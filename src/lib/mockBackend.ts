// In-memory stand-in for the Rust backend so the UI can be developed in a normal browser.
// It mirrors the rules in src-tauri/src/srs.rs and commands.rs; the Tauri build never loads it.
import seedJson from "../../src-tauri/data/questions.json";
import glossary from "../../src-tauri/data/glossary.json";
import grammarNotes from "../../src-tauri/data/grammar-notes.json";
import pronunciations from "../../src-tauri/data/pronunciations.json";
import wordPartsList from "../../src-tauri/data/word-parts.json";
import wordFamilies from "../../src-tauri/data/word-families.json";
import irregularSeeds from "../../src-tauri/data/irregular-verbs.json";
import tierOverrides from "../../src-tauri/data/tiers.json";
import wordExamples from "../../src-tauri/data/word-examples.json";
import wordUsages from "../../src-tauri/data/word-usage.json";
import idiomOrigins from "../../src-tauri/data/idiom-origins.json";
import wordPos from "../../src-tauri/data/word-pos.json";
import relatedSeeds from "../../src-tauri/data/word-related.json";
import confusableSets from "../../src-tauri/data/word-confusables.json";
import verbTypes from "../../src-tauri/data/verb-types.json";
import glossaryPosOverrides from "../../src-tauri/data/glossary-pos.json";
import posOrder from "../../src-tauri/data/pos-order.json";
import sensePos from "../../src-tauri/data/sense-pos.json";
import homonymGroups from "../../src-tauri/data/homonyms.json";
import abbreviationList from "../../src-tauri/data/abbreviations.json";
import antonymList from "../../src-tauri/data/antonyms.json";
import examBasic from "../../src-tauri/data/exam-basic.json";
import exam600 from "../../src-tauri/data/exam-600.json";
import exam800 from "../../src-tauri/data/exam-800.json";
import { buildPhraseIndex, expandDictionary, lemmas, phraseSpans, tokenize, type Dictionary, type PhraseIndex } from "./dictionary";
import { cueFor, cueText, meaningParts, posFromGloss, posOf as posOfSense } from "./pos";
import { answerWordCount, CLEAR_SCORE, hintPenalty, kcalFor, scoredKind, scoresPerWord } from "./scoring";
import { exampleSentence, sentences } from "./sentences";
import type {
  AnswerPayload,
  AnswerResult,
  Breakdown,
  CategoryInfo,
  ConsumptionEntry,
  DailyStats,
  ModeCount,
  Dashboard,
  DayPoint,
  EatenSnack,
  ExamAnswer,
  ExamCell,
  ExamKcal,
  ExamKcalKind,
  ExampleSentence,
  ExamLevel,
  ExamLevelInfo,
  ExamOverview,
  ExamProgress,
  ExamPart,
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
  LexiPair,
  LexiResult,
  IrregularVerb,
  GrammarNote,
  Level,
  RelatedGroup,
  Mode,
  PartOfSpeech,
  PlayMode,
  Question,
  RecipeAddResult,
  RecipeKind,
  RecipePos,
  RecipeWord,
  RecipeWordInput,
  SessionMode,
  SessionQuestion,
  Snack,
  StatCell,
  Stats,
  Task,
  TaskEntry,
  Ticket,
  Tier,
  UsedWord,
  UserInfo,
  WeakQuestion,
  WeightPoint,
  WeightResult,
  WordNotes,
  Abbreviation,
  Antonym,
  WordTags,
  WordPart,
  WordUsage,
} from "../types";
import { PLAY_MODES, POINT_CATEGORIES } from "../types";

interface SeedQuestion {
  key: string;
  kind: string;
  difficulty: string;
  category?: string;
  group?: string;
  en: string;
  ja: string;
  modes: string[];
  choices?: string[];
  prompt?: string;
  example?: string;
  exampleJa?: string;
  point?: string;
}

interface Hist {
  level: number;
  needsReview: boolean;
  nextDue: string | null;
  correct: number;
  wrong: number;
  lastScore: number | null;
  lastStudiedAt: string;
  /** the mode it was last missed in, which its review is asked in (learning_history.review_mode) */
  reviewMode?: Mode | null;
  /** how often its review was missed on a day (answer_log's misses with is_review that day) */
  reviewMisses?: { date: string; count: number };
}

interface StoredConsumption extends ConsumptionEntry {
  date: string;
  ticketId?: number | null;
  /** null: eaten without being put in the book (log_one_off_snack) */
  snackId?: number | null;
}

/** A 課題 done (mirrors task_log); `taskId` null for one done without the list. */
interface StoredTaskEntry extends TaskEntry {
  date: string;
  taskId: number | null;
}

/** A day's weight (mirrors weight_log): the height it was weighed at and what it paid. */
interface StoredWeight {
  weightKg: number;
  heightCm: number;
  bonus: number;
}

/** An exam set as asked: how many exams asked it, and when it was last asked (mirrors exam_seen). */
interface ExamSeen {
  count: number;
  at: string;
}

interface MockState {
  user: UserInfo;
  /**
   * Keyed by the question's immutable `key`, never its `id`. Ids here are array positions, so
   * inserting a pack anywhere but the end renumbers everything after it and would silently move a
   * learner's progress onto unrelated questions. The Tauri build has the same guarantee for free:
   * SQLite assigns the id once and the seed upsert matches on `key`.
   */
  history: Record<string, Hist>;
  daily: Record<string, DailyStats>;
  snacks: Snack[];
  consumption: StoredConsumption[];
  tickets: Ticket[];
  /** お菓子作りレシピ; absent in state saved before the list existed */
  recipe: StoredRecipeWord[];
  /** 貯蓄 (mirrors users.savings_kcal) */
  savings: number;
  /** leftover moved to savings per finished day (mirrors daily_stats.saved_kcal) */
  saved: Record<string, number>;
  /** お菓子引換券 */
  snackTickets: SnackTicket[];
  /** 目標のお菓子（mirrors goal_snacks） */
  goals: number[];
  /** 1 kcal に満たない獲得の端数（1/8 kcal 単位）、日ごと（mirrors daily_stats.kcal_eighths） */
  kcalEighths: Record<string, number>;
  /** the study answers by "tier|mode": how many, how many right (what answer_log counts; `kcal` only in state saved before `earned`) */
  answerTotals: Record<string, { kcal?: number; answered: number; correct: number }>;
  /**
   * Mirrors earn_log, summed by the 記録's cells ("study|tier|mode", "recipe|mode",
   * "exam|level|kind|eighths", "cheat"): the whole kcal the rewards added, and how many there were.
   */
  earned: Record<string, { kcal: number; times: number }>;
  /** Mirrors counted_answers, summed: お気に入りの復習 of a study question ("tier|mode"), and the exam questions handed in and favorites of them ("exam|level|part"). */
  counted: Record<string, { answered: number; correct: number }>;
  /** the day each recipe word was last right (mirrors recipe_words.paid_on) */
  recipePaid: Record<number, string>;
  /** 試験 handed in (mirrors exam_attempts) */
  examAttempts: ExamAttempt[];
  /** exam question id → missed and not yet put right in the exam review (mirrors exam_mistakes) */
  examMistakes: Record<string, { level: ExamLevel; addedAt: string; misses: number }>;
  /** exam set id → how many exams asked it and when it was last asked (mirrors exam_seen) */
  examSeen: Record<string, ExamSeen>;
  /** the exam of a level left part-way (mirrors exam_progress) */
  examProgress: Partial<Record<ExamLevel, { questionIds: string[]; answers: ExamAnswer[]; savedAt: string }>>;
  /** お気に入り (mirrors favorites); a study question by its `key`, as `history` is */
  favorites: StoredFavorite[];
  /** mirrors meta done_reviews_released: reviews done once have stopped waiting to return */
  doneReviewsReleased?: boolean;
  /** ダイエット機能の課題一覧 (mirrors tasks) */
  tasks: Task[];
  /** 目標の課題 (mirrors goal_tasks) */
  goalTasks: number[];
  /** 課題 done (mirrors task_log), the latest first */
  taskLog: StoredTaskEntry[];
  /** date → the weight of the day (mirrors weight_log) */
  weights: Record<string, StoredWeight>;
  nextId: number;
}

interface StoredFavorite {
  id: number;
  questionKey?: string;
  mode?: Mode;
  examId?: string;
  addedAt: string;
  lastReviewedAt?: string | null;
  /** the day it was last answered right in its review, which pays once a day (mirrors favorites.paid_on) */
  paidOn?: string | null;
}

interface ExamAttempt {
  level: ExamLevel;
  date: string;
  total: number;
  correct: number;
  passed: boolean;
  kcal: number;
  finishedAt: string;
}

interface SnackTicket {
  id: number;
  issuedAt: string;
  usedAt: string | null;
  consumptionId: number | null;
}

const RATES = { wordChoice: 2, phraseChoice: 3, sentenceChoice: 4, reviewMultiplier: 1.5, cheatDayBonus: 300, staleReviewDays: 7, weightBonus: 10 };

/**
 * Mirrors db::tier_of: the hand-sorted example sentences, else the kind decides the tab. A word of
 * several words, or of words joined by a hyphen, is a compound, unless it is a verb (get up).
 */
function tierOf(kind: string, key: string, en: string): Tier {
  const sorted = (tierOverrides as Record<string, Tier>)[key];
  if (sorted) return sorted;
  if (kind === "word") return /[\s-]/.test(en) && (wordPos as Record<string, string>)[key] !== "verb" ? "compound" : "word";
  if (kind === "grammar" || kind === "idiom") return kind;
  if (kind === "dialogue" || kind === "expression") return "phrase";
  return "example";
}
/** Mirrors srs::RETRY_DAYS and REVIEW_AGAIN_DAYS. */
const RETRY_DAYS = 1;
const REVIEW_AGAIN_DAYS = 3;
/** Mirrors srs::misses_to_review_again: one miss picked, three typed or spoken. */
const missesToReviewAgain = (mode: Mode) => (mode === "typing" || mode === "speaking" ? 3 : 1);
/** Mirrors srs::STALE_REVIEW_DAYS. */
const STALE_REVIEW_DAYS = RATES.staleReviewDays;

/** Mirrors db::word_pos: a one-word word question's part of speech, by key. */
const posOf = wordPos as Record<string, PartOfSpeech>;

/** Mirrors the category clause of session_questions: a genre, "pos:noun" …, "gp:時制" …, or "all". */
function inCategory(q: Question, category: string): boolean {
  const point = grammarPointOf(q);
  return (
    category === "all" ||
    q.category === category ||
    `pos:${posOf[q.key]}` === category ||
    (point !== null && `gp:${point}` === category)
  );
}

/** Mirrors questions.grammar_point (db::sync_grammar_points): a grammar question's explanation's 文法項目. */
function grammarPointOf(q: Question): string | null {
  return (q.point && notesByPoint.get(q.point)?.category) || null;
}
// v2 keys history by question key. v1 keyed it by array position, and those numbers no longer
// mean anything, so a v1 blob is dropped rather than read back onto the wrong questions.
const STORAGE_KEY = "calorie-quest-mock-v2";

/**
 * Every pack in src-tauri/data, discovered the same way build.rs discovers them for the Rust
 * side, so adding a file needs no edit here. questions.json, glossary.json and grammar-notes.json
 * are imported by name above and excluded; the rest are plain arrays of questions.
 */
const packModules = import.meta.glob<SeedQuestion[]>("../../src-tauri/data/*.json", {
  eager: true,
  import: "default",
});

/** Mirrors build.rs: group by family, order numerically, keep a trailing letter as tiebreaker. */
function packOrder(path: string): [string, number, string] {
  const stem = path.slice(path.lastIndexOf("/") + 1).replace(/\.json$/, "");
  const cut = stem.lastIndexOf("-");
  if (cut < 0) return [stem, 0, ""];
  const tail = stem.slice(cut + 1);
  const digits = /^\d+/.exec(tail)?.[0];
  if (!digits) return [stem, 0, ""];
  return [stem.slice(0, cut), Number(digits), tail.slice(digits.length)];
}

const seedQuestions: SeedQuestion[] = [
  ...(seedJson as unknown as { questions: SeedQuestion[] }).questions,
  ...Object.entries(packModules)
    .filter(
      ([path]) =>
        !/\/(questions|glossary|grammar-notes|pronunciations|word-parts|tiers|word-examples|word-usage|idiom-origins|word-related|word-pos|word-confusables|word-families|irregular-verbs|verb-types|glossary-pos|retired-words|pos-order|sense-pos|homonyms|abbreviations|antonyms|exam-[^/]*)\.json$/.test(
          path,
        ),
    )
    .sort(([a], [b]) => {
      const x = packOrder(a);
      const y = packOrder(b);
      return x[0].localeCompare(y[0]) || x[1] - y[1] || x[2].localeCompare(y[2]);
    })
    .flatMap(([, pack]) => pack),
];

const questions: Question[] = seedQuestions.map(
  (q, i) => ({
    id: i + 1,
    key: q.key,
    kind: q.kind,
    difficulty: q.difficulty as Level,
    tier: tierOf(q.kind, q.key, q.en),
    category: q.category ?? "",
    group: q.group ?? q.category ?? "",
    en: q.en,
    ja: q.ja,
    modes: q.modes as Mode[],
    choices: q.choices ?? null,
    prompt: q.prompt ?? null,
    hint: null,
    audioPath: null,
    example: q.example ?? null,
    exampleJa: q.exampleJa ?? null,
    point: q.point ?? null,
  }),
);

const BUILTIN: Array<[string, number, string]> = [
  ["クッキー 1枚", 50, "🍪"],
  ["チョコレート 数かけ", 100, "🍫"],
  ["せんべい 2枚", 100, "🍘"],
  ["グミ 1袋", 120, "🍬"],
  ["プリン", 150, "🍮"],
  ["大福", 230, "🍡"],
  ["アイスクリーム 1個", 250, "🍦"],
  ["ドーナツ", 300, "🍩"],
  ["ポテトチップス 1袋", 330, "🥨"],
  ["ショートケーキ", 350, "🍰"],
];

/** Mirrors diet::BUILTIN_TASKS. */
const BUILTIN_TASKS: Array<[string, number, string]> = [
  ["腕立て伏せ 10回", 30, "svg:dumbbell"],
  ["スクワット 20回", 30, "svg:dumbbell"],
  ["洗濯物をたたむ", 30, "🧺"],
  ["植物の水やり", 20, "🪴"],
  ["散歩 30分", 50, "🚶"],
  ["自転車 30分", 60, "🚲"],
  ["部屋の掃除機がけ", 60, "svg:vacuum"],
  ["宿題", 100, "✏️"],
];
/** Mirrors diet::FORMER_BUILTIN_TASKS: the first 課題 as put in before their icons were chosen again. */
const FORMER_BUILTIN_TASKS: Array<[string, number, string]> = [
  ["腕立て伏せ 10回", 30, "💪"],
  ["スクワット 20回", 30, "🏋️"],
  ["洗濯物をたたむ", 30, "🧺"],
  ["食器洗い", 40, "🍽️"],
  ["散歩 30分", 50, "🚶"],
  ["窓ふき", 50, "🧽"],
  ["部屋の掃除", 60, "🧹"],
  ["宿題", 100, "📚"],
];
/** Mirrors diet::WEIGHT_BONUS_KCAL and diet::TASK_MAX_KCAL. */
const WEIGHT_BONUS_KCAL = RATES.weightBonus;
const TASK_MAX_KCAL = 1000;
/** Mirrors diet::checked_task's icon for an empty one. */
const DEFAULT_TASK_ICON = "svg:dumbbell";

/** Mirrors diet::seed_tasks: a first 課題 still as it was put in takes what it is now. */
function renewBuiltinTasks(tasks: Task[]): Task[] {
  return tasks.map((t) => {
    const i = FORMER_BUILTIN_TASKS.findIndex(([name, kcal, icon]) => t.isBuiltin && t.name === name && t.calories === kcal && t.icon === icon);
    if (i < 0) return t;
    const [name, calories, icon] = BUILTIN_TASKS[i];
    return { ...t, name, calories, icon };
  });
}

