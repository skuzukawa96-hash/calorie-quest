// IPA for the speaking questions. The table comes from the backend once (CMU Pronouncing
// Dictionary, see `db::pronunciations`); each word maps to its sounds separated by spaces.
import { api } from "./api";

export type Pronunciations = Record<string, string>;

let loading: Promise<Pronunciations> | null = null;

export function loadPronunciations(): Promise<Pronunciations> {
  if (!loading) {
    loading = api.getPronunciations().catch((e) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}

export interface IpaWord {
  /** the word as written in the sentence */
  word: string;
  /** its sounds ("ˈ", "l", "aɪ", …), or null when the dictionary does not have it */
  sounds: string[] | null;
}

/** The sentence's words with their sounds; the split matches `scripts/make_pronunciations.py`. */
export function ipaWords(text: string, table: Pronunciations): IpaWord[] {
  return (text.replace(/’/g, "'").match(/[A-Za-z']+/g) ?? [])
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean)
    .map((word) => {
      const ipa = table[word.toLowerCase()];
      return { word, sounds: ipa ? ipa.split(" ") : null };
    });
}
