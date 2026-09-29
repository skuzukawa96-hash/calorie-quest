export type Mode = "choice" | "typing" | "speaking" | "listening";
/** a study session: one mode, or "review" (every due review, each in the mode it was missed in) */
export type SessionMode = Mode | "review";
export type Difficulty = "low" | "mid" | "high" | "mixed";
export type Level = "low" | "mid" | "high";

export interface Question {
  id: number;
  key: string;
  kind: string;
  difficulty: Level;
  /** genre such as 食べ物 / 旅行・交通 / 文法 */
  category: string;
  /** fine-grained semantic field (果物, 乗り物, …) that distractors are drawn from */
  group: string;
  en: string;
  ja: string;
  modes: Mode[];
  choices?: string[] | null;
  prompt?: string | null;
  hint?: string | null;
  audioPath?: string | null;
  /** idioms carry a sentence showing the expression in use, plus its translation */
  example?: string | null;
  exampleJa?: string | null;
  /** grammar questions name the point they test ("present-perfect", "relative-pronoun", …) */
  point?: string | null;
}

/** The explanation shown with a grammar answer; one note serves every question on that point. */
export interface GrammarNote {
  title: string;
  body: string;
  example: string;
}

export interface SessionQuestion {
  question: Question;
  mode: Mode;
  isReview: boolean;
  display: string;
  subDisplay?: string | null;
  options: string[];
  answer: string;
  /** every English the grader accepts for typing: `answer` plus same-meaning siblings in the group */
  accepted: string[];
  /** English to speak: the completed sentence for grammar, the spoken line for dialogues */
  audioText: string;
  /** listening mode keeps the English hidden until the answer is in */
  hideText: boolean;
  /** grammar questions carry the explanation of the point they test */
  grammarNote?: GrammarNote | null;
}

export interface UserInfo {
  id: number;
  name: string;
  totalStudyDays: number;
  currentStreak: number;
  longestStreak: number;
  lastStudyDate?: string | null;
}

export interface DailyStats {
  date: string;
  kcalEarned: number;
  kcalConsumed: number;
  answered: number;
  correct: number;
}

export interface Snack {
  id: number;
  name: string;
  calories: number;
  icon: string;
  isBuiltin: boolean;
}

export interface KcalRates {
  low: number;
  mid: number;
  high: number;
  reviewMultiplier: number;
  cheatDayBonus: number;
}

export interface CategoryInfo {
  name: string;
  total: number;
  low: number;
  mid: number;
  high: number;
}

export const ALL_CATEGORIES = "all";

export const CATEGORY_ICON: Record<string, string> = {
  食べ物: "🍰",
  日常生活: "🏠",
  "旅行・交通": "✈️",
  買い物: "🛍️",
  "学校・仕事": "💼",
  "自然・天気": "🌤️",
  "からだ・健康": "💪",
  "気持ち・性格": "💬",
  "時間・数": "⏰",
  動物: "🐾",
  "趣味・スポーツ": "⚽",
  "色・かたち": "🎨",
  "人・職業": "👤",
  "街・建物": "🏙️",
  テクノロジー: "💻",
  科学: "🔬",
  "社会・くらし": "🏛️",
  "芸術・文化": "🎭",
  文法: "✏️",
  慣用句: "🗣️",
};

export function categoryIcon(name: string): string {
  return CATEGORY_ICON[name] ?? "📚";
}

export interface Dashboard {
  user: UserInfo;
  today: DailyStats;
  /** 目標のお菓子（カロリーの少ない順） */
  goalSnacks: Snack[];
  /** 今日食べたお菓子の id。目標やバーのアイコンに「食べた」を付ける */
  eatenToday: number[];
  snacks: Snack[];
  categories: CategoryInfo[];
  dueReviewCount: number;
  ticketsAvailable: number;
  kcalRates: KcalRates;
  savings: SavingsInfo;
}

/** 使わなかったカロリーの貯蓄と、それが変わったお菓子引換券。 */
export interface SavingsInfo {
  balance: number;
  /** この量で引換券1枚 */
  perTicket: number;
  /** まだ使っていないお菓子引換券 */
  snackTickets: number;
  /** この読み込みで締めた前日までの残り（日付が変わって最初の1回だけ 0 以外） */
  justSaved: number;
  justIssued: number;
}

