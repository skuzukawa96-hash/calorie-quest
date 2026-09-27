// In-memory stand-in for the Rust backend so the UI can be developed in a normal browser.
// It mirrors the rules in src-tauri/src/srs.rs and commands.rs; the Tauri build never loads it.
import seedJson from "../../src-tauri/data/questions.json";
import glossary from "../../src-tauri/data/glossary.json";
import grammarNotes from "../../src-tauri/data/grammar-notes.json";
import { expandDictionary, type Dictionary } from "./dictionary";
import { answerWordCount, scoresPerWord } from "./scoring";
import type {
  AnswerPayload,
  AnswerResult,
  CategoryInfo,
  ConsumptionEntry,
  DailyStats,
  Dashboard,
  DayPoint,
  GrammarNote,
  Level,
  Mode,
  Question,
  RecipeAddResult,
  RecipeWord,
  RecipeWordInput,
  SessionQuestion,
  Snack,
  Stats,
  Ticket,
  UserInfo,
  WeakQuestion,
} from "../types";

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
}

interface StoredConsumption extends ConsumptionEntry {
  date: string;
  ticketId?: number | null;
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
  recipe: RecipeWord[];
  /** 貯蓄 (mirrors users.savings_kcal) */
  savings: number;
  /** leftover moved to savings per finished day (mirrors daily_stats.saved_kcal) */
  saved: Record<string, number>;
  /** お菓子引換券 */
  snackTickets: SnackTicket[];
  nextId: number;
}

interface SnackTicket {
  id: number;
  issuedAt: string;
  usedAt: string | null;
  consumptionId: number | null;
}

const RATES = { low: 2, mid: 4, high: 10, reviewMultiplier: 1.5, cheatDayBonus: 300 };
const INTERVALS = [1, 3, 7, 14, 30];
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
    .filter(([path]) => !/\/(questions|glossary|grammar-notes)\.json$/.test(path))
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
      goalSnackId: null,
    },
    history: {},
    daily: {},
    snacks: BUILTIN.map(([name, calories, icon], i) => ({ id: i + 1, name, calories, icon, isBuiltin: true })),
    consumption: [],
    tickets: [],
    recipe: [],
    savings: 0,
    saved: {},
    snackTickets: [],
    nextId: 100,
  };
}

let state: MockState = load();

function load(): MockState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      // State saved before the word list or savings existed lacks them. Like the Rust migration,
      // days already over are closed at 0 rather than paid into savings all at once.
      const stored = JSON.parse(raw) as Partial<MockState> & Omit<MockState, "recipe" | "savings" | "saved" | "snackTickets">;
      const closed = Object.fromEntries(Object.keys(stored.daily).filter((d) => d < today()).map((d) => [d, 0]));
      return {
        ...stored,
        recipe: stored.recipe ?? [],
        savings: stored.savings ?? 0,
        saved: stored.saved ?? closed,
        snackTickets: stored.snackTickets ?? [],
      };
    }
  } catch {
    /* ignore */
  }
  return freshState();
}
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

/** Mirrors commands::settle_savings: finished days' leftover → savings, every 2,000 → a ticket. */
const SAVINGS_PER_TICKET = 2000;
function settleSavings(): { saved: number; issued: number } {
  const t = today();
  let saved = 0;
  for (const [date, d] of Object.entries(state.daily)) {
    if (date >= t || state.saved[date] !== undefined) continue;
    const leftover = Math.max(0, d.kcalEarned - d.kcalConsumed);
    state.saved[date] = leftover;
    saved += leftover;
  }
  const total = state.savings + saved;
  const issued = Math.floor(total / SAVINGS_PER_TICKET);
  state.savings = total % SAVINGS_PER_TICKET;
  for (let i = 0; i < issued; i++) state.snackTickets.push({ id: state.nextId++, issuedAt: nowTs(), usedAt: null, consumptionId: null });
  if (saved > 0 || issued > 0) save();
  return { saved, issued };
}

function daily(date: string): DailyStats {
  if (!state.daily[date]) {
    state.daily[date] = { date, kcalEarned: 0, kcalConsumed: 0, answered: 0, correct: 0 };
  }
  return state.daily[date];
}
function dueCount(): number {
  const t = today();
  return Object.values(state.history).filter((h) => h.needsReview && h.nextDue !== null && h.nextDue <= t).length;
}
function ticketsAvailable(): number {
  return state.tickets.filter((t) => !t.usedAt).length;
}

