import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import AntonymTag from "./AntonymTag";
import GlossedText from "./GlossedText";
import { MeaningWithTags, PosTags, SlotText, useWordTags, WordTagsOnly } from "./PosTags";
import { homonymsApart, tagMeaning } from "../lib/pos";
import type { Dictionary } from "../lib/dictionary";
import { useAddToRecipe } from "../lib/recipe";
import { isTtsSupported, speak, speakInTurn } from "../lib/speech";
import type { Abbreviation, IrregularVerb, PartFamily, RelatedGroup, UsedWord, WordNotes, WordPart, WordUsage } from "../types";

const PART_LABEL: Record<WordPart["kind"], string> = {
  prefix: "接頭辞",
  root: "語根",
  suffix: "接尾辞",
  base: "元の語",
  change: "つづりを変えて",
};

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

/** The pause between the three forms read in turn: buy … bought … bought. */
const FORM_GAP_MS = 300;
/** The forms being read now; a newer reading (or the row going away) stops an older one. */
let latestReading = 0;

/**
 * An irregular verb's forms, base-past-participle, and a 🔊 that reads the three in turn with a
 * short pause between them, marking each as it is read: the rhythm and the sound are what stay.
 */
function IrregularRow({ v }: { v: IrregularVerb }) {
  const [at, setAt] = useState<number | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const play = async () => {
    const mine = ++latestReading;
    const current = () => latestReading === mine && mounted.current;
    await speakInTurn(v.say, FORM_GAP_MS, (i) => current() && setAt(i)).catch(() => undefined);
    if (current()) setAt(null);
  };
  return (
    <div className="irregular-row">
      {[v.base, v.past, v.participle].map((form, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="irregular-dash">-</span>}
          <span className={"irregular-form" + (at === i ? " saying" : "")}>{form}</span>
        </Fragment>
      ))}
      <button
        className="btn-link speak-btn"
        onClick={() => void play()}
        disabled={!isTtsSupported()}
        title="原形-過去形-過去分詞の順に読み上げる"
        aria-label={`${v.base} の活用を読み上げる`}
      >
        🔊
      </button>
    </div>
  );
}

/**
 * One pattern: [compare A with B：AとBを比較する], then a sentence using it with its Japanese. What
 * fills it is A / B (a noun), 人, -ing, or boxed: [原] a verb's base form, [形] an adjective, [節] a clause.
 */
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
            <SlotText text={u.pattern} />
          </b>
          <span className="usage-sep">：</span>
          <SlotText text={u.ja} />
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
                <WordTagsOnly word={m.word} about={m.nuance} dict={dict} />
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

/** pre- / paid / -ness: a piece as it is written in 成り立ち (a base word as it is; つづりを変えて, its meaning). */
function pieceText(p: WordPart): string {
  if (p.kind === "change") return p.ja;
  return p.kind === "prefix" ? `${p.text}-` : p.kind === "suffix" ? `-${p.text}` : p.text;
}

/**
 * A base word's meaning in the senses it keeps, each part of speech boxed before its 「…」:
 * accuse [他]「（of で）責める、告発する」.
 */
function BaseMeaning({ word, ja }: { word: string; ja: string }) {
  const data = useWordTags();
  const groups = data ? tagMeaning(word, ja, data).groups : [{ tags: [], ja }];
  return (
    <>
      {groups.map((g, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="pos-sense-sep">／</span>}
          {g.tags.length > 0 && <PosTags tags={g.tags} />}
          <span>「{g.ja}」</span>
        </Fragment>
      ))}
    </>
  );
}

/**
 * What a piece says: its kind, how it is written and what it means. A base word (元の語) is a
 * word of the dictionary: it is read aloud on a click and saved to the recipe on a right click, as
 * any English on screen is.
 */
function PieceBody({ p, dict }: { p: WordPart; dict: Dictionary | null }) {
  if (p.kind === "base") {
    return (
      <>
        <span className="wp-kind">{PART_LABEL.base}</span>
        <b className="wp-base-word">
          <GlossedText text={p.text} dict={dict} enabled={false} context="" />
        </b>
        <BaseMeaning word={p.text} ja={p.ja} />
      </>
    );
  }
  if (p.kind === "change") {
    return (
      <>
        <span className="wp-kind">{PART_LABEL.change}</span>
        <span>{p.ja}</span>
      </>
    );
  }
  return (
    <>
      <span className="wp-kind">{PART_LABEL[p.kind]}</span>
      <b>{pieceText(p)}</b>
      <span>「{p.ja}」</span>
    </>
  );
}

/**
 * How a word is built: pre-「前もって」＋ paid「支払った」→ prepaid「前払いの」, or from the word it
 * is made from: 元の語 accuse「責める」＋ -ation → accusation. A base the data splits in turn shows
 * its pieces underneath (reimburse: re- ＋ imburse), and a meaning moved far from the base's says
 * how (hardly). A piece that other words share in the same sense is a button: clicking it lists a
 * few of them underneath. The list starts closed, so the explanation itself stays as short as before.
 */
