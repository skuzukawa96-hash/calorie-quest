import type { TipKey } from "../lib/scoring";

interface Props {
  variant: TipKey;
}

/**
 * Side-view mouth cross-section (facing left). The tongue/lip shapes change per sound
 * so the learner can see where the tongue tip goes.
 */
export default function MouthDiagram({ variant }: Props) {
  const tongue: Record<TipKey, string> = {
    // Tongue bunched back, tip curled up but touching nothing.
    r: "M176,104 C150,74 116,64 92,70 C76,74 70,64 80,58 C86,56 90,62 86,66 C80,70 82,76 92,78 C124,86 150,100 176,104 Z",
    // Tip pressed against the ridge just behind the upper teeth.
    l: "M176,104 C142,88 96,84 66,72 L52,48 L60,48 C72,76 118,92 176,104 Z",
    // Tip slides between the upper and lower teeth.
    th: "M176,104 C142,90 92,88 60,80 L26,74 L28,82 L60,88 C118,98 150,102 176,104 Z",
    // Flat tongue; the lip does the work.
    fv: "M176,104 C140,90 92,92 60,90 L52,92 C92,102 140,106 176,104 Z",
    // Back of the tongue raised toward the soft palate.
    w: "M176,104 C160,72 132,64 110,72 C92,80 72,88 56,90 C92,102 140,106 176,104 Z",
  };

  const lips = {
    // [upper lip cx, cy, lower lip cx, cy]
    r: [34, 52, 34, 96],
    l: [34, 50, 34, 98],
    th: [34, 48, 34, 100],
    fv: [34, 50, 40, 70],
    w: [22, 60, 22, 88],
  }[variant];

  const airflow =
    variant === "th" || variant === "fv"
      ? "M30,75 L8,75"
      : variant === "w"
        ? "M14,74 L2,74"
        : "M44,75 L12,75";

  return (
    <svg viewBox="0 0 200 150" className="mouth-diagram" role="img" aria-label={`${variant} の口の形`}>
      {/* palate and jaw outline */}
      <path d="M46,44 Q110,14 178,58" fill="none" stroke="var(--choco)" strokeWidth="3" strokeLinecap="round" />
      <path d="M46,106 Q110,134 178,102" fill="none" stroke="var(--choco)" strokeWidth="3" strokeLinecap="round" />
      <path d="M178,58 L178,102" fill="none" stroke="var(--choco)" strokeWidth="2" strokeDasharray="4 4" />
      {/* alveolar ridge marker for L */}
      {variant === "l" && <circle cx="56" cy="47" r="4" fill="var(--caramel)" />}
      {/* tongue */}
      <path d={tongue[variant]} fill="#e6899a" stroke="#b85c6f" strokeWidth="2" strokeLinejoin="round" />
      {/* teeth */}
      <rect x="38" y="45" width="12" height="17" rx="2" fill="#fff" stroke="var(--choco)" strokeWidth="2" />
      <rect x="38" y="88" width="12" height="17" rx="2" fill="#fff" stroke="var(--choco)" strokeWidth="2" />
      {/* lips */}
      <ellipse cx={lips[0]} cy={lips[1]} rx="9" ry="8" fill="#c96b6b" stroke="var(--choco)" strokeWidth="2" />
      <ellipse cx={lips[2]} cy={lips[3]} rx="9" ry="8" fill="#c96b6b" stroke="var(--choco)" strokeWidth="2" />
      {/* airflow */}
      <path d={airflow} fill="none" stroke="var(--caramel)" strokeWidth="3" strokeLinecap="round" strokeDasharray="6 5" />
      <path d="M8,70 L2,75 L8,80" fill="none" stroke="var(--caramel)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <text x="100" y="140" textAnchor="middle" fontSize="12" fill="var(--muted)">
        ← 前　　　　　　　後ろ →
      </text>
    </svg>
  );
}
