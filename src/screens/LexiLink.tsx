import { useCallback, useEffect, useRef, useState } from "react";
import { CandyArt, CandyShapes, type CandyFrame } from "../components/Candy";
import SpeakableText from "../components/SpeakableText";
import { api } from "../lib/api";
import { loadDictionary, loadedDictionary, type Dictionary } from "../lib/dictionary";
import { playFanfare, playLexi, prepareLexiSounds } from "../lib/sfx";
import { speak, speakInTurn } from "../lib/speech";
import type { LexiCard, LexiGenre, LexiMode } from "../types";

/** What the home screen starts a game with. */
export interface LexiConfig {
  mode: LexiMode;
  genre: LexiGenre;
  preferLearned: boolean;
  players: 1 | 2;
  /** 先攻・後攻 (ふたりで対戦) */
  names: [string, string];
}

export const LEXI_MODE_LABEL: Record<LexiMode, string> = { match: "Word Match", opposites: "Opposites" };
export const LEXI_GENRE_LABEL: Record<LexiGenre, string> = { random: "ランダム", noun: "名詞", verb: "動詞", adjective: "形容詞", adverb: "副詞" };

/** ひとりで挑戦: 3 kcal a pair, −1 for each お手つき after the third, 10 for clearing (mirrors lexilink.rs). */
const PAIR_KCAL = 3;
const FREE_MISSES = 3;
const MISS_KCAL = 1;
const CLEAR_KCAL = 10;
const VERSUS_KCAL = 30;
/** how long two cards stay open before they are judged, and a miss before it is wrapped again
 * (long enough to read both) */
const LOOK_MS = 450;
const MISS_MS = 2000;

interface Cell {
  pair: number;
  card: LexiCard;
}
interface Taken {
  pair: number;
  left: LexiCard;
  right: LexiCard;
  /** who took it (0: 先攻 / ひとり, 1: 後攻) */
  by: 0 | 1;
}
type End = { kind: "complete"; kcal: number } | { kind: "win"; winner: 0 | 1 } | { kind: "draw" };

