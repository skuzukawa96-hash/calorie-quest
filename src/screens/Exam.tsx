import { useCallback, useEffect, useMemo, useState } from "react";
import FavoriteStar, { useFavorites } from "../components/FavoriteStar";
import GlossedText from "../components/GlossedText";
import { PlayModeTag } from "../components/PlayModeSwitch";
import WordNotesPanel from "../components/WordNotes";
import { api } from "../lib/api";
import { loadDictionary, type Dictionary } from "../lib/dictionary";
import { formatKcal } from "../lib/scoring";
import { playCrunch, playFanfare, playWrong } from "../lib/sfx";
import { isTtsSupported, speak, stopSpeaking } from "../lib/speech";
import {
  EXAM_PART_LABEL,
  type ExamAnswer,
  type ExamLevel,
  type ExamOverview,
  type ExamPart,
  type ExamQuestion,
  type ExamResult,
  type PlayMode,
} from "../types";

const GLOSS_KEY = "cq-show-gloss";
const LETTERS = ["A", "B", "C", "D"];
const PART_ORDER: ExamPart[] = ["listening", "short", "text", "reading"];

/**
 * One round of お気に入りの復習 of exam questions, graded here. It pays nothing and leaves the exam
 * review alone; only the time each was gone over is kept.
 */
export interface ExamFavoriteRound {
  items: { favoriteId: number; question: ExamQuestion }[];
  /** the next round, when there are favorites this one did not take */
  onAgain: (() => void) | null;
}

interface Props {
  /** an exam of a level, the review of exam questions missed, or exam questions starred */
  kind: "exam" | "review" | "favorites";
  level?: ExamLevel;
  /** kind "favorites": the round to go through */
  favorites?: ExamFavoriteRound;
  overview: ExamOverview;
  /** がんばり / 通常 / お気軽, shown beside what was earned */
  playMode: PlayMode;
  onExit: () => void;
  onProgress: () => void;
  toast: (msg: string) => void;
}

interface Answered {
  chosen: string;
  correct: boolean;
  /** the review pays for each question put right */
  kcal?: number;
}

function loadGloss(): boolean {
  try {
    return localStorage.getItem(GLOSS_KEY) !== "off";
  } catch {
    return true;
  }
}

function saveGloss(on: boolean) {
  try {
    localStorage.setItem(GLOSS_KEY, on ? "on" : "off");
  } catch {
    /* ignore */
  }
}

function say(text: string) {
  if (isTtsSupported()) speak(text).catch(() => undefined);
}

/**
 * 試験: 30 questions laid out like TOEIC (応答問題 → 短文穴埋め → 長文穴埋め → 読解), each marked
 * as soon as it is answered, with its explanation; the score is handed in at the end. The review
 * goes over the exam questions missed, one at a time, paying for each put right.
 */
