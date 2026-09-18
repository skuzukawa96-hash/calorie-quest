import { useCallback, useEffect, useRef, useState } from "react";
import PronunciationTips, { HighlightedText } from "../components/PronunciationTips";
import { api } from "../lib/api";
import { checkTyping, makeHint, PASS_SCORE, scorePronunciation, type PronunciationScore, type TipKey } from "../lib/scoring";
import { playCrunch, playFanfare, playPop, playWrong } from "../lib/sfx";
import { runningInTauri } from "../lib/api";
import {
  describeRecognitionError,
  INSTALL_STT_GUIDE,
  isTtsSupported,
  recognitionBackend,
  recognizeOnce,
  speak,
  speechCaps,
  stopSpeaking,
  type RecognitionHandle,
} from "../lib/speech";
import {
  ALL_CATEGORIES,
  categoryIcon,
  DIFFICULTY_LABEL,
  LEVEL_SHORT,
  MODE_LABEL,
  type AnswerResult,
  type Difficulty,
  type KcalRates,
  type Mode,
  type SessionQuestion,
} from "../types";

const SESSION_SIZE = 10;
const AUTO_SPEAK_KEY = "cq-auto-speak";

interface Props {
  mode: Mode;
  difficulty: Difficulty;
  /** genre name or "all" */
  category: string;
  rates: KcalRates;
  onExit: () => void;
  onProgress: () => void;
  toast: (msg: string) => void;
}

/** What to read aloud after answering: the completed sentence for grammar blanks, otherwise the English text. */
function spokenText(q: SessionQuestion): string {
  if (q.question.choices && q.question.prompt) return q.question.prompt.replace(/_{2,}/g, q.question.en);
  return q.question.en;
}

function loadAutoSpeak(): boolean {
  try {
    return localStorage.getItem(AUTO_SPEAK_KEY) !== "off";
  } catch {
    return true;
  }
}

interface Feedback {
  correct: boolean;
  result: AnswerResult;
  given?: string;
  score?: PronunciationScore | null;
}

interface Tally {
  correct: number;
  kcal: number;
  reviews: number;
}