export interface AnswerPayload {
  questionId: number;
  mode: Mode;
  correct: boolean;
  score?: number | null;
  /** 記入問題でヒントの単語を開示した数。1語ごとに獲得カロリーが半分になる。 */
  hintsUsed?: number;
  /** 記入問題で正解と食い違った語の数（違う語・抜けた語・余分な語）。中難易度は1語ごとに −1 kcal。 */
  mistakes?: number;
}

export interface AnswerResult {
  kcalEarned: number;
  todayKcal: number;
  streak: number;
  newTicket: boolean;
  firstStudyToday: boolean;
  isReview: boolean;
  needsReview: boolean;
  nextDue?: string | null;
}

export interface ConsumptionEntry {
  id: number;
  snackName: string;
  snackIcon: string;
  calories: number;
  eatenAt: string;
  /** お菓子引換券で食べた（カロリー予算を使っていない） */
  withTicket: boolean;
}

export interface RedeemResult {
  kcalAdded: number;
  todayKcal: number;
  ticketsLeft: number;
}

export interface Ticket {
  id: number;
  issuedAt: string;
  issuedForStreak: number;
  usedAt?: string | null;
}

export interface DayPoint {
  date: string;
  kcalEarned: number;
  answered: number;
  correct: number;
}

export interface WeakQuestion {
  question: Question;
  wrongCount: number;
  lastScore?: number | null;
  nextDue?: string | null;
  srsLevel: number;
}

export interface Stats {
  totalStudyDays: number;
  currentStreak: number;
  longestStreak: number;
  totalKcal: number;
  totalAnswered: number;
  totalCorrect: number;
  accuracy: number;
  last14Days: DayPoint[];
  weakQuestions: WeakQuestion[];
  tickets: Ticket[];
  reviewDue: number;
  reviewPending: number;
}

/** One entry of お菓子作りレシピ, the learner's own word list. */
export interface RecipeWord {
  id: number;
  /** dictionary form ("hear"), or the whole expression for a phrase ("doggy bag") */
  word: string;
  meaning: string;
  /** the form that was right-clicked ("heard"), marked in the example */
  form: string;
  /** the sentence the word was found in, empty when it was a lone headword */
  example: string;
  exampleJa: string;
  addedAt: string;
  reviews: number;
  lastReviewedAt?: string | null;
  /** set once the word is marked learned; learned words can be cleared out */
  masteredAt?: string | null;
}

export type RecipeWordInput = Pick<RecipeWord, "word" | "meaning" | "form" | "example" | "exampleJa">;

/** added: new entry / exists: already listed / restored: was learned, now back in review */
export type RecipeAddStatus = "added" | "exists" | "restored";

export interface RecipeAddResult {
  status: RecipeAddStatus;
  entry: RecipeWord;
}

/** choice: pick the meaning of the English (0.5 kcal) / typing: write the English for the meaning (1 kcal) */
export type RecipeReviewMode = "choice" | "typing";

export interface RecipeReviewResult {
  entry: RecipeWord;
  /** whole kcal added to today just now; half a calorie waits for the next one */
  kcalEarned: number;
  todayKcal: number;
  /** 0.5 kcal is waiting for the next correct pick today */
  halfPending: boolean;
}

export interface SpeechCapabilities {
  nativeTts: boolean;
  ttsVoices: string[];
  nativeStt: boolean;
  sttLanguages: string[];
  sttError?: string | null;
}

export interface NativeRecognition {
  status: string;
  text: string;
  confidence: "high" | "medium" | "low" | "rejected";
  rawConfidence: number;
  durationMs: number;
  matched: boolean;
}

export const MODE_LABEL: Record<Mode, string> = {
  choice: "選択問題",
  typing: "記入問題",
  speaking: "発音問題",
  listening: "ヒアリング問題",
};

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  low: "低（英単語）",
  mid: "中（フレーズ・文法）",
  high: "高（慣用句・長文）",
  mixed: "ミックス",
};

export const LEVEL_SHORT: Record<Level, string> = { low: "低", mid: "中", high: "高" };
