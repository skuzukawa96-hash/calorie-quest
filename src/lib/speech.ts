/* eslint-disable @typescript-eslint/no-explicit-any */
// Text-to-speech and speech recognition.
//
// Two backends:
//  - "web":    the Web Speech API (works in normal browsers)
//  - "native": Windows SAPI5 / WinRT through the Rust side. Used inside Tauri, because
//              WebView2 does not implement SpeechRecognition (it fails with `network`). On
//              Android, the phone's own text-to-speech and recognizer (Android's WebView has
//              neither part of the Web Speech API).
import { listen } from "@tauri-apps/api/event";
import { api, runningInTauri, runningOnAndroid } from "./api";
import { audio } from "./sfx";
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
/** a voice made ahead, playing through the app's AudioContext (`prepareWords`) */
let currentSource: AudioBufferSourceNode | null = null;

/** Counts the requests to speak. */
let speakRequests = 0;

/**
 * Takes a request to speak, and says later whether it is still wanted once its voice is ready: not
 * when something else was asked to be said meanwhile, nor when speaking was stopped (the learner
 * moved on to the next question while the voice was being made, which would else play over it).
 */
function speakRequest(): () => boolean {
  const asked = ++speakRequests;
  const stopsThen = stops;
  return () => asked === speakRequests && stops === stopsThen;
}

