import { useEffect, useMemo, useState } from "react";
import {
  buildPhraseIndex,
  headword,
  lemmas,
  lookup,
  normalizeWord,
  phraseSpans,
  tokenize,
  type Dictionary,
  type PhraseIndex,
} from "../lib/dictionary";
import { useAddToRecipe } from "../lib/recipe";
import { isTtsSupported, speak } from "../lib/speech";

interface Props {
  text: string;
  dict: Dictionary | null;
  /** When off the words still speak on click, but no meanings are shown. */
  enabled: boolean;
  className?: string;
  /**
   * A meaning to keep hidden: the answer to the question on screen. Hovering "hit the books"
   * while the quiz asks what "hit the books" means must not show 猛勉強する.
   */
  withhold?: string | null;
  /**
   * The sentence a right-clicked word is saved with, when `text` is not it: a grammar prompt
   * still has its blank, and a lone answer word has no sentence at all. Defaults to `text`.
   */
  context?: string;
  contextJa?: string | null;
  /** A word or phrase to mark, such as the recipe entry this example sentence belongs to. */
  highlight?: string;
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

interface Span {
  key: string;
  gloss: string;
  /** its meaning is the answer being asked for, so it is not shown yet */
  hidden: boolean;
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

/** Which word pieces spell `target` ("heard", or "doggy bag"), inflections included. */
function highlightedPieces(wordPiece: number[], words: string[], target: string | undefined): Set<number> {
  const out = new Set<number>();
  const want = target ? tokenize(target) : [];
  if (want.length === 0) return out;
  const same = (w: string, t: string) => w === t || lemmas(w).includes(t) || lemmas(t).includes(w);
  for (let i = 0; i + want.length <= words.length; i++) {
    if (!want.every((t, k) => same(words[i + k], t))) continue;
    for (let p = wordPiece[i]; p <= wordPiece[i + want.length - 1]; p++) out.add(p);
    break;
  }
  return out;
}

/**
 * Renders an English sentence where every word the dictionary knows shows its meaning on hover
 * (or tap), every English word is read aloud when clicked, and right-clicking one saves it to
 * お菓子作りレシピ. Words that form a phrase together ("doggy bag", "kept my fingers crossed") are
 * underlined as one and show the phrase's meaning above the word's own: "doggy" alone is 犬の,
 * but here it is part of 持ち帰り用の袋.
 */
export default function GlossedText({ text, dict, enabled, className, withhold, context, contextJa, highlight }: Props) {
  const [tip, setTip] = useState<Tip | null>(null);
  const [saying, setSaying] = useState<number | null>(null);
  const [stashed, setStashed] = useState<number | null>(null);
  const canSpeak = isTtsSupported();
  const addToRecipe = useAddToRecipe();

  // Which piece belongs to which phrase. Digit-only pieces are skipped when counting words, the
  // same way tokenize() drops them, so word positions line up with the phrase matcher's. Phrases
  // are found even with meanings off: right-click still offers the phrase for the recipe.
  const { parts, spanOf, spans, marked } = useMemo(() => {
    const parts = pieces(text);
    const spanOf: (number | null)[] = parts.map(() => null);
    const wordPiece: number[] = [];
    const words: string[] = [];
    parts.forEach((p, i) => {
      if (/^[\p{L}\p{N}]/u.test(p) && /\p{L}/u.test(p)) {
        wordPiece.push(i);
        words.push(normalizeWord(p));
      }
    });
    const spans: Span[] = [];
    if (dict) {
      for (const s of phraseSpans(words, phraseIndexFor(dict))) {
        const gloss = dict[s.key];
        if (!gloss) continue;
        const k = spans.push({ key: s.key, gloss, hidden: gloss === withhold }) - 1;
        for (let i = wordPiece[s.start]; i <= wordPiece[s.end - 1]; i++) spanOf[i] = k;
      }
    }
    return { parts, spanOf, spans, marked: highlightedPieces(wordPiece, words, highlight) };
  }, [text, dict, withhold, highlight]);

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
  useEffect(() => {
    if (stashed === null) return;
    const t = window.setTimeout(() => setStashed(null), 700);
    return () => window.clearTimeout(t);
  }, [stashed]);

  // Nothing to offer: no meanings to show, no voice to play, nowhere to save a word.
  if ((!enabled || !dict) && !canSpeak && !addToRecipe && marked.size === 0) {
    return <span className={className}>{text}</span>;
  }

  const say = (word: string, at: number) => {
    setSaying(at);
    speak(word)
      .catch(() => undefined)
      .finally(() => setSaying((cur) => (cur === at ? null : cur)));
  };

  const stash = (part: string, at: number) => {
    if (!addToRecipe) return;
    const { word, meaning } = headword(dict, part);
    const span = spanOf[at];
    const phrase = span !== null ? spans[span] : undefined;
    addToRecipe({
      word,
      meaning,
      form: normalizeWord(part),
      example: context ?? text,
      exampleJa: contextJa ?? "",
      phrase: phrase && { word: phrase.key, meaning: phrase.gloss },
    });
    setStashed(at);
  };

  /** The phrase a piece shows as part of, if meanings are on and it is not the withheld answer. */
  const shownSpan = (i: number): number | null => {
    const s = spanOf[i];
    return enabled && dict && s !== null && !spans[s].hidden ? s : null;
  };
  const isActive = (i: number) => tip !== null && (tip.span !== null ? shownSpan(i) === tip.span : tip.piece === i);
  const hint = [canSpeak && "クリックで発音", addToRecipe && "右クリックでレシピに追加"].filter(Boolean).join("・") || undefined;

  return (
    <span className={className}>
      {parts.map((part, i) => {
        const span = shownSpan(i);
        const mark = marked.has(i) ? " recipe-mark" : "";
        // Only Latin-script words are looked up or spoken; Japanese and punctuation pass through.
        if (!/^[A-Za-z]/.test(part)) {
          // A gap inside a phrase keeps the phrase's underline unbroken.
          if (span === null) return mark ? <span key={i} className={mark.trim()}>{part}</span> : <span key={i}>{part}</span>;
          return (
            <span key={i} className={"phrase-gap" + (isActive(i) ? " active" : "") + mark}>
              {part}
            </span>
          );
        }
        const own = enabled && dict ? lookup(dict, part) : undefined;
        const gloss = own && own !== withhold ? own : undefined;
        const phrase = span !== null ? spans[span] : undefined;
        if (!gloss && !phrase && !canSpeak && !addToRecipe) {
          return mark ? <span key={i} className={mark.trim()}>{part}</span> : <span key={i}>{part}</span>;
        }

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
          stashed === i ? "stashed" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <span
            key={i}
            className={cls + mark}
            title={hint}
            onMouseEnter={gloss || phrase ? (e) => show(e.currentTarget) : undefined}
            onMouseLeave={gloss || phrase ? () => setTip(null) : undefined}
            onClick={(e) => {
              e.stopPropagation();
              if (gloss || phrase) show(e.currentTarget);
              if (canSpeak) say(part, i);
            }}
            onContextMenu={
              addToRecipe
                ? (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    stash(part, i);
                  }
                : undefined
            }
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