function builtinTasks(): Task[] {
  return BUILTIN_TASKS.map(([name, calories, icon], i) => ({ id: i + 1, name, calories, icon, isBuiltin: true, doneCount: 0 }));
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function today(): string {
  return fmtDate(new Date());
}
function datePlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}
function nowTs(): string {
  const d = new Date();
  return `${fmtDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function freshState(): MockState {
  return {
    user: {
      id: 1,
      name: "Player",
      totalStudyDays: 0,
      currentStreak: 0,
      longestStreak: 0,
      lastStudyDate: null,
      playMode: "normal",
      dietMode: false,
      heightCm: null,
    },
    history: {},
    daily: {},
    snacks: BUILTIN.map(([name, calories, icon], i) => ({ id: i + 1, name, calories, icon, isBuiltin: true, eatenCount: 0 })),
    consumption: [],
    tickets: [],
    recipe: [],
    savings: 0,
    saved: {},
    snackTickets: [],
    goals: [],
    kcalEighths: {},
    answerTotals: {},
    earned: {},
    counted: {},
    recipePaid: {},
    examAttempts: [],
    examMistakes: {},
    examSeen: {},
    examProgress: {},
    favorites: [],
    doneReviewsReleased: true,
    tasks: builtinTasks(),
    goalTasks: [],
    taskLog: [],
    weights: {},
    nextId: 100,
  };
}

/** The single goal kept in `user.goalSnackId` before goals became a list. */
function legacyGoal(user: UserInfo): number[] {
  const id = (user as UserInfo & { goalSnackId?: number | null }).goalSnackId;
  return id == null ? [] : [id];
}

let state: MockState = load();

function load(): MockState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      // State saved before the word list or savings existed lacks them. Like the Rust migration,
      // days already over are closed at 0 rather than paid into savings all at once.
      const stored = JSON.parse(raw) as Partial<MockState> &
        Omit<
          MockState,
          | "recipe"
          | "savings"
          | "saved"
          | "snackTickets"
          | "goals"
          | "kcalEighths"
          | "answerTotals"
          | "earned"
          | "counted"
          | "recipePaid"
          | "examAttempts"
          | "examMistakes"
          | "examSeen"
          | "examProgress"
          | "favorites"
          | "tasks"
          | "goalTasks"
          | "taskLog"
          | "weights"
        > & {
          /** the day's recipe pay in halves, then in quarters, before eighths of any reward */
          recipeHalves?: Record<string, number>;
          recipeQuarters?: Record<string, number>;
        };
      const closed = Object.fromEntries(Object.keys(stored.daily).filter((d) => d < today()).map((d) => [d, 0]));
      const quarters =
        stored.recipeQuarters ??
        Object.fromEntries(Object.entries(stored.recipeHalves ?? {}).map(([d, n]) => [d, n * 2]));
      return {
        ...stored,
        // Mirrors the defaults of users.play_mode, diet_mode and height_cm for state saved before them.
        user: {
          ...stored.user,
          playMode: stored.user.playMode ?? "normal",
          dietMode: stored.user.dietMode ?? false,
          heightCm: stored.user.heightCm ?? null,
        },
        // Mirrors recipe::trim_passage_examples: a word once saved with a whole exam passage keeps its
        // sentence; and recipe::migrate_usage_notation: a 用法 saved as "be afraid of ～" is "be afraid of A".
        recipe: migrateUsageNotation(
          (stored.recipe ?? []).map((w) => ({ ...w, example: exampleSentence(w.example, w.exampleJa, w.form, w.word) })),
        ),
        savings: stored.savings ?? 0,
        saved: stored.saved ?? closed,
        snackTickets: stored.snackTickets ?? [],
        // The single goal of earlier versions becomes the first entry of the list.
        goals: stored.goals ?? legacyGoal(stored.user),
        // Mirrors the Rust migration: only the pending fraction is kept, in eighths.
        kcalEighths:
          stored.kcalEighths ?? Object.fromEntries(Object.entries(quarters).map(([d, n]) => [d, (n % 4) * 2])),
        answerTotals: stored.answerTotals ?? {},
        // Mirrors db::fill_earn_log: what the record kept before goes in once.
        earned: stored.earned ?? filledEarned(stored.answerTotals ?? {}, stored.examAttempts ?? [], stored.tickets ?? []),
        counted: stored.counted ?? {},
        recipePaid: stored.recipePaid ?? {},
        examAttempts: stored.examAttempts ?? [],
        examMistakes: stored.examMistakes ?? {},
        // Kept as the time alone before the count: a set asked before was asked once.
        examSeen: Object.fromEntries(
          Object.entries((stored.examSeen ?? {}) as Record<string, ExamSeen | string>).map(([id, v]) => [
            id,
            typeof v === "string" ? { count: 1, at: v } : v,
          ]),
        ),
        examProgress: stored.examProgress ?? {},
        favorites: stored.favorites ?? [],
        // Mirrors diet::seed_tasks: the first 課題 come in once, with the list.
        tasks: stored.tasks ? renewBuiltinTasks(stored.tasks) : builtinTasks(),
        goalTasks: stored.goalTasks ?? [],
        taskLog: stored.taskLog ?? [],
        weights: stored.weights ?? {},
        // Mirrors the Rust migration: a review done once (level above 0) waits no more, once.
        history: stored.doneReviewsReleased
          ? stored.history
          : Object.fromEntries(
              Object.entries(stored.history).map(([k, h]) => [
                k,
                h.needsReview && h.level > 0 ? { ...h, needsReview: false, nextDue: null, reviewMode: null } : h,
              ]),
            ),
        doneReviewsReleased: true,
      };
    }
  } catch {
    /* ignore */
  }
  return freshState();
}
/** Mirrors recipe::loose_pattern: every slot as "_", asides left out, ways apart as "|". */
function loosePattern(pattern: string): string {
  return pattern
    .replace(/（[^）]*）/g, " ")
    .replace(/／| \/ /g, " | ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (["～", "…", "A", "B", "節", "形容詞", "過去分詞"].includes(t) ? "_" : t.toLowerCase()))
    .join(" ");
}

/** Mirrors recipe::migrate_usage_notation: a 用法 saved in the old notation moves to the new, with its Japanese. */
function migrateUsageNotation(recipe: StoredRecipeWord[]): StoredRecipeWord[] {
  // Runs while the state loads, before the tables further down exist: so the raw data and a list
  // of its own (mirrors recipe::RENAMED_USAGES).
  const RENAMED_USAGES: [string, string][] = [
  ["not ～ anymore", "not 原形 anymore"],
  ["become ～（名詞・形容詞）", "become A／形容詞"],
  ["be capable of ～", "be capable of A／-ing"],
  ["not ～ either", "not 原形 either"],
  ["Have you ever ～?", "Have you ever 過去分詞?"],
  ["look forward to ～", "look forward to A／-ing"],
  ["prove (to be) ～", "prove (to be) A／形容詞"],
  ["seem (to be) ～", "seem (to be) A／形容詞"],
  ["～, though.", "節, though."],
  ["turn out to be ～", "turn out to be A／形容詞"],
  ["What's wrong with ～?", "What's wrong with A?"],
  ];
  const all = wordUsages as WordUsage[];
  return recipe.map((w) => {
    if (w.kind !== "usage" || all.some((u) => u.pattern === w.word)) return w;
    const renamed = RENAMED_USAGES.find(([old]) => old === w.word);
    let target: WordUsage | undefined;
    if (renamed) target = all.find((u) => u.pattern === renamed[1]);
    else {
      const key = loosePattern(w.word);
      const hits = [...new Set(all.filter((u) => loosePattern(u.pattern) === key).map((u) => u.pattern))];
      if (hits.length === 1) target = all.find((u) => u.pattern === hits[0]);
    }
    if (!target || recipe.some((x) => x.word === target!.pattern)) return w;
    return { ...w, word: target.pattern, meaning: target.ja };
  });
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

/**
 * Mirrors commands::checked_item: the name and icon of a snack or a 課題 (`what`) as they are kept,
 * the name trimmed and not empty, the kcal 1〜`max`, an empty icon made `defaultIcon`.
 */
function checkedItem(
  what: string,
  args: Record<string, unknown>,
  max: number,
  defaultIcon: string,
): { name: string; calories: number; icon: string } {
  const name = String(args.name ?? "").trim();
  const calories = Number(args.calories);
  if (!name) throw new Error(`${what}の名前を入力してください`);
  if (!(Number.isInteger(calories) && calories >= 1 && calories <= max)) throw new Error(`カロリーは1〜${max}の範囲で入力してください`);
  const icon = String(args.icon ?? "");
  return { name, calories, icon: icon.trim() ? icon : defaultIcon };
}

/** Mirrors TASK_COLS in diet.rs: every 課題 carries how often it has been done. */
function countedTasks(tasks: Task[]): Task[] {
  const done = new Map<number, number>();
  for (const e of state.taskLog) if (e.taskId !== null) done.set(e.taskId, (done.get(e.taskId) ?? 0) + 1);
  return tasks.map((x) => ({ ...x, doneCount: done.get(x.id) ?? 0 }));
}

/** Mirrors diet::goal_tasks: cheapest first. */
function goalTasks(): Task[] {
  return countedTasks(state.tasks)
    .filter((x) => state.goalTasks.includes(x.id))
    .sort((a, b) => a.calories - b.calories || state.goalTasks.indexOf(a.id) - state.goalTasks.indexOf(b.id));
}

/** Mirrors diet::list_tasks_in: the cheapest first. */
function listTasks(): Task[] {
  return countedTasks(state.tasks).sort((a, b) => a.calories - b.calories || a.id - b.id);
}

/** Mirrors diet::earn_on: a 課題 done now, logged and paid as it says (no play mode). */
function earnTask(taskId: number | null, taskName: string, taskIcon: string, calories: number): DailyStats {
  const t = today();
  state.taskLog.unshift({ id: state.nextId++, taskId, taskName, taskIcon, calories, doneAt: nowTs(), date: t });
  daily(t).kcalEarned += calories;
  save();
  return { ...daily(t) };
}

/** Mirrors diet::bmi: kg over metres squared, to one decimal. */
function bmi(weightKg: number, heightCm: number): number {
  const m = heightCm / 100;
  return Math.round((weightKg / (m * m)) * 10) / 10;
}

function weightPoint(date: string, w: StoredWeight): WeightPoint {
  return { date, weightKg: w.weightKg, heightCm: w.heightCm, bmi: bmi(w.weightKg, w.heightCm) };
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Mirrors diet::set_height_in: the height kept until it is changed. */
function setHeight(heightCm: number): number {
  if (!(Number.isFinite(heightCm) && heightCm >= 50 && heightCm <= 250)) throw new Error("身長は50〜250 cmの範囲で入力してください");
  state.user.heightCm = round1(heightCm);
  save();
  return state.user.heightCm;
}

/** Mirrors diet::record_weight_in: today's weight at the height kept, once a day, paying the daily bonus. */
function recordWeight(weightKg: number): WeightResult {
  if (!(Number.isFinite(weightKg) && weightKg >= 10 && weightKg <= 300)) throw new Error("体重は10〜300 kgの範囲で入力してください");
  const heightCm = state.user.heightCm;
  if (heightCm == null) throw new Error("先に記録の画面で身長を入れてください（BMI の計算に使います）");
  const t = today();
  if (state.weights[t]) throw new Error("今日の体重はもう記録しました（記録できるのは1日1回です）");
  state.weights[t] = { weightKg: round1(weightKg), heightCm, bonus: WEIGHT_BONUS_KCAL };
  daily(t).kcalEarned += WEIGHT_BONUS_KCAL;
  save();
  return { point: weightPoint(t, state.weights[t]), bonus: WEIGHT_BONUS_KCAL, today: { ...daily(t) } };
}

/** Mirrors SNACK_COLS in commands.rs: every snack carries how often it has been eaten. */
function counted(snacks: Snack[]): Snack[] {
  const eaten = new Map<number, number>();
  for (const c of state.consumption) {
    const id = snackIdOf(c);
    if (id !== null) eaten.set(id, (eaten.get(id) ?? 0) + 1);
  }
  return snacks.map((s) => ({ ...s, eatenCount: eaten.get(s.id) ?? 0 }));
}

/** Mirrors commands::goal_snacks_inner: cheapest first. */
function goalSnacks(): Snack[] {
  return counted(state.snacks)
    .filter((s) => state.goals.includes(s.id))
    .sort((a, b) => a.calories - b.calories || state.goals.indexOf(a.id) - state.goals.indexOf(b.id));
}

/** Log entries keep the snack's id (null for one eaten off the book); older mock entries only have its name. */
function snackIdOf(c: StoredConsumption): number | null {
  if (c.snackId !== undefined) return c.snackId;
  return state.snacks.find((s) => s.name === c.snackName && s.icon === c.snackIcon)?.id ?? null;
}

/** Mirrors commands::settle_savings: finished days' leftover → savings, every 2,000 → a ticket. */
const SAVINGS_PER_TICKET = 2000;
/**
 * Mirrors commands::settle_savings: every finished day in order, its leftover into savings, a day
 * ended below zero carrying that into the next day settled, or into today.
 */
function settleSavings(): { saved: number; issued: number; carried: number } {
  const t = today();
  let saved = 0;
  let owed = 0;
  const days = Object.keys(state.daily)
    .filter((date) => date < t && state.saved[date] === undefined)
    .sort();
  for (const date of days) {
    const d = state.daily[date];
    d.carriedKcal = Math.min(0, d.carriedKcal ?? 0) + owed;
    const net = d.kcalEarned - d.kcalConsumed + d.carriedKcal;
    state.saved[date] = Math.max(0, net);
    saved += Math.max(0, net);
    owed = Math.min(0, net);
  }
  if (owed < 0) daily(t).carriedKcal = Math.min(0, daily(t).carriedKcal ?? 0) + owed;
  const total = state.savings + saved;
  const issued = Math.floor(total / SAVINGS_PER_TICKET);
  state.savings = total % SAVINGS_PER_TICKET;
  for (let i = 0; i < issued; i++) state.snackTickets.push({ id: state.nextId++, issuedAt: nowTs(), usedAt: null, consumptionId: null });
  if (days.length > 0) save();
  return { saved, issued, carried: owed };
}

function daily(date: string): DailyStats {
  if (!state.daily[date]) {
    state.daily[date] = { date, kcalEarned: 0, kcalConsumed: 0, answered: 0, correct: 0, carriedKcal: 0 };
  }
  return state.daily[date];
}

/** Mirrors srs::apply_play_mode: がんばり ×0.5、通常 ×1、お気軽 ×1.5, in eighths of a kcal. */
function applyPlayMode(eighths: number): number {
  const e = Math.max(0, eighths);
  const m = state.user.playMode;
  return m === "hard" ? e / 2 : m === "easy" ? (e * 3) / 2 : e;
}

/** Mirrors commands::Earning: what a reward is for, kept with it for the 記録's table. */
type Earning =
  | { source: "answer" | "favorite"; tier: Tier; mode: Mode }
  | { source: "favoriteExam" | "examPass" | "examFail" | "examReview"; level: ExamLevel }
  | { source: "recipe"; mode: Mode }
  | { source: "cheat" };

/** The cell of `earned` a reward is kept in (mirrors how load_breakdown groups earn_log). */
function earnKey(e: Earning, eighths: number): string {
  switch (e.source) {
    case "answer":
    case "favorite":
      return `study|${e.tier}|${e.mode}`;
    case "recipe":
      return `recipe|${e.mode}`;
    case "cheat":
      return "cheat";
    default: {
      const kind = e.source === "examPass" ? "pass" : e.source === "examFail" ? "fail" : "review";
      return `exam|${e.level}|${kind}|${eighths}`;
    }
  }
}

function addEarned(key: string, kcal: number, times = 1) {
  const cell = state.earned[key] ?? { kcal: 0, times: 0 };
  state.earned[key] = { kcal: cell.kcal + kcal, times: cell.times + times };
}

/** Mirrors db::fill_earn_log: the study answers at what they kept, the exams at what they paid, the cheat days. */
function filledEarned(
  answerTotals: Record<string, { kcal?: number }>,
  attempts: ExamAttempt[],
  tickets: Ticket[],
): MockState["earned"] {
  const out: MockState["earned"] = {};
  const add = (key: string, kcal: number) => {
    const cell = out[key] ?? { kcal: 0, times: 0 };
    out[key] = { kcal: cell.kcal + kcal, times: cell.times + 1 };
  };
  for (const [key, v] of Object.entries(answerTotals)) if (v.kcal) out[`study|${key}`] = { kcal: Math.round(v.kcal), times: 0 };
  for (const a of attempts) add(`exam|${a.level}|${a.passed ? "pass" : "fail"}|${a.kcal * 8}`, a.kcal);
  for (const t of tickets) if (t.usedAt) add("cheat", RATES.cheatDayBonus);
  return out;
}

function countAnswer(key: string, correct: boolean) {
  const cell = state.counted[key] ?? { answered: 0, correct: 0 };
  state.counted[key] = { answered: cell.answered + 1, correct: cell.correct + (correct ? 1 : 0) };
}

/**
 * Mirrors commands::credit: pays `eighths` (1/8 kcal, before the play mode) into `date`. Whole kcal
 * go to the day's earnings; a fraction waits for the next reward that day. The reward is kept with
 * what it is `for` and the whole kcal it added, so the 記録's table adds up to the total.
 */
function credit(date: string, eighths: number, what: Earning): { points: number; whole: number; pending: boolean } {
  const scaled = applyPlayMode(eighths);
  const total = (state.kcalEighths[date] ?? 0) + scaled;
  const whole = Math.floor(total / 8);
  state.kcalEighths[date] = total % 8;
  daily(date).kcalEarned += whole;
  if (scaled > 0) addEarned(earnKey(what, scaled), whole);
  return { points: scaled / 8, whole, pending: total % 8 > 0 };
}
/** Mirrors release_stale_reviews: reviews undone for more than a week after they were due go back. */
function releaseStaleReviews() {
  const oldest = datePlus(-STALE_REVIEW_DAYS);
  for (const h of Object.values(state.history)) {
    if (h.needsReview && h.nextDue !== null && h.nextDue < oldest) {
      h.needsReview = false;
      h.level = 0;
      h.nextDue = null;
      h.reviewMode = null;
    }
  }
}
function dueCount(): number {
  const t = today();
  // A key whose question left the bank (a retired word) is no review to do.
  return Object.entries(state.history).filter(
    ([key, h]) => h.needsReview && h.nextDue !== null && h.nextDue <= t && questions.some((q) => q.key === key),
  ).length;
}
function ticketsAvailable(): number {
  return state.tickets.filter((t) => !t.usedAt).length;
}

/** Mirrors commands::senses: 聞く、聞こえる is 聞く and 聞こえる; notes in parentheses dropped. */
function glossSenses(ja: string): string[] {
  return ja
    .split(/[、，,;；/／]/)
    .map((s) => s.replace(/（[^）]*）|\([^)]*\)/g, "").trim())
    .filter(Boolean);
}

function shareASense(a: string, b: string): boolean {
  const sb = glossSenses(b);
  return glossSenses(a).some((s) => sb.includes(s));
}

/** Mirrors commands::meanings_close: a sense, a kanji or the first two kana in common. */
function meaningsClose(a: string, b: string): boolean {
  const kanji = (s: string) => new Set([...s].filter((c) => /[\u4e00-\u9fff]/.test(c) && !"的性化月曜日".includes(c)));
  const kb = kanji(b);
  if ([...kanji(a)].some((c) => kb.has(c))) return true;
  const sb = glossSenses(b);
  return glossSenses(a).some((x) =>
    sb.some((y) => {
      if (x === y) return true;
      let common = 0;
      while (common < x.length && common < y.length && x[common] === y[common]) common++;
      return common >= 2 && /[\u3041-\u30ff]/.test(x[0]);
    }),
  );
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 0; i < a.length; i++) {
    let prev = row[0];
    row[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cur = row[j + 1];
      row[j + 1] = a[i] === b[j] ? prev : 1 + Math.min(prev, row[j], row[j + 1]);
      prev = cur;
    }
  }
  return row[b.length];
}

/** Mirrors commands::spelled_alike: house / horse, desert / dessert. */
function spelledAlike(a: string, b: string): boolean {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  if (x === y || /[ -]/.test(x) || /[ -]/.test(y)) return false;
  if (Math.min(x.length, y.length) < 4 || Math.abs(x.length - y.length) > 2) return false;
  const d = levenshtein(x, y);
  return d === 1 || (d === 2 && Math.min(x.length, y.length) >= 7);
}

/** Mirrors db::confusables: English (lowercase) → the other words of its sets. */
const confusables = (() => {
  const out = new Map<string, string[]>();
  for (const set of confusableSets as string[][]) {
    const words = set.map((w) => w.toLowerCase());
    for (const w of words) {
      const others = out.get(w) ?? [];
      for (const o of words) if (o !== w && !others.includes(o)) others.push(o);
      out.set(w, others);
    }
  }
  return out;
})();

/** Mirrors db::related_words: the other words of every 類似表現 group of `key`. */
function relatedWords(key: string): string[] {
  const out: string[] = [];
  for (const g of relatedSeeds as Array<{ members: Array<{ word: string }> }>) {
    if (!g.members.some((m) => m.word.toLowerCase() === key)) continue;
    for (const m of g.members) {
      const w = m.word.toLowerCase();
      if (w !== key && !out.includes(w)) out.push(w);
    }
  }
  return out;
}

/** A wrong option in Japanese with the English it translates. Mirrors commands::Distractor. */
type Distractor = [ja: string, en: string];

/** Mirrors commands::word_distractors: wrong meanings of the same part of speech. */
let relatedCuesCache: Record<string, Array<[number, string]>> | null = null;

/** Mirrors db::related_cues: each word's 類似表現 groups, with its nuance as a cue. */
function relatedCues(): Record<string, Array<[number, string]>> {
  if (!relatedCuesCache) {
    const out: Record<string, Array<[number, string]>> = {};
    (relatedSeeds as Array<{ members: Array<{ word: string; nuance: string }> }>).forEach((g, i) => {
      for (const m of g.members) (out[m.word.toLowerCase()] ??= []).push([i, cueText(m.nuance) ?? ""]);
    });
    relatedCuesCache = out;
  }
  return relatedCuesCache;
}

function wordDistractors(q: Question): Distractor[] | null {
  const pos = posOf[q.key];
  if (!pos) return null;
  const candidates = shuffle(questions.filter((o) => o.kind === "word" && posOf[o.key] === pos && o.id !== q.id && o.ja !== q.ja));
  const confused = confusables.get(q.en.toLowerCase()) ?? [];
  const near = relatedWords(q.en.toLowerCase()).filter((w) => !confused.includes(w));
  const otherSenses = questions
    .filter((o) => o.kind === "word" && o.id !== q.id && o.en.toLowerCase() === q.en.toLowerCase())
    .map((o) => o.ja);
  const picked: Distractor[] = [];
  const pickedEn: string[] = [];
  const take = (fits: (c: Question) => boolean, checked: boolean, upTo: number) => {
    for (const c of candidates) {
      if (picked.length >= upTo) break;
      if (
        !fits(c) ||
        c.en.toLowerCase() === q.en.toLowerCase() ||
        near.includes(c.en.toLowerCase()) ||
        pickedEn.includes(c.en.toLowerCase()) ||
        shareASense(c.ja, q.ja) ||
        picked.some(([p]) => shareASense(p, c.ja)) ||
        (!checked && meaningsClose(c.ja, q.ja)) ||
        otherSenses.some((o) => meaningsClose(c.ja, o))
      )
        continue;
      picked.push([c.ja, c.en]);
      pickedEn.push(c.en.toLowerCase());
    }
  };
  take((c) => confused.includes(c.en.toLowerCase()), true, 2);
  // Mirrors the Rust side: an answer asked with its nuance among others with theirs.
  if (cueFor(q.en, q.ja, relatedCues())) {
    const cued = (c: Question) => !!cueFor(c.en, c.ja, relatedCues());
    take((c) => cued(c) && spelledAlike(c.en, q.en), false, 2);
    take((c) => cued(c) && c.group === q.group, false, 3);
    take((c) => cued(c) && c.category === q.category, false, 3);
    take((c) => cued(c) && c.tier === q.tier, false, 3);
    take(cued, false, 3);
  }
  take((c) => spelledAlike(c.en, q.en), false, 2);
  take((c) => c.group === q.group, false, 3);
  take((c) => c.category === q.category, false, 3);
  take((c) => c.tier === q.tier, false, 3);
  take(() => true, false, 3);
  take(() => true, true, 3);
  return picked;
}

/** Three wrong translations from the tightest semantic circle available; mirrors the Rust side. */
function japaneseDistractors(q: Question): Distractor[] {
  if (q.kind === "word") {
    const opts = wordDistractors(q);
    if (opts && opts.length >= 3) return opts;
  }
  const out: Distractor[] = [];
  const pools = [
    questions.filter((o) => o.id !== q.id && o.kind === q.kind && o.group === q.group && o.ja !== q.ja),
    questions.filter((o) => o.id !== q.id && o.kind === q.kind && o.category === q.category && o.ja !== q.ja),
    questions.filter((o) => o.id !== q.id && o.kind === q.kind && o.ja !== q.ja),
    questions.filter((o) => o.id !== q.id && o.ja !== q.ja),
  ];
  for (const pool of pools) {
    for (const o of shuffle(pool)) {
      if (out.length >= 3) break;
      if (!out.some(([ja]) => ja === o.ja)) out.push([o.ja, o.en]);
    }
    if (out.length >= 3) break;
  }
  return out;
}

/** Mirrors commands::japanese_options: the four Japanese options, shuffled, and the English of each. */
function japaneseOptions(q: Question): { options: string[]; optionEn: string[] } {
  const opts = shuffle([...japaneseDistractors(q), [q.ja, q.en] as Distractor]);
  return { options: opts.map(([ja]) => ja), optionEn: opts.map(([, en]) => en) };
}

/** Every English the bank treats as a correct rendering of this question's Japanese. */
/** Mirrors TWO_WAY_DETERMINERS / ALWAYS_PLURAL / number_neutral_after in util.rs. */
const TWO_WAY_DETERMINERS = new Set(["the", "his", "her", "my", "your", "our", "their", "its"]);
const ALWAYS_PLURAL = new Set(
  `glasses sunglasses scissors pants trousers jeans shorts pajamas clothes stairs headphones
   earphones binoculars tweezers pliers belongings goods groceries savings surroundings outskirts
   congratulations thanks means series species news mathematics physics economics politics remains
   arms hands eyes ears feet legs shoulders knees teeth fingers toes lips hips wrists ankles elbows
   nails lungs paws wings shoes socks gloves boots slippers chopsticks lines ropes books shots times
   words guns rules strings nerves cards findings drums customs leftovers valuables refreshments
   odds wits`.split(/\s+/),
);
const FORCES_PLURAL = new Set(
  `all both many few several numerous various most some one two three four five six seven eight
   nine ten dozens hundreds thousands plenty number group pair couple bunch lots none each every
   list series row line set`.split(/\s+/),
);
const NUMBER_NEUTRAL_AFTER = new Set(
  `at in on by for with of to from about under over between among into onto during since until
   before after through across along around behind below beside near off out up down against
   without within inside outside and or but that which who whose when where while because so
   a an the this these those every each all some any no more most my your our their its one two
   three several both another other never always often again still also too here there now then
   today yesterday tomorrow well back away home together first last early late soon just even only
   almost`.split(/\s+/),
);

const MASS_NOUNS = new Set(
  `water milk juice tea rice bread butter cheese meat sugar salt pepper flour oil food money cash
   furniture luggage baggage equipment information advice news homework housework traffic weather
   music research knowledge progress evidence education fun help health happiness sadness anger
   love space air oxygen smoke dust sand snow ice wood plastic metal gold silver electricity energy
   mail software jewelry clothing machinery transportation accommodation garbage trash pollution
   sleep patience courage luck peace safety silence stuff wildlife poetry literature vocabulary
   slang feedback grass hair laundry scenery pasta soup chaos damage wealth`.split(/\s+/),
);
const IRREGULAR_PLURALS: Record<string, string> = {
  child: "children", person: "people", man: "men", woman: "women", foot: "feet", tooth: "teeth",
  mouse: "mice", goose: "geese", leaf: "leaves", life: "lives", knife: "knives", wife: "wives",
  shelf: "shelves", wolf: "wolves", half: "halves", loaf: "loaves", thief: "thieves",
  calf: "calves", scarf: "scarves",
};
/** Verbs taking a bare infinitive, which never agrees: "watched the lizard(s) bask". */
const BARE_INFINITIVE_VERBS = new Set(
  `watch watched watches see saw sees hear heard hears notice noticed notices feel felt feels let
   lets make made makes have had has help helped helps observe observed`.split(/\s+/),
);

function pluralOf(word: string): string | null {
  if (word.length < 2 || MASS_NOUNS.has(word)) return null;
  if (IRREGULAR_PLURALS[word]) return IRREGULAR_PLURALS[word];
  if (word.endsWith("s") || word.endsWith("ese") || word.endsWith("fish") || word.endsWith("sheep")) return null;
  if (/(x|z|ch|sh)$/.test(word)) return word + "es";
  if (/[^aeiou]y$/.test(word)) return word.slice(0, -1) + "ies";
  return word + "s";
}

/** Mirrors db::is_countable_noun: evidence from the bank that the noun takes a plural at all. */
let countableCache: { heads: Set<string>; used: Set<string> } | null = null;
function countabilityEvidence() {
  if (countableCache) return countableCache;
  const heads = new Set<string>();
  const used = new Set<string>();
  const bare = (t: string) => t.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const isBoundary = (w: string) =>
    w.endsWith("ing") ||
    w.endsWith("ed") ||
    `at in on by for with of to from about under over between among into onto during since until
     before after through across along around behind below beside near and or but that which who
     whose when where while because`
      .split(/\s+/)
      .includes(w);
  for (const q of questions) {
    for (const text of [q.en, q.prompt ?? "", q.example ?? ""]) {
      const toks = text.split(/\s+/).filter(Boolean);
      toks.forEach((tok, i) => {
        const w = bare(tok);
        if (!w) return;
        used.add(w);
        if (i === 0) return;
        if (!["a", "an", "one", "each", "every", "another"].includes(bare(toks[i - 1]))) return;
        const ends = /[.,?!;:]$/.test(tok) || i + 1 === toks.length;
        if (ends || isBoundary(bare(toks[i + 1] ?? ""))) heads.add(w);
      });
    }
  }
  countableCache = { heads, used };
  return countableCache;
}

function isCountableNoun(word: string): boolean {
  const { heads, used } = countabilityEvidence();
  const p = pluralOf(word);
  return heads.has(word) || (p !== null && used.has(p));
}

function singularCandidates(word: string): string[] {
  if (word.length < 4 || !word.endsWith("s") || word.endsWith("ss") || ALWAYS_PLURAL.has(word)) return [];
  const out: string[] = [];
  if (word.endsWith("ies") && word.length > 5) out.push(word.slice(0, -3) + "y");
  if (word.endsWith("ves")) out.push(word.slice(0, -3) + "f", word.slice(0, -3) + "fe");
  if (word.endsWith("es")) out.push(word.slice(0, -2));
  out.push(word.slice(0, -1));
  return out;
}

function numberNeutralAfter(next: string | undefined, governed: boolean): boolean {
  if (!next) return true;
  if (governed && !next.endsWith("s")) return true;
  return next.endsWith("ing") || next.endsWith("ed") || next.endsWith("ly") || NUMBER_NEUTRAL_AFTER.has(next);
}

/** Mirrors number_variants in util.rs: see the reasoning there. */
function numberVariants(sentence: string, known: (w: string) => boolean): string[] {
  const tokens = sentence.split(" ");
  const bare = (t: string) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
  const swaps: [number, string][] = [];
  for (let i = 1; i < tokens.length && swaps.length < 3; i++) {
    if (!TWO_WAY_DETERMINERS.has(bare(tokens[i - 1]))) continue;
    if ([2, 3].some((back) => i - back >= 0 && FORCES_PLURAL.has(bare(tokens[i - back])))) continue;
    const word = bare(tokens[i]);
    const governed = i >= 2 && BARE_INFINITIVE_VERBS.has(bare(tokens[i - 2]));
    if (!numberNeutralAfter(tokens[i + 1] === undefined ? undefined : bare(tokens[i + 1]), governed)) continue;
    const other = word.endsWith("s")
      ? singularCandidates(word).find(known)
      : known(word) && isCountableNoun(word)
        ? pluralOf(word) ?? undefined
        : undefined;
    if (!other || other === word) continue;
    const start = tokens[i].search(/[\p{L}\p{N}]/u);
    const end = tokens[i].length - [...tokens[i]].reverse().join("").search(/[\p{L}\p{N}]/u);
    const cased = /[A-Z]/.test(tokens[i][start]) ? other[0].toUpperCase() + other.slice(1) : other;
    swaps.push([i, tokens[i].slice(0, start) + cased + tokens[i].slice(end)]);
  }
  const out: string[] = [];
  for (let mask = 1; mask < 1 << swaps.length; mask++) {
    const words = [...tokens];
    swaps.forEach(([at, replacement], bit) => {
      if (mask & (1 << bit)) words[at] = replacement;
    });
    out.push(words.join(" "));
  }
  return out;
}

function acceptedAnswers(q: Question): string[] {
  const out = [q.en];
  for (const o of questions) {
    if (o.id !== q.id && o.kind === q.kind && o.group === q.group && o.ja === q.ja && !out.includes(o.en)) {
      out.push(o.en);
    }
  }
  // An idiom's wording is fixed, so only ordinary sentences get the singular reading.
  if (q.kind !== "idiom") {
    const known = (w: string) => w in mockDictionary();
    for (const v of numberVariants(q.en, known)) if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** Three wrong replies borrowed from sibling dialogues; mirrors the Rust side. */
function englishDistractors(q: Question): string[] {
  const out: string[] = [];
  const pools = [
    questions.filter((o) => o.id !== q.id && o.kind === q.kind && o.group === q.group && o.en !== q.en),
    questions.filter((o) => o.id !== q.id && o.kind === q.kind && o.category === q.category && o.en !== q.en),
    questions.filter((o) => o.id !== q.id && o.kind === q.kind && o.en !== q.en),
  ];
  for (const pool of pools) {
    for (const o of shuffle(pool)) {
      if (out.length >= 3) break;
      if (!out.includes(o.en)) out.push(o.en);
    }
    if (out.length >= 3) break;
  }
  return out;
}

/** Mirrors util.rs `fill_blank`: the "no article" choice leaves the gap empty. */
function fillBlank(prompt: string, answer: string): string {
  if (answer !== "(none)") return prompt.replace(/_{2,}/g, () => answer);
  return prompt.replace(/ ?_{2,} ?/g, (gap) => (gap.startsWith(" ") && gap.endsWith(" ") ? " " : ""));
}

function audioTextFor(q: Question): string {
  if (q.kind === "grammar") return fillBlank(q.prompt ?? q.en, q.en);
  if (q.kind === "dialogue") return q.prompt ?? q.en;
  return q.en;
}

/** Mirrors grammar_note_for in commands.rs: the point names the explanation to show. */
const notesByPoint = new Map(
  (grammarNotes as (GrammarNote & { point: string })[]).map((n) => [n.point, n]),
);

function grammarNoteFor(q: Question): GrammarNote | null {
  const note = q.point ? notesByPoint.get(q.point) : undefined;
  return note ? { category: note.category, title: note.title, body: note.body, example: note.example } : null;
}

/** Mirrors db::word_parts: a word's prefix, root and suffix (or base word), keyed by its English. */
const wordPartsByWord = new Map(
  (wordPartsList as { en: string; parts: WordPart[] }[]).map((w) => [w.en.toLowerCase(), w.parts]),
);
/** Mirrors db::part_shifts: how far a word's meaning has moved from its base word's. */
const partShifts = new Map(
  (wordPartsList as { en: string; shift?: string }[]).flatMap((w) => (w.shift ? [[w.en.toLowerCase(), w.shift]] : [])),
);
/** Mirrors db::abbreviations: an abbreviation (lowercase, "a.m" without its last dot) → what it stands for. */
const abbreviations = new Map(Object.entries(abbreviationList as Record<string, Abbreviation>));

interface FamilySeed {
  id: string;
  forms: string[];
  ja: string;
  origin?: string | null;
  limit?: number;
  members: { word: string; ja: string; note: string }[];
}

/** Mirrors db::family_index: "word|spelling of a piece" → its family, for listed members only. */
const familyIndex = new Map<string, FamilySeed>();
for (const f of wordFamilies as FamilySeed[]) {
  for (const m of f.members) for (const form of f.forms) familyIndex.set(`${m.word.toLowerCase()}|${form}`, f);
}

/**
 * Mirrors db::parts_with_families: a word's parts, each with the words sharing it, if any, and a
 * base word with how it is built in turn (one step).
 */
function partsWithFamilies(key: string): WordPart[] {
  return (wordPartsByWord.get(key) ?? []).map((p) => {
    const f = familyIndex.get(`${key}|${p.text.toLowerCase()}`);
    const members = (f?.members ?? [])
      .filter((m) => m.word.toLowerCase() !== key)
      .slice(0, f?.limit ?? 3)
      .map((m) => ({ ...m, parts: wordPartsByWord.get(m.word.toLowerCase()) ?? [] }));
    const chain = p.kind === "base" ? wordPartsByWord.get(p.text.toLowerCase()) : undefined;
    return {
      ...p,
      ...(f && members.length ? { family: { ja: f.ja, origin: f.origin ?? null, forms: f.forms, members } } : {}),
      ...(chain ? { chain } : {}),
    };
  });
}

function groupByWord<T extends { word: string }>(list: T[]): Map<string, Omit<T, "word">[]> {
  const map = new Map<string, Omit<T, "word">[]>();
  for (const { word, ...rest } of list) {
    const key = word.toLowerCase();
    map.set(key, [...(map.get(key) ?? []), rest]);
  }
  return map;
}

const examplesByWord = groupByWord(wordExamples as ({ word: string } & ExampleSentence)[]);
const usagesByWord = groupByWord(wordUsages as ({ word: string } & WordUsage)[]);
const originByIdiom = new Map(
  Object.entries(idiomOrigins as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
);

interface RelatedSeed {
  title: string;
  members: {
    word: string;
    nuance: string;
    patterns?: string[];
    hideUsages?: boolean;
    example?: string;
    exampleJa?: string;
  }[];
}

/** Mirrors db::related_groups: the groups `key` belongs to, each member with how it is used. */
function relatedGroups(key: string): RelatedGroup[] {
  return relatedGroupsWhere(key, () => true);
}

/** Mirrors db::related_groups_of_pattern: the 類似表現 of a 用法's word that are about that pattern. */
function relatedGroupsOfPattern(pattern: string): RelatedGroup[] {
  const p = pattern.trim();
  const owners = [...usagesByWord.entries()]
    .filter(([, list]) => (list as WordUsage[]).some((u) => u.pattern === p))
    .map(([w]) => w)
    .sort();
  return owners.flatMap((owner) =>
    relatedGroupsWhere(owner, (m) => !m.hideUsages && (!m.patterns?.length || m.patterns.includes(p))),
  );
}

function relatedGroupsWhere(key: string, keep: (m: RelatedSeed["members"][number]) => boolean): RelatedGroup[] {
  return (relatedSeeds as RelatedSeed[])
    .filter((g) => g.members.some((m) => m.word.toLowerCase() === key && keep(m)))
    .map((g) => ({
      title: g.title,
      members: g.members.map((m) => {
        const word = m.word.toLowerCase();
        const isSelf = word === key;
        const usages =
          isSelf || m.hideUsages
            ? []
            : ((usagesByWord.get(word) ?? []) as WordUsage[]).filter(
                (u) => !m.patterns?.length || m.patterns.includes(u.pattern),
              );
        let example: ExampleSentence | null = null;
        if (!isSelf && usages.length === 0) {
          example =
            m.example && m.exampleJa
              ? { en: m.example, ja: m.exampleJa }
              : (((examplesByWord.get(word) ?? [])[0] as ExampleSentence | undefined) ?? null);
        }
        return { word: m.word, nuance: m.nuance, isSelf, usages, example };
      }),
    }));
}

/** Mirrors db::word_notes: everything the data says about a word or an idiom, or null. */
/** Mirrors db::usages_of: a phrasal verb takes the patterns of its verb that begin with it. */
function usagesOf(key: string): WordUsage[] {
  const own = usagesByWord.get(key);
  if (own) return own as WordUsage[];
  const space = key.indexOf(" ");
  if (space < 0) return [];
  return ((usagesByWord.get(key.slice(0, space)) ?? []) as WordUsage[]).filter((u) => {
    const p = u.pattern.toLowerCase();
    return p === key || p.startsWith(key + " ");
  });
}

function wordNotes(word: string): WordNotes | null {
  const key = word.trim().toLowerCase();
  const notes: WordNotes = {
    parts: partsWithFamilies(key),
    examples: (examplesByWord.get(key) ?? []) as ExampleSentence[],
    usages: usagesOf(key),
    origin: originByIdiom.get(key) ?? null,
    related: relatedGroups(key),
    used: [],
    irregular: [],
    shift: partShifts.get(key) ?? null,
    // "a.m." and "a.m" alike (db::word_notes trims every last dot)
    abbreviation: abbreviations.get(key.replace(/\.+$/, "")) ?? null,
  };
  return notesAreEmpty(notes) ? null : notes;
}

function notesAreEmpty(n: WordNotes): boolean {
  return (
    !n.parts.length && !n.examples.length && !n.usages.length && !n.origin && !n.related.length && !n.used.length && !n.irregular.length &&
    !n.abbreviation &&
    !n.antonym
  );
}

/**
 * Mirrors db::antonym_seeds: a word's opposite in every sense ("refuse", or ["light", "光"] shown in
 * a sense of it), or [sense, opposite, its sense?] apiece.
 */
const antonymSeeds = antonymList as unknown as Record<string, string | [string, string] | string[][]>;

/** Mirrors db::antonym_of: the 対義語 of a word in the sense it is asked or saved in, with its meaning. */
function antonymOf(word: string, meaning: string): Antonym | null {
  const seed = antonymSeeds[word.trim().toLowerCase()];
  if (!seed) return null;
  let en: string;
  let sense: string | undefined;
  if (typeof seed === "string") en = seed;
  else if (typeof seed[0] === "string") [en, sense] = seed as [string, string];
  else {
    const bySense = seed as string[][];
    const hit = meaningParts(meaning)
      .map((s) => bySense.find((e) => e[0] === s))
      .find(Boolean);
    if (!hit) return null;
    [, en, sense] = hit;
  }
  // The meaning it is shown with: its word question's, else its glossary's (db::shown_meaning).
  const key = en.toLowerCase();
  const shown = sense ?? questions.find((q) => q.kind === "word" && q.en.toLowerCase() === key)?.ja ?? (glossary as Record<string, string>)[key];
  return shown ? { word: en, meaning: shown } : null;
}

/* ---------- Irregular verbs (mirrors db::irregular_of / db::irregulars_in) ---------- */

interface IrregularSeed {
  base: string;
  past: string;
  participle: string;
  say?: string[];
}

const IRREGULAR_SEEDS = irregularSeeds as IrregularSeed[];
const alternatives = (forms: string) => forms.split("/").map((f) => f.trim());
const irregularByBase = new Map(IRREGULAR_SEEDS.map((v, i) => [v.base, i]));
const irregularByForm = new Map<string, number>();
const irregularParticiples = new Set<string>();
IRREGULAR_SEEDS.forEach((v, i) => {
  for (const form of [v.base, ...alternatives(v.past), ...alternatives(v.participle)]) {
    if (!irregularByForm.has(form)) irregularByForm.set(form, i);
  }
  for (const pp of alternatives(v.participle)) irregularParticiples.add(pp);
});
irregularByForm.set("has", irregularByBase.get("have")!);
irregularByForm.set("does", irregularByBase.get("do")!);

function irregularForms(v: IrregularSeed): IrregularVerb {
  const written = (forms: string) => alternatives(forms).join(" / ");
  const say = v.say ?? [v.base, alternatives(v.past)[0], alternatives(v.participle)[0]];
  return { base: v.base, past: written(v.past), participle: written(v.participle), say };
}

/**
 * Mirrors db::irregular_of: a word that is an irregular verb, or the verb a phrase or a pattern
 * starts with (come back: come, split A into B: split); none for a phrase of be (be afraid of ～).
 */
function irregularOf(word: string): IrregularVerb | null {
  const tokens = word.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const head = tokens[0].toLowerCase();
  if (head === "be" && tokens.length > 1) return null;
  const i = irregularByBase.get(head);
  return i === undefined ? null : irregularForms(IRREGULAR_SEEDS[i]);
}

const MAX_IRREGULARS = 6;
const NOT_VERBS_HERE = [
  "bear", "bears", "bore", "spring", "springs", "lie", "lies", "lying", "lay", "lays", "light", "lights", "ground",
  "grounds", "bit", "leaves", "bound", "tear", "tears", "upset",
];
const NOUN_OR_VERB = [
  "show", "shows", "drink", "drinks", "run", "runs", "cut", "cuts", "cost", "costs", "hit", "hits", "set", "sets",
  "bet", "bets", "beat", "beats", "deal", "deals", "ride", "rides", "swing", "swings", "fight", "fights", "fall",
  "falls", "feed", "feeds", "speed", "speeds", "split", "splits", "spread", "spreads", "sink", "sinks", "ring", "rings",
  "stick", "sticks", "shot", "cast", "casts", "forecast", "forecasts", "broadcast", "broadcasts", "break", "breaks",
  "drive", "drives", "pay", "strike", "strikes", "bite", "bites", "blow", "blows", "sleep", "swim", "slide", "slides",
  "spin", "draw", "draws", "stand", "stands", "lead", "leads", "sting", "stings", "shake", "shakes", "win", "wins",
  "quit", "burst", "catch", "fly", "flies", "hurt", "creep", "creeps",
];
const BEFORE_A_VERB = [
  "i", "you", "we", "they", "he", "she", "it", "who", "which", "that", "can", "could", "will", "would", "shall",
  "should", "may", "might", "must", "to", "not", "never", "always", "often", "usually", "sometimes", "also", "just",
  "really", "still", "even", "already", "let", "please", "don't", "doesn't", "didn't", "can't", "won't", "couldn't",
  "wouldn't", "shouldn't", "i'll", "you'll", "we'll", "they'll", "he'll", "she'll", "i'd", "you'd", "we'd", "they'd",
  "am", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "having",
];
const BEFORE_A_NOUN = [
  "the", "a", "an", "my", "your", "his", "its", "our", "their", "every", "each", "this", "these", "those", "some", "any",
  "no", "another", "many", "few", "several",
];
const BE_FORMS = ["am", "is", "are", "was", "were", "be", "been", "being"];
const NOUN_ING = [
  "building", "buildings", "meeting", "meetings", "feeling", "feelings", "beginning", "beginnings", "setting",
  "settings", "understanding", "drawing", "drawings", "saying", "sayings", "writing", "writings", "findings",
];
const SUBJECTS = ["i", "you", "he", "she", "it", "we", "they", "there"];
const BEFORE_PARTICIPLE = ["not", "never", "already", "just", "ever", "always", "also", "recently", "finally", "still", "only", "really", "yet"];

function auxiliaryHave(tokens: string[], i: number): boolean {
  const t = tokens.slice(i + 1, i + 5).find((x) => !BEFORE_PARTICIPLE.includes(x) && !SUBJECTS.includes(x));
  return !!t && (t === "been" || t === "better" || (t.length > 3 && t.endsWith("ed")) || irregularParticiples.has(t));
}

/** Mirrors db::irregular_at: the irregular verb tokens[i] is a form of, when it is that verb here. */
function irregularAt(tokens: string[], i: number): number | null {
  const t = tokens[i];
  if (NOT_VERBS_HERE.includes(t)) return null;
  let v = irregularByForm.get(t);
  let derived = false;
  if (v === undefined) {
    derived = true;
    const base = lemmas(t).slice(1).find((c) => readsAs(t, c) && irregularByBase.has(c));
    if (base === undefined) return null;
    v = irregularByBase.get(base)!;
  }
  const base = IRREGULAR_SEEDS[v].base;
  const prev = i > 0 ? tokens[i - 1] : undefined;
  const next = tokens[i + 1];
  const after = (words: string[]) => prev !== undefined && words.includes(prev);
  if (base === "be" || after(BEFORE_A_NOUN)) return null;
  if (derived && t.endsWith("ing") && NOUN_ING.includes(t) && !after(BE_FORMS)) return null;
  if (NOUN_OR_VERB.includes(t) && (i === 0 ? next === "of" : !after(BEFORE_A_VERB))) return null;
  let skip = false;
  if (t === "left") {
    skip =
      after(["turn", "turned", "turns", "turning", "to", "on", "keep", "go"]) ||
      ["side", "hand", "lane", "arm", "leg", "foot", "eye", "ear", "corner", "wing", "turn"].includes(next ?? "");
  } else if (t === "fall" || t === "falls") skip = after(["in", "last", "next", "early", "late"]);
  else if (t === "mean") skip = after(["is", "are", "was", "were", "be", "so", "very", "too", "really"]);
  else if (t === "do" || t === "does" || t === "did") skip = next === "not" || SUBJECTS.includes(next ?? "");
  else if (t === "have" || t === "has" || t === "had") skip = auxiliaryHave(tokens, i);
  return skip ? null : v;
}

/** Mirrors db::irregulars_in: the irregular verbs the sentences use, in order. */
function irregularsIn(texts: string[]): IrregularVerb[] {
  const found: number[] = [];
  for (const text of texts) {
    const tokens = tokenize(text);
    tokens.forEach((_, i) => {
      const v = irregularAt(tokens, i);
      if (v !== null && !found.includes(v)) found.push(v);
    });
  }
  return found.slice(0, MAX_IRREGULARS).map((v) => irregularForms(IRREGULAR_SEEDS[v]));
}

/* ---------- Patterns found in a sentence (mirrors db::used_words) ---------- */

type Piece =
  | { kind: "word"; words: string[] }
  | { kind: "ing" }
  | { kind: "slot" }
  | { kind: "optional" }
  | { kind: "shortSlot" }
  | { kind: "base" }
  | { kind: "gap" };

const OPTIONAL_PATTERN_WORDS = ["be", "is", "am", "are", "feel", "can", "would", "could", "will", "don't"];
const REFLEXIVES = ["oneself", "myself", "yourself", "himself", "herself", "itself", "ourselves", "yourselves", "themselves"];
const PARTICLES = ["off", "up", "out", "away", "down", "back"];
const TOO_COMMON_FOR_RELATED = [
  "big", "small", "little", "large", "fast", "sleep", "rest", "close", "cheap", "expensive", "price", "quiet", "wear", "fix", "hurt", "store", "very", "really",
];
/** Mirrors TOO_MANY_SENSES_FOR_RELATED: their 類似表現 is about one sense only. */
const TOO_MANY_SENSES_FOR_RELATED = ["have", "get", "take", "make", "put", "go", "come", "keep", "find", "give", "let", "do"];
/** Mirrors IN_MOST_SENTENCES: prepositions and quantifiers in nearly every sentence. */
const IN_MOST_SENTENCES = ["for", "from", "by", "every", "each", "many", "much", "few", "fewer", "less", "other", "another", "too", "also", "either", "else"];
const NOT_ING = ["morning", "evening", "ceiling", "during", "string", "spring", "sibling", "pudding", "awning", "darling"];
const NOUNS_AFTER_TO = ["work", "school", "bed", "class", "church", "court", "rain", "store", "water"];
const DETERMINERS = ["the", "a", "an", "my", "your", "his", "its", "our", "their", "every", "each"];
const ADVERBS = [
  "well", "very", "really", "so", "too", "just", "also", "still", "even", "never", "always", "often", "sometimes",
  "usually", "already", "soon", "much", "quite", "rather", "right", "straight", "early", "late", "hard", "not",
  "almost", "only", "again", "ever", "all", "both",
];
const NOT_LY_ADVERBS = [
  "family", "italy", "july", "belly", "jelly", "lily", "rally", "assembly", "ally", "bully", "butterfly",
  "dragonfly", "firefly", "monopoly", "supply", "reply", "apply", "rely", "fly", "multiply", "imply", "comply",
];
const MAX_ADVERBS = 2;
const MAX_SLOT_WORDS = 6;
const MAX_SHORT_SLOT_WORDS = 3;
const MAX_GAP_WORDS = 2;
const MAX_USED_WORDS = 6;

/** Mirrors db::base_verbs: verbs of the bank by their part of speech, glossary words by their gloss. */
const baseVerbs: Set<string> = (() => {
  const verbLike = (ja: string) => {
    const first = (ja.split(/[、，,]/)[0] ?? "").replace(/（[^）]*）|\([^)]*\)/g, "").trim();
    return /[うくぐすつぬぶむる]$/.test(first);
  };
  // A word of the bank is a verb when its part of speech says so; a glossary word by its gloss.
  const bank = new Map<string, boolean>();
  for (const q of seedQuestions) {
    if (q.kind !== "word" || /[\s-]/.test(q.en)) continue;
    const en = q.en.toLowerCase();
    bank.set(en, (bank.get(en) ?? false) || (wordPos as Record<string, string>)[q.key] === "verb");
  }
  const out = new Set<string>();
  for (const [en, ja] of Object.entries(glossary as Record<string, string>)) {
    if (!en.includes(" ") && !bank.has(en) && verbLike(ja)) out.add(en);
  }
  for (const [en, verb] of bank) if (verb) out.add(en);
  return out;
})();

function patternPiece(raw: string): Piece | null {
  const el = raw.replace(/^[?.,!]+|[?.,!]+$/g, "");
  if (!el) return null;
  if (["～", "…", "A", "B", "人", "形容詞", "節", "過去分詞"].includes(el)) return { kind: "slot" };
  if (el === "(…)") return { kind: "optional" };
  if (el === "原形") return { kind: "base" };
  if (el === "-ing") return { kind: "ing" };
  const words = el.split("/").flatMap(tokenize);
  if (!words.length) return null;
  if (words.some((w) => OPTIONAL_PATTERN_WORDS.includes(w))) return { kind: "gap" };
  if (words.length === 1 && words[0] === "oneself") return { kind: "word", words: REFLEXIVES };
  return { kind: "word", words };
}

const names = (p: Piece | undefined, headword: string) => p?.kind === "word" && p.words.includes(headword);
const samePiece = (a: Piece | undefined, b: Piece | undefined) => JSON.stringify(a) === JSON.stringify(b);
const isParticle = (p: Piece | undefined): p is { kind: "word"; words: string[] } =>
  p?.kind === "word" && p.words.every((x) => PARTICLES.includes(x));

function patternWays(pattern: string, headword: string): Piece[][] {
  let plain = "";
  let aside = 0;
  let optional = 0;
  for (const c of pattern) {
    if (c === "（") aside++;
    else if (c === "）") aside--;
    else if (c === "(") {
      optional++;
      if (optional === 1 && aside === 0) plain += " (…) ";
    } else if (c === ")") optional--;
    else if (aside === 0 && optional === 0) plain += c;
  }
  const ways: Piece[][] = [];
  for (const way of plain.replace(/／/g, " / ").split(" / ")) {
    const pieces = way.split(/\s+/).map(patternPiece).filter((p): p is Piece => p !== null);
    if (pieces.some((p) => names(p, headword))) {
      ways.push(pieces);
    } else if (ways.length) {
      const joined = ways[ways.length - 1].slice();
      const last = joined.pop();
      if (last?.kind === "base" && pieces[0]?.kind === "ing" && samePiece(joined[joined.length - 1], { kind: "word", words: ["to"] })) {
        joined.pop();
      }
      ways.push([...joined, ...pieces]);
    }
  }
  const swapped: Piece[][] = [];
  for (const w of ways) {
    const n = w.length;
    if (n >= 2 && w[n - 2].kind === "slot" && isParticle(w[n - 1])) {
      swapped.push([...w.slice(0, n - 2), w[n - 1], w[n - 2]]);
    } else if (n >= 3 && names(w[n - 3], headword) && isParticle(w[n - 2]) && w[n - 1].kind === "slot") {
      swapped.push([...w.slice(0, n - 2), w[n - 1], w[n - 2]]);
    }
  }
  const all = [...ways, ...swapped];
  // What stands before a particle or an -ing is short: "pick [you] up", "caught [him] sleeping".
  for (const way of all) {
    for (let i = 0; i + 1 < way.length; i++) {
      const next = way[i + 1];
      if (way[i].kind === "slot" && (isParticle(next) || next.kind === "ing")) way[i] = { kind: "shortSlot" };
    }
  }
  return all;
}

/** Mirrors Search::is_adverb: well / very …, or a word ending in -ly. */
const isAdverb = (t: string) => ADVERBS.includes(t) || (t.length > 4 && t.endsWith("ly") && !NOT_LY_ADVERBS.includes(t));

/** Mirrors db::reads_as: "speaker" is no speak, "completely" no complete. */
const readsAs = (token: string, word: string) =>
  token === word || !(token.endsWith("er") || token.endsWith("est") || token.endsWith("ly"));

function patternIsTelling(pieces: Piece[], headword: string, ja: string): boolean {
  return (
    (ja.includes("付けない") && !ja.includes("the は")) ||
    pieces.some((p) => p.kind === "ing" || (p.kind === "word" && !p.words.includes(headword)))
  );
}

/** Mirrors db::pieces_found: null when not found, else whether a word follows the headword. */
function piecesFound(pieces: Piece[], headword: string, tokens: string[], lemmaList: string[][]): boolean | null {
  let result: boolean | null = null;
  const hit = (p: Piece, j: number) => {
    const t = tokens[j];
    if (p.kind === "word") return p.words.some((w) => t === w || lemmaList[j].includes(w));
    if (p.kind === "ing") return t.length > 4 && t.endsWith("ing") && !t.endsWith("thing") && !NOT_ING.includes(t);
    return false;
  };
  const go = (i: number, last: number | null, gap: [number, number], afterHead: boolean | null, headSeen: boolean): boolean => {
    if (i === pieces.length) {
      result = afterHead === true;
      return true;
    }
    const first = pieces[i];
    const afterVerb = last !== null && lemmaList[last].some((w) => baseVerbs.has(w));
    const slot: [number, number] | null =
      first.kind === "slot" || first.kind === "base"
        ? [afterVerb ? 0 : 1, MAX_SLOT_WORDS]
        : first.kind === "optional"
          ? [0, MAX_SLOT_WORDS]
          : first.kind === "shortSlot"
            ? [1, MAX_SHORT_SLOT_WORDS]
            : null;
    if (slot) {
      return go(i + 1, last, [gap[0] + slot[0], gap[1] + slot[1]], headSeen && afterHead === null ? false : afterHead, false);
    }
    if (first.kind === "gap") return go(i + 1, last, [gap[0], gap[1] + MAX_GAP_WORDS], afterHead, headSeen);
    const from = last === null ? 0 : last + 1 + gap[0];
    const to = last === null ? tokens.length : Math.min(last + 2 + gap[1] + MAX_ADVERBS, tokens.length);
    const next = pieces[i + 1];
    for (let j = from; j < to; j++) {
      if (!hit(first, j)) continue;
      // Words beyond what the pattern allows must be adverbs: "get along [well] with".
      if (last !== null) {
        let adverbs = 0;
        for (let k = last + 1; k < j; k++) if (isAdverb(tokens[k])) adverbs++;
        if (j - last - 1 > gap[1] + Math.min(adverbs, MAX_ADVERBS)) continue;
      }
      const isHead = names(first, headword);
      if (isHead && last === null && j > 0 && DETERMINERS.includes(tokens[j - 1])) continue;
      if (isHead && !readsAs(tokens[j], headword)) continue;
      if (
        first.kind === "word" &&
        first.words.includes("to") &&
        (next?.kind === "slot" || next?.kind === "shortSlot") &&
        j + 1 < tokens.length &&
        baseVerbs.has(tokens[j + 1]) &&
        !NOUNS_AFTER_TO.includes(tokens[j + 1])
      ) {
        continue;
      }
      // And "to" before what is no verb takes a noun, not 原形: "tended to the patients".
      if (
        first.kind === "word" &&
        first.words.includes("to") &&
        next?.kind === "base" &&
        !(j + 1 < tokens.length && (baseVerbs.has(tokens[j + 1]) || isAdverb(tokens[j + 1])))
      ) {
        continue;
      }
      const seen = headSeen && afterHead === null ? true : afterHead;
      if (go(i + 1, j, [0, 0], seen, isHead)) return true;
    }
    return false;
  };
  return go(0, null, [0, 0], null, false) ? result : null;
}

/** Mirrors db::used_words: the words of a sentence whose patterns it uses, or that are easily confused. */
/** Mirrors PHRASES_OF_MANY_SENSES: phrasal verbs of the 類似表現 not looked for in a sentence. */
const PHRASES_OF_MANY_SENSES = ["get in", "get off", "get on", "get out", "get over", "pick up", "take off", "give back", "put out", "come across"];

/** Mirrors related_phrases: the 類似表現 members of more than one word, the longest first. */
const RELATED_PHRASES: string[][] = (() => {
  const out: string[][] = [];
  for (const g of relatedSeeds as RelatedSeed[]) {
    for (const m of g.members) {
      const w = m.word.toLowerCase();
      const words = w.split(/\s+/);
      if (words.length > 1 && !PHRASES_OF_MANY_SENSES.includes(w) && !out.some((o) => o.join(" ") === w)) out.push(words);
    }
  }
  return out.sort((a, b) => b.length - a.length);
})();

/** Mirrors related_phrase_at: its verb in any form, the words after it as written and right after it. */
function relatedPhraseAt(i: number, tokens: string[], lemmaList: string[][]): string[] | undefined {
  return RELATED_PHRASES.find(
    (words) => lemmaList[i].includes(words[0]) && words.slice(1).every((w, k) => tokens[i + 1 + k] === w),
  );
}

/**
 * Mirrors db::compound_phrases: the word questions of more than one word but the phrasal verbs, the
 * idioms, and the glossary's whose first sense is no verb. A word inside one is the phrase's (the
 * rush of "rush hour" is no 急ぐ).
 */
let compoundIndex: PhraseIndex | null = null;
function compoundPhrases(): PhraseIndex {
  if (compoundIndex) return compoundIndex;
  const keys: Dictionary = {};
  for (const [en, asked] of recipeLookup.words) if (asked.every(([, pos]) => pos !== "verb")) keys[en] = "";
  for (const en of recipeLookup.idioms.keys()) keys[en] = "";
  for (const [en, senses] of Object.entries(glossaryPos)) if (senses[0]?.[0] !== "verb") keys[en] = "";
  compoundIndex = buildPhraseIndex(keys);
  return compoundIndex;
}

function usedWords(texts: string[]): UsedWord[] {
  const out: UsedWord[] = [];
  const foundPattern: boolean[] = [];
  for (const text of texts) {
    const tokens = tokenize(text);
    const lemmaList = tokens.map(lemmas);
    const inPhrase = tokens.map(() => false);
    for (const span of phraseSpans(tokens, compoundPhrases())) inPhrase.fill(true, span.start, span.end);
    // Mirrors used_words: the words of a phrasal verb found are its own, not its verb's.
    let skipTo = 0;
    lemmaList.forEach((candidates, i) => {
      if (i < skipTo) return;
      const words = relatedPhraseAt(i, tokens, lemmaList);
      if (words) {
        skipTo = i + words.length;
        const phrase = words.join(" ");
        if (out.some((u) => u.word === phrase)) return;
        const head = words[0];
        const usages = usagesOf(phrase).filter((u) =>
          patternWays(u.pattern, head)
            .filter((p) => patternIsTelling(p, head, u.ja))
            .some((p) => piecesFound(p, head, tokens, lemmaList) !== null),
        );
        const related = relatedGroups(phrase);
        const nuance = related.flatMap((g) => g.members).find((m) => m.isSelf)?.nuance ?? null;
        foundPattern.push(usages.length > 0);
        out.push({ word: phrase, nuance, usages, related });
        return;
      }
      for (const word of candidates) {
        if (out.some((u) => u.word === word)) continue;
        // Mirrors used_words: not as a noun after "the", nor as a piece of a phrase ("rush hour").
        const asWord = readsAs(tokens[i], word) && !(i > 0 && DETERMINERS.includes(tokens[i - 1])) && !inPhrase[i];
        const found: [WordUsage, boolean][] = [];
        for (const u of (usagesByWord.get(word) ?? []) as WordUsage[]) {
          const hits = patternWays(u.pattern, word)
            .filter((p) => patternIsTelling(p, word, u.ja))
            .map((p) => piecesFound(p, word, tokens, lemmaList))
            .filter((h): h is boolean => h !== null);
          if (hits.length) found.push([u, hits.includes(true)]);
        }
        const close = found.some(([, c]) => c);
        let usages = found.filter(([, c]) => c || !close).map(([u]) => u);
        const related = relatedGroups(word);
        // Easily confused (lend / borrow) and no pattern of it found: shown with its 類似表現 and the
        // patterns it may be using that no sentence could tell (lend 人 ～).
        const confusable =
          !usages.length &&
          asWord &&
          related.length > 0 &&
          !TOO_COMMON_FOR_RELATED.includes(word) &&
          !TOO_MANY_SENSES_FOR_RELATED.includes(word) &&
          !IN_MOST_SENTENCES.includes(word);
        if (!usages.length && !confusable) continue;
        foundPattern.push(usages.length > 0);
        if (!usages.length) {
          usages = ((usagesByWord.get(word) ?? []) as WordUsage[]).filter((u) =>
            patternWays(u.pattern, word).some((p) => !patternIsTelling(p, word, u.ja)),
          );
        }
        const nuance = related.flatMap((g) => g.members).find((m) => m.isSelf)?.nuance ?? null;
        out.push({ word, nuance, usages, related });
        break;
      }
    });
  }
  // Mirrors used_words: the words whose patterns the sentence uses first, then the confusable ones.
  return out
    .map((u, i) => [u, i] as const)
    .sort((a, b) => Number(!foundPattern[a[1]]) - Number(!foundPattern[b[1]]) || a[1] - b[1])
    .slice(0, MAX_USED_WORDS)
    .map(([u]) => u);
}

/** Mirrors notes_for in commands.rs. */
function notesFor(q: Question, audioText: string): WordNotes | null {
  if (q.kind === "word") {
    const notes = wordNotes(q.en) ?? { parts: [], examples: [], usages: [], origin: null, related: [], used: [], irregular: [] };
    notes.antonym = antonymOf(q.en, q.ja);
    // A verb's forms; a noun spelled like one ("a cut") has none.
    const pos = (wordPos as Record<string, string>)[q.key];
    if (!pos || pos === "verb") {
      const forms = irregularOf(q.en);
      notes.irregular = forms ? [forms] : [];
    }
    return notesAreEmpty(notes) ? null : notes;
  }
  const texts =
    q.kind === "grammar"
      ? [audioText]
      : q.kind === "idiom"
        ? [q.en, ...(q.example ? [q.example] : [])]
        : q.kind === "dialogue"
          ? [...(q.prompt ? [q.prompt] : []), q.en]
          : [q.en];
  const base: WordNotes =
    (q.kind === "idiom" ? wordNotes(q.en) : null) ?? { parts: [], examples: [], usages: [], origin: null, related: [], used: [], irregular: [] };
  const notes = { ...base, used: usedWords(texts), irregular: irregularsIn(texts) };
  return notesAreEmpty(notes) ? null : notes;
}

function buildSessionQuestion(q: Question, mode: Mode, isReview: boolean): SessionQuestion {
  const audioText = audioTextFor(q);
  const base = {
    question: q,
    mode,
    isReview,
    audioText,
    hideText: false,
    grammarNote: grammarNoteFor(q),
    notes: notesFor(q, audioText),
  };
  if (mode === "choice") {
    if (q.choices && q.choices.length) {
      return {
        ...base,
        display: q.prompt ?? q.en,
        subDisplay: q.ja,
        options: shuffle(q.choices),
        optionEn: [],
        answer: q.en,
        accepted: [q.en],
      };
    }
    return {
      ...base,
      display: q.en,
      subDisplay: null,
      ...japaneseOptions(q),
      answer: q.ja,
      accepted: [q.ja],
    };
  }
  if (mode === "typing") {
    // Only typing is graded on free text, so it is the only mode that needs the sibling renderings.
    return {
      ...base,
      display: q.ja,
      subDisplay: q.prompt ?? null,
      options: [],
      optionEn: [],
      answer: q.en,
      accepted: acceptedAnswers(q),
    };
  }
  if (mode === "listening") {
    if (q.kind === "dialogue") {
      const opts = englishDistractors(q);
      if (opts.length < 3) {
        // Genre too small to borrow from: fall back to the replies written in the data.
        for (const c of q.choices ?? []) {
          if (opts.length >= 3) break;
          if (c !== q.en && !opts.includes(c)) opts.push(c);
        }
      }
      return {
        ...base,
        hideText: true,
        display: "",
        subDisplay: q.ja,
        options: shuffle([...opts, q.en]),
        optionEn: [],
        answer: q.en,
        accepted: [q.en],
      };
    }
    return {
      ...base,
      hideText: true,
      display: "",
      subDisplay: null,
      ...japaneseOptions(q),
      answer: q.ja,
      accepted: [q.ja],
    };
  }
  return { ...base, display: q.en, subDisplay: q.ja, options: [], optionEn: [], answer: q.en, accepted: [q.en] };
}

/** Mirrors offers_mode in commands.rs: listening also plays anything recorded for speaking. */
function offersMode(q: Question, mode: Mode): boolean {
  return q.modes.includes(mode) || (mode === "listening" && q.modes.includes("speaking"));
}

/** Mirrors review_mode_for: the mode it was missed in, else choice, else its first mode. */
function reviewModeFor(q: Question, missedIn: Mode | null | undefined): Mode {
  if (missedIn && offersMode(q, missedIn)) return missedIn;
  if (offersMode(q, "choice")) return "choice";
  return q.modes[0] ?? "choice";
}

function getSessionQuestions(mode: SessionMode, tier: string, category: string, count: number): SessionQuestion[] {
  const t = today();
  releaseStaleReviews();
  const isDue = (q: Question) => !!state.history[q.key]?.needsReview && (state.history[q.key].nextDue ?? "9999") <= t;
  const byDue = (a: Question, b: Question) =>
    (state.history[a.key].nextDue ?? "").localeCompare(state.history[b.key].nextDue ?? "");
  if (mode === "review") {
    // Mirrors review_session: every due review, each in the mode it was missed in; nothing fresh.
    const due = questions
      .filter((q) => isDue(q) && (tier === "mixed" || q.tier === tier) && inCategory(q, category))
      .sort(byDue)
      .slice(0, count);
    return shuffle(due.map((q) => buildSessionQuestion(q, reviewModeFor(q, state.history[q.key].reviewMode), true)));
  }
  const hasMode = (q: Question) =>
    mode === "listening" ? q.modes.includes("listening") || q.modes.includes("speaking") : q.modes.includes(mode);
  const fits = (q: Question) =>
    hasMode(q) &&
    (tier === "mixed" || q.tier === tier) &&
    inCategory(q, category);
  const maxReviews = Math.ceil(count * 0.6);
  // A review joins only sessions of the mode it was missed in.
  const due = questions
    .filter((q) => fits(q) && isDue(q) && (!state.history[q.key].reviewMode || state.history[q.key].reviewMode === mode))
    .sort(byDue)
    .slice(0, maxReviews);
  const dueKeys = new Set(due.map((q) => q.key));
  const freshPool = questions.filter((q) => fits(q) && !dueKeys.has(q.key) && !state.history[q.key]?.needsReview);
  const unseen = shuffle(freshPool.filter((q) => !state.history[q.key]));
  const seen = shuffle(freshPool.filter((q) => !!state.history[q.key]));
  const fresh = [...unseen, ...seen].slice(0, Math.max(0, count - due.length));
  return shuffle([
    ...due.map((q) => buildSessionQuestion(q, mode, true)),
    ...fresh.map((q) => buildSessionQuestion(q, mode, false)),
  ]);
}

/** Mirrors commands::mark_studied: the first answer of a day extends the streak or starts one. */
function markStudied(t: string): { firstStudyToday: boolean; newTicket: boolean } {
  const u = state.user;
  if (u.lastStudyDate === t) return { firstStudyToday: false, newTicket: false };
  u.currentStreak = u.lastStudyDate === datePlus(-1) ? u.currentStreak + 1 : 1;
  u.longestStreak = Math.max(u.longestStreak, u.currentStreak);
  u.totalStudyDays += 1;
  u.lastStudyDate = t;
  const newTicket = u.currentStreak % 7 === 0;
  if (newTicket) state.tickets.push({ id: state.nextId++, issuedAt: nowTs(), issuedForStreak: u.currentStreak, usedAt: null });
  return { firstStudyToday: true, newTicket };
}

/* ---------- 試験 (mirrors exam.rs) ---------- */

interface ExamSetSeed {
  id: string;
  part: ExamPart;
  title?: string;
  passage?: string;
  passageJa?: string;
  questions: Array<{ prompt?: string; choices: string[]; answer: string; ja?: string; explanation: string; point?: string }>;
}

const EXAM_LEVELS: ExamLevel[] = ["basic", "toeic600", "toeic800"];
const EXAM_SETS: Record<ExamLevel, ExamSetSeed[]> = {
  basic: examBasic as ExamSetSeed[],
  toeic600: exam600 as ExamSetSeed[],
  toeic800: exam800 as ExamSetSeed[],
};
const EXAM = { size: 30, listening: 6, textSets: 1, reading: 8, passPercent: 70, reviewKcal: 3, reviewSize: 10 };
const EXAM_REWARD: Record<ExamLevel, number> = { basic: 100, toeic600: 150, toeic800: 200 };
/** Mirrors exam::effort: what an exam not passed pays for trying. */
const EXAM_EFFORT: Record<ExamLevel, number> = { basic: 30, toeic600: 40, toeic800: 50 };
const EXAM_LABEL: Record<ExamLevel, string> = { basic: "中学～高校基礎", toeic600: "TOEIC 500〜700点目安", toeic800: "TOEIC 800点目安" };

const examPasses = (correct: number, total: number) => total > 0 && correct * 100 >= total * EXAM.passPercent;

/** Mirrors exam::sentences (in lib/sentences.ts, shared with the exam screen). */
const examSentences = sentences;

/** Mirrors exam::notes_for. */
function examNotes(answer: string, texts: string[]): WordNotes | null {
  const short = answer.trim().split(/\s+/).length <= 3 && !/[.,?]/.test(answer);
  const own = short ? wordNotes(answer) : null;
  const notes: WordNotes = own ?? { parts: [], examples: [], usages: [], origin: null, related: [], used: [], irregular: [] };
  notes.used = usedWords(texts);
  notes.irregular = irregularsIn(texts);
  return notesAreEmpty(notes) ? null : notes;
}

function buildExamQuestion(level: ExamLevel, set: ExamSetSeed, index: number): ExamQuestion {
  const q = set.questions[index];
  const answers = set.questions.map((x) => x.answer);
  let sentence = "";
  let sentenceJa: string | null = null;
  let texts: string[] = [];
  if (set.part === "short") {
    sentence = fillBlank(q.prompt ?? "", q.answer);
    sentenceJa = q.ja ?? null;
    texts = [sentence];
  } else if (set.part === "listening") {
    sentence = q.prompt ?? "";
    sentenceJa = q.ja ?? null;
    texts = [sentence, q.answer];
  } else if (set.part === "text" && /[.?!]$/.test(q.answer)) {
    // A sentence put into the passage is its own sentence.
    sentence = q.answer;
    texts = [sentence];
  } else if (set.part === "text") {
    const own = examSentences(set.passage ?? "").find((s) => s.includes(`[${index + 1}]`)) ?? "";
    sentence = answers.reduce((s, a, i) => s.split(`[${i + 1}]`).join(a), own);
    texts = [sentence];
  } else {
    sentence = q.prompt ?? "";
    sentenceJa = q.ja ?? null;
  }
  return {
    id: `${set.id}-${index + 1}`,
    setId: set.id,
    level,
    part: set.part,
    title: set.title ?? null,
    passage: set.passage ?? null,
    passageJa: set.passageJa ?? null,
    blank: set.part === "text" ? index + 1 : null,
    prompt: q.prompt ?? null,
    promptJa: q.ja ?? null,
    choices: shuffle(q.choices),
    answer: q.answer,
    explanation: q.explanation,
    point: q.point ?? null,
    sentence,
    sentenceJa,
    notes: examNotes(q.answer, texts),
  };
}

const examIndex = (() => {
  const out = new Map<string, [ExamLevel, number, number]>();
  for (const level of EXAM_LEVELS) {
    EXAM_SETS[level].forEach((set, si) => set.questions.forEach((_, qi) => out.set(`${set.id}-${qi + 1}`, [level, si, qi])));
  }
  return out;
})();

function examQuestion(id: string): ExamQuestion | null {
  const at = examIndex.get(id);
  return at ? buildExamQuestion(at[0], EXAM_SETS[at[0]][at[1]], at[2]) : null;
}

/** Mirrors exam::build_exam. */
/** Mirrors exam::fullest: the first of `items` that together come closest to `room` without going over. */
function fullest(items: number[], size: (i: number) => number, room: number): number[] {
  let best: { sum: number; chosen: number[] } = { sum: 0, chosen: [] };
  const search = (at: number, chosen: number[], sum: number) => {
    if (sum > best.sum) best = { sum, chosen: [...chosen] };
    if (best.sum === room) return;
    for (let i = at; i < items.length; i++) {
      if (sum + size(items[i]) > room) continue;
      search(i + 1, [...chosen, items[i]], sum + size(items[i]));
      if (best.sum === room) return;
    }
  };
  search(0, [], 0);
  return best.chosen;
}

/**
 * Mirrors exam::build_exam_from: each part takes the sets not asked yet, then those asked the
 * fewest times, then of those the ones asked longest ago.
 */
function buildExam(level: ExamLevel): ExamQuestion[] {
  const list = EXAM_SETS[level];
  if (!list) throw new Error(`unknown exam level ${level}`);
  const history = (i: number): ExamSeen => state.examSeen[list[i].id] ?? { count: 0, at: "" };
  const ofPart = (part: ExamPart) =>
    shuffle(list.map((s, i) => [s, i] as const).filter(([s]) => s.part === part).map(([, i]) => i)).sort(
      (a, b) => history(a).count - history(b).count || history(a).at.localeCompare(history(b).at),
    );
  const listening = ofPart("listening").slice(0, EXAM.listening);
  const text = ofPart("text").slice(0, EXAM.textSets);
  const count = (sets: number[]) => sets.reduce((s, i) => s + list[i].questions.length, 0);
  // 読解: the passages not asked yet that come closest to 8, topped up only when they make fewer than 6.
  const readingOrder = ofPart("reading");
  // Mirrors build_exam_from: passages of 3 first (3 + 3 + 2 is their only way to 8), so the 2s last.
  const fresh = readingOrder
    .filter((i) => history(i).count === 0)
    .sort((a, b) => Number(list[a].questions.length % 2 === 0) - Number(list[b].questions.length % 2 === 0));
  const asked = readingOrder.filter((i) => history(i).count > 0);
  const reading = fullest(fresh, (i) => list[i].questions.length, EXAM.reading);
  if (count(reading) < EXAM.reading - 2) reading.push(...fullest(asked, (i) => list[i].questions.length, EXAM.reading - count(reading)));
  const readingCount = count(reading);
  const short = ofPart("short").slice(0, Math.max(0, EXAM.size - count(listening) - count(text) - readingCount));
  return [listening, short, text, reading].flatMap((group) =>
    group.flatMap((si) => list[si].questions.map((_, qi) => buildExamQuestion(level, list[si], qi))),
  );
}

/** Mirrors exam::set_ids: the sets of the exam questions `answers`. */
function examSetIds(answers: ExamAnswer[]): Set<string> {
  return new Set(answers.map((a) => examQuestion(a.id)?.setId).filter((id): id is string => !!id));
}

/** Mirrors exam::counted_sets: the sets the exam of `level` under way has counted already. */
function countedExamSets(level: ExamLevel, answers: ExamAnswer[]): Set<string> {
  const kept = state.examProgress[level];
  if (!kept || !answers.every((a) => kept.questionIds.includes(a.id))) return new Set();
  return examSetIds(kept.answers);
}

/** Mirrors exam::mark_seen: the sets of the questions answered were asked now, counted once an exam. */
function markExamSeen(answers: ExamAnswer[], counted: Set<string>) {
  const now = nowTs();
  for (const id of examSetIds(answers)) {
    const was = state.examSeen[id] ?? { count: 0, at: now };
    state.examSeen[id] = { count: was.count + (counted.has(id) ? 0 : 1), at: now };
  }
}

/** Mirrors exam::finish. */
function finishExam(level: ExamLevel, answers: ExamAnswer[]): ExamResult {
  if (!EXAM_LEVELS.includes(level)) throw new Error(`unknown exam level ${level}`);
  // Mirrors exam::finish: an exam is handed in whole, every question once, all of its level.
  if (answers.length !== EXAM.size) throw new Error(`${EXAM.size}問すべてに答えてから提出してください`);
  if (new Set(answers.map((a) => a.id)).size !== answers.length) throw new Error("同じ問題の答えが2つあります");
  const graded = answers.map((a) => {
    const q = examQuestion(a.id);
    if (!q) throw new Error(`unknown exam question ${a.id}`);
    if (q.level !== level) throw new Error(`exam question ${a.id} is not of ${level}`);
    return { id: a.id, level: q.level, part: q.part, ok: q.answer === a.chosen };
  });
  const total = graded.length;
  const correct = graded.filter((g) => g.ok).length;
  const passed = examPasses(correct, total);
  const t = today();
  const now = nowTs();
  // Every exam handed in pays (mirrors exam::finish).
  const kcal = passed ? EXAM_REWARD[level] : EXAM_EFFORT[level];
  // Every question was asked, its sets counted once for this exam; nothing is left part-way.
  markExamSeen(answers, countedExamSets(level, answers));
  delete state.examProgress[level];
  state.examAttempts.push({ level, date: t, total, correct, passed, kcal, finishedAt: now });
  let reviewAdded = 0;
  for (const g of graded) {
    const m = state.examMistakes[g.id];
    if (g.ok) delete state.examMistakes[g.id];
    else if (m) m.misses += 1;
    else {
      state.examMistakes[g.id] = { level: g.level, addedAt: now, misses: 1 };
      reviewAdded += 1;
    }
  }
  const paid = credit(t, kcal * 8, { source: passed ? "examPass" : "examFail", level });
  const d = daily(t);
  d.answered += total;
  d.correct += correct;
  for (const g of graded) countAnswer(`exam|${g.level}|${g.part}`, g.ok);
  const { newTicket } = markStudied(t);
  save();
  return {
    level,
    correct,
    total,
    passed,
    kcalEarned: paid.whole,
    points: paid.points,
    todayKcal: d.kcalEarned,
    streak: state.user.currentStreak,
    newTicket,
    reviewAdded,
  };
}

/** Mirrors commands::load_breakdown: the 記録's tables, from `earned`, `answerTotals` and `counted`. */
function breakdown(): Breakdown {
  const study = new Map<string, StatCell>();
  const cellOf = (key: string) => {
    const [tier, mode] = key.split("|") as [Tier, Mode];
    const cell = study.get(key) ?? { tier, mode, kcal: 0, answered: 0, correct: 0 };
    study.set(key, cell);
    return cell;
  };
  for (const [key, v] of [...Object.entries(state.answerTotals), ...Object.entries(state.counted).filter(([k]) => !k.startsWith("exam|"))]) {
    const cell = cellOf(key);
    cell.answered += v.answered;
    cell.correct += v.correct;
  }
  const recipe: Breakdown["recipe"] = [];
  const examKcal: ExamKcal[] = [];
  let cheat = { times: 0, kcal: 0 };
  let lexilink = { times: 0, kcal: 0 };
  for (const [key, v] of Object.entries(state.earned)) {
    const [what, a, b, c] = key.split("|");
    if (what === "study") cellOf(`${a}|${b}`).kcal += v.kcal;
    else if (what === "recipe") recipe.push({ mode: a as Mode, kcal: v.kcal });
    else if (what === "exam")
      examKcal.push({ level: a as ExamLevel, kind: b as ExamKcalKind, each: Number(c) / 8, times: v.times, kcal: v.kcal });
    else if (what === "cheat") cheat = { times: v.times, kcal: v.kcal };
    else if (what === "lexilink") lexilink = { times: v.times, kcal: v.kcal };
  }
  const exams: ExamCell[] = Object.entries(state.counted)
    .filter(([k]) => k.startsWith("exam|"))
    .map(([k, v]) => {
      const [, level, part] = k.split("|") as [string, ExamLevel, ExamPart];
      return { level, part, answered: v.answered, correct: v.correct };
    });
  return {
    study: [...study.values()].sort((a, b) => a.tier.localeCompare(b.tier) || a.mode.localeCompare(b.mode)),
    recipe: recipe.sort((a, b) => a.mode.localeCompare(b.mode)),
    levels: EXAM_LEVELS.map((level) => ({ level, label: EXAM_LABEL[level] })),
    exams,
    examKcal: examKcal.sort((a, b) => a.level.localeCompare(b.level) || a.kind.localeCompare(b.kind) || b.each - a.each),
    cheat,
    lexilink,
  };
}

/* ---------- LexiLink (mirrors lexilink.rs) ---------- */

const LEXI_PAIRS = 10;
const LEXI_GENRES: LexiGenre[] = ["random", "noun", "verb", "adjective", "adverb"];

/** Mirrors lexilink::told_apart: what a meaning says once its notes in （） are put aside, and the notes. */
function toldApart(meaning: string): [string, string] {
  let said = "";
  let notes = "";
  let depth = 0;
  for (const c of meaning) {
    if (c === "（" || c === "(") {
      depth += 1;
      notes += c;
    } else if (c === "）" || c === ")") {
      depth -= 1;
      notes += c;
    } else if (depth > 0) notes += c;
    else said += c;
  }
  return [said.trim(), notes];
}

/** Mirrors lexilink::alike: two meanings a player could not tell apart. */
function alikeMeanings(a: string, b: string): boolean {
  const [sa, na] = toldApart(a);
  const [sb, nb] = toldApart(b);
  return sa === sb && (na === "" || nb === "" || na === nb);
}

const firstSense = (ja: string) => glossSenses(ja)[0] ?? ja.trim();

/** Mirrors db::shown_meaning: a word's word question's meaning, else its glossary's. */
function shownMeaning(en: string): string | null {
  const key = en.toLowerCase();
  return questions.find((q) => q.kind === "word" && q.en.toLowerCase() === key)?.ja ?? (glossary as Record<string, string>)[key] ?? null;
}

/** Mirrors db::antonym_pairs: every pair antonyms.json writes, once: [word, its sense, opposite, its sense]. */
function antonymPairs(): Array<[string, string | null, string, string | null]> {
  const seen = new Set<string>();
  const out: Array<[string, string | null, string, string | null]> = [];
  for (const word of Object.keys(antonymSeeds).sort()) {
    const seed = antonymSeeds[word];
    const each: Array<[string | null, string, string | null]> =
      typeof seed === "string"
        ? [[null, seed, null]]
        : typeof seed[0] === "string"
          ? [[null, (seed as [string, string])[0], (seed as [string, string])[1]]]
          : (seed as string[][]).filter((e) => e.length >= 2).map((e) => [e[0], e[1], e[2] ?? null] as [string, string, string | null]);
    for (const [sense, opposite, its] of each) {
      const o = opposite.toLowerCase();
      const pair = word < o ? `${word}|${o}` : `${o}|${word}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      out.push([word, sense, opposite, its]);
    }
  }
  return out;
}

