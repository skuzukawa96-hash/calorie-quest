import { useEffect, useState } from "react";
import { COM_LEVEL_ORDER, COM_LEVELS } from "../lib/lexiCom";
import { LEXI, LEXI_GENRES, LEXI_MODES, type LexiMode } from "../types";
import { LEXI_GENRE_LABEL, type LexiConfig } from "../screens/LexiLink";

const KEY = "cq-lexilink";
const DEFAULT: LexiConfig = { mode: "match", genre: "random", preferLearned: false, players: 1, names: ["プレイヤー1", "プレイヤー2"], com: null };
/** 2P's name while it is the computer (unless the learner named it) */
const COM_NAME = "COM";

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
      com: COM_LEVEL_ORDER.find((l) => l === kept.com) ?? null,
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
 * on one line, the names of 1P and 2P for 対戦 (which of them plays first is drawn each game), and the
 * button beside the rules. What was chosen is kept for the next time.
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
  /** COM on (at 普通 to start with) or off; 2P's name follows unless the learner named it */
  const setCom = (on: boolean) =>
    setConfig((c) => {
      const second = c.names[1].trim();
      const name = on ? (second === "" || second === DEFAULT.names[1] ? COM_NAME : c.names[1]) : second === COM_NAME ? DEFAULT.names[1] : c.names[1];
      return { ...c, com: on ? "normal" : null, names: [c.names[0], name] };
    });
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
              {who === 0 ? "1P" : "2P"}
              <input
                className={`p${who + 1}`}
                value={config.names[who]}
                maxLength={12}
                onChange={(e) => set({ names: who === 0 ? [e.target.value, config.names[1]] : [config.names[0], e.target.value] })}
              />
            </label>
          ))}
          {/* 2P played by the computer, at the level chosen beside it */}
          <label className="lexi-com" title="2Pをコンピューターにする">
            <input type="checkbox" checked={config.com !== null} onChange={(e) => setCom(e.target.checked)} />
            COM
          </label>
          {config.com && (
            <span className="lexi-chips">
              {COM_LEVEL_ORDER.map((l) => chip(config.com === l, COM_LEVELS[l].label, () => set({ com: l })))}
            </span>
          )}
        </div>
      )}
      <div className="lexi-go">
        <div className="lexi-rules">
          {config.players === 1 ? (
            <>
              1ペア <b>+3 kcal</b>／お手つき4回目以降 <b>−1 kcal</b>。クリアで <b>+10 kcal</b>
            </>
          ) : config.com ? (
            <>
              先攻はランダム。お手つきで交代。COM（{COM_LEVELS[config.com].label}）に勝つと <b>+{LEXI.comWinKcal[config.com]} kcal</b>、引き分けで{" "}
              <b>+{LEXI.comDrawKcal} kcal</b>、負けても <b>+{LEXI.comLoseKcal} kcal</b>
            </>
          ) : (
            <>
              先攻はランダム。取ったペアの数で勝負／お手つきで交代。最後まで遊ぶと <b>+{LEXI.versusKcal} kcal</b>
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
