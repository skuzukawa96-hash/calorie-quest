import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { CandyArt, CandyShapes, type CandyFrame } from "../components/Candy";
import SpeakableText from "../components/SpeakableText";
import { api } from "../lib/api";
import { COM_LEVELS, LexiCom, type ComLevel, type ComView } from "../lib/lexiCom";
import { loadDictionary, loadedDictionary, type Dictionary } from "../lib/dictionary";
import { playFanfare, playLexi, prepareLexiSounds } from "../lib/sfx";
import { prepareWords, stopSpeaking, type ReadyWords } from "../lib/speech";
import { CLICK, RIGHT_CLICK } from "../lib/touch";
import { LEXI, lexiScore, lexiSoloKcal, lexiVersusKcal, type LexiCard, type LexiGenre, type LexiMode } from "../types";

/** What the home screen starts a game with. */
export interface LexiConfig {
  mode: LexiMode;
  genre: LexiGenre;
  preferLearned: boolean;
  players: 1 | 2;
  /** 1P・2P (ふたりで対戦; which of them plays first is drawn each game) */
  names: [string, string];
  /** ふたりで対戦: 2P is the computer, at this level (null: a person) */
  com: ComLevel | null;
}

export const LEXI_MODE_LABEL: Record<LexiMode, string> = { match: "Word Match", opposites: "Opposites" };
export const LEXI_GENRE_LABEL: Record<LexiGenre, string> = { random: "ランダム", noun: "名詞", verb: "動詞", adjective: "形容詞", adverb: "副詞" };

/** how long two cards stay open before they are judged, and a miss before it is wrapped again
 * (long enough to read both) */
const LOOK_MS = 450;
const MISS_MS = 1500;
/** a pair taken: the glow, then the crunch */
const GLOW_MS = 500;
/** a candy opened: its English read aloud once the unwrapping has sounded (its カサッ is over by then) */
const SAY_AFTER_UNWRAP_MS = 450;
/** the computer's turn: a moment before it turns its first candy, and its second (to follow it by eye) */
const COM_FIRST_MS = 900;
const COM_SECOND_MS = 900;
/** ふたりで: who plays first (drawn at random each game), shown on the board before the first candy */
const OPENER_MS = 1400;
/** 手動で閉じる (kept for the next game): two candies of no pair stay open until a click */
const HOLD_KEY = "cq-lexilink-hold";

function loadHold(): boolean {
  try {
    return localStorage.getItem(HOLD_KEY) === "1";
  } catch {
    return false;
  }
}

interface Cell {
  pair: number;
  card: LexiCard;
}
interface Taken {
  pair: number;
  left: LexiCard;
  right: LexiCard;
  /** who took it (0: 1P / ひとり, 1: 2P) */
  by: 0 | 1;
}
/** the game over: ひとりで complete; ふたりで won by one, drawn, or (against the computer) lost by 1P */
type End = { kind: "complete"; kcal: number } | { kind: "win"; winner: 0 | 1 } | { kind: "draw" } | { kind: "lose" };

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
 * How many letters an open candy has to fit across, for its text's size (styles.css: the width of
 * the candy over this, up to the usual size), so that it takes two lines at most: an English card
 * the narrowest line its words break into two lines at (a word alone fits on one), a Japanese one
 * its length on one line up to six, else on two lines.
 */
function fitOf(card: LexiCard): number {
  if (card.english) return twoLineWidth(card.text.split(/\s+/).filter(Boolean));
  const n = [...card.text].length;
  return n <= 6 ? n : Math.ceil(n / 2);
}

/** The fewest letters a line must hold for `words`, broken at their spaces, to take two lines. */
function twoLineWidth(words: string[]): number {
  const total = words.join(" ").length;
  for (let width = Math.max(1, ...words.map((w) => w.length)); width < total; width++) {
    let lines = 1;
    let line = 0;
    for (const w of words) {
      const joined = line ? line + 1 + w.length : w.length;
      if (joined > width) {
        lines++;
        line = w.length;
      } else {
        line = joined;
      }
    }
    if (lines <= 2) return width;
  }
  return Math.max(1, total);
}