/** Mirrors lexilink::learned_words: answered in study, saved to the recipe, the answers of exam questions asked. */
function learnedWords(): Set<string> {
  const out = new Set<string>();
  for (const q of questions) if (q.kind === "word" && state.history[q.key]) out.add(q.en.toLowerCase());
  for (const w of state.recipe) out.add(w.word.trim().toLowerCase());
  for (const level of EXAM_LEVELS)
    for (const set of EXAM_SETS[level]) if (state.examSeen[set.id]) set.questions.forEach((q) => out.add(q.answer.trim().toLowerCase()));
  return out;
}

/** Mirrors lexilink::ordered: shuffled, the learned ones first when asked. */
function lexiOrdered<T>(items: T[], prefer: boolean, learned: (x: T) => boolean): T[] {
  const mixed = shuffle(items);
  return prefer ? [...mixed.filter(learned), ...mixed.filter((x) => !learned(x))] : mixed;
}

/** Mirrors lexilink::deal. */
function dealLexiLink(mode: LexiMode, genre: LexiGenre, prefer: boolean): LexiDeal {
  if (mode !== "match" && mode !== "opposites") throw new Error(`unknown LexiLink mode ${String(mode)}`);
  if (!LEXI_GENRES.includes(genre)) throw new Error(`unknown LexiLink genre ${String(genre)}`);
  const learned = prefer ? learnedWords() : new Set<string>();
  const pairs: LexiPair[] = [];
  if (mode === "match") {
    const words = questions
      .filter((q) => q.kind === "word" && (q.tier === "word" || q.tier === "compound") && (genre === "random" || (wordPos as Record<string, string>)[q.key] === genre))
      .map((q) => [q.en, firstSense(q.ja)] as [string, string]);
    const picked: Array<[string, string]> = [];
    for (const [en, meaning] of lexiOrdered(words, prefer, ([en]) => learned.has(en.toLowerCase()))) {
      if (picked.length === LEXI_PAIRS) break;
      if (!meaning || picked.some(([e, m]) => e.toLowerCase() === en.toLowerCase() || alikeMeanings(m, meaning))) continue;
      picked.push([en, meaning]);
    }
    for (const [en, meaning] of picked)
      pairs.push({ a: { text: en, english: true, word: en, meaning }, b: { text: meaning, english: false, word: en, meaning } });
  } else {
    const all = antonymPairs();
    const oppositeOf = new Map<string, Set<string>>();
    const link = (x: string, y: string) => oppositeOf.set(x, (oppositeOf.get(x) ?? new Set<string>()).add(y));
    for (const [w, , o] of all) {
      link(w.toLowerCase(), o.toLowerCase());
      link(o.toLowerCase(), w.toLowerCase());
    }
    const posOf = (word: string, meaning: string) => recipePoses(word, meaning)[0];
    const cands: Array<[string, string, string, string]> = [];
    for (const [w, ws, o, os] of all) {
      const shown = (word: string) => {
        const m = shownMeaning(word);
        return m ? firstSense(m) : null;
      };
      const wm = ws ?? shown(w);
      const om = os ?? shown(o);
      if (!wm || !om) continue;
      if (genre !== "random" && (posOf(w, wm) !== genre || posOf(o, om) !== genre)) continue;
      cands.push([w, wm, o, om]);
    }
    const picked: Array<[string, string, string, string]> = [];
    const used = new Set<string>();
    const met = ([w, , o]: [string, string, string, string]) => learned.has(w.toLowerCase()) || learned.has(o.toLowerCase());
    for (const pair of lexiOrdered(cands, prefer, met)) {
      if (picked.length === LEXI_PAIRS) break;
      const w = pair[0].toLowerCase();
      const o = pair[2].toLowerCase();
      const crosses = (x: string) => [...(oppositeOf.get(x) ?? [])].some((y) => used.has(y));
      const sameSense = picked.some(([, pm, , qm]) => [pair[1], pair[3]].some((m) => alikeMeanings(m, pm) || alikeMeanings(m, qm)));
      if (used.has(w) || used.has(o) || crosses(w) || crosses(o) || sameSense) continue;
      used.add(w);
      used.add(o);
      picked.push(pair);
    }
    for (const [w, wm, o, om] of picked)
      pairs.push({ a: { text: w, english: true, word: w, meaning: wm }, b: { text: o, english: true, word: o, meaning: om } });
  }
  if (pairs.length < LEXI_PAIRS) throw new Error("このジャンルでは10ペアそろいません");
  return { mode, genre, pairs };
}

