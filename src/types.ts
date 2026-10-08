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
  /** other words with this piece in the same sense, shown when the piece is clicked */
  family?: PartFamily | null;
}

/**
 * Words sharing a piece in one sense (fid「信じる」: confidence, confidential). A piece spelt alike
 * in another sense (the con- of confident, すっかり) has none.
 */
export interface PartFamily {
  /** what the piece means in all of them */
  ja: string;
  /** where it comes from, as a fact: ラテン語 fidere「信じる」 */
  origin?: string | null;
  /** its spellings (spect / pect), to mark it in each word's parts */
  forms: string[];
  /** the others: three at most, five where the family allows */
  members: FamilyMember[];
}

export interface FamilyMember {
  word: string;
  ja: string;
  /** what it has in common with the rest: how the piece gives its meaning */
  note: string;
  /** how it is built, when the data has it */
  parts: WordPart[];
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
  /** irregular verbs: the word's own forms (buy – bought – bought), or those of the verbs a sentence uses */
  irregular: IrregularVerb[];
}

/**
 * An irregular verb's three forms, each alternative written out ("got / gotten"), and what is read
 * aloud for each in turn (the first alternative, or a spelling the voice reads right: read – red – red).
 */
export interface IrregularVerb {
  base: string;
  past: string;
  participle: string;
  say: string[];
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
  /**
   * the English of each option when the options are Japanese (野球 → baseball), shown in the wrong
   * options once the question is answered; empty when the options are English already
   */
  optionEn: string[];
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
  playMode: PlayMode;
}

/** 遊び方: がんばり（獲得カロリー ×0.5）/ 通常 / お気軽（×1.5）。Mirrors srs::PLAY_MODES. */
export type PlayMode = "hard" | "normal" | "easy";

/** The modes in the order the top bar's button cycles through them. */
export const PLAY_MODES: PlayMode[] = ["hard", "normal", "easy"];

export const PLAY_MODE_INFO: Record<PlayMode, { label: string; multiplier: number; desc: string }> = {
  hard: { label: "がんばり", multiplier: 0.5, desc: "すべての獲得カロリーが半分（×0.5）" },
  normal: { label: "通常", multiplier: 1, desc: "獲得カロリーはそのまま（等倍）" },
  easy: { label: "お気軽", multiplier: 1.5, desc: "すべての獲得カロリーが1.5倍" },
};

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
  /** a word picked from four: what the goals are counted in (あと何問) */
  wordChoice: number;
  /** any other question picked from four */
  choice: number;
  reviewMultiplier: number;
  cheatDayBonus: number;
  /** days a review may be carried over before it goes back to the ordinary questions */
  staleReviewDays: number;
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

/** The boxed tags before a meaning: 自動詞・他動詞, 名詞, 形容詞, 副詞. */
export type PosTag = "自" | "他" | "名" | "形" | "副";

/**
 * 自動詞・他動詞 of a verb (data/verb-types.json): the same meaning either way, each sense with its
 * own tag when the two differ (run: [["自", "走る"], ["他", "経営する"]]), or the one verb sense of
 * a word whose question is another part of speech (estimate: [["他", "見積もる"]]).
 */
export type VerbType = "自" | "他" | "自他" | Array<["自" | "他" | "自他", string]>;

/** What the tags are worked out from (commands::get_word_tags). */
export interface WordTags {
  /** English (lowercase) → [part of speech, Japanese] of each word question with it */
  words: Record<string, Array<[PartOfSpeech, string]>>;
  /** English (lowercase) → [part of speech, sense] of each sense of each word only the glossary has; empty: no tag */
  glossary: Record<string, Array<[PartOfSpeech, string]>>;
  verbTypes: Record<string, VerbType>;
  /** English (lowercase) → [group, nuance as a cue ("" when none)] of every 類似表現 group it is in */
  cues: Record<string, Array<[number, string]>>;
}

/** Tags with the sense they are for (none when they are for the whole word). */
export interface TagSense {
  tags: PosTag[];
  ja?: string;
}

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
  /** 試験: the levels, what they pay, and the exam questions waiting in review */
  exam: ExamOverview;
}

/* ---------- 試験 ---------- */

