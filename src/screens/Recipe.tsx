import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import GlossedText from "../components/GlossedText";
import { DeleteButton } from "../components/IconButtons";
import PencilIcon from "../components/PencilIcon";
import { PlayModeTag } from "../components/PlayModeSwitch";
import WordCardIcon from "../components/WordCardIcon";
import WordNotesPanel, { WordNotesBrief } from "../components/WordNotes";
import AntonymTag from "../components/AntonymTag";
import { CuedMeaningWithTags, MeaningWithTags, SlotText, useWordTags } from "../components/PosTags";
import { cuedMeaning } from "../lib/pos";
import { api } from "../lib/api";
import { loadDictionary, loadedDictionary, lookup, type Dictionary } from "../lib/dictionary";
import { keep, keptData } from "../lib/screenCache";
import { onRecipeChanged } from "../lib/recipe";
import { formatKcal } from "../lib/scoring";
import { playCrunch, playFanfare, playWrong } from "../lib/sfx";
import { isTtsSupported, speak, speakInTurn, stopSpeaking } from "../lib/speech";
import { revealOnTouch, RIGHT_CLICK, touchScreen, withEnter } from "../lib/touch";
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

/** すべて (every word not taken off), ★ (the starred words in review), 復習, 習得, 除外 (taken off with ×) */
const TAB_LABEL: Record<RecipeTab, string> = { all: "すべて", favorite: "★", learning: "復習", mastered: "習得", excluded: "除外" };
const TABS: RecipeTab[] = ["all", "favorite", "learning", "mastered", "excluded"];

const NO_MEANING = "（辞書に意味がありません）";

/**
 * What one correct word pays, as shown to the learner (srs::recipe_quarter_kcal): the first time
 * it is right in a day, and every time after that day.
 */
const REVIEW_KCAL: Record<RecipeReviewMode, string> = { choice: "0.5", typing: "1" };
const REPEAT_KCAL: Record<RecipeReviewMode, string> = { choice: "0.25", typing: "0.5" };


const REVIEW_TITLE: Record<RecipeReviewMode, string> = { choice: "選択式", typing: "記入式" };

/** What a bulk button does to the words of its tab. */
type BulkKind = "learn" | "review" | "unstar" | "exclude" | "delete";

interface BulkAction {
  kind: BulkKind;
  label: string;
  ask: (n: number) => string;
  yes: string;
  done: (n: number) => string;
}

/**
 * The bulk buttons at the end of the review row of ★, 復習, 習得 and 除外, side by side with ／
 * between, each asked before it acts. In 復習, すべて習得へ leaves the starred words: they are kept
 * to go on reviewing.
 */
const BULK: Partial<Record<RecipeTab, BulkAction[]>> = {
  favorite: [
    {
      kind: "unstar",
      label: "すべて復習へ",
      ask: (n) => `★の${n}語をすべて★から外しますか？（復習に残ります）`,
      yes: "外す",
      done: (n) => `${n}語を★から外しました（復習に残っています）`,
    },
    {
      kind: "learn",
      label: "すべて習得へ",
      ask: (n) => `★の${n}語をすべて習得に移しますか？（★は外れます）`,
      yes: "移す",
      done: (n) => `${n}語を習得に移しました`,
    },
  ],
  learning: [
    {
      kind: "learn",
      label: "すべて習得へ",
      ask: (n) => `復習の${n}語（★の単語を除く）をすべて習得に移しますか？`,
      yes: "移す",
      done: (n) => `${n}語を習得に移しました`,
    },
  ],
  mastered: [
    {
      kind: "review",
      label: "すべて復習へ",
      ask: (n) => `習得の${n}語をすべて復習に戻しますか？`,
      yes: "戻す",
      done: (n) => `${n}語を復習に戻しました`,
    },
    {
      kind: "exclude",
      label: "すべて除外",
      ask: (n) => `習得の${n}語をすべて除外に移しますか？`,
      yes: "移す",
      done: (n) => `${n}語を除外に移しました`,
    },
  ],
  excluded: [
    {
      kind: "delete",
      label: "一括削除",
      ask: (n) => `除外の${n}語を完全に削除しますか？（元に戻せません）`,
      yes: "削除する",
      done: (n) => `${n}語を削除しました`,
    },
  ],
};
const REVIEW_ICON: Record<RecipeReviewMode, ReactNode> = { choice: "👆", typing: <PencilIcon /> };

/** In ★: starred and in review (recipe::review never makes a starred word learned). */
function isStarred(w: RecipeWord): boolean {
  return !!w.favoritedAt && !w.masteredAt && !w.excludedAt;
}

/** What starring says: a word learned or taken off comes back into 復習 with its star. */
function starredMessage(w: RecipeWord): string {
  return `「${w.word}」を★に入れました${w.masteredAt || w.excludedAt ? "（復習に戻しました）" : ""}`;
}

/** ☆ / ★ of a recipe word: starred, it is in ★ (and in 復習 and すべて). */
function StarButton({ on, onToggle, className = "" }: { on: boolean; onToggle: () => void; className?: string }) {
  const label = on ? "★から外す" : "★に入れる（復習に入ります）";
  return (
    <button
      type="button"
      className={"fav-star-small recipe-star" + (on ? " on" : "") + (className ? " " + className : "")}
      aria-pressed={on}
      title={label}
      aria-label={label}
      onClick={onToggle}
    >
      {on ? "★" : "☆"}
    </button>
  );
}

/**
 * ☆ / ★ during a review or the word cards: what was starred when it began, and starring or
 * unstarring a word there and then (recipe::set_favorite). The star turns at once; a failed save
 * turns it back and says so.
 */
function useStars(queue: RecipeWord[], toast: (msg: string) => void) {
  const [stars, setStars] = useState<ReadonlySet<number>>(() => new Set(queue.filter(isStarred).map((w) => w.id)));
  const mark = useCallback(
    (id: number, on: boolean) =>
      setStars((cur) => {
        const next = new Set(cur);
        if (on) next.add(id);
        else next.delete(id);
        return next;
      }),
    [],
  );
  const toggle = async (w: RecipeWord) => {
    const on = !stars.has(w.id);
    mark(w.id, on);
    try {
      await api.setRecipeFavorite(w.id, on);
      toast(on ? starredMessage(w) : `「${w.word}」を★から外しました`);
    } catch (e) {
      mark(w.id, !on);
      toast(String(e));
    }
  };
  return { has: (id: number) => stars.has(id), toggle, unstar: (id: number) => mark(id, false) };
}

/** 単語カード: which side of a word shows first, the meaning (日本語→英語) or the English (英語→日本語). */
type CardDirection = "ja-en" | "en-ja";
const CARD_DIRECTIONS: { direction: CardDirection; label: string; note: string }[] = [
  { direction: "ja-en", label: "日本語 → 英語", note: "意味を見て英語を思い出す" },
  { direction: "en-ja", label: "英語 → 日本語", note: "英語を見て（聞いて）意味を思い出す" },
];
const CARD_DIRECTION_LABEL: Record<CardDirection, string> = { "ja-en": "日本語→英語", "en-ja": "英語→日本語" };

