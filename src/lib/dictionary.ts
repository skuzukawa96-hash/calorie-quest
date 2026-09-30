// Hover dictionary: English word → Japanese gloss.
// The backend already expands inflected forms, so a lookup is normally a single map hit;
// the lemma fallback keeps it working for text the backend has never seen.
import { api } from "./api";

/** Splits English text into lookup-ready words. Mirrors `util::tokens` in the Rust backend. */
/**
 * Mirrors `util::tokens`: accents, digits and the dots inside an abbreviation belong to the word,
 * and digit-only runs are dropped.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^\p{L}\p{N}'.]+/gu, " ")
    .split(/\s+/)
    .map(normalizeWord)
    .filter((w) => /\p{L}/u.test(w));
}

export function normalizeWord(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/^['.]+|['.]+$/g, "")
    .replace(/'s$/, "");
}

/** Irregular verb forms, which no suffix rule can undo. Mirrors `util::IRREGULAR`. */
const IRREGULAR: Record<string, string> = {
  was: "be", were: "be", been: "be", is: "be", are: "be", am: "be",
  had: "have", has: "have", did: "do", does: "do", done: "do",
  went: "go", gone: "go", came: "come", saw: "see", seen: "see",
  took: "take", taken: "take", made: "make", said: "say", got: "get",
  gotten: "get", knew: "know", known: "know", thought: "think",
  found: "find", told: "tell", became: "become", left: "leave",
  felt: "feel", brought: "bring", began: "begin", begun: "begin",
  kept: "keep", held: "hold", wrote: "write", written: "write",
  stood: "stand", heard: "hear", meant: "mean", met: "meet", ran: "run",
  paid: "pay", sat: "sit", spoke: "speak", spoken: "speak", led: "lead",
  grew: "grow", grown: "grow", lost: "lose", fell: "fall", fallen: "fall",
  sent: "send", built: "build", understood: "understand", drew: "draw",
  drawn: "draw", broke: "break", broken: "break", spent: "spend",
  rose: "rise", risen: "rise", drove: "drive", driven: "drive",
  bought: "buy", wore: "wear", worn: "wear", chose: "choose",
  chosen: "choose", ate: "eat", eaten: "eat", gave: "give", given: "give",
  slept: "sleep", won: "win", taught: "teach", caught: "catch",
  bitten: "bite", threw: "throw", thrown: "throw", stole: "steal",
  stolen: "steal", bent: "bend", forgot: "forget", forgotten: "forget",
  swam: "swim", drank: "drink", drunk: "drink", sang: "sing", sung: "sing",
  woke: "wake", woken: "wake", hung: "hang", blew: "blow", blown: "blow",
  flew: "fly", flown: "fly", slid: "slide", swum: "swim", lent: "lend",
  stuck: "stick", swept: "sweep", dug: "dig", hid: "hide", shook: "shake",
  rang: "ring", rung: "ring", sank: "sink", laid: "lay", sold: "sell",
};

/** Candidate dictionary forms for an inflected word. Mirrors `util::lemmas`. */
export function lemmas(word: string): string[] {
  const w = word.toLowerCase();
  const out = [w];
  if (IRREGULAR[w]) out.push(IRREGULAR[w]);
  const n = w.length;
  const cut = (k: number) => w.slice(0, Math.max(0, n - k));
  const doubled = (k: number) => n > k + 1 && w[n - k - 1] === w[n - k - 2];

  if (w.endsWith("ies") && n > 3) out.push(cut(3) + "y");
  if (w.endsWith("es") && n > 2) out.push(cut(2));
  if (w.endsWith("s") && n > 1) out.push(cut(1));
  if (w.endsWith("ied") && n > 3) out.push(cut(3) + "y");
  if (w.endsWith("ed") && n > 2) {
    out.push(cut(2), cut(1));
    if (doubled(2)) out.push(cut(3));
  }
  if (w.endsWith("ing") && n > 3) {
    out.push(cut(3), cut(3) + "e");
    if (doubled(3)) out.push(cut(4));
  }
  if (w.endsWith("er") && n > 2) {
    out.push(cut(2), cut(1));
    if (doubled(2)) out.push(cut(3));
  }
  if (w.endsWith("est") && n > 3) {
    out.push(cut(3), cut(2));
    if (doubled(3)) out.push(cut(4));
  }
  if (w.endsWith("ly") && n > 2) out.push(cut(2));
  // Words ending in -y switch to -i before a suffix (busy → busier, early → earliest).
  for (const c of [...out]) {
    if (c.endsWith("i")) out.push(c.slice(0, -1) + "y");
  }
  return out.filter(Boolean);
}

export type Dictionary = Record<string, string>;

export function lookup(dict: Dictionary | null, rawWord: string): string | undefined {
  if (!dict) return undefined;
  const w = normalizeWord(rawWord);
  if (!w) return undefined;
  const direct = dict[w];
  if (direct) return direct;
  for (const l of lemmas(w)) {
    if (dict[l]) return dict[l];
  }
  return undefined;
}

/**
 * The dictionary form of a word in running text, with its meaning: "heard" → hear 聞く.
 * The backend files every inflected form it has seen under its own key, so "heard" is a key too;
 * the headword is the lemma carrying the same meaning. A form whose lemma means something else
 * stays as it is ("glasses" メガネ is not "glass" ガラス).
 */