export type ExamLevel = "basic" | "toeic600" | "toeic800";
/** listening 応答問題 (TOEIC Part 2) / short 短文穴埋め (Part 5) / text 長文穴埋め (Part 6) / reading 読解 (Part 7) */
export type ExamPart = "listening" | "short" | "text" | "reading";

export const EXAM_PART_LABEL: Record<ExamPart, string> = {
  listening: "応答問題",
  short: "短文穴埋め",
  text: "長文穴埋め",
  reading: "読解問題",
};

export interface ExamLevelInfo {
  level: ExamLevel;
  label: string;
  /** kcal for passing, every time */
  reward: number;
  attempts: number;
  bestCorrect: number | null;
  bestTotal: number | null;
  passedEver: boolean;
  /** passed today: the 合格 mark on the level, gone the next day */
  passedToday: boolean;
  reviewCount: number;
  /** an exam of this level left part-way (中断中), to go on with */
  suspended: ExamSuspended | null;
}

/** How far the exam of a level left part-way got. */
export interface ExamSuspended {
  answered: number;
  total: number;
}

/** 試験の中断: an exam left before it was handed in, its questions in order and the answers so far. */
export interface ExamProgress {
  level: ExamLevel;
  questions: ExamQuestion[];
  answers: ExamAnswer[];
  /** when the last answer was kept, "2026-10-04T21:30:05" */
  savedAt: string;
}

export interface ExamOverview {
  levels: ExamLevelInfo[];
  reviewCount: number;
  questionCount: number;
  passPercent: number;
  /** kcal for trying when the exam is not passed, once a day per level */
  effortKcal: number;
  /** kcal for each question put right in the exam review */
  reviewKcal: number;
}

export interface ExamQuestion {
  id: string;
  setId: string;
  level: ExamLevel;
  part: ExamPart;
  title?: string | null;
  /** blanks are written [1], [2] … */
  passage?: string | null;
  passageJa?: string | null;
  /** 長文穴埋め: which blank this is */
  blank?: number | null;
  /** the sentence with ___, the line heard, or the question asked */
  prompt?: string | null;
  promptJa?: string | null;
  choices: string[];
  answer: string;
  explanation: string;
  point?: string | null;
  /** the sentence the question is about, completed: its words go to the recipe with it */
  sentence: string;
  sentenceJa?: string | null;
  notes?: WordNotes | null;
}

export interface ExamAnswer {
  id: string;
  chosen: string;
}

export interface ExamResult {
  level: ExamLevel;
  correct: number;
  total: number;
  passed: boolean;
  /** whole kcal added to today now */
  kcalEarned: number;
  /** what the exam earned after the play mode: the level's reward when passed, the effort bonus when not */
  points: number;
  todayKcal: number;
  streak: number;
  newTicket: boolean;
  reviewAdded: number;
}

/** What is starred, for the ☆ / ★ on the questions of a session or an exam. */
export interface FavoriteKeys {
  /** study questions, each starred in a mode */
  questions: { questionId: number; mode: Mode }[];
  /** exam question ids */
  exams: string[];
}

/** One お気に入り: a study question built for the mode it was starred in, or an exam question. */
export interface Favorite {
  id: number;
  addedAt: string;
  /** when it was last gone over in the favorites' review */
  lastReviewedAt?: string | null;
  question?: SessionQuestion | null;
  exam?: ExamQuestion | null;
}

export interface ExamReviewResult {
  correct: boolean;
  /** whole kcal added to today now */
  kcalEarned: number;
  /** what the answer earned after the play mode, in kcal (3 / 1.5 / 4.5) */
  points: number;
  todayKcal: number;
  remaining: number;
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
  /** whole kcal added to today now (with a fraction pending, it can differ from `points`) */
  kcalEarned: number;
  /** what the answer earned after the play mode, in kcal: 0.5 for a word picked in がんばり */
  points: number;
  /** a fraction of a calorie waits for the next reward today */
  fractionPending: boolean;
  todayKcal: number;
  streak: number;
  newTicket: boolean;
  firstStudyToday: boolean;
  isReview: boolean;
  /** a due review not done (missed, or spoken under 70): it stays in today's review */
  staysToday: boolean;
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
  /** what the day earned, after the play mode (as on the home) */
  kcalEarned: number;
  /** the snacks eaten that day */
  kcalConsumed: number;
  answered: number;
  correct: number;
  /** what was eaten that day, one snack a line, the most kcal first (those eaten with a ticket last) */
  eaten: EatenSnack[];
}

