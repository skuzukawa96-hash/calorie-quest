import { useCallback, useEffect, useRef, useState } from "react";
import GlossedText from "../components/GlossedText";
import PronunciationTips, { HighlightedText } from "../components/PronunciationTips";
import WordNotesPanel from "../components/WordNotes";
import { PHONEMES, STRESS_MARK } from "../lib/phonemes";
import { ipaWords, loadPronunciations, type Pronunciations } from "../lib/pronunciation";
import { api, runningInTauri } from "../lib/api";
import { loadDictionary, type Dictionary } from "../lib/dictionary";
import {
  answerWordCount,
  gradeTyping,
  maskWord,
  PASS_SCORE,
  scorePronunciation,
  scoresPerWord,
  type PronunciationScore,
  type TipKey,
  type TypingGrade,
} from "../lib/scoring";
import { playCrunch, playFanfare, playPop, playWrong } from "../lib/sfx";
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
  categoryLabel,
  TIER_LABEL,
  MODE_LABEL,
  type AnswerResult,
  type KcalRates,
  type SessionMode,
  type SessionQuestion,
  type TierChoice,
} from "../types";

const SESSION_SIZE = 10;
const AUTO_SPEAK_KEY = "cq-auto-speak";
const GLOSS_KEY = "cq-show-gloss";
const TYPING_HINT_KEY = "cq-typing-hint";

interface Props {
  /** one mode for every question, or "review": each due review in the mode it was missed in */
  mode: SessionMode;
  /** a tab, or "mixed" */
  tier: TierChoice;
  /** genre name or "all" */
  category: string;
  rates: KcalRates;
  onExit: () => void;
  onProgress: () => void;
  toast: (msg: string) => void;
}

interface Feedback {
  correct: boolean;
  result: AnswerResult;
  given?: string;
  score?: PronunciationScore | null;
  /** typing: which words of the answer were off */
  typing?: TypingGrade;
}

interface Tally {
  correct: number;
  kcal: number;
  reviews: number;
}

function loadFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "on";
  } catch {
    return fallback;
  }
}

function saveFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? "on" : "off");
  } catch {
    /* ignore */
  }
}

/**
 * The sentence a word right-clicked in `text` is saved to the recipe with. A grammar prompt still
 * has its blank, so the completed sentence stands in; an idiom's own example beats the bare idiom.
 */
function recipeContext(q: SessionQuestion, text: string): { context: string; contextJa?: string | null } {
  const { kind, ja, example, exampleJa } = q.question;
  if (kind === "grammar") return { context: q.audioText, contextJa: ja };
  if (kind === "idiom" && example) return { context: example, contextJa: exampleJa };
  // A phrase or sentence is its own example, and a dialogue's heard line is what `ja` translates.
  if (text === q.question.en && (kind === "phrase" || kind === "sentence" || kind === "expression")) {
    return { context: text, contextJa: ja };
  }
  if (kind === "dialogue" && text === q.audioText) return { context: text, contextJa: ja };
  return { context: text };
}

/** Single vocabulary items need no hover dictionary; full lines do. */
function isMultiWord(q: SessionQuestion): boolean {
  return q.audioText.trim().includes(" ");
}