async function speakNative(text: string): Promise<void> {
  const wanted = speakRequest();
  const buf = await api.nativeSynthesize(text, -2);
  if (!wanted()) return;
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
  const wanted = speakRequest();
  const voices = await loadVoices();
  if (!wanted()) return;
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

/** Counts the stops, so words being read in turn stop with them. */
let stops = 0;

/** The 16-bit mono samples of a WAV the native voice made, and its sample rate. */
function wavSamples(buf: ArrayBuffer): { rate: number; samples: Int16Array } {
  const view = new DataView(buf);
  const rate = view.getUint32(24, true);
  for (let at = 12; at + 8 <= buf.byteLength; ) {
    const id = String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
    const size = view.getUint32(at + 4, true);
    if (id === "data") return { rate, samples: new Int16Array(buf.slice(at + 8, at + 8 + size)) };
    at += 8 + size;
  }
  return { rate, samples: new Int16Array(0) };
}

/** What trimSilence keeps of the quiet on each side of a word, not to clip it. */
const EDGE_MS = 20;

/**
 * The voice without the silence the synthesizer puts around it (about 0.15 s before and 0.9 s
 * after a word). Anything louder than `quiet` counts as voice, so a soft final consonant (the p of
 * "get up") stays; EDGE_MS more are kept on each side.
 */
function trimSilence(samples: Int16Array, rate: number): Int16Array {
  const quiet = 50;
  let start = 0;
  let end = samples.length;
  while (start < end && Math.abs(samples[start]) < quiet) start++;
  while (end > start && Math.abs(samples[end - 1]) < quiet) end--;
  const margin = Math.round((rate * EDGE_MS) / 1000);
  return samples.slice(Math.max(0, start - margin), Math.min(samples.length, end + margin));
}

function wavBlob(samples: Int16Array, rate: number): Blob {
  const header = new DataView(new ArrayBuffer(44));
  const text = (at: number, s: string) => [...s].forEach((c, i) => header.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  header.setUint32(4, 36 + samples.byteLength, true);
  text(8, "WAVE");
  text(12, "fmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, rate, true);
  header.setUint32(28, rate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  text(36, "data");
  header.setUint32(40, samples.byteLength, true);
  return new Blob([header.buffer, samples.buffer as ArrayBuffer], { type: "audio/wav" });
}

/** The WAVs native_synthesize_all sends back, each after its byte length (u32, little-endian). */
function splitWavs(buf: ArrayBuffer): ArrayBuffer[] {
  const view = new DataView(buf);
  const out: ArrayBuffer[] = [];
  for (let at = 0; at + 4 <= buf.byteLength; ) {
    const size = view.getUint32(at, true);
    out.push(buf.slice(at + 4, at + 4 + size));
    at += 4 + size;
  }
  return out;
}

/** Words with their silence cut, joined with `gapMs` of silence between them, and when (ms) each starts. */
function joinClips(parts: Int16Array[], rate: number, gapMs: number): { joined: Int16Array; starts: number[] } {
  // The edges kept on either side count towards the pause, so the words are gapMs apart.
  const gap = Math.round((rate * Math.max(0, gapMs - 2 * EDGE_MS)) / 1000);
  const starts: number[] = [];
  const joined = new Int16Array(parts.reduce((n, p) => n + p.length, 0) + gap * Math.max(0, parts.length - 1));
  let at = 0;
  parts.forEach((p) => {
    starts.push((at / rate) * 1000);
    joined.set(p, at);
    at += p.length + gap;
  });
  return { joined, starts };
}

/**
 * Words to be read the moment they are wanted (LexiLink: a pair's English as it is eaten). With the
 * native voice they are made ahead, all in one go and with their silence cut, so a word plays at
 * once instead of after the synthesizer (and the quiet it puts before a word); it plays through the
 * app's AudioContext, which starts sooner than an <audio>. The browser's voice cannot be made ahead,
 * so there `say` reads as speak / speakInTurn do.
 */
export interface ReadyWords {
  /** reads `words` one after another, `gapMs` apart; resolves when done or stopped */
  say(words: string[], gapMs: number): Promise<void>;
}

export function prepareWords(words: string[]): ReadyWords {
  const plain: ReadyWords = {
    say: (list, gapMs) => (list.length === 1 ? speak(list[0]) : speakInTurn(list, gapMs, () => undefined)),
  };
  if (!(runningInTauri && caps?.nativeTts)) return plain;
  const unique = [...new Set(words)];
  const made: Promise<Map<string, { rate: number; samples: Int16Array }> | null> = api
    .nativeSynthesizeAll(unique, -2)
    .then((buf) => {
      const clips = new Map<string, { rate: number; samples: Int16Array }>();
      splitWavs(buf).forEach((wav, i) => {
        const c = wavSamples(wav);
        clips.set(unique[i], { rate: c.rate, samples: trimSilence(c.samples, c.rate) });
      });
      return clips;
    })
    .catch(() => null);
  return {
    async say(list, gapMs) {
      const wanted = speakRequest();
      // Asked before the voices are made (a pair taken in the first second): played once they are.
      const clips = await made;
      if (!wanted()) return;
      const parts = list.map((w) => clips?.get(w));
      const ctx = audio();
      if (!ctx || parts.some((c) => !c)) return plain.say(list, gapMs);
      const rate = parts[0]!.rate;
      const { joined } = joinClips(
        parts.map((c) => c!.samples),
        rate,
        gapMs,
      );
      const buffer = ctx.createBuffer(1, Math.max(1, joined.length), rate);
      const out = buffer.getChannelData(0);
      for (let i = 0; i < joined.length; i++) out[i] = joined[i] / 32768;
      stopSpeaking();
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      currentSource = source;
      await new Promise<void>((resolve) => {
        source.onended = () => resolve();
        source.start();
      });
      if (currentSource === source) currentSource = null;
    },
  };
}

/**
 * The native voice makes each word apart (one after another: the engine crashes the app when
 * it makes several at once); their silence is cut and they are joined with `gapMs` of silence
 * between them into one sound, so the pause is the same every time and nothing waits for the
 * synthesizer in between.
 */
async function speakJoinedNative(words: string[], gapMs: number, onStep: (i: number) => void): Promise<void> {
  const wanted = speakRequest();
  const made = await api.nativeSynthesizeAll(words, -2);
  if (!wanted()) return;
  const clips = splitWavs(made).map(wavSamples);
  const rate = clips[0]?.rate ?? 22050;
  const { joined, starts } = joinClips(
    clips.map((c) => trimSilence(c.samples, c.rate)),
    rate,
    gapMs,
  );
  stopSpeaking();
  const url = URL.createObjectURL(wavBlob(joined, rate));
  const audio = new Audio(url);
  currentAudio = audio;
  const timers: number[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("tts-playback"));
      audio.onpause = () => resolve();
      audio.onplaying = () => starts.forEach((ms, i) => timers.push(window.setTimeout(() => onStep(i), ms)));
      audio.play().catch(reject);
    });
  } finally {
    timers.forEach((t) => window.clearTimeout(t));
    if (currentAudio === audio) currentAudio = null;
    URL.revokeObjectURL(url);
  }
}

/**
 * Reads `words` one after another with `gapMs` of silence between them (a verb's forms: buy -
 * bought - bought), calling `onStep` with each word's index as it starts. The browser's voice
 * speaks them in turn, so its own start-up time adds to the pause. Resolves when done or stopped.
 */
export async function speakInTurn(words: string[], gapMs: number, onStep: (i: number) => void): Promise<void> {
  if (runningInTauri && caps?.nativeTts) {
    try {
      return await speakJoinedNative(words, gapMs, onStep);
    } catch (e) {
      void api.logDebug(`native tts failed, falling back: ${String(e)}`);
    }
  }
  stopSpeaking();
  const mine = stops;
  for (let i = 0; i < words.length; i++) {
    if (stops !== mine) return;
    onStep(i);
    await speakWeb(words[i], 0.9).catch(() => undefined);
    if (i < words.length - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
}

export function stopSpeaking() {
  stops++;
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  if (currentSource) {
    // its onended resolves the say() that started it
    try {
      currentSource.stop();
    } catch {
      /* already ended */
    }
    currentSource = null;
  }
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

/* ---------- speech recognition ---------- */

/** Mirrors speech::LISTENING_EVENT: the native recognizer is ready, so the learner may speak. */
const LISTENING_EVENT = "speech-listening";

export interface RecognitionOutcome {
  /** candidate transcripts, best first */
  transcripts: string[];
  /** ms of actual speech (native) or from speech start to result (web); kept for the log, not scored */
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
  const timeoutSecs = Math.round((opts.timeoutMs ?? 8000) / 1000);
  // "Speak now" only once the recognizer is listening (speech.rs emits it): setting it up takes a
  // moment, and the first words said in it would be lost.
  const ready = listen(LISTENING_EVENT, () => opts.onListening?.()).catch(() => {
    opts.onListening?.();
    return () => undefined;
  });
  const result = ready
    .then(() => api.nativeRecognize(opts.target, opts.alternatives ?? [], timeoutSecs, opts.lang ?? "en-US"))
    .then((native): RecognitionOutcome => {
      const guessed = native.targetConfidence !== null && native.targetConfidence !== undefined;
      if (native.status === "timeout" || (native.status === "success" && !native.text && !guessed)) {
        // Heard but not made out is not the same as silence.
        throw new Error(native.heard ? "unclear" : "no-speech");
      }
      if (native.status !== "success" && !guessed) throw new Error(native.status);
      // Android's recognizer wrote down what it heard: scored by closeness, as the browser's is.
      if (native.transcripts?.length) return { transcripts: native.transcripts, durationMs: native.durationMs };
      return { transcripts: native.text ? [native.text] : [], durationMs: native.durationMs, native };
    })
    .finally(() => void ready.then((stop) => stop()));
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
      return runningOnAndroid
        ? "マイクの使用が許可されていません。スマホの設定 → アプリ → Calorie Quest → 権限 で、マイクを許可してください。"
        : "マイクの使用が許可されていません。Windowsの設定でマイクへのアクセスを許可してください。";
    case "audio-capture":
    case "microphone-unavailable":
      return "マイクが見つかりません。マイクの接続を確認してください。";
    case "no-speech":
    case "timeout":
      return "音声が検出されませんでした。「● 録音中」が出てから、マイクに向かって話してみてください。";
    case "unclear":
      return "声は届きましたが、聞き取れませんでした。マイクに少し近づいて、文全体を一息に話してみてください（この回は回数に数えません）。";
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

/** Japanese instructions for enabling the English recognizer: Windows's, or a phone's (Google's). */
export const INSTALL_STT_GUIDE = runningOnAndroid
  ? "スマホに音声入力のアプリ（Google アプリ、または「Google の音声サービス」）を入れて有効にすると、発音判定が使えるようになります。"
  : "Windowsに英語の音声認識を追加すると、発音判定が使えるようになります: 設定 → 時刻と言語 → 言語と地域 → 「言語の追加」で English (United States) を追加 → 言語のオプション → 「音声認識」をインストール。";
