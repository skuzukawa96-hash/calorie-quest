import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import GlossedText from "../components/GlossedText";
import { api } from "../lib/api";
import { loadDictionary, lookup, type Dictionary } from "../lib/dictionary";
import { onRecipeChanged } from "../lib/recipe";
import { playCrunch, playFanfare, playWrong } from "../lib/sfx";
import { isTtsSupported, speak, stopSpeaking } from "../lib/speech";
import type { RecipeReviewMode, RecipeReviewResult, RecipeWord } from "../types";

interface Props {
  /** a correct review adds to today's kcal, which the header and home show */
  onProgress: () => void;
  toast: (msg: string) => void;
}

type Filter = "all" | "learning" | "mastered";

const NO_MEANING = "（辞書に意味がありません）";

/** What one correct word pays, as shown to the learner (srs::recipe_half_kcal). */
const REVIEW_KCAL: Record<RecipeReviewMode, string> = { choice: "0.5", typing: "1" };
const REVIEW_TITLE: Record<RecipeReviewMode, string> = { choice: "意味を選ぶ", typing: "英語で書く" };

function say(text: string) {
  if (isTtsSupported()) speak(text).catch(() => undefined);
}

function shuffled<T>(items: T[]): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** The form that was right-clicked, when it differs from the headword ("heard" for hear). */
function shownForm(w: RecipeWord): string | null {
  return w.form && w.form.toLowerCase() !== w.word.toLowerCase() ? w.form : null;
}

/* ---------- 意味を選ぶ: three wrong meanings ---------- */

/** The senses of a gloss, so "聞く" and "聞く、聞こえる" count as the same answer. */
function senses(meaning: string): string[] {
  return meaning
    .split(/[、,，;；/／]/)
    .map((s) => s.replace(/[（(][^）)]*[）)]/g, "").trim())
    .filter(Boolean);
}

const meaningPools = new WeakMap<Dictionary, string[]>();

/** Every distinct gloss in the dictionary (inflected forms repeat their lemma's). */
function dictionaryMeanings(dict: Dictionary): string[] {
  let pool = meaningPools.get(dict);
  if (!pool) {
    pool = [...new Set(Object.values(dict))];
    meaningPools.set(dict, pool);
  }
  return pool;
}

/**
 * The correct meaning plus three that share no sense with it (or with each other), so only one
 * option is right. Two come from the learner's own recipe when it has them, the rest from the
 * dictionary, preferring glosses of a similar length so the answer does not stand out.
 */
function meaningOptions(word: RecipeWord, words: RecipeWord[], dict: Dictionary | null): string[] {
  const picked: string[] = [];
  const taken = new Set(senses(word.meaning));
  const len = word.meaning.length;
  const near = (m: string) => m.length >= Math.floor(len / 2) && m.length <= len * 2 + 2;
  const take = (pool: string[], upTo: number, fits: (m: string) => boolean = () => true) => {
    // Random probes rather than a shuffle: the dictionary pool has thousands of glosses.
    for (let tries = 0; tries < 300 && picked.length < upTo && pool.length > 0; tries++) {
      const m = pool[Math.floor(Math.random() * pool.length)];
      const ss = senses(m);
      if (!m || ss.length === 0 || !fits(m) || ss.some((s) => taken.has(s))) continue;
      picked.push(m);
      ss.forEach((s) => taken.add(s));
    }
  };
  const own = words.filter((w) => w.id !== word.id && w.meaning).map((w) => w.meaning);
  take(own, 2, near);
  if (dict) {
    take(dictionaryMeanings(dict), 3, near);
    take(dictionaryMeanings(dict), 3);
  }
  take(own, 3);
  return shuffled([...picked, word.meaning]);
}

/* ---------- 英語で書く: grading and the sentence with a gap ---------- */