function say(text: string) {
  if (isTtsSupported()) speak(text).catch(() => undefined);
}

/**
 * What fills a pattern, read as an English dictionary reads it (lend someone something, look
 * forward to doing). 節 is left out: "I'm afraid (that) 節" is "I'm afraid that".
 */
const STAND_INS: [RegExp, string][] = [
  [/過去分詞/g, "done"],
  [/形容詞/g, "adjective"],
  [/原形/g, "do"],
  [/人/g, "someone"],
  [/節/g, ""],
  [/(?<![\w-])-ing(?![\w-])/g, "doing"],
  [/(?<![\w-])[AB](?![\w-])/g, "something"],
];

/**
 * What is read aloud for an entry: a word as it is, a pattern with what fills it in words
 * (`STAND_INS`), each way of it in turn. "be confident in/about A" is "be confident in something",
 * then "be confident about something"; "lend 人 A／lend A to 人" "lend someone something" and "lend
 * something to someone". A side of ／ not starting with the pattern's word stands for the last part
 * before it, "to 原形" as one: "look forward to A／-ing" is "look forward to doing" as well, "begin to
 * 原形／-ing" "begin doing". The English in ( ) is read ("It is easy for someone to do"), a note in
 * （ ） is not.
 */
function readings(w: Pick<RecipeWord, "kind" | "word">): string[] {
  if (w.kind !== "usage") return [w.word];
  const out = new Set<string>();
  let before = "";
  for (const side of w.word.split(/\s*／\s*/)) {
    const whole = !before || side.split(" ")[0] === before.split(" ")[0];
    const written = whole ? side : before.replace(/(?:to )?原形$|\S+$/, () => side);
    before = written;
    const bare = STAND_INS.reduce(
      (text, [filler, word]) => text.replace(filler, ` ${word} `),
      written.replace(/（[^）]*）/g, " ").replace(/[()]/g, " "),
    ).replace(/[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]/gu, " ");
    const choices = bare
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => (/^[A-Za-z'-]+(\/[A-Za-z'-]+)+$/.test(token) ? token.split("/") : [token]));
    for (const way of eachOf(choices)) if (way.length > 0) out.add(way.join(" "));
  }
  return [...out];
}

/** Two ways of a pattern are read this far apart. */
const READINGS_GAP_MS = 400;

/** Reads an entry aloud: a word, or a pattern's ways one after another. Settles when it is read. */
function sayEntry(w: Pick<RecipeWord, "kind" | "word">): Promise<void> {
  const ways = readings(w);
  if (!isTtsSupported() || ways.length === 0) return Promise.resolve();
  const read = ways.length === 1 ? speak(ways[0]) : speakInTurn(ways, READINGS_GAP_MS, () => undefined);
  return read.catch(() => undefined);
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

/** The order 単語カード goes through a tab's words: shuffled, or the ones missed most first. */
function cardQueue(words: RecipeWord[], missedFirst: boolean): RecipeWord[] {
  const base = shuffled(words);
  return missedFirst ? base.sort((a, b) => b.misses - a.misses) : base;
}

/** Closes a menu that is `open` (`setOpen(false)`) on a click outside `box` or on Escape. */
function useClickAway(open: boolean, box: RefObject<HTMLElement | null>, setOpen: (open: boolean) => void) {
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open, box, setOpen]);
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
type Hint = "decide" | "repeat" | "starred";
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
/** Each word's 類似表現 groups with its nuance as a cue (WordTags.cues). */
type Cues = Record<string, Array<[number, string]>>;

/** English → its gloss, the other way round: whose meaning an option of the dictionary is. */
const glossOwners = new WeakMap<Dictionary, Map<string, string>>();
function ownerOf(dict: Dictionary | null, gloss: string): string | undefined {
  if (!dict) return undefined;
  let owners = glossOwners.get(dict);
  if (!owners) {
    owners = new Map();
    for (const [en, ja] of Object.entries(dict)) if (!owners.has(ja)) owners.set(ja, en);
    glossOwners.set(dict, owners);
  }
  return owners.get(gloss);
}

/** The English an option of a word's review stands for: a word of the recipe, else the dictionary's. */
function optionEnglish(meaning: string, words: RecipeWord[], dict: Dictionary | null): string | undefined {
  return words.find((w) => w.kind !== "usage" && w.meaning === meaning)?.word ?? ownerOf(dict, meaning);
}

/**
 * The English an option of a review stands for, shown beside a wrong option once answered as the
 * study's 選択問題 shows it: a pattern for a pattern's meaning (one of the recipe, else of 用法:
 * `patterns`, meaning → pattern), a word for a word's.
 */
function optionSource(
  word: RecipeWord,
  meaning: string,
  words: RecipeWord[],
  dict: Dictionary | null,
  patterns: Map<string, string>,
): string | undefined {
  if (word.kind === "usage") return words.find((w) => w.kind === "usage" && w.meaning === meaning)?.word ?? patterns.get(meaning);
  return optionEnglish(meaning, words, dict);
}

/**
 * The options of a word's review as they are put: when the word has a nuance that tells it from its
 * near synonyms (admit: （事実・誤りを）しぶしぶ認める), every option with one shows its own.
 */
function optionLabels(word: RecipeWord, options: string[], words: RecipeWord[], dict: Dictionary | null, cues: Cues | null): string[] {
  if (!cues || word.kind === "usage") return options;
  const own = cuedMeaning(word.word, word.meaning, cues);
  if (!own) return options;
  return options.map((o) => {
    if (o === word.meaning) return own;
    const en = optionEnglish(o, words, dict);
    return (en && cuedMeaning(en, o, cues)) || o;
  });
}

function meaningOptions(
  word: RecipeWord,
  words: RecipeWord[],
  dict: Dictionary | null,
  usagePool: string[],
  cues: Cues | null,
): string[] {
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
  // A word asked with its nuance is set among words with theirs, from other 類似表現 groups than
  // its own (whose words are its near synonyms), so that it is not the one option that looks different.
  if (cues && cuedMeaning(word.word, word.meaning, cues)) {
    const groups = new Set((cues[word.word.toLowerCase()] ?? []).map(([g]) => g));
    const apart = (en: string) => !(cues[en.toLowerCase()] ?? []).some(([g]) => groups.has(g));
    const cuedOwn = words
      .filter((w) => w.id !== word.id && w.kind !== "usage" && w.meaning && apart(w.word) && cuedMeaning(w.word, w.meaning, cues))
      .map((w) => w.meaning);
    const cuedDict = Object.keys(cues)
      .filter((en) => dict?.[en] && apart(en) && cuedMeaning(en, dict[en], cues))
      .map((en) => dict![en]);
    take(cuedOwn, 2, near);
    take(cuedDict, 3, near);
    take(cuedDict, 3);
  }
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
    // "café" is "cafe", as in the study's typing (scoring.ts normalizeText).
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
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
 * "be afraid of A" → "afraid of", "look forward to A／-ing" → "look forward to". Written in full or
 * without the fillers, it is the same.
 */
function patternCore(text: string): string {
  const bare = text
    .replace(/[（(][^）)]*[）)]/g, " ")
    .replace(/～|~|…|人|原形|過去分詞|形容詞|節|-ing|／/g, " ")
    .replace(/\b[ABab]\b/g, " ");
  return normalizeAnswer(bare).replace(/^be /, "");
}