export default function Study({ mode, difficulty, category, rates, onExit, onProgress, toast }: Props) {
  const [questions, setQuestions] = useState<SessionQuestion[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [tally, setTally] = useState<Tally>({ correct: 0, kcal: 0, reviews: 0 });
  const [submitting, setSubmitting] = useState(false);
  const [runId, setRunId] = useState(0);
  const [autoSpeak, setAutoSpeak] = useState<boolean>(loadAutoSpeak);

  const toggleAutoSpeak = () => {
    setAutoSpeak((v) => {
      const next = !v;
      try {
        localStorage.setItem(AUTO_SPEAK_KEY, next ? "on" : "off");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  useEffect(() => {
    let alive = true;
    setQuestions(null);
    setIdx(0);
    setFeedback(null);
    setTally({ correct: 0, kcal: 0, reviews: 0 });
    api
      .getSessionQuestions(mode, difficulty, category, SESSION_SIZE)
      .then((qs) => alive && setQuestions(qs))
      .catch((e) => alive && setLoadError(String(e)));
    return () => {
      alive = false;
      stopSpeaking();
    };
  }, [mode, difficulty, category, runId]);

  const current = questions?.[idx];
  const finished = questions !== null && idx >= questions.length;

  const submit = useCallback(
    async (correct: boolean, score: number | null, given?: string, ps?: PronunciationScore | null) => {
      if (!current || submitting || feedback) return;
      setSubmitting(true);
      try {
        const result = await api.submitAnswer({ questionId: current.question.id, mode, correct, score });
        setTally((t) => ({
          correct: t.correct + (correct ? 1 : 0),
          kcal: t.kcal + result.kcalEarned,
          reviews: t.reviews + (result.isReview && correct ? 1 : 0),
        }));
        if (correct) playCrunch();
        else playWrong();
        if (result.newTicket) {
          window.setTimeout(playFanfare, 350);
          toast("🎫 7日連続達成！チートデイチケット（+300 kcal）を獲得しました");
        }
        setFeedback({ correct, result, given, score: ps });
        onProgress();
        // Read the English aloud after the answer sound so the learner hears the pronunciation.
        if (mode !== "speaking" && autoSpeak && isTtsSupported()) {
          const text = spokenText(current);
          window.setTimeout(() => {
            speak(text).catch(() => undefined);
          }, 380);
        }
      } catch (e) {
        toast("保存に失敗しました: " + String(e));
      } finally {
        setSubmitting(false);
      }
    },
    [current, submitting, feedback, mode, autoSpeak, onProgress, toast],
  );

  const next = useCallback(() => {
    stopSpeaking();
    setFeedback(null);
    setIdx((i) => i + 1);
  }, []);

  useEffect(() => {
    if (finished) playFanfare();
  }, [finished]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (feedback && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        next();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [feedback, next]);

  if (loadError) {
    return (
      <div className="screen">
        <div className="card">
          <p>問題を読み込めませんでした: {loadError}</p>
          <button className="btn" onClick={onExit}>
            ホームへ戻る
          </button>
        </div>
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
  if (questions.length === 0) {
    return (
      <div className="screen">
        <div className="card">
          <p>この条件に合う問題がありません。難易度やモードを変えてみてください。</p>
          <button className="btn" onClick={onExit}>
            ホームへ戻る
          </button>
        </div>
      </div>
    );
  }
  if (finished) {
    return (
      <Summary
        total={questions.length}
        tally={tally}
        onExit={onExit}
        onAgain={() => setRunId((r) => r + 1)}
      />
    );
  }
  if (!current) return null;

  return (
    <div className="screen study">
      <div className="study-head">
        <button className="btn-link" onClick={onExit}>
          ← やめる
        </button>
        <div className="study-meta">
          <span className="pill">{MODE_LABEL[mode]}</span>
          <span className="pill">{DIFFICULTY_LABEL[difficulty]}</span>
          {category !== ALL_CATEGORIES && (
            <span className="pill">
              {categoryIcon(category)} {category}
            </span>
          )}
          <span className="pill level">難易度 {LEVEL_SHORT[current.question.difficulty]}</span>
          {current.isReview && <span className="pill review">🔁 復習 ×{rates.reviewMultiplier}</span>}
          {mode !== "speaking" && (
            <button
              type="button"
              className={"pill toggle " + (autoSpeak ? "on" : "")}
              onClick={toggleAutoSpeak}
              title="回答後に英語を読み上げます"
            >
              🔊 自動読み上げ {autoSpeak ? "ON" : "OFF"}
            </button>
          )}
        </div>
        <div className="study-progress">
          {idx + 1} / {questions.length}
          <div className="mini-bar">
            <div style={{ width: `${((idx + (feedback ? 1 : 0)) / questions.length) * 100}%` }} />
          </div>
        </div>
      </div>

      <div className="card question-card" key={current.question.id}>
        {current.question.category && (
          <div className="q-category">
            {categoryIcon(current.question.category)} {current.question.category}
          </div>
        )}
        {mode === "choice" && (
          <ChoiceCard q={current} disabled={!!feedback || submitting} onAnswer={(sel) => submit(sel === current.answer, null, sel)} chosen={feedback?.given ?? null} />
        )}
        {mode === "typing" && (
          <TypingCard q={current} disabled={!!feedback || submitting} onAnswer={(input) => submit(checkTyping(current.answer, input), null, input)} />
        )}
        {mode === "speaking" && (
          <SpeakingCard
            q={current}
            alternatives={questions.filter((x) => x !== current).map((x) => x.question.en)}
            disabled={!!feedback || submitting}
            onSubmit={(ps, selfScore) => {
              const score = ps ? ps.score : (selfScore ?? 0);
              submit(score >= PASS_SCORE, score, ps?.best, ps);
            }}
          />
        )}

        {feedback && (
          <div className={"feedback " + (feedback.correct ? "ok" : "ng")}>
            <div className="feedback-main">
              <div className="feedback-title">{feedback.correct ? "正解！ サクサク🍪" : "ざんねん…"}</div>
              <div className="feedback-kcal">
                {feedback.result.kcalEarned > 0 ? `+${feedback.result.kcalEarned} kcal` : "+0 kcal"}
                {feedback.result.isReview && feedback.correct && <span className="bonus"> 復習ボーナス ×{rates.reviewMultiplier}</span>}
              </div>
            </div>
            <div className="feedback-detail">
              <div>
                <span className="label">正解</span> <strong>{current.answer}</strong>
                {mode === "choice" && current.subDisplay && <span className="muted">　{current.subDisplay}</span>}
                {mode !== "speaking" && (
                  <button className="btn-link" onClick={() => speak(spokenText(current)).catch(() => undefined)} disabled={!isTtsSupported()}>
                    🔊 もう一度聞く
                  </button>
                )}
              </div>
              {feedback.score && (
                <div className="score-breakdown">
                  <span>スコア <b>{feedback.score.score}</b></span>
                  <span>一致度 {Math.round(feedback.score.similarity * 100)}%</span>
                  <span>流暢さ {Math.round(feedback.score.fluency * 100)}%</span>
                  {feedback.score.best && <span className="muted">認識: “{feedback.score.best}”</span>}
                </div>
              )}
              {!feedback.correct && (
                <div className="muted">この問題は明日、復習として再出題されます（正解すればカロリー ×{rates.reviewMultiplier}）。</div>
              )}
              {feedback.correct && feedback.result.needsReview && feedback.result.nextDue && (
                <div className="muted">次の復習: {feedback.result.nextDue}</div>
              )}
            </div>
            <button className="btn btn-primary" onClick={next} autoFocus>
              {idx + 1 >= questions.length ? "結果を見る" : "次へ（Enter）"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- Multiple choice ---------- */

function ChoiceCard({ q, disabled, onAnswer, chosen }: { q: SessionQuestion; disabled: boolean; onAnswer: (s: string) => void; chosen: string | null }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (disabled) return;
      const n = Number(e.key);
      if (n >= 1 && n <= q.options.length) onAnswer(q.options[n - 1]);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [q, disabled, onAnswer]);

  const isGrammar = !!q.question.choices;
  return (
    <>
      <div className="prompt-label">{isGrammar ? "空欄に入る語を選ぼう" : "この英語の意味は？"}</div>
      <div className={"prompt " + (isGrammar ? "prompt-sentence" : "")}>{q.display}</div>
      <div className="options">
        {q.options.map((opt, i) => {
          let cls = "option";
          if (chosen) {
            if (opt === q.answer) cls += " correct";
            else if (opt === chosen) cls += " wrong";
          }
          return (
            <button key={opt + i} className={cls} disabled={disabled} onClick={() => onAnswer(opt)}>
              <span className="option-num">{i + 1}</span>
              <span>{opt}</span>
            </button>
          );
        })}
      </div>
      <div className="muted small">キーボードの 1〜4 でも回答できます</div>
    </>
  );
}

/* ---------- Typing ---------- */

function TypingCard({ q, disabled, onAnswer }: { q: SessionQuestion; disabled: boolean; onAnswer: (s: string) => void }) {
  const [value, setValue] = useState("");
  const [showHint, setShowHint] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled && value.trim()) onAnswer(value);
      }}
    >
      <div className="prompt-label">日本語に合う英語を入力しよう</div>
      <div className="prompt">{q.display}</div>
      {q.subDisplay && <div className="muted">{q.subDisplay}</div>}
      <input
        ref={ref}
        className="answer-input"
        value={value}
        disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
        placeholder="英語で入力して Enter"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        lang="en"
      />
      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={disabled || !value.trim()}>
          回答する
        </button>
        <button type="button" className="btn-link" onClick={() => setShowHint((h) => !h)} disabled={disabled}>
          {showHint ? "ヒントを隠す" : "ヒント"}
        </button>
        {showHint && <code className="hint">{makeHint(q.answer)}</code>}
      </div>
    </form>
  );
}

/* ---------- Speaking ---------- */

type ListenState = "idle" | "listening" | "processing";
const MAX_ATTEMPTS = 3;

function SpeakingCard({
  q,
  alternatives,
  disabled,
  onSubmit,
}: {
  q: SessionQuestion;
  alternatives: string[];
  disabled: boolean;
  onSubmit: (ps: PronunciationScore | null, selfScore?: number) => void;
}) {
  const backend = recognitionBackend();
  const supported = backend !== "none";
  const [attempts, setAttempts] = useState<PronunciationScore[]>([]);
  const [state, setState] = useState<ListenState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [activeTip, setActiveTip] = useState<TipKey | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const handle = useRef<RecognitionHandle | null>(null);

  const playModel = useCallback(() => {
    setSpeaking(true);
    speak(q.question.en)
      .catch(() => undefined)
      .finally(() => setSpeaking(false));
  }, [q.question.en]);

  // Play the model pronunciation once when the question appears.
  useEffect(() => {
    const t = window.setTimeout(playModel, 350);
    return () => {
      window.clearTimeout(t);
      handle.current?.abort();
      stopSpeaking();
    };
  }, [playModel]);

  const listen = async () => {
    if (state !== "idle" || disabled) return;
    setError(null);
    stopSpeaking();
    playPop();
    setState("listening");
    const h = recognizeOnce({ target: q.question.en, alternatives, timeoutMs: 9000 });
    handle.current = h;
    try {
      const out = await h.result;
      setState("processing");
      const ps = scorePronunciation(q.question.en, out.transcripts, out.durationMs, out.native);
      setAttempts((a) => [...a, ps]);
      void api.logDebug(`speech ok (${backend}): "${ps.best}" score=${ps.score}`);
    } catch (e) {
      const code = e instanceof Error ? e.message : String(e);
      setError(describeRecognitionError(code));
      void api.logDebug(`speech error: ${code}`);
    } finally {
      handle.current = null;
      setState("idle");
    }
  };

  const stop = () => {
    handle.current?.abort();
  };

  const best = attempts.reduce<PronunciationScore | null>((b, a) => (b === null || a.score > b.score ? a : b), null);

  return (
    <>
      <div className="prompt-label">お手本を聞いて、同じように話そう</div>
      <div className="prompt speak-target">
        <HighlightedText text={q.display} active={activeTip} />
      </div>
      {q.subDisplay && <div className="muted">{q.subDisplay}</div>}

      <div className="row speak-controls">
        <button type="button" className="btn" onClick={playModel} disabled={disabled || speaking || !isTtsSupported()}>
          🔊 お手本を聞く
        </button>
        {supported ? (
          state === "listening" ? (
            <button type="button" className="btn btn-danger" onClick={stop} disabled={backend === "native"}>
              🎙 聞き取り中…（話し終わると自動で止まります）
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={listen} disabled={disabled || state !== "idle" || attempts.length >= MAX_ATTEMPTS}>
              🎤 マイクで話す{attempts.length ? `（${attempts.length}/${MAX_ATTEMPTS}）` : ""}
            </button>
          )
        ) : null}
        {state === "listening" && <span className="listening-dot">● 録音中</span>}
      </div>

      {!isTtsSupported() && <div className="notice">この環境では読み上げ（TTS）が利用できません。</div>}
      {error && <div className="notice warn">{error}</div>}

      {attempts.length > 0 && (
        <div className="attempts">
          {attempts.map((a, i) => (
            <div key={i} className={"attempt " + (a.score >= PASS_SCORE ? "pass" : "fail")}>
              <span className="attempt-score">{a.score}</span>
              <span className="attempt-text">“{a.best || "（認識できず）"}”</span>
              <span className="muted small">一致 {Math.round(a.similarity * 100)}% / 流暢 {Math.round(a.fluency * 100)}%</span>
            </div>
          ))}
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={disabled || !best} onClick={() => best && onSubmit(best)}>
              この結果で確定（ベスト {best?.score ?? 0} 点）
            </button>
            {attempts.length < MAX_ATTEMPTS && <span className="muted small">合格ラインは {PASS_SCORE} 点。あと {MAX_ATTEMPTS - attempts.length} 回やり直せます。</span>}
          </div>
        </div>
      )}

      {!supported && (
        <div className="self-assess">
          <div className="notice">
            {runningInTauri ? (
              <>
                <div>
                  <b>英語の音声認識がこのPCにまだ入っていません。</b>
                  {speechCaps()?.sttLanguages.length ? `（利用可能: ${speechCaps()!.sttLanguages.join(", ")}）` : ""}
                </div>
                <div className="small">{INSTALL_STT_GUIDE}</div>
                <div className="small">それまでは自己採点で記録します。お手本と同じように声に出してから選んでください。</div>
              </>
            ) : (
              <>この環境では音声認識が利用できないため、自己採点で記録します。（お手本と同じように声に出してから選んでください）</>
            )}
          </div>
          <div className="row">
            <button type="button" className="btn" disabled={disabled} onClick={() => onSubmit(null, 80)}>
              はっきり言えた（80点）
            </button>
            <button type="button" className="btn" disabled={disabled} onClick={() => onSubmit(null, 60)}>
              だいたい言えた（60点）
            </button>
            <button type="button" className="btn btn-ghost" disabled={disabled} onClick={() => onSubmit(null, 0)}>
              うまく言えなかった
            </button>
          </div>
        </div>
      )}

      <PronunciationTips text={q.question.en} active={activeTip} onActiveChange={setActiveTip} />
    </>
  );
}

/* ---------- Summary ---------- */

function Summary({ total, tally, onExit, onAgain }: { total: number; tally: Tally; onExit: () => void; onAgain: () => void }) {
  const rate = total ? Math.round((tally.correct / total) * 100) : 0;
  const cheer = rate === 100 ? "パーフェクト！ご褒美タイムです🍰" : rate >= 70 ? "いい調子！サクサク進んでます🍪" : "復習で取り返そう。明日また出題されます🍫";
  return (
    <div className="screen">
      <div className="card summary">
        <h2>セッション終了</h2>
        <div className="summary-grid">
          <div>
            <div className="summary-num">
              {tally.correct} / {total}
            </div>
            <div className="muted">正解数（{rate}%）</div>
          </div>
          <div>
            <div className="summary-num accent">+{tally.kcal} kcal</div>
            <div className="muted">獲得カロリー</div>
          </div>
          <div>
            <div className="summary-num">{tally.reviews}</div>
            <div className="muted">復習ボーナス回数</div>
          </div>
        </div>
        <p className="cheer">{cheer}</p>
        <div className="row">
          <button className="btn btn-primary" onClick={onAgain}>
            もう10問
          </button>
          <button className="btn" onClick={onExit}>
            ホームへ戻る
          </button>
        </div>
      </div>
    </div>
  );
}