export default function Study({ mode, tier, category, rates, onExit, onProgress, toast }: Props) {
  const [questions, setQuestions] = useState<SessionQuestion[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [tally, setTally] = useState<Tally>({ correct: 0, kcal: 0, reviews: 0 });
  const [submitting, setSubmitting] = useState(false);
  const [runId, setRunId] = useState(0);
  const [autoSpeak, setAutoSpeak] = useState<boolean>(() => loadFlag(AUTO_SPEAK_KEY, true));
  const [showGloss, setShowGloss] = useState<boolean>(() => loadFlag(GLOSS_KEY, true));
  const [typingHint, setTypingHint] = useState<boolean>(() => loadFlag(TYPING_HINT_KEY, false));
  const [dict, setDict] = useState<Dictionary | null>(null);

  useEffect(() => {
    let alive = true;
    loadDictionary().then((d) => alive && setDict(d));
    return () => {
      alive = false;
    };
  }, []);

  const toggleAutoSpeak = () =>
    setAutoSpeak((v) => {
      saveFlag(AUTO_SPEAK_KEY, !v);
      return !v;
    });

  const toggleGloss = () =>
    setShowGloss((v) => {
      saveFlag(GLOSS_KEY, !v);
      return !v;
    });

  const toggleTypingHint = () =>
    setTypingHint((v) => {
      saveFlag(TYPING_HINT_KEY, !v);
      return !v;
    });

  useEffect(() => {
    let alive = true;
    setQuestions(null);
    setIdx(0);
    setFeedback(null);
    setTally({ correct: 0, kcal: 0, reviews: 0 });
    api
      .getSessionQuestions(mode, tier, category, SESSION_SIZE)
      .then((qs) => alive && setQuestions(qs))
      .catch((e) => alive && setLoadError(String(e)));
    return () => {
      alive = false;
      stopSpeaking();
    };
  }, [mode, tier, category, runId]);

  const current = questions?.[idx];
  const finished = questions !== null && idx >= questions.length;

  const submit = useCallback(
    async (
      correct: boolean,
      score: number | null,
      given?: string,
      ps?: PronunciationScore | null,
      hintsUsed = 0,
      typing?: TypingGrade,
    ) => {
      if (!current || submitting || feedback) return;
      // A review session mixes modes, so each answer is recorded in its question's own mode.
      const qMode = current.mode;
      setSubmitting(true);
      try {
        const result = await api.submitAnswer({
          questionId: current.question.id,
          mode: qMode,
          correct,
          score,
          hintsUsed,
          mistakes: typing?.mistakes,
        });
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
        setFeedback({ correct, result, given, score: ps, typing });
        onProgress();
        // Read the English aloud after the answer sound so the learner hears the pronunciation.
        // Listening mode has just played it, so it only repeats when the answer was wrong.
        const repeat = qMode !== "speaking" && autoSpeak && isTtsSupported() && (qMode !== "listening" || !correct);
        if (repeat) {
          const text = current.audioText;
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
    [current, submitting, feedback, autoSpeak, onProgress, toast],
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
          <p>
            {mode === "review"
              ? "今日の復習はすべて終わりました。"
              : "この条件に合う問題がありません。難易度やモードを変えてみてください。"}
          </p>
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
        againLabel={mode === "review" ? "続けて復習する" : "もう10問"}
        onExit={onExit}
        onAgain={() => setRunId((r) => r + 1)}
      />
    );
  }
  if (!current) return null;

  const glossOn = showGloss && isMultiWord(current);
  const qMode = current.mode;

  return (
    <div className="screen study">
      <div className="study-head">
        <button className="btn-link" onClick={onExit}>
          ← やめる
        </button>
        <div className="study-meta">
          <span className="pill">{MODE_LABEL[qMode]}</span>
          <span className="pill">{TIER_LABEL[tier]}</span>
          {category !== ALL_CATEGORIES && (
            <span className="pill">
              {categoryLabel(category)}
            </span>
          )}
          {tier === "mixed" && <span className="pill level">{TIER_LABEL[current.question.tier]}</span>}
          {current.isReview && <span className="pill review">🔁 復習 ×{rates.reviewMultiplier}</span>}
          {qMode !== "speaking" && (
            <button
              type="button"
              className={"pill toggle " + (autoSpeak ? "on" : "")}
              onClick={toggleAutoSpeak}
              title="回答後に英語を読み上げます"
            >
              🔊 自動読み上げ {autoSpeak ? "ON" : "OFF"}
            </button>
          )}
          <button
            type="button"
            className={"pill toggle " + (showGloss ? "on" : "")}
            onClick={toggleGloss}
            title="英文の単語にカーソルを合わせると意味が出ます"
          >
            🔤 単語の意味 {showGloss ? "ON" : "OFF"}
          </button>
          {qMode === "typing" && (
            <button
              type="button"
              className={"pill toggle " + (typingHint ? "on" : "")}
              onClick={toggleTypingHint}
              title="記入問題のヒント（伏せ字）を最初から表示します。表示するだけなら減点はありません"
            >
              💡 ヒント常時表示 {typingHint ? "ON" : "OFF"}
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
        {qMode === "choice" && (
          <ChoiceCard
            q={current}
            dict={dict}
            glossOn={glossOn}
            disabled={!!feedback || submitting}
            onAnswer={(sel) => submit(sel === current.answer, null, sel)}
            chosen={feedback?.given ?? null}
          />
        )}
        {qMode === "typing" && (
          <TypingCard
            q={current}
            hintAlways={typingHint}
            disabled={!!feedback || submitting}
            onAnswer={(input, hintsUsed) => {
              const grade = gradeTyping(current.accepted ?? current.answer, input);
              void submit(grade.correct, null, input, null, hintsUsed, grade);
            }}
          />
        )}
        {qMode === "listening" && (
          <ListeningCard
            q={current}
            disabled={!!feedback || submitting}
            answered={!!feedback}
            dict={dict}
            glossOn={glossOn}
            onAnswer={(sel) => submit(sel === current.answer, null, sel)}
            chosen={feedback?.given ?? null}
          />
        )}
        {qMode === "speaking" && (
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
              <div className="feedback-title">
                {feedback.correct
                  ? "正解！ サクサク🍪"
                  : feedback.typing && feedback.result.kcalEarned > 0
                    ? `惜しい！ ${feedback.typing.mistakes}語ちがい🍪`
                    : "ざんねん…"}
              </div>
              <div className="feedback-kcal">
                {feedback.result.kcalEarned > 0 ? `+${feedback.result.kcalEarned} kcal` : "+0 kcal"}
                {feedback.result.isReview && feedback.correct && <span className="bonus"> 復習ボーナス ×{rates.reviewMultiplier}</span>}
              </div>
            </div>
            <div className="feedback-detail">
              {qMode === "listening" && (
                <div className="heard-line">
                  <span className="label">聞こえた英語</span>{" "}
                  <strong>
                    <GlossedText text={current.audioText} dict={dict} enabled={glossOn} {...recipeContext(current, current.audioText)} />
                  </strong>
                  {current.subDisplay && <span className="muted">　{current.subDisplay}</span>}
                </div>
              )}
              {feedback.typing && !feedback.correct && (
                <div className="typed-line">
                  <span className="label">あなたの答え</span>{" "}
                  {feedback.typing.marks.map((m, i) => (
                    <span key={i}>
                      {i > 0 && " "}
                      {m.status === "missing" ? (
                        <span className="typed-missing" title={`「${m.word}」が抜けています`}>
                          ＿
                        </span>
                      ) : (
                        <span className={"typed-" + m.status} title={m.status === "extra" ? "余分な語" : m.status === "wrong" ? "ちがう語" : undefined}>
                          {m.word}
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              )}
              <div>
                <span className="label">正解</span>{" "}
                <strong>
                  {/^[\x20-\x7e]+$/.test(current.answer) ? (
                    <GlossedText text={current.answer} dict={dict} enabled={showGloss} {...recipeContext(current, current.answer)} />
                  ) : (
                    current.answer
                  )}
                </strong>
                {qMode === "choice" && current.subDisplay && <span className="muted">　{current.subDisplay}</span>}
                {qMode !== "speaking" && (
                  <button className="btn-link" onClick={() => speak(current.audioText).catch(() => undefined)} disabled={!isTtsSupported()}>
                    🔊 もう一度聞く
                  </button>
                )}
              </div>
              {current.question.kind === "grammar" && (
                <div className="filled-line">
                  <span className="label">完成した文</span>{" "}
                  <GlossedText text={current.audioText} dict={dict} enabled={showGloss} {...recipeContext(current, current.audioText)} />
                </div>
              )}
              {current.grammarNote && (
                <div className="grammar-note">
                  <div className="grammar-note-title">📘 {current.grammarNote.title}</div>
                  <div>
                    <GlossedText text={current.grammarNote.body} dict={dict} enabled={showGloss} />
                  </div>
                  <div className="grammar-note-example">
                    <GlossedText text={current.grammarNote.example} dict={dict} enabled={showGloss} />
                  </div>
                </div>
              )}
              {current.question.example && (
                <div className="example-line">
                  <span className="label">例文</span>
                  <div className="example-en">
                    <GlossedText
                      text={current.question.example}
                      dict={dict}
                      enabled={showGloss}
                      contextJa={current.question.exampleJa}
                    />
                    <button
                      className="btn-link"
                      onClick={() => speak(current.question.example!).catch(() => undefined)}
                      disabled={!isTtsSupported()}
                    >
                      🔊
                    </button>
                  </div>
                  {current.question.exampleJa && <div className="muted">{current.question.exampleJa}</div>}
                </div>
              )}
              {current.notes && (
                <WordNotesPanel
                  notes={current.notes}
                  word={current.question.en}
                  meaning={current.question.ja}
                  dict={dict}
                  gloss={showGloss}
                />
              )}
              {feedback.score && (
                <div className="score-breakdown">
                  <span>
                    スコア <b>{feedback.score.score}</b>
                  </span>
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

function ChoiceCard({
  q,
  dict,
  glossOn,
  disabled,
  onAnswer,
  chosen,
}: {
  q: SessionQuestion;
  dict: Dictionary | null;
  glossOn: boolean;
  disabled: boolean;
  onAnswer: (s: string) => void;
  chosen: string | null;
}) {
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
  // Once answered, each wrong option shows the English it translates. Words and short idioms sit
  // to the right of the Japanese; when any is longer (a phrase, a sentence) they all go on a second,
  // smaller line, so the four options stay alike.
  const wrongEn = (i: number) => (chosen && q.options[i] !== q.answer ? q.optionEn[i] : undefined);
  const enBelow = q.optionEn.some((en, i) => q.options[i] !== q.answer && (en.split(" ").length > 3 || en.length > 22));
  // A word, a compound or an idiom can be right-clicked into the recipe like any English on screen
  // (a compound or an idiom is offered whole first, then the word clicked). Phrases and sentences
  // are left as text. The meaning sits beside it already, so no hover meanings.
  const canSave = q.question.kind === "word" || q.question.kind === "idiom";
  return (
    <>
      <div className="prompt-label">{isGrammar ? "空欄に入る語を選ぼう" : "この英語の意味は？"}</div>
      <div className={"prompt " + (isGrammar ? "prompt-sentence" : "")}>
        {/* The question asks for this meaning, so no phrase may give it away before the answer. */}
        <GlossedText
          text={q.display}
          dict={dict}
          enabled={glossOn}
          withhold={chosen ? null : q.answer}
          {...recipeContext(q, q.display)}
        />
      </div>
      <div className={"options" + (chosen ? " answered" : "")}>
        {q.options.map((opt, i) => {
          let cls = "option";
          if (chosen) {
            if (opt === q.answer) cls += " correct";
            else if (opt === chosen) cls += " wrong";
          }
          const en = wrongEn(i);
          return (
            <button key={opt + i} className={cls} disabled={disabled} onClick={() => onAnswer(opt)}>
              <span className="option-num">{i + 1}</span>
              <span className="option-text">
                <span>{opt}</span>
                {en && (
                  <span className={"option-en" + (enBelow ? " below" : "")} lang="en">
                    {canSave ? <GlossedText text={en} dict={dict} enabled={false} context="" /> : en}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      <div className="muted small">キーボードの 1〜4 でも回答できます</div>
    </>
  );
}

/* ---------- Typing ---------- */

function TypingCard({
  q,
  hintAlways,
  disabled,
  onAnswer,
}: {
  q: SessionQuestion;
  /** 「ヒント常時表示」: the masked hint is open from the start (revealing a word still costs) */
  hintAlways: boolean;
  disabled: boolean;
  onAnswer: (s: string, hintsUsed: number) => void;
}) {
  const [value, setValue] = useState("");
  const [showHint, setShowHint] = useState(hintAlways);
  const [revealed, setRevealed] = useState<number[]>([]);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  // Switching the setting mid-question applies to this question too.
  useEffect(() => setShowHint(hintAlways), [hintAlways]);

  const hintWords = q.answer.split(" ");
  // フレーズの記入問題は1語 1 kcal、開示した語1つにつき −1 kcal。ほかは開示1語ごとに半分。
  const perWord = scoresPerWord(q.question.kind, q.mode);
  const worth = answerWordCount(q.answer);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled && value.trim()) onAnswer(value, revealed.length);
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
        {showHint && (
          <code className="hint">
            {hintWords.map((word, i) => {
              const masked = maskWord(word, perWord);
              if (revealed.includes(i)) return <span key={i} className="hint-word revealed">{word}</span>;
              if (masked === word) return <span key={i}>{word}</span>;
              return (
                <button
                  key={i}
                  type="button"
                  className="hint-word"
                  disabled={disabled}
                  title={perWord ? "タップでこの単語を表示（1 kcal 減点）" : "タップでこの単語を表示（獲得カロリーが半分になります）"}
                  onClick={() => setRevealed((r) => [...r, i])}
                >
                  {masked}
                </button>
              );
            })}
          </code>
        )}
        {perWord ? (
          <span className="muted small">
            1語 1 kcal：{revealed.length > 0 ? `${worth} − ${revealed.length} = ${Math.max(0, worth - revealed.length)}` : worth} kcal
          </span>
        ) : (
          revealed.length > 0 && <span className="muted small">獲得カロリー ×1/{2 ** revealed.length}</span>
        )}
      </div>
    </form>
  );
}

/* ---------- Listening ---------- */

function ListeningCard({
  q,
  disabled,
  answered,
  dict,
  glossOn,
  onAnswer,
  chosen,
}: {
  q: SessionQuestion;
  disabled: boolean;
  answered: boolean;
  dict: Dictionary | null;
  glossOn: boolean;
  onAnswer: (s: string) => void;
  chosen: string | null;
}) {
  const [playing, setPlaying] = useState(false);
  const [plays, setPlays] = useState(0);
  const isDialogue = q.question.kind === "dialogue";

  const play = useCallback(() => {
    setPlaying(true);
    setPlays((n) => n + 1);
    speak(q.audioText)
      .catch(() => undefined)
      .finally(() => setPlaying(false));
  }, [q.audioText]);

  // Play once when the question appears; the learner can repeat as often as they like.
  useEffect(() => {
    const t = window.setTimeout(play, 300);
    return () => {
      window.clearTimeout(t);
      stopSpeaking();
    };
  }, [play]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (disabled) return;
      const n = Number(e.key);
      if (n >= 1 && n <= q.options.length) onAnswer(q.options[n - 1]);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [q, disabled, onAnswer]);

  return (
    <>
      <div className="prompt-label">{isDialogue ? "会話を聞いて、自然な応答を選ぼう" : "英語を聞いて、意味を選ぼう"}</div>
      <div className="listen-stage">
        <button type="button" className={"listen-button " + (playing ? "playing" : "")} onClick={play} disabled={!isTtsSupported()}>
          <span className="listen-icon">{playing ? "🔊" : "▶"}</span>
          <span>{plays <= 1 ? "もう一度聞く" : `もう一度聞く（${plays}回再生）`}</span>
        </button>
        {answered ? (
          <div className="listen-revealed">
            <GlossedText text={q.audioText} dict={dict} enabled={glossOn} {...recipeContext(q, q.audioText)} />
          </div>
        ) : (
          <div className="listen-hidden" aria-hidden="true">
            ● ● ● ● ●
          </div>
        )}
      </div>
      {!isTtsSupported() && <div className="notice warn">この環境では音声の読み上げが利用できません。</div>}
      <div className={"options " + (isDialogue ? "options-long" : "")}>
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
  const [phoneme, setPhoneme] = useState<string | null>(null);
  const [ipa, setIpa] = useState<Pronunciations | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const handle = useRef<RecognitionHandle | null>(null);

  useEffect(() => {
    let alive = true;
    loadPronunciations()
      .then((t) => alive && setIpa(t))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  /** A sound picked from the IPA line: its tip opens below, and a sound with a diagram marks its letters too. */
  const pickSound = (sound: string) => {
    setPhoneme(sound);
    const diagram = PHONEMES[sound]?.diagram;
    if (diagram) setActiveTip(diagram);
  };

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
      {ipa && <IpaLine text={q.question.en} table={ipa} active={phoneme} onPick={pickSound} />}
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
            <button
              type="button"
              className="btn btn-primary"
              onClick={listen}
              disabled={disabled || state !== "idle" || attempts.length >= MAX_ATTEMPTS}
            >
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
              <span className="muted small">
                一致 {Math.round(a.similarity * 100)}% / 流暢 {Math.round(a.fluency * 100)}%
              </span>
            </div>
          ))}
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={disabled || !best} onClick={() => best && onSubmit(best)}>
              この結果で確定（ベスト {best?.score ?? 0} 点）
            </button>
            {attempts.length < MAX_ATTEMPTS && (
              <span className="muted small">
                合格ラインは {PASS_SCORE} 点。あと {MAX_ATTEMPTS - attempts.length} 回やり直せます。
              </span>
            )}
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

      <PronunciationTips
        text={q.question.en}
        active={activeTip}
        onActiveChange={setActiveTip}
        phoneme={phoneme}
        onPhonemeChange={setPhoneme}
      />
    </>
  );
}

/**
 * The sentence in IPA, one clickable span per sound. Right-clicking (or clicking) a sound explains
 * it under 発音のコツ. A word the pronouncing dictionary lacks keeps its spelling in place.
 */
function IpaLine({
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

/* ---------- Summary ---------- */

function Summary({
  total,
  tally,
  againLabel,
  onExit,
  onAgain,
}: {
  total: number;
  tally: Tally;
  againLabel: string;
  onExit: () => void;
  onAgain: () => void;
}) {
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
            {againLabel}
          </button>
          <button className="btn" onClick={onExit}>
            ホームへ戻る
          </button>
        </div>
      </div>
    </div>
  );
}
