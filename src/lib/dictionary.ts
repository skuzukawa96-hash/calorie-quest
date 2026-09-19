// Hover dictionary: English word → Japanese gloss.
// The backend already expands inflected forms, so a lookup is normally a single map hit;
// the lemma fallback keeps it working for text the backend has never seen.
import { api } from "./api";

/** Splits English text into lookup-ready words. Mirrors `util::tokens` in the Rust backend. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z']+/g, " ")
    .split(/\s+/)
    .map(normalizeWord)
    .filter(Boolean);
}

export function normalizeWord(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/^'+|'+$/g, "")
    .replace(/'s$/, "");
}

/** Candidate dictionary forms for an inflected word. Mirrors `util::lemmas`. */
export function lemmas(word: string): string[] {
  const w = word.toLowerCase();
  const out = [w];
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
