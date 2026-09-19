import { useEffect, useMemo, useState } from "react";
import { lookup, type Dictionary } from "../lib/dictionary";

interface Props {
  text: string;
  dict: Dictionary | null;
  /** When off the text renders as plain text with no hover targets. */
  enabled: boolean;
  className?: string;
}

interface Tip {
  word: string;
  gloss: string;
  x: number;
  y: number;
}

/** Splits into word / separator pieces so punctuation and spacing survive untouched. */
function pieces(text: string): string[] {
  return text.split(/([A-Za-z]+(?:['’][A-Za-z]+)?)/).filter((p) => p !== "");
}

/**
 * Renders an English sentence where every word the dictionary knows shows its meaning
 * on hover (or tap). Used for phrases, idioms and sentences, where the learner is
 * reading a full line rather than a single vocabulary item.
 */
export default function GlossedText({ text, dict, enabled, className }: Props) {
  const [tip, setTip] = useState<Tip | null>(null);
  const parts = useMemo(() => pieces(text), [text]);

  useEffect(() => setTip(null), [text, enabled]);
  useEffect(() => {
    if (!tip) return;
    const clear = () => setTip(null);
    window.addEventListener("scroll", clear, true);
    return () => window.removeEventListener("scroll", clear, true);
  }, [tip]);

  if (!enabled || !dict) return <span className={className}>{text}</span>;

  const show = (word: string, gloss: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setTip({ word, gloss, x: r.left + r.width / 2, y: r.top });
  };

  return (
    <span className={className}>
      {parts.map((part, i) => {
        const gloss = /^[A-Za-z]/.test(part) ? lookup(dict, part) : undefined;
        if (!gloss) return <span key={i}>{part}</span>;
        return (
          <span
            key={i}
            className={"glossed " + (tip?.word === part ? "active" : "")}
            onMouseEnter={(e) => show(part, gloss, e.currentTarget)}
            onMouseLeave={() => setTip(null)}
            onClick={(e) => {
              e.stopPropagation();
              if (tip?.word === part) setTip(null);
              else show(part, gloss, e.currentTarget);
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
