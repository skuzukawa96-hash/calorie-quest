import { Fragment } from "react";
import GlossedText from "./GlossedText";
import type { Dictionary } from "../lib/dictionary";
import { isTtsSupported, speak } from "../lib/speech";
import type { WordNotes, WordPart } from "../types";

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

/**
 * A pattern as it can be read aloud: "apologize to 人 for ~" → "apologize to someone for
 * something". The Japanese placeholders and asides would come out of an English voice as noise.
 */
export function spokenPattern(pattern: string): string {
  return pattern
    .replace(/（[^）]*）/g, "")
    .replace(/[()]/g, "")
    .replace(/人/g, "someone")
    .replace(/\b[AB]\b/g, "something")
    .replace(/[~～]/g, "something")
    .replace(/\s*\/\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
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
 * Every English line has a 🔊 that reads it aloud. Shown under a study answer and under a recipe
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
  const { parts, examples, usages, origin } = notes;
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
      {usages.length > 0 && (
        <div className="usage-line">
          <span className="label">用法</span>
          {usages.map((u, i) => (
            <div key={i} className="usage">
              <div className="usage-head">
                <span className="usage-bracket">
                  <b>{u.pattern}</b>
                  <span className="usage-sep">：</span>
                  {u.ja}
                </span>
                <SpeakButton text={spokenPattern(u.pattern)} />
              </div>
              <div className="example-en">
                <GlossedText text={u.example} dict={dict} enabled={gloss} highlight={word} contextJa={u.exampleJa} />
                <SpeakButton text={u.example} />
              </div>
              <div className="muted">{u.exampleJa}</div>
            </div>
          ))}
        </div>
      )}
      {origin && (
        <div className="origin-line">
          <span className="label">由来</span>
          <div>{origin}</div>
        </div>
      )}
    </>
  );
}