function WordParts({
  parts,
  word,
  meaning,
  dict,
  shift,
}: {
  parts: WordPart[];
  word: string;
  meaning: string;
  dict: Dictionary | null;
  shift?: string | null;
}) {
  // Keyed by the word, so the next question starts closed without remounting the panel.
  const [open, setOpen] = useState<{ word: string; index: number } | null>(null);
  const openIndex = open?.word === word ? open.index : null;
  const shown = openIndex !== null ? parts[openIndex] : undefined;
  const base = parts.find((p) => p.kind === "base");
  return (
    <>
      <div className="word-parts">
        <span className="label">成り立ち</span>
        <span className="word-parts-row">
          {parts.map((p, i) => {
            const toggle = () => setOpen(openIndex === i ? null : { word, index: i });
            const caret = <span className="wp-caret">{openIndex === i ? "▾" : "▸"}</span>;
            return (
              <Fragment key={i}>
                {i > 0 && <span className="wp-sign">＋</span>}
                {p.family && p.kind !== "base" ? (
                  <button
                    type="button"
                    className={"wp wp-" + p.kind + " wp-link" + (openIndex === i ? " open" : "")}
                    aria-expanded={openIndex === i}
                    title={`クリックで ${pieceText(p)} をもつ語を表示`}
                    onClick={toggle}
                  >
                    <PieceBody p={p} dict={dict} />
                    {caret}
                  </button>
                ) : (
                  // A base word is itself clicked (read aloud), so its family opens from the caret alone.
                  <span className={"wp wp-" + p.kind}>
                    <PieceBody p={p} dict={dict} />
                    {p.family && (
                      <button
                        type="button"
                        className="wp-caret-btn"
                        aria-expanded={openIndex === i}
                        title={`クリックで ${p.text} をもつ語を表示`}
                        onClick={toggle}
                      >
                        {caret}
                      </button>
                    )}
                  </span>
                )}
              </Fragment>
            );
          })}
          <span className="wp-sign">→</span>
          <span className="wp-result">
            <b>{word}</b>「{meaning}」
          </span>
        </span>
      </div>
      {base?.chain && base.chain.length > 0 && (
        <div className="wp-chain">
          <b>{base.text}</b>
          <span>の成り立ち</span>
          {base.chain.map((q, k) => (
            <Fragment key={k}>
              {k > 0 && <span className="wp-sign">＋</span>}
              <span className={"wp wp-" + q.kind}>
                <PieceBody p={q} dict={dict} />
              </span>
            </Fragment>
          ))}
        </div>
      )}
      {shift && <div className="wp-shift">⚠ 元の語と意味が大きく違う（{shift}）</div>}
      {shown?.family && <PartFamilyList piece={shown} family={shown.family} dict={dict} />}
    </>
  );
}

/**
 * 関連語: the words sharing the clicked piece in the same sense, each with how it is built (the
 * shared piece marked), what it means and how the piece gives that meaning. Where the piece comes
 * from is shown as 語源, a fact; the notes say how the meaning follows from it.
 */
