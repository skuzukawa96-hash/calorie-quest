// In-memory stand-in for the Rust backend so the UI can be developed in a normal browser.
// It mirrors the rules in src-tauri/src/srs.rs and commands.rs; the Tauri build never loads it.
import seedJson from "../../src-tauri/data/questions.json";
import words2a from "../../src-tauri/data/words-2a.json";
import words2b from "../../src-tauri/data/words-2b.json";
import words3 from "../../src-tauri/data/words-3.json";
import phrases2 from "../../src-tauri/data/phrases-2.json";
import phrases3 from "../../src-tauri/data/phrases-3.json";
import grammar2 from "../../src-tauri/data/grammar-2.json";
import grammar3 from "../../src-tauri/data/grammar-3.json";
import idioms2 from "../../src-tauri/data/idioms-2.json";
import idioms3 from "../../src-tauri/data/idioms-3.json";
import sentences2 from "../../src-tauri/data/sentences-2.json";
import sentences3 from "../../src-tauri/data/sentences-3.json";
import dialogues from "../../src-tauri/data/listening-dialogues.json";
import dialogues2 from "../../src-tauri/data/listening-dialogues-2.json";
import glossary from "../../src-tauri/data/glossary.json";
import { expandDictionary, type Dictionary } from "./dictionary";
import type {
  AnswerPayload,
  AnswerResult,
  CategoryInfo,
  ConsumptionEntry,
  DailyStats,
  Dashboard,
  DayPoint,
  Level,
  Mode,
  Question,
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
}

interface MockState {
  user: UserInfo;
  history: Record<number, Hist>;
  daily: Record<string, DailyStats>;
  snacks: Snack[];
  consumption: StoredConsumption[];
  tickets: Ticket[];
  nextId: number;
}

const RATES = { low: 5, mid: 10, high: 25, reviewMultiplier: 1.5, cheatDayBonus: 300 };
const INTERVALS = [1, 3, 7, 14, 30];
const STORAGE_KEY = "calorie-quest-mock-v1";

const seedQuestions: SeedQuestion[] = [
  ...(seedJson as unknown as { questions: SeedQuestion[] }).questions,
  ...(words2a as unknown as SeedQuestion[]),
  ...(words2b as unknown as SeedQuestion[]),
  ...(words3 as unknown as SeedQuestion[]),
  ...(phrases2 as unknown as SeedQuestion[]),
  ...(phrases3 as unknown as SeedQuestion[]),
  ...(grammar2 as unknown as SeedQuestion[]),
  ...(grammar3 as unknown as SeedQuestion[]),
  ...(idioms2 as unknown as SeedQuestion[]),
  ...(idioms3 as unknown as SeedQuestion[]),
  ...(sentences2 as unknown as SeedQuestion[]),
  ...(sentences3 as unknown as SeedQuestion[]),
  ...(dialogues as unknown as SeedQuestion[]),
  ...(dialogues2 as unknown as SeedQuestion[]),
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
    nextId: 100,
  };
}

let state: MockState = load();

function load(): MockState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as MockState;
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

function audioTextFor(q: Question): string {
  if (q.kind === "grammar") return (q.prompt ?? q.en).replace(/_{2,}/g, q.en);
  if (q.kind === "dialogue") return q.prompt ?? q.en;
  return q.en;
}

function buildSessionQuestion(q: Question, mode: Mode, isReview: boolean): SessionQuestion {
  const base = { question: q, mode, isReview, audioText: audioTextFor(q), hideText: false };
  if (mode === "choice") {
    if (q.choices && q.choices.length) {
      return { ...base, display: q.prompt ?? q.en, subDisplay: q.ja, options: shuffle(q.choices), answer: q.en };
    }
    return {
      ...base,
      display: q.en,
      subDisplay: null,
      options: shuffle([...japaneseDistractors(q), q.ja]),
      answer: q.ja,
    };
  }
  if (mode === "typing") {
    return { ...base, display: q.ja, subDisplay: q.prompt ?? null, options: [], answer: q.en };
  }
  if (mode === "listening") {
    if (q.kind === "dialogue") {
      return { ...base, hideText: true, display: "", subDisplay: q.ja, options: shuffle(q.choices ?? []), answer: q.en };
    }
    return {
      ...base,
      hideText: true,
      display: "",
      subDisplay: null,
      options: shuffle([...japaneseDistractors(q), q.ja]),
      answer: q.ja,
    };
  }
  return { ...base, display: q.en, subDisplay: q.ja, options: [], answer: q.en };
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
    .filter((q) => fits(q) && state.history[q.id]?.needsReview && (state.history[q.id].nextDue ?? "9999") <= t)
    .sort((a, b) => (state.history[a.id].nextDue ?? "").localeCompare(state.history[b.id].nextDue ?? ""))
    .slice(0, maxReviews);
  const dueIds = new Set(due.map((q) => q.id));
  const freshPool = questions.filter((q) => fits(q) && !dueIds.has(q.id) && !state.history[q.id]?.needsReview);
  const unseen = shuffle(freshPool.filter((q) => !state.history[q.id]));
  const seen = shuffle(freshPool.filter((q) => !!state.history[q.id]));
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
  const h = state.history[q.id] ?? { level: 0, needsReview: false, nextDue: null, correct: 0, wrong: 0, lastScore: null, lastStudiedAt: "" };
  const isDueReview = h.needsReview && h.nextDue !== null && h.nextDue <= t;
  const lowScore = p.mode === "speaking" && (p.score ?? 100) < 70;
  const base = RATES[q.difficulty];
  let kcal = 0;
  if (p.correct) {
    kcal = p.mode === "speaking" ? Math.round((base * Math.min(100, Math.max(0, p.score ?? 100))) / 100) : base;
    if (isDueReview) kcal = Math.round(kcal * RATES.reviewMultiplier);
  }
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
  state.history[q.id] = {
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
    .map(([id, h]) => ({
      question: questions.find((q) => q.id === Number(id))!,
      wrongCount: h.wrong,
      lastScore: h.lastScore,
      nextDue: h.nextDue,
      srsLevel: h.level,
    }))
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
  for (const q of questions) {
    if (q.kind === "word") base[q.en.toLowerCase()] = q.ja;
  }
  const texts = questions.flatMap((q) => [q.en, q.prompt ?? "", q.example ?? "", ...(q.choices ?? [])]);
  dictionaryCache = expandDictionary(base, texts);
  return dictionaryCache;
}

export async function mockInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  await new Promise((r) => setTimeout(r, 30));
  const t = today();
  switch (cmd) {
    case "get_dashboard": {
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
      state.consumption.unshift({ id: state.nextId++, snackName: snack.name, snackIcon: snack.icon, calories: snack.calories, eatenAt: nowTs(), date: t });
      daily(t).kcalConsumed += snack.calories;
      save();
      return { ...daily(t) } as T;
    }
    case "get_today_consumption":
      return state.consumption.filter((c) => c.date === t).map(({ date: _d, ...rest }) => rest) as T;
    case "delete_consumption": {
      const id = Number(args.id);
      const entry = state.consumption.find((c) => c.id === id);
      if (entry) {
        state.consumption = state.consumption.filter((c) => c.id !== id);
        const d = daily(entry.date);
        d.kcalConsumed = Math.max(0, d.kcalConsumed - entry.calories);
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
      const snacks = state.snacks;
      state = freshState();
      state.snacks = snacks;
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
    default:
      throw new Error(`mock backend: unknown command ${cmd}`);
  }
}
