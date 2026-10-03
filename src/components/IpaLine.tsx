import { STRESS_MARK } from "../lib/phonemes";
import { ipaWords, type Pronunciations } from "../lib/pronunciation";

/**
 * The sentence in IPA, one clickable span per sound. Right-clicking (or clicking) a sound explains
 * it under 発音のコツ. A word the pronouncing dictionary lacks keeps its spelling in place.
 */
export default function IpaLine({
  text,
  table,
  active,
  onPick,
}: {
  text: string;
  table: Pronunciations;
  active: string | null;
  onPick: (sound: string) => void;
}) {
  const words = ipaWords(text, table);
  if (!words.some((w) => w.sounds)) return null;
  return (
    <div className="ipa-line" title="発音記号を右クリックすると、下の「発音のコツ」にその音の解説が出ます">
      /
      {words.map((w, i) => (
        <span key={i} className="ipa-word">
          {i > 0 && " "}
          {w.sounds ? (
            w.sounds.map((s, j) =>
              s === STRESS_MARK ? (
                <span key={j} className="ipa-stress" title="この後の音節を強く読みます">
                  {s}
                </span>
              ) : (
                <span
                  key={j}
                  className={"ipa-sound" + (s === active ? " active" : "")}
                  onClick={() => onPick(s)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onPick(s);
                  }}
                >
                  {s}
                </span>
              ),
            )
          ) : (
            <span className="ipa-missing" title="発音記号の辞書にない語です">
              {w.word}
            </span>
          )}
        </span>
      ))}
      /
    </div>
  );
}
