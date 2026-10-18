/**
 * LexiLink's candies: wrapped, half open (the one frame between), open (the word on a faint candy
 * on its flattened wrapper), and the wrapper alone once the pair is eaten. The shapes are drawn once
 * per screen (`CandyShapes`) and each candy uses them.
 */
export type CandyFrame = "wrapped" | "half" | "open" | "empty";

export function CandyShapes() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
      <defs>
        <pattern id="lexi-stripe" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
          <rect width="9" height="9" fill="#f6b9c9" />
          <rect width="4" height="9" fill="#fde5ec" />
        </pattern>
        <symbol id="lexi-wrapped" viewBox="0 0 140 84">
          <path d="M46 33 L16 14 Q11 29 18 42 Q11 55 16 70 L46 51 Z" fill="#f8cad6" stroke="#e595ab" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M24 22 L42 37 M22 62 L42 47 M17 42 L42 42" stroke="#e595ab" strokeWidth="1" fill="none" />
          <path d="M94 33 L124 14 Q129 29 122 42 Q129 55 124 70 L94 51 Z" fill="#f8cad6" stroke="#e595ab" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M116 22 L98 37 M118 62 L98 47 M123 42 L98 42" stroke="#e595ab" strokeWidth="1" fill="none" />
          <rect x="40" y="19" width="60" height="46" rx="23" fill="url(#lexi-stripe)" stroke="#e595ab" strokeWidth="1.5" />
          <ellipse cx="60" cy="31" rx="13" ry="5" fill="#fff" opacity=".6" />
          <rect x="39" y="34" width="6" height="16" rx="3" fill="#e595ab" />
          <rect x="95" y="34" width="6" height="16" rx="3" fill="#e595ab" />
        </symbol>
        <symbol id="lexi-half" viewBox="0 0 140 84">
          <path
            d="M28 16 L56 7 L84 12 L112 5 L120 28 L132 43 L118 60 L122 79 L88 73 L58 79 L26 74 L20 55 L8 41 L22 28 Z"
            fill="url(#lexi-stripe)"
            stroke="#e595ab"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path d="M38 22 L70 42 L102 20 M36 68 L70 42 L106 66" stroke="#e595ab" fill="none" opacity=".75" />
          <path d="M44 30 L58 22 L82 24 L98 32 L98 54 L82 62 L58 62 L44 54 Z" fill="#fff6f8" opacity=".9" />
          <circle cx="70" cy="42" r="19" fill="#f7c6d3" opacity=".55" />
        </symbol>
        <symbol id="lexi-open" viewBox="0 0 140 84">
          <path
            d="M5 5 L40 2 L72 6 L104 1 L136 5 L138 30 L134 52 L137 81 L100 78 L70 83 L38 79 L3 82 L6 56 L2 30 Z"
            fill="url(#lexi-stripe)"
            stroke="#e595ab"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <path d="M12 11 L40 9 L72 12 L104 8 L129 11 L131 32 L127 52 L130 74 L100 71 L70 76 L38 72 L10 75 L13 56 L9 32 Z" fill="#fffaf7" />
          <path d="M18 22 L42 32 M122 18 L98 30 M20 64 L44 54 M122 68 L96 56 M70 13 L68 24 M72 72 L70 60" stroke="#f3d6de" strokeWidth="1.2" fill="none" />
          <circle cx="70" cy="42" r="27" fill="#f7c6d3" opacity=".38" />
          <ellipse cx="62" cy="31" rx="9" ry="4" fill="#fff" opacity=".7" />
        </symbol>
        <symbol id="lexi-empty" viewBox="0 0 140 84">
          <g opacity=".55">
            <path
              d="M5 5 L40 2 L72 6 L104 1 L136 5 L138 30 L134 52 L137 81 L100 78 L70 83 L38 79 L3 82 L6 56 L2 30 Z"
              fill="url(#lexi-stripe)"
              stroke="#e595ab"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
            <path d="M12 11 L40 9 L72 12 L104 8 L129 11 L131 32 L127 52 L130 74 L100 71 L70 76 L38 72 L10 75 L13 56 L9 32 Z" fill="#fffaf7" />
            <path
              d="M18 22 L42 32 M122 18 L98 30 M20 64 L44 54 M122 68 L96 56 M70 13 L68 24 M72 72 L70 60 M40 40 L60 46 M84 36 L102 44"
              stroke="#f0cfd8"
              strokeWidth="1.2"
              fill="none"
            />
          </g>
        </symbol>
      </defs>
    </svg>
  );
}

export function CandyArt({ frame }: { frame: CandyFrame }) {
  return (
    <svg className="candy-art" viewBox="0 0 140 84" aria-hidden="true">
      <use href={`#lexi-${frame}`} />
    </svg>
  );
}
