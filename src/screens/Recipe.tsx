import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import GlossedText from "../components/GlossedText";
import { DeleteButton } from "../components/IconButtons";
import PencilIcon from "../components/PencilIcon";
import WordNotesPanel from "../components/WordNotes";
import { api } from "../lib/api";
import { loadDictionary, lookup, type Dictionary } from "../lib/dictionary";
import { onRecipeChanged } from "../lib/recipe";
import { playCrunch, playFanfare, playWrong } from "../lib/sfx";
import { isTtsSupported, speak, stopSpeaking } from "../lib/speech";
import {
  RECIPE_POS,
  RECIPE_POS_LABEL,
  type RecipePos,
  type RecipeReviewMode,
  type RecipeReviewResult,
  type RecipeWord,
  type WordNotes,
} from "../types";

interface Props {
  /** a correct review adds to today's kcal, which the header and home show */
  onProgress: () => void;
  toast: (msg: string) => void;
}

type Filter = "all" | "learning" | "mastered";
/** which words a review goes over: those still being learned, or those already learned */
type Target = "learning" | "mastered";

const NO_MEANING = "（辞書に意味がありません）";

/** What one correct word pays, as shown to the learner (srs::recipe_half_kcal). */
const REVIEW_KCAL: Record<RecipeReviewMode, string> = { choice: "0.5", typing: "1" };
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

/** The form that was right-clicked, when it differs from the headword ("heard" for hear). */
function shownForm(w: RecipeWord): string | null {
  return w.form && w.form.toLowerCase() !== w.word.toLowerCase() ? w.form : null;
}

/* ---------- the list: search, order, parts of speech ---------- */

/** abc順 or 追加日順, one at a time; clicking the one in use turns it around. */
interface Order {
  key: "added" | "abc";
  reverse: boolean;
}
/** 品詞順: off, every part of speech in turn (名詞 → 動詞 → 形容詞 → 副詞 → 慣用句), or only one. */
type PosView = "off" | "grouped" | RecipePos;

const ORDERS: Array<{ key: Order["key"]; label: string; dirs: [string, string] }> = [
  { key: "abc", label: "abc順", dirs: ["A→Z", "Z→A"] },
  { key: "added", label: "追加日順", dirs: ["新→古", "古→新"] },
];
const LIST_STORAGE = "cq-recipe-order";

