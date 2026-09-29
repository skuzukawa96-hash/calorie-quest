import { invoke } from "@tauri-apps/api/core";
import type {
  AnswerPayload,
  AnswerResult,
  ConsumptionEntry,
  DailyStats,
  Dashboard,
  Difficulty,
  NativeRecognition,
  RecipeAddResult,
  RecipeReviewMode,
  RecipeReviewResult,
  RecipeWord,
  RecipeWordInput,
  RedeemResult,
  SessionMode,
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
  // Browser preview (`npm run dev`): an in-memory backend keeps the UI usable without Rust.
  // Dev-only, so the ~6 MB of bundled question data is dropped from the production build that
  // `tauri build` packages — the shipped app always has the Rust side and never runs this.
  if (import.meta.env.DEV) {
    const { mockInvoke } = await import("./mockBackend");
    return mockInvoke<T>(cmd, args);
  }
  throw new Error(`${cmd}: no backend available — a production build runs only inside Tauri`);
}

export const api = {
  getDashboard: () => call<Dashboard>("get_dashboard"),
  getSessionQuestions: (mode: SessionMode, difficulty: Difficulty, category: string, count: number) =>
    call<SessionQuestion[]>("get_session_questions", { mode, difficulty, category, count }),
  submitAnswer: (payload: AnswerPayload) => call<AnswerResult>("submit_answer", { payload }),
  listSnacks: () => call<Snack[]>("list_snacks"),
  addSnack: (name: string, calories: number, icon: string) =>
    call<Snack>("add_snack", { name, calories, icon }),
  deleteSnack: (id: number) => call<void>("delete_snack", { id }),
  /** 目標に加える（goal: true）/ 目標から外す。お菓子自体は図鑑に残る */
  setGoalSnack: (id: number, goal: boolean) => call<Snack[]>("set_goal_snack", { id, goal }),
  logSnackEaten: (snackId: number) => call<DailyStats>("log_snack_eaten", { snackId }),
  eatWithTicket: (snackId: number) => call<DailyStats>("eat_with_ticket", { snackId }),
  getTodayConsumption: () => call<ConsumptionEntry[]>("get_today_consumption"),
  deleteConsumption: (id: number) => call<DailyStats>("delete_consumption", { id }),
  redeemCheatTicket: () => call<RedeemResult>("redeem_cheat_ticket"),
  getStats: () => call<Stats>("get_stats"),
  getDictionary: () => call<Record<string, string>>("get_dictionary"),
  getIdioms: () => call<string[]>("get_idioms"),
  resetProgress: () => call<void>("reset_progress"),

  // お菓子作りレシピ (the learner's word list)
  listRecipeWords: () => call<RecipeWord[]>("list_recipe_words"),
  addRecipeWord: (entry: RecipeWordInput) => call<RecipeAddResult>("add_recipe_word", { entry }),
  reviewRecipeWord: (id: number, remembered: boolean, mode: RecipeReviewMode) =>
    call<RecipeReviewResult>("review_recipe_word", { id, remembered, mode }),
  setRecipeMastered: (id: number, mastered: boolean) => call<RecipeWord>("set_recipe_mastered", { id, mastered }),
  deleteRecipeWords: (ids: number[]) => call<number>("delete_recipe_words", { ids }),
  logDebug: (message: string) => call<void>("log_debug", { message }).catch(() => undefined),

  // Native speech (Tauri only; the mock backend reports "unavailable").
  speechCapabilities: () => call<SpeechCapabilities>("speech_capabilities"),
  nativeSynthesize: (text: string, rate = -2) => invoke<ArrayBuffer>("native_synthesize", { text, rate }),
  nativeRecognize: (target: string, alternatives: string[], timeoutSecs = 6, lang = "en-US") =>
    call<NativeRecognition>("native_recognize", { target, alternatives, timeoutSecs, lang }),
};
