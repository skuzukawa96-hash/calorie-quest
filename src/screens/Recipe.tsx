import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import GlossedText from "../components/GlossedText";
import { DeleteButton } from "../components/IconButtons";
import PencilIcon from "../components/PencilIcon";
import { PlayModeTag } from "../components/PlayModeSwitch";
import WordNotesPanel from "../components/WordNotes";
import { api } from "../lib/api";
import { loadDictionary, lookup, type Dictionary } from "../lib/dictionary";
import { onRecipeChanged } from "../lib/recipe";
import { formatKcal } from "../lib/scoring";
import { playCrunch, playFanfare, playWrong } from "../lib/sfx";
import { isTtsSupported, speak, stopSpeaking } from "../lib/speech";
import {
  PLAY_MODE_INFO,
  RECIPE_POS,
  RECIPE_POS_LABEL,
  type PlayMode,
  type RecipePos,
  type RecipeReviewMode,
  type RecipeReviewResult,
  type RecipeTab,
  type RecipeWord,
  type WordNotes,
} from "../types";

interface Props {
  /** がんばり / 通常 / お気軽, shown beside what a review earned */
  playMode: PlayMode;
  /** a correct review adds to today's kcal, which the header and home show */
  onProgress: () => void;
  toast: (msg: string) => void;
}

/** すべて (every word not taken off), 復習中, 習得済み, 除外中 (taken off with ×) */
const TAB_LABEL: Record<RecipeTab, string> = { all: "すべて", learning: "復習中", mastered: "習得済み", excluded: "除外中" };
const TABS: RecipeTab[] = ["all", "learning", "mastered", "excluded"];

const NO_MEANING = "（辞書に意味がありません）";

/**
 * What one correct word pays, as shown to the learner (srs::recipe_quarter_kcal): the first time
 * it is right in a day, and every time after that day.
 */
const REVIEW_KCAL: Record<RecipeReviewMode, string> = { choice: "0.5", typing: "1" };
const REPEAT_KCAL: Record<RecipeReviewMode, string> = { choice: "0.25", typing: "0.5" };


const REVIEW_TITLE: Record<RecipeReviewMode, string> = { choice: "選択式", typing: "記入式" };
const REVIEW_ICON: Record<RecipeReviewMode, ReactNode> = { choice: "👆", typing: <PencilIcon /> };

function say(text: string) {
  if (isTtsSupported()) speak(text).catch(() => undefined);
}

function shuffled<T>(items: T[]): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Learned words gone over longest ago come first, as the likeliest to have been forgotten. */
function stalestFirst(words: RecipeWord[]): RecipeWord[] {
  const day = (w: RecipeWord) => (w.lastReviewedAt ?? w.masteredAt ?? w.addedAt).slice(0, 10);
  // Shuffled first, so words of the same day do not always come in the same order.
  return shuffled(words).sort((a, b) => day(a).localeCompare(day(b)));
}

/**
 * The order a review of `tab` asks its words in: learned ones longest unseen first, the rest
 * shuffled. 間違いやすい語を優先 puts the words missed most often first, keeping that order among
 * words missed as often.
 */
function reviewQueue(words: RecipeWord[], tab: RecipeTab, missedFirst: boolean): RecipeWord[] {
  const base = tab === "mastered" ? stalestFirst(words) : shuffled(words);
  return missedFirst ? base.sort((a, b) => b.misses - a.misses) : base;
}

/** 間違いやすい語を優先, as last left. */
const PRIORITY_STORAGE = "cq-recipe-priority";

function loadPriority(): boolean {
  try {
    return localStorage.getItem(PRIORITY_STORAGE) === "on";
  } catch {
    return false;
  }
}

function savePriority(on: boolean) {
  try {
    localStorage.setItem(PRIORITY_STORAGE, on ? "on" : "off");
  } catch {
    /* ignore */
  }
}

/** The form that was right-clicked, when it differs from the headword ("heard" for hear). */
function shownForm(w: RecipeWord): string | null {
  return w.form && w.form.toLowerCase() !== w.word.toLowerCase() ? w.form : null;
}

/* ---------- the list: search, order, parts of speech ---------- */

/** abc順, 追加日順 or 間違い順, one at a time; clicking the one in use turns it around. */
interface Order {
  key: "added" | "abc" | "misses";
  reverse: boolean;
}
/** 品詞順: off, every part of speech in turn (名詞 → 動詞 → 形容詞 → 副詞 → 慣用句), or only one. */
type PosView = "off" | "grouped" | RecipePos;

const ORDERS: Array<{ key: Order["key"]; label: string; dirs: [string, string] }> = [
  { key: "abc", label: "abc順", dirs: ["A→Z", "Z→A"] },
  { key: "added", label: "追加日順", dirs: ["新→古", "古→新"] },
  { key: "misses", label: "間違い順", dirs: ["多→少", "少→多"] },
];
const LIST_STORAGE = "cq-recipe-order";

/** The order and whether it goes by part of speech, as last left; a one-part filter is not kept. */
function loadListView(): { order: Order; grouped: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(LIST_STORAGE) ?? "null");
    if (v && (v.key === "added" || v.key === "abc" || v.key === "misses") && typeof v.reverse === "boolean") {
      return { order: { key: v.key, reverse: v.reverse }, grouped: v.grouped === true };
    }
  } catch {
    /* ignore */
  }
  return { order: { key: "added", reverse: false }, grouped: false };
}

function saveListView(order: Order, grouped: boolean) {
  try {
    localStorage.setItem(LIST_STORAGE, JSON.stringify({ ...order, grouped }));
  } catch {
    /* ignore */
  }
}

