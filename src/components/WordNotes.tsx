import { Fragment, useState } from "react";
import GlossedText from "./GlossedText";
import type { Dictionary } from "../lib/dictionary";
import { useAddToRecipe } from "../lib/recipe";
import { isTtsSupported, speak } from "../lib/speech";
import type { RelatedGroup, UsedWord, WordNotes, WordPart, WordUsage } from "../types";

const PART_LABEL: Record<WordPart["kind"], string> = { prefix: "接頭辞", root: "語根", suffix: "接尾辞" };

function SpeakButton({ text }: { text: string }) {
  return (
    <button
      className="btn-link speak-btn"
      onClick={() => speak(text).catch(() => undefined)}
      disabled={!isTtsSupported()}
      title="読み上げる"
      aria-label="読み上げる"
    >
      🔊
    </button>
  );
}

/** One pattern: [compare A with B：AとBを比較する], then a sentence using it with its Japanese. */
function UsageItem({ u, word, dict, gloss }: { u: WordUsage; word: string; dict: Dictionary | null; gloss: boolean }) {
  // Right-clicking the pattern saves it whole to the recipe, like a phrase: "compare A with B" is
  // what is worth learning, not "compare" alone. It is not read aloud (人, 原形, ～ have no sound).
  const addToRecipe = useAddToRecipe();
  return (
    <div className="usage">
      <div className="usage-head">
        <span className="usage-bracket">
          <b
            title={addToRecipe ? "右クリックでこの用法をレシピに登録" : undefined}
            onContextMenu={
              addToRecipe
                ? (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    addToRecipe({
                      word: u.pattern,
                      meaning: u.ja,
                      form: "",
                      example: u.example,
                      exampleJa: u.exampleJa,
                      kind: "usage",
                    });
                  }
                : undefined
            }
          >
            {u.pattern}
          </b>
          <span className="usage-sep">：</span>
          {u.ja}
        </span>
      </div>
      <div className="example-en">
        <GlossedText text={u.example} dict={dict} enabled={gloss} highlight={word} contextJa={u.exampleJa} />
        <SpeakButton text={u.example} />
      </div>
      <div className="muted">{u.exampleJa}</div>
    </div>
  );
}

/**
 * 類似表現, opened from beside 用法: each group of easily confused words, every word with how it
 * differs (afraid「（人が）恐れている」, creepy「（物・場所が）不気味でぞっとする」) and how it is used.
 * The word on screen is marked and shows only its nuance; its patterns are right above.
 */
