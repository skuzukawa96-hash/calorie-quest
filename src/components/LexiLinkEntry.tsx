import { useEffect, useState } from "react";
import { LEXI_GENRES, LEXI_MODES, type LexiMode } from "../types";
import { LEXI_GENRE_LABEL, type LexiConfig } from "../screens/LexiLink";

const KEY = "cq-lexilink";
const DEFAULT: LexiConfig = { mode: "match", genre: "random", preferLearned: false, players: 1, names: ["プレイヤー1", "プレイヤー2"] };

/** What was chosen last time, each part only if it is still one of the choices (else the default). */
function loadConfig(): LexiConfig {
  try {
    const kept = JSON.parse(localStorage.getItem(KEY) ?? "null") as Record<string, unknown> | null;
    if (!kept || typeof kept !== "object") return DEFAULT;
    const names = kept.names;
    return {
      mode: LEXI_MODES.find((m) => m === kept.mode) ?? DEFAULT.mode,
      genre: LEXI_GENRES.find((g) => g === kept.genre) ?? DEFAULT.genre,
      preferLearned: typeof kept.preferLearned === "boolean" ? kept.preferLearned : DEFAULT.preferLearned,
      players: kept.players === 2 ? 2 : 1,
      names:
        Array.isArray(names) && names.length === 2 && names.every((n) => typeof n === "string")
          ? [names[0] as string, names[1] as string]
          : DEFAULT.names,
    };
  } catch {
    return DEFAULT;
  }
}

/** The pictures under the tiles' words: two pieces that fit, two arrows face to face, one and two people. */
function Picture({ kind }: { kind: "match" | "opposites" | "one" | "two" }) {
  return (
    <svg className="lexi-ill" viewBox="0 0 120 92" aria-hidden="true">
      {kind === "match" && (
        <>
          <path d="M14 22 h34 a10 10 0 1 1 18 0 h0 v26 a10 10 0 1 0 0 18 v14 h-52 z" fill="#f1cf9a" stroke="#c98a3e" strokeWidth="2.5" strokeLinejoin="round" />
          <path d="M74 22 h36 v58 h-36 v-14 a10 10 0 1 1 0 -18 z" fill="#bfe3c9" stroke="#4f9d69" strokeWidth="2.5" strokeLinejoin="round" />
        </>
      )}
      {kind === "opposites" && (
        <>
          <path d="M8 46 H48 M48 46 l-12 -12 M48 46 l-12 12" stroke="#3b7dd8" strokeWidth="7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M112 46 H72 M72 46 l12 -12 M72 46 l12 12" stroke="#d9577f" strokeWidth="7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="60" cy="46" r="4" fill="#c98a3e" />
        </>
      )}
      {kind === "one" && (
        <>
          <circle cx="64" cy="30" r="16" fill="#c98a3e" />
          <path d="M32 92 C32 64 46 52 64 52 C82 52 96 64 96 92 Z" fill="#c98a3e" />
        </>
      )}
      {kind === "two" && (
        <>
          <circle cx="42" cy="32" r="14" fill="#d9577f" />
          <path d="M14 92 C14 66 26 55 42 55 C58 55 70 66 70 92 Z" fill="#d9577f" />
          <circle cx="82" cy="32" r="14" fill="#3b7dd8" />
          <path d="M54 92 C54 66 66 55 82 55 C98 55 110 66 110 92 Z" fill="#3b7dd8" />
        </>
      )}
    </svg>
  );
}

/**
 * LexiLink on the home screen, under the exams: Word Match / Opposites and ひとりで挑戦 / ふたりで対戦 as
 * tiles on one line (2:2:3, the two of players one above the other), the genre and the words asked
 * on one line, the names of 先攻 and 後攻 for 対戦, and the button beside the rules. What was chosen is
 * kept for the next time.
 */
export default function LexiLinkEntry({ onStart }: { onStart: (config: LexiConfig) => void }) {
  const [config, setConfig] = useState<LexiConfig>(loadConfig);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(config));
    } catch {
      /* ignore */
    }
  }, [config]);
  const set = (patch: Partial<LexiConfig>) => setConfig((c) => ({ ...c, ...patch }));
  const mode = (m: LexiMode, title: string, sub: string) => (
    <button type="button" className={"lexi-tile mode" + (config.mode === m ? " on" : "")} onClick={() => set({ mode: m })} aria-pressed={config.mode === m}>
      <Picture kind={m} />
      <span className="lexi-tile-text">
        <span className="lexi-tile-en">{title}</span>
        <span className="lexi-tile-ja">{sub}</span>
      </span>
    </button>
  );
  const players = (n: 1 | 2, title: string) => (
    <button type="button" className={"lexi-tile player" + (config.players === n ? " on" : "")} onClick={() => set({ players: n })} aria-pressed={config.players === n}>
      <Picture kind={n === 1 ? "one" : "two"} />
      <span className="lexi-tile-text lexi-tile-title">{title}</span>
    </button>
  );
  const chip = (on: boolean, label: string, onClick: () => void) => (
    <button key={label} type="button" className={"lexi-chip" + (on ? " on" : "")} onClick={onClick} aria-pressed={on}>
      {label}
    </button>
  );
  return (
    <section className="card lexi-entry">
      <div className="section-head">
        <h2>🍬 LexiLink</h2>
        <span className="muted small">英単語の神経衰弱。同じペアの2枚をめくって取ろう</span>
      </div>
      <div className="lexi-pick">
        {mode("match", "Word Match", "英単語 × 意味")}
        {mode("opposites", "Opposites", "英単語 × 対義語")}
        <div className="lexi-players">
          {players(1, "ひとりで挑戦")}
          {players(2, "ふたりで対戦")}
        </div>
      </div>
      <div className="lexi-opts">
        <span className="lexi-opt-label">ジャンル</span>
        <span className="lexi-chips">{LEXI_GENRES.map((g) => chip(config.genre === g, LEXI_GENRE_LABEL[g], () => set({ genre: g })))}</span>
        <span className="lexi-sep" />
        <span className="lexi-opt-label">出題</span>
        <span className="lexi-chips">
          {chip(!config.preferLearned, "無作為", () => set({ preferLearned: false }))}
          {chip(config.preferLearned, "学習済みを優先", () => set({ preferLearned: true }))}
        </span>
      </div>
      {config.players === 2 && (
        <div className="lexi-names">
          {([0, 1] as const).map((who) => (
            <label key={who}>
              {who === 0 ? "先攻" : "後攻"}
              <input
                className={`p${who + 1}`}
                value={config.names[who]}
                maxLength={12}
                onChange={(e) => set({ names: who === 0 ? [e.target.value, config.names[1]] : [config.names[0], e.target.value] })}
              />
            </label>
          ))}
        </div>
      )}
      <div className="lexi-go">
        <div className="lexi-rules">
          {config.players === 1 ? (
            <>
              1ペア <b>+3 kcal</b>／お手つき4回目以降 <b>−1 kcal</b>。クリアで <b>+10 kcal</b>
            </>
          ) : (
            <>
              取ったペアの数で勝負／お手つきで交代。最後まで遊ぶと <b>+30 kcal</b>
            </>
          )}
        </div>
        <button className="btn lexi-btn-go" onClick={() => onStart(config)}>
          {config.players === 1 ? "挑戦する" : "対戦する"}
        </button>
      </div>
    </section>
  );
}