const abc = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/**
 * Newest first, A→Z or missed most first (turned around by `reverse`), within the parts of speech
 * when `byPos`. Words missed as often go newest first.
 */
function ordered(words: RecipeWord[], { key, reverse }: Order, byPos: boolean): RecipeWord[] {
  const sign = reverse ? -1 : 1;
  const newest = (a: RecipeWord, b: RecipeWord) => b.addedAt.localeCompare(a.addedAt) || b.id - a.id;
  const within = (a: RecipeWord, b: RecipeWord) =>
    key === "abc" ? abc.compare(a.word, b.word) || a.id - b.id : key === "misses" ? b.misses - a.misses || newest(a, b) : newest(a, b);
  return words
    .slice()
    .sort((a, b) => (byPos ? RECIPE_POS.indexOf(a.pos) - RECIPE_POS.indexOf(b.pos) : 0) || sign * within(a, b));
}

/** The words that begin with what is typed: "bar" finds barely and bare, but not cab or rebar. */
function startingWith(words: RecipeWord[], query: string): RecipeWord[] {
  const q = query.trimStart().toLowerCase();
  return q ? words.filter((w) => w.word.toLowerCase().startsWith(q)) : words;
}

/* ---------- hints shown once a day ---------- */

/**
 * The notes under a right answer that say the same thing every time: how 習得 / まだ work (すべて /
 * 復習中), and
 * that a word right again the same day pays half. Each is shown the first time it comes up in a day.
 */
type Hint = "decide" | "repeat";
const HINT_STORAGE = "cq-recipe-hints";

function localDay(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** True the first time `hint` comes up today, which it also notes; false after that. */
function firstToday(hint: Hint): boolean {
  try {
    const day = localDay();
    const v = JSON.parse(localStorage.getItem(HINT_STORAGE) ?? "null");
    const seen: string[] = v?.day === day && Array.isArray(v.seen) ? v.seen : [];
    if (seen.includes(hint)) return false;
    localStorage.setItem(HINT_STORAGE, JSON.stringify({ day, seen: [...seen, hint] }));
    return true;
  } catch {
    // Nowhere to remember it: better shown every time than never.
    return true;
  }
}

/** "2026-09-30T12:34:56" as 2026-09-30 12:34. */
function stamp(ts: string): string {
  return ts.slice(0, 16).replace("T", " ");
}

/* ---------- 選択: three wrong meanings ---------- */

/** The senses of a gloss, so "聞く" and "聞く、聞こえる" count as the same answer. */
function senses(meaning: string): string[] {
  return meaning
    .split(/[、,，;；/／]/)
    .map((s) => s.replace(/[（(][^）)]*[）)]/g, "").trim())
    .filter(Boolean);
}

const meaningPools = new WeakMap<Dictionary, string[]>();

/** Every distinct gloss in the dictionary (inflected forms repeat their lemma's). */
function dictionaryMeanings(dict: Dictionary): string[] {
  let pool = meaningPools.get(dict);
  if (!pool) {
    pool = [...new Set(Object.values(dict))];
    meaningPools.set(dict, pool);
  }
  return pool;
}

/**
 * The correct meaning plus three that share no sense with it (or with each other), so only one
 * option is right. Two come from the learner's own recipe when it has them, the rest from the
 * dictionary, preferring glosses of a similar length so the answer does not stand out.
 */
function meaningOptions(word: RecipeWord, words: RecipeWord[], dict: Dictionary | null, usagePool: string[]): string[] {
  const picked: string[] = [];
  const taken = new Set(senses(word.meaning));
  const len = word.meaning.length;
  const near = (m: string) => m.length >= Math.floor(len / 2) && m.length <= len * 2 + 2;
  const take = (pool: string[], upTo: number, fits: (m: string) => boolean = () => true) => {
    // Random probes rather than a shuffle: the dictionary pool has thousands of glosses.
    for (let tries = 0; tries < 300 && picked.length < upTo && pool.length > 0; tries++) {
      const m = pool[Math.floor(Math.random() * pool.length)];
      const ss = senses(m);
      if (!m || ss.length === 0 || !fits(m) || ss.some((s) => taken.has(s))) continue;
      picked.push(m);
      ss.forEach((s) => taken.add(s));
    }
  };
  // A pattern's meaning (「AとBを比較する」) is asked against other patterns': among nouns it would
  // stand out.
  if (word.kind === "usage") {
    const ownUsages = words.filter((w) => w.id !== word.id && w.kind === "usage" && w.meaning).map((w) => w.meaning);
    take(ownUsages, 2, near);
    take(usagePool, 3, near);
    take(usagePool, 3);
    return shuffled([...picked, word.meaning]);
  }
  const own = words.filter((w) => w.id !== word.id && w.kind !== "usage" && w.meaning).map((w) => w.meaning);
  take(own, 2, near);
  if (dict) {
    take(dictionaryMeanings(dict), 3, near);
    take(dictionaryMeanings(dict), 3);
  }
  take(own, 3);
  return shuffled([...picked, word.meaning]);
}

/* ---------- 記入: grading and the sentence with a gap ---------- */

