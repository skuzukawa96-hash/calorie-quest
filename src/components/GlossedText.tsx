import { useEffect, useMemo, useState } from "react";
import {
  buildPhraseIndex,
  lookup,
  normalizeWord,
  phraseSpans,
  type Dictionary,
  type PhraseIndex,
} from "../lib/dictionary";
import { isTtsSupported, speak } from "../lib/speech";

interface Props {
  text: string;
  dict: Dictionary | null;
  /** When off the words still speak on click, but no meanings are shown. */
  enabled: boolean;
  className?: string;
  /**
   * A meaning to keep hidden: the answer to the question on screen. Hovering "hit the books" while
   * the quiz asks what "hit the books" means must not show 猛勉強する.
   */
  withhold?: string | null;
}

interface Tip {
  x: number;
  y: number;
  /** the hovered word, and its own meaning when it has one */
  word: string;
  gloss?: string;
  /** the phrase the word sits in, when it is part of one */
  phrase?: { key: string; gloss: string };
  /** what to highlight: a whole phrase, or just the one word */
  span: number | null;
  piece: number;
}

/**
 * Splits into word / separator pieces so punctuation and spacing survive untouched.
 * Accents, digits and the dots inside an abbreviation stay in the word so the highlighted text
 * matches what was looked up: hovering "café", "K9" or "a.m." used to underline only the ASCII
 * letters up to the first accent, digit or dot.
 */
function pieces(text: string): string[] {
  return text.split(/([\p{L}\p{N}]+(?:['’.][\p{L}\p{N}]+)*)/gu).filter((p) => p !== "");
}

/** One index per dictionary: building it walks every key, and many sentences share a dictionary. */
const phraseIndexes = new WeakMap<Dictionary, PhraseIndex>();
function phraseIndexFor(dict: Dictionary): PhraseIndex {
  let index = phraseIndexes.get(dict);
  if (!index) {
    index = buildPhraseIndex(dict);
    phraseIndexes.set(dict, index);
  }
  return index;
}

/**
 * Renders an English sentence where every word the dictionary knows shows its meaning on hover
 * (or tap), and every English word is read aloud when clicked. Words that form a phrase together
 * ("doggy bag", "kept my fingers crossed") are underlined as one and show the phrase's meaning
 * above the word's own: "doggy" alone is 犬の, but here it is part of 持ち帰り用の袋.
 */
export default function GlossedText({ text, dict, enabled, className, withhold }: Props) {
  const [tip, setTip] = useState<Tip | null>(null);
  const [saying, setSaying] = useState<number | null>(null);
  const canSpeak = isTtsSupported();

  // Which piece belongs to which phrase. Digit-only pieces are skipped when counting words, the
  // same way tokenize() drops them, so word positions line up with the phrase matcher's.
  const { parts, spanOf, spans } = useMemo(() => {
    const parts = pieces(text);
    const spanOf: (number | null)[] = parts.map(() => null);
    if (!enabled || !dict) return { parts, spanOf, spans: [] as { key: string; gloss: string }[] };

    const wordPiece: number[] = [];
    const words: string[] = [];
    parts.forEach((p, i) => {
      if (/^[\p{L}\p{N}]/u.test(p) && /\p{L}/u.test(p)) {
        wordPiece.push(i);
        words.push(normalizeWord(p));
      }
    });
    const spans: { key: string; gloss: string }[] = [];
    for (const s of phraseSpans(words, phraseIndexFor(dict))) {
      const gloss = dict[s.key];
      if (!gloss || gloss === withhold) continue;
      const k = spans.push({ key: s.key, gloss }) - 1;
      for (let i = wordPiece[s.start]; i <= wordPiece[s.end - 1]; i++) spanOf[i] = k;
    }
    return { parts, spanOf, spans };
  }, [text, dict, enabled, withhold]);

  useEffect(() => {
    setTip(null);
    setSaying(null);
  }, [text, enabled]);
  useEffect(() => {
    if (!tip) return;
    const clear = () => setTip(null);
    window.addEventListener("scroll", clear, true);
    return () => window.removeEventListener("scroll", clear, true);
  }, [tip]);

  // Nothing to offer: no meanings to show and no voice to play.
  if ((!enabled || !dict) && !canSpeak) return <span className={className}>{text}</span>;

  const say = (word: string, at: number) => {
    setSaying(at);
    speak(word)
      .catch(() => undefined)
      .finally(() => setSaying((cur) => (cur === at ? null : cur)));
  };

  const isActive = (i: number) => tip !== null && (tip.span !== null ? spanOf[i] === tip.span : tip.piece === i);

  return (
    <span className={className}>
      {parts.map((part, i) => {
        const span = spanOf[i];
        // Only Latin-script words are looked up or spoken; Japanese and punctuation pass through.
        if (!/^[A-Za-z]/.test(part)) {
          // A gap inside a phrase keeps the phrase's underline unbroken.
          if (span === null) return <span key={i}>{part}</span>;
          return (
            <span key={i} className={"phrase-gap" + (isActive(i) ? " active" : "")}>
              {part}
            </span>
          );
        }
        const own = enabled && dict ? lookup(dict, part) : undefined;
        const gloss = own && own !== withhold ? own : undefined;
        const phrase = span !== null ? spans[span] : undefined;
        if (!gloss && !phrase && !canSpeak) return <span key={i}>{part}</span>;

        const show = (el: HTMLElement) => {
          const r = el.getBoundingClientRect();
          setTip({ x: r.left + r.width / 2, y: r.top, word: part, gloss, phrase, span, piece: i });
        };
        const cls = [
          gloss || phrase ? "glossed" : "speakable",
          phrase ? "phrase" : "",
          canSpeak ? "can-speak" : "",
          isActive(i) ? "active" : "",
          saying === i ? "saying" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <span
            key={i}
            className={cls}
            title={canSpeak ? "クリックで発音" : undefined}
            onMouseEnter={gloss || phrase ? (e) => show(e.currentTarget) : undefined}
            onMouseLeave={gloss || phrase ? () => setTip(null) : undefined}
            onClick={(e) => {
              e.stopPropagation();
              if (gloss || phrase) show(e.currentTarget);
              if (canSpeak) say(part, i);
            }}
          >
            {part}
          </span>
        );
      })}
      {tip && (tip.phrase || tip.gloss) && (
        <span className="gloss-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
          {tip.phrase && (
            <span className="gloss-line">
              <b>{tip.phrase.key}</b>
              {tip.phrase.gloss}
            </span>
          )}
          {tip.gloss && (
            <span className={"gloss-line" + (tip.phrase ? " sub" : "")}>
              <b>{tip.word}</b>
              {tip.gloss}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