export default function Exam({ kind, level, favorites, overview, playMode, onExit, onProgress, toast }: Props) {
  const [questions, setQuestions] = useState<ExamQuestion[] | null>(null);
  const [round, setRound] = useState(0);
  const [idx, setIdx] = useState(0);
  const [answered, setAnswered] = useState<Record<string, Answered>>({});
  const [result, setResult] = useState<ExamResult | null>(null);
  const [reviewDone, setReviewDone] = useState<{ remaining: number } | null>(null);
  /** exam questions still in review, as the last review answer left them */
  const [remaining, setRemaining] = useState<number | null>(null);
  const [dict, setDict] = useState<Dictionary | null>(null);
  const [gloss, setGloss] = useState(loadGloss);
  const [busy, setBusy] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const fav = useFavorites(toast);
  const levelInfo = overview.levels.find((l) => l.level === level);

  useEffect(() => {
    let alive = true;
    setQuestions(null);
    setIdx(0);
    setAnswered({});
    setResult(null);
    setReviewDone(null);
    setRemaining(null);
    if (kind === "favorites") setQuestions(favorites?.items.map((i) => i.question) ?? []);
    else
      (kind === "exam" && level ? api.startExam(level) : api.getExamReview())
        .then((qs) => alive && setQuestions(qs))
        .catch((e) => toast(String(e)));
    loadDictionary().then((d) => alive && setDict(d));
    return () => {
      alive = false;
      stopSpeaking();
    };
  }, [kind, level, favorites, round, toast]);

  const current = questions?.[idx];
  const mine = current ? answered[current.id] : undefined;
  const correctCount = useMemo(() => Object.values(answered).filter((a) => a.correct).length, [answered]);

  const choose = useCallback(
    async (choice: string) => {
      if (!current || answered[current.id] || busy) return;
      const correct = choice === current.answer;
      if (kind === "review") {
        setBusy(true);
        try {
          const r = await api.answerExamReview(current.id, choice);
          setAnswered((a) => ({ ...a, [current.id]: { chosen: choice, correct: r.correct, kcal: r.points } }));
          setRemaining(r.remaining);
          if (r.points > 0) onProgress();
        } catch (e) {
          toast(String(e));
          return;
        } finally {
          setBusy(false);
        }
      } else {
        setAnswered((a) => ({ ...a, [current.id]: { chosen: choice, correct } }));
        // お気に入りの復習 keeps only when the favorite was gone over.
        const item = favorites?.items.find((i) => i.question.id === current.id);
        if (kind === "favorites" && item) api.markFavoriteReviewed(item.favoriteId).catch((e) => toast(String(e)));
      }
      if (correct) playCrunch();
      else playWrong();
      // The line heard, or the sentence completed, is read once the answer is in.
      if (current.part === "short" || current.part === "listening") window.setTimeout(() => say(current.sentence), 350);
    },
    [current, answered, busy, kind, favorites, onProgress, toast],
  );

  const finish = useCallback(async () => {
    if (!questions || !level) return;
    setBusy(true);
    try {
      const answers: ExamAnswer[] = questions
        .filter((q) => answered[q.id])
        .map((q) => ({ id: q.id, chosen: answered[q.id].chosen }));
      const r = await api.finishExam(level, answers);
      setResult(r);
      if (r.passed) playFanfare();
      onProgress();
    } catch (e) {
      toast(String(e));
    } finally {
      setBusy(false);
    }
  }, [questions, level, answered, onProgress, toast]);

  const next = useCallback(() => {
    stopSpeaking();
    if (!questions) return;
    if (idx + 1 < questions.length) {
      setIdx(idx + 1);
    } else if (kind === "exam") {
      void finish();
    } else {
      setReviewDone({ remaining: remaining ?? 0 });
      playFanfare();
    }
  }, [questions, idx, kind, finish, remaining]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!current || result || reviewDone) return;
      if (mine) {
        if (e.key === "Enter") {
          e.preventDefault();
          next();
        }
        return;
      }
      const n = Number(e.key);
      const letter = LETTERS.indexOf(e.key.toUpperCase());
      const pick = n >= 1 && n <= current.choices.length ? n - 1 : letter >= 0 && letter < current.choices.length ? letter : -1;
      if (pick >= 0) void choose(current.choices[pick]);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [current, mine, result, reviewDone, next, choose]);

  const toggleGloss = () =>
    setGloss((g) => {
      saveGloss(!g);
      return !g;
    });

  const title = kind === "exam" ? `📝 試験：${levelInfo?.label ?? ""}` : kind === "favorites" ? "★ お気に入りの復習" : "🔁 試験の復習";

  if (result && questions) {
    return (
      <ExamResultView
        result={result}
        questions={questions}
        answered={answered}
        overview={overview}
        label={levelInfo?.label ?? ""}
        playMode={playMode}
        onAgain={() => setRound((r) => r + 1)}
        onExit={onExit}
      />
    );
  }
  if (reviewDone && questions && kind === "favorites") {
    return (
      <div className="screen exam">
        <section className="card exam-result">
          <h2>★ お気に入りの復習おしまい！</h2>
          <div className="exam-score">
            <b>{correctCount}</b> / {questions.length} 問正解
          </div>
          <p className="muted">お気に入りの問題は何度でも見返せます。カロリーと試験の復習は変わりません。</p>
          <div className="row">
            {favorites?.onAgain && (
              <button className="btn btn-primary" onClick={favorites.onAgain}>
                続けて復習する
              </button>
            )}
            <button className="btn" onClick={onExit}>
              お気に入りに戻る
            </button>
          </div>
        </section>
      </div>
    );
  }
  if (reviewDone && questions) {
    const earned = Object.values(answered).reduce((s, a) => s + (a.kcal ?? 0), 0);
    return (
      <div className="screen exam">
        <section className="card exam-result">
          <h2>🔁 試験の復習おしまい！</h2>
          <div className="exam-score">
            <b>{correctCount}</b> / {questions.length} 問正解
          </div>
          <div className="exam-kcal">
            おやつ予算 +{formatKcal(earned)} kcal{earned > 0 && <PlayModeTag mode={playMode} />}
          </div>
          <p className="muted">
            {reviewDone.remaining > 0
              ? `まだ復習が ${reviewDone.remaining} 問あります。間違えた問題は正解するまで残ります。`
              : "試験で間違えた問題はすべて正解できました！"}
          </p>
          <div className="row">
            {reviewDone.remaining > 0 && (
              <button className="btn btn-primary" onClick={() => setRound((r) => r + 1)}>
                続けて復習する
              </button>
            )}
            <button className="btn" onClick={onExit}>
              ホームに戻る
            </button>
          </div>
        </section>
      </div>
    );
  }
  if (!questions) {
    return (
      <div className="screen">
        <div className="card loading">問題を用意しています…</div>
      </div>
    );
  }
  if (!current) {
    return (
      <div className="screen">
        <div className="card">
          <p>{kind === "review" ? "試験の復習はありません。" : "問題がありません。"}</p>
          <button className="btn" onClick={onExit}>
            ホームに戻る
          </button>
        </div>
      </div>
    );
  }

  // The passage's blanks answered so far in this exam (長文穴埋め), shown filled in.
  const sameSet = questions.filter((q) => q.setId === current.setId);
  const filled: Record<number, string> = {};
  for (const q of sameSet) {
    if (q.blank && answered[q.id]) filled[q.blank] = q.answer;
  }
  const setAnswers: Record<number, string> = {};
  for (const q of sameSet) if (q.blank) setAnswers[q.blank] = q.answer;
  const partIndex = PART_ORDER.indexOf(current.part);

  return (
    <div className="screen study exam">
      <div className="study-head">
        {quitting ? (
          <span className="exam-quit">
            やめると{kind === "exam" ? "この試験の結果は記録されません" : "ここまでの復習は記録済みです"}。
            <button className="btn-link danger" onClick={onExit}>
              やめる
            </button>
            <button className="btn-link" onClick={() => setQuitting(false)}>
              続ける
            </button>
          </span>
        ) : (
          <button className="btn-link" onClick={() => (kind === "exam" ? setQuitting(true) : onExit())}>
            ← やめる
          </button>
        )}
        <div className="study-meta">
          <span className="pill">{title}</span>
          <span className="pill level">
            Part {"ABCD"[partIndex]} {EXAM_PART_LABEL[current.part]}
          </span>
          {kind === "review" && <span className="pill review">正解で +{overview.reviewKcal} kcal</span>}
          <button
            type="button"
            className={"pill toggle " + (gloss ? "on" : "")}
            onClick={toggleGloss}
            title="英文の単語にカーソルを合わせると意味が出ます"
          >
            🔤 単語の意味 {gloss ? "ON" : "OFF"}
          </button>
        </div>
        <div className="study-progress">
          {idx + 1} / {questions.length}
          <div className="mini-bar">
            <div style={{ width: `${((idx + (mine ? 1 : 0)) / questions.length) * 100}%` }} />
          </div>
        </div>
      </div>

      <div className="card question-card" key={current.id}>
        <FavoriteStar on={fav.isExam(current.id)} onToggle={() => void fav.toggleExam(current.id)} />
        {(current.part === "text" || current.part === "reading") && current.passage && (
          <ExamPassage
            q={current}
            filled={filled}
            setAnswers={setAnswers}
            dict={dict}
            gloss={gloss}
            revealJa={!!mine}
          />
        )}
        <QuestionPrompt q={current} answered={!!mine} dict={dict} gloss={gloss} />
        <div className={"options exam-options" + (current.part === "listening" || current.part === "reading" ? " options-long" : "")}>
          {current.choices.map((c, i) => {
            let cls = "option";
            if (mine) {
              if (c === current.answer) cls += " correct";
              else if (c === mine.chosen) cls += " wrong";
            }
            return (
              <button key={c} className={cls} disabled={!!mine || busy} onClick={() => void choose(c)}>
                <span className="option-num">{LETTERS[i]}</span>
                <span>{c}</span>
              </button>
            );
          })}
        </div>
        {!mine && <div className="muted small">キーボードの 1〜{current.choices.length} や A〜{LETTERS[current.choices.length - 1]} でも回答できます</div>}

        {mine && (
          <div className={"feedback " + (mine.correct ? "ok" : "ng")}>
            <div className="feedback-main">
              <div className="feedback-title">{mine.correct ? "正解！" : "不正解…"}</div>
              <div className={"feedback-kcal" + (kind === "favorites" ? " fav-review-note" : "")}>
                {kind === "review"
                  ? `+${formatKcal(mine.kcal ?? 0)} kcal`
                  : kind === "favorites"
                    ? "★ お気に入りの復習"
                    : `${correctCount} / ${Object.keys(answered).length} 問正解`}
              </div>
            </div>
            <div className="feedback-detail">
              <div>
                <span className="label">正解</span> <strong>{current.answer}</strong>
                {current.point && <span className="pill exam-point">{current.point}</span>}
              </div>
              <AnswerDetail q={current} dict={dict} gloss={gloss} />
              <div className="exam-explanation">
                <div className="grammar-note-title">📘 解説</div>
                <div>{current.explanation}</div>
              </div>
              {current.notes && (
                <WordNotesPanel
                  notes={current.notes}
                  word={current.answer}
                  meaning={dict?.[current.answer.toLowerCase()] ?? ""}
                  dict={dict}
                  gloss={gloss}
                />
              )}
              {!mine.correct &&
                (kind === "exam" ? (
                  <div className="muted">この問題は、試験を終えると「試験の復習」に入ります（正解で +{overview.reviewKcal} kcal）。</div>
                ) : kind === "review" ? (
                  <div className="muted">この問題は試験の復習に残ります。</div>
                ) : null)}
            </div>
            <button className="btn btn-primary" onClick={next} disabled={busy} autoFocus>
              {idx + 1 >= questions.length ? (kind === "exam" ? "採点する" : "結果を見る") : "次へ（Enter）"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- the passage (長文穴埋め / 読解) ---------- */

function ExamPassage({
  q,
  filled,
  setAnswers,
  dict,
  gloss,
  revealJa,
}: {
  q: ExamQuestion;
  /** blanks already answered, shown with their answers */
  filled: Record<number, string>;
  /** every blank's answer, for the sentence a word right-clicked in the passage is saved with */
  setAnswers: Record<number, string>;
  dict: Dictionary | null;
  gloss: boolean;
  revealJa: boolean;
}) {
  const lines = (q.passage ?? "").split("\n");
  const complete = (s: string) => s.replace(/\[(\d+)\]/g, (_, n) => setAnswers[Number(n)] ?? "…");
  return (
    <div className="exam-passage">
      {q.title && <div className="exam-passage-title">📄 {q.title}</div>}
      <div className="exam-passage-body">
        {lines.map((line, li) => (
          <p key={li}>
            {line.split(/(\[\d+\])/).map((seg, si) => {
              const m = /^\[(\d+)\]$/.exec(seg);
              if (m && q.part === "text") {
                const n = Number(m[1]);
                const done = filled[n];
                return (
                  <span key={si} className={"exam-blank" + (n === q.blank ? " current" : "") + (done ? " done" : "")}>
                    ({n}){done ? ` ${done}` : ""}
                  </span>
                );
              }
              if (!seg) return null;
              return (
                <GlossedText key={si} text={seg} dict={dict} enabled={gloss} context={complete(line)} />
              );
            })}
          </p>
        ))}
      </div>
      {revealJa && q.passageJa && (
        <details className="exam-passage-ja">
          <summary>本文の訳を見る</summary>
          {q.passageJa.split("\n").map((l, i) => (
            <p key={i}>{l}</p>
          ))}
        </details>
      )}
    </div>
  );
}

/* ---------- what is asked ---------- */

function QuestionPrompt({ q, answered, dict, gloss }: { q: ExamQuestion; answered: boolean; dict: Dictionary | null; gloss: boolean }) {
  const [playing, setPlaying] = useState(false);
  const [plays, setPlays] = useState(0);
  const play = useCallback(() => {
    setPlaying(true);
    setPlays((n) => n + 1);
    speak(q.sentence)
      .catch(() => undefined)
      .finally(() => setPlaying(false));
  }, [q.sentence]);
  // 応答問題: the line is played once when the question appears, and again as often as asked.
  useEffect(() => {
    if (q.part !== "listening") return;
    const t = window.setTimeout(play, 300);
    return () => {
      window.clearTimeout(t);
      stopSpeaking();
    };
  }, [q.part, play]);

  if (q.part === "listening") {
    return (
      <>
        <div className="prompt-label">英語を聞いて、最も適切な応答を選ぼう</div>
        <div className="listen-stage">
          <button type="button" className={"listen-button " + (playing ? "playing" : "")} onClick={play} disabled={!isTtsSupported()}>
            <span className="listen-icon">{playing ? "🔊" : "▶"}</span>
            <span>{plays <= 1 ? "もう一度聞く" : `もう一度聞く（${plays}回再生）`}</span>
          </button>
          {!answered && (
            <div className="listen-hidden" aria-hidden="true">
              ● ● ● ● ●
            </div>
          )}
        </div>
        {!isTtsSupported() && <div className="notice warn">この環境では音声の読み上げが利用できません。</div>}
      </>
    );
  }
  if (q.part === "short") {
    const [before, after] = (q.prompt ?? "").split("___");
    return (
      <>
        <div className="prompt-label">空欄に入る最も適切な語句を選ぼう</div>
        <div className="prompt prompt-sentence">
          <GlossedText text={before} dict={dict} enabled={gloss} context={q.sentence} contextJa={q.sentenceJa} />
          <span className="exam-blank current">＿＿＿</span>
          <GlossedText text={after ?? ""} dict={dict} enabled={gloss} context={q.sentence} contextJa={q.sentenceJa} />
        </div>
      </>
    );
  }
  if (q.part === "text") {
    return <div className="prompt-label">本文の空欄（{q.blank}）に入る最も適切なものを選ぼう</div>;
  }
  return (
    <>
      <div className="prompt-label">本文を読んで、設問に答えよう</div>
      <div className="prompt exam-question">
        <GlossedText text={q.prompt ?? ""} dict={dict} enabled={gloss} context={q.sentence} contextJa={q.sentenceJa} />
      </div>
    </>
  );
}

/** Under the answer: the line heard, the sentence completed, or the question in Japanese. */
function AnswerDetail({ q, dict, gloss }: { q: ExamQuestion; dict: Dictionary | null; gloss: boolean }) {
  const speakBtn = (
    <button className="btn-link" onClick={() => say(q.sentence)} disabled={!isTtsSupported()} title="読み上げる">
      🔊
    </button>
  );
  if (q.part === "listening") {
    return (
      <div className="heard-line">
        <span className="label">聞こえた英語</span>{" "}
        <strong>
          <GlossedText text={q.sentence} dict={dict} enabled={gloss} context={q.sentence} contextJa={q.sentenceJa} />
        </strong>
        {speakBtn}
        {q.sentenceJa && <div className="muted">{q.sentenceJa}</div>}
      </div>
    );
  }
  if (q.part === "short" || q.part === "text") {
    return (
      <div className="filled-line">
        <span className="label">完成した文</span>{" "}
        <GlossedText text={q.sentence} dict={dict} enabled={gloss} context={q.sentence} contextJa={q.sentenceJa} />
        {speakBtn}
        {q.sentenceJa && <div className="muted">{q.sentenceJa}</div>}
      </div>
    );
  }
  return q.promptJa ? (
    <div>
      <span className="label">設問の訳</span> {q.promptJa}
    </div>
  ) : null;
}

/* ---------- result ---------- */

function ExamResultView({
  result,
  questions,
  answered,
  overview,
  label,
  playMode,
  onAgain,
  onExit,
}: {
  result: ExamResult;
  questions: ExamQuestion[];
  answered: Record<string, Answered>;
  overview: ExamOverview;
  label: string;
  playMode: PlayMode;
  onAgain: () => void;
  onExit: () => void;
}) {
  const percent = Math.round((result.correct / result.total) * 100);
  const byPart = PART_ORDER.map((part) => {
    const qs = questions.filter((q) => q.part === part);
    return { part, total: qs.length, correct: qs.filter((q) => answered[q.id]?.correct).length };
  }).filter((p) => p.total > 0);
  return (
    <div className="screen exam">
      <section className={"card exam-result " + (result.passed ? "passed" : "failed")}>
        <div className="exam-result-label">{label}</div>
        <h2>{result.passed ? "🎉 合格！" : "不合格…"}</h2>
        <div className="exam-score">
          <b>{result.correct}</b> / {result.total} 問正解（{percent}%）
          <span className="muted small">　合格ライン {overview.passPercent}%</span>
        </div>
        <div className="exam-kcal">
          おやつ予算 +{formatKcal(result.points)} kcal
          <PlayModeTag mode={playMode} />
          {!result.passed && <span className="muted small">（挑戦ボーナス）</span>}
        </div>
        <ul className="exam-parts">
          {byPart.map((p) => (
            <li key={p.part}>
              <span>{EXAM_PART_LABEL[p.part]}</span>
              <span className="exam-part-bar" aria-hidden="true">
                <span style={{ width: `${(p.correct / p.total) * 100}%` }} />
              </span>
              <b>
                {p.correct} / {p.total}
              </b>
            </li>
          ))}
        </ul>
        {result.reviewAdded > 0 && (
          <p className="muted">
            間違えた {result.reviewAdded} 問をホームの「試験の復習」に追加しました（正解で1問 +{overview.reviewKcal} kcal）。
          </p>
        )}
        {result.newTicket && <p>🎫 連続 {result.streak} 日！チートデイチケットを獲得しました。</p>}
        <div className="row">
          <button className="btn btn-primary" onClick={onAgain}>
            もう一度受ける（新しい問題）
          </button>
          <button className="btn" onClick={onExit}>
            ホームに戻る
          </button>
        </div>
      </section>
    </div>
  );
}