function PartFamilyList({ piece, family, dict }: { piece: WordPart; family: PartFamily; dict: Dictionary | null }) {
  return (
    <div className="part-family">
      <div className="part-family-head">
        <span className="part-family-title">
          関連語：<b>{pieceText(piece)}</b>「{family.ja}」をもつ語
        </span>
        {family.origin && <span className="part-family-origin">語源 {family.origin}</span>}
      </div>
      {family.members.map((m) => (
        <div key={m.word} className="part-family-word">
          <span className="pf-head">
            <b className="pf-word">
              <GlossedText text={m.word} dict={dict} enabled={false} context="" />
            </b>
            <span className="pf-ja">
              <MeaningWithTags word={m.word} meaning={m.ja} dict={dict} />
            </span>
          </span>
          <span className="pf-how">
            {m.parts.length > 0 && (
              <span className="pf-parts">
                {m.parts.map((q, k) => (
                  <Fragment key={k}>
                    {k > 0 && " ＋ "}
                    <span className={family.forms.includes(q.text.toLowerCase()) ? "pf-shared" : undefined}>
                      {pieceText(q)}
                    </span>
                  </Fragment>
                ))}
              </span>
            )}
            <span className="pf-note">{m.note}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * What the answer explains about a word or an idiom beyond its meaning: 不規則動詞 (base-past-
 * participle, read in turn), 成り立ち (prefix, root, suffix), 例文, 用法 (patterns with
 * prepositions, each with a sentence) and, for an idiom, 由来.
 * Every sentence has a 🔊 that reads it aloud; a pattern has none, its ～ / 人 / 原形 being no
 * English an English voice could read. Shown under a study answer and under a recipe
 * review answer alike.
 */
/**
 * 同じつづりの別の語: the other words spelt like the one asked (bark 樹皮: [自] ほえる; fine 元気な:
 * [名] 罰金), each with its tags, so a sense of another word is not taken for this one's.
 */
function Homonyms({ word, meaning }: { word: string; meaning: string }) {
  const data = useWordTags();
  const apart = data ? homonymsApart(word, meaning, data) : [];
  if (!apart.length) return null;
  return (
    <div className="homonym-line">
      <span className="label">同じつづりの別の語</span>
      <span className="homonym-words">
        {apart.map((senses, i) => (
          <span key={i} className="homonym">
            <b>{word}</b> <MeaningWithTags word={word} meaning={senses.join("、")} others={false} />
          </span>
        ))}
      </span>
    </div>
  );
}

/**
 * 正式名称 (an acronym) or 略さない形 (a clipped word): what an abbreviation stands for, the letters
 * it keeps marked: Magnetic Resonance Imaging, examination with exam marked. An acronym's letters
 * are capitals, as it writes them. Read aloud unless it is not English (RSVP, a.m.).
 */
function AbbreviationLine({ a }: { a: Abbreviation }) {
  const acronym = a.kind === "acronym";
  const pieces = a.full.split(/(\[[^\]]*\])/).filter(Boolean);
  return (
    <div className="abbr-line">
      <span className="label">{acronym ? "正式名称" : "略さない形"}</span>
      <span className="abbr-full">
        {pieces.map((p, i) =>
          p.startsWith("[") ? (
            <b key={i} className="abbr-kept">
              {acronym ? p.slice(1, -1).toUpperCase() : p.slice(1, -1)}
            </b>
          ) : (
            <Fragment key={i}>{p}</Fragment>
          ),
        )}
      </span>
      <span className="abbr-ja">{a.lang ? `${a.lang}で「${a.ja}」` : `「${a.ja}」`}</span>
      {!a.lang && <SpeakButton text={a.full.replace(/[[\]]/g, "")} />}
    </div>
  );
}

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
  const { parts, examples, usages, origin, related, used, irregular = [], shift, abbreviation } = notes;
  // Keyed by the word, so the next question starts closed without remounting the panel.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const relatedOpen = openFor === word;
  return (
    <>
      {abbreviation && <AbbreviationLine a={abbreviation} />}
      <Homonyms word={word} meaning={meaning} />
      {irregular.length > 0 && (
        <div className="irregular-line">
          <div className="usage-title">
            <span className="label">不規則動詞</span>
            <span className="irregular-heads">原形-過去形-過去分詞</span>
          </div>
          {irregular.map((v) => (
            // Keyed by the question's English too, so a new question starts quiet.
            <IrregularRow key={`${word}|${v.base}`} v={v} />
          ))}
        </div>
      )}
      {parts.length > 0 && <WordParts parts={parts} word={word} meaning={meaning} dict={dict} shift={shift} />}
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
 * A word of the recipe's list, opened: what its review explains about it, kept short — 対義語 and
 * 成り立ち as they are, then `children` (the sentence it was saved with), then 用法 and 類似表現
 * each behind a button (open, they would make the list too long). Without notes (not read yet, or
 * none), `children` alone.
 */
export function WordNotesBrief({
  notes,
  word,
  meaning,
  dict,
  children,
}: {
  notes: WordNotes | null;
  word: string;
  meaning: string;
  dict: Dictionary | null;
  children?: ReactNode;
}) {
  const { parts = [], usages = [], related = [], shift, antonym } = notes ?? {};
  const [usagesOpen, setUsagesOpen] = useState(false);
  const [relatedOpen, setRelatedOpen] = useState(false);
  return (
    <div className="brief-notes">
      {antonym && (
        <div className="brief-antonym">
          <span className="label">対義語</span>
          <AntonymTag antonym={antonym} dict={dict} />
        </div>
      )}
      {parts.length > 0 && <WordParts parts={parts} word={word} meaning={meaning} dict={dict} shift={shift} />}
      {children}
      {(usages.length > 0 || related.length > 0) && (
        <div className="brief-toggles">
          {usages.length > 0 && (
            <button type="button" className="related-toggle" aria-expanded={usagesOpen} onClick={() => setUsagesOpen(!usagesOpen)}>
              用法 {usagesOpen ? "▾" : "▸"}
            </button>
          )}
          {related.length > 0 && (
            <button type="button" className="related-toggle" aria-expanded={relatedOpen} onClick={() => setRelatedOpen(!relatedOpen)}>
              類似表現 {relatedOpen ? "▾" : "▸"}
            </button>
          )}
        </div>
      )}
      {usagesOpen && (
        <div className="usage-line">
          {usages.map((u, i) => (
            <UsageItem key={i} u={u} word={word} dict={dict} gloss />
          ))}
        </div>
      )}
      {relatedOpen && <RelatedWords groups={related} dict={dict} gloss />}
    </div>
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
        <WordTagsOnly word={w.word} about={w.nuance} dict={dict} />
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
