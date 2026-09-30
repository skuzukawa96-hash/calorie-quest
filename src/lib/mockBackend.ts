// In-memory stand-in for the Rust backend so the UI can be developed in a normal browser.
// It mirrors the rules in src-tauri/src/srs.rs and commands.rs; the Tauri build never loads it.
import seedJson from "../../src-tauri/data/questions.json";
import glossary from "../../src-tauri/data/glossary.json";
import grammarNotes from "../../src-tauri/data/grammar-notes.json";
import pronunciations from "../../src-tauri/data/pronunciations.json";
import wordPartsList from "../../src-tauri/data/word-parts.json";
import tierOverrides from "../../src-tauri/data/tiers.json";
import wordExamples from "../../src-tauri/data/word-examples.json";
import wordUsages from "../../src-tauri/data/word-usage.json";
import idiomOrigins from "../../src-tauri/data/idiom-origins.json";
import wordPos from "../../src-tauri/data/word-pos.json";
import relatedSeeds from "../../src-tauri/data/word-related.json";
import confusableSets from "../../src-tauri/data/word-confusables.json";
import { expandDictionary, lemmas, tokenize, type Dictionary } from "./dictionary";
import { answerWordCount, scoresPerWord } from "./scoring";
import type {
  AnswerPayload,
  AnswerResult,
  CategoryInfo,
  ConsumptionEntry,
  DailyStats,
  Dashboard,
  DayPoint,
  ExampleSentence,
  GrammarNote,
  Level,
  RelatedGroup,
  Mode,
  PartOfSpeech,
  Question,
  RecipeAddResult,
  RecipePos,
  RecipeWord,
  RecipeWordInput,
  SessionMode,
  SessionQuestion,
  Snack,
  Stats,
  Ticket,
  Tier,
  UsedWord,
  UserInfo,
  WeakQuestion,
  WordNotes,
  WordPart,
  WordUsage,
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
  /** the mode it was last missed in, which its review is asked in (learning_history.review_mode) */
  reviewMode?: Mode | null;
}

interface StoredConsumption extends ConsumptionEntry {
  date: string;
  ticketId?: number | null;
  snackId?: number;
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
  /** レシピ復習の 0.5 kcal 単位の点、日ごと（mirrors daily_stats.recipe_half_kcal） */
  recipeHalves: Record<string, number>;
  /** the day each recipe word last paid (mirrors recipe_words.paid_on) */
  recipePaid: Record<number, string>;
  nextId: number;
}

interface SnackTicket {
  id: number;
  issuedAt: string;
  usedAt: string | null;
  consumptionId: number | null;
}

const RATES = { low: 2, mid: 4, high: 10, choice: 4, idiomTyping: 6, reviewMultiplier: 1.5, cheatDayBonus: 300 };

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
const INTERVALS = [1, 3, 7, 14, 30];

/** Mirrors db::word_pos: a one-word word question's part of speech, by key. */
const posOf = wordPos as Record<string, PartOfSpeech>;

