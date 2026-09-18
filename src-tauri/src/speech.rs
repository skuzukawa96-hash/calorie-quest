//! Native speech support. WebView2 does not implement the Web Speech API's recognition
//! part (it fails with a `network` error), so on Windows we use what the OS already ships:
//! - SAPI 5 text-to-speech, rendered to a WAV buffer that the frontend plays back
//! - the WinRT `SpeechRecognizer` with a list grammar, which reports a confidence score
//!   for the phrase the learner was asked to say.
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechCapabilities {
    pub native_tts: bool,
    pub tts_voices: Vec<String>,
    pub native_stt: bool,
    pub stt_languages: Vec<String>,
    pub stt_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRecognition {
    pub status: String,
    pub text: String,
    pub confidence: String,
    pub raw_confidence: f64,
    pub duration_ms: i64,
    pub matched: bool,
}

#[cfg(windows)]
mod platform {
    use super::{NativeRecognition, SpeechCapabilities};
    use std::ffi::c_void;
    use windows::core::{GUID, HSTRING, PCWSTR};
    use windows::Foundation::TimeSpan;
    use windows_collections::IIterable;
    use windows::Globalization::Language;
    use windows::Media::SpeechRecognition::{
        SpeechRecognitionConfidence, SpeechRecognitionListConstraint, SpeechRecognitionResultStatus,
        SpeechRecognizer,
    };
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::Media::Audio::WAVEFORMATEX;
    use windows::Win32::Media::Speech::{
        IEnumSpObjectTokens, ISpObjectToken, ISpObjectTokenCategory, ISpStream, ISpVoice, SpObjectTokenCategory,
        SpStream, SpVoice, SPCAT_VOICES, SPF_DEFAULT,
    };
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IStream, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
        STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET,
    };
    use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

    const ONECORE_VOICES: &str = "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Speech_OneCore\\Voices";
    const SAMPLE_RATE: u32 = 16_000;
    /// SPDFID_WaveFormatEx from sapi.h: the stream format is described by a WAVEFORMATEX.
    const SPDFID_WAVEFORMATEX: GUID = GUID::from_u128(0xC31ADBAE_527F_4FF5_A230_F62BB61FF70C);

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn e(err: impl std::fmt::Display) -> String {
        err.to_string()
    }

    struct ComGuard;
    impl ComGuard {
        fn new() -> Self {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            }
            ComGuard
        }
    }
    impl Drop for ComGuard {
        fn drop(&mut self) {
            unsafe { CoUninitialize() }
        }
    }

    unsafe fn token_name(tok: &ISpObjectToken) -> String {
        match tok.GetStringValue(PCWSTR::null()) {
            Ok(p) => {
                let s = p.to_string().unwrap_or_default();
                CoTaskMemFree(Some(p.0 as *const c_void));
                s
            }
            Err(_) => "(unknown voice)".to_string(),
        }
    }

    /// English (0x409) voices from the SAPI 5 category first, then the OneCore category.
    unsafe fn english_voices() -> Vec<(ISpObjectToken, String)> {
        let mut out = Vec::new();
        let onecore = wide(ONECORE_VOICES);
        let attr = wide("Language=409");
        for cat_id in [SPCAT_VOICES, PCWSTR(onecore.as_ptr())] {
            let cat: ISpObjectTokenCategory = match CoCreateInstance(&SpObjectTokenCategory, None, CLSCTX_ALL) {
                Ok(c) => c,
                Err(_) => continue,
            };
            if cat.SetId(cat_id, false).is_err() {
                continue;
            }
            let tokens: IEnumSpObjectTokens = match cat.EnumTokens(PCWSTR(attr.as_ptr()), PCWSTR::null()) {
                Ok(t) => t,
                Err(_) => continue,
            };
            let mut count = 0u32;
            if tokens.GetCount(&mut count).is_err() {
                continue;
            }
            for i in 0..count {
                if let Ok(tok) = tokens.Item(i) {
                    let name = token_name(&tok);
                    out.push((tok, name));
                }
            }
        }
        out
    }

    fn wav_wrap(pcm: &[u8], sample_rate: u32, channels: u16, bits: u16) -> Vec<u8> {
        let block_align = channels * bits / 8;
        let byte_rate = sample_rate * block_align as u32;
        let mut out = Vec::with_capacity(44 + pcm.len());
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&channels.to_le_bytes());
        out.extend_from_slice(&sample_rate.to_le_bytes());
        out.extend_from_slice(&byte_rate.to_le_bytes());
        out.extend_from_slice(&block_align.to_le_bytes());
        out.extend_from_slice(&bits.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
        out.extend_from_slice(pcm);
        out
    }

    pub fn tts_voice_names() -> Vec<String> {
        std::thread::spawn(|| unsafe {
            let _com = ComGuard::new();
            english_voices().into_iter().map(|(_, n)| n).collect()
        })
        .join()
        .unwrap_or_default()
    }

    pub fn synthesize(text: &str, rate: i32) -> Result<Vec<u8>, String> {
        let text = text.to_string();
        std::thread::spawn(move || unsafe {
            let _com = ComGuard::new();
            let voice: ISpVoice = CoCreateInstance(&SpVoice, None, CLSCTX_ALL).map_err(e)?;
            let voices = english_voices();
            let Some((token, _)) = voices.into_iter().next() else {
                return Err("英語の音声（SAPI5 / OneCore）が見つかりません".to_string());
            };
            voice.SetVoice(&token).map_err(e)?;
            voice.SetRate(rate.clamp(-10, 10)).map_err(e)?;

            let mem: IStream = CreateStreamOnHGlobal(HGLOBAL::default(), true).map_err(e)?;
            let stream: ISpStream = CoCreateInstance(&SpStream, None, CLSCTX_ALL).map_err(e)?;
            let wfx = WAVEFORMATEX {
                wFormatTag: 1,
                nChannels: 1,
                nSamplesPerSec: SAMPLE_RATE,
                nAvgBytesPerSec: SAMPLE_RATE * 2,
                nBlockAlign: 2,
                wBitsPerSample: 16,
                cbSize: 0,
            };
            stream.SetBaseStream(&mem, &SPDFID_WAVEFORMATEX, &wfx).map_err(e)?;
            voice.SetOutput(&stream, false).map_err(e)?;

            let w = wide(&text);
            voice.Speak(PCWSTR(w.as_ptr()), SPF_DEFAULT.0 as u32, None).map_err(e)?;

            let mut stat = STATSTG::default();
            mem.Stat(&mut stat, STATFLAG_NONAME).map_err(e)?;
            let size = stat.cbSize as usize;
            mem.Seek(0, STREAM_SEEK_SET, None).map_err(e)?;
            let mut pcm = vec![0u8; size];
            let mut total = 0usize;
            while total < size {
                let mut read = 0u32;
                let hr = mem.Read(pcm.as_mut_ptr().add(total) as *mut c_void, (size - total) as u32, Some(&mut read));
                if hr.is_err() || read == 0 {
                    break;
                }
                total += read as usize;
            }
            pcm.truncate(total);
            Ok(wav_wrap(&pcm, SAMPLE_RATE, 1, 16))
        })
        .join()
        .map_err(|_| "speech thread panicked".to_string())?
    }

    fn status_name(s: SpeechRecognitionResultStatus) -> String {
        match s {
            SpeechRecognitionResultStatus::Success => "success",
            SpeechRecognitionResultStatus::TopicLanguageNotSupported => "topic-language-not-supported",
            SpeechRecognitionResultStatus::GrammarLanguageMismatch => "grammar-language-mismatch",
            SpeechRecognitionResultStatus::GrammarCompilationFailure => "grammar-compilation-failure",
            SpeechRecognitionResultStatus::AudioQualityFailure => "audio-quality-failure",
            SpeechRecognitionResultStatus::UserCanceled => "user-canceled",
            SpeechRecognitionResultStatus::TimeoutExceeded => "timeout",
            SpeechRecognitionResultStatus::PauseLimitExceeded => "pause-limit-exceeded",
            SpeechRecognitionResultStatus::NetworkFailure => "network-failure",
            SpeechRecognitionResultStatus::MicrophoneUnavailable => "microphone-unavailable",
            _ => "unknown",
        }
        .to_string()
    }

    fn confidence_name(c: SpeechRecognitionConfidence) -> String {
        match c {
            SpeechRecognitionConfidence::High => "high",
            SpeechRecognitionConfidence::Medium => "medium",
            SpeechRecognitionConfidence::Low => "low",
            _ => "rejected",
        }
        .to_string()
    }

    pub fn supported_languages() -> Result<Vec<String>, String> {
        std::thread::spawn(|| unsafe {
            let _ = RoInitialize(RO_INIT_MULTITHREADED);
            let langs = SpeechRecognizer::SupportedGrammarLanguages().map_err(e)?;
            let mut out = Vec::new();
            for l in langs {
                if let Ok(tag) = l.LanguageTag() {
                    out.push(tag.to_string());
                }
            }
            Ok(out)
        })
        .join()
        .map_err(|_| "speech thread panicked".to_string())?
    }

    pub fn capabilities() -> SpeechCapabilities {
        let tts_voices = tts_voice_names();
        let (stt_languages, stt_error) = match supported_languages() {
            Ok(l) => (l, None),
            Err(err) => (Vec::new(), Some(err)),
        };
        let native_stt = stt_languages.iter().any(|l| l.to_ascii_lowercase().starts_with("en"));
        SpeechCapabilities {
            native_tts: !tts_voices.is_empty(),
            tts_voices,
            native_stt,
            stt_languages,
            stt_error,
        }
    }

    pub fn recognize(lang: &str, target: &str, alternatives: Vec<String>, timeout_secs: u32) -> Result<NativeRecognition, String> {
        let lang = lang.to_string();
        let target = target.to_string();
        std::thread::spawn(move || unsafe {
            let _ = RoInitialize(RO_INIT_MULTITHREADED);
            let language = Language::CreateLanguage(&HSTRING::from(lang.as_str())).map_err(e)?;
            let rec = SpeechRecognizer::Create(&language)
                .map_err(|err| format!("音声認識エンジン（{lang}）を初期化できません: {err}"))?;

            let mut phrases: Vec<HSTRING> = vec![HSTRING::from(target.as_str())];
            for a in alternatives {
                if !a.trim().is_empty() && !a.eq_ignore_ascii_case(&target) {
                    phrases.push(HSTRING::from(a.as_str()));
                }
            }
            let iterable = IIterable::<HSTRING>::try_from(phrases).map_err(e)?;
            let constraint = SpeechRecognitionListConstraint::Create(&iterable).map_err(e)?;
            rec.Constraints().map_err(e)?.Append(&constraint).map_err(e)?;
            let compiled = rec.CompileConstraintsAsync().map_err(e)?.join().map_err(e)?;
            let cstatus = compiled.Status().map_err(e)?;
            if cstatus != SpeechRecognitionResultStatus::Success {
                return Err(format!("grammar compilation failed: {}", status_name(cstatus)));
            }

            let timeouts = rec.Timeouts().map_err(e)?;
            let _ = timeouts.SetInitialSilenceTimeout(TimeSpan { Duration: timeout_secs as i64 * 10_000_000 });
            let _ = timeouts.SetEndSilenceTimeout(TimeSpan { Duration: 8_000_000 });
            let _ = timeouts.SetBabbleTimeout(TimeSpan { Duration: 12 * 10_000_000 });

            let result = rec.RecognizeAsync().map_err(e)?.join().map_err(e)?;
            let status = result.Status().map_err(e)?;
            let text = result.Text().map(|t| t.to_string()).unwrap_or_default();
            let confidence = result.Confidence().unwrap_or(SpeechRecognitionConfidence::Rejected);
            let raw_confidence = result.RawConfidence().unwrap_or(0.0);
            let duration_ms = result.PhraseDuration().map(|d| d.Duration / 10_000).unwrap_or(0);
            let _ = rec.Close();

            Ok(NativeRecognition {
                status: status_name(status),
                matched: !text.is_empty() && text.eq_ignore_ascii_case(&target),
                text,
                confidence: confidence_name(confidence),
                raw_confidence,
                duration_ms,
            })
        })
        .join()
        .map_err(|_| "speech thread panicked".to_string())?
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{NativeRecognition, SpeechCapabilities};

    pub fn capabilities() -> SpeechCapabilities {
        SpeechCapabilities {
            native_tts: false,
            tts_voices: Vec::new(),
            native_stt: false,
            stt_languages: Vec::new(),
            stt_error: Some("native speech is only implemented on Windows".to_string()),
        }
    }

    pub fn synthesize(_text: &str, _rate: i32) -> Result<Vec<u8>, String> {
        Err("native speech is only implemented on Windows".to_string())
    }

    pub fn recognize(_lang: &str, _target: &str, _alternatives: Vec<String>, _timeout_secs: u32) -> Result<NativeRecognition, String> {
        Err("native speech is only implemented on Windows".to_string())
    }
}

#[tauri::command(async)]
pub fn speech_capabilities() -> SpeechCapabilities {
    platform::capabilities()
}

/// Returns a 16 kHz mono WAV file for the frontend to play.
#[tauri::command(async)]
pub fn native_synthesize(text: String, rate: Option<i32>) -> Result<tauri::ipc::Response, String> {
    let bytes = platform::synthesize(&text, rate.unwrap_or(-2))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command(async)]
pub fn native_recognize(
    lang: Option<String>,
    target: String,
    alternatives: Option<Vec<String>>,
    timeout_secs: Option<u32>,
) -> Result<NativeRecognition, String> {
    platform::recognize(
        lang.as_deref().unwrap_or("en-US"),
        &target,
        alternatives.unwrap_or_default(),
        timeout_secs.unwrap_or(6).clamp(2, 20),
    )
}
