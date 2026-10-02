import { PLAY_MODE_INFO, PLAY_MODES, type PlayMode } from "../types";

/**
 * The play mode in the top bar: がんばり (red, earnings ×0.5) → 通常 (green) → お気軽 (blue, ×1.5),
 * one step a click. Hovering it explains the three.
 */
export default function PlayModeSwitch({ mode, onChange }: { mode: PlayMode; onChange: (mode: PlayMode) => void }) {
  const next = PLAY_MODES[(PLAY_MODES.indexOf(mode) + 1) % PLAY_MODES.length];
  return (
    <span className="play-mode">
      <button
        type="button"
        className={"play-mode-btn " + mode}
        onClick={() => onChange(next)}
        aria-label={`${PLAY_MODE_INFO[mode].label}モード（クリックで${PLAY_MODE_INFO[next].label}モードに切り替え）`}
      >
        {PLAY_MODE_INFO[mode].label}
      </button>
      <span className="play-mode-tip" role="tooltip">
        {PLAY_MODES.map((m) => (
          <span key={m} className={"play-mode-line" + (m === mode ? " current" : "")}>
            <b className={"play-mode-name " + m}>{PLAY_MODE_INFO[m].label}モード</b>
            {PLAY_MODE_INFO[m].desc}
          </span>
        ))}
        <span className="play-mode-note">
          学習・単語帳・試験・チートデイなど、カロリーがもらえるものすべてに掛かります。クリックで切り替え（がんばり → 通常 →
          お気軽）
        </span>
      </span>
    </span>
  );
}

/** "がんばり ×0.5" beside what an answer earned, when the mode is not 通常. */
export function PlayModeTag({ mode }: { mode: PlayMode }) {
  if (mode === "normal") return null;
  const info = PLAY_MODE_INFO[mode];
  return (
    <span className={"play-mode-tag " + mode}>
      {info.label} ×{info.multiplier}
    </span>
  );
}