/** Every way of writing one word a / b / c: "in/about" is "in" or "about", and so is a pair. */
function eachOf<T>(lists: T[][]): T[][] {
  return lists.reduce<T[][]>((ways, list) => ways.flatMap((way) => list.map((x) => [...way, x])), [[]]);
}

/**
 * The ways an entry may be written, as it is and with each choice made: "be confident in/about A"
 * is "be confident in A" or "be confident about A", the two sides of ／ ("A／-ing", "bring A to
 * 人／bring 人 A") each stand alone, and an English part in ( ) may be written or left out ("I'm
 * afraid (that) 節").
 */
function spellings(text: string): string[] {
  const out = new Set([text]);
  for (const side of text.split(/\s*／\s*|\s+\/\s+/)) {
    // The optional parts: half-width brackets around English (a note in （ ） is no part of it).
    const optional = [...side.matchAll(/\(([^()]*[A-Za-z][^()]*)\)/g)].map((m) => m[0]);
    for (const keep of eachOf(optional.map(() => [true, false]))) {
      let written = side;
      optional.forEach((part, i) => (written = written.replace(part, keep[i] ? part.slice(1, -1) : " ")));
      const choices = written.split(/\s+/).map((token) => (/^[A-Za-z'-]+(\/[A-Za-z'-]+)+$/.test(token) ? token.split("/") : [token]));
      for (const way of eachOf(choices)) out.add(way.join(" "));
    }
  }
  return [...out];
}

/** An entry as written: a pattern with [原] [形] [節] boxed, a word as it is. */
function EntryText({ w, text }: { w: RecipeWord; text: string }) {
  return w.kind === "usage" ? <SlotText text={text} /> : <>{text}</>;
}

/**
 * An entry's meaning: a word's with its tags in front ([名] 腕時計, [他] 承認する, [自] 走る ／ [他]
 * 経営する), a pattern's with [原] [形] [節] boxed, an idiom's as it is. `cued`: a word with near
 * synonyms by its nuance, as the reviews ask it (admit: [他] （事実・誤りを）しぶしぶ認める). `lines`:
 * each part of speech on a line of its own (単語カード).
 */
function EntryMeaning({ w, dict, cued, lines }: { w: RecipeWord; dict: Dictionary | null; cued?: boolean; lines?: boolean }) {
  if (w.kind === "usage") return <SlotText text={w.meaning} />;
  if (w.pos === "idiom") return <>{w.meaning}</>;
  if (cued) return <CuedMeaningWithTags word={w.word} meaning={w.meaning} dict={dict} lines={lines} />;
  return <MeaningWithTags word={w.word} meaning={w.meaning} dict={dict} lines={lines} />;
}