/** Mirrors lexilink::solo_kcal. */
function lexiSoloKcal(pairs: number, misses: number, cleared: boolean): number {
  const total = pairs * 3 - Math.max(0, misses - 3) * 1 + (cleared ? 10 : 0);
  return cleared ? total : Math.max(0, total);
}

/** Mirrors lexilink::finish (and commands::credit_flat: as it is, the day not below zero). */
function finishLexiLink(game: LexiFinish): LexiResult {
  if (![1, 2].includes(game.players) || game.pairs < 0 || game.pairs > LEXI_PAIRS || game.misses < 0) throw new Error("LexiLink の結果が正しくありません");
  if (game.cleared && game.pairs !== LEXI_PAIRS) throw new Error("LexiLink の結果が正しくありません（ペアがそろっていません）");
  const kcal = game.players === 1 ? lexiSoloKcal(game.pairs, game.misses, game.cleared) : game.cleared ? 30 : 0;
  const t = today();
  const d = daily(t);
  const added = Math.max(kcal, -d.kcalEarned);
  if (added !== 0) {
    d.kcalEarned += added;
    addEarned("lexilink", added);
  }
  const { newTicket } = markStudied(t);
  save();
  return { kcalEarned: added, todayKcal: d.kcalEarned, streak: state.user.currentStreak, newTicket };
}