export function headword(dict: Dictionary | null, rawWord: string): { word: string; meaning: string } {
  const form = normalizeWord(rawWord);
  const meaning = lookup(dict, rawWord);
  if (!dict || !meaning) {
    // Unknown words keep their spelling, so a name like "Kyoto" is not saved as "kyoto".
    return { word: rawWord.replace(/[’']s$/, "").replace(/^['.]+|['.]+$/g, ""), meaning: "" };
  }
  const lemma = lemmas(form).find((l) => l !== form && dict[l] === meaning);
  return { word: lemma ?? form, meaning };
}

/** Expands a base dictionary so every word used in `texts` is a key of its own. */
export function expandDictionary(base: Dictionary, texts: string[]): Dictionary {
  const out: Dictionary = { ...base };
  for (const text of texts) {
    for (const word of tokenize(text)) {
      if (out[word]) continue;
      for (const l of lemmas(word)) {
        if (base[l]) {
          out[word] = base[l];
          break;
        }
      }
    }
  }
  return out;
}

/* ---------- multi-word expressions (mirrors PhraseIndex in util.rs) ---------- */

const POSSESSIVES = new Set(["my", "your", "his", "her", "its", "our", "their"]);
const OBJECTS = new Set(["me", "you", "him", "her", "it", "us", "them"]);
const REFLEXIVES = new Set([
  "myself", "yourself", "himself", "herself", "itself", "ourselves", "yourselves", "themselves", "oneself",
]);

/** Idioms use a stand-in pronoun ("keep your fingers crossed") that the sentence fills in. */
function placeholderMatches(pattern: string, word: string): boolean {
  switch (pattern) {
    case "your": case "my": case "his": case "her": case "their": case "our": case "its":
      return POSSESSIVES.has(word);
    case "someone": case "somebody": case "one":
      return POSSESSIVES.has(word) || OBJECTS.has(word);
    case "yourself": case "oneself":
      return REFLEXIVES.has(word);
    default:
      return false;
  }
}

function phraseTokenMatches(pattern: string, word: string): boolean {
  return pattern === word || placeholderMatches(pattern, word) || lemmas(word).includes(pattern);
}

export interface PhraseSpan {
  /** first word, inclusive, over the sentence's words */
  start: number;
  /** last word, exclusive */
  end: number;
  /** the phrase's dictionary form, which is also its key in the dictionary */
  key: string;
}

export interface PhraseIndex {
  byFirst: Map<string, { words: string[]; key: string }[]>;
}

/** Every multi-word key of the dictionary, filed under the word it starts with. */
export function buildPhraseIndex(dict: Dictionary): PhraseIndex {
  const byFirst = new Map<string, { words: string[]; key: string }[]>();
  for (const key of Object.keys(dict)) {
    const words = tokenize(key);
    if (words.length < 2) continue;
    const list = byFirst.get(words[0]) ?? [];
    list.push({ words, key });
    byFirst.set(words[0], list);
  }
  // Longest first, so "real estate agent" wins over a shorter phrase at the same spot.
  for (const list of byFirst.values()) {
    list.sort((a, b) => b.words.length - a.words.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  return { byFirst };
}

function firstWordCandidates(word: string): string[] {
  const out = lemmas(word);
  if (POSSESSIVES.has(word)) out.push("your", "my", "his", "her", "their", "our", "its", "someone", "somebody", "one");
  if (OBJECTS.has(word)) out.push("someone", "somebody", "one");
  if (REFLEXIVES.has(word)) out.push("yourself", "oneself");
  return [...new Set(out)].sort();
}

/** Left to right, longest match first; words covered by one phrase never start another. */
export function phraseSpans(words: string[], index: PhraseIndex): PhraseSpan[] {
  const out: PhraseSpan[] = [];
  let i = 0;
  while (i < words.length) {
    let best: { n: number; key: string } | null = null;
    for (const first of firstWordCandidates(words[i])) {
      for (const p of index.byFirst.get(first) ?? []) {
        if (i + p.words.length > words.length || (best && best.n >= p.words.length)) continue;
        if (p.words.every((w, k) => phraseTokenMatches(w, words[i + k]))) best = { n: p.words.length, key: p.key };
      }
    }
    if (best) {
      out.push({ start: i, end: i + best.n, key: best.key });
      i += best.n;
    } else {
      i += 1;
    }
  }
  return out;
}

/** Which of a dictionary's phrases are idioms, recorded when the dictionary is loaded. */
const idiomKeys = new WeakMap<Dictionary, Set<string>>();

/**
 * Whether a phrase key is an idiom, which the words may also spell out literally: "The cat is
 * under the table" is about where the cat is, not about something done secretly. Compounds such
 * as "doggy bag" have only the one reading.
 */
export function isIdiom(dict: Dictionary | null, key: string): boolean {
  return !!dict && (idiomKeys.get(dict)?.has(key) ?? false);
}

let cached: Promise<Dictionary> | null = null;

export function loadDictionary(): Promise<Dictionary> {
  if (!cached) {
    cached = Promise.all([
      api.getDictionary().catch(() => ({}) as Dictionary),
      api.getIdioms().catch(() => [] as string[]),
    ]).then(([dict, idioms]) => {
      idiomKeys.set(dict, new Set(idioms));
      return dict;
    });
  }
  return cached;
}
