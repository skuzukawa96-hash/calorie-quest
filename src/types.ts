export type Mode = "choice" | "typing" | "speaking";
export type Difficulty = "low" | "mid" | "high" | "mixed";
export type Level = "low" | "mid" | "high";

export interface Question {
  id: number;
  key: string;
  kind: string;
  difficulty: Level;
  /** genre such as 食べ物 / 旅行・交通 / 文法 */
  category: string;
  en: string;
  ja: string;
  modes: Mode[];
  choices?: string[] | null;
  prompt?: string | null;
  hint?: string | null;
  audioPath?: string | null;
}

export interface SessionQuestion {
  question: Question;
  mode: Mode;
  isReview: boolean;
  display: string;
  subDisplay?: string | null;
  options: string[];
  answer: string;
}

export interface UserInfo {
  id: number;
  name: string;
  totalStudyDays: number;
  currentStreak: number;
  longestStreak: number;
  lastStudyDate?: string | null;
  goalSnackId?: number | null;
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
  文法: "✏️",
  慣用句: "🗣️",
};

export function categoryIcon(name: string): string {
  return CATEGORY_ICON[name] ?? "📚";
}

export interface Dashboard {
  user: UserInfo;
  today: DailyStats;
  goalSnack?: Snack | null;
  snacks: Snack[];
  categories: CategoryInfo[];
  dueReviewCount: number;
  ticketsAvailable: number;
  kcalRates: KcalRates;
}

export interface AnswerPayload {
  questionId: number;
  mode: Mode;
  correct: boolean;
  score?: number | null;
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
};

export const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  low: "低（英単語）",
  mid: "中（フレーズ・文法）",
  high: "高（慣用句・長文）",
  mixed: "ミックス",
};

export const LEVEL_SHORT: Record<Level, string> = { low: "低", mid: "中", high: "高" };