/* ---------- お気に入り (mirrors favorite.rs) ---------- */

function setQuestionFavorite(questionId: number, mode: Mode, on: boolean) {
  if (!(["choice", "typing", "speaking", "listening"] as Mode[]).includes(mode)) throw new Error(`unknown mode ${mode}`);
  const q = questions.find((x) => x.id === questionId);
  if (!q) throw new Error(`question ${questionId} not found`);
  const at = state.favorites.findIndex((f) => f.questionKey === q.key && f.mode === mode);
  if (on && at < 0) state.favorites.push({ id: state.nextId++, questionKey: q.key, mode, addedAt: nowTs() });
  if (!on && at >= 0) state.favorites.splice(at, 1);
  save();
}

function setExamFavorite(examId: string, on: boolean) {
  const at = state.favorites.findIndex((f) => f.examId === examId);
  if (on && at < 0) {
    if (!examQuestion(examId)) throw new Error(`unknown exam question ${examId}`);
    state.favorites.push({ id: state.nextId++, examId, addedAt: nowTs() });
  }
  if (!on && at >= 0) state.favorites.splice(at, 1);
  save();
}

function favoriteKeys(): FavoriteKeys {
  const out: FavoriteKeys = { questions: [], exams: [] };
  for (const f of state.favorites) {
    if (f.examId) out.exams.push(f.examId);
    const q = f.questionKey ? questions.find((x) => x.key === f.questionKey) : undefined;
    if (q && f.mode) out.questions.push({ questionId: q.id, mode: f.mode });
  }
  return out;
}

