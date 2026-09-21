import { useEffect, useMemo, useState } from "react";
import { lookup, type Dictionary } from "../lib/dictionary";
import { isTtsSupported, speak } from "../lib/speech";

interface Props {
  text: string;
  dict: Dictionary | null;
  /** When off the words still speak on click, but no meanings are shown. */
  enabled: boolean;
  className?: string;
}

interface Tip {
  word: string;
  gloss: string;
  x: number;
  y: number;
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

/**
 * Renders an English sentence where every word the dictionary knows shows its meaning
 * on hover (or tap), and every English word is read aloud when clicked. Used for phrases,
 * idioms and sentences, where the learner is reading a full line rather than a single item.
 */
export default function GlossedText({ text, dict, enabled, className }: Props) {
  const [tip, setTip] = useState<Tip | null>(null);
  const [saying, setSaying] = useState<number | null>(null);
  const parts = useMemo(() => pieces(text), [text]);
  const canSpeak = isTtsSupported();

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

  const show = (word: string, gloss: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setTip({ word, gloss, x: r.left + r.width / 2, y: r.top });
  };

  const say = (word: string, at: number) => {
    setSaying(at);
    speak(word)
      .catch(() => undefined)
      .finally(() => setSaying((cur) => (cur === at ? null : cur)));
  };

  return (
    <span className={className}>
      {parts.map((part, i) => {
        // Only Latin-script words are looked up or spoken; Japanese and punctuation pass through.
        if (!/^[A-Za-z]/.test(part)) return <span key={i}>{part}</span>;
        const gloss = enabled && dict ? lookup(dict, part) : undefined;
        if (!gloss && !canSpeak) return <span key={i}>{part}</span>;
        const cls = [gloss ? "glossed" : "speakable", canSpeak ? "can-speak" : "", tip?.word === part ? "active" : "", saying === i ? "saying" : ""]
          .filter(Boolean)
          .join(" ");
        return (
          <span
            key={i}
            className={cls}
            title={canSpeak ? "クリックで発音" : undefined}
            onMouseEnter={gloss ? (e) => show(part, gloss, e.currentTarget) : undefined}
            onMouseLeave={gloss ? () => setTip(null) : undefined}
            onClick={(e) => {
              e.stopPropagation();
              if (gloss) show(part, gloss, e.currentTarget);
              if (canSpeak) say(part, i);
            }}
          >
            {part}
          </span>
        );
      })}
      {tip && (
        <span className="gloss-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
          <b>{tip.word}</b>
          {tip.gloss}
        </span>
      )}
    </span>
  );
}
