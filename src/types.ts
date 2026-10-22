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

/**
 * One piece of a word: pre- 「前もって」, paid 「支払った」, -ness 「〜であること」; or the word it is
 * made from, its 元の語 (`base`: accuse of accusation, in the sense it keeps), and for a base
 * whose spelling changes beyond a suffix what it becomes (`change`, no text: speak → speech).
 */
export interface WordPart {
  kind: "prefix" | "root" | "suffix" | "base" | "change";
  text: string;
  ja: string;
  /** other words with this piece in the same sense, shown when the piece is clicked */
  family?: PartFamily | null;
  /** for a base word: how it is built in turn, where the data splits it (reimburse: re- + imburse) */
  chain?: WordPart[] | null;
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

/**
 * What an abbreviation stands for, the letters it keeps in brackets: "[m]agnetic [r]esonance
 * [i]maging" (an acronym, 正式名称), "[exam]ination" (a clipped word, 略さない形); `lang` names a
 * language other than English (RSVP: フランス語).
 */
export interface Abbreviation {
  kind: "acronym" | "clipping";
  full: string;
  ja: string;
  lang?: string | null;
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
  /** for a word whose meaning has moved far from its base word's (hardly from hard): how */
  shift?: string | null;
  /** for an abbreviation: what it stands for (MRI: magnetic resonance imaging) */
  abbreviation?: Abbreviation | null;
  /** for a word with an opposite in the sense asked or saved: that word (accept ⇔ refuse 断る) */
  antonym?: Antonym | null;
}

/** A word's 対義語 and the meaning of it to show (light 軽い ⇔ heavy 重い). */
export interface Antonym {
  word: string;
  meaning: string;
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
  /** the broad 文法項目 (時制, 比較…) the お気に入り sorts and reviews by */
  category: string;
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
  /** ダイエット機能: 課題一覧・目標の課題・体重と BMI のグラフを出す */
  dietMode: boolean;
  /** the height BMI is worked out from, once given */
  heightCm?: number | null;
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
  /** what days over-eaten carried into this one (0 or less), taken off its budget */
  carriedKcal: number;
}

/** What is left to eat on a day: earned − eaten, less what an over-eaten day before carried in. */
export function remainingKcal(day: DailyStats): number {
  return day.kcalEarned - day.kcalConsumed + Math.min(0, day.carriedKcal ?? 0);
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

/** ダイエット機能の課題: something done for kcal (腕立て伏せ 10回 30 kcal), the other way round from a snack. */
export interface Task {
  id: number;
  name: string;
  /** what doing it earns */
  calories: number;
  icon: string;
  isBuiltin: boolean;
  /** how many times it has been done */
  doneCount: number;
}

/** A 課題 done today, in the day's log beside the snacks eaten. */
export interface TaskEntry {
  id: number;
  taskName: string;
  taskIcon: string;
  calories: number;
  doneAt: string;
}

/** The weight of a day, the height it was weighed at, and the BMI they make. */
export interface WeightPoint {
  date: string;
  weightKg: number;
  heightCm: number;
  bmi: number;
  /** 体脂肪率 (%), when given with the weight (not every scale measures it) */
  bodyFat: number | null;
}

/** What ダイエット機能 has paid: the 課題 done and the weights' daily bonus. */
export interface DietKcal {
  tasks: number;
  weight: number;
}

export interface WeightResult {
  point: WeightPoint;
  /** kcal paid now (a day's weight is recorded once) */
  bonus: number;
  today: DailyStats;
}

export interface KcalRates {
  /** a word picked from four: what the goals are counted in (あと何問) */
  wordChoice: number;
  /** a compound or an idiom picked from four */
  phraseChoice: number;
  /** a sentence picked from four: a grammar question, a phrase, an example */
  sentenceChoice: number;
  reviewMultiplier: number;
  cheatDayBonus: number;
  /** days a review may be carried over before it goes back to the ordinary questions */
  staleReviewDays: number;
  /** what recording the day's weight pays (ダイエット機能) */
  weightBonus: number;
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

/** A 文法項目 of the 文法 tab (時制, 接続詞…) and its questions: a chip of the home. */
export interface GrammarPointInfo {
  point: string;
  total: number;
}

/**
 * The questions of one tab, genre and part of speech each mode can ask, counted as a session picks
 * them (ヒアリング takes the questions with English to say as well).
 */
export interface ModeCount {
  tier: Tier;
  category: string;
  pos?: PartOfSpeech | null;
  /** the 文法項目 of grammar questions (時制…); none for the others */
  grammarPoint?: string | null;
  choice: number;
  typing: number;
  speaking: number;
  listening: number;
}

/** The category a session asks for to get the words of one part of speech. */
export const posCategory = (pos: PartOfSpeech) => `pos:${pos}`;
/** A 文法項目 asked for as a session's category ("gp:時制"), as a part of speech is ("pos:noun"). */
export const grammarPointCategory = (point: string) => `gp:${point}`;

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
  /** English (lowercase) → [part of speech, Japanese] of each word question with it (sense by sense where sense-pos.json writes them) */
  words: Record<string, Array<[PartOfSpeech, string]>>;
  /** English (lowercase) of a word question → [part of speech, sense] of each sense only the glossary adds ("none": no tag) */
  added: Record<string, Array<[PartOfSpeech, string]>>;
  /** English (lowercase) → [part of speech, sense] of each sense of each word only the glossary has; empty: no tag */
  glossary: Record<string, Array<[PartOfSpeech, string]>>;
  verbTypes: Record<string, VerbType>;
  /** English (lowercase) → [group, nuance as a cue ("" when none)] of every 類似表現 group it is in */
  cues: Record<string, Array<[number, string]>>;
  /** English (lowercase) → its words of the same spelling, each as the senses that are its (bark: 樹皮 / ほえる) */
  homonyms: Record<string, string[][]>;
}

/** Tags with the sense they are for (none when they are for the whole word). */
export interface TagSense {
  tags: PosTag[];
  ja?: string;
}

/** How a session's category reads: 名詞 for a part of speech, the icon and name for a genre. */
export function categoryLabel(category: string): string {
  const pos = category.startsWith("pos:") ? POS_LABEL[category.slice(4) as PartOfSpeech] : undefined;
  if (category.startsWith("gp:")) return category.slice(3);
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
  /** 目標の課題（カロリーの少ない順） */
  goalTasks: Task[];
  /** 今日やった課題の id */
  doneToday: number[];
  /** 課題一覧 */
  tasks: Task[];
  /** today's weight, once recorded (a day is weighed once) */
  weightToday?: WeightPoint | null;
  categories: CategoryInfo[];
  /** 英単語 by part of speech, for the chips above the genres */
  partsOfSpeech: PartOfSpeechInfo[];
  /** 文法 by 文法項目 (時制, 接続詞…), for the chips above the genres */
  grammarPoints: GrammarPointInfo[];
  /** how many questions each mode can ask, by tab, genre and part of speech */
  modeCounts: ModeCount[];
  dueReviewCount: number;
  ticketsAvailable: number;
  kcalRates: KcalRates;
  savings: SavingsInfo;
  /** 試験: the levels, what they pay, and the exam questions waiting in review */
  exam: ExamOverview;
}

/* ---------- LexiLink（英単語の神経衰弱） ---------- */

/** Word Match（英単語 × 意味）/ Opposites（英単語 × 対義語） */
export type LexiMode = "match" | "opposites";
export type LexiGenre = "random" | "noun" | "verb" | "adjective" | "adverb";
export const LEXI_MODES: LexiMode[] = ["match", "opposites"];
/** ふたりで対戦 against the computer: its level (lib/lexiCom.ts) */
export type ComLevel = "easy" | "normal" | "hard";
export const LEXI_GENRES: LexiGenre[] = ["random", "noun", "verb", "adjective", "adverb"];

/** The board and its kcal (mirrors lexilink.rs): ひとりで 3 a pair, お手つき free up to the third and
 * −1 each after, 10 for clearing the board; ふたりで 30 for a game played to the end, and against the
 * computer 20 / 30 / 45 for a win by its level, 10 for a loss or a draw. */
export const LEXI = {
  pairs: 10,
  pairKcal: 3,
  freeMisses: 3,
  missKcal: 1,
  clearKcal: 10,
  versusKcal: 30,
  comWinKcal: { easy: 20, normal: 30, hard: 45 } as Record<ComLevel, number>,
  comLoseKcal: 10,
} as const;

/** ひとりで: what the pairs and the お手つき so far come to (with the clear when `cleared`); below zero
 * when the misses outweigh the pairs. */
export const lexiScore = (pairs: number, misses: number, cleared: boolean) =>
  pairs * LEXI.pairKcal - Math.max(0, misses - LEXI.freeMisses) * LEXI.missKcal + (cleared ? LEXI.clearKcal : 0);

/** ふたりで: what a game adds (mirrors lexilink::finish): left part-way nothing; played to the end, 30
 * against a person, and against the computer its level's win or, lost or drawn, 10. */
export const lexiVersusKcal = (com: ComLevel | null, playerPairs: number, cleared: boolean) =>
  !cleared ? 0 : !com ? LEXI.versusKcal : playerPairs > LEXI.pairs - playerPairs ? LEXI.comWinKcal[com] : LEXI.comLoseKcal;

/** ひとりで: what a game adds (mirrors lexilink::solo_kcal): a cleared game its score as it is, one left
 * part-way what it is above zero. */
export const lexiSoloKcal = (pairs: number, misses: number, cleared: boolean) =>
  cleared ? lexiScore(pairs, misses, true) : Math.max(0, lexiScore(pairs, misses, false));

/** One card: `text` is what it says (the English, or the meaning in Word Match); `word` and `meaning` are what the pair's line shows once it is taken. */
export interface LexiCard {
  text: string;
  /** the card says English (read aloud when the pair is taken) */
  english: boolean;
  word: string;
  meaning: string;
}

export interface LexiPair {
  a: LexiCard;
  b: LexiCard;
}

export interface LexiDeal {
  mode: LexiMode;
  genre: LexiGenre;
  pairs: LexiPair[];
}

/** How a game ended (finished, or left part-way), for its kcal. */
export interface LexiFinish {
  /** 1: ひとりで挑戦, 2: ふたりで対戦 */
  players: 1 | 2;
  pairs: number;
  misses: number;
  cleared: boolean;
  /** ふたりで対戦 against the computer: its level */
  com?: ComLevel | null;
  /** ふたりで対戦: the pairs 先攻 (the person, against the computer) took */
  playerPairs?: number;
}

export interface LexiResult {
  /** what the game added to today (below zero when a cleared game's misses outweighed it) */
  kcalEarned: number;
  todayKcal: number;
  streak: number;
  newTicket: boolean;
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
  /** kcal for trying when the exam is not passed, every time */
  effort: number;
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
  /** answered right in today's review already: it pays no more today, and the review asks the others first */
  paidToday: boolean;
  question?: SessionQuestion | null;
  exam?: ExamQuestion | null;
}

/** What an answer in お気に入りの復習 did: a favorite answered right pays once a day. */
export interface FavoriteReview {
  /** what it paid, after the play mode (0 when wrong or paid already today) */
  points: number;
  kcalEarned: number;
  /** right, but it had paid already today */
  paidBefore: boolean;
}

/**
 * The 文法項目 a grammar question (its explanation's) or an exam question belongs to, in the order the
 * お気に入り lists them: mirrors db::POINT_CATEGORIES.
 */
export const POINT_CATEGORIES = [
  "時制", "主語と動詞の一致", "助動詞", "受け身", "仮定法", "不定詞・動名詞", "分詞", "文型", "構文", "文の種類",
  "関係詞", "接続詞", "接続副詞", "前置詞", "代名詞", "冠詞", "数量", "比較", "品詞", "語彙", "文挿入",
];

export interface ExamReviewResult {
  correct: boolean;
  /** whole kcal added to today now */
  kcalEarned: number;
  /** what the answer earned after the play mode, in kcal (3 / 1.5 / 4.5) */
  points: number;
  todayKcal: number;
  remaining: number;
}

/** One backup in Documents > CalorieQuest > backups (backup.rs). */
export interface BackupInfo {
  /** the file name: calorie-quest_2026-10-12_153000.db */
  name: string;
  /** when it was written, local time (2026-10-12T15:30:00) */
  madeAt: string;
  bytes: number;
  /** made by the app just before a restore, of what was there then */
  beforeRestore: boolean;
}

/** The backups folder and what is in it, newest first. */
export interface BackupList {
  folder: string;
  backups: BackupInfo[];
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
  /** この読み込みで今日に持ち越した、食べすぎて終わった日のマイナス（0 以下） */
  justCarried: number;
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
  /** the 課題 done that day, one a line, the most kcal first (ダイエット機能: the weight chart's dots) */
  done: DoneTask[];
}

/** A 課題 done on a day: how many times and how many kcal in all. */
export interface DoneTask {
  icon: string;
  name: string;
  count: number;
  kcal: number;
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
  /** what was earned and answered, by where it belongs, for 累計獲得カロリー / 累計回答数 / 正答率 */
  breakdown: Breakdown;
  /** what ダイエット機能 has paid in all, while it is on (off, it is left out of the totals and the chart too) */
  dietKcal?: DietKcal | null;
  /** the weights recorded in the last two weeks, oldest first (ダイエット機能) */
  weights: WeightPoint[];
  heightCm?: number | null;
  /** what the first weight recorded in a day pays */
  weightBonusKcal: number;
}

/**
 * The 記録's tables behind 累計獲得カロリー / 累計回答数 / 正答率. The kcal are those each reward added to
 * its day, so they add up to the total; お気に入りの復習 is counted with the question it reviews.
 */
export interface Breakdown {
  /** the study questions by tab and mode */
  study: StatCell[];
  /** 単語帳の復習 by mode (choice / typing) */
  recipe: Array<{ mode: Mode; kcal: number }>;
  /** the exam levels in order, with their names */
  levels: Array<{ level: ExamLevel; label: string }>;
  /** the exam questions handed in by level and part */
  exams: ExamCell[];
  /** what the exams paid by level and kind, by what each paid */
  examKcal: ExamKcal[];
  /** the cheat days used and what they paid */
  cheat: { times: number; kcal: number };
  /** LexiLink's games (every one settled, those that added nothing too) and what they added (below zero for one whose misses outweighed it) */
  lexilink: { times: number; kcal: number };
}

/** The study questions of one tab in one mode: the whole kcal they added to their days (after the play mode), how many, how many right. */
export interface StatCell {
  tier: Tier;
  mode: Mode;
  kcal: number;
  answered: number;
  correct: number;
}

/** The exam questions of one level in one part: how many were handed in, how many right. */
export interface ExamCell {
  level: ExamLevel;
  part: ExamPart;
  answered: number;
  correct: number;
}

export type ExamKcalKind = "pass" | "fail" | "review";

/** What one kind of exam reward of a level paid, `each` a time (after the play mode), as in 150 kcal × 4回. */
export interface ExamKcal {
  level: ExamLevel;
  kind: ExamKcalKind;
  each: number;
  times: number;
  kcal: number;
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
  /** set once the word is learned: right in a review of すべて / 復習, or marked so */
  masteredAt?: string | null;
  /** how many times it was answered wrong in a review */
  misses: number;
  /** set when it was taken off the list (×): it waits in 除外, apart from すべて */
  excludedAt?: string | null;
  /**
   * set when it was starred (☆ → ★): a starred word in review shows in ★ as well as in すべて and
   * 復習; learning it or taking it off by hand unstars it
   */
  favoritedAt?: string | null;
  /** the part of speech it is sorted under, its commonest, or idiom, or usage for a pattern (db::recipe_poses) */
  pos: RecipePos;
  /** every part of speech it has, `pos` first: figure (a noun and a verb) shows under either */
  poses: RecipePos[];
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
 * The tab a recipe review goes over: すべて (every word not taken off), ★ (the starred words in
 * review), 復習, 習得 or 除外. It decides where an answer moves the word (recipe::review).
 */
export type RecipeTab = "all" | "favorite" | "learning" | "mastered" | "excluded";

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
  /**
   * Android: what the phone's recognizer took down, its best guess first (empty on Windows). It
   * writes down whatever was said rather than choosing among phrases, so these are scored by how
   * close they come to the target, as the browser's are.
   */
  transcripts: string[];
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
