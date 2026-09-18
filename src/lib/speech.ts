/* eslint-disable @typescript-eslint/no-explicit-any */
// Text-to-speech and speech recognition.
//
// Two backends:
//  - "web":    the Web Speech API (works in normal browsers)
//  - "native": Windows SAPI5 / WinRT through the Rust side. Used inside Tauri, because
//              WebView2 does not implement SpeechRecognition (it fails with `network`).
import { api, runningInTauri } from "./api";
import type { NativeRecognition, SpeechCapabilities } from "../types";

type RecognitionCtor = new () => any;

function recognitionCtor(): RecognitionCtor | null {
  const w = window as any;
  return (w.SpeechRecognition || w.webkitSpeechRecognition || null) as RecognitionCtor | null;
}

/* ---------- capabilities ---------- */

let caps: SpeechCapabilities | null = null;

export async function loadSpeechCapabilities(): Promise<SpeechCapabilities> {
  if (caps) return caps;
  try {
    caps = await api.speechCapabilities();
  } catch (e) {
    caps = { nativeTts: false, ttsVoices: [], nativeStt: false, sttLanguages: [], sttError: String(e) };
  }
  return caps;
}

export function speechCaps(): SpeechCapabilities | null {
  return caps;
}

export type RecognitionBackend = "native" | "web" | "none";

export function recognitionBackend(): RecognitionBackend {
  if (runningInTauri) return caps?.nativeStt ? "native" : "none";
  return recognitionCtor() ? "web" : "none";
}

export function isRecognitionSupported(): boolean {
  return recognitionBackend() !== "none";
}

export function isTtsSupported(): boolean {
  if (runningInTauri && caps?.nativeTts) return true;
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/* ---------- text to speech ---------- */

let voicesPromise: Promise<SpeechSynthesisVoice[]> | null = null;

function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!("speechSynthesis" in window)) return Promise.resolve([]);
  if (voicesPromise) return voicesPromise;
  voicesPromise = new Promise((resolve) => {
    const have = speechSynthesis.getVoices();
    if (have.length) {
      resolve(have);
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(speechSynthesis.getVoices());
    };
    speechSynthesis.addEventListener("voiceschanged", finish, { once: true });
    setTimeout(finish, 1500);
  });
  return voicesPromise;
}

const PREFERRED_VOICES = ["Aria", "Jenny", "Guy", "Zira", "David", "Mark", "Google US English", "Samantha", "Alex"];

export function pickEnglishVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | undefined {
  const en = voices.filter((v) => /^en[-_]/i.test(v.lang));
  if (!en.length) return undefined;
  for (const name of PREFERRED_VOICES) {
    const v = en.find((x) => x.name.includes(name));
    if (v) return v;
  }
  return en.find((v) => /en[-_]US/i.test(v.lang)) ?? en[0];
}

let currentAudio: HTMLAudioElement | null = null;

async function speakNative(text: string): Promise<void> {
  const buf = await api.nativeSynthesize(text, -2);
  const blob = new Blob([buf], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  stopSpeaking();
  const audio = new Audio(url);
  currentAudio = audio;
  try {
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("tts-playback"));
      audio.onpause = () => resolve();
      audio.play().catch(reject);
    });
  } finally {
    if (currentAudio === audio) currentAudio = null;
    URL.revokeObjectURL(url);
  }
}

