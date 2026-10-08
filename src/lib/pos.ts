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

/** Mirrors db::gloss_senses: a meaning apart at 、 outside （ ）, each as it is written. */
export function meaningParts(ja: string): string[] {
  const out = [""];
  let depth = 0;
  for (const c of ja) {
    if (c === "（" || c === "(") depth++;
    else if (c === "）" || c === ")") depth--;
    else if (depth === 0 && (c === "、" || c === "，" || c === ",")) {
      out.push("");
      continue;
    }
    out[out.length - 1] += c;
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The senses of a gloss, notes in （ ） left out: "（傷が）治る、治す" is 治る and 治す. */
function senses(ja: string): string[] {
  return ja
    .split(/[、，,／/。]/)
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

const typeTags = (t: "自" | "他" | "自他"): PosTag[] => (t === "自他" ? ["自", "他"] : [t]);

/** A part of speech with the sense it is in ("" when the data writes none). */
type Sense = [PartOfSpeech, string];

/**
 * Every part of speech a word has, each with its sense: its word questions' (or, for a word only
 * the glossary has, its gloss's, sense by sense), and its verb senses from verb-types.json when no
 * question is a verb (estimate 見積もり is a noun question; 見積もる its verb). null when the word
 * takes no tag (about, she, could); empty when the data does not know it.
 */
function sensesOf(key: string, data: WordTags): Sense[] | null {
  const own = data.words[key] ?? data.glossary[key];
  if (own && own.length === 0) return null;
  const out: Sense[] = own ? [...own] : [];
  const type = data.verbTypes[key];
  if (type && !out.some(([p]) => p === "verb")) {
    if (typeof type === "string") out.push(["verb", ""]);
    else for (const [, ja] of type) out.push(["verb", ja]);
  }
  return out;
}

/**
 * The part of speech of one sense on screen: the one of the word's senses written the same way,
 * else the one the sense looks like when the word has it (見積もる of estimate), else the closest
 * (不気味でぞっとする is creepy's 不気味な, an adjective).
 */
function posOf(part: string, own: Sense[], word: string): PartOfSpeech | undefined {
  if (!own.length) return posFromGloss(part, word);
  const kinds = new Set(own.map(([p]) => p));
  if (kinds.size === 1) return own[0][0];
  const same = own.find(([, ja]) => ja && closeness(ja, part) === 2);
  if (same) return same[0];
  const shape = posFromGloss(part, word);
  if (kinds.has(shape)) return shape;
  return closest(own, ([, ja]) => ja, part)?.[0];
}

/** [自] / [他] / [自][他] of a verb in the sense on screen; both when its two senses differ and neither is meant. */
function verbTags(type: VerbType | undefined, part: string): PosTag[] {
  if (!type) return [];
  if (typeof type === "string") return typeTags(type);
  const meant = type.length === 1 ? type[0] : closest(type, ([, ja]) => ja, part);
  if (meant) return typeTags(meant[0]);
  return [...new Set(type.flatMap(([t]) => typeTags(t)))];
}

function tagsOfPart(key: string, part: string, own: Sense[], data: WordTags, word: string): PosTag[] {
  const pos = posOf(part, own, word);
  if (!pos) return [];
  if (pos === "verb") return verbTags(data.verbTypes[key], part);
  return [POS_TAG[pos]];
}

/** A meaning with its tags: the parts of the same tags together, and the verb senses it leaves out. */
export interface TaggedMeaning {
  groups: TagSense[];
  others: TagSense[];
}

/**
 * The tags before a word's meaning, sense by sense: [名] [形] [副], or for a verb [自] / [他] /
 * [自][他]. Senses of different parts of speech are apart ([名] 場所、地点 ／ [他] 見つける), and so
 * are a verb's 自 and 他 when they mean different things ([自] 走る ／ [他] 経営する). A verb sense
 * the meaning leaves out comes after it (estimate 見積もり: ／ [他] 見積もる). A word the data has
 * no part of speech for is tagged by the shape of its meaning; a verb with no 自・他 has no tag.
 */
export function tagMeaning(word: string, meaning: string, data: WordTags): TaggedMeaning {
  const key = word.trim().toLowerCase();
  const own = sensesOf(key, data);
  if (!own) return { groups: [{ tags: [], ja: meaning }], others: [] };
  const groups: TagSense[] = [];
  const parts = meaningParts(meaning);
  for (const part of parts) {
    const tags = tagsOfPart(key, part, own, data, word);
    const last = groups[groups.length - 1];
    if (last && last.tags.join() === tags.join()) last.ja += `、${part}`;
    else groups.push({ tags, ja: part });
  }
  const type = data.verbTypes[key];
  const others: TagSense[] =
    typeof type === "object"
      ? type
          .filter(([, ja]) => !parts.some((p) => closeness(ja, p) > 0))
          .map(([t, ja]) => ({ tags: typeTags(t), ja }))
      : [];
  return { groups, others };
}

/**
 * The tags of a word on a line with a description of its own instead of its meaning (類似表現,
 * 文中の用法): its first sense picks among the word's ("（数・費用・時間を）おおよそ見積もる" is
 * estimate's verb). A word of two parts of speech with no description (watch: 腕時計, 見守る) has none.
 */
export function tagsFor(word: string, about: string | null | undefined, data: WordTags, gloss?: string | null): PosTag[] {
  const key = word.trim().toLowerCase();
  const own = sensesOf(key, data);
  if (!own) return [];
  const part = about ? (meaningParts(about.split("。")[0])[0] ?? about) : "";
  // A word the data does not know goes by its gloss, the description being no gloss.
  if (!own.length) return gloss ? tagsOfPart(key, gloss, [], data, word) : [];
  if (!part && new Set(own.map(([p]) => p)).size > 1) return [];
  return tagsOfPart(key, part, own, data, word);
}

/**
 * Mirrors db::cue_text: a 類似表現 nuance as it is put to a question in place of the bare meaning,
 * its first sentence with the English in it taken out ("put on：（動作）身につける" is （動作）身につける);
 * undefined when English is what it says ("although とほぼ同じ").
 */
export function cueText(nuance: string): string | undefined {
  let first = nuance.split("。")[0] ?? "";
  const colon = first.lastIndexOf("：");
  if (colon >= 0) first = first.slice(colon + 1);
  const out = first.replace(/（[^（）]*）/g, (aside) => (/[A-Za-z]/.test(aside) ? "" : aside)).trim();
  return out && !/[A-Za-z]/.test(out) ? out : undefined;
}

/**
 * Mirrors db::cue_of: what tells a word in a sense apart from its near synonyms when only the
 * Japanese is given, the nuance of its 類似表現 group nearest the meaning (admit 認める:
 * （事実・誤りを）しぶしぶ認める); undefined when there is none or it says no more than the meaning.
 */
export function cueFor(en: string, ja: string, cues: Record<string, Array<[number, string]>>): string | undefined {
  let best: string | undefined;
  let score = 0;
  for (const [, cue] of cues[en.trim().toLowerCase()] ?? []) {
    const c = cue ? closeness(cue, ja) : 0;
    if (c > score) [best, score] = [cue, c];
  }
  return best && best.trim() !== ja.trim() ? best : undefined;
}
