import { useCallback, useEffect, useRef, useState } from "react";
import { CandyArt, CandyShapes, type CandyFrame } from "../components/Candy";
import SpeakableText from "../components/SpeakableText";
import { api } from "../lib/api";
import { COM_LEVELS, LexiCom, type ComLevel, type ComView } from "../lib/lexiCom";
import { loadDictionary, loadedDictionary, type Dictionary } from "../lib/dictionary";
import { playFanfare, playLexi, prepareLexiSounds } from "../lib/sfx";
import { prepareWords, stopSpeaking, type ReadyWords } from "../lib/speech";
import { LEXI, lexiScore, lexiSoloKcal, type LexiCard, type LexiGenre, type LexiMode } from "../types";

/** What the home screen starts a game with. */
export interface LexiConfig {
  mode: LexiMode;
  genre: LexiGenre;
  preferLearned: boolean;
  players: 1 | 2;
  /** 先攻・後攻 (ふたりで対戦) */
  names: [string, string];
  /** ふたりで対戦: 後攻 is the computer, at this level (null: a person) */
  com: ComLevel | null;
}

export const LEXI_MODE_LABEL: Record<LexiMode, string> = { match: "Word Match", opposites: "Opposites" };
export const LEXI_GENRE_LABEL: Record<LexiGenre, string> = { random: "ランダム", noun: "名詞", verb: "動詞", adjective: "形容詞", adverb: "副詞" };

/** how long two cards stay open before they are judged, and a miss before it is wrapped again
 * (long enough to read both) */
