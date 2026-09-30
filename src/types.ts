export type Mode = "choice" | "typing" | "speaking" | "listening";
/** a study session: one mode, or "review" (every due review, each in the mode it was missed in) */
export type SessionMode = Mode | "review";
/** the home screen's tabs: 英単語 / 文法 / 慣用句 / フレーズ / 例文 */
export type Tier = "word" | "compound" | "grammar" | "idiom" | "phrase" | "example";
/** a tab, or every tab at once */
export type TierChoice = Tier | "mixed";
/** a question's level: sets the listening and speaking rate (2 / 4 / 10 kcal) */
export type Level = "low" | "mid" | "high";

export interface Question {
  id: number;
  key: string;
  kind: string;
  difficulty: Level;
  /** which tab it is in */
  tier: Tier;
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

/** One piece of a word: pre- 「前もって」, paid 「支払った」, -ness 「〜であること」. */
export interface WordPart {
  kind: "prefix" | "root" | "suffix";
  text: string;
  ja: string;
}

/** A sentence using a word, with its Japanese. */
export interface ExampleSentence {
  en: string;
  ja: string;
}

/** A pattern a word is used in: "compare A with B" AとBを比較する, with a sentence using it. */
export interface WordUsage {
  pattern: string;
  ja: string;
  example: string;
  exampleJa: string;
}

/**
 * What the answer explains about a word or an idiom beyond its meaning (db::word_notes). Each part
 * is empty when the data has nothing for it.
 */
export interface WordNotes {
  parts: WordPart[];
  examples: ExampleSentence[];
  usages: WordUsage[];
  /** for an idiom whose origin is known: where it comes from */
  origin?: string | null;
  /** similar or easily confused words (lend / borrow / rent), each with how it differs */
  related: RelatedGroup[];
  /**
   * for a sentence (grammar, idiom, phrase, example, dialogue): its words whose pattern it uses
   * ("compared his life to" → compare A to B), or that are easily confused with others
   */
  used: UsedWord[];
}

/** A word of a sentence with the patterns of it that the sentence uses. */
export interface UsedWord {
  word: string;
  /** how it differs from similar words, when it has any */
  nuance?: string | null;
  usages: WordUsage[];
  related: RelatedGroup[];
}

/** Words easily confused with each other, shown under 用法 behind 類似表現. */
export interface RelatedGroup {
  title: string;
  members: RelatedWord[];
}

export interface RelatedWord {
  word: string;
  /** how it differs from the others: 「（物・場所が）不気味でぞっとする」 */
  nuance: string;
  /** the word whose answer is on screen; its patterns are already shown above */
  isSelf: boolean;
  usages: WordUsage[];
  /** a sentence using it, for a word without patterns */
  example?: ExampleSentence | null;
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
  /** words and idioms carry how they are built, sentences, patterns and origin, shown with the answer */
  notes?: WordNotes | null;
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
  /** how many times it has been recorded as eaten (with kcal or a ticket) */
  eatenCount: number;
}

export interface KcalRates {
  low: number;
  mid: number;
  high: number;
  /** any choice question but a word */
  choice: number;
  idiomTyping: number;
  reviewMultiplier: number;
  cheatDayBonus: number;
}

export interface CategoryInfo {
  name: string;
  total: number;
  /** questions per tab */
  word: number;
  compound: number;
  grammar: number;
  idiom: number;
  phrase: number;
  example: number;
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
  "あいさつ・あいづち": "👋",
  気持ちを伝える: "💗",
  "お願い・誘い": "🙏",
  "質問・確認": "❓",
  "意見・評価": "💭",
  決まり文句: "📣",
  副詞: "🔤",
};

export function categoryIcon(name: string): string {
  return CATEGORY_ICON[name] ?? "📚";
}

/** The part of speech of a word in the 英単語 tab. */
export type PartOfSpeech = "noun" | "verb" | "adjective" | "adverb";

export const POS_LABEL: Record<PartOfSpeech, string> = { noun: "名詞", verb: "動詞", adjective: "形容詞", adverb: "副詞" };

export interface PartOfSpeechInfo {
  pos: PartOfSpeech;
  total: number;
}

/** The category a session asks for to get the words of one part of speech. */
export const posCategory = (pos: PartOfSpeech) => `pos:${pos}`;

/** How a session's category reads: 名詞 for a part of speech, the icon and name for a genre. */
export function categoryLabel(category: string): string {
  const pos = category.startsWith("pos:") ? POS_LABEL[category.slice(4) as PartOfSpeech] : undefined;
  return pos ?? `${categoryIcon(category)} ${category}`;
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
  /** 英単語 by part of speech, for the chips above the genres */
  partsOfSpeech: PartOfSpeechInfo[];
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
  /** the answer earned its 0.5 / 1 kcal: right, and the word had not paid yet today */
  counted: boolean;
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

export const TIER_LABEL: Record<TierChoice, string> = {
  word: "英単語",
  compound: "複合語",
  grammar: "文法",
  idiom: "慣用句",
  phrase: "フレーズ",
  example: "例文",
  mixed: "ミックス",
};

export const TIERS: Tier[] = ["word", "compound", "grammar", "idiom", "phrase", "example"];