/** A snack eaten on a day: how many times and how many kcal in all (a ticket's cost no kcal of the day). */
export interface EatenSnack {
  icon: string;
  name: string;
  count: number;
  kcal: number;
  withTicket: boolean;
}

export interface WeakQuestion {
  question: Question;
  wrongCount: number;
  lastScore?: number | null;
  nextDue?: string | null;
}

export interface Stats {
  totalStudyDays: number;
  currentStreak: number;
  longestStreak: number;
  totalKcal: number;
  /** every snack eaten, in kcal (with `totalKcal`, over `totalStudyDays` for the averages) */
  totalConsumed: number;
  totalAnswered: number;
  totalCorrect: number;
  accuracy: number;
  last14Days: DayPoint[];
  weakQuestions: WeakQuestion[];
  tickets: Ticket[];
  reviewDue: number;
  reviewPending: number;
  /** the study answers by tab and mode (英単語 × 選択 …), for 累計獲得カロリー / 累計回答数 / 正答率 */
  breakdown: StatCell[];
}

/** The study answers of one tab in one mode: what they earned at 通常 (the play mode left aside), how many, how many right. */
export interface StatCell {
  tier: Tier;
  mode: Mode;
  kcal: number;
  answered: number;
  correct: number;
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
  /** set once the word is learned: right in a review of すべて / 復習中, or marked so */
  masteredAt?: string | null;
  /** how many times it was answered wrong in a review */
  misses: number;
  /** set when it was taken off the list (×): it waits in 除外中, apart from すべて */
  excludedAt?: string | null;
  /** its part of speech, or idiom (db::recipe_pos), or usage for a pattern, for sorting and filtering the list */
  pos: RecipePos;
  /** word (a word, phrase or idiom) / usage (a pattern saved from 用法, never read aloud) */
  kind: RecipeKind;
}

/**
 * What a recipe entry is: a word, a phrase or an idiom, or a pattern of 用法 ("compare A with B",
 * "be afraid of ～"). A pattern holds 人 / 原形 / -ing / ～, which no voice can read.
 */
export type RecipeKind = "word" | "usage";

/** How a recipe word is sorted: by part of speech, then idioms, then patterns. */
export type RecipePos = PartOfSpeech | "idiom" | "usage";
export const RECIPE_POS: RecipePos[] = ["noun", "verb", "adjective", "adverb", "idiom", "usage"];
export const RECIPE_POS_LABEL: Record<RecipePos, string> = { ...POS_LABEL, idiom: "慣用句", usage: "用法" };

export type RecipeWordInput = Pick<RecipeWord, "word" | "meaning" | "form" | "example" | "exampleJa"> & {
  kind?: RecipeKind;
};

/** added: new entry / exists: already listed / restored: was learned, now back in review */
export type RecipeAddStatus = "added" | "exists" | "restored" | "unexcluded";

export interface RecipeAddResult {
  status: RecipeAddStatus;
  entry: RecipeWord;
}

/** choice: pick the meaning of the English (0.5 kcal) / typing: write the English for the meaning (1 kcal) */
export type RecipeReviewMode = "choice" | "typing";

/**
 * The tab a recipe review goes over: すべて (every word not taken off), 復習中, 習得済み or 除外中.
 * It decides where an answer moves the word (recipe::review).
 */
export type RecipeTab = "all" | "learning" | "mastered" | "excluded";

export interface RecipeReviewResult {
  entry: RecipeWord;
  /**
   * what the answer earned after the play mode, in kcal: 0.5 / 1 the first time the word is right
   * today, half that after, 0 when wrong (then halved in がんばり, ×1.5 in お気軽)
   */
  points: number;
  /** the word had already been right today, so it paid half */
  repeat: boolean;
  /** whole kcal added to today just now; a fraction waits for the next right answer */
  kcalEarned: number;
  todayKcal: number;
  /** a fraction of a calorie is waiting for the next right answer today */
  fractionPending: boolean;
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
  /** how sure the engine was of the target phrase, from the result or the alternates it weighed */
  targetConfidence: number | null;
  /** the engine heard speech, even if it could not make out a phrase */
  heard: boolean;
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
