import { invoke } from "@tauri-apps/api/core";
import type {
  BackupInfo,
  BackupList,
  AnswerPayload,
  AnswerResult,
  ConsumptionEntry,
  DailyStats,
  Dashboard,
  ExamAnswer,
  ExamLevel,
  ExamProgress,
  ExamQuestion,
  ExamResult,
  ExamReviewResult,
  Favorite,
  FavoriteKeys,
  FavoriteReview,
  LexiDeal,
  LexiFinish,
  LexiGenre,
  LexiMode,
  LexiResult,
  Mode,
  NativeRecognition,
  PlayMode,
  RecipeAddResult,
  RecipeReviewMode,
  RecipeReviewResult,
  RecipeTab,
  RecipeWord,
  RecipeWordInput,
  RedeemResult,
  SessionMode,
  SessionQuestion,
  Snack,
  SpeechCapabilities,
  Stats,
  Task,
  TaskEntry,
  TierChoice,
  WeightResult,
  WordNotes,
  WordTags,
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
  getSessionQuestions: (mode: SessionMode, tier: TierChoice, category: string, count: number) =>
    call<SessionQuestion[]>("get_session_questions", { mode, tier, category, count }),
  submitAnswer: (payload: AnswerPayload) => call<AnswerResult>("submit_answer", { payload }),
  listSnacks: () => call<Snack[]>("list_snacks"),
  addSnack: (name: string, calories: number, icon: string) =>
    call<Snack>("add_snack", { name, calories, icon }),
  /** any snack of the book, the first ones too */
  updateSnack: (id: number, name: string, calories: number, icon: string) =>
    call<Snack>("update_snack", { id, name, calories, icon }),
  deleteSnack: (id: number) => call<void>("delete_snack", { id }),
  /** 目標に加える（goal: true）/ 目標から外す。お菓子自体は図鑑に残る */
  setGoalSnack: (id: number, goal: boolean) => call<Snack[]>("set_goal_snack", { id, goal }),
  logSnackEaten: (snackId: number) => call<DailyStats>("log_snack_eaten", { snackId }),
  /** 食べた記録とカロリーの消費だけ。図鑑にも目標にも入れない（一度しか食べないお菓子で図鑑が埋まらないように） */
  logOneOffSnack: (name: string, calories: number, icon: string) =>
    call<DailyStats>("log_one_off_snack", { name, calories, icon }),
  eatWithTicket: (snackId: number) => call<DailyStats>("eat_with_ticket", { snackId }),
  getTodayConsumption: () => call<ConsumptionEntry[]>("get_today_consumption"),
  deleteConsumption: (id: number) => call<DailyStats>("delete_consumption", { id }),
  redeemCheatTicket: () => call<RedeemResult>("redeem_cheat_ticket"),
  /** がんばり / 通常 / お気軽: what is earned from now on is scaled by it */
  setPlayMode: (mode: PlayMode) => call<PlayMode>("set_play_mode", { mode }),
  getStats: () => call<Stats>("get_stats"),

  // ダイエット機能: 課題 (done for kcal, as they say whatever the play mode) and the weight
  setDietMode: (on: boolean) => call<boolean>("set_diet_mode", { on }),
  listTasks: () => call<Task[]>("list_tasks"),
  addTask: (name: string, calories: number, icon: string) => call<Task>("add_task", { name, calories, icon }),
  updateTask: (id: number, name: string, calories: number, icon: string) =>
    call<Task>("update_task", { id, name, calories, icon }),
  deleteTask: (id: number) => call<void>("delete_task", { id }),
  setGoalTask: (id: number, goal: boolean) => call<Task[]>("set_goal_task", { id, goal }),
  logTaskDone: (taskId: number) => call<DailyStats>("log_task_done", { taskId }),
  /** 達成の記録とカロリーの獲得だけ。課題一覧にも目標にも入れない */
  logOneOffTask: (name: string, calories: number, icon: string) =>
    call<DailyStats>("log_one_off_task", { name, calories, icon }),
  getTodayTasks: () => call<TaskEntry[]>("get_today_tasks"),
  deleteTaskDone: (id: number) => call<DailyStats>("delete_task_done", { id }),
  /** the height BMI is worked out from, kept until it is changed */
  setHeight: (heightCm: number) => call<number>("set_height", { heightCm }),
  /** today's weight at the height kept, once a day (it pays the daily bonus) */
  recordWeight: (weightKg: number) => call<WeightResult>("record_weight", { weightKg }),
  /** 💾 バックアップ: the backups folder and its files, newest first */
  listBackups: () => call<BackupList>("list_backups"),
  createBackup: () => call<BackupInfo>("create_backup"),
  /** puts the record of backup `name` back, after backing up what is there now */
  restoreBackup: (name: string) => call<void>("restore_backup", { name }),
  /** deletes backup `name` from the folder */
  deleteBackup: (name: string) => call<void>("delete_backup", { name }),
  /** LexiLink: the ten pairs of a game */
  dealLexiLink: (mode: LexiMode, genre: LexiGenre, preferLearned: boolean) =>
    call<LexiDeal>("deal_lexilink", { mode, genre, preferLearned }),
  /** LexiLink: a game finished or left part-way (its kcal, and the day counts as studied) */
  finishLexiLink: (game: LexiFinish) => call<LexiResult>("finish_lexilink", { game }),
  openBackupFolder: () => call<void>("open_backup_folder"),
  getDictionary: () => call<Record<string, string>>("get_dictionary"),
  getIdioms: () => call<string[]>("get_idioms"),
  /** word → its IPA sounds separated by spaces (CMU Pronouncing Dictionary) */
  getPronunciations: () => call<Record<string, string>>("get_pronunciations"),
  /** how a word is built, sentences and patterns using it, an idiom's origin; null when none */
  /** a word's notes; `meaning` (what it was saved with) picks the sense of its 対義語 */
  getWordNotes: (word: string, meaning?: string) => call<WordNotes | null>("get_word_notes", { word, meaning: meaning ?? null }),
  /** the word questions' parts of speech and the verbs' 自・他, for the tags before a meaning */
  getWordTags: () => call<WordTags>("get_word_tags"),
  resetProgress: () => call<void>("reset_progress"),

  // 試験
  startExam: (level: ExamLevel) => call<ExamQuestion[]>("start_exam", { level }),
  finishExam: (level: ExamLevel, answers: ExamAnswer[]) => call<ExamResult>("finish_exam", { level, answers }),
  getExamProgress: (level: ExamLevel) => call<ExamProgress | null>("get_exam_progress", { level }),
  saveExamProgress: (level: ExamLevel, questionIds: string[], answers: ExamAnswer[]) =>
    call<void>("save_exam_progress", { level, questionIds, answers }),
  discardExamProgress: (level: ExamLevel) => call<void>("discard_exam_progress", { level }),
  getExamReview: () => call<ExamQuestion[]>("get_exam_review"),
  answerExamReview: (id: string, chosen: string) => call<ExamReviewResult>("answer_exam_review", { id, chosen }),

  // お気に入り: questions starred (☆ → ★); going over them again pays nothing and records nothing
  getFavoriteKeys: () => call<FavoriteKeys>("get_favorite_keys"),
  setQuestionFavorite: (questionId: number, mode: Mode, on: boolean) =>
    call<void>("set_question_favorite", { questionId, mode, on }),
  setExamFavorite: (examId: string, on: boolean) => call<void>("set_exam_favorite", { examId, on }),
  listFavorites: () => call<Favorite[]>("list_favorites"),
  /** a favorite answered in its review: right, it pays once a day (英単語 1 kcal, the others 2 kcal) */
  reviewFavorite: (id: number, correct: boolean) => call<FavoriteReview>("review_favorite", { id, correct }),

  // お菓子作りレシピ (the learner's word list)
  listRecipeWords: () => call<RecipeWord[]>("list_recipe_words"),
  addRecipeWord: (entry: RecipeWordInput) => call<RecipeAddResult>("add_recipe_word", { entry }),
  reviewRecipeWord: (id: number, remembered: boolean, mode: RecipeReviewMode, target: RecipeTab) =>
    call<RecipeReviewResult>("review_recipe_word", { id, remembered, mode, target }),
  /** ✓ 覚えた (true) or 復習に戻す (false); either way the word leaves 除外中 */
  setRecipeMastered: (id: number, mastered: boolean) => call<RecipeWord>("set_recipe_mastered", { id, mastered }),
  setRecipeWordsMastered: (ids: number[], mastered: boolean) =>
    call<number>("set_recipe_words_mastered", { ids, mastered }),
  /** ☆ / ★: a starred word is in review (one learned or taken off comes back into 復習) */
  setRecipeFavorite: (id: number, favorite: boolean) => call<RecipeWord>("set_recipe_favorite", { id, favorite }),
  /** ★ / unstar many at once (すべて復習へ in ★); how many there were */
  setRecipeWordsFavorite: (ids: number[], favorite: boolean) =>
    call<number>("set_recipe_words_favorite", { ids, favorite }),
  /** × outside 除外中: the words wait in 除外中 */
  excludeRecipeWords: (ids: number[]) => call<number>("exclude_recipe_words", { ids }),
  /** × in 除外中: deleted for good */
  deleteRecipeWords: (ids: number[]) => call<number>("delete_recipe_words", { ids }),
  /** the meanings of every pattern of 用法: wrong options for a pattern saved to the recipe */
  /** every pattern's meaning with a pattern of it: [meaning, pattern] */
  getUsageMeanings: () => call<Array<[string, string]>>("get_usage_meanings"),
  logDebug: (message: string) => call<void>("log_debug", { message }).catch(() => undefined),

  // Native speech (Tauri only; the mock backend reports "unavailable").
  speechCapabilities: () => call<SpeechCapabilities>("speech_capabilities"),
  nativeSynthesize: (text: string, rate = -2) => invoke<ArrayBuffer>("native_synthesize", { text, rate }),
  /** A WAV for each text, made one after another by one voice: each is a u32 (LE) length, then the WAV. */
  nativeSynthesizeAll: (texts: string[], rate = -2) => invoke<ArrayBuffer>("native_synthesize_all", { texts, rate }),
  nativeRecognize: (target: string, alternatives: string[], timeoutSecs = 6, lang = "en-US") =>
    call<NativeRecognition>("native_recognize", { target, alternatives, timeoutSecs, lang }),
};