/** Mirrors the category clause of session_questions: a genre, "pos:noun" …, or "all". */
function inCategory(q: Question, category: string): boolean {
  return category === "all" || q.category === category || `pos:${posOf[q.key]}` === category;
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
        !/\/(questions|glossary|grammar-notes|pronunciations|word-parts|tiers|word-examples|word-usage|idiom-origins|word-related|word-pos|word-confusables)\.json$/.test(
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
    recipeHalves: {},
    recipePaid: {},
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
      const stored = JSON.parse(raw) as Partial<MockState> & Omit<MockState, "recipe" | "savings" | "saved" | "snackTickets" | "goals" | "recipeHalves" | "recipePaid">;
      const closed = Object.fromEntries(Object.keys(stored.daily).filter((d) => d < today()).map((d) => [d, 0]));
      return {
        ...stored,
        recipe: stored.recipe ?? [],
        savings: stored.savings ?? 0,
        saved: stored.saved ?? closed,
        snackTickets: stored.snackTickets ?? [],
        // The single goal of earlier versions becomes the first entry of the list.
        goals: stored.goals ?? legacyGoal(stored.user),
        recipeHalves: stored.recipeHalves ?? {},
        recipePaid: stored.recipePaid ?? {},
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

/** Log entries keep the snack's id; older mock entries only have its name. */
function snackIdOf(c: StoredConsumption): number | null {
  return c.snackId ?? state.snacks.find((s) => s.name === c.snackName && s.icon === c.snackIcon)?.id ?? null;
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
  const kanji = (s: string) => new Set([...s].filter((c) => /[\u4e00-\u9fff]/.test(c) && !"的性化".includes(c)));
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

/** Mirrors commands::word_distractors: wrong meanings of the same part of speech. */
function wordDistractors(q: Question): string[] | null {
  const pos = posOf[q.key];
  if (!pos) return null;
  const candidates = shuffle(questions.filter((o) => o.kind === "word" && posOf[o.key] === pos && o.id !== q.id && o.ja !== q.ja));
  const confused = confusables.get(q.en.toLowerCase()) ?? [];
  const near = relatedWords(q.en.toLowerCase()).filter((w) => !confused.includes(w));
  const otherSenses = questions
    .filter((o) => o.kind === "word" && o.id !== q.id && o.en.toLowerCase() === q.en.toLowerCase())
    .map((o) => o.ja);
  const picked: string[] = [];
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
        picked.some((p) => shareASense(p, c.ja)) ||
        (!checked && meaningsClose(c.ja, q.ja)) ||
        otherSenses.some((o) => meaningsClose(c.ja, o))
      )
        continue;
      picked.push(c.ja);
      pickedEn.push(c.en.toLowerCase());
    }
  };
  take((c) => confused.includes(c.en.toLowerCase()), true, 2);
  take((c) => spelledAlike(c.en, q.en), false, 2);
  take((c) => c.group === q.group, false, 3);
  take((c) => c.category === q.category, false, 3);
  take((c) => c.tier === q.tier, false, 3);
  take(() => true, false, 3);
  take(() => true, true, 3);
  return picked;
}

/** Three wrong translations from the tightest semantic circle available; mirrors the Rust side. */
function japaneseDistractors(q: Question): string[] {
  if (q.kind === "word") {
    const opts = wordDistractors(q);
    if (opts && opts.length >= 3) return opts;
  }
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

/** Mirrors db::word_parts: a word's prefix, root and suffix, keyed by its English. */
const wordPartsByWord = new Map(
  (wordPartsList as { en: string; parts: WordPart[] }[]).map((w) => [w.en.toLowerCase(), w.parts]),
);

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
  return (relatedSeeds as RelatedSeed[])
    .filter((g) => g.members.some((m) => m.word.toLowerCase() === key))
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
    parts: wordPartsByWord.get(key) ?? [],
    examples: (examplesByWord.get(key) ?? []) as ExampleSentence[],
    usages: usagesOf(key),
    origin: originByIdiom.get(key) ?? null,
    related: relatedGroups(key),
    used: [],
  };
  return notesAreEmpty(notes) ? null : notes;
}

function notesAreEmpty(n: WordNotes): boolean {
  return !n.parts.length && !n.examples.length && !n.usages.length && !n.origin && !n.related.length && !n.used.length;
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
  if (["～", "…", "A", "B", "人", "形容詞", "節"].includes(el)) return { kind: "slot" };
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
  for (const way of plain.split(" / ")) {
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
      const seen = headSeen && afterHead === null ? true : afterHead;
      if (go(i + 1, j, [0, 0], seen, isHead)) return true;
    }
    return false;
  };
  return go(0, null, [0, 0], null, false) ? result : null;
}

/** Mirrors db::used_words: the words of a sentence whose patterns it uses, or that are easily confused. */
function usedWords(texts: string[]): UsedWord[] {
  const out: UsedWord[] = [];
  for (const text of texts) {
    const tokens = tokenize(text);
    const lemmaList = tokens.map(lemmas);
    lemmaList.forEach((candidates, i) => {
      for (const word of candidates) {
        if (out.some((u) => u.word === word)) continue;
        const asWord = readsAs(tokens[i], word) && !(i > 0 && DETERMINERS.includes(tokens[i - 1]));
        const found: [WordUsage, boolean][] = [];
        for (const u of (usagesByWord.get(word) ?? []) as WordUsage[]) {
          const hits = patternWays(u.pattern, word)
            .filter((p) => patternIsTelling(p, word, u.ja))
            .map((p) => piecesFound(p, word, tokens, lemmaList))
            .filter((h): h is boolean => h !== null);
          if (hits.length) found.push([u, hits.includes(true)]);
        }
        const close = found.some(([, c]) => c);
        const usages = found.filter(([, c]) => c || !close).map(([u]) => u);
        const related = relatedGroups(word);
        const onlyRelated =
          !usages.length && asWord && related.length > 0 && !usagesByWord.has(word) && !TOO_COMMON_FOR_RELATED.includes(word);
        if (!usages.length && !onlyRelated) continue;
        const nuance = related.flatMap((g) => g.members).find((m) => m.isSelf)?.nuance ?? null;
        out.push({ word, nuance, usages, related });
        break;
      }
    });
  }
  return out.slice(0, MAX_USED_WORDS);
}