function shuffled<T>(list: T[]): T[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** ひとりで挑戦: what the game is worth so far. */
const soloKcal = (pairs: number, misses: number, cleared: boolean) =>
  pairs * PAIR_KCAL - Math.max(0, misses - FREE_MISSES) * MISS_KCAL + (cleared ? CLEAR_KCAL : 0);
const signed = (n: number) => (n < 0 ? `−${-n}` : `+${n}`);

/**
 * LexiLink（英単語の神経衰弱）: twenty wrapped candies, ten pairs. A candy opens in two frames with a
 * カサッ; two open candies of a pair light up (キラッ), are eaten (ぽりぽり) and leave their wrappers,
 * the English read aloud and the pair laid out below; two of no pair are wrapped again (お手つき), and
 * in 対戦 the turn passes. ひとりで: kcal as the game goes (paid when it ends, or what is above zero when
 * left part-way); ふたりで: the most pairs wins, and a game played to the end pays 30 kcal.
 */
export default function LexiLink({
  config,
  onExit,
  onProgress,
  toast,
}: {
  config: LexiConfig;
  onExit: () => void;
  onProgress: () => void;
  toast: (msg: string, ms?: number) => void;
}) {
  const solo = config.players === 1;
  const [cells, setCells] = useState<Cell[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frames, setFrames] = useState<CandyFrame[]>([]);
  const [open, setOpen] = useState<number[]>([]);
  const [glow, setGlow] = useState<number[]>([]);
  const [taken, setTaken] = useState<Taken[]>([]);
  const [misses, setMisses] = useState<[number, number]>([0, 0]);
  const [turn, setTurn] = useState<0 | 1>(0);
  const [end, setEnd] = useState<End | null>(null);
  const [asking, setAsking] = useState(false);
  const [dict, setDict] = useState<Dictionary | null>(loadedDictionary);
  const busy = useRef(false);
  const timers = useRef<number[]>([]);
  const later = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms));

  const deal = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    busy.current = false;
    setCells(null);
    setError(null);
    setOpen([]);
    setGlow([]);
    setTaken([]);
    setMisses([0, 0]);
    setTurn(0);
    setEnd(null);
    setAsking(false);
    api
      .dealLexiLink(config.mode, config.genre, config.preferLearned)
      .then((d) => {
        const list = shuffled(d.pairs.flatMap((p, i) => [{ pair: i, card: p.a }, { pair: i, card: p.b }]));
        setCells(list);
        setFrames(list.map(() => "wrapped"));
      })
      .catch((e) => setError(String(e)));
  }, [config.mode, config.genre, config.preferLearned]);

  useEffect(() => {
    prepareLexiSounds();
    deal();
    let alive = true;
    loadDictionary().then((d) => alive && setDict(d));
    return () => {
      alive = false;
      timers.current.forEach(clearTimeout);
    };
  }, [deal]);

  const pairs = taken.length;
  const pairsOf = (who: 0 | 1) => taken.filter((t) => t.by === who).length;
  const setFrame = (i: number, f: CandyFrame) => setFrames((cur) => cur.map((x, k) => (k === i ? f : x)));

  /** The game is over: its kcal, the sound and the words in the middle of the screen. */
  const finish = (allTaken: Taken[], missCount: [number, number]) => {
    if (solo) {
      const kcal = soloKcal(10, missCount[0], true);
      setEnd({ kind: "complete", kcal });
      playFanfare();
    } else {
      const [a, b] = [allTaken.filter((t) => t.by === 0).length, allTaken.filter((t) => t.by === 1).length];
      if (a === b) {
        setEnd({ kind: "draw" });
        playLexi("draw");
      } else {
        setEnd({ kind: "win", winner: a > b ? 0 : 1 });
        playLexi("win");
      }
    }
    api
      .finishLexiLink({ players: config.players, pairs: 10, misses: missCount[0], cleared: true })
      .then((r) => {
        if (r.newTicket) toast(`🎫 ${r.streak}日連続達成！チートデイチケットを獲得しました`, 4000);
        onProgress();
      })
      .catch((e) => toast(String(e)));
  };

  const flip = (i: number) => {
    if (!cells || busy.current || end || open.includes(i) || frames[i] === "empty") return;
    playLexi("unwrap");
    setFrame(i, "half");
    later(() => setFrame(i, "open"), 90);
    const now = [...open, i];
    setOpen(now);
    if (now.length < 2) return;
    busy.current = true;
    const [x, y] = now;
    later(() => {
      if (cells[x].pair === cells[y].pair) {
        setGlow([x, y]);
        playLexi("sparkle");
        later(() => {
          playLexi("crunch");
          setGlow([]);
          setFrames((cur) => cur.map((f, k) => (k === x || k === y ? "empty" : f)));
          // Word Match: English on the left; Opposites: the one opened first on the left.
          const [left, right] =
            config.mode === "match" ? (cells[x].card.english ? [cells[x].card, cells[y].card] : [cells[y].card, cells[x].card]) : [cells[x].card, cells[y].card];
          if (config.mode === "match") void speak(left.word).catch(() => undefined);
          else void speakInTurn([left.word, right.word], 350, () => undefined).catch(() => undefined);
          const next = [{ pair: cells[x].pair, left, right, by: turn }, ...taken];
          setTaken(next);
          setOpen([]);
          busy.current = false;
          if (next.length === 10) later(() => finish(next, misses), 700);
        }, 500);
      } else {
        later(() => {
          playLexi("rewrap");
          [x, y].forEach((k) => {
            setFrame(k, "half");
            later(() => setFrame(k, "wrapped"), 90);
          });
          const counted: [number, number] = turn === 0 ? [misses[0] + 1, misses[1]] : [misses[0], misses[1] + 1];
          setMisses(counted);
          setOpen([]);
          if (!solo) {
            setTurn(turn === 0 ? 1 : 0);
            later(() => playLexi("turn"), 250);
          }
          busy.current = false;
        }, MISS_MS - LOOK_MS);
      }
    }, LOOK_MS);
  };

  /** Left part-way: ひとりで, what the game is above zero; ふたりで, nothing (the day still counts). */
  const quit = () => {
    const played = pairs > 0 || misses[0] + misses[1] > 0;
    if (!played || end) {
      onExit();
      return;
    }
    api
      .finishLexiLink({ players: config.players, pairs, misses: misses[0], cleared: false })
      .then((r) => {
        if (r.kcalEarned > 0) toast(`🍬 LexiLink +${r.kcalEarned} kcal`);
        onProgress();
      })
      .catch((e) => toast(String(e)))
      .finally(onExit);
  };

  const soFar = soloKcal(pairs, misses[0], pairs === 10);
  const name = (who: 0 | 1) => config.names[who].trim() || `プレイヤー${who + 1}`;

  if (error) {
    return (
      <div className="screen">
        <div className="card">
          <p>{error}</p>
          <button className="btn" onClick={onExit}>
            ホームへ
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen lexi">
      <CandyShapes />
      <section className="card lexi-card">
        <div className="lexi-hud">
          <div className="lexi-hud-left">
            <button className="btn-link" onClick={() => (pairs > 0 || misses[0] + misses[1] > 0) && !end ? setAsking(true) : quit()}>
              ← やめる
            </button>
            <span className="tag">{LEXI_MODE_LABEL[config.mode]}</span>
            <span className="tag">{LEXI_GENRE_LABEL[config.genre]}</span>
          </div>
          {solo && (
            <div className="lexi-stats">
              <span>
                ペア <b>{pairs}</b>/10
              </span>
              <span title={`お手つきは${FREE_MISSES}回まで無料、${FREE_MISSES + 1}回目から −${MISS_KCAL} kcal`}>
                お手つき <b>{misses[0]}</b>
                <span className="miss-dots">
                  {Array.from({ length: FREE_MISSES }, (_, k) => (
                    <i key={k} className={k < misses[0] ? "used" : ""} />
                  ))}
                </span>
              </span>
              <span className="kcal">
                獲得 <b>{signed(soFar)}</b> kcal
              </span>
            </div>
          )}
        </div>
        {asking && (
          <div className="lexi-ask">
            <span>
              途中でやめますか？
              {solo ? (soFar > 0 ? `（ここまでの +${soFar} kcal はもらえます）` : "（カロリーは変わりません）") : "（対戦ボーナスはもらえません）"}
            </span>
            <button className="btn btn-small btn-danger" onClick={quit}>
              やめる
            </button>
            <button className="btn-link" onClick={() => setAsking(false)}>
              続ける
            </button>
          </div>
        )}

        {!solo && (
          <div className="lexi-versus">
            {([0, 1] as const).map((who) => (
              <div key={who} className={`lexi-player p${who + 1}` + (turn === who && !end ? " turn" : "")}>
                <div>
                  <div className="lexi-player-name">
                    {name(who)}
                    {turn === who && !end && <span className="lexi-turn-badge">番</span>}
                  </div>
                  <div className="muted small">お手つき {misses[who]}</div>
                </div>
                <div className="lexi-player-pts">
                  {pairsOf(who)}
                  <small>ペア</small>
                </div>
              </div>
            ))}
          </div>
        )}

        {cells ? (
          <div className="lexi-board">
            {cells.map((c, i) => (
              <button
                key={i}
                type="button"
                className={"lexi-candy" + (glow.includes(i) ? " glow" : "") + (frames[i] === "empty" ? " gone" : "")}
                onClick={() => flip(i)}
                disabled={frames[i] === "empty"}
                aria-label={frames[i] === "open" ? c.card.text : "キャンディ"}
              >
                <CandyArt frame={frames[i] ?? "wrapped"} />
                {frames[i] === "open" && (
                  <span className={"lexi-word" + (c.card.english ? " en" : " ja")} lang={c.card.english ? "en" : undefined}>
                    {c.card.text}
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <div className="loading">キャンディを並べています…</div>
        )}

        <div className="lexi-taken">
          <h4>取ったペア {pairs}/10</h4>
          <div className="lexi-taken-list">
            {taken.map((t, k) => (
              <span key={t.pair} className={"lexi-pair" + (k === 0 ? " new" : "")}>
                <span className="lexi-pair-l">
                  {!solo && <i className={`lexi-who p${t.by + 1}`} />}
                  <SpeakableText text={t.left.word} dict={dict} />
                  {config.mode === "opposites" && <span className="lexi-gloss">{t.left.meaning}</span>}
                </span>
                <span className="lexi-pair-r">
                  {config.mode === "opposites" ? (
                    <>
                      <SpeakableText text={t.right.word} dict={dict} />
                      <span className="lexi-gloss">{t.right.meaning}</span>
                    </>
                  ) : (
                    <span className="lexi-ja">{t.right.meaning}</span>
                  )}
                </span>
              </span>
            ))}
            {Array.from({ length: 10 - pairs }, (_, k) => (
              <span key={`slot-${k}`} className="lexi-slot" />
            ))}
          </div>
          <div className="muted small lexi-hint">英語のクリックで読み上げ、右クリックで単語帳に登録</div>
        </div>
      </section>

      {end && (
        <div className="lexi-overlay" role="dialog" aria-live="polite">
          <div className="lexi-confetti" aria-hidden="true">
            {Array.from({ length: 18 }, (_, k) => (
              <i key={k} style={{ left: `${(k * 53) % 100}%`, animationDelay: `${(k % 6) * 0.12}s` }} />
            ))}
          </div>
          <div className="lexi-burst">
            {end.kind === "complete" ? (
              <>
                <div className="lexi-big">COMPLETE!</div>
                <div className="lexi-sub">
                  合計 <b>{signed(end.kcal)} kcal</b>（ペア +{10 * PAIR_KCAL} ・ お手つき −{Math.max(0, misses[0] - FREE_MISSES) * MISS_KCAL} ・ クリア +
                  {CLEAR_KCAL}）
                </div>
              </>
            ) : (
              <>
                <div className={"lexi-big" + (end.kind === "win" ? " win" : " draw")}>{end.kind === "win" ? `${name(end.winner)} WIN!` : "DRAW"}</div>
                <div className="lexi-scoreline">
                  <span className="p1">
                    {name(0)} {pairsOf(0)}ペア
                  </span>
                  <span className="p2">
                    {name(1)} {pairsOf(1)}ペア
                  </span>
                </div>
                <div className="lexi-sub">
                  対戦ボーナス <b>+{VERSUS_KCAL} kcal</b>
                </div>
              </>
            )}
            <div className="lexi-btns">
              <button className="btn" onClick={deal}>
                もう一度
              </button>
              <button className="btn" onClick={onExit}>
                ホームへ
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