function normalizeAnswer(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[.!?,;:"“”]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The saved word or the form it was found in is right, and so is any other English the dictionary
 * glosses exactly the same way ("large" when "big" 大きい was saved).
 */
/**
 * A pattern with what fills it taken out, for typing it back: "compare A with B" → "compare with",
 * "be afraid of ～" → "afraid of". Written in full or without the fillers, it is the same.
 */
function patternCore(text: string): string {
  const bare = text
    .replace(/[（(][^）)]*[）)]/g, " ")
    .replace(/～|~|…|人|原形|形容詞|節|-ing/g, " ")
    .replace(/\b[ABab]\b/g, " ");
  return normalizeAnswer(bare).replace(/^be /, "");
}

function typedRight(word: RecipeWord, typed: string, dict: Dictionary | null): boolean {
  const t = normalizeAnswer(typed);
  if (!t) return false;
  if (word.kind === "usage") {
    const core = patternCore(typed);
    return t === normalizeAnswer(word.word) || (core !== "" && core === patternCore(word.word));
  }
  if ([word.word, word.form].some((w) => w && normalizeAnswer(w) === t)) return true;
  return !!dict && !!word.meaning && (dict[t] ?? lookup(dict, t)) === word.meaning;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The example with the word taken out, or null when the word cannot be found in it. */
function withGap(word: RecipeWord): string | null {
  if (!word.example) return null;
  for (const target of [word.form, word.word]) {
    if (!target.trim()) continue;
    const pattern = `(?<![\\p{L}'])${escapeRegExp(target.trim())}(?![\\p{L}])`;
    if (new RegExp(pattern, "iu").test(word.example)) {
      return word.example.replace(new RegExp(pattern, "giu"), "＿＿＿");
    }
  }
  return null;
}

/**
 * お菓子作りレシピ: the words the learner right-clicked while studying, in four tabs: すべて (every
 * word not taken off), 復習中, 習得済み and 除外中 (taken off with ×; × there deletes for good). They
 * are reviewed by picking the meaning (0.5 kcal) or writing the English (1 kcal), half that for a
 * word right again the same day, from the tab on show: right in すべて / 復習中 makes a word learned
 * (or not, if the learner says まだ), right in 習得済み / 除外中 leaves it there, and wrong anywhere puts
 * it back into review (recipe::review). Every miss is counted, for
 * the 間違い順 order and for 間違いやすい語を優先.
 *
 * The list shows a word and its meaning on one line and opens to its example and dates on a
 * click; it can be narrowed by the start of the word and put in abc or added order, by part of
 * speech or not, or down to one part of speech.
 */
export default function Recipe({ playMode, onProgress, toast }: Props) {
  const [words, setWords] = useState<RecipeWord[] | null>(null);
  const [dict, setDict] = useState<Dictionary | null>(null);
  /** the meanings of every pattern of 用法, the wrong options for a pattern in review */
  const [usagePool, setUsagePool] = useState<string[]>([]);
  const [filter, setFilter] = useState<RecipeTab>("all");
  const [reviewing, setReviewing] = useState<{ target: RecipeTab; mode: RecipeReviewMode; queue: RecipeWord[] } | null>(null);
  const [missedFirst, setMissedFirst] = useState(loadPriority);
  /** each round of review starts from a fresh component */
  const [round, setRound] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<Order>(() => loadListView().order);
  const [posView, setPosView] = useState<PosView>(() => (loadListView().grouped ? "grouped" : "off"));
  const [posMenu, setPosMenu] = useState(false);
  const posBox = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());

  useEffect(() => saveListView(order, posView !== "off"), [order, posView]);
  useEffect(() => savePriority(missedFirst), [missedFirst]);

  // The part-of-speech menu closes on a click elsewhere or Escape.
  useEffect(() => {
    if (!posMenu) return;
    const away = (e: MouseEvent) => {
      if (!posBox.current?.contains(e.target as Node)) setPosMenu(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setPosMenu(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [posMenu]);

  const reload = useCallback(async () => {
    setWords(await api.listRecipeWords());
  }, []);

  useEffect(() => {
    reload().catch((e) => toast(String(e)));
    let alive = true;
    loadDictionary().then((d) => alive && setDict(d));
    api
      .getUsageMeanings()
      .then((p) => alive && setUsagePool(p))
      .catch(() => undefined);
    const off = onRecipeChanged(() => void reload().catch(() => undefined));
    return () => {
      alive = false;
      off();
    };
  }, [reload, toast]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (e) {
      toast(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!words) {
    return (
      <div className="screen">
        <div className="card loading">読み込み中…</div>
      </div>
    );
  }

  const inTab: Record<RecipeTab, RecipeWord[]> = {
    all: words.filter((w) => !w.excludedAt),
    learning: words.filter((w) => !w.excludedAt && !w.masteredAt),
    mastered: words.filter((w) => !w.excludedAt && w.masteredAt),
    excluded: words.filter((w) => w.excludedAt),
  };
  // Both kinds of review ask about the meaning, so a word without one cannot be quizzed.
  const quizzable = (tab: RecipeTab) => inTab[tab].filter((w) => w.meaning);

  if (reviewing) {
    return (
      <div className="screen recipe">
        <RecipeReview
          key={round}
          target={reviewing.target}
          mode={reviewing.mode}
          queue={reviewing.queue}
          words={words}
          dict={dict}
          usagePool={usagePool}
          playMode={playMode}
          onAgain={(left) => {
            setRound((r) => r + 1);
            // Words missed in 習得済み / 除外中 are back in review now; the others are where they were.
            const target = reviewing.target === "mastered" || reviewing.target === "excluded" ? "learning" : reviewing.target;
            setReviewing({ target, mode: reviewing.mode, queue: reviewQueue(left, target, missedFirst) });
          }}
          onDone={() => {
            stopSpeaking();
            setReviewing(null);
            void reload();
          }}
          onProgress={onProgress}
          toast={toast}
        />
      </div>
    );
  }

  const shown = inTab[filter];
  const found = startingWith(shown, query);
  const onlyPos = posView !== "off" && posView !== "grouped" ? posView : null;
  const listed = ordered(onlyPos ? found.filter((w) => w.pos === onlyPos) : found, order, posView === "grouped");
  const posCount = (pos: RecipePos) => found.filter((w) => w.pos === pos).length;

  const chooseOrder = (key: Order["key"]) =>
    setOrder((o) => (o.key === key ? { key, reverse: !o.reverse } : { key, reverse: false }));
  // The first click lines the words up by part of speech; after that it opens the menu.
  const clickPos = () => (posView === "off" ? setPosView("grouped") : setPosMenu((m) => !m));
  const pickPos = (view: PosView) => {
    setPosView(view);
    setPosMenu(false);
  };
  const toggleOpen = (id: number) =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // 一括: opens every word the list shows, or closes them when all are open already.
  const allOpen = listed.length > 0 && listed.every((w) => open.has(w.id));
  const toggleAll = () =>
    setOpen((s) => {
      const next = new Set(s);
      for (const w of listed) {
        if (allOpen) next.delete(w.id);
        else next.add(w.id);
      }
      return next;
    });
  // The review buttons go over the words of the tab on show.
  const pool = quizzable(filter);
  const start = (mode: RecipeReviewMode) => {
    setRound((r) => r + 1);
    setReviewing({ target: filter, mode, queue: reviewQueue(pool, filter, missedFirst) });
  };

  const mastered = inTab.mastered;
  const clearMastered = () =>
    run(async () => {
      const n = await api.excludeRecipeWords(mastered.map((w) => w.id));
      setConfirmClear(false);
      toast(`🧁 習得済みの${n}語を除外中に移しました`);
    });

  return (
    <div className="screen recipe">
      <section className="card">
        <div className="section-head">
          <h2>🧁 お菓子作りレシピ</h2>
          <div className="recipe-counts">
            <span>
              材料 <b>{inTab.all.length}</b>語
            </span>
            <span>
              復習中 <b>{inTab.learning.length}</b>
            </span>
            <span className="positive">
              習得済み <b>{mastered.length}</b>
            </span>
            {inTab.excluded.length > 0 && (
              <span className="negative">
                除外中 <b>{inTab.excluded.length}</b>
              </span>
            )}
          </div>
        </div>
        <p className="muted">
          問題や解説の英単語を<b>右クリック</b>すると、ここに材料として集まります。復習は英単語の意味を4択で選ぶ「選択式」（1語 0.5 kcal）と、日本語から英語を書く「記入式」（1語 1 kcal）の2通り（同じ日に同じ単語を2回目以降に正解すると半分）で、下で選んでいるタブの単語から出題されます。「すべて」「復習中」では、正解したら「習得」（習得済みに）か「まだ」（復習中のまま）を選びます。「習得済み」「除外中」では、正解ならそのまま、間違えると復習中に戻ります。× で外した単語は「除外中」に入り、そこで × を押すと完全に削除されます。獲得したカロリーは今日のおやつ予算に入ります（小数点以下は切り捨て）。
        </p>
        <div className="row recipe-actions">
          <span className="recipe-target">
            {TAB_LABEL[filter]} <b>{pool.length}</b>語
          </span>
          {(["choice", "typing"] as const).map((mode) => (
            <button
              key={mode}
              className={"btn recipe-mode-btn " + mode}
              disabled={busy || pool.length === 0}
              onClick={() => start(mode)}
            >
              {REVIEW_ICON[mode]} {REVIEW_TITLE[mode]}
            </button>
          ))}
          <button
            type="button"
            className={"recipe-priority" + (missedFirst ? " on" : "")}
            aria-pressed={missedFirst}
            title="オンにすると、復習で間違えた回数が多い単語から出題します"
            onClick={() => setMissedFirst((on) => !on)}
          >
            <span className="recipe-priority-switch" aria-hidden="true" />
            間違いやすい語を優先
          </button>
          {filter === "mastered" &&
            mastered.length > 0 &&
            (confirmClear ? (
              <>
                <span>習得済みの{mastered.length}語を除外中に移します。</span>
                <button className="btn btn-danger" disabled={busy} onClick={() => void clearMastered()}>
                  移す
                </button>
                <button className="btn-link" onClick={() => setConfirmClear(false)}>
                  やめる
                </button>
              </>
            ) : (
              <button className="btn-link" disabled={busy} onClick={() => setConfirmClear(true)}>
                習得済みを片付ける
              </button>
            ))}
        </div>
        {inTab[filter].length > pool.length && (
          <p className="muted small">
            辞書に意味のない{inTab[filter].length - pool.length}語は復習に出ません
            {filter === "learning" && "（一覧で単語を開き「✓ 覚えた」を押すと習得済みにできます）"}。
          </p>
        )}
      </section>

      <section className="card">
        {words.length === 0 ? (
          <div className="recipe-empty">
            <div className="recipe-empty-icon">🥣</div>
            <p>まだ材料がありません。</p>
            <p className="muted">学習中に、問題文・正解・完成した文・解説・例文の英単語を右クリックしてみましょう。</p>
          </div>
        ) : (
          <>
            <div className="recipe-toolbar">
              <div className="segmented recipe-filter">
                {TABS.filter((tab) => tab !== "excluded").map((tab) => (
                  <button key={tab} className={filter === tab ? "active" : ""} onClick={() => setFilter(tab)}>
                    {TAB_LABEL[tab]} {inTab[tab].length}
                  </button>
                ))}
              </div>
              {/* 除外中 stands apart from the three, in light red: words taken off the list. */}
              <button
                className={"recipe-excluded-tab" + (filter === "excluded" ? " active" : "")}
                title="× で外した単語。ここで × を押すと完全に削除、「復習に戻す」で復習中に戻ります"
                onClick={() => setFilter("excluded")}
              >
                除外中 {inTab.excluded.length}
              </button>
              <button className="btn-small recipe-open-all" disabled={listed.length === 0} onClick={toggleAll}>
                {allOpen ? "一括で詳細を閉じる" : "一括で詳細を開く"}
              </button>
              <div className="recipe-tools">
                <input
                  type="search"
                  className="recipe-search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && setQuery("")}
                  placeholder="🔍 英単語で検索"
                  aria-label="英単語の先頭で絞り込む"
                  autoComplete="off"
                  spellCheck={false}
                  lang="en"
                />
                <div className="segmented recipe-sort" role="group" aria-label="並び替え">
                  <div className="recipe-pos" ref={posBox}>
                    <button
                      className={posView !== "off" ? "active" : ""}
                      aria-haspopup="menu"
                      aria-expanded={posMenu}
                      title={posView === "off" ? "名詞・動詞・形容詞・副詞・慣用句の順に並べる" : "品詞を選ぶ"}
                      onClick={clickPos}
                    >
                      {onlyPos ? `${RECIPE_POS_LABEL[onlyPos]}のみ` : "品詞順"}
                      {posView !== "off" && <span className="recipe-caret-small"> ▾</span>}
                    </button>
                    {posMenu && (
                      <div className="recipe-pos-menu" role="menu">
                        <button role="menuitemradio" aria-checked={posView === "grouped"} onClick={() => pickPos("grouped")}>
                          <span>すべての品詞</span>
                          <span className="count">{found.length}</span>
                        </button>
                        {RECIPE_POS.map((pos) => (
                          <button key={pos} role="menuitemradio" aria-checked={onlyPos === pos} onClick={() => pickPos(pos)}>
                            <span>{RECIPE_POS_LABEL[pos]}のみ</span>
                            <span className="count">{posCount(pos)}</span>
                          </button>
                        ))}
                        <hr />
                        <button role="menuitem" onClick={() => pickPos("off")}>
                          <span>品詞順をやめる</span>
                        </button>
                      </div>
                    )}
                  </div>
                  {ORDERS.map((o) => (
                    <button
                      key={o.key}
                      className={order.key === o.key ? "active" : ""}
                      title={order.key === o.key ? "もう一度押すと逆順" : `${o.label}（${o.dirs[0]}）`}
                      onClick={() => chooseOrder(o.key)}
                    >
                      {o.label}
                      {order.key === o.key && <span className="recipe-dir">{o.dirs[order.reverse ? 1 : 0]}</span>}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {listed.length === 0 ? (
              <p className="muted">
                {shown.length === 0
                  ? filter === "mastered"
                    ? "習得済みの単語はまだありません。"
                    : filter === "excluded"
                      ? "除外中の単語はありません。単語を開いて × を押すと、ここに入ります。"
                      : filter === "learning"
                        ? "復習中の単語はありません。"
                        : "単語はありません。"
                  : found.length === 0
                    ? `「${query.trim()}」で始まる単語はありません。`
                    : `${RECIPE_POS_LABEL[onlyPos ?? "noun"]}の単語はありません。`}
              </p>
            ) : (
              <ul className="recipe-list">
                {listed.map((w, i) => {
                  const isOpen = open.has(w.id);
                  const heading = posView === "grouped" && (i === 0 || listed[i - 1].pos !== w.pos);
                  return [
                    heading && (
                      <li key={"pos-" + w.pos} className="recipe-group">
                        {RECIPE_POS_LABEL[w.pos]} <span>{posCount(w.pos)}</span>
                      </li>
                    ),
                    <li
                      key={w.id}
                      className={
                        "recipe-item" + (w.excludedAt ? " excluded" : w.masteredAt ? " mastered" : "") + (isOpen ? " open" : "")
                      }
                    >
                      <div
                        className="recipe-item-head"
                        role="button"
                        tabIndex={0}
                        aria-expanded={isOpen}
                        title={isOpen ? "閉じる" : "例文と追加日を見る"}
                        onClick={() => toggleOpen(w.id)}
                        onKeyDown={(e) => {
                          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                            e.preventDefault();
                            toggleOpen(w.id);
                          }
                        }}
                      >
                        <span className="recipe-word">{w.word}</span>
                        {/* A pattern (人 / 原形 / ～) has no voice to read it with. */}
                        {w.kind !== "usage" && (
                          <button
                            className="btn-link speak-btn recipe-speak"
                            onClick={(e) => {
                              e.stopPropagation();
                              say(w.word);
                            }}
                            disabled={!isTtsSupported()}
                            title="読み上げる"
                            aria-label={`${w.word} を読み上げる`}
                          >
                            🔊
                          </button>
                        )}
                        <span className={"recipe-meaning" + (w.meaning ? "" : " muted")}>{w.meaning || NO_MEANING}</span>
                        {/* Sorted by 間違い順, the count the order goes by. */}
                        {order.key === "misses" && w.misses > 0 && (
                          <span className="recipe-misses" title="復習で間違えた回数">
                            間違い {w.misses}回
                          </span>
                        )}
                        {w.masteredAt && !w.excludedAt && (
                          <span className="recipe-check" title="習得済み" aria-label="習得済み">
                            ✓
                          </span>
                        )}
                        <span className="recipe-caret" aria-hidden="true">
                          ▾
                        </span>
                      </div>
                      {isOpen && (
                        <div className="recipe-item-body">
                          {w.example && (
                            <div className="recipe-example">
                              <GlossedText text={w.example} dict={dict} enabled highlight={w.form || w.word} />
                            </div>
                          )}
                          {w.exampleJa && <div className="muted small">{w.exampleJa}</div>}
                          <div className="recipe-item-foot">
                            <span className="muted small">
                              {RECIPE_POS_LABEL[w.pos]}
                              {shownForm(w) && `・「${shownForm(w)}」から登録`}・{stamp(w.addedAt)} に追加
                              {w.reviews > 0 && `・復習 ${w.reviews}回`}
                              {w.misses > 0 && `・間違い ${w.misses}回`}
                              {w.masteredAt && !w.excludedAt && `・${stamp(w.masteredAt)} に習得`}
                              {w.excludedAt && `・${stamp(w.excludedAt)} に除外`}
                            </span>
                            {w.excludedAt ? (
                              <>
                                <button
                                  className="btn-small"
                                  disabled={busy}
                                  onClick={() =>
                                    run(async () => {
                                      await api.setRecipeMastered(w.id, false);
                                      toast(`「${w.word}」を復習中に戻しました`);
                                    })
                                  }
                                >
                                  復習に戻す
                                </button>
                                <DeleteButton
                                  label="レシピから完全に削除"
                                  disabled={busy}
                                  onClick={() =>
                                    run(async () => {
                                      await api.deleteRecipeWords([w.id]);
                                      toast(`「${w.word}」をレシピから削除しました`);
                                    })
                                  }
                                />
                              </>
                            ) : (
                              <>
                                <button
                                  className={"btn-small " + (w.masteredAt ? "" : "eat")}
                                  disabled={busy}
                                  onClick={() =>
                                    run(async () => {
                                      await api.setRecipeMastered(w.id, !w.masteredAt);
                                    })
                                  }
                                >
                                  {w.masteredAt ? "復習に戻す" : "✓ 覚えた"}
                                </button>
                                <DeleteButton
                                  label="レシピから除外"
                                  disabled={busy}
                                  onClick={() =>
                                    run(async () => {
                                      await api.excludeRecipeWords([w.id]);
                                      toast(`「${w.word}」を除外中に移しました`);
                                    })
                                  }
                                />
                              </>
                            )}
                          </div>
                        </div>
                      )}
                    </li>,
                  ];
                })}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
}

/* ---------- review: 選択 / 記入 ---------- */

interface Answered {
  correct: boolean;
  /** the option picked, or what was typed */
  given: string;
  /** what it paid after the play mode, in kcal: full the first time the word is right today, half after */
  points: number;
  /** wrong: whether the word went back into review from 習得済み / 除外中, or was there already */
  movedBack: boolean;
  /** right in すべて / 復習中, and the first time today: explain 習得 / まだ */
  decideHint: boolean;
  /** right again the same day, the first time this happens today: say why it paid half */
  repeatNote: boolean;
}

/** How 習得 / まだ work after a right answer in すべて / 復習中. */
const DECIDE_HINT = "覚えたなら「習得」で習得済みに。なんとなく当たっただけなら「まだ」で復習中に残します。";

/**
 * Whether a right answer in this tab asks 習得 / まだ: only where it would make the word learned
 * (すべて / 復習中). In 習得済み / 除外中 a right answer leaves the word where it is.
 */
const asksDecision = (tab: RecipeTab) => tab === "all" || tab === "learning";

function RecipeReview({
  target,
  mode,
  queue,
  words,
  dict,
  usagePool,
  playMode,
  onAgain,
  onDone,
  onProgress,
  toast,
}: {
  /** the tab the words come from: すべて / 復習中 move right answers to 習得済み and ask 習得 / まだ,
   * 習得済み / 除外中 leave right answers where they are; wrong ones go back to 復習中 from any */
  target: RecipeTab;
  mode: RecipeReviewMode;
  queue: RecipeWord[];
  /** the whole recipe, whose meanings serve as wrong options */
  words: RecipeWord[];
  dict: Dictionary | null;
  usagePool: string[];
  playMode: PlayMode;
  onAgain: (left: RecipeWord[]) => void;
  onDone: () => void;
  onProgress: () => void;
  toast: (msg: string) => void;
}) {
  const [idx, setIdx] = useState(0);
  const [answered, setAnswered] = useState<Answered | null>(null);
  const [typed, setTyped] = useState("");
  const [remembered, setRemembered] = useState<RecipeWord[]>([]);
  const [left, setLeft] = useState<RecipeWord[]>([]);
  const [earned, setEarned] = useState(0);
  const [fractionPending, setFractionPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cleared, setCleared] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const current = queue[idx];
  const finished = idx >= queue.length;
  const decides = asksDecision(target);
  // Drawn once per card: a word saved mid-review reloads the recipe, and that must not reshuffle
  // the options under the learner. Only the dictionary or the patterns' meanings arriving late
  // redraw (the first card).
  const options = useMemo(
    () => (current && mode === "choice" ? meaningOptions(current, words, dict, usagePool) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current, mode, dict === null, usagePool.length === 0],
  );
  const gapped = useMemo(() => (current ? withGap(current) : null), [current]);
  // The same explanation a word question shows under its answer: how the word is built, sentences
  // and patterns using it, an idiom's origin. Fetched with the card, shown once it is answered.
  const [notes, setNotes] = useState<{ word: string; notes: WordNotes | null } | null>(null);
  const word = current?.word;
  useEffect(() => {
    if (!word) return;
    let alive = true;
    api
      .getWordNotes(word)
      .then((n) => alive && setNotes({ word, notes: n }))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [word]);

  useEffect(() => {
    if (!current) return;
    // Writing the English: hearing it first would give the answer away.
    // A pattern (人 / 原形 / ～) is not read aloud.
    if (mode === "choice") {
      if (current.kind !== "usage") say(current.word);
    }
    else input.current?.focus();
  }, [current, mode]);
  useEffect(() => {
    if (finished && queue.length > 0) playFanfare();
  }, [finished, queue.length]);

  const answer = useCallback(
    async (correct: boolean, given: string) => {
      if (!current || saving || answered) return;
      setSaving(true);
      try {
        const r: RecipeReviewResult = await api.reviewRecipeWord(current.id, correct, mode, target);
        if (correct) {
          // Right in すべて / 復習中 has made the word learned already; 習得 keeps that, まだ takes it
          // back into review (see `decide`). In 習得済み / 除外中 it stays where it is.
          playCrunch();
          if (!decides) setRemembered((w) => [...w, current]);
        } else {
          playWrong();
          setLeft((w) => [...w, current]);
        }
        setEarned((k) => k + r.kcalEarned);
        setFractionPending(r.fractionPending);
        setAnswered({
          correct,
          given,
          points: r.points,
          movedBack: !correct && !!(current.masteredAt || current.excludedAt),
          decideHint: correct && decides && firstToday("decide"),
          repeatNote: correct && r.repeat && firstToday("repeat"),
        });
        if (r.kcalEarned > 0) onProgress();
        if (mode === "typing" && current.kind !== "usage") window.setTimeout(() => say(current.word), 380);
      } catch (e) {
        toast(String(e));
      } finally {
        setSaving(false);
      }
    },
    [current, saving, answered, mode, target, decides, onProgress, toast],
  );

  const next = useCallback(() => {
    stopSpeaking();
    setAnswered(null);
    setTyped("");
    setIdx((i) => i + 1);
  }, []);

  // After a right answer in すべて / 復習中: 習得 keeps the word in 習得済み, where the answer put it,
  // まだ puts it back into review, so a lucky guess does not make a word learned.
  const decide = useCallback(
    async (learned: boolean) => {
      if (!current || !answered?.correct || saving) return;
      setSaving(true);
      try {
        if (learned) setRemembered((w) => [...w, current]);
        else {
          await api.setRecipeMastered(current.id, false);
          setLeft((w) => [...w, current]);
        }
        next();
      } catch (e) {
        toast(String(e));
      } finally {
        setSaving(false);
      }
    },
    [current, answered, saving, next, toast],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (finished) return;
      // A right answer in すべて / 復習中 waits for 習得 / まだ; any other answer moves on with Enter.
      if (answered && (!answered.correct || !decides) && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        next();
      } else if (!answered && mode === "choice") {
        const n = Number(e.key);
        if (n >= 1 && n <= options.length) void answer(options[n - 1] === current.meaning, options[n - 1]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [finished, answered, decides, mode, options, current, answer, next]);

  if (finished) {
    const again = target === "mastered" || target === "excluded";
    const clearRemembered = async () => {
      setSaving(true);
      try {
        const n = await api.excludeRecipeWords(remembered.map((w) => w.id));
        setCleared(true);
        toast(`🧁 ${again ? "覚えていた" : "覚えた"}${n}語を除外中に移しました`);
      } catch (e) {
        toast(String(e));
      } finally {
        setSaving(false);
      }
    };
    const summary =
      target === "mastered"
        ? "正解した単語は習得済みのまま、間違えた単語は復習中に戻しました。"
        : target === "excluded"
          ? "正解した単語は除外中のまま、間違えた単語は復習中に戻しました。"
          : "「習得」にした単語は習得済みになりました。間違えた単語と「まだ」にした単語は復習中です。";
    return (
      <section className="card recipe-review done">
        <h2>🧁 復習おしまい！</h2>
        <div className="recipe-counts big">
          <span className="positive">
            {again ? "覚えていた" : "覚えた"} <b>{remembered.length}</b>語
          </span>
          <span>
            {again ? "忘れていた" : "まだ"} <b>{left.length}</b>語
          </span>
          <span className="recipe-kcal">
            おやつ予算 <b>+{earned}</b> kcal
          </span>
        </div>
        {fractionPending && (
          <p className="muted small">
            1 kcal に満たない端数は、今日のうちに次の正解と合わせて 1 kcal になります（日付が変わると切り捨て）。
          </p>
        )}
        <p className="muted">{summary}</p>
        <div className="row recipe-actions">
          {remembered.length > 0 && !cleared && target !== "excluded" && (
            <button className="btn btn-primary" disabled={saving} onClick={() => void clearRemembered()}>
              {again ? "覚えていた" : "覚えた"}{remembered.length}語を除外中に移す
            </button>
          )}
          {left.length > 0 && (
            <button className="btn" disabled={saving} onClick={() => onAgain(left)}>
              {again ? "忘れていた" : "まだの"}{left.length}語をもう一度
            </button>
          )}
          <button className="btn" onClick={onDone}>
            レシピに戻る
          </button>
        </div>
      </section>
    );
  }

  const example = current.example ? (
    <div className="flash-example">
      {/* Meanings stay off until the answer is in, or hovering would give it away. */}
      <GlossedText text={current.example} dict={dict} enabled={!!answered} highlight={current.form || current.word} />
      <button
        type="button"
        className="btn-link speak-btn"
        onClick={() => say(current.example)}
        disabled={!isTtsSupported()}
        title="読み上げる"
        aria-label="読み上げる"
      >
        🔊
      </button>
    </div>
  ) : null;

  return (
    <section className="card recipe-review">
      <div className="section-head">
        <h2>
          {REVIEW_ICON[mode]} {REVIEW_TITLE[mode]} <span className={"pill recipe-tab-pill " + target}>{TAB_LABEL[target]}</span>{" "}
          <span className="pill" title={`同じ日に同じ単語を2回目以降に正解すると ${REPEAT_KCAL[mode]} kcal`}>
            1語 {REVIEW_KCAL[mode]} kcal
          </span>
        </h2>
        <div className="study-progress">
          {idx + 1} / {queue.length}
          <div className="mini-bar">
            <div style={{ width: `${((idx + (answered ? 1 : 0)) / queue.length) * 100}%` }} />
          </div>
        </div>
        <button className="btn-link" onClick={onDone}>
          やめる
        </button>
      </div>

      {mode === "choice" ? (
        <div className="flash" key={current.id}>
          <div className="prompt-label">この英語の意味は？</div>
          <button
            className="flash-word"
            onClick={() => current.kind !== "usage" && say(current.word)}
            title={current.kind === "usage" ? undefined : "クリックで発音"}
          >
            {current.word}
          </button>
          {example}
          <div className="options recipe-options">
            {options.map((opt, i) => {
              let cls = "option";
              if (answered) {
                if (opt === current.meaning) cls += " correct";
                else if (opt === answered.given) cls += " wrong";
              }
              return (
                <button
                  key={opt + i}
                  className={cls}
                  disabled={!!answered || saving}
                  onClick={() => void answer(opt === current.meaning, opt)}
                >
                  <span className="option-num">{i + 1}</span>
                  <span>{opt}</span>
                </button>
              );
            })}
          </div>
          {!answered && <div className="muted small">キーボードの 1〜4 でも回答できます</div>}
        </div>
      ) : (
        <form
          className="flash"
          key={current.id}
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) void answer(typedRight(current, typed, dict), typed.trim());
          }}
        >
          <div className="prompt-label">この意味の英語は？</div>
          <div className="flash-meaning">{current.meaning}</div>
          {current.kind === "usage" && (
            <div className="muted small">用法の「～・人・A・B・原形・-ing」などの部分は書かなくてもかまいません</div>
          )}
          {answered ? example : gapped && <div className="flash-example">{gapped}</div>}
          {current.exampleJa && <div className="muted">{current.exampleJa}</div>}
          <input
            ref={input}
            className="answer-input recipe-input"
            value={typed}
            disabled={!!answered || saving}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="英語で入力して Enter"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            lang="en"
          />
          {!answered && (
            <div className="row flash-actions">
              <button type="submit" className="btn btn-primary" disabled={saving || !typed.trim()}>
                回答する
              </button>
              <button type="button" className="btn-link" disabled={saving} onClick={() => void answer(false, "")}>
                わからない
              </button>
            </div>
          )}
        </form>
      )}

      {answered && (
        <div className={"feedback " + (answered.correct ? "ok" : "ng")}>
          <div className="feedback-main">
            <div className="feedback-title">{answered.correct ? "正解！ サクサク🍪" : "ざんねん…"}</div>
            <div className="feedback-kcal">
              +{formatKcal(answered.points)} kcal
              {answered.points > 0 && <PlayModeTag mode={playMode} />}
            </div>
          </div>
          <div className="feedback-detail">
            {mode === "typing" && !answered.correct && answered.given && (
              <div>
                <span className="label">あなたの答え</span> <span className="typed-wrong">{answered.given}</span>
              </div>
            )}
            <div>
              <span className="label">正解</span> <strong>{current.word}</strong>
              {shownForm(current) && <span className="muted">（{shownForm(current)}）</span>}　{current.meaning}
              {current.kind !== "usage" && (
                <button className="btn-link" onClick={() => say(current.word)} disabled={!isTtsSupported()}>
                  🔊 もう一度聞く
                </button>
              )}
            </div>
            {notes?.word === current.word && notes.notes && (
              <WordNotesPanel notes={notes.notes} word={current.word} meaning={current.meaning} dict={dict} gloss />
            )}
            {(answered.correct ? answered.decideHint || answered.repeatNote : true) && (
              <div className="muted">
                {answered.correct
                  ? [
                      answered.decideHint && DECIDE_HINT,
                      answered.repeatNote &&
                        `この単語は今日2回目以降の正解なので、カロリーは半分（${REPEAT_KCAL[mode]} kcal${playMode === "normal" ? "" : `、${PLAY_MODE_INFO[playMode].label} ×${PLAY_MODE_INFO[playMode].multiplier} の前`}）です。`,
                    ]
                      .filter(Boolean)
                      .join(" ")
                  : answered.movedBack
                    ? "復習中に戻しました。最後にもう一度挑戦できます。"
                    : "復習中のまま残ります。最後にもう一度挑戦できます。"}
              </div>
            )}
          </div>
          {answered.correct && decides ? (
            <div className="row decide-buttons">
              <button className="btn decide-learned" disabled={saving} onClick={() => void decide(true)} autoFocus>
                習得
              </button>
              <button className="btn decide-not-yet" disabled={saving} onClick={() => void decide(false)}>
                まだ
              </button>
            </div>
          ) : (
            <button className="btn btn-primary" onClick={next} autoFocus>
              {idx + 1 >= queue.length ? "結果を見る" : "次へ（Enter）"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
