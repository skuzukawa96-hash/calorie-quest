// Development-only diagnostics: run with `VITE_SPEECH_PROBE=1 npm run tauri dev`.
// Results are printed by the Rust side (`log_debug`), so they show up in the terminal.
import { api, runningInTauri } from "./api";
import { loadSpeechCapabilities, recognitionBackend, recognizeOnce, speak } from "./speech";

export async function runSpeechProbe() {
  const log = (m: string) => api.logDebug(`[probe] ${m}`);
  // Expose internals for driving the real WebView2 window over the DevTools protocol.
  (window as unknown as { __cq: unknown }).__cq = { api, speak, recognizeOnce, recognitionBackend, log };
  await log(`ua=${navigator.userAgent}`);
  const caps = await loadSpeechCapabilities();
  await log(`caps=${JSON.stringify(caps)} backend=${recognitionBackend()}`);

  if ("speechSynthesis" in window) {
    await new Promise((r) => setTimeout(r, 1500));
    const voices = speechSynthesis.getVoices();
    await log(`web voices=${voices.length} en=${voices.filter((v) => /^en/i.test(v.lang)).map((v) => v.name).join(" | ")}`);
  }

  if (runningInTauri && caps.nativeTts) {
    const t0 = performance.now();
    try {
      const buf = await api.nativeSynthesize("Nice to meet you.", -2);
      await log(`native tts ok bytes=${buf.byteLength} ms=${Math.round(performance.now() - t0)}`);
    } catch (e) {
      await log(`native tts error: ${String(e)}`);
    }
  }

  if (runningInTauri) {
    // en-US is expected to fail on machines without the English speech pack; ja-JP checks the pipeline.
    for (const lang of ["en-US", "ja-JP"]) {
      const t0 = performance.now();
      try {
        const r = await api.nativeRecognize(lang === "ja-JP" ? "こんにちは" : "hello", ["good morning", "おはよう"], 2, lang);
        await log(`native stt ${lang}: ${JSON.stringify(r)} ms=${Math.round(performance.now() - t0)}`);
      } catch (e) {
        await log(`native stt ${lang} error: ${String(e)} ms=${Math.round(performance.now() - t0)}`);
      }
    }
  }
  await log("done");
}
