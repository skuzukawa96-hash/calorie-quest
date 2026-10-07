// No import of the api here: the mock backend uses posFromGloss while it loads.
import type { PartOfSpeech, PosTag, TagSense, VerbType, WordTags } from "../types";

/**
 * Mirrors db::pos_from_gloss: 走る a verb, 美しい an adjective, ゆっくりと an adverb, else a noun;
 * an English -ly glossed 〜く is an adverb (quickly すばやく), not a verb like 書く.
 */
export function posFromGloss(ja: string, en = ""): PartOfSpeech {
  const first = (ja.split(/[、，,]/)[0] ?? "").replace(/（[^）]*）|\([^)]*\)/g, "").trim();
  if (/[にと]$/.test(first)) return "adverb";
  if (/[うくぐすつぬぶむる]$/.test(first)) return first.endsWith("く") && /ly$/i.test(en.trim()) ? "adverb" : "verb";
  if (/[いなの的ただてで]$/.test(first)) return "adjective";
  return "noun";
}

/** The senses of a gloss, notes in （ ） left out: "（傷が）治る、治す" is 治る and 治す. */
function senses(ja: string): string[] {
  return ja
    .split(/[、，,／/]/)
    .map((s) => s.replace(/（[^）]*）|\([^)]*\)/g, "").trim())
    .filter(Boolean);
}

/** How close two glosses are: 2 when they share a sense, 1 when a sense is part of the other's (治る in 治るまで待つ), else 0. */
function closeness(a: string, b: string): number {
  const x = senses(a);
  const y = senses(b);
  if (y.some((s) => x.includes(s))) return 2;
  return y.some((s) => x.some((t) => t.includes(s) || s.includes(t))) ? 1 : 0;
}

export function sharesSense(a: string, b: string): boolean {
  return closeness(a, b) > 0;
}

/** The item whose gloss is closest to the meaning: 雨が降る is the verb's, not the noun 雨's. */
function closest<T>(items: T[], ja: (item: T) => string, meaning: string): T | undefined {
  let best: T | undefined;
  let score = 0;
  for (const item of items) {
    const c = closeness(ja(item), meaning);
    if (c > score) [best, score] = [item, c];
  }
  return best;
}

const POS_TAG: Record<Exclude<PartOfSpeech, "verb">, PosTag> = { noun: "名", adjective: "形", adverb: "副" };

function verbSenses(type: VerbType | undefined, meaning: string | undefined): TagSense[] {
  if (!type) return [];
  if (typeof type === "string") return [{ tags: type === "自他" ? ["自", "他"] : [type] }];
  const out = type.map(([tag, ja]) => ({ tags: [tag] as PosTag[], ja }));
  // The sense the meaning on screen is about comes first.
  if (meaning) out.sort((a, b) => closeness(b.ja ?? "", meaning) - closeness(a.ja ?? "", meaning));
  return out;
}

/**
 * The tags before a word's meaning: [名] [形] [副], or for a verb [自] / [他] / [自][他] — or one
 * sense apiece when the two mean different things ([自] 走る ／ [他] 経営する). The part of speech
 * comes from the word question whose meaning is the one on screen, else from the meaning's own
 * shape (a word only the glossary has); a verb the data has no type for has no tag.
 */
export function tagSenses(word: string, meaning: string | undefined, data: WordTags, gloss?: string | null): TagSense[] {
  const key = word.trim().toLowerCase();
  const entries = data.words[key] ?? [];
  let pos: PartOfSpeech;
  if (entries.length) {
    const own = meaning ? closest(entries, ([, ja]) => ja, meaning) : undefined;
    // A meaning no question has is one of the glossary's (like「～のような」beside the verb 好む).
    pos = own ? own[0] : meaning ? posFromGloss(meaning, word) : entries[0][0];
  } else {
    const text = meaning || gloss;
    if (!text) return [];
    pos = posFromGloss(text, word);
  }
  if (pos === "verb") return verbSenses(data.verbTypes[key], meaning || gloss || undefined);
  return [{ tags: [POS_TAG[pos]] }];
}

/**
 * The tags of a word on a line with a description of its own instead of its meaning (類似表現,
 * 文中の用法): the description only picks among the word's senses, as its wording says nothing of
 * the part of speech (「（物・場所が）不気味でぞっとする」 is an adjective). A word of the bank that is
 * two parts of speech (watch: 腕時計, 見守る) and that the description does not settle has none.
 */
export function tagsFor(word: string, about: string | null | undefined, data: WordTags, gloss?: string | null): PosTag[] {
  const key = word.trim().toLowerCase();
  const entries = data.words[key] ?? [];
  let pos: PartOfSpeech;
  if (entries.length) {
    const own = about ? closest(entries, ([, ja]) => ja, about) : undefined;
    const kinds = new Set(entries.map(([p]) => p));
    if (own) pos = own[0];
    else if (kinds.size === 1) pos = entries[0][0];
    else return [];
  } else {
    if (!gloss) return [];
    pos = posFromGloss(gloss, word);
  }
  if (pos !== "verb") return [POS_TAG[pos]];
  const senses = verbSenses(data.verbTypes[key], about ?? undefined);
  if (senses.length > 1 && about) {
    const meant = closest(senses, (s) => s.ja ?? "", about);
    if (meant) return meant.tags;
  }
  return [...new Set(senses.flatMap((s) => s.tags))];
}