/** Three wrong translations from the tightest semantic circle available; mirrors the Rust side. */
function japaneseDistractors(q: Question): string[] {
  const out: string[] = [];
  const pools = [
    questions.filter((o) => o.id !== q.id && o.kind === q.kind && o.group === q.group && o.ja !== q.ja),
    questions.filter((o) => o.id !== q.id && o.kind === q.kind && o.category === q.category && o.ja !== q.ja),
    questions.filter((o) => o.id !== q.id && o.kind === q.kind && o.ja !== q.ja),
    questions.filter((o) => o.id !== q.id && o.ja !== q.ja),
  ];
  for (const pool of pools) {
    for (const o of shuffle(pool)) {
      if (out.length >= 3) break;
      if (!out.includes(o.ja)) out.push(o.ja);
    }
    if (out.length >= 3) break;
  }
  return out;
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
  return note ? { title: note.title, body: note.body, example: note.example } : null;
}

function buildSessionQuestion(q: Question, mode: Mode, isReview: boolean): SessionQuestion {
  const base = {
    question: q,
    mode,
    isReview,
    audioText: audioTextFor(q),
    hideText: false,
    grammarNote: grammarNoteFor(q),
  };
  if (mode === "choice") {
    if (q.choices && q.choices.length) {
      return {
        ...base,
        display: q.prompt ?? q.en,
        subDisplay: q.ja,
        options: shuffle(q.choices),
        answer: q.en,
        accepted: [q.en],
      };
    }
    return {
      ...base,
      display: q.en,
      subDisplay: null,
      options: shuffle([...japaneseDistractors(q), q.ja]),
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
        answer: q.en,
        accepted: [q.en],
      };
    }
    return {
      ...base,
      hideText: true,
      display: "",
      subDisplay: null,
      options: shuffle([...japaneseDistractors(q), q.ja]),
      answer: q.ja,
      accepted: [q.ja],
    };
  }
  return { ...base, display: q.en, subDisplay: q.ja, options: [], answer: q.en, accepted: [q.en] };
}