function RelatedWords({ groups, dict, gloss }: { groups: RelatedGroup[]; dict: Dictionary | null; gloss: boolean }) {
  return (
    <div className="related">
      {groups.map((g, gi) => (
        <div key={gi} className="related-group">
          <div className="related-title">{g.title}</div>
          {g.members.map((m) => (
            <div key={m.word} className={"related-word" + (m.isSelf ? " self" : "")}>
              <div className="related-head">
                <b>{m.word}</b>
                <span className="related-nuance">{m.nuance}</span>
                {m.isSelf && <span className="related-self">この語</span>}
              </div>
              {m.usages.map((u, i) => (
                <UsageItem key={i} u={u} word={m.word} dict={dict} gloss={gloss} />
              ))}
              {m.example && (
                <div className="usage">
                  <div className="example-en">
                    <GlossedText text={m.example.en} dict={dict} enabled={gloss} highlight={m.word} contextJa={m.example.ja} />
                    <SpeakButton text={m.example.en} />
                  </div>
                  <div className="muted">{m.example.ja}</div>
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** How a word is built: pre-「前もって」＋ paid「支払った」→ prepaid「前払いの」. */
function WordParts({ parts, word, meaning }: { parts: WordPart[]; word: string; meaning: string }) {
  return (
    <div className="word-parts">
      <span className="label">成り立ち</span>
      <span className="word-parts-row">
        {parts.map((p, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="wp-sign">＋</span>}
            <span className={"wp wp-" + p.kind}>
              <span className="wp-kind">{PART_LABEL[p.kind]}</span>
              <b>{p.kind === "prefix" ? `${p.text}-` : p.kind === "suffix" ? `-${p.text}` : p.text}</b>
              <span>「{p.ja}」</span>
            </span>
          </Fragment>
        ))}
        <span className="wp-sign">→</span>
        <span className="wp-result">
          <b>{word}</b>「{meaning}」
        </span>
      </span>
    </div>
  );
}

/**
 * What the answer explains about a word or an idiom beyond its meaning: 成り立ち (prefix, root,
 * suffix), 例文, 用法 (patterns with prepositions, each with a sentence) and, for an idiom, 由来.
 * Every sentence has a 🔊 that reads it aloud; a pattern has none, its ～ / 人 / 原形 being no
 * English an English voice could read. Shown under a study answer and under a recipe
 * review answer alike.
 */
export default function WordNotesPanel({
  notes,
  word,
  meaning,
  dict,
  gloss,
}: {
  notes: WordNotes;
  word: string;
  meaning: string;
  dict: Dictionary | null;
  /** show meanings on hover (the study screen's 単語の意味 toggle) */
  gloss: boolean;
}) {
  const { parts, examples, usages, origin, related, used } = notes;
  // Keyed by the word, so the next question starts closed without remounting the panel.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const relatedOpen = openFor === word;
  return (
    <>
      {parts.length > 0 && <WordParts parts={parts} word={word} meaning={meaning} />}
      {examples.length > 0 && (
        <div className="example-line">
          <span className="label">例文</span>
          {examples.map((e, i) => (
            <div key={i} className="notes-sentence">
              <div className="example-en">
                <GlossedText text={e.en} dict={dict} enabled={gloss} highlight={word} contextJa={e.ja} />
                <SpeakButton text={e.en} />
              </div>
              <div className="muted">{e.ja}</div>
            </div>
          ))}
        </div>
      )}
      {(usages.length > 0 || related.length > 0) && (
        <div className="usage-line">
          <div className="usage-title">
            {usages.length > 0 && <span className="label">用法</span>}
            {related.length > 0 && (
              <button
                type="button"
                className="related-toggle"
                aria-expanded={relatedOpen}
                onClick={() => setOpenFor(relatedOpen ? null : word)}
              >
                類似表現 {relatedOpen ? "▾" : "▸"}
              </button>
            )}
          </div>
          {relatedOpen && <RelatedWords groups={related} dict={dict} gloss={gloss} />}
          {usages.map((u, i) => (
            <UsageItem key={i} u={u} word={word} dict={dict} gloss={gloss} />
          ))}
        </div>
      )}
      {origin && (
        <div className="origin-line">
          <span className="label">由来</span>
          <div>{origin}</div>
        </div>
      )}
      {used.length > 0 && (
        <div className="usage-line">
          <span className="label">文中の用法</span>
          {used.map((w) => (
            // Keyed by the question's English too, so each question starts with 類似表現 closed.
            <UsedWordItem key={`${word}|${w.word}`} w={w} dict={dict} gloss={gloss} />
          ))}
        </div>
      )}
    </>
  );
}

/**
 * A word of the sentence on screen: the patterns of it that the sentence uses, how it differs
 * from similar words, and 類似表現 to open them.
 */
function UsedWordItem({ w, dict, gloss }: { w: UsedWord; dict: Dictionary | null; gloss: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="used-word">
      <div className="usage-title">
        <b className="used-word-name">{w.word}</b>
        {w.nuance && <span className="related-nuance">{w.nuance}</span>}
        {w.related.length > 0 && (
          <button type="button" className="related-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
            類似表現 {open ? "▾" : "▸"}
          </button>
        )}
      </div>
      {open && <RelatedWords groups={w.related} dict={dict} gloss={gloss} />}
      {w.usages.map((u, i) => (
        <UsageItem key={i} u={u} word={w.word} dict={dict} gloss={gloss} />
      ))}
    </div>
  );
}