function normalizeAnswer(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[.!?,;:"“”]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The saved word or the form it was found in is right, and so is any other English the dictionary
 * glosses exactly the same way ("large" when "big" 大きい was saved).
 */
function typedRight(word: RecipeWord, typed: string, dict: Dictionary | null): boolean {
  const t = normalizeAnswer(typed);
  if (!t) return false;
  if ([word.word, word.form].some((w) => w && normalizeAnswer(w) === t)) return true;
  return !!dict && !!word.meaning && (dict[t] ?? lookup(dict, t)) === word.meaning;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The example with the word taken out, or null when the word cannot be found in it. */
function withGap(word: RecipeWord): string | null {
  if (!word.example) return null;
  for (const target of [word.form, word.word]) {
    if (!target.trim()) continue;
    const pattern = `(?<![\\p{L}'])${escapeRegExp(target.trim())}(?![\\p{L}])`;
    if (new RegExp(pattern, "iu").test(word.example)) {
      return word.example.replace(new RegExp(pattern, "giu"), "＿＿＿");
    }
  }
  return null;
}

/**
 * お菓子作りレシピ: the words the learner right-clicked while studying. They are reviewed by
 * picking the meaning (0.5 kcal) or writing the English (1 kcal); a word answered right is
 * learned, and learned words can be cleared out of the list.
 */
export default function Recipe({ onProgress, toast }: Props) {
  const [words, setWords] = useState<RecipeWord[] | null>(null);
  const [dict, setDict] = useState<Dictionary | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [reviewing, setReviewing] = useState<{ mode: RecipeReviewMode; queue: RecipeWord[] } | null>(null);
  /** each round of review starts from a fresh component */
  const [round, setRound] = useState(0);
  const [confirmClear, setConfirmClear] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setWords(await api.listRecipeWords());
  }, []);

  useEffect(() => {
    reload().catch((e) => toast(String(e)));
    let alive = true;
    loadDictionary().then((d) => alive && setDict(d));
    const off = onRecipeChanged(() => void reload().catch(() => undefined));
    return () => {
      alive = false;
      off();
    };
  }, [reload, toast]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (e) {
      toast(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!words) {
    return (
      <div className="screen">
        <div className="card loading">読み込み中…</div>
      </div>
    );
  }

  const learning = words.filter((w) => !w.masteredAt);
  const mastered = words.filter((w) => w.masteredAt);
  // Both kinds of review ask about the meaning, so a word without one cannot be quizzed.
  const quizzable = learning.filter((w) => w.meaning);

  if (reviewing) {
    return (
      <div className="screen recipe">
        <RecipeReview
          key={round}
          mode={reviewing.mode}
          queue={reviewing.queue}
          words={words}
          dict={dict}
          onAgain={(left) => {
            setRound((r) => r + 1);
            setReviewing({ mode: reviewing.mode, queue: shuffled(left) });
          }}
          onDone={() => {
            stopSpeaking();
            setReviewing(null);
            void reload();
          }}
          onProgress={onProgress}
          toast={toast}
        />
      </div>
    );
  }

  const shown = filter === "learning" ? learning : filter === "mastered" ? mastered : words;
  const start = (mode: RecipeReviewMode) => {
    setRound((r) => r + 1);
    setReviewing({ mode, queue: shuffled(quizzable) });
  };

  const clearMastered = () =>
    run(async () => {
      const n = await api.deleteRecipeWords(mastered.map((w) => w.id));
      setConfirmClear(false);
      toast(`🧁 習得済みの${n}語をレシピから片付けました`);
    });

  return (
    <div className="screen recipe">
      <section className="card">
        <div className="section-head">
          <h2>🧁 お菓子作りレシピ</h2>
          <div className="recipe-counts">
            <span>
              材料 <b>{words.length}</b>語
            </span>
            <span>
              復習中 <b>{learning.length}</b>
            </span>
            <span className="positive">
              習得済み <b>{mastered.length}</b>
            </span>
          </div>
        </div>
        <p className="muted">
          問題や解説の英単語を<b>右クリック</b>すると、ここに材料として集まります。復習は英単語の意味を4択で選ぶ「意味を選ぶ」（1語 0.5 kcal）と、日本語から英語を書く「英語で書く」（1語 1 kcal）の2通り。正解した単語は習得済みになり、レシピから片付けられます。獲得したカロリーは今日のおやつ予算に入ります（小数点以下は切り捨て）。
        </p>
        <div className="row recipe-actions">
          {(["choice", "typing"] as const).map((mode) => (
            <button key={mode} className="btn btn-primary" disabled={busy || quizzable.length === 0} onClick={() => start(mode)}>
              {mode === "choice" ? "🍪" : "🍫"} {REVIEW_TITLE[mode]}（{quizzable.length}語・1語 {REVIEW_KCAL[mode]} kcal）
            </button>
          ))}
          {mastered.length > 0 &&
            (confirmClear ? (
              <>
                <span>習得済みの{mastered.length}語をレシピから削除します。</span>
                <button className="btn btn-danger" disabled={busy} onClick={() => void clearMastered()}>
                  削除する
                </button>
                <button className="btn-link" onClick={() => setConfirmClear(false)}>
                  やめる
                </button>
              </>
            ) : (
              <button className="btn" disabled={busy} onClick={() => setConfirmClear(true)}>
                習得済みを片付ける（{mastered.length}語）
              </button>
            ))}
        </div>
        {learning.length > quizzable.length && (
          <p className="muted small">
            辞書に意味のない{learning.length - quizzable.length}語は復習に出ません（一覧の「✓ 覚えた」で習得済みにできます）。
          </p>
        )}
      </section>

      <section className="card">
        {words.length === 0 ? (
          <div className="recipe-empty">
            <div className="recipe-empty-icon">🥣</div>
            <p>まだ材料がありません。</p>
            <p className="muted">学習中に、問題文・正解・完成した文・解説・例文の英単語を右クリックしてみましょう。</p>
          </div>
        ) : (
          <>
            <div className="segmented recipe-filter">
              {(
                [
                  ["all", `すべて ${words.length}`],
                  ["learning", `復習中 ${learning.length}`],
                  ["mastered", `習得済み ${mastered.length}`],
                ] as const
              ).map(([id, label]) => (
                <button key={id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>
                  {label}
                </button>
              ))}
            </div>
            {shown.length === 0 ? (
              <p className="muted">{filter === "mastered" ? "習得済みの単語はまだありません。" : "復習中の単語はありません。"}</p>
            ) : (
              <ul className="recipe-list">
                {shown.map((w) => (
                  <li key={w.id} className={"recipe-item" + (w.masteredAt ? " mastered" : "")}>
                    <div className="recipe-item-head">
                      <button className="recipe-word" onClick={() => say(w.word)} title="クリックで発音" disabled={!isTtsSupported()}>
                        {w.word}
                      </button>
                      {shownForm(w) && <span className="muted small">（{shownForm(w)}）</span>}
                      <span className="recipe-meaning">{w.meaning || NO_MEANING}</span>
                      {w.masteredAt && <span className="pill mastered">✓ 習得済み</span>}
                    </div>
                    {w.example && (
                      <div className="recipe-example">
                        <GlossedText text={w.example} dict={dict} enabled highlight={w.form || w.word} />
                      </div>
                    )}
                    {w.exampleJa && <div className="muted small">{w.exampleJa}</div>}
                    <div className="recipe-item-foot">
                      <span className="muted small">
                        {w.addedAt.slice(0, 10)} に追加
                        {w.reviews > 0 && `・復習 ${w.reviews}回`}
                      </span>
                      <button
                        className={"btn-small " + (w.masteredAt ? "" : "eat")}
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await api.setRecipeMastered(w.id, !w.masteredAt);
                          })
                        }
                      >
                        {w.masteredAt ? "復習に戻す" : "✓ 覚えた"}
                      </button>
                      <button
                        className="btn-link danger"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await api.deleteRecipeWords([w.id]);
                            toast(`「${w.word}」をレシピから削除しました`);
                          })
                        }
                      >
                        削除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
}

/* ---------- review: 意味を選ぶ / 英語で書く ---------- */

interface Answered {
  correct: boolean;
  /** the option picked, or what was typed */
  given: string;
}

function RecipeReview({
  mode,
  queue,
  words,
  dict,
  onAgain,
  onDone,
  onProgress,
  toast,
}: {
  mode: RecipeReviewMode;
  queue: RecipeWord[];
  /** the whole recipe, whose meanings serve as wrong options */
  words: RecipeWord[];
  dict: Dictionary | null;
  onAgain: (left: RecipeWord[]) => void;
  onDone: () => void;
  onProgress: () => void;
  toast: (msg: string) => void;
}) {
  const [idx, setIdx] = useState(0);
  const [answered, setAnswered] = useState<Answered | null>(null);
  const [typed, setTyped] = useState("");
  const [remembered, setRemembered] = useState<RecipeWord[]>([]);
  const [left, setLeft] = useState<RecipeWord[]>([]);
  const [earned, setEarned] = useState(0);
  const [halfPending, setHalfPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cleared, setCleared] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const current = queue[idx];
  const finished = idx >= queue.length;
  // Drawn once per card: a word saved mid-review reloads the recipe, and that must not reshuffle
  // the options under the learner. Only the dictionary arriving late redraws (the first card).
  const options = useMemo(
    () => (current && mode === "choice" ? meaningOptions(current, words, dict) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current, mode, dict === null],
  );
  const gapped = useMemo(() => (current ? withGap(current) : null), [current]);

  useEffect(() => {
    if (!current) return;
    // Writing the English: hearing it first would give the answer away.
    if (mode === "choice") say(current.word);
    else input.current?.focus();
  }, [current, mode]);
  useEffect(() => {
    if (finished && queue.length > 0) playFanfare();
  }, [finished, queue.length]);

  const answer = useCallback(
    async (correct: boolean, given: string) => {
      if (!current || saving || answered) return;
      setSaving(true);
      try {
        const r: RecipeReviewResult = await api.reviewRecipeWord(current.id, correct, mode);
        if (correct) {
          playCrunch();
          setRemembered((w) => [...w, current]);
        } else {
          playWrong();
          setLeft((w) => [...w, current]);
        }
        setEarned((k) => k + r.kcalEarned);
        setHalfPending(r.halfPending);
        setAnswered({ correct, given });
        if (r.kcalEarned > 0) onProgress();
        if (mode === "typing") window.setTimeout(() => say(current.word), 380);
      } catch (e) {
        toast(String(e));
      } finally {
        setSaving(false);
      }
    },
    [current, saving, answered, mode, onProgress, toast],
  );

  const next = useCallback(() => {
    stopSpeaking();
    setAnswered(null);
    setTyped("");
    setIdx((i) => i + 1);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (finished) return;
      if (answered && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        next();
      } else if (!answered && mode === "choice") {
        const n = Number(e.key);
        if (n >= 1 && n <= options.length) void answer(options[n - 1] === current.meaning, options[n - 1]);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [finished, answered, mode, options, current, answer, next]);

  if (finished) {
    const clearRemembered = async () => {
      setSaving(true);
      try {
        const n = await api.deleteRecipeWords(remembered.map((w) => w.id));
        setCleared(true);
        toast(`🧁 覚えた${n}語をレシピから片付けました`);
      } catch (e) {
        toast(String(e));
      } finally {
        setSaving(false);
      }
    };
    return (
      <section className="card recipe-review done">
        <h2>🧁 復習おしまい！</h2>
        <div className="recipe-counts big">
          <span className="positive">
            覚えた <b>{remembered.length}</b>語
          </span>
          <span>
            まだ <b>{left.length}</b>語
          </span>
          <span className="recipe-kcal">
            おやつ予算 <b>+{earned}</b> kcal
          </span>
        </div>
        {halfPending && (
          <p className="muted small">
            端数の 0.5 kcal は、今日のうちに次の 0.5 kcal と合わせて 1 kcal になります（日付が変わると切り捨て）。
          </p>
        )}
        {remembered.length > 0 && (
          <p className="muted">覚えた単語は習得済みになりました。レシピに残しておくことも、片付けることもできます。</p>
        )}
        <div className="row recipe-actions">
          {remembered.length > 0 && !cleared && (
            <button className="btn btn-primary" disabled={saving} onClick={() => void clearRemembered()}>
              覚えた{remembered.length}語をレシピから片付ける
            </button>
          )}
          {left.length > 0 && (
            <button className="btn" disabled={saving} onClick={() => onAgain(left)}>
              まだの{left.length}語をもう一度
            </button>
          )}
          <button className="btn" onClick={onDone}>
            レシピに戻る
          </button>
        </div>
      </section>
    );
  }

  const example = current.example ? (
    <div className="flash-example">
      {/* Meanings stay off until the answer is in, or hovering would give it away. */}
      <GlossedText text={current.example} dict={dict} enabled={!!answered} highlight={current.form || current.word} />
    </div>
  ) : null;

  return (
    <section className="card recipe-review">
      <div className="section-head">
        <h2>
          🧁 {REVIEW_TITLE[mode]} <span className="pill">1語 {REVIEW_KCAL[mode]} kcal</span>
        </h2>
        <div className="study-progress">
          {idx + 1} / {queue.length}
          <div className="mini-bar">
            <div style={{ width: `${((idx + (answered ? 1 : 0)) / queue.length) * 100}%` }} />
          </div>
        </div>
        <button className="btn-link" onClick={onDone}>
          やめる
        </button>
      </div>

      {mode === "choice" ? (
        <div className="flash" key={current.id}>
          <div className="prompt-label">この英語の意味は？</div>
          <button className="flash-word" onClick={() => say(current.word)} title="クリックで発音">
            {current.word}
          </button>
          {example}
          <div className="options recipe-options">
            {options.map((opt, i) => {
              let cls = "option";
              if (answered) {
                if (opt === current.meaning) cls += " correct";
                else if (opt === answered.given) cls += " wrong";
              }
              return (
                <button
                  key={opt + i}
                  className={cls}
                  disabled={!!answered || saving}
                  onClick={() => void answer(opt === current.meaning, opt)}
                >
                  <span className="option-num">{i + 1}</span>
                  <span>{opt}</span>
                </button>
              );
            })}
          </div>
          {!answered && <div className="muted small">キーボードの 1〜4 でも回答できます</div>}
        </div>
      ) : (
        <form
          className="flash"
          key={current.id}
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) void answer(typedRight(current, typed, dict), typed.trim());
          }}
        >
          <div className="prompt-label">この意味の英語は？</div>
          <div className="flash-meaning">{current.meaning}</div>
          {answered ? example : gapped && <div className="flash-example">{gapped}</div>}
          {current.exampleJa && <div className="muted">{current.exampleJa}</div>}
          <input
            ref={input}
            className="answer-input recipe-input"
            value={typed}
            disabled={!!answered || saving}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="英語で入力して Enter"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            lang="en"
          />
          {!answered && (
            <div className="row flash-actions">
              <button type="submit" className="btn btn-primary" disabled={saving || !typed.trim()}>
                回答する
              </button>
              <button type="button" className="btn-link" disabled={saving} onClick={() => void answer(false, "")}>
                わからない
              </button>
            </div>
          )}
        </form>
      )}

      {answered && (
        <div className={"feedback " + (answered.correct ? "ok" : "ng")}>
          <div className="feedback-main">
            <div className="feedback-title">{answered.correct ? "正解！ サクサク🍪" : "ざんねん…"}</div>
            <div className="feedback-kcal">{answered.correct ? `+${REVIEW_KCAL[mode]} kcal` : "+0 kcal"}</div>
          </div>
          <div className="feedback-detail">
            {mode === "typing" && !answered.correct && answered.given && (
              <div>
                <span className="label">あなたの答え</span> <span className="typed-wrong">{answered.given}</span>
              </div>
            )}
            <div>
              <span className="label">正解</span> <strong>{current.word}</strong>
              {shownForm(current) && <span className="muted">（{shownForm(current)}）</span>}　{current.meaning}
              <button className="btn-link" onClick={() => say(current.word)} disabled={!isTtsSupported()}>
                🔊 もう一度聞く
              </button>
            </div>
            <div className="muted">
              {answered.correct ? "習得済みになりました。" : "復習中のまま残ります。最後にもう一度挑戦できます。"}
            </div>
          </div>
          <button className="btn btn-primary" onClick={next} autoFocus>
            {idx + 1 >= queue.length ? "結果を見る" : "次へ（Enter）"}
          </button>
        </div>
      )}
    </section>
  );
}