function getSessionQuestions(mode: Mode, difficulty: string, category: string, count: number): SessionQuestion[] {
  const t = today();
  const hasMode = (q: Question) =>
    mode === "listening" ? q.modes.includes("listening") || q.modes.includes("speaking") : q.modes.includes(mode);
  const fits = (q: Question) =>
    hasMode(q) &&
    (difficulty === "mixed" || q.difficulty === difficulty) &&
    (category === "all" || q.category === category);
  const maxReviews = Math.ceil(count * 0.6);
  const due = questions
    .filter((q) => fits(q) && state.history[q.key]?.needsReview && (state.history[q.key].nextDue ?? "9999") <= t)
    .sort((a, b) => (state.history[a.key].nextDue ?? "").localeCompare(state.history[b.key].nextDue ?? ""))
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

function submitAnswer(p: AnswerPayload): AnswerResult {
  const q = questions.find((x) => x.id === p.questionId);
  if (!q) throw new Error(`question ${p.questionId} not found`);
  const t = today();
  const h = state.history[q.key] ?? { level: 0, needsReview: false, nextDue: null, correct: 0, wrong: 0, lastScore: null, lastStudiedAt: "" };
  const isDueReview = h.needsReview && h.nextDue !== null && h.nextDue <= t;
  const lowScore = p.mode === "speaking" && (p.score ?? 100) < 70;
  const base = RATES[q.difficulty];
  const hints = Math.max(0, p.hintsUsed ?? 0);
  // srs.rs と同じ: フレーズの記入問題は1語 1 kcal、開示1語ごとに −1。ほかは開示1語ごとに半分。
  const perWord = scoresPerWord(q.difficulty, p.mode);
  let kcal = 0;
  if (p.correct) {
    if (perWord) kcal = Math.max(0, answerWordCount(q.en) - hints);
    else kcal = p.mode === "speaking" ? Math.round((base * Math.min(100, Math.max(0, p.score ?? 100))) / 100) : base;
    if (isDueReview) kcal = Math.round(kcal * RATES.reviewMultiplier);
  } else if (perWord && p.mistakes !== undefined) {
    // srs::per_word_kcal: a slip costs the word it was in, not the whole answer.
    kcal = Math.max(0, answerWordCount(q.en) - hints - Math.max(1, p.mistakes));
  }
  if (!perWord) kcal = Math.round(kcal / 2 ** Math.min(30, hints));
  let level = h.level;
  let needsReview = false;
  let nextDue: string | null = null;
  if (!p.correct || lowScore) {
    level = 0;
    needsReview = true;
    nextDue = datePlus(INTERVALS[0]);
  } else if (h.needsReview) {
    level = h.level + 1;
    if (level < INTERVALS.length) {
      needsReview = true;
      nextDue = datePlus(INTERVALS[level]);
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
  };
  const d = daily(t);
  d.kcalEarned += kcal;
  d.answered += 1;
  d.correct += p.correct ? 1 : 0;

  const u = state.user;
  let firstStudyToday = false;
  let newTicket = false;
  if (u.lastStudyDate !== t) {
    firstStudyToday = true;
    u.currentStreak = u.lastStudyDate === datePlus(-1) ? u.currentStreak + 1 : 1;
    u.longestStreak = Math.max(u.longestStreak, u.currentStreak);
    u.totalStudyDays += 1;
    u.lastStudyDate = t;
    if (u.currentStreak % 7 === 0) {
      state.tickets.push({ id: state.nextId++, issuedAt: nowTs(), issuedForStreak: u.currentStreak, usedAt: null });
      newTicket = true;
    }
  }
  save();
  return {
    kcalEarned: kcal,
    todayKcal: d.kcalEarned,
    streak: u.currentStreak,
    newTicket,
    firstStudyToday,
    isReview: isDueReview,
    needsReview,
    nextDue,
  };
}

function getStats(): Stats {
  const days = Object.values(state.daily);
  const totalKcal = days.reduce((s, d) => s + d.kcalEarned, 0);
  const totalAnswered = days.reduce((s, d) => s + d.answered, 0);
  const totalCorrect = days.reduce((s, d) => s + d.correct, 0);
  const last14Days: DayPoint[] = [];
  for (let i = -13; i <= 0; i++) {
    const date = datePlus(i);
    const d = state.daily[date];
    last14Days.push({ date, kcalEarned: d?.kcalEarned ?? 0, answered: d?.answered ?? 0, correct: d?.correct ?? 0 });
  }
  const weakQuestions: WeakQuestion[] = Object.entries(state.history)
    .filter(([, h]) => h.needsReview || h.wrong > 0)
    .flatMap(([key, h]) => {
      // A key can outlive its question if a pack is removed; drop those rather than render a hole.
      const question = questions.find((q) => q.key === key);
      if (!question) return [];
      return [{ question, wrongCount: h.wrong, lastScore: h.lastScore, nextDue: h.nextDue, srsLevel: h.level }];
    })
    .sort((a, b) => b.wrongCount - a.wrongCount)
    .slice(0, 12);
  return {
    totalStudyDays: state.user.totalStudyDays,
    currentStreak: state.user.currentStreak,
    longestStreak: state.user.longestStreak,
    totalKcal,
    totalAnswered,
    totalCorrect,
    accuracy: totalAnswered ? totalCorrect / totalAnswered : 0,
    last14Days,
    weakQuestions,
    tickets: state.tickets.slice().reverse().slice(0, 20),
    reviewDue: dueCount(),
    reviewPending: Object.values(state.history).filter((h) => h.needsReview).length,
  };
}

let dictionaryCache: Dictionary | null = null;

function mockDictionary(): Dictionary {
  if (dictionaryCache) return dictionaryCache;
  const base: Dictionary = { ...(glossary as unknown as Dictionary) };
  // Multi-word vocabulary and idioms go in whole, as phrases; mirrors db::dictionary.
  for (const q of questions) {
    if (q.kind === "word" || q.kind === "idiom") base[q.en.toLowerCase()] = q.ja;
  }
  const texts = questions.flatMap((q) => [q.en, q.prompt ?? "", q.example ?? "", ...(q.choices ?? [])]);
  dictionaryCache = expandDictionary(base, texts);
  return dictionaryCache;
}

/* ---------- お菓子作りレシピ (mirrors recipe.rs) ---------- */

function recipeWord(id: number): RecipeWord {
  const w = state.recipe.find((x) => x.id === id);
  if (!w) throw new Error("その単語はレシピにありません");
  return w;
}

function addRecipeWord(input: RecipeWordInput): RecipeAddResult {
  const word = input.word.trim();
  if (!/\p{L}/u.test(word)) throw new Error("レシピに入れる英単語がありません");
  if ([...word].length > 60) throw new Error("長すぎてレシピに入れられません");
  const example = input.example.trim();
  const found = state.recipe.find((w) => w.word.toLowerCase() === word.toLowerCase());
  if (found) {
    const status = found.masteredAt ? "restored" : "exists";
    found.masteredAt = null;
    if (!found.example && example) {
      found.example = example;
      found.exampleJa = input.exampleJa.trim();
      found.form = input.form.trim();
    }
    save();
    return { status, entry: { ...found } };
  }
  const entry: RecipeWord = {
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
  };
  state.recipe.push(entry);
  save();
  return { status: "added", entry: { ...entry } };
}

export async function mockInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  await new Promise((r) => setTimeout(r, 30));
  const t = today();
  switch (cmd) {
    case "get_dashboard": {
      const settled = settleSavings();
      const goal = state.snacks.find((s) => s.id === state.user.goalSnackId) ?? null;
      const categories: CategoryInfo[] = [];
      for (const q of questions) {
        if (!q.category) continue;
        let c = categories.find((x) => x.name === q.category);
        if (!c) {
          c = { name: q.category, total: 0, low: 0, mid: 0, high: 0 };
          categories.push(c);
        }
        c.total += 1;
        c[q.difficulty] += 1;
      }
      const dash: Dashboard = {
        user: { ...state.user },
        today: { ...daily(t) },
        goalSnack: goal,
        snacks: state.snacks.slice().sort((a, b) => a.calories - b.calories),
        categories,
        dueReviewCount: dueCount(),
        ticketsAvailable: ticketsAvailable(),
        kcalRates: { ...RATES },
        savings: {
          balance: state.savings,
          perTicket: SAVINGS_PER_TICKET,
          snackTickets: state.snackTickets.filter((x) => !x.usedAt).length,
          justSaved: settled.saved,
          justIssued: settled.issued,
        },
      };
      return dash as T;
    }
    case "get_session_questions":
      return getSessionQuestions(args.mode as Mode, String(args.difficulty), String(args.category || "all"), Number(args.count)) as T;
    case "submit_answer":
      return submitAnswer(args.payload as AnswerPayload) as T;
    case "list_snacks":
      return state.snacks.slice().sort((a, b) => a.calories - b.calories) as T;
    case "add_snack": {
      const name = String(args.name ?? "").trim();
      const calories = Number(args.calories);
      if (!name) throw new Error("お菓子の名前を入力してください");
      if (!(calories >= 1 && calories <= 5000)) throw new Error("カロリーは1〜5000の範囲で入力してください");
      const snack: Snack = { id: state.nextId++, name, calories, icon: String(args.icon || "🍬"), isBuiltin: false };
      state.snacks.push(snack);
      save();
      return snack as T;
    }
    case "delete_snack": {
      const id = Number(args.id);
      state.snacks = state.snacks.filter((s) => s.id !== id);
      if (state.user.goalSnackId === id) state.user.goalSnackId = null;
      save();
      return undefined as T;
    }
    case "set_goal_snack": {
      const id = args.id === null || args.id === undefined ? null : Number(args.id);
      state.user.goalSnackId = id;
      save();
      return (state.snacks.find((s) => s.id === id) ?? null) as T;
    }
    case "log_snack_eaten": {
      const snack = state.snacks.find((s) => s.id === Number(args.snackId));
      if (!snack) throw new Error("snack not found");
      state.consumption.unshift({ id: state.nextId++, snackName: snack.name, snackIcon: snack.icon, calories: snack.calories, eatenAt: nowTs(), date: t, withTicket: false });
      daily(t).kcalConsumed += snack.calories;
      save();
      return { ...daily(t) } as T;
    }
    case "eat_with_ticket": {
      const snack = state.snacks.find((s) => s.id === Number(args.snackId));
      if (!snack) throw new Error("snack not found");
      const ticket = state.snackTickets.find((x) => !x.usedAt);
      if (!ticket) throw new Error("使えるお菓子引換券がありません");
      const id = state.nextId++;
      state.consumption.unshift({ id, snackName: snack.name, snackIcon: snack.icon, calories: snack.calories, eatenAt: nowTs(), date: t, withTicket: true, ticketId: ticket.id });
      ticket.usedAt = nowTs();
      ticket.consumptionId = id;
      save();
      return { ...daily(t) } as T;
    }
    case "get_today_consumption":
      return state.consumption
        .filter((c) => c.date === t)
        .map(({ date: _d, ticketId: _t, ...rest }) => ({ ...rest, withTicket: rest.withTicket ?? false })) as T;
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
      daily(t).kcalEarned += RATES.cheatDayBonus;
      save();
      return { kcalAdded: RATES.cheatDayBonus, todayKcal: daily(t).kcalEarned, ticketsLeft: ticketsAvailable() } as T;
    }
    case "get_stats":
      return getStats() as T;
    case "reset_progress": {
      // Like the snacks, the word list is the learner's own, not learning history.
      const { snacks, recipe } = state;
      state = freshState();
      state.snacks = snacks;
      state.recipe = recipe;
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
        .map((w) => ({ ...w })) as T;
    case "add_recipe_word":
      return addRecipeWord(args.entry as RecipeWordInput) as T;
    case "review_recipe_word": {
      const w = recipeWord(Number(args.id));
      const now = nowTs();
      w.reviews += 1;
      w.lastReviewedAt = now;
      w.masteredAt = args.remembered ? now : null;
      save();
      return { ...w } as T;
    }
    case "set_recipe_mastered": {
      const w = recipeWord(Number(args.id));
      w.masteredAt = args.mastered ? (w.masteredAt ?? nowTs()) : null;
      save();
      return { ...w } as T;
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