function listFavorites(): Favorite[] {
  const out: Favorite[] = [];
  for (const f of [...state.favorites].reverse()) {
    const base = { id: f.id, addedAt: f.addedAt, lastReviewedAt: f.lastReviewedAt ?? null, paidToday: f.paidOn === today() };
    if (f.examId) {
      const exam = examQuestion(f.examId);
      if (exam) out.push({ ...base, question: null, exam });
      continue;
    }
    const q = questions.find((x) => x.key === f.questionKey);
    if (q && f.mode) out.push({ ...base, question: buildSessionQuestion(q, f.mode, false), exam: null });
  }
  return out;
}

/** Mirrors favorite::KCAL_WORD / KCAL_OTHER: what a favorite answered right pays, once a day. */
const FAVORITE_KCAL_WORD = 1;
const FAVORITE_KCAL_OTHER = 2;

/** Mirrors favorite::review: the time kept, and answered right it pays once a day. */
function reviewFavorite(id: number, correct: boolean): FavoriteReview {
  const f = state.favorites.find((x) => x.id === id);
  if (!f) throw new Error("favorite not found");
  const t = today();
  const exam = f.examId ? examQuestion(f.examId) : null;
  const q = f.questionKey ? questions.find((x) => x.key === f.questionKey) : undefined;
  const what: Earning | null = exam
    ? { source: "favoriteExam", level: exam.level }
    : q && f.mode
      ? { source: "favorite", tier: q.tier, mode: f.mode }
      : null;
  if (!what) throw new Error("the question of the favorite is gone");
  f.lastReviewedAt = nowTs();
  // Counted in 累計回答数 with the question it reviews (mirrors counted_answers).
  const d = daily(t);
  d.answered += 1;
  d.correct += correct ? 1 : 0;
  countAnswer(exam ? `exam|${exam.level}|${exam.part}` : `${q?.tier}|${f.mode}`, correct);
  const paidBefore = correct && f.paidOn === t;
  const out: FavoriteReview = { points: 0, kcalEarned: 0, paidBefore };
  if (correct && !paidBefore) {
    const word = q?.tier === "word";
    const paid = credit(t, (word ? FAVORITE_KCAL_WORD : FAVORITE_KCAL_OTHER) * 8, what);
    f.paidOn = t;
    out.points = paid.points;
    out.kcalEarned = paid.whole;
  }
  save();
  return out;
}

function examReview(): ExamQuestion[] {
  return Object.entries(state.examMistakes)
    .sort(([a, x], [b, y]) => x.addedAt.localeCompare(y.addedAt) || a.localeCompare(b))
    .slice(0, EXAM.reviewSize)
    .map(([id]) => examQuestion(id))
    .filter((q): q is ExamQuestion => q !== null);
}

/** Mirrors exam::answer_review. */
function answerExamReview(id: string, chosen: string): ExamReviewResult {
  const q = examQuestion(id);
  if (!q) throw new Error(`unknown exam question ${id}`);
  const correct = q.answer === chosen;
  const waiting = id in state.examMistakes;
  const kcal = correct && waiting ? EXAM.reviewKcal : 0;
  if (correct) delete state.examMistakes[id];
  else if (waiting) state.examMistakes[id].misses += 1;
  const t = today();
  // A review question is an exam question again, not a new one: it is not counted in 累計回答数.
  const paid = credit(t, kcal * 8, { source: "examReview", level: q.level });
  const d = daily(t);
  markStudied(t);
  save();
  return {
    correct,
    kcalEarned: paid.whole,
    points: paid.points,
    todayKcal: d.kcalEarned,
    remaining: Object.keys(state.examMistakes).length,
  };
}

/** Mirrors exam::save_progress: every answer keeps the exam left part-way. */
function saveExamProgress(level: ExamLevel, questionIds: string[], answers: ExamAnswer[]) {
  if (!EXAM_LEVELS.includes(level)) throw new Error(`unknown exam level ${level}`);
  if (answers.length) {
    markExamSeen(answers, countedExamSets(level, answers));
    state.examProgress[level] = { questionIds, answers, savedAt: nowTs() };
  } else delete state.examProgress[level];
  save();
}

/** Mirrors exam::progress: the exam left part-way, dropped if the bank lost one of its questions. */
function examProgress(level: ExamLevel): ExamProgress | null {
  const kept = state.examProgress[level];
  if (!kept) return null;
  const questions = kept.questionIds.map(examQuestion);
  if (
    !questions.length ||
    !kept.answers.length ||
    questions.some((q) => !q) ||
    kept.answers.some((a) => !kept.questionIds.includes(a.id))
  ) {
    delete state.examProgress[level];
    save();
    return null;
  }
  return { level, questions: questions as ExamQuestion[], answers: kept.answers, savedAt: kept.savedAt };
}

/** Mirrors exam::overview. */
function examOverview(): ExamOverview {
  const mistakes = Object.values(state.examMistakes);
  const levels: ExamLevelInfo[] = EXAM_LEVELS.map((level) => {
    const mine = state.examAttempts.filter((a) => a.level === level);
    const best = mine
      .slice()
      .sort((a, b) => b.correct / b.total - a.correct / a.total || b.finishedAt.localeCompare(a.finishedAt))[0];
    return {
      level,
      label: EXAM_LABEL[level],
      reward: EXAM_REWARD[level],
      effort: EXAM_EFFORT[level],
      attempts: mine.length,
      bestCorrect: best ? best.correct : null,
      bestTotal: best ? best.total : null,
      passedEver: mine.some((a) => a.passed),
      passedToday: mine.some((a) => a.passed && a.date === today()),
      reviewCount: mistakes.filter((m) => m.level === level).length,
      suspended: state.examProgress[level]
        ? { answered: state.examProgress[level].answers.length, total: state.examProgress[level].questionIds.length }
        : null,
    };
  });
  return {
    levels,
    reviewCount: mistakes.length,
    questionCount: EXAM.size,
    passPercent: EXAM.passPercent,
    reviewKcal: EXAM.reviewKcal,
  };
}

