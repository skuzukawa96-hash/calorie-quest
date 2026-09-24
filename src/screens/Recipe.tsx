import { useCallback, useEffect, useState } from "react";
import GlossedText from "../components/GlossedText";
import { api } from "../lib/api";
import { loadDictionary, type Dictionary } from "../lib/dictionary";
import { onRecipeChanged } from "../lib/recipe";
import { playCrunch, playFanfare } from "../lib/sfx";
import { isTtsSupported, speak, stopSpeaking } from "../lib/speech";
import type { RecipeWord } from "../types";

interface Props {
  toast: (msg: string) => void;
}

type Filter = "all" | "learning" | "mastered";

const NO_MEANING = "（辞書に意味がありません）";

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

/**
 * お菓子作りレシピ: the words the learner right-clicked while studying. They are reviewed as
 * flashcards here; "覚えた" marks one learned, and learned words can be cleared out of the list.
 */
export default function Recipe({ toast }: Props) {
  const [words, setWords] = useState<RecipeWord[] | null>(null);
  const [dict, setDict] = useState<Dictionary | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [reviewing, setReviewing] = useState<RecipeWord[] | null>(null);
  /** each round of flashcards starts from a fresh component */
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

  if (reviewing) {
    return (
      <div className="screen recipe">
        <RecipeReview
          key={round}
          queue={reviewing}
          dict={dict}
          onAgain={(left) => {
            setRound((r) => r + 1);
            setReviewing(shuffled(left));
          }}
          onDone={() => {
            stopSpeaking();
            setReviewing(null);
            void reload();
          }}
          toast={toast}
        />
      </div>
    );
  }

  const shown = filter === "learning" ? learning : filter === "mastered" ? mastered : words;

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
          問題や解説の英単語を<b>右クリック</b>すると、ここに材料として集まります。復習で「覚えた」にした単語は習得済みになり、レシピから片付けられます。
        </p>
        <div className="row recipe-actions">
          <button className="btn btn-primary" disabled={busy || learning.length === 0} onClick={() => setReviewing(shuffled(learning))}>
            🧁 復習する（{learning.length}語）
          </button>
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

/* ---------- flashcard review ---------- */

function RecipeReview({
  queue,
  dict,
  onAgain,
  onDone,
  toast,
}: {
  queue: RecipeWord[];
  dict: Dictionary | null;
  onAgain: (left: RecipeWord[]) => void;
  onDone: () => void;
  toast: (msg: string) => void;
}) {
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [remembered, setRemembered] = useState<RecipeWord[]>([]);
  const [left, setLeft] = useState<RecipeWord[]>([]);
  const [saving, setSaving] = useState(false);
  const [cleared, setCleared] = useState(false);

  const current = queue[idx];
  const finished = idx >= queue.length;

  useEffect(() => {
    if (current) say(current.word);
  }, [current]);
  useEffect(() => {
    if (finished && queue.length > 0) playFanfare();
  }, [finished, queue.length]);

  const answer = useCallback(
    async (ok: boolean) => {
      if (!current || saving) return;
      setSaving(true);
      try {
        await api.reviewRecipeWord(current.id, ok);
        if (ok) {
          playCrunch();
          setRemembered((r) => [...r, current]);
        } else {
          setLeft((l) => [...l, current]);
        }
        setRevealed(false);
        setIdx((i) => i + 1);
      } catch (e) {
        toast(String(e));
      } finally {
        setSaving(false);
      }
    },
    [current, saving, toast],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (finished) return;
      if (!revealed && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        setRevealed(true);
      } else if (revealed && e.key === "1") {
        void answer(true);
      } else if (revealed && e.key === "2") {
        void answer(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [finished, revealed, answer]);

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
        </div>
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

  return (
    <section className="card recipe-review">
      <div className="section-head">
        <h2>🧁 レシピの復習</h2>
        <div className="study-progress">
          {idx + 1} / {queue.length}
          <div className="mini-bar">
            <div style={{ width: `${(idx / queue.length) * 100}%` }} />
          </div>
        </div>
        <button className="btn-link" onClick={onDone}>
          やめる
        </button>
      </div>
      <div className="flash" key={current.id}>
        <button className="flash-word" onClick={() => say(current.word)} title="クリックで発音">
          {current.word}
        </button>
        {current.example && (
          <div className="flash-example">
            {/* Meanings stay off until the card is turned, or hovering would give it away. */}
            <GlossedText text={current.example} dict={dict} enabled={revealed} highlight={current.form || current.word} />
          </div>
        )}
        {revealed ? (
          <>
            <div className="flash-meaning">{current.meaning || NO_MEANING}</div>
            {current.exampleJa && <div className="muted">{current.exampleJa}</div>}
            <div className="row flash-actions">
              <button className="btn btn-primary" disabled={saving} onClick={() => void answer(true)}>
                ✓ 覚えた（1）
              </button>
              <button className="btn" disabled={saving} onClick={() => void answer(false)}>
                まだ（2）
              </button>
            </div>
            <div className="muted small">「覚えた」にすると習得済みになり、レシピから片付けられます。</div>
          </>
        ) : (
          <button className="btn btn-primary" onClick={() => setRevealed(true)}>
            意味を見る（Enter）
          </button>
        )}
      </div>
    </section>
  );
}