function typedRight(word: RecipeWord, typed: string, dict: Dictionary | null): boolean {
  const t = normalizeAnswer(typed);
  if (!t) return false;
  if (word.kind === "usage") {
    const core = patternCore(typed);
    return spellings(word.word).some((s) => t === normalizeAnswer(s) || (core !== "" && core === patternCore(s)));
  }
  if ([...spellings(word.word), word.form].some((w) => w && normalizeAnswer(w) === t)) return true;
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
  // What was loaded last shows at once, the list loaded afresh behind it (no 読み込み中 in between).
  const [words, setWords] = useState<RecipeWord[] | null>(() => keptData("recipe"));
  const [dict, setDict] = useState<Dictionary | null>(loadedDictionary);
  /** the meanings of every pattern of 用法, the wrong options for a pattern in review */
  const [usagePool, setUsagePool] = useState<Array<[string, string]>>([]);
  const [filter, setFilter] = useState<RecipeTab>("all");
  const [reviewing, setReviewing] = useState<{ target: RecipeTab; mode: RecipeReviewMode; queue: RecipeWord[] } | null>(null);
  const [missedFirst, setMissedFirst] = useState(loadPriority);
  /** each round of review starts from a fresh component */
  const [round, setRound] = useState(0);
  /** the bulk button (すべて習得へ / すべて復習へ / すべて除外 / 一括削除) waiting for a yes */
  const [confirmBulk, setConfirmBulk] = useState<BulkKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<Order>(() => loadListView().order);
  const [posView, setPosView] = useState<PosView>(() => (loadListView().grouped ? "grouped" : "off"));
  const [posMenu, setPosMenu] = useState(false);
  const posBox = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  /** 単語カード: the menu of 日本語→英語 / 英語→日本語, and the cards gone through */
  const [cardMenu, setCardMenu] = useState(false);
  const cardBox = useRef<HTMLDivElement>(null);
  const [carding, setCarding] = useState<{ target: RecipeTab; direction: CardDirection; queue: RecipeWord[] } | null>(null);

  useEffect(() => saveListView(order, posView !== "off"), [order, posView]);
  // A question left open belongs to the tab it was asked in.
  useEffect(() => {
    setConfirmBulk(null);
  }, [filter]);
  useEffect(() => savePriority(missedFirst), [missedFirst]);

  // The part-of-speech menu and the choice of 単語カード close on a click elsewhere or Escape.
  useClickAway(posMenu, posBox, setPosMenu);
  useClickAway(cardMenu, cardBox, setCardMenu);

  const reload = useCallback(async () => {
    const fresh = await api.listRecipeWords();
    keep("recipe", fresh);
    setWords(fresh);
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
    favorite: words.filter(isStarred),
    learning: words.filter((w) => !w.excludedAt && !w.masteredAt),
    mastered: words.filter((w) => !w.excludedAt && w.masteredAt),
    excluded: words.filter((w) => w.excludedAt),
  };
  // Both kinds of review ask about the meaning, so a word without one cannot be quizzed.
  const quizzable = (tab: RecipeTab) => inTab[tab].filter((w) => w.meaning);

  if (carding) {
    return (
      <div className="screen recipe">
        <RecipeCards
          key={round}
          target={carding.target}
          direction={carding.direction}
          queue={carding.queue}
          dict={dict}
          onAgain={(direction, words) => {
            setRound((r) => r + 1);
            setCarding({ ...carding, direction, queue: cardQueue(words, missedFirst) });
          }}
          onDone={() => {
            stopSpeaking();
            setCarding(null);
            void reload();
          }}
          toast={toast}
        />
      </div>
    );
  }

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
            // Words missed in 習得 / 除外 are back in review now; the others are where they were.
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
  // One part of speech shows every word that has it (figure under 名詞 and 動詞 alike); the grouped
  // list puts each word once, under its commonest (`pos`).
  const listed = ordered(onlyPos ? found.filter((w) => w.poses.includes(onlyPos)) : found, order, posView === "grouped");
  const posCount = (pos: RecipePos) => found.filter((w) => w.poses.includes(pos)).length;
  const groupCount = (pos: RecipePos) => found.filter((w) => w.pos === pos).length;

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
  const startCards = (direction: CardDirection) => {
    setCardMenu(false);
    setRound((r) => r + 1);
    setCarding({ target: filter, direction, queue: cardQueue(pool, missedFirst) });
  };

  const mastered = inTab.mastered;

  // The bulk buttons of the tab on show: every word of it, whatever the list is narrowed to, but
  // the starred words for すべて習得へ in 復習.
  const bulkWords = (a: BulkAction) =>
    filter === "learning" && a.kind === "learn" ? inTab.learning.filter((w) => !isStarred(w)) : inTab[filter];
  const bulks = (BULK[filter] ?? []).filter((a) => bulkWords(a).length > 0);
  const asking = bulks.find((a) => a.kind === confirmBulk);
  const runBulk = (a: BulkAction) =>
    run(async () => {
      const ids = bulkWords(a).map((w) => w.id);
      const n =
        a.kind === "delete"
          ? await api.deleteRecipeWords(ids)
          : a.kind === "exclude"
            ? await api.excludeRecipeWords(ids)
            : a.kind === "unstar"
              ? await api.setRecipeWordsFavorite(ids, false)
              : await api.setRecipeWordsMastered(ids, a.kind === "learn");
      setConfirmBulk(null);
      toast(`📖 ${a.done(n)}`);
    });

  return (
    <div className="screen recipe">
      <section className="card">
        <div className="section-head">
          <h2>📖 レシピ</h2>
          <div className="recipe-counts">
            <span>
              材料 <b>{inTab.all.length}</b>語
            </span>
            {inTab.favorite.length > 0 && (
              <span className="recipe-count-star">
                ★ <b>{inTab.favorite.length}</b>
              </span>
            )}
            <span>
              復習 <b>{inTab.learning.length}</b>
            </span>
            <span className="positive">
              習得 <b>{mastered.length}</b>
            </span>
            {inTab.excluded.length > 0 && (
              <span className="negative">
                除外 <b>{inTab.excluded.length}</b>
              </span>
            )}
          </div>
        </div>
        <div className="recipe-intro">
          <p className="recipe-intro-lead">
            問題や解説の英単語を<b>{RIGHT_CLICK}</b>すると、ここに材料として集まります。
          </p>
          <dl className="recipe-guide">
            <dt>選択式・記入式</dt>
            <dd>
              選んでいるタブの単語を復習します。意味を4択で選ぶと 0.5 kcal、英語を書くと 1 kcal が今日のおやつ予算に入ります（同じ日の2回目からは半分）。
            </dd>
            <dt>習得・まだ</dt>
            <dd>「すべて」「復習」で正解したら、覚えたかを自分で選びます。「★」「習得」「除外」では、正解ならそのまま、間違えると復習に戻ります。</dd>
            <dt>
              ☆ <span className="recipe-star-mark">★</span>
            </dt>
            <dd>☆ を押した単語は「★」に入り、正解しても★のまま復習に残ります。習得や除外に移すと★は外れます。</dd>
            <dt>×</dt>
            <dd>単語を「除外」に移します。「除外」のタブで × を押すと完全に削除します。</dd>
            <dt>単語カード</dt>
            <dd>{touchScreen ? "タップ" : "クリック・右クリック・Enter"} でめくって覚えます（カロリーはもらえません）。</dd>
          </dl>
        </div>
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
          <div className="recipe-cards-pick" ref={cardBox}>
            <button
              className="btn recipe-mode-btn cards"
              disabled={busy || pool.length === 0}
              aria-haspopup="menu"
              aria-expanded={cardMenu}
              title="クリックでめくって覚える単語カード（カロリーはもらえません）"
              onClick={() => setCardMenu((m) => !m)}
            >
              <WordCardIcon /> 単語カード
            </button>
            {cardMenu && (
              <div className="recipe-pos-menu recipe-cards-menu" role="menu">
                {CARD_DIRECTIONS.map(({ direction, label, note }) => (
                  <button key={direction} role="menuitem" onClick={() => startCards(direction)}>
                    <span>{label}</span>
                    <small>{note}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className={"switch-btn" + (missedFirst ? " on" : "")}
            aria-pressed={missedFirst}
            title="オンにすると、復習で間違えた回数が多い単語から出題します"
            onClick={() => setMissedFirst((on) => !on)}
          >
            <span className="switch-knob" aria-hidden="true" />
            間違いやすい語を優先
          </button>
          {asking ? (
            <span className="recipe-bulk asking">
              <span>{asking.ask(bulkWords(asking).length)}</span>
              <button
                className={"btn btn-small" + (asking.kind === "delete" ? " btn-danger" : "")}
                disabled={busy}
                onClick={() => void runBulk(asking)}
              >
                {asking.yes}
              </button>
              <button className="btn-link" onClick={() => setConfirmBulk(null)}>
                やめる
              </button>
            </span>
          ) : (
            bulks.length > 0 && (
              <span className="recipe-bulks">
                {bulks.map((a, i) => (
                  <Fragment key={a.kind}>
                    {i > 0 && <span className="recipe-bulk-sep">／</span>}
                    <button className="recipe-bulk" disabled={busy} onClick={() => setConfirmBulk(a.kind)}>
                      {a.label}
                    </button>
                  </Fragment>
                ))}
              </span>
            )
          )}
        </div>
        {inTab[filter].length > pool.length && (
          <p className="muted small">
            辞書に意味のない{inTab[filter].length - pool.length}語は復習に出ません
            {(filter === "learning" || filter === "favorite") && "（一覧の「✓ 覚えた」を押すと習得にできます）"}。
          </p>
        )}
      </section>

      <section className="card">
        {words.length === 0 ? (
          <div className="recipe-empty">
            <div className="recipe-empty-icon">🥣</div>
            <p>まだ材料がありません。</p>
            <p className="muted">学習中に、問題文・正解・完成した文・解説・例文の英単語を{RIGHT_CLICK}してみましょう。</p>
          </div>
        ) : (
          <>
            <div className="recipe-toolbar">
              <div className="segmented recipe-filter">
                {TABS.filter((tab) => tab !== "excluded").map((tab) => (
                  <button
                    key={tab}
                    className={filter === tab ? "active" : ""}
                    title={tab === "favorite" ? "☆ を押した単語（復習中の単語のうち★のもの）" : undefined}
                    onClick={() => setFilter(tab)}
                  >
                    {tab === "favorite" ? <span className="recipe-star-mark">★</span> : TAB_LABEL[tab]} {inTab[tab].length}
                  </button>
                ))}
              </div>
              {/* 除外 stands apart from the others, in light red: words taken off the list. */}
              <button
                className={"recipe-excluded-tab" + (filter === "excluded" ? " active" : "")}
                title="× で外した単語。ここで × を押すと完全に削除、「復習に戻す」で復習に戻ります"
                onClick={() => setFilter("excluded")}
              >
                除外 {inTab.excluded.length}
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
                    ? "習得の単語はまだありません。"
                    : filter === "excluded"
                      ? "除外の単語はありません。一覧で × を押すと、ここに入ります。"
                      : filter === "favorite"
                        ? "★の単語はありません。一覧の ☆ を押すと、ここに入ります。"
                        : filter === "learning"
                          ? "復習の単語はありません。"
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
                        {RECIPE_POS_LABEL[w.pos]} <span>{groupCount(w.pos)}</span>
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
                        title={isOpen ? "閉じる" : "例文・解説と追加日を見る"}
                        onClick={() => toggleOpen(w.id)}
                        onKeyDown={(e) => {
                          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                            e.preventDefault();
                            toggleOpen(w.id);
                          }
                        }}
                      >
                        <span className="recipe-word">
                          <EntryText w={w} text={w.word} />
                        </span>
                        <button
                          className="btn-link speak-btn recipe-speak"
                          onClick={(e) => {
                            e.stopPropagation();
                            sayEntry(w);
                          }}
                          disabled={!isTtsSupported()}
                          title="読み上げる"
                          aria-label={`${w.word} を読み上げる`}
                        >
                          🔊
                        </button>
                        <span className={"recipe-meaning" + (w.meaning ? "" : " muted")}>
                          {w.meaning ? <EntryMeaning w={w} dict={dict} cued /> : NO_MEANING}
                        </span>
                        {/* Sorted by 間違い順, the count the order goes by. */}
                        {order.key === "misses" && w.misses > 0 && (
                          <span className="recipe-misses" title="復習で間違えた回数">
                            間違い {w.misses}回
                          </span>
                        )}
                        {/* At the right end of the row, open or not; a press here does not open the row. */}
                        <span className="recipe-row-actions" onClick={(e) => e.stopPropagation()}>
                          <StarButton
                            on={isStarred(w)}
                            onToggle={() =>
                              run(async () => {
                                const on = !isStarred(w);
                                await api.setRecipeFavorite(w.id, on);
                                toast(on ? starredMessage(w) : `「${w.word}」を★から外しました`);
                              })
                            }
                          />
                          {w.excludedAt ? (
                            <>
                              <button
                                className="btn-small recipe-move"
                                disabled={busy}
                                onClick={() =>
                                  run(async () => {
                                    await api.setRecipeMastered(w.id, false);
                                    toast(`「${w.word}」を復習に戻しました`);
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
                                className={"btn-small recipe-move " + (w.masteredAt ? "" : "eat")}
                                disabled={busy}
                                onClick={() =>
                                  run(async () => {
                                    await api.setRecipeMastered(w.id, !w.masteredAt);
                                    // Learned by hand, a starred word leaves ★.
                                    if (isStarred(w)) toast(`「${w.word}」を習得に移しました（★は外れました）`);
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
                                    toast(`「${w.word}」を除外に移しました${isStarred(w) ? "（★は外れました）" : ""}`);
                                  })
                                }
                              />
                            </>
                          )}
                        </span>
                        <span className="recipe-caret" aria-hidden="true">
                          ▾
                        </span>
                      </div>
                      {isOpen && (
                        <div className="recipe-item-body">
                          <ListedNotes w={w} dict={dict}>
                            {(w.example || w.exampleJa) && (
                              <div className="brief-example">
                                <span className="label">例文</span>
                                <div>
                                  {w.example && (
                                    <div className="recipe-example">
                                      <GlossedText text={w.example} dict={dict} enabled highlight={w.form || w.word} />
                                    </div>
                                  )}
                                  {w.exampleJa && <div className="muted small">{w.exampleJa}</div>}
                                </div>
                              </div>
                            )}
                          </ListedNotes>
                          <div className="recipe-item-foot muted small">
                            {w.poses.map((p) => RECIPE_POS_LABEL[p]).join("・")}
                            {shownForm(w) && `・「${shownForm(w)}」から登録`}・{stamp(w.addedAt)} に追加
                            {w.reviews > 0 && `・復習 ${w.reviews}回`}
                            {w.misses > 0 && `・間違い ${w.misses}回`}
                            {w.masteredAt && !w.excludedAt && `・${stamp(w.masteredAt)} に習得`}
                            {w.excludedAt && `・${stamp(w.excludedAt)} に除外`}
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

/** What each word's review explains, kept once fetched (a row opened again, or the list read again). */
const listedNotes = new Map<string, WordNotes | null>();

/**
 * A row of the list opened: its 対義語 and 成り立ち, the sentence it was saved with (`children`),
 * and 用法 / 類似表現 to open (as its review explains them), fetched when the row is first opened.
 */
function ListedNotes({ w, dict, children }: { w: RecipeWord; dict: Dictionary | null; children?: ReactNode }) {
  const key = `${w.word}
${w.meaning}`;
  const [notes, setNotes] = useState<WordNotes | null | undefined>(() => listedNotes.get(key));
  useEffect(() => {
    if (listedNotes.has(key)) {
      setNotes(listedNotes.get(key));
      return;
    }
    let alive = true;
    api
      .getWordNotes(w.word, w.meaning || undefined)
      .then((n) => {
        listedNotes.set(key, n);
        if (alive) setNotes(n);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [key, w.word, w.meaning]);
  return (
    <WordNotesBrief notes={notes ?? null} word={w.word} meaning={w.meaning} dict={dict}>
      {children}
    </WordNotesBrief>
  );
}

/* ---------- review: 選択 / 記入 ---------- */

interface Answered {
  correct: boolean;
  /** the option picked, or what was typed */
  given: string;
  /** what it paid after the play mode, in kcal: full the first time the word is right today, half after */
  points: number;
  /** wrong: whether the word went back into review from 習得 / 除外, or was there already */
  movedBack: boolean;
  /** right in すべて / 復習 and not starred: 習得 / まだ are asked (a starred word stays in review) */
  decides: boolean;
  /** the word is starred: it stays in ★ whatever the answer */
  starred: boolean;
  /** right in すべて / 復習, and the first time today: explain 習得 / まだ */
  decideHint: boolean;
  /** right in すべて / 復習 but starred, the first time today: say why there is no 習得 / まだ */
  starredHint: boolean;
  /** right again the same day, the first time this happens today: say why it paid half */
  repeatNote: boolean;
}

/** How 習得 / まだ work after a right answer in すべて / 復習中. */
const DECIDE_HINT = "覚えたなら「習得」で習得に。なんとなく当たっただけなら「まだ」で復習に残します。";
/** Why a starred word answered right in すべて / 復習 has no 習得 / まだ. */
const STARRED_HINT = "★の単語は、正解しても★のまま復習に残ります（習得にするなら一覧の「✓ 覚えた」）。";

/**
 * Whether a right answer in this tab asks 習得 / まだ: only where it would make the word learned
 * (すべて / 復習), and not for a starred word, which stays in review. In ★ / 習得 / 除外 a right
 * answer leaves the word where it is.
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
  /** the tab the words come from: すべて / 復習 move right answers to 習得 and ask 習得 / まだ,
   * ★ / 習得 / 除外 leave right answers where they are; wrong ones go back to 復習 from any */
  target: RecipeTab;
  mode: RecipeReviewMode;
  queue: RecipeWord[];
  /** the whole recipe, whose meanings serve as wrong options */
  words: RecipeWord[];
  dict: Dictionary | null;
  /** every pattern's meaning with a pattern of it (recipe::usage_meanings) */
  usagePool: Array<[string, string]>;
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
  /** words taken out with × after their answer */
  const [removed, setRemoved] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const stars = useStars(queue, toast);

  const current = queue[idx];
  const finished = idx >= queue.length;
  const tabDecides = asksDecision(target);
  // × after an answer: to 除外 from すべて / ★ / 復習 / 習得, out of the recipe from 除外.
  const deletes = target === "excluded";
  // Drawn once per card: a word saved mid-review reloads the recipe, and that must not reshuffle
  // the options under the learner. Only the dictionary or the patterns' meanings arriving late
  // redraw (the first card).
  const tags = useWordTags();
  const cues = tags?.cues ?? null;
  const options = useMemo(
    () =>
      current && mode === "choice"
        ? meaningOptions(
            current,
            words,
            dict,
            usagePool.map(([ja]) => ja),
            cues,
          )
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current, mode, dict === null, usagePool.length === 0, cues === null],
  );
  const labels = useMemo(
    () => (current ? optionLabels(current, options, words, dict, cues) : options),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options, cues === null],
  );
  // Once answered, each wrong option shows the English it stands for, as in the study's 選択問題:
  // beside the Japanese, or all on a second line when one is long. A click on it reads it aloud.
  const optionEn = useMemo(() => {
    if (!current) return [];
    const patterns = new Map(usagePool);
    return options.map((o) => (o === current.meaning ? undefined : optionSource(current, o, words, dict, patterns)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options]);
  const enBelow = optionEn.some((en) => !!en && (en.split(" ").length > 3 || en.length > 22));
  const [saying, setSaying] = useState<number | null>(null);
  const sayOption = (i: number, en: string) => {
    setSaying(i);
    void sayEntry({ kind: current.kind === "usage" ? "usage" : "word", word: en }).finally(() =>
      setSaying((cur) => (cur === i ? null : cur)),
    );
  };
  // A word with near synonyms is asked to be written from its nuance: （事実・誤りを）しぶしぶ認める.
  const asked = current && current.kind !== "usage" && cues ? (cuedMeaning(current.word, current.meaning, cues) ?? current.meaning) : current?.meaning;
  const gapped = useMemo(() => (current ? withGap(current) : null), [current]);
  // The same explanation a word question shows under its answer: how the word is built, sentences
  // and patterns using it, an idiom's origin. Fetched with the card, shown once it is answered.
  const [notes, setNotes] = useState<{ word: string; notes: WordNotes | null } | null>(null);
  const word = current?.word;
  const meaning = current?.meaning;
  useEffect(() => {
    if (!word) return;
    let alive = true;
    api
      .getWordNotes(word, meaning)
      .then((n) => alive && setNotes({ word, notes: n }))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [word]);

  useEffect(() => {
    if (!current) return;
    // Writing the English: hearing it first would give the answer away.
    if (mode === "choice") sayEntry(current);
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
        // Starred as the answer was saved (it may have been starred or unstarred on this card).
        const starred = !!r.entry.favoritedAt && !r.entry.excludedAt;
        const decides = correct && tabDecides && !starred;
        if (correct) {
          // Right in すべて / 復習 has made the word learned already; 習得 keeps that, まだ takes it
          // back into review (see `decide`). A starred word, and any in ★ / 習得 / 除外, stays where it is.
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
          decides,
          starred,
          decideHint: decides && firstToday("decide"),
          starredHint: correct && tabDecides && starred && firstToday("starred"),
          repeatNote: correct && r.repeat && firstToday("repeat"),
        });
        if (r.kcalEarned > 0) onProgress();
        if (mode === "typing") window.setTimeout(() => sayEntry(current), 380);
      } catch (e) {
        toast(String(e));
      } finally {
        setSaving(false);
      }
    },
    [current, saving, answered, mode, target, tabDecides, onProgress, toast],
  );

  const next = useCallback(() => {
    stopSpeaking();
    setAnswered(null);
    setTyped("");
    setIdx((i) => i + 1);
  }, []);

  // After a right answer in すべて / 復習: 習得 keeps the word in 習得, where the answer put it, and
  // takes its star off (set again, in case it was starred since); まだ puts it back into review,
  // star and all, so a lucky guess does not make a word learned.
  const decide = useCallback(
    async (learned: boolean) => {
      if (!current || !answered?.decides || saving) return;
      setSaving(true);
      try {
        if (learned) {
          await api.setRecipeMastered(current.id, true);
          stars.unstar(current.id);
          setRemembered((w) => [...w, current]);
        } else {
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
    [current, answered, saving, next, toast, stars],
  );

  // × after an answer: a word not worth reviewing any more goes at once, whatever the answer did
  // to it, and the review moves on. It no longer counts among the words remembered or to try again.
  const remove = useCallback(async () => {
    if (!current || !answered || saving) return;
    setSaving(true);
    try {
      if (deletes) await api.deleteRecipeWords([current.id]);
      else await api.excludeRecipeWords([current.id]);
      setRemembered((w) => w.filter((x) => x.id !== current.id));
      setLeft((w) => w.filter((x) => x.id !== current.id));
      setRemoved((n) => n + 1);
      stars.unstar(current.id);
      toast(deletes ? `「${current.word}」をレシピから削除しました` : `「${current.word}」を除外に移しました`);
      next();
    } catch (e) {
      toast(String(e));
    } finally {
      setSaving(false);
    }
  }, [current, answered, saving, deletes, next, toast, stars]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (finished) return;
      // A right answer in すべて / 復習 waits for 習得 / まだ; any other answer moves on with Enter.
      if (answered && !answered.decides && (e.key === "Enter" || e.key === " ")) {
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

  if (finished) {
    // Without 習得 / まだ (★, 習得, 除外), a right answer was remembered and a wrong one forgotten.
    const again = !tabDecides;
    const clearRemembered = async () => {
      setSaving(true);
      try {
        const n = await api.excludeRecipeWords(remembered.map((w) => w.id));
        setCleared(true);
        toast(`📖 ${again ? "覚えていた" : "覚えた"}${n}語を除外に移しました`);
      } catch (e) {
        toast(String(e));
      } finally {
        setSaving(false);
      }
    };
    const summary =
      target === "mastered"
        ? "正解した単語は習得のまま、間違えた単語は復習に戻しました。"
        : target === "excluded"
          ? "正解した単語は除外のまま、間違えた単語は復習に戻しました。"
          : target === "favorite"
            ? "★の単語は、正解しても間違えても★のまま（復習）です。覚えた単語は一覧の「✓ 覚えた」で習得に移せます。"
            : "「習得」にした単語は習得になりました。間違えた単語と「まだ」にした単語、★の単語は復習です。";
    return (
      <section className="card recipe-review done">
        <h2>📖 復習おしまい！</h2>
        <div className="recipe-counts big">
          <span className="positive">
            {again ? "覚えていた" : "覚えた"} <b>{remembered.length}</b>語
          </span>
          <span>
            {again ? "忘れていた" : "まだ"} <b>{left.length}</b>語
          </span>
          {removed > 0 && (
            <span>
              {deletes ? "削除した" : "除外した"} <b>{removed}</b>語
            </span>
          )}
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
              {again ? "覚えていた" : "覚えた"}{remembered.length}語を除外に移す
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

  // In the other corner: ☆ / ★, before or after the answer.
  const starButton = (
    <StarButton className="recipe-review-star" on={stars.has(current.id)} onToggle={() => void stars.toggle(current)} />
  );

  // Up in the card's corner, away from 習得 / まだ and 次へ under the answer.
  const removeButton = answered ? (
    <button
      type="button"
      className="recipe-review-remove"
      disabled={saving}
      title={deletes ? "この単語をレシピから完全に削除" : "この単語をレシピから除外（もう復習しない）"}
      onClick={() => void remove()}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
      {deletes ? "削除" : "除外"}
    </button>
  ) : null;

  return (
    <div className="review-stack">
      <div className="section-head review-head">
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

      <section className="card recipe-review">
        {mode === "choice" ? (
          <div className="flash" key={current.id}>
            {starButton}
            {removeButton}
            <div className="prompt-label">この英語の意味は？</div>
            <button
              className="flash-word"
              onClick={() => sayEntry(current)}
              title="クリックで発音"
            >
              <EntryText w={current} text={current.word} />
            </button>
            {example}
            <div className="options recipe-options">
              {options.map((opt, i) => {
                let cls = "option";
                if (answered) {
                  if (opt === current.meaning) cls += " correct";
                  else if (opt === answered.given) cls += " wrong";
                }
                const en = answered ? optionEn[i] : undefined;
                const body = (
                  <>
                    <span className="option-num">{i + 1}</span>
                    <span className="option-text">
                      <span>
                        <EntryText w={current} text={labels[i] ?? opt} />
                      </span>
                      {en && (
                        <span className={"option-en" + (enBelow ? " below" : "")} lang="en">
                          {current.kind === "usage" ? (
                            <SlotText text={en} />
                          ) : (
                            <GlossedText text={en} dict={dict} enabled={false} context="" speakOnClick={false} />
                          )}
                        </span>
                      )}
                    </span>
                  </>
                );
                // Answered, an option is something to read and hear rather than a control (a click
                // inside a disabled button does not bubble past it in Chromium).
                if (answered) {
                  const speaks = !!en && isTtsSupported();
                  return (
                    <div
                      key={opt + i}
                      className={cls + (speaks ? " speaks" : "") + (saying === i ? " saying" : "")}
                      title={speaks ? "クリックで読み上げ" : undefined}
                      onClick={speaks ? () => sayOption(i, en) : undefined}
                    >
                      {body}
                    </div>
                  );
                }
                return (
                  <button key={opt + i} className={cls} disabled={saving} onClick={() => void answer(opt === current.meaning, opt)}>
                    {body}
                  </button>
                );
              })}
            </div>
            {!answered && <div className="muted small keys-hint">キーボードの 1〜4 でも回答できます</div>}
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
            {starButton}
            {removeButton}
            <div className="prompt-label">この意味の英語は？</div>
            <div className="flash-meaning">
              <EntryText w={current} text={asked ?? current.meaning} />
            </div>
            {current.kind === "usage" && (
              <div className="muted small">
                <SlotText text="用法の A・B・人・-ing・原形・形容詞・節 の部分は書かなくてもかまいません" />
              </div>
            )}
            {answered ? example : gapped && <div className="flash-example">{gapped}</div>}
            {current.exampleJa && <div className="muted">{current.exampleJa}</div>}
            <input
              ref={input}
              className="answer-input recipe-input"
              value={typed}
              disabled={!!answered || saving}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={touchScreen ? "英語で入力" : "英語で入力して Enter"}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              enterKeyHint="send"
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
          <div className={"feedback " + (answered.correct ? "ok" : "ng")} ref={revealOnTouch}>
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
                <span className="label">正解</span>{" "}
                {/* The entry reads aloud on a click, as its 対義語 does: no 🔊 もう一度聞く. */}
                <strong
                  className="say-whole"
                  role={isTtsSupported() ? "button" : undefined}
                  title={isTtsSupported() ? "クリックで読み上げ" : undefined}
                  onClick={() => void sayEntry(current)}
                >
                  <EntryText w={current} text={current.word} />
                </strong>
                {shownForm(current) && <span className="muted">（{shownForm(current)}）</span>}　<EntryMeaning w={current} dict={dict} />
                {notes?.word === current.word && notes.notes?.antonym && <AntonymTag antonym={notes.notes.antonym} dict={dict} />}
              </div>
              {notes?.word === current.word && notes.notes && (
                <WordNotesPanel notes={notes.notes} word={current.word} meaning={current.meaning} dict={dict} gloss />
              )}
              {(answered.correct ? answered.decideHint || answered.starredHint || answered.repeatNote : true) && (
                <div className="muted">
                  {answered.correct
                    ? [
                        answered.decideHint && DECIDE_HINT,
                        answered.starredHint && STARRED_HINT,
                        answered.repeatNote &&
                          `この単語は今日2回目以降の正解なので、カロリーは半分（${REPEAT_KCAL[mode]} kcal${playMode === "normal" ? "" : `、${PLAY_MODE_INFO[playMode].label} ×${PLAY_MODE_INFO[playMode].multiplier} の前`}）です。`,
                      ]
                        .filter(Boolean)
                        .join(" ")
                    : answered.movedBack
                      ? "復習に戻しました。最後にもう一度挑戦できます。"
                      : answered.starred
                        ? "★のまま残ります。最後にもう一度挑戦できます。"
                        : "復習のまま残ります。最後にもう一度挑戦できます。"}
                </div>
              )}
            </div>
            {answered.decides ? (
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
                {idx + 1 >= queue.length ? "結果を見る" : withEnter("次へ")}
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

/** Whether a click or Enter landed on something that does its own thing (🔊, やめる, the header's tabs). */
function onControl(e: Event): boolean {
  return e.target instanceof Element && !!e.target.closest("button, a, input, select, textarea, label");
}

/**
 * 単語カード: a tab's words one card at a time, for remembering rather than scoring. 日本語→英語
 * shows the meaning (by its nuance, as 記入式 asks it) and then the English, 英語→日本語 the English
 * and then the meaning. A click anywhere on the screen, a right-click or Enter shows the other side,
 * and the next one goes on to the next word. The English is read aloud when it shows (a pattern
 * without what fills it: `readings`). A meaning has its tags, each part of speech on a line of its own
 * ([名] 場所、地点 above [他] 見つける). Nothing is recorded and nothing is paid.
 */
function RecipeCards({
  target,
  direction,
  queue,
  dict,
  onAgain,
  onDone,
  toast,
}: {
  target: RecipeTab;
  direction: CardDirection;
  queue: RecipeWord[];
  dict: Dictionary | null;
  /** once more, shuffled again, the same way round or turned */
  onAgain: (direction: CardDirection, words: RecipeWord[]) => void;
  onDone: () => void;
  toast: (msg: string) => void;
}) {
  const [idx, setIdx] = useState(0);
  const [turned, setTurned] = useState(false);
  const stars = useStars(queue, toast);
  /** words taken out with × on their card: to 除外, or out of the recipe from 除外 */
  const [removed, setRemoved] = useState<ReadonlySet<number>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const deletes = target === "excluded";
  const current = queue[idx];
  const finished = idx >= queue.length;
  const cues = useWordTags()?.cues ?? null;
  // The meaning asked by its nuance differs from the one in the recipe: the latter is shown with the answer.
  const cued = !!current && current.kind !== "usage" && !!cues && (cuedMeaning(current.word, current.meaning, cues) ?? current.meaning) !== current.meaning;
  const englishShown = direction === "en-ja" || turned;

  useEffect(() => {
    if (current && englishShown) sayEntry(current);
  }, [current, englishShown]);

  const flip = useCallback(() => {
    if (finished) return;
    if (!turned) {
      setTurned(true);
      return;
    }
    stopSpeaking();
    setTurned(false);
    setIdx((i) => i + 1);
  }, [finished, turned]);

  // Anywhere on the screen. The click that opened the cards (or turned the last one) is still on its
  // way up to the window when this listens again, so only what happens after is taken.
  useEffect(() => {
    if (finished) return;
    const since = performance.now();
    const fresh = (e: Event) => e.timeStamp >= since;
    const click = (e: MouseEvent) => {
      if (e.button === 0 && fresh(e) && !onControl(e)) flip();
    };
    const rightClick = (e: MouseEvent) => {
      if (!fresh(e)) return;
      e.preventDefault();
      flip();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.repeat || !fresh(e)) return;
      e.preventDefault();
      flip();
    };
    window.addEventListener("click", click);
    window.addEventListener("contextmenu", rightClick);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("click", click);
      window.removeEventListener("contextmenu", rightClick);
      window.removeEventListener("keydown", key);
    };
  }, [finished, flip]);

  // × on a card: the word goes at once, as in a review, and the next card shows.
  const remove = async () => {
    if (!current || saving) return;
    setSaving(true);
    try {
      if (deletes) await api.deleteRecipeWords([current.id]);
      else await api.excludeRecipeWords([current.id]);
      stars.unstar(current.id);
      setRemoved((r) => new Set(r).add(current.id));
      toast(deletes ? `「${current.word}」をレシピから削除しました` : `「${current.word}」を除外に移しました`);
      stopSpeaking();
      setTurned(false);
      setIdx((i) => i + 1);
    } catch (e) {
      toast(String(e));
    } finally {
      setSaving(false);
    }
  };

  const head = (
    <h2>
      <WordCardIcon /> 単語カード <span className={"pill recipe-tab-pill " + target}>{TAB_LABEL[target]}</span>{" "}
      <span className="pill">{CARD_DIRECTION_LABEL[direction]}</span> <span className="pill muted">カロリーなし</span>
    </h2>
  );

  if (finished) {
    const turnedDirection: CardDirection = direction === "ja-en" ? "en-ja" : "ja-en";
    // Once more without the words taken out on the way.
    const left = queue.filter((w) => !removed.has(w.id));
    return (
      <section className="card recipe-review recipe-cards done">
        <div className="section-head review-head">{head}</div>
        <p className="recipe-cards-done">
          📖 {queue.length}語のカードをめくり終えました！
          {removed.size > 0 && `（${deletes ? "削除した" : "除外した"} ${removed.size}語）`}
        </p>
        <div className="row recipe-actions">
          {left.length > 0 && (
            <>
              <button className="btn btn-primary" onClick={() => onAgain(direction, left)}>
                もう一度（並びを変えて）
              </button>
              <button className="btn" onClick={() => onAgain(turnedDirection, left)}>
                {CARD_DIRECTION_LABEL[turnedDirection]}でもう一度
              </button>
            </>
          )}
          <button className="btn" onClick={onDone}>
            レシピに戻る
          </button>
        </div>
      </section>
    );
  }

  const speakButton = (
    <button
      type="button"
      className="btn-link speak-btn"
      onClick={() => sayEntry(current)}
      disabled={!isTtsSupported()}
      title="読み上げる"
      aria-label="読み上げる"
    >
      🔊
    </button>
  );
  const english = (
    <div className="flash-word">
      <EntryText w={current} text={current.word} />
      {shownForm(current) && <span className="recipe-card-form">（{shownForm(current)}）</span>}
      {speakButton}
    </div>
  );

  return (
    <div className="review-stack">
      <div className="section-head review-head">
        {head}
        <div className="study-progress">
          {idx + 1} / {queue.length}
          <div className="mini-bar">
            <div style={{ width: `${((idx + (turned ? 1 : 0)) / queue.length) * 100}%` }} />
          </div>
        </div>
        <button className="btn-link" onClick={onDone}>
          やめる
        </button>
      </div>

      <section className="card recipe-review recipe-cards">
        <div className={"word-card" + (turned ? " turned" : "")} key={current.id}>
          <span className="word-card-remove">
            <DeleteButton
              label={deletes ? "この単語をレシピから完全に削除" : "この単語をレシピから除外（もう復習しない）"}
              disabled={saving}
              onClick={() => void remove()}
            />
          </span>
          <StarButton className="word-card-star" on={stars.has(current.id)} onToggle={() => void stars.toggle(current)} />
          {direction === "ja-en" ? (
            <div className="flash-meaning">
              <EntryMeaning w={current} dict={dict} cued lines />
            </div>
          ) : (
            english
          )}
          {turned && (
            <div className="word-card-back">
              {direction === "ja-en" ? (
                <>
                  {english}
                  {cued && (
                    <div className="muted">
                      <EntryMeaning w={current} dict={dict} lines />
                    </div>
                  )}
                </>
              ) : (
                <div className="flash-meaning">
                  <EntryMeaning w={current} dict={dict} lines />
                </div>
              )}
              {current.example && <div className="flash-example">{current.example}</div>}
              {current.exampleJa && <div className="muted">{current.exampleJa}</div>}
            </div>
          )}
        </div>
        <p className="word-card-hint">
          {touchScreen ? "タップ" : "クリック・右クリック・Enter"} で
          {turned ? (idx + 1 >= queue.length ? "おしまい" : "次の単語へ") : direction === "ja-en" ? "英語を表示" : "意味を表示"}
        </p>
      </section>
    </div>
  );
}