/** Mirrors notes_for in commands.rs. */
function notesFor(q: Question, audioText: string): WordNotes | null {
  if (q.kind === "word") return wordNotes(q.en);
  const texts =
    q.kind === "grammar"
      ? [audioText]
      : q.kind === "idiom"
        ? [q.en, ...(q.example ? [q.example] : [])]
        : q.kind === "dialogue"
          ? [...(q.prompt ? [q.prompt] : []), q.en]
          : [q.en];
  const base: WordNotes =
    (q.kind === "idiom" ? wordNotes(q.en) : null) ?? { parts: [], examples: [], usages: [], origin: null, related: [], used: [] };
  const notes = { ...base, used: usedWords(texts) };
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

function submitAnswer(p: AnswerPayload): AnswerResult {
  const q = questions.find((x) => x.id === p.questionId);
  if (!q) throw new Error(`question ${p.questionId} not found`);
  const t = today();
  const h = state.history[q.key] ?? { level: 0, needsReview: false, nextDue: null, correct: 0, wrong: 0, lastScore: null, lastStudiedAt: "" };
  const isDueReview = h.needsReview && h.nextDue !== null && h.nextDue <= t;
  const lowScore = p.mode === "speaking" && (p.score ?? 100) < 70;
  const base = RATES[q.difficulty];
  const hints = Math.max(0, p.hintsUsed ?? 0);
  // srs.rs と同じ: 文の記入問題は1語 1 kcal、開示1語ごとに −1。ほかは開示1語ごとに半分。
  const perWord = scoresPerWord(q.kind, p.mode);
  let kcal = 0;
  if (p.correct) {
    if (perWord) kcal = Math.max(0, answerWordCount(q.en) - hints);
    else if (p.mode === "speaking") kcal = Math.round((base * Math.min(100, Math.max(0, p.score ?? 100))) / 100);
    // srs::kcal_for: choice pays 4 for anything but a word, an idiom typed 6; the rest by level.
    else if (p.mode === "choice" && q.kind !== "word") kcal = RATES.choice;
    else if (p.mode === "typing" && q.kind === "idiom") kcal = RATES.idiomTyping;
    else kcal = base;
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
    reviewMode: !p.correct || lowScore ? p.mode : (h.reviewMode ?? null),
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
  for (const [key, senses] of asked) {
    for (const s of (base[key] ?? "").split("、")) if (s && !senses.includes(s)) senses.push(s);
    base[key] = senses.join("、");
  }
  const texts = questions.flatMap((q) => [q.en, q.prompt ?? "", q.example ?? "", ...(q.choices ?? [])]);
  dictionaryCache = expandDictionary(base, texts);
  return dictionaryCache;
}

/* ---------- お菓子作りレシピ (mirrors recipe.rs) ---------- */

/** A recipe word as the mock keeps it; its part of speech is worked out when it is handed out. */
type StoredRecipeWord = Omit<RecipeWord, "pos">;

/** Mirrors db::pos_from_gloss: 走る a verb, 美しい an adjective, ゆっくりと an adverb, else a noun. */
function posFromGloss(ja: string): PartOfSpeech {
  const first = (ja.split(/[、，,]/)[0] ?? "").replace(/（[^）]*）|\([^)]*\)/g, "").trim();
  if (/[にと]$/.test(first)) return "adverb";
  if (/[うくぐすつぬぶむる]$/.test(first)) return "verb";
  if (/[いなの的ただてで]$/.test(first)) return "adjective";
  return "noun";
}

/** Mirrors db::words_by_english: each word question's meaning and part of speech, and the idioms. */
const recipeLookup = (() => {
  const words = new Map<string, Array<[string, PartOfSpeech]>>();
  const idioms = new Set<string>();
  for (const q of questions) {
    const en = q.en.toLowerCase();
    if (q.kind === "word") words.set(en, [...(words.get(en) ?? []), [q.ja, posOf[q.key] ?? posFromGloss(q.ja)]]);
    else if (q.kind === "idiom") idioms.add(en);
  }
  return { words, idioms };
})();

/** Mirrors db::recipe_pos. */
function recipePos(word: string, meaning: string): RecipePos {
  const key = word.trim().toLowerCase();
  const senses = recipeLookup.words.get(key);
  if (senses) return (senses.find(([ja]) => ja === meaning) ?? senses[0])[1];
  if (recipeLookup.idioms.has(key)) return "idiom";
  return posFromGloss(meaning);
}

const withPos = (w: StoredRecipeWord): RecipeWord => ({ ...w, pos: recipePos(w.word, w.meaning) });

function recipeWord(id: number): StoredRecipeWord {
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
      const dash: Dashboard = {
        user: { ...state.user },
        today: { ...daily(t) },
        goalSnacks: goalSnacks(),
        eatenToday: [...new Set(state.consumption.filter((c) => c.date === t).map((c) => snackIdOf(c)).filter((id): id is number => id !== null))].sort((a, b) => a - b),
        snacks: counted(state.snacks).sort((a, b) => a.calories - b.calories),
        categories,
        partsOfSpeech: (["noun", "verb", "adjective", "adverb"] as PartOfSpeech[]).map((pos) => ({
          pos,
          total: questions.filter((q) => q.tier === "word" && posOf[q.key] === pos).length,
        })),
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
      return getSessionQuestions(args.mode as SessionMode, String(args.tier), String(args.category || "all"), Number(args.count)) as T;
    case "submit_answer":
      return submitAnswer(args.payload as AnswerPayload) as T;
    case "list_snacks":
      return counted(state.snacks).sort((a, b) => a.calories - b.calories) as T;
    case "add_snack": {
      const name = String(args.name ?? "").trim();
      const calories = Number(args.calories);
      if (!name) throw new Error("お菓子の名前を入力してください");
      if (!(calories >= 1 && calories <= 5000)) throw new Error("カロリーは1〜5000の範囲で入力してください");
      const snack: Snack = { id: state.nextId++, name, calories, icon: String(args.icon || "🍬"), isBuiltin: false, eatenCount: 0 };
      state.snacks.push(snack);
      save();
      return snack as T;
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
      daily(t).kcalEarned += RATES.cheatDayBonus;
      save();
      return { kcalAdded: RATES.cheatDayBonus, todayKcal: daily(t).kcalEarned, ticketsLeft: ticketsAvailable() } as T;
    }
    case "get_stats":
      return getStats() as T;
    case "reset_progress": {
      // Like the snacks, the word list and the goals are the learner's own, not learning history
      // (reset_progress in Rust leaves recipe_words and goal_snacks alone too, forgetting only the
      // day each word last paid, which went with the day's kcal).
      const { snacks, recipe, goals } = state;
      state = freshState();
      state.snacks = snacks;
      state.recipe = recipe;
      state.goals = goals;
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
    case "get_word_notes":
      return wordNotes(String(args.word ?? "")) as T;
    case "get_pronunciations":
      return pronunciations as T;
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
      // Mirrors recipe::review and srs::recipe_half_kcal / recipe_kcal_gain: pay is counted in
      // halves per day (choice 0.5, typing 1 kcal) and only whole calories reach the budget.
      const halves = args.mode === "choice" ? 1 : args.mode === "typing" ? 2 : 0;
      if (!halves) throw new Error(`unknown review mode ${String(args.mode)}`);
      const w = recipeWord(Number(args.id));
      const now = nowTs();
      // A word pays once a day. Right leaves it where it is (the learner marks it learned with
      // 習得 / まだ, which is set_recipe_mastered); wrong puts it back into review.
      const counted = !!args.remembered && state.recipePaid[w.id] !== t;
      w.reviews += 1;
      w.lastReviewedAt = now;
      if (!args.remembered) w.masteredAt = null;
      if (counted) state.recipePaid[w.id] = t;
      const before = state.recipeHalves[t] ?? 0;
      const gained = counted ? halves : 0;
      const kcal = Math.floor((before + gained) / 2) - Math.floor(before / 2);
      state.recipeHalves[t] = before + gained;
      daily(t).kcalEarned += kcal;
      save();
      return { entry: withPos(w), counted, kcalEarned: kcal, todayKcal: daily(t).kcalEarned, halfPending: (before + gained) % 2 === 1 } as T;
    }
    case "set_recipe_mastered": {
      const w = recipeWord(Number(args.id));
      w.masteredAt = args.mastered ? (w.masteredAt ?? nowTs()) : null;
      save();
      return withPos(w) as T;
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