/**
 * LexiLink（英単語の神経衰弱）: twenty wrapped candies, ten pairs. A candy opens in two frames with a
 * カサッ; two open candies of a pair light up (キラッ), are eaten (ぽりぽり) and leave their wrappers,
 * the English read aloud and the pair laid out below; two of no pair are wrapped again (お手つき; with
 * 手動で閉じる on, once the board is clicked), and in 対戦 the turn passes. ひとりで: kcal as the game goes
 * (paid when it ends, or what is above zero when left part-way); ふたりで: who plays first is drawn,
 * the most pairs wins, and a game played to the end pays 30 kcal.
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
  /** the game over, its end put away to save words from the pairs taken (単語を登録する) */
  const [browsing, setBrowsing] = useState(false);
  /** ふたりで: who plays first, while it is shown on the board (the board waits) */
  const [opener, setOpener] = useState<0 | 1 | null>(null);
  /** 手動で閉じる: a miss stays open until a click on the board (for whoever needs longer to remember) */
  const [hold, setHold] = useState(loadHold);
  const holdNow = useRef(hold);
  holdNow.current = hold;
  /** two candies of no pair held open (手動で閉じる): what wraps them again and passes the turn */
  const closeHeld = useRef<(() => void) | null>(null);
  const [holding, setHolding] = useState(false);
  const [dict, setDict] = useState<Dictionary | null>(loadedDictionary);
  const busy = useRef(false);
  /** the game's kcal have been asked for (finished, or left part-way): never twice */
  const settled = useRef(false);
  /** where the game stands for its kcal: a pair or a miss counts here the moment it is judged, before
   * the board has shown it (eaten, wrapped again), so leaving in between pays it as it is */
  const standing = useRef<{ pairs: number; misses: [number, number]; mine: number }>({ pairs: 0, misses: [0, 0], mine: 0 });
  /** the deal asked for last: one answered after another was asked for is not laid out */
  const dealt = useRef(0);
  /** the board's English, its voices made as soon as it is dealt (read the moment a candy is opened) */
  const voices = useRef<ReadyWords | null>(null);
  const timers = useRef<number[]>([]);
  const later = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms));
  /** the computer playing 2P (ふたりで対戦 with COM), one for the screen: its memory reset each game */
  const com = useRef<LexiCom | null>(null);
  /** the computer's next candy is on its way (one at a time) */
  const comWaiting = useRef(false);

  const deal = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    busy.current = false;
    comWaiting.current = false;
    if (config.players === 2 && config.com) {
      // In development, what it stores and recalls and why it chooses each card go to the console.
      com.current ??= new LexiCom(COM_LEVELS[config.com], Math.random, import.meta.env.DEV ? (line) => console.info(`[LexiCom] ${line}`) : undefined);
      com.current.reset();
    } else com.current = null;
    settled.current = false;
    standing.current = { pairs: 0, misses: [0, 0], mine: 0 };
    closeHeld.current = null;
    const asked = ++dealt.current;
    // ふたりで: who plays first is drawn each game (the computer too may open)
    const first: 0 | 1 = config.players === 2 && Math.random() < 0.5 ? 1 : 0;
    setCells(null);
    setError(null);
    setOpen([]);
    setGlow([]);
    setTaken([]);
    setMisses([0, 0]);
    setTurn(first);
    setEnd(null);
    setAsking(false);
    setBrowsing(false);
    setOpener(null);
    setHolding(false);
    api
      .dealLexiLink(config.mode, config.genre, config.preferLearned)
      .then((d) => {
        if (asked !== dealt.current) return;
        voices.current = prepareWords(d.pairs.flatMap((p) => [p.a, p.b]).filter((c) => c.english).map((c) => c.word));
        const list = shuffled(d.pairs.flatMap((p, i) => [{ pair: i, card: p.a }, { pair: i, card: p.b }]));
        setCells(list);
        setFrames(list.map(() => "wrapped"));
        if (config.players === 2) {
          // Who opens, on the board for a moment; no candy is turned until it has gone.
          busy.current = true;
          setOpener(first);
          timers.current.push(
            window.setTimeout(() => {
              busy.current = false;
              setOpener(null);
            }, OPENER_MS),
          );
        }
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
      .finishLexiLink({
        players: config.players,
        pairs: pairCount,
        misses: missCount[0],
        cleared,
        com: solo ? null : config.com,
        playerPairs: standing.current.mine,
      })
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
      } else if (b > a && config.com) {
        // The computer is not the one cheered: the person lost.
        setEnd({ kind: "lose" });
        playLexi("lose");
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
    // The English on it read aloud after the unwrapping (a meaning in Japanese is not read).
    const card = cells[i].card;
    if (card.english) later(() => void voices.current?.say([card.word], 0).catch(() => undefined), SAY_AFTER_UNWRAP_MS);
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
        standing.current = { pairs: got, misses: missed, mine: standing.current.mine + (turn === 0 ? 1 : 0) };
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
          const next = [{ pair: cells[x].pair, left, right, by: turn }, ...taken];
          setTaken(next);
          setOpen([]);
          busy.current = false;
          if (next.length === LEXI.pairs) later(() => finish(next, missed), 700);
        }, GLOW_MS);
      } else {
        const counted: [number, number] = turn === 0 ? [missed[0] + 1, missed[1]] : [missed[0], missed[1] + 1];
        standing.current = { ...standing.current, misses: counted };
        const close = () => {
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
        };
        // 手動で閉じる: left open (the computer's two as well) until a click on the board
        const wait = () => {
          closeHeld.current = close;
          setHolding(true);
        };
        if (holdNow.current) wait();
        else later(() => (holdNow.current ? wait() : close()), MISS_MS - LOOK_MS);
      }
    }, LOOK_MS);
  };

  /** The two held open wrapped again (a click on the board, or 手動で閉じる turned off). */
  const release = () => {
    const close = closeHeld.current;
    closeHeld.current = null;
    setHolding(false);
    close?.();
  };
  const toggleHold = () => {
    const on = !hold;
    setHold(on);
    try {
      localStorage.setItem(HOLD_KEY, on ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (!on) release();
  };

  /** The computer's turn (2P): its candies are its own; a click on the board waits for the turn back. */
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
  // Its turn, the board still: the next candy after a moment (the first, or the second once the first
  // is open). Who opens is shown first: the board is still once it has gone.
  useEffect(() => {
    if (!comTurn || !cells || opener !== null || busy.current || comWaiting.current || open.length >= 2 || standing.current.pairs >= LEXI.pairs) return;
    comWaiting.current = true;
    later(
      () => {
        comWaiting.current = false;
        comMoveNow.current();
      },
      open.length === 0 ? COM_FIRST_MS : COM_SECOND_MS,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comTurn, cells, open, frames, opener]);

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
  /** 対戦: 1P's share of the pairs taken, in % of the gauge (half before the first pair) */
  const share = pairs === 0 ? 50 : (pairsOf(0) / pairs) * 100;

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
          <div className="lexi-hud-right">
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
            <button
              type="button"
              className={"switch-btn lexi-hold-switch" + (hold ? " on" : "")}
              aria-pressed={hold}
              title={`オンにすると、ペアにならなかった2枚は${CLICK}するまで閉じません（覚える時間を取りたいときに）`}
              onClick={toggleHold}
            >
              <span className="switch-knob" aria-hidden="true" />
              手動で閉じる
            </button>
          </div>
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

        {/* 対戦: the names over one gauge of the pairs taken, 1P's share from the left and 2P's from the
            right (half each before the first pair), 番 beside whoever's turn it is */}
        {!solo && (
          <div className="lexi-versus">
            <div className="lexi-vs-top">
              {([0, 1] as const).map((who) => (
                <div key={who} className={`lexi-vs-side p${who + 1}`}>
                  <span className="lexi-vs-name">{name(who)}</span>
                  <span className={"lexi-turn-badge" + (turn === who && !end ? " on" : "")}>番</span>
                  <span className="lexi-vs-sub">
                    {who === 1 && config.com && `COM・${COM_LEVELS[config.com].label}・`}お手つき {misses[who]}
                  </span>
                </div>
              ))}
            </div>
            <div className="lexi-gauge" role="img" aria-label={`${name(0)} ${pairsOf(0)}ペア、${name(1)} ${pairsOf(1)}ペア`}>
              <div className="lexi-gauge-fill p1" style={{ width: `${share}%` }} />
              <div className="lexi-gauge-fill p2" style={{ width: `${100 - share}%` }} />
              <i className="lexi-gauge-mid" />
              <span className="lexi-gauge-count p1">{pairsOf(0)}</span>
              <span className="lexi-gauge-count p2">{pairsOf(1)}</span>
            </div>
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
                  <span
                    className={"lexi-word" + (c.card.english ? " en" : " ja")}
                    lang={c.card.english ? "en" : undefined}
                    style={{ "--fit": fitOf(c.card) } as CSSProperties}
                  >
                    {c.card.text}
                  </span>
                )}
              </button>
            ))}
            {opener !== null && (
              <div className="lexi-opener" aria-live="polite">
                <span className={`p${opener + 1}`}>{name(opener)}</span> の先攻！
              </div>
            )}
            {/* 手動で閉じる: the two open until the board is clicked anywhere */}
            {holding && (
              <button type="button" className="lexi-hold" onClick={release} aria-label="開いた2枚を閉じる">
                <span>{CLICK}で閉じる</span>
              </button>
            )}
            {/* The end put away: its two buttons in the middle of the board, now empty. The game was
                paid when its last pair was taken, so leaving by ← やめる or the tabs pays nothing more. */}
            {end && browsing && (
              <div className="lexi-after">
                <button className="btn" onClick={deal}>
                  もう一度
                </button>
                <button className="btn" onClick={onExit}>
                  ホームへ
                </button>
              </div>
            )}
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
          <div className="muted small lexi-hint">
            英語の{CLICK}で読み上げ、{RIGHT_CLICK}で単語帳に登録
          </div>
        </div>
      </section>

      {end && !browsing && (
        <div className="lexi-overlay" role="dialog" aria-live="polite">
          {end.kind !== "lose" && (
            <div className="lexi-confetti" aria-hidden="true">
              {Array.from({ length: 18 }, (_, k) => (
                <i key={k} style={{ left: `${(k * 53) % 100}%`, animationDelay: `${(k % 6) * 0.12}s` }} />
              ))}
            </div>
          )}
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
                <div className={"lexi-big " + end.kind}>
                  {end.kind === "win" ? `${name(end.winner)} WIN!` : end.kind === "lose" ? `${name(0)} LOSE...` : "DRAW"}
                </div>
                <div className="lexi-scoreline">
                  <span className="p1">
                    {name(0)} {pairsOf(0)}ペア
                  </span>
                  <span className="p2">
                    {name(1)} {pairsOf(1)}ペア
                  </span>
                </div>
                <div className="lexi-sub">
                  対戦ボーナス <b>+{lexiVersusKcal(config.com, pairsOf(0), true)} kcal</b>
                  {config.com && `（COM・${COM_LEVELS[config.com].label}）`}
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
              <button className="btn" onClick={() => setBrowsing(true)}>
                単語を登録する
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
