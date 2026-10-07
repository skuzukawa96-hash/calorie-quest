import { Fragment, useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { sharesSense, tagSenses, tagsFor } from "../lib/pos";
import type { Dictionary } from "../lib/dictionary";
import type { PosTag, WordTags } from "../types";

let cached: WordTags | null = null;
let loading: Promise<WordTags> | null = null;

/** The parts of speech and verb types, loaded once. */
function loadWordTags(): Promise<WordTags> {
  if (!loading) {
    loading = api.getWordTags().catch((e) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}

/** The parts of speech and verb types, once they have loaded (null until then). */
export function useWordTags(): WordTags | null {
  const [data, setData] = useState<WordTags | null>(cached);
  useEffect(() => {
    if (cached) return;
    let alive = true;
    loadWordTags()
      .then((d) => {
        cached = d;
        if (alive) setData(d);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return data;
}

const TAG_TITLE: Record<PosTag, string> = { 自: "自動詞", 他: "他動詞", 名: "名詞", 形: "形容詞", 副: "副詞" };

/** Boxed tags: [自] [他] [名] [形] [副]. */
export function PosTags({ tags }: { tags: PosTag[] }) {
  return (
    <span className="pos-tags">
      {tags.map((t) => (
        <span key={t} className="pos-tag" title={TAG_TITLE[t]}>
          {t}
        </span>
      ))}
    </span>
  );
}

/**
 * A word's meaning with its tags in front: [他] 承認する. A verb whose 自 and 他 mean different
 * things shows each sense with its own: [自] 走る ／ [他] 経営する (the meaning on screen first,
 * the other after it when the meaning holds only one).
 */
export function MeaningWithTags({ word, meaning, dict }: { word: string; meaning: string; dict?: Dictionary | null }) {
  const data = useWordTags();
  if (!data) return <>{meaning}</>;
  const senses = tagSenses(word, meaning, data, dict?.[word.toLowerCase()]);
  if (!senses.length) return <>{meaning}</>;
  if (senses.length === 1 || senses.some((s) => !s.ja)) {
    return (
      <>
        <PosTags tags={senses.flatMap((s) => s.tags)} />
        {meaning}
      </>
    );
  }
  // Senses apart: all of them in place of the meaning when it holds them all.
  if (senses.every((s) => sharesSense(s.ja ?? "", meaning))) {
    return (
      <>
        {senses.map((s, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="pos-sense-sep"> ／ </span>}
            <PosTags tags={s.tags} />
            {s.ja}
          </Fragment>
        ))}
      </>
    );
  }
  const [own, ...others] = senses;
  return (
    <>
      <PosTags tags={own.tags} />
      {meaning}
      {others.map((s, i) => (
        <span key={i} className="pos-other-sense">
          {" ／ "}
          <PosTags tags={s.tags} />
          {s.ja}
        </span>
      ))}
    </>
  );
}

/**
 * Only the tags of a word, for a line that has its own description (類似表現, 文中の用法): the sense
 * the description is about, or every tag when the verb's senses are apart and none is meant.
 */
export function WordTagsOnly({ word, about, dict }: { word: string; about?: string | null; dict?: Dictionary | null }) {
  const data = useWordTags();
  if (!data) return null;
  const tags = tagsFor(word, about, data, dict?.[word.toLowerCase()]);
  return tags.length ? <PosTags tags={tags} /> : null;
}

/** The kinds of what fills a pattern, written as words in the data and boxed on screen. */
const SLOT_BOX: Record<string, string> = { 原形: "原", 形容詞: "形", 節: "節" };
const SLOT_TITLE: Record<string, string> = { 原形: "動詞の原形", 形容詞: "形容詞", 節: "節（主語と動詞のある文）" };

/**
 * A pattern or its Japanese with 原形 / 形容詞 / 節 boxed: "too [形] to [原]". 節 is boxed only on
 * its own, not inside a word (季節, 節約).
 */
export function SlotText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const re = /原形|形容詞|節/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const before = text[m.index - 1] ?? "";
    const after = text[m.index + m[0].length] ?? "";
    const kanji = /[一-鿿々]/;
    if (m[0] === "節" && (kanji.test(before) || kanji.test(after))) continue;
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <span key={m.index} className="pos-tag slot-tag" title={SLOT_TITLE[m[0]]}>
        {SLOT_BOX[m[0]]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