function submitAnswer(p: AnswerPayload): AnswerResult {
  const q = questions.find((x) => x.id === p.questionId);
  if (!q) throw new Error(`question ${p.questionId} not found`);
  const t = today();
  const h = state.history[q.key] ?? { level: 0, needsReview: false, nextDue: null, correct: 0, wrong: 0, lastScore: null, lastStudiedAt: "" };
  const isDueReview = h.needsReview && h.nextDue !== null && h.nextDue <= t;
  const lowScore = p.mode === "speaking" && (p.score ?? 100) < CLEAR_SCORE;
  // Mirrors record_answer: a due review is done when answered right (70 or more if spoken).
  const done = p.correct && !lowScore;
  const hints = Math.max(0, p.hintsUsed ?? 0);
  // srs.rs と同じ: 文の記入問題は1語 1 kcal、開示1語ごとに −1。ほかは scored の配点。
  const perWord = scoresPerWord(q.kind, p.mode);
  const s = scoredKind(q.kind, q.tier);
  let kcal = 0;
  if (p.correct) {
    if (perWord) kcal = Math.max(0, answerWordCount(q.en) - hints);
    else kcal = kcalFor(s, p.mode, p.score ?? null);
  } else if (perWord && p.mistakes !== undefined) {
    // srs::per_word_kcal: a slip costs the word it was in, not the whole answer.
    kcal = Math.max(0, answerWordCount(q.en) - hints - Math.max(1, p.mistakes));
  }
  // A review pays ×1.5 when done and nothing until then: it stays in today's review.
  if (isDueReview) kcal = done ? Math.round(kcal * RATES.reviewMultiplier) : 0;
  if (!perWord) kcal = hintPenalty(s, kcal, hints);
  // Mirrors record_answer's count of the review's misses today.
  const missedToday = h.reviewMisses?.date === t ? h.reviewMisses.count : 0;
  let level = h.level;
  let needsReview = false;
  let nextDue: string | null = null;
  if (!p.correct || lowScore) {
    // Mirrors srs::next_state: a missed due review keeps the day it was due (still due today).
    level = 0;
    needsReview = true;
    nextDue = isDueReview ? h.nextDue : datePlus(RETRY_DAYS);
  } else if (h.needsReview) {
    // Done (消化); back 3 days later if it took misses today (one picked, three typed or spoken).
    level = h.level + 1;
    if (missedToday >= missesToReviewAgain(p.mode)) {
      needsReview = true;
      nextDue = datePlus(REVIEW_AGAIN_DAYS);
    }
  }
  state.history[q.key] = {
    level,
    needsReview,
    nextDue,
    correct: h.correct + (p.correct ? 1 : 0),
    wrong: h.wrong + (p.correct ? 0 : 1),
    lastScore: p.score ?? null,
    lastStudiedAt: nowTs(),
    reviewMode: !p.correct || lowScore ? p.mode : (h.reviewMode ?? null),
    reviewMisses: isDueReview && !done ? { date: t, count: missedToday + 1 } : h.reviewMisses,
  };
  const paid = credit(t, kcal * 8, { source: "answer", tier: q.tier, mode: p.mode });
  const d = daily(t);
  d.answered += 1;
  d.correct += p.correct ? 1 : 0;
  // Mirrors answer_log, for the 記録 by tab and mode.
  const cellKey = `${q.tier}|${p.mode}`;
  const cell = state.answerTotals[cellKey] ?? { answered: 0, correct: 0 };
  state.answerTotals[cellKey] = { ...cell, answered: cell.answered + 1, correct: cell.correct + (p.correct ? 1 : 0) };

  const { firstStudyToday, newTicket } = markStudied(t);
  const u = state.user;
  save();
  return {
    kcalEarned: paid.whole,
    points: paid.points,
    fractionPending: paid.pending,
    todayKcal: d.kcalEarned,
    streak: u.currentStreak,
    newTicket,
    firstStudyToday,
    isReview: isDueReview,
    staysToday: isDueReview && !done,
    needsReview,
    nextDue,
  };
}

/** Mirrors diet::diet_kcal_since: what ダイエット機能 paid on a day (課題 and the weight). */
function dietKcalOn(date: string): number {
  return state.taskLog.filter((e) => e.date === date).reduce((n, e) => n + e.calories, 0) + (state.weights[date]?.bonus ?? 0);
}

function getStats(): Stats {
  const days = Object.values(state.daily);
  // Mirrors load_stats: ダイエット機能 off, what it paid is left out of the totals and the chart.
  const diet = state.user.dietMode;
  const dietKcal = {
    tasks: state.taskLog.reduce((n, e) => n + e.calories, 0),
    weight: Object.values(state.weights).reduce((n, w) => n + w.bonus, 0),
  };
  const earnedInAll = days.reduce((s, d) => s + d.kcalEarned, 0);
  const totalKcal = diet ? earnedInAll : Math.max(0, earnedInAll - dietKcal.tasks - dietKcal.weight);
  const totalConsumed = days.reduce((s, d) => s + d.kcalConsumed, 0);
  const totalAnswered = days.reduce((s, d) => s + d.answered, 0);
  const totalCorrect = days.reduce((s, d) => s + d.correct, 0);
  const last14Days: DayPoint[] = [];
  for (let i = -13; i <= 0; i++) {
    const date = datePlus(i);
    const d = state.daily[date];
    // Mirrors the eaten of load_stats: a snack a line, the most kcal first, a ticket's last.
    const eaten = new Map<string, EatenSnack>();
    for (const c of state.consumption.filter((x) => x.date === date)) {
      const withTicket = !!(c.withTicket || c.ticketId);
      const key = `${c.snackIcon}|${c.snackName}|${withTicket}`;
      const e = eaten.get(key) ?? { icon: c.snackIcon, name: c.snackName, count: 0, kcal: 0, withTicket };
      e.count += 1;
      e.kcal += c.calories;
      eaten.set(key, e);
    }
    last14Days.push({
      date,
      kcalEarned: Math.max(0, (d?.kcalEarned ?? 0) - (diet ? 0 : dietKcalOn(date))),
      kcalConsumed: d?.kcalConsumed ?? 0,
      answered: d?.answered ?? 0,
      correct: d?.correct ?? 0,
      eaten: [...eaten.values()].sort(
        (a, b) => Number(a.withTicket) - Number(b.withTicket) || b.kcal - a.kcal || a.name.localeCompare(b.name),
      ),
    });
  }
  const weakQuestions: WeakQuestion[] = Object.entries(state.history)
    .filter(([, h]) => h.needsReview || h.wrong > 0)
    .flatMap(([key, h]) => {
      // A key can outlive its question if a pack is removed; drop those rather than render a hole.
      const question = questions.find((q) => q.key === key);
      if (!question) return [];
      return [{ question, wrongCount: h.wrong, lastScore: h.lastScore, nextDue: h.nextDue }];
    })
    .sort((a, b) => b.wrongCount - a.wrongCount)
    .slice(0, 12);
  return {
    totalStudyDays: state.user.totalStudyDays,
    currentStreak: state.user.currentStreak,
    longestStreak: state.user.longestStreak,
    totalKcal,
    totalConsumed,
    totalAnswered,
    totalCorrect,
    accuracy: totalAnswered ? totalCorrect / totalAnswered : 0,
    last14Days,
    weakQuestions,
    tickets: state.tickets.slice().reverse().slice(0, 20),
    reviewDue: dueCount(),
    reviewPending: Object.values(state.history).filter((h) => h.needsReview).length,
    breakdown: breakdown(),
    dietKcal: diet ? dietKcal : null,
    // Mirrors diet::weights_since: the last two weeks' weights, oldest first.
    weights: Object.entries(state.weights)
      .filter(([date]) => date >= datePlus(-13))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, w]) => weightPoint(date, w)),
    heightCm: state.user.heightCm ?? null,
    weightBonusKcal: WEIGHT_BONUS_KCAL,
  };
}

let dictionaryCache: Dictionary | null = null;

function mockDictionary(): Dictionary {
  if (dictionaryCache) return dictionaryCache;
  const base: Dictionary = { ...(glossary as unknown as Dictionary) };
  // Multi-word vocabulary and idioms go in whole, as phrases; mirrors db::dictionary: every sense
  // a word is asked in, then those only the glossary has.
  const asked = new Map<string, string[]>();
  for (const q of questions) {
    if (q.kind !== "word" && q.kind !== "idiom") continue;
    const key = q.en.toLowerCase();
    const senses = asked.get(key) ?? [];
    for (const s of q.ja.split("、")) if (!senses.includes(s)) senses.push(s);
    asked.set(key, senses);
  }
  // A plain sense a question gives already with a note is not repeated (`sensesBeyond`).
  for (const [key, senses] of asked) {
    if (base[key]) senses.push(...sensesBeyond(senses, base[key]).map(([, s]) => s));
    base[key] = senses.join("、");
  }
  const texts = questions.flatMap((q) => [q.en, q.prompt ?? "", q.example ?? "", ...(q.choices ?? [])]);
  dictionaryCache = expandDictionary(base, texts);
  return dictionaryCache;
}

/* ---------- お菓子作りレシピ (mirrors recipe.rs) ---------- */

/** A recipe word as the mock keeps it; its part of speech is worked out when it is handed out. */
type StoredRecipeWord = Omit<RecipeWord, "pos" | "poses" | "kind" | "misses"> & { kind?: RecipeKind; misses?: number };

/** Mirrors db::words_by_english: each word question's meaning and part of speech, and the idioms. */
const recipeLookup = (() => {
  const words = new Map<string, Array<[string, PartOfSpeech]>>();
  const keys = new Map<string, string[]>();
  /** English → the Japanese of each idiom with it */
  const idioms = new Map<string, string[]>();
  for (const q of questions) {
    const en = q.en.toLowerCase();
    if (q.kind === "word") {
      words.set(en, [...(words.get(en) ?? []), [q.ja, posOf[q.key] ?? posFromGloss(q.ja, q.en)]]);
      keys.set(en, [...(keys.get(en) ?? []), q.key]);
    } else if (q.kind === "idiom") idioms.set(en, [...(idioms.get(en) ?? []), q.ja]);
  }
  return { words, keys, idioms };
})();

/** Mirrors db::senses_beyond: the senses of a glossary entry the questions and idioms do not give already. */
function sensesBeyond(given: string[], gloss: string): Array<[number, string]> {
  const plain = (x: string) => x.replace(/（[^）]*）|\([^)]*\)/g, "").trim();
  const isGiven = (s: string) => given.some((x) => x === s || (!/[（(]/.test(s) && !/[／/。，,]/.test(x) && plain(x) === s));
  return meaningParts(gloss)
    .map((s, i): [number, string] => [i, s])
    .filter(([, s]) => !isGiven(s));
}

/** Mirrors db::added_sense_pos: the part of speech of a sense the glossary adds to a question word's. */
function addedSensePos(key: string, sense: string, index: number, asked: string[]): string {
  const written = (glossaryPosOverrides as Record<string, string | string[]>)[key];
  if (Array.isArray(written) && written[index]) return written[index];
  if (typeof written === "string") return written;
  const shape = posFromGloss(sense, key);
  if (asked.includes(shape)) return shape;
  const plain = sense.replace(/（[^）]*）|\([^)]*\)/g, "").trim();
  if (shape === "verb") return key in verbTypes ? "verb" : asked[0];
  if (shape === "adjective") return /[なの的]$/.test(plain) ? "adjective" : asked[0];
  if (shape === "noun" && asked.includes("adverb")) return "adverb";
  return shape;
}

/** Mirrors db::word_senses: a question word's senses with their parts of speech, its questions' and the glossary's added ones. */
const wordSensesCache = new Map<string, { asked: Array<[string, string]>; added: Array<[string, string]> }>();
function wordSenses(key: string): { asked: Array<[string, string]>; added: Array<[string, string]> } {
  const cached = wordSensesCache.get(key);
  if (cached) return cached;
  const questionsOf = recipeLookup.words.get(key) ?? [];
  const keys = recipeLookup.keys.get(key) ?? [];
  const asked: Array<[string, string]> = [];
  const given: string[] = [];
  questionsOf.forEach(([ja, pos], i) => {
    const each = (sensePos as Record<string, string[]>)[keys[i]];
    if (each) meaningParts(ja).forEach((s, k) => asked.push([each[k], s]));
    else asked.push([pos, ja]);
    given.push(...ja.split("、"));
  });
  for (const ja of recipeLookup.idioms.get(key) ?? []) given.push(...ja.split("、"));
  const gloss = (glossary as Record<string, string>)[key];
  const own = questionsOf.map(([, pos]) => pos as string);
  const added: Array<[string, string]> =
    gloss && own.length ? sensesBeyond(given, gloss).map(([i, s]) => [addedSensePos(key, s, i, own), s]) : [];
  const out = { asked, added };
  wordSensesCache.set(key, out);
  return out;
}

/**
 * Mirrors db::glossary_pos: each sense of each word only the glossary has, with its part of speech
 * as glossary-pos.json writes it or as it looks, a verb's sense a verb when it has a type.
 */
const glossaryPos = (() => {
  const out: Record<string, Array<[PartOfSpeech, string]>> = {};
  const written = glossaryPosOverrides as Record<string, string | string[]>;
  for (const [en, ja] of Object.entries(glossary as Record<string, string>)) {
    const key = en.toLowerCase();
    if (recipeLookup.words.has(key)) continue;
    const typed = key in verbTypes;
    const senses = meaningParts(ja);
    const own = written[key];
    if (Array.isArray(own)) out[key] = senses.map((s, i) => [own[i] as PartOfSpeech, s]);
    else if (own === "none") out[key] = [];
    else
      out[key] = senses.map((s) => {
        const shape = posFromGloss(s, en);
        if (shape === "verb") return [typed ? "verb" : ((own as PartOfSpeech) ?? "noun"), s];
        return [(own as PartOfSpeech) ?? shape, s];
      });
  }
  return out;
})();

/** Mirrors db::POS_PRIORITY. */
const POS_PRIORITY: PartOfSpeech[] = ["verb", "adjective", "noun", "adverb"];

/** Mirrors db::recipe_poses: every part of speech of a saved word, the one it is sorted under first. */
function recipePoses(word: string, meaning: string): RecipePos[] {
  const key = word.trim().toLowerCase();
  // Each sense of the word with its part of speech, as the tags see them.
  const senses: Array<[PartOfSpeech, string]> = [];
  if (recipeLookup.words.has(key)) {
    const { asked, added } = wordSenses(key);
    senses.push(...([...asked, ...added] as Array<[PartOfSpeech, string]>));
  } else if (recipeLookup.idioms.has(key)) return ["idiom"];
  else if (glossaryPos[key]) senses.push(...glossaryPos[key]);
  const type = (verbTypes as Record<string, string | string[][]>)[key];
  if (type && !senses.some(([p]) => p === "verb")) {
    if (typeof type === "string") senses.push(["verb", ""]);
    else for (const [, ja] of type) senses.push(["verb", ja]);
  }
  const isPos = (p: string): p is PartOfSpeech => POS_PRIORITY.includes(p as PartOfSpeech);
  const found = [...new Set(senses.map(([p]) => p).filter(isPos))];
  // The parts of speech of the senses the saved meaning has come first.
  const meant = [
    ...new Set(meaningParts(meaning).map((part) => posOfSense(part, senses, word) ?? posFromGloss(part, word)).filter(isPos)),
  ];
  for (const p of meant) if (!found.includes(p)) found.push(p);
  if (!found.length) found.push(posFromGloss(meaning, word));
  const order = (posOrder as Record<string, string[]>)[key] ?? [];
  const rank = (p: PartOfSpeech) => [
    meant.includes(p) ? 0 : 1,
    order.includes(p) ? order.indexOf(p) : Infinity,
    POS_PRIORITY.indexOf(p),
  ];
  return found.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
}

const withPos = (w: StoredRecipeWord): RecipeWord => ({
  ...w,
  kind: w.kind ?? "word",
  // Words saved before misses, 除外 and ★ existed have none of them.
  misses: w.misses ?? 0,
  excludedAt: w.excludedAt ?? null,
  favoritedAt: w.favoritedAt ?? null,
  // Mirrors recipe::row_to_word: a pattern is sorted as a pattern.
  ...(() => {
    const poses: RecipePos[] = w.kind === "usage" ? ["usage"] : recipePoses(w.word, w.meaning);
    return { pos: poses[0], poses };
  })(),
});

function recipeWord(id: number): StoredRecipeWord {
  const w = state.recipe.find((x) => x.id === id);
  if (!w) throw new Error("その単語はレシピにありません");
  return w;
}

function addRecipeWord(input: RecipeWordInput): RecipeAddResult {
  const word = input.word.trim();
  if (!/\p{L}/u.test(word)) throw new Error("レシピに入れる英単語がありません");
  if ([...word].length > 60) throw new Error("長すぎてレシピに入れられません");
  // Mirrors recipe::example_sentence: a passage without its Japanese keeps the word's sentence only.
  const example = exampleSentence(input.example.trim(), input.exampleJa.trim(), input.form.trim(), word);
  const found = state.recipe.find((w) => w.word.toLowerCase() === word.toLowerCase());
  if (found) {
    // Mirrors recipe::add: a learned or taken-off word goes back into review.
    const status = found.excludedAt ? "unexcluded" : found.masteredAt ? "restored" : "exists";
    found.masteredAt = null;
    found.excludedAt = null;
    if (!found.example && example) {
      found.example = example;
      found.exampleJa = input.exampleJa.trim();
      found.form = input.form.trim();
    }
    save();
    return { status, entry: withPos(found) };
  }
  const entry: StoredRecipeWord = {
    id: state.nextId++,
    word,
    meaning: input.meaning.trim(),
    form: input.form.trim(),
    example,
    exampleJa: input.exampleJa.trim(),
    addedAt: nowTs(),
    reviews: 0,
    lastReviewedAt: null,
    masteredAt: null,
    misses: 0,
    excludedAt: null,
    favoritedAt: null,
    kind: input.kind === "usage" ? "usage" : "word",
  };
  state.recipe.push(entry);
  save();
  return { status: "added", entry: withPos(entry) };
}