const LOOK_MS = 450;
const MISS_MS = 1500;
/** a pair taken: the glow, then the crunch, then (after its last bite) the English read aloud */
const GLOW_MS = 500;
const SAY_AFTER_CRUNCH_MS = 400;
/** the computer's turn: a moment before it turns its first candy, and its second (to follow it by eye) */
const COM_FIRST_MS = 900;
const COM_SECOND_MS = 900;

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
  /** the game's kcal have been asked for (finished, or left part-way): never twice */
  const settled = useRef(false);
  /** where the game stands for its kcal: a pair or a miss counts here the moment it is judged, before
   * the board has shown it (eaten, wrapped again), so leaving in between pays it as it is */
  const standing = useRef<{ pairs: number; misses: [number, number] }>({ pairs: 0, misses: [0, 0] });
  /** the deal asked for last: one answered after another was asked for is not laid out */
  const dealt = useRef(0);
  /** the board's English, its voices made as soon as it is dealt (read the moment a pair is eaten) */
  const voices = useRef<ReadyWords | null>(null);
  const timers = useRef<number[]>([]);
  const later = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms));
  /** the computer playing 後攻 (ふたりで対戦 with COM), one for the screen: its memory reset each game */
  const com = useRef<LexiCom | null>(null);
  /** the computer's next candy is on its way (one at a time) */
  const comWaiting = useRef(false);

  const deal = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    busy.current = false;
    comWaiting.current = false;
    if (config.players === 2 && config.com) {
      com.current ??= new LexiCom(COM_LEVELS[config.com]);
      com.current.reset();
    } else com.current = null;
    settled.current = false;
    standing.current = { pairs: 0, misses: [0, 0] };
    const asked = ++dealt.current;
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
        if (asked !== dealt.current) return;
        voices.current = prepareWords(d.pairs.flatMap((p) => [p.a, p.b]).filter((c) => c.english).map((c) => c.word));
        const list = shuffled(d.pairs.flatMap((p, i) => [{ pair: i, card: p.a }, { pair: i, card: p.b }]));
        setCells(list);
        setFrames(list.map(() => "wrapped"));
      })
      .catch((e) => asked === dealt.current && setError(String(e)));
  }, [config.mode, config.genre, config.preferLearned, config.players, config.com]);

  useEffect(() => {
    prepareLexiSounds();
    deal();
    let alive = true;
    loadDictionary().then((d) => alive && setDict(d));
    return () => {
      alive = false;
      timers.current.forEach(clearTimeout);
      stopSpeaking();
    };
  }, [deal]);

  const pairs = taken.length;
  const pairsOf = (who: 0 | 1) => taken.filter((t) => t.by === who).length;
  const setFrame = (i: number, f: CandyFrame) => setFrames((cur) => cur.map((x, k) => (k === i ? f : x)));
  /** a pair or a miss has been judged (read when a button is pressed: `standing` is ahead of the board) */
  const played = () => standing.current.pairs > 0 || standing.current.misses[0] + standing.current.misses[1] > 0;

  /** Pays the game once: what it is worth, its ticket if the day brings one, and the home refreshed. */
  const settle = (pairCount: number, missCount: [number, number], cleared: boolean, tell: boolean) => {
    if (settled.current) return Promise.resolve();
    settled.current = true;
    return api
      .finishLexiLink({ players: config.players, pairs: pairCount, misses: missCount[0], cleared })
      .then((r) => {
        if (tell && r.kcalEarned > 0) toast(`🍬 LexiLink +${r.kcalEarned} kcal`);
        if (r.newTicket) toast(`🎫 ${r.streak}日連続達成！チートデイチケットを獲得しました`, 4000);
        onProgress();
      })
      .catch((e) => toast(String(e)));
  };

  // Left by the tabs above: settled as ← やめる would (what is above zero ひとりで, nothing ふたりで;
  // the day counts as studied either way).
  useEffect(
    () => () => {
      if (played()) void settle(standing.current.pairs, standing.current.misses, false, true);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /** The game is over (already paid when the last pair was taken): the sound and the words in the middle of the screen. */
  const finish = (allTaken: Taken[], missCount: [number, number]) => {
    setAsking(false);
    if (solo) {
      const kcal = lexiSoloKcal(LEXI.pairs, missCount[0], true);
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
  };

  const flip = (i: number) => {
    if (!cells || busy.current || end || open.includes(i) || frames[i] === "empty") return;
    // Shown to the computer as it is to the players: this card, now face up, and no other.
    com.current?.see({ index: i, pair: cells[i].pair });
    playLexi("unwrap");
    setFrame(i, "half");
    later(() => setFrame(i, "open"), 90);
    const now = [...open, i];
    setOpen(now);
    if (now.length < 2) return;
    busy.current = true;
    const [x, y] = now;
    later(() => {
      const missed = standing.current.misses;
      if (cells[x].pair === cells[y].pair) {
        com.current?.forget([x, y]);
        const got = standing.current.pairs + 1;
        standing.current = { pairs: got, misses: missed };
        // The board cleared is paid the moment it is, so leaving before COMPLETE shows keeps the clear.
        if (got === LEXI.pairs) void settle(got, missed, true, false);
        setGlow([x, y]);
        playLexi("sparkle");
        later(() => {
          playLexi("crunch");
          setGlow([]);
          setFrames((cur) => cur.map((f, k) => (k === x || k === y ? "empty" : f)));
          // Word Match: English on the left; Opposites: the one opened first on the left.
          const [left, right] =
            config.mode === "match" ? (cells[x].card.english ? [cells[x].card, cells[y].card] : [cells[y].card, cells[x].card]) : [cells[x].card, cells[y].card];
          const words = config.mode === "match" ? [left.word] : [left.word, right.word];
          later(() => void voices.current?.say(words, 350).catch(() => undefined), SAY_AFTER_CRUNCH_MS);
          const next = [{ pair: cells[x].pair, left, right, by: turn }, ...taken];
          setTaken(next);
          setOpen([]);
          busy.current = false;
          if (next.length === LEXI.pairs) later(() => finish(next, missed), 700);
        }, GLOW_MS);
      } else {
        const counted: [number, number] = turn === 0 ? [missed[0] + 1, missed[1]] : [missed[0], missed[1] + 1];
        standing.current = { pairs: standing.current.pairs, misses: counted };
        later(() => {
          playLexi("rewrap");
          [x, y].forEach((k) => {
            setFrame(k, "half");
            later(() => setFrame(k, "wrapped"), 90);
          });
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

  /** The computer's turn (後攻): its candies are its own; a click on the board waits for the turn back. */
  const comTurn = !!com.current && turn === 1 && !end;

  /** The computer turns its next candy, chosen from what can be chosen and what is face up (the
   * board's faces down are not handed to it). */
  const comMove = () => {
    const ai = com.current;
    if (!ai || !cells || end || turn !== 1 || busy.current || open.length >= 2) return;
    const view: ComView = {
      selectable: cells.map((_, k) => k).filter((k) => frames[k] !== "empty" && !open.includes(k)),
      open: open.map((k) => ({ index: k, pair: cells[k].pair })),
    };
    const pick = open.length === 0 ? ai.pickFirst(view) : ai.pickSecond(view);
    if (pick !== null) flip(pick);
  };
  const comMoveNow = useRef(comMove);
  comMoveNow.current = comMove;
  // Its turn, the board still: the next candy after a moment (the first, or the second once the first is open).
  useEffect(() => {
    if (!comTurn || !cells || busy.current || comWaiting.current || open.length >= 2 || standing.current.pairs >= LEXI.pairs) return;
    comWaiting.current = true;
    later(
      () => {
        comWaiting.current = false;
        comMoveNow.current();
      },
      open.length === 0 ? COM_FIRST_MS : COM_SECOND_MS,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comTurn, cells, open, frames]);

  /** Left part-way: ひとりで, what the game is above zero; ふたりで, nothing (the day still counts). */
  const quit = () => {
    if (!played() || settled.current) {
      onExit();
      return;
    }
    void settle(standing.current.pairs, standing.current.misses, false, true).finally(onExit);
  };

  /** ひとりで: the HUD's score so far (below zero when the misses outweigh the pairs) and what leaving now adds */
  const soFar = lexiScore(pairs, misses[0], pairs === LEXI.pairs);
  // From `standing`, which a pair still lighting up is already in (each change to it comes with a
  // render: the glow, or the candies wrapped again).
  const ifLeft = lexiSoloKcal(standing.current.pairs, standing.current.misses[0], false);
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
            <button className="btn-link" onClick={() => (played() && !settled.current ? setAsking(true) : quit())}>
              ← やめる
            </button>
            <span className="tag">{LEXI_MODE_LABEL[config.mode]}</span>
            <span className="tag">{LEXI_GENRE_LABEL[config.genre]}</span>
          </div>
          {solo && (
            <div className="lexi-stats">
              <span>
                ペア <b>{pairs}</b>/{LEXI.pairs}
              </span>
              <span title={`お手つきは${LEXI.freeMisses}回まで無料、${LEXI.freeMisses + 1}回目から −${LEXI.missKcal} kcal`}>
                お手つき <b>{misses[0]}</b>
                <span className="miss-dots">
                  {Array.from({ length: LEXI.freeMisses }, (_, k) => (
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
              {solo ? (ifLeft > 0 ? `（ここまでの +${ifLeft} kcal はもらえます）` : "（カロリーは変わりません）") : "（対戦ボーナスはもらえません）"}
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
                  <div className="muted small">
                    {who === 1 && config.com && `COM・${COM_LEVELS[config.com].label}・`}お手つき {misses[who]}
                  </div>
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
          <div className={"lexi-board" + (comTurn ? " com-turn" : "")}>
            {cells.map((c, i) => (
              <button
                key={i}
                type="button"
                className={"lexi-candy" + (glow.includes(i) ? " glow" : "") + (frames[i] === "empty" ? " gone" : "")}
                onClick={() => !comTurn && flip(i)}
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
          <h4>取ったペア {pairs}/{LEXI.pairs}</h4>
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
            {Array.from({ length: LEXI.pairs - pairs }, (_, k) => (
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
                  合計 <b>{signed(end.kcal)} kcal</b>（ペア +{LEXI.pairs * LEXI.pairKcal} ・ お手つき −{Math.max(0, misses[0] - LEXI.freeMisses) * LEXI.missKcal} ・ クリア +
                  {LEXI.clearKcal}）
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
                  対戦ボーナス <b>+{LEXI.versusKcal} kcal</b>
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