/** The order and whether it goes by part of speech, as last left; a one-part filter is not kept. */
function loadListView(): { order: Order; grouped: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(LIST_STORAGE) ?? "null");
    if (v && (v.key === "added" || v.key === "abc") && typeof v.reverse === "boolean") {
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

/** Newest first or A→Z (turned around by `reverse`), within the parts of speech when `byPos`. */
function ordered(words: RecipeWord[], { key, reverse }: Order, byPos: boolean): RecipeWord[] {
  const sign = reverse ? -1 : 1;
  const within = (a: RecipeWord, b: RecipeWord) =>
    key === "abc" ? abc.compare(a.word, b.word) || a.id - b.id : b.addedAt.localeCompare(a.addedAt) || b.id - a.id;
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
 * The notes under a right answer that say the same thing every time: how 習得 / まだ work, and
 * that a word pays only once a day. Each is shown the first time it comes up in a day.
 */
type Hint = "decide" | "paid";
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
 * お菓子作りレシピ: the words the learner right-clicked while studying. They are reviewed by
 * picking the meaning (0.5 kcal) or writing the English (1 kcal); a word answered right becomes
 * learned when the learner says so (習得), and learned words can be cleared out of the list. Learned
 * words can be gone over again too, and one got wrong goes back into review.
 *
 * The list shows a word and its meaning on one line and opens to its example and dates on a
 * click; it can be narrowed by the start of the word and put in abc or added order, by part of
 * speech or not, or down to one part of speech.
 */
export default function Recipe({ onProgress, toast }: Props) {
  const [words, setWords] = useState<RecipeWord[] | null>(null);
  const [dict, setDict] = useState<Dictionary | null>(null);
  /** the meanings of every pattern of 用法, the wrong options for a pattern in review */
  const [usagePool, setUsagePool] = useState<string[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [reviewing, setReviewing] = useState<{ target: Target; mode: RecipeReviewMode; queue: RecipeWord[] } | null>(null);
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

  const learning = words.filter((w) => !w.masteredAt);
  const mastered = words.filter((w) => w.masteredAt);
  // Both kinds of review ask about the meaning, so a word without one cannot be quizzed.
  const quizzable: Record<Target, RecipeWord[]> = {
    learning: learning.filter((w) => w.meaning),
    mastered: mastered.filter((w) => w.meaning),
  };

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
          onAgain={(left) => {
            setRound((r) => r + 1);
            // Missed words are back in review now, even those that had been learned.
            setReviewing({ target: "learning", mode: reviewing.mode, queue: shuffled(left) });
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

  const shown = filter === "learning" ? learning : filter === "mastered" ? mastered : words;
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
  // The review buttons follow the list's tab: 習得済み goes over the learned words, the others
  // over the words still in review.
  const target: Target = filter === "mastered" ? "mastered" : "learning";
  const start = (target: Target, mode: RecipeReviewMode) => {
    const pool = quizzable[target];
    setRound((r) => r + 1);
    setReviewing({ target, mode, queue: target === "mastered" ? stalestFirst(pool) : shuffled(pool) });
  };

  const clearMastered = () =>
    run(async () => {
      const n = await api.deleteRecipeWords(mastered.map((w) => w.id));
      setConfirmClear(false);
      toast(`🧁 習得済みの${n}語をレシピから片付けました`);
    });

  return (
    <div className="screen recipe">
      <section className="card">
        <div className="section-head">
          <h2>🧁 お菓子作りレシピ</h2>
          <div className="recipe-counts">
            <span>
              材料 <b>{words.length}</b>語
            </span>
            <span>
              復習中 <b>{learning.length}</b>
            </span>
            <span className="positive">
              習得済み <b>{mastered.length}</b>
            </span>
          </div>
        </div>
        <p className="muted">
          問題や解説の英単語を<b>右クリック</b>すると、ここに材料として集まります。復習は英単語の意味を4択で選ぶ「選択式」（1語 0.5 kcal）と、日本語から英語を書く「記入式」（1語 1 kcal）の2通り。正解したら「習得」か「まだ」を選び、習得した単語はレシピから片付けられます。習得済みの単語も下の「習得済み」タブから復習でき、間違えるか「まだ」を選ぶと復習中に戻ります。獲得したカロリーは今日のおやつ予算に入ります（1語につき1日1回、小数点以下は切り捨て）。
        </p>
        <div className="row recipe-actions">
          <span className="recipe-target">
            {target === "learning" ? "復習中" : "習得済み"} <b>{quizzable[target].length}</b>語
          </span>
          {(["choice", "typing"] as const).map((mode) => (
            <button
              key={mode}
              className={"btn recipe-mode-btn " + mode}
              disabled={busy || quizzable[target].length === 0}
              onClick={() => start(target, mode)}
            >
              {REVIEW_ICON[mode]} {REVIEW_TITLE[mode]}
            </button>
          ))}
          {target === "mastered" &&
            mastered.length > 0 &&
            (confirmClear ? (
              <>
                <span>習得済みの{mastered.length}語をレシピから削除します。</span>
                <button className="btn btn-danger" disabled={busy} onClick={() => void clearMastered()}>
                  削除する
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
        {target === "learning" && learning.length > quizzable.learning.length && (
          <p className="muted small">
            辞書に意味のない{learning.length - quizzable.learning.length}語は復習に出ません（一覧で単語を開き「✓ 覚えた」を押すと習得済みにできます）。
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
                {(
                  [
                    ["all", `すべて ${words.length}`],
                    ["learning", `復習中 ${learning.length}`],
                    ["mastered", `習得済み ${mastered.length}`],
                  ] as const
                ).map(([id, label]) => (
                  <button key={id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>
                    {label}
                  </button>
                ))}
              </div>
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
                    : "復習中の単語はありません。"
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
                    <li key={w.id} className={"recipe-item" + (w.masteredAt ? " mastered" : "") + (isOpen ? " open" : "")}>
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
                        {w.masteredAt && (
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
                              {w.masteredAt && `・${stamp(w.masteredAt)} に習得`}
                            </span>
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
                              label="レシピから削除"
                              disabled={busy}
                              onClick={() =>
                                run(async () => {
                                  await api.deleteRecipeWords([w.id]);
                                  toast(`「${w.word}」をレシピから削除しました`);
                                })
                              }
                            />
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
  /** right and paid; a word pays once a day */
  counted: boolean;
  /** right, and the first right answer today: explain 習得 / まだ */
  decideHint: boolean;
  /** right but already paid today, the first time today: say why it is +0 kcal */
  paidNote: boolean;
}

function RecipeReview({
  target,
  mode,
  queue,
  words,
  dict,
  usagePool,
  onAgain,
  onDone,
  onProgress,
  toast,
}: {
  /** learned words: right keeps them learned, wrong puts them back into review */
  target: Target;
  mode: RecipeReviewMode;
  queue: RecipeWord[];
  /** the whole recipe, whose meanings serve as wrong options */
  words: RecipeWord[];
  dict: Dictionary | null;
  usagePool: string[];
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
  const [halfPending, setHalfPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cleared, setCleared] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const current = queue[idx];
  const finished = idx >= queue.length;
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
        const r: RecipeReviewResult = await api.reviewRecipeWord(current.id, correct, mode);
        if (correct) {
          // Right is not yet learned: the learner says so with 習得 / まだ (see `decide`).
          playCrunch();
        } else {
          playWrong();
          setLeft((w) => [...w, current]);
        }
        setEarned((k) => k + r.kcalEarned);
        setHalfPending(r.halfPending);
        setAnswered({
          correct,
          given,
          counted: r.counted,
          decideHint: correct && firstToday("decide"),
          paidNote: correct && !r.counted && firstToday("paid"),
        });
        if (r.kcalEarned > 0) onProgress();
        if (mode === "typing" && current.kind !== "usage") window.setTimeout(() => say(current.word), 380);
      } catch (e) {
        toast(String(e));
      } finally {
        setSaving(false);
      }
    },
    [current, saving, answered, mode, onProgress, toast],
  );

  const next = useCallback(() => {
    stopSpeaking();
    setAnswered(null);
    setTyped("");
    setIdx((i) => i + 1);
  }, []);

  // After a right answer: 習得 marks the word learned, まだ keeps it in review (or puts a learned
  // word back), so a lucky guess does not make a word learned.
  const decide = useCallback(
    async (learned: boolean) => {
      if (!current || !answered?.correct || saving) return;
      setSaving(true);
      try {
        await api.setRecipeMastered(current.id, learned);
        if (learned) setRemembered((w) => [...w, current]);
        else setLeft((w) => [...w, current]);
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
      // A right answer waits for 習得 / まだ; only a wrong one moves on with Enter.
      if (answered && !answered.correct && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        next();
      } else if (!answered && mode === "choice") {
        const n = Number(e.key);
        if (n >= 1 && n <= options.length) void answer(options[n - 1] === current.meaning, options[n - 1]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [finished, answered, mode, options, current, answer, next]);

  const again = target === "mastered";
  if (finished) {
    const clearRemembered = async () => {
      setSaving(true);
      try {
        const n = await api.deleteRecipeWords(remembered.map((w) => w.id));
        setCleared(true);
        toast(`🧁 ${again ? "覚えていた" : "覚えた"}${n}語をレシピから片付けました`);
      } catch (e) {
        toast(String(e));
      } finally {
        setSaving(false);
      }
    };
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
        {halfPending && (
          <p className="muted small">
            端数の 0.5 kcal は、今日のうちに次の 0.5 kcal と合わせて 1 kcal になります（日付が変わると切り捨て）。
          </p>
        )}
        {left.length > 0 && (
          <p className="muted">
            {again ? "忘れていた単語と「まだ」にした単語は復習中に戻しました。" : "間違えた単語と「まだ」にした単語は復習中に残ります。"}
          </p>
        )}
        {remembered.length > 0 && (
          <p className="muted">
            {again ? "「習得」にした単語は習得済みのままです。" : "「習得」にした単語は習得済みになりました。"}
            レシピに残しておくことも、片付けることもできます。
          </p>
        )}
        <div className="row recipe-actions">
          {remembered.length > 0 && !cleared && (
            <button className="btn btn-primary" disabled={saving} onClick={() => void clearRemembered()}>
              {again ? "覚えていた" : "覚えた"}{remembered.length}語をレシピから片付ける
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
          {REVIEW_ICON[mode]} {REVIEW_TITLE[mode]} {again && <span className="pill mastered">習得済み</span>}{" "}
          <span className="pill">1語 {REVIEW_KCAL[mode]} kcal</span>
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
            <div className="feedback-kcal">{answered.counted ? `+${REVIEW_KCAL[mode]} kcal` : "+0 kcal"}</div>
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
            {(answered.correct ? answered.decideHint || answered.paidNote : true) && (
              <div className="muted">
                {answered.correct
                  ? [
                      answered.decideHint &&
                        (again
                          ? "まだ覚えているなら「習得」、自信がなければ「まだ」で復習中に戻します。"
                          : "覚えたなら「習得」で習得済みに。なんとなく当たっただけなら「まだ」で復習中に残します。"),
                      answered.paidNote && "この単語のカロリーは今日もう受け取っています（1語につき1日1回）。",
                    ]
                      .filter(Boolean)
                      .join(" ")
                  : again
                    ? "復習中に戻しました。最後にもう一度挑戦できます。"
                    : "復習中のまま残ります。最後にもう一度挑戦できます。"}
              </div>
            )}
          </div>
          {answered.correct ? (
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