export async function mockInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  await new Promise((r) => setTimeout(r, 30));
  const t = today();
  switch (cmd) {
    case "get_dashboard": {
      const settled = settleSavings();
      releaseStaleReviews();
      const categories: CategoryInfo[] = [];
      for (const q of questions) {
        if (!q.category) continue;
        let c = categories.find((x) => x.name === q.category);
        if (!c) {
          c = { name: q.category, total: 0, word: 0, compound: 0, grammar: 0, idiom: 0, phrase: 0, example: 0 };
          categories.push(c);
        }
        c.total += 1;
        c[q.tier] += 1;
      }
      // Mirrors commands::mode_counts: a mode's questions by tab, genre and part of speech.
      const modeCounts = new Map<string, ModeCount>();
      for (const q of questions) {
        const pos = q.kind === "word" ? (posOf[q.key] ?? null) : null;
        const grammarPoint = grammarPointOf(q);
        const id = `${q.tier}|${q.category}|${pos}|${grammarPoint}`;
        let m = modeCounts.get(id);
        if (!m) {
          m = { tier: q.tier, category: q.category, pos, grammarPoint, choice: 0, typing: 0, speaking: 0, listening: 0 };
          modeCounts.set(id, m);
        }
        for (const mode of ["choice", "typing", "speaking", "listening"] as const) if (offersMode(q, mode)) m[mode] += 1;
      }
      const dash: Dashboard = {
        user: { ...state.user },
        today: { ...daily(t) },
        goalSnacks: goalSnacks(),
        eatenToday: [...new Set(state.consumption.filter((c) => c.date === t).map((c) => snackIdOf(c)).filter((id): id is number => id !== null))].sort((a, b) => a - b),
        snacks: counted(state.snacks).sort((a, b) => a.calories - b.calories),
        goalTasks: goalTasks(),
        doneToday: [...new Set(state.taskLog.flatMap((e) => (e.date === t && e.taskId !== null ? [e.taskId] : [])))].sort((a, b) => a - b),
        tasks: listTasks(),
        weightToday: state.weights[t] ? weightPoint(t, state.weights[t]) : null,
        categories,
        partsOfSpeech: (["noun", "verb", "adjective", "adverb"] as PartOfSpeech[]).map((pos) => ({
          pos,
          total: questions.filter((q) => q.tier === "word" && posOf[q.key] === pos).length,
        })),
        modeCounts: [...modeCounts.values()],
        // Mirrors commands::grammar_points: the 文法 tab by 文法項目.
        grammarPoints: POINT_CATEGORIES.map((point) => ({
          point,
          total: questions.filter((q) => q.tier === "grammar" && grammarPointOf(q) === point).length,
        }))
          .filter((p) => p.total > 0),
        dueReviewCount: dueCount(),
        ticketsAvailable: ticketsAvailable(),
        kcalRates: { ...RATES },
        savings: {
          balance: state.savings,
          perTicket: SAVINGS_PER_TICKET,
          snackTickets: state.snackTickets.filter((x) => !x.usedAt).length,
          justSaved: settled.saved,
          justIssued: settled.issued,
          justCarried: settled.carried,
        },
        exam: examOverview(),
      };
      return dash as T;
    }
    case "start_exam":
      return buildExam(args.level as ExamLevel) as T;
    case "finish_exam":
      return finishExam(args.level as ExamLevel, args.answers as ExamAnswer[]) as T;
    case "get_exam_progress":
      return examProgress(args.level as ExamLevel) as T;
    case "save_exam_progress":
      return saveExamProgress(args.level as ExamLevel, args.questionIds as string[], args.answers as ExamAnswer[]) as T;
    case "discard_exam_progress":
      delete state.examProgress[args.level as ExamLevel];
      save();
      return undefined as T;
    case "get_exam_review":
      return examReview() as T;
    case "answer_exam_review":
      return answerExamReview(String(args.id), String(args.chosen)) as T;
    case "get_favorite_keys":
      return favoriteKeys() as T;
    case "set_question_favorite":
      return setQuestionFavorite(Number(args.questionId), args.mode as Mode, Boolean(args.on)) as T;
    case "set_exam_favorite":
      return setExamFavorite(String(args.examId), Boolean(args.on)) as T;
    case "list_favorites":
      return listFavorites() as T;
    case "review_favorite":
      return reviewFavorite(Number(args.id), Boolean(args.correct)) as T;
    case "get_session_questions":
      return getSessionQuestions(args.mode as SessionMode, String(args.tier), String(args.category || "all"), Number(args.count)) as T;
    case "submit_answer":
      return submitAnswer(args.payload as AnswerPayload) as T;
    case "list_snacks":
      return counted(state.snacks).sort((a, b) => a.calories - b.calories) as T;
    case "add_snack": {
      const { name, calories, icon } = checkedItem("お菓子", args, 5000, "🍬");
      const snack: Snack = { id: state.nextId++, name, calories, icon, isBuiltin: false, eatenCount: 0 };
      state.snacks.push(snack);
      save();
      return snack as T;
    }
    case "update_snack": {
      // Mirrors commands::update_snack_in: any snack, the first ones too.
      const snack = state.snacks.find((s) => s.id === Number(args.id));
      if (!snack) throw new Error("snack not found");
      Object.assign(snack, checkedItem("お菓子", args, 5000, "🍬"));
      save();
      return { ...snack } as T;
    }
    case "delete_snack": {
      const id = Number(args.id);
      state.snacks = state.snacks.filter((s) => s.id !== id);
      state.goals = state.goals.filter((g) => g !== id);
      save();
      return undefined as T;
    }
    case "set_goal_snack": {
      const id = Number(args.id);
      if (args.goal) {
        if (!state.snacks.some((s) => s.id === id)) throw new Error("snack not found");
        if (!state.goals.includes(id)) state.goals.push(id);
      } else {
        state.goals = state.goals.filter((g) => g !== id);
      }
      save();
      return goalSnacks() as T;
    }
    case "log_snack_eaten": {
      const snack = state.snacks.find((s) => s.id === Number(args.snackId));
      if (!snack) throw new Error("snack not found");
      state.consumption.unshift({ id: state.nextId++, snackId: snack.id, snackName: snack.name, snackIcon: snack.icon, calories: snack.calories, eatenAt: nowTs(), date: t, withTicket: false });
      daily(t).kcalConsumed += snack.calories;
      save();
      return { ...daily(t) } as T;
    }
    case "log_one_off_snack": {
      // Mirrors commands::log_one_off: spent and logged, but neither in the book nor a goal.
      const { name, calories, icon } = checkedItem("お菓子", args, 5000, "🍬");
      state.consumption.unshift({ id: state.nextId++, snackId: null, snackName: name, snackIcon: icon, calories, eatenAt: nowTs(), date: t, withTicket: false });
      daily(t).kcalConsumed += calories;
      save();
      return { ...daily(t) } as T;
    }
    case "eat_with_ticket": {
      const snack = state.snacks.find((s) => s.id === Number(args.snackId));
      if (!snack) throw new Error("snack not found");
      const ticket = state.snackTickets.find((x) => !x.usedAt);
      if (!ticket) throw new Error("使えるお菓子引換券がありません");
      const id = state.nextId++;
      state.consumption.unshift({ id, snackId: snack.id, snackName: snack.name, snackIcon: snack.icon, calories: snack.calories, eatenAt: nowTs(), date: t, withTicket: true, ticketId: ticket.id });
      ticket.usedAt = nowTs();
      ticket.consumptionId = id;
      save();
      return { ...daily(t) } as T;
    }
    case "get_today_consumption":
      return state.consumption
        .filter((c) => c.date === t)
        .map(({ date: _d, ticketId: _t, snackId: _s, ...rest }) => ({ ...rest, withTicket: rest.withTicket ?? false })) as T;
    case "delete_consumption": {
      const id = Number(args.id);
      const entry = state.consumption.find((c) => c.id === id);
      if (entry) {
        state.consumption = state.consumption.filter((c) => c.id !== id);
        const ticket = entry.ticketId ? state.snackTickets.find((x) => x.id === entry.ticketId) : undefined;
        if (ticket) {
          // Eaten with a ticket: the ticket comes back, the day's kcal were never touched.
          ticket.usedAt = null;
          ticket.consumptionId = null;
        } else {
          const d = daily(entry.date);
          d.kcalConsumed = Math.max(0, d.kcalConsumed - entry.calories);
        }
      }
      save();
      return { ...daily(t) } as T;
    }
    case "redeem_cheat_ticket": {
      const ticket = state.tickets.find((x) => !x.usedAt);
      if (!ticket) throw new Error("使えるチートデイチケットがありません");
      ticket.usedAt = nowTs();
      const paid = credit(t, RATES.cheatDayBonus * 8, { source: "cheat" });
      save();
      return { kcalAdded: paid.whole, todayKcal: daily(t).kcalEarned, ticketsLeft: ticketsAvailable() } as T;
    }
    case "set_play_mode": {
      // Mirrors commands::set_play_mode_in.
      const mode = args.mode as PlayMode;
      if (!PLAY_MODES.includes(mode)) throw new Error(`unknown play mode ${String(args.mode)}`);
      state.user.playMode = mode;
      save();
      return mode as T;
    }
    case "set_diet_mode":
      state.user.dietMode = Boolean(args.on);
      save();
      return state.user.dietMode as T;
    case "list_tasks":
      return listTasks() as T;
    case "add_task": {
      const { name, calories, icon } = checkedItem("課題", args, TASK_MAX_KCAL, DEFAULT_TASK_ICON);
      const task: Task = { id: state.nextId++, name, calories, icon, isBuiltin: false, doneCount: 0 };
      state.tasks.push(task);
      save();
      return task as T;
    }
    case "update_task": {
      const task = state.tasks.find((x) => x.id === Number(args.id));
      if (!task) throw new Error("task not found");
      Object.assign(task, checkedItem("課題", args, TASK_MAX_KCAL, DEFAULT_TASK_ICON));
      save();
      return countedTasks([task])[0] as T;
    }
    case "delete_task": {
      const id = Number(args.id);
      state.tasks = state.tasks.filter((x) => x.id !== id);
      state.goalTasks = state.goalTasks.filter((g) => g !== id);
      save();
      return undefined as T;
    }
    case "set_goal_task": {
      const id = Number(args.id);
      if (args.goal) {
        if (!state.tasks.some((x) => x.id === id)) throw new Error("task not found");
        if (!state.goalTasks.includes(id)) state.goalTasks.push(id);
      } else {
        state.goalTasks = state.goalTasks.filter((g) => g !== id);
      }
      save();
      return goalTasks() as T;
    }
    case "log_task_done": {
      const task = state.tasks.find((x) => x.id === Number(args.taskId));
      if (!task) throw new Error("task not found");
      return earnTask(task.id, task.name, task.icon, task.calories) as T;
    }
    case "log_one_off_task": {
      const { name, calories, icon } = checkedItem("課題", args, TASK_MAX_KCAL, DEFAULT_TASK_ICON);
      return earnTask(null, name, icon, calories) as T;
    }
    case "get_today_tasks":
      return state.taskLog.filter((e) => e.date === t).map(({ date: _d, taskId: _t, ...rest }) => rest) as T;
    case "delete_task_done": {
      // Mirrors diet::delete_done_in: out of the log, and its kcal back from its day.
      const entry = state.taskLog.find((e) => e.id === Number(args.id));
      if (entry) {
        state.taskLog = state.taskLog.filter((e) => e.id !== entry.id);
        const d = daily(entry.date);
        d.kcalEarned = Math.max(0, d.kcalEarned - entry.calories);
        save();
      }
      return { ...daily(t) } as T;
    }
    case "set_height":
      return setHeight(Number(args.heightCm)) as T;
    case "record_weight":
      return recordWeight(Number(args.weightKg)) as T;
    case "get_stats":
      return getStats() as T;
    case "reset_progress": {
      // Like the snacks, the word list and the goals are the learner's own, not learning history
      // (reset_progress in Rust leaves recipe_words and goal_snacks alone too, forgetting only the
      // day each word last paid, which went with the day's kcal).
      const { snacks, recipe, goals, favorites, tasks, goalTasks, weights, nextId } = state;
      const { playMode, dietMode, heightCm } = state.user;
      state = freshState();
      // The 課題 list, its goals and the weights stay, as tasks, goal_tasks and weight_log do in
      // Rust (only task_log goes, with the day's kcal); ids go on from where they were, so nothing
      // kept is given the id of something new.
      // The weights stay, but what they paid went with the days (mirrors weight_log.bonus_kcal = 0).
      const unpaid = Object.fromEntries(Object.entries(weights).map(([d, w]) => [d, { ...w, bonus: 0 }]));
      Object.assign(state, { tasks, goalTasks, weights: unpaid, nextId });
      Object.assign(state.user, { dietMode, heightCm });
      state.snacks = snacks;
      state.recipe = recipe;
      state.goals = goals;
      // お気に入り are the learner's own too (reset_progress leaves favorites alone).
      // What a favorite paid went with the day's kcal (mirrors favorites.paid_on = NULL).
      state.favorites = favorites.map((f) => ({ ...f, paidOn: null }));
      // The play mode is a setting, as users.play_mode is left alone in Rust.
      state.user.playMode = playMode;
      save();
      return undefined as T;
    }
    case "log_debug":
      console.debug("[mock]", args.message);
      return undefined as T;
    case "speech_capabilities":
      return { nativeTts: false, ttsVoices: [], nativeStt: false, sttLanguages: [], sttError: "browser preview" } as T;
    case "get_dictionary":
      return mockDictionary() as T;
    case "get_word_notes": {
      // Mirrors commands::get_word_notes: the word's notes and, for an irregular verb, its forms.
      const word = String(args.word ?? "");
      const notes = wordNotes(word) ?? { parts: [], examples: [], usages: [], origin: null, related: [], used: [], irregular: [] };
      notes.antonym = args.meaning ? antonymOf(word, String(args.meaning)) : null;
      const forms = irregularOf(word);
      notes.irregular = forms ? [forms] : [];
      // A 用法 saved to the recipe brings the 類似表現 of its word that are about it.
      if (!notes.related.length) notes.related = relatedGroupsOfPattern(word);
      return (notesAreEmpty(notes) ? null : notes) as T;
    }
    case "get_pronunciations":
      return pronunciations as T;
    case "get_word_tags": {
      // Mirrors db::word_tags: each word question's and glossary word's part of speech, and the verbs' 自・他.
      const words: WordTags["words"] = {};
      const added: WordTags["added"] = {};
      for (const en of recipeLookup.words.keys()) {
        const senses = wordSenses(en);
        words[en] = senses.asked as WordTags["words"][string];
        if (senses.added.length) added[en] = senses.added as WordTags["added"][string];
      }
      return {
        words,
        added,
        glossary: glossaryPos,
        verbTypes: verbTypes as unknown as WordTags["verbTypes"],
        cues: relatedCues(),
        homonyms: homonymGroups as WordTags["homonyms"],
      } as T;
    }
    case "get_idioms": {
      // Mirrors db::idiom_keys: idioms, minus any English that is also a vocabulary item.
      const words = new Set(questions.filter((q) => q.kind === "word").map((q) => q.en.toLowerCase()));
      const idioms = questions.filter((q) => q.kind === "idiom").map((q) => q.en.toLowerCase());
      return [...new Set(idioms)].filter((k) => !words.has(k)).sort() as T;
    }
    case "list_recipe_words":
      return state.recipe
        .slice()
        .sort((a, b) => b.addedAt.localeCompare(a.addedAt) || b.id - a.id)
        .map(withPos) as T;
    case "add_recipe_word":
      return addRecipeWord(args.entry as RecipeWordInput) as T;
    case "review_recipe_word": {
      // Mirrors recipe::review and srs::recipe_quarter_kcal: choice 0.5, typing 1 kcal the first
      // time a word is right that day, half after; credit scales it by the play mode and only
      // whole calories reach the budget.
      const full = args.mode === "choice" ? 2 : args.mode === "typing" ? 4 : 0;
      if (!full) throw new Error(`unknown review mode ${String(args.mode)}`);
      const target = String(args.target);
      if (!["all", "favorite", "learning", "mastered", "excluded"].includes(target)) throw new Error(`unknown review target ${target}`);
      const w = recipeWord(Number(args.id));
      const now = nowTs();
      // Mirrors recipe::review: in すべて / 復習 right makes the word learned unless it is starred;
      // wrong puts it back into review from any tab, and is a miss.
      const repeat = state.recipePaid[w.id] === t;
      w.reviews += 1;
      w.lastReviewedAt = now;
      if (args.remembered) {
        state.recipePaid[w.id] = t;
        if ((target === "all" || target === "learning") && !w.favoritedAt) w.masteredAt = w.masteredAt ?? now;
      } else {
        w.misses = (w.misses ?? 0) + 1;
        w.masteredAt = null;
        w.excludedAt = null;
      }
      const quarters = args.remembered ? (repeat ? full / 2 : full) : 0;
      const paid = credit(t, quarters * 2, { source: "recipe", mode: args.mode as Mode });
      save();
      return {
        entry: withPos(w),
        points: paid.points,
        repeat,
        kcalEarned: paid.whole,
        todayKcal: daily(t).kcalEarned,
        fractionPending: paid.pending,
      } as T;
    }
    case "set_recipe_mastered": {
      // Mirrors recipe::set_mastered: learned, the word is no longer starred.
      const w = recipeWord(Number(args.id));
      w.masteredAt = args.mastered ? (w.masteredAt ?? nowTs()) : null;
      if (args.mastered) w.favoritedAt = null;
      w.excludedAt = null;
      save();
      return withPos(w) as T;
    }
    case "set_recipe_favorite": {
      // Mirrors recipe::set_favorite: a starred word is in review.
      const w = recipeWord(Number(args.id));
      if (args.favorite) {
        w.favoritedAt = w.favoritedAt ?? nowTs();
        w.masteredAt = null;
        w.excludedAt = null;
      } else w.favoritedAt = null;
      save();
      return withPos(w) as T;
    }
    case "set_recipe_words_favorite": {
      // Mirrors recipe::set_favorite_all.
      const ids = new Set((args.ids as number[]).map(Number));
      const now = nowTs();
      let changed = 0;
      for (const w of state.recipe) {
        if (!ids.has(w.id)) continue;
        if (args.favorite) {
          w.favoritedAt = w.favoritedAt ?? now;
          w.masteredAt = null;
          w.excludedAt = null;
        } else w.favoritedAt = null;
        changed += 1;
      }
      save();
      return changed as T;
    }
    case "set_recipe_words_mastered": {
      // Mirrors recipe::set_mastered_all.
      const ids = new Set((args.ids as number[]).map(Number));
      const now = nowTs();
      let changed = 0;
      for (const w of state.recipe) {
        if (!ids.has(w.id)) continue;
        w.masteredAt = args.mastered ? (w.masteredAt ?? now) : null;
        if (args.mastered) w.favoritedAt = null;
        w.excludedAt = null;
        changed += 1;
      }
      save();
      return changed as T;
    }
    case "exclude_recipe_words": {
      // Mirrors recipe::exclude.
      const ids = new Set((args.ids as number[]).map(Number));
      const now = nowTs();
      let moved = 0;
      for (const w of state.recipe) {
        if (!ids.has(w.id)) continue;
        w.excludedAt = w.excludedAt ?? now;
        w.favoritedAt = null;
        moved += 1;
      }
      save();
      return moved as T;
    }
    case "deal_lexilink":
      return dealLexiLink(args.mode as LexiMode, args.genre as LexiGenre, Boolean(args.preferLearned)) as T;
    case "finish_lexilink":
      return finishLexiLink(args.game as LexiFinish) as T;
    case "list_backups":
    case "create_backup":
    case "restore_backup":
    case "delete_backup":
    case "open_backup_folder":
      // A backup is a file of the app's database; the browser preview keeps its data in the page.
      throw new Error("ブラウザのプレビューではバックアップできません（アプリでは使えます）");
    case "get_usage_meanings": {
      // Mirrors recipe::usage_meanings: each meaning once, with the first of its patterns.
      const pairs = (wordUsages as WordUsage[]).map((u) => [u.ja, u.pattern] as [string, string]);
      pairs.sort(([a, p], [b, q]) => (a < b ? -1 : a > b ? 1 : p < q ? -1 : p > q ? 1 : 0));
      return pairs.filter(([ja], i) => i === 0 || pairs[i - 1][0] !== ja) as T;
    }
    case "delete_recipe_words": {
      const ids = new Set((args.ids as number[]).map(Number));
      const before = state.recipe.length;
      state.recipe = state.recipe.filter((w) => !ids.has(w.id));
      save();
      return (before - state.recipe.length) as T;
    }
    default:
      throw new Error(`mock backend: unknown command ${cmd}`);
  }
}
