import { useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import type { Dictionary } from "../lib/dictionary";
import type { WordNotes } from "../types";
import { MeaningWithTags } from "./PosTags";
import { WordNotesBrief } from "./WordNotes";

interface Props {
  /** the word as tapped, and its own meaning when it has one */
  word: string;
  gloss?: string;
  /** the phrase it is part of, when it is one ("doggy bag", "kept my fingers crossed") */
  phrase?: { key: string; gloss: string; idiom: boolean };
  /** the sentence it was tapped in, the word marked; none for a word on its own */
  sentence?: ReactNode;
  dict: Dictionary | null;
  onSay: () => void;
  /** 単語帳に登録 (as a long press does) */
  onSave?: () => void;
  /** the word whose 用法・類似表現 can be opened: none while the meaning would answer the question */
  notesFor?: { word: string; meaning: string };
  onClose: () => void;
}

/** How far down a swipe has to take the sheet before it closes instead of springing back. */
const CLOSE_AFTER_PX = 80;

/**
 * A word tapped on a phone: its meaning in a sheet from the bottom of the screen, in place of the
 * tooltip a mouse hovers out (which covered the sentence and cut long meanings short). It has the
 * buttons a phone has no hover or right-click for: read it, save it, its 用法・類似表現. It closes on
 * a tap outside it or a swipe down.
 */
export default function WordSheet({ word, gloss, phrase, sentence, dict, onSay, onSave, notesFor, onClose }: Props) {
  const [notes, setNotes] = useState<WordNotes | null | "loading" | "none">(null);
  const sheet = useRef<HTMLElement>(null);
  const swipe = useRef<{ y: number; dy: number } | null>(null);

  const openNotes = async () => {
    if (!notesFor) return;
    if (notes !== null) return setNotes(null);
    setNotes("loading");
    try {
      const n = await api.getWordNotes(notesFor.word, notesFor.meaning);
      const empty = !n || ((n.usages?.length ?? 0) === 0 && (n.related?.length ?? 0) === 0 && (n.parts?.length ?? 0) === 0 && !n.antonym);
      setNotes(empty ? "none" : n);
    } catch {
      setNotes("none");
    }
  };

  // A swipe down from where the sheet is not scrolled moves it with the finger, and far enough closes it.
  const onTouchStart = (e: React.TouchEvent) => {
    if ((sheet.current?.scrollTop ?? 0) > 0) return;
    swipe.current = { y: e.touches[0].clientY, dy: 0 };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = swipe.current;
    if (!s || !sheet.current) return;
    s.dy = Math.max(0, e.touches[0].clientY - s.y);
    sheet.current.style.transform = `translateY(${s.dy}px)`;
  };
  const onTouchEnd = () => {
    const s = swipe.current;
    swipe.current = null;
    if (!s || !sheet.current) return;
    if (s.dy > CLOSE_AFTER_PX) onClose();
    else sheet.current.style.transform = "";
  };

  // Portalled to the body, it is still inside its sentence in React's tree: a tap on it must not
  // go on to what holds the sentence (a row that opens, an answered option that reads itself).
  const keep = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div className="sheet-root" onClick={keep} onContextMenu={keep} onKeyDown={keep}>
      <div className="sheet-backdrop" onClick={onClose} />
      <section
        ref={sheet}
        className="word-sheet"
        role="dialog"
        aria-label={`${phrase && !gloss ? phrase.key : word} の意味`}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <div className="sheet-handle" aria-hidden="true" />
        <div className="sheet-head">
          <span className="sheet-word">{gloss ? word : phrase?.key}</span>
          <button type="button" className="sheet-say" aria-label={`${word} を読み上げる`} onClick={onSay}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 9v6h4l5 4V5L8 9z" />
              <path d="M16.5 8.5a5 5 0 0 1 0 7" />
            </svg>
          </button>
        </div>
        {gloss && (
          <div className="sheet-meaning">
            <MeaningWithTags word={word.toLowerCase()} meaning={gloss} dict={dict} />
          </div>
        )}
        {phrase && (
          <div className="sheet-phrase">
            {/* The same words can be meant literally, so an idiom's meaning is offered as a reading. */}
            <span className="label">{phrase.idiom ? "慣用句なら" : "この文では熟語"}</span>
            {gloss && <b className="sheet-phrase-key">{phrase.key}</b>}
            <span>{phrase.gloss}</span>
          </div>
        )}
        {sentence && (
          <div className="sheet-sentence">
            <span className="label">この文では</span>
            <div>{sentence}</div>
          </div>
        )}
        {(onSave || notesFor) && (
          <div className="sheet-actions">
            {onSave && (
              <button type="button" className="btn btn-primary" onClick={onSave}>
                単語帳に登録
              </button>
            )}
            {notesFor && (
              <button type="button" className="btn" aria-expanded={notes !== null} onClick={() => void openNotes()}>
                用法・類似表現 {notes !== null ? "▾" : "▸"}
              </button>
            )}
          </div>
        )}
        {notes === "loading" && <div className="muted small">読み込み中…</div>}
        {notes === "none" && <div className="muted small">この語の用法・類似表現はありません</div>}
        {notes !== null && typeof notes === "object" && notesFor && (
          <WordNotesBrief notes={notes} word={notesFor.word} meaning={notesFor.meaning} dict={dict} />
        )}
        <div className="muted small sheet-hint">シートの外をタップするか、下にスワイプすると閉じます</div>
      </section>
    </div>
  );
}
