import { useEffect, useState, type ReactNode } from "react";
import { detectTrickySounds, type TipKey } from "../lib/scoring";
import MouthDiagram from "./MouthDiagram";

const TIPS: Record<TipKey, { title: string; text: string; sample: string }> = {
  th: {
    title: "TH の音",
    text: "舌先を上下の前歯で軽く挟み、そのすき間から息を出します。「サ」「ザ」に逃げないのがコツ。",
    sample: "three / think / mother",
  },
  r: {
    title: "R の音",
    text: "舌先はどこにも触れません。舌を少し後ろに引いて口の中で浮かせ、唇を軽く丸めて「ゥル」のように。",
    sample: "river / right / read",
  },
  l: {
    title: "L の音",
    text: "舌先を上の前歯のすぐ裏（歯ぐき）にしっかり当て、舌の両わきから声を出します。",
    sample: "light / lead / library",
  },
  fv: {
    title: "F / V の音",
    text: "上の前歯を下唇に軽く当て、息（F）または声（V）でこすります。「フ」「ブ」にならないように。",
    sample: "favorite / very / family",
  },
  w: {
    title: "W の音",
    text: "唇を強く丸めて前に突き出し、「ウ」の形から次の母音へすばやく滑らせます。",
    sample: "water / world / wonderful",
  },
};

const HIGHLIGHT: Record<TipKey, RegExp> = {
  th: /th/gi,
  r: /r/gi,
  l: /l/gi,
  fv: /[fv]/gi,
  w: /\bw/gi,
};

/** Renders the sentence with the letters for the active sound underlined. */
export function HighlightedText({ text, active }: { text: string; active: TipKey | null }): ReactNode {
  if (!active) return <>{text}</>;
  const re = HIGHLIGHT[active];
  const parts: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    if (start > last) parts.push(<span key={`t${i++}`}>{text.slice(last, start)}</span>);
    parts.push(
      <mark key={`m${i++}`} className="sound-mark">
        {m[0]}
      </mark>,
    );
    last = start + m[0].length;
  }
  if (last < text.length) parts.push(<span key={`t${i++}`}>{text.slice(last)}</span>);
  return <>{parts}</>;
}

interface Props {
  text: string;
  active: TipKey | null;
  onActiveChange: (key: TipKey | null) => void;
}

export default function PronunciationTips({ text, active, onActiveChange }: Props) {
  const keys = detectTrickySounds(text);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (active && !keys.includes(active)) onActiveChange(keys[0] ?? null);
    if (!active && keys.length) onActiveChange(keys[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  if (!keys.length) return null;
  const tip = active ? TIPS[active] : null;

  return (
    <div className="tips">
      <div className="tips-head">
        <span>💡 発音のコツ</span>
        <div className="chips">
          {keys.map((k) => (
            <button
              key={k}
              type="button"
              className={"chip " + (active === k ? "active" : "")}
              onClick={() => {
                onActiveChange(k);
                setOpen(true);
              }}
            >
              {TIPS[k].title}
            </button>
          ))}
        </div>
        <button type="button" className="btn-link" onClick={() => setOpen((o) => !o)}>
          {open ? "閉じる" : "図解を見る"}
        </button>
      </div>
      {open && tip && active && (
        <div className="tips-body">
          <MouthDiagram variant={active} />
          <div>
            <div className="tips-title">{tip.title}</div>
            <p>{tip.text}</p>
            <div className="muted">例: {tip.sample}</div>
          </div>
        </div>
      )}
    </div>
  );
}
