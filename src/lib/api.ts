import { invoke } from "@tauri-apps/api/core";
import type {
  AnswerPayload,
  AnswerResult,
  ConsumptionEntry,
  DailyStats,
  Dashboard,
  Difficulty,
  Mode,
  NativeRecognition,
  RedeemResult,
  SessionQuestion,
  Snack,
  SpeechCapabilities,
  Stats,
} from "../types";

/** True when the page runs inside the Tauri WebView; false in a plain browser (`npm run dev`). */
export const runningInTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (runningInTauri) {
    return invoke<T>(cmd, args);
  }
  // Browser preview: an in-memory backend keeps the UI usable without Rust.
  const { mockInvoke } = await import("./mockBackend");
  return mockInvoke<T>(cmd, args);
}

export const api = {
  getDashboard: () => call<Dashboard>("get_dashboard"),
  getSessionQuestions: (mode: Mode, difficulty: Difficulty, category: string, count: number) =>
    call<SessionQuestion[]>("get_session_questions", { mode, difficulty, category, count }),
  submitAnswer: (payload: AnswerPayload) => call<AnswerResult>("submit_answer", { payload }),
  listSnacks: () => call<Snack[]>("list_snacks"),
  addSnack: (name: string, calories: number, icon: string) =>
    call<Snack>("add_snack", { name, calories, icon }),
  deleteSnack: (id: number) => call<void>("delete_snack", { id }),
  setGoalSnack: (id: number | null) => call<Snack | null>("set_goal_snack", { id }),
  logSnackEaten: (snackId: number) => call<DailyStats>("log_snack_eaten", { snackId }),
  getTodayConsumption: () => call<ConsumptionEntry[]>("get_today_consumption"),
  deleteConsumption: (id: number) => call<DailyStats>("delete_consumption", { id }),
  redeemCheatTicket: () => call<RedeemResult>("redeem_cheat_ticket"),
  getStats: () => call<Stats>("get_stats"),
  getDictionary: () => call<Record<string, string>>("get_dictionary"),
  resetProgress: () => call<void>("reset_progress"),
  logDebug: (message: string) => call<void>("log_debug", { message }).catch(() => undefined),

  // Native speech (Tauri only; the mock backend reports "unavailable").
  speechCapabilities: () => call<SpeechCapabilities>("speech_capabilities"),
  nativeSynthesize: (text: string, rate = -2) => invoke<ArrayBuffer>("native_synthesize", { text, rate }),
  nativeRecognize: (target: string, alternatives: string[], timeoutSecs = 6, lang = "en-US") =>
    call<NativeRecognition>("native_recognize", { target, alternatives, timeoutSecs, lang }),
};
