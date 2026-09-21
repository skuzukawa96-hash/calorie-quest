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
  rang: "ring", rung: "ring", sank: "sink", laid: "lay",
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

let cached: Promise<Dictionary> | null = null;

export function loadDictionary(): Promise<Dictionary> {
  if (!cached) {
    cached = api.getDictionary().catch(() => ({}) as Dictionary);
  }
  return cached;
}