async function speakWeb(text: string, rate: number): Promise<void> {
  if (!("speechSynthesis" in window)) throw new Error("tts-unsupported");
  const voices = await loadVoices();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  u.rate = rate;
  u.pitch = 1;
  const v = pickEnglishVoice(voices);
  if (v) u.voice = v;
  return new Promise((resolve, reject) => {
    u.onend = () => resolve();
    u.onerror = (e) => {
      if (e.error === "interrupted" || e.error === "canceled") resolve();
      else reject(new Error("tts-" + e.error));
    };
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
}

/** Plays the model pronunciation; resolves when playback ends. */
export async function speak(text: string, rate = 0.9): Promise<void> {
  if (runningInTauri && caps?.nativeTts) {
    try {
      return await speakNative(text);
    } catch (e) {
      void api.logDebug(`native tts failed, falling back: ${String(e)}`);
    }
  }
  return speakWeb(text, rate);
}

export function stopSpeaking() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

/* ---------- speech recognition ---------- */

export interface RecognitionOutcome {
  /** candidate transcripts, best first */
  transcripts: string[];
  /** ms of actual speech (native) or from speech start to result (web); used for fluency */
  durationMs: number;
  /** present when the native recognizer judged the phrase */
  native?: NativeRecognition;
}

export interface RecognitionHandle {
  result: Promise<RecognitionOutcome>;
  abort: () => void;
}

export interface RecognizeOptions {
  /** the phrase the learner should say */
  target: string;
  /** other phrases the native list grammar can choose from (makes the confidence meaningful) */
  alternatives?: string[];
  lang?: string;
  timeoutMs?: number;
  onListening?: () => void;
  onSpeechStart?: () => void;
}

export function recognizeOnce(opts: RecognizeOptions): RecognitionHandle {
  const backend = recognitionBackend();
  if (backend === "native") return recognizeNative(opts);
  if (backend === "web") return recognizeWeb(opts);
  return { result: Promise.reject(new Error("unsupported")), abort: () => undefined };
}

function recognizeNative(opts: RecognizeOptions): RecognitionHandle {
  opts.onListening?.();
  const timeoutSecs = Math.round((opts.timeoutMs ?? 8000) / 1000);
  const result = api
    .nativeRecognize(opts.target, opts.alternatives ?? [], timeoutSecs, opts.lang ?? "en-US")
    .then((native): RecognitionOutcome => {
      if (native.status === "timeout" || (native.status === "success" && !native.text)) {
        throw new Error("no-speech");
      }
      if (native.status !== "success") throw new Error(native.status);
      return { transcripts: native.text ? [native.text] : [], durationMs: native.durationMs, native };
    });
  // The WinRT recognizer stops by itself on silence; there is no cancel from JS.
  return { result, abort: () => undefined };
}

function recognizeWeb(opts: RecognizeOptions): RecognitionHandle {
  const Ctor = recognitionCtor();
  if (!Ctor) {
    return { result: Promise.reject(new Error("unsupported")), abort: () => undefined };
  }
  const rec = new Ctor();
  rec.lang = opts.lang ?? "en-US";
  rec.interimResults = false;
  rec.maxAlternatives = 5;
  rec.continuous = false;

  let settled = false;
  let speechStart = 0;
  const started = performance.now();
  let timer: number | undefined;

  const result = new Promise<RecognitionOutcome>((resolve, reject) => {
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      fn();
    };
    rec.onstart = () => opts.onListening?.();
    rec.onspeechstart = () => {
      speechStart = performance.now();
      opts.onSpeechStart?.();
    };
    rec.onresult = (ev: any) => {
      const list = ev.results?.[0];
      const transcripts: string[] = [];
      if (list) {
        for (let i = 0; i < list.length; i++) transcripts.push(String(list[i].transcript ?? ""));
      }
      const end = performance.now();
      finish(() => resolve({ transcripts, durationMs: end - (speechStart || started) }));
    };
    rec.onerror = (ev: any) => finish(() => reject(new Error(String(ev?.error ?? "unknown"))));
    rec.onend = () => finish(() => reject(new Error("no-speech")));
    try {
      rec.start();
    } catch (e) {
      finish(() => reject(e instanceof Error ? e : new Error(String(e))));
    }
    timer = window.setTimeout(() => {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    }, opts.timeoutMs ?? 8000);
  });

  return {
    result,
    abort: () => {
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    },
  };
}

export function describeRecognitionError(code: string): string {
  switch (code) {
    case "unsupported":
      return "この環境では音声認識が利用できません。";
    case "not-allowed":
    case "service-not-allowed":
      return "マイクの使用が許可されていません。Windowsの設定でマイクへのアクセスを許可してください。";
    case "audio-capture":
    case "microphone-unavailable":
      return "マイクが見つかりません。マイクの接続を確認してください。";
    case "no-speech":
    case "timeout":
      return "音声が検出されませんでした。もう一度、はっきり話してみてください。";
    case "audio-quality-failure":
      return "音声がうまく聞き取れませんでした。マイクに近づいて話してみてください。";
    case "network":
    case "network-failure":
      return "音声認識サービスに接続できませんでした（ネットワークエラー）。";
    case "aborted":
    case "user-canceled":
      return "認識を中止しました。";
    default:
      return `音声認識エラー: ${code}`;
  }
}

/** Japanese instructions for enabling the Windows English recognizer. */
export const INSTALL_STT_GUIDE =
  "Windowsに英語の音声認識を追加すると、発音判定が使えるようになります: 設定 → 時刻と言語 → 言語と地域 → 「言語の追加」で English (United States) を追加 → 言語のオプション → 「音声認識」をインストール。";
