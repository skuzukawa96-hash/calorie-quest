import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import GlossedText from "../components/GlossedText";
import IpaLine from "../components/IpaLine";
import PronunciationTips from "../components/PronunciationTips";
import WordNotesPanel from "../components/WordNotes";
import { api } from "../lib/api";
import { loadDictionary, type Dictionary } from "../lib/dictionary";
import { PHONEMES } from "../lib/phonemes";
import { loadPronunciations, type Pronunciations } from "../lib/pronunciation";
import type { TipKey } from "../lib/scoring";
import { isTtsSupported, speak, stopSpeaking } from "../lib/speech";
import {
  EXAM_PART_LABEL,
  TIER_LABEL,
  TIERS,
  type ExamOverview,
  type ExamPart,
  type ExamQuestion,
  type Favorite,
  type KcalRates,
  type Mode,
  type PlayMode,
  type SessionQuestion,
  type Tier,
} from "../types";
import Exam, { type ExamFavoriteRound } from "./Exam";
import Study, { type FavoriteRound } from "./Study";

/** The tabs: every favorite, one tab of the study questions, or the exam questions. */
type FavTab = "all" | Tier | "exam";
/**
 * How a favorite is asked: a study mode, or an exam part ("part:listening", kept apart from the
 * study's listening: 応答問題 is not ヒアリング).
 */
type Form = Mode | `part:${ExamPart}`;

const MODES: Mode[] = ["choice", "typing", "speaking", "listening"];
const MODE_SHORT: Record<Mode, string> = { choice: "選択", typing: "記入", speaking: "発音", listening: "ヒアリング" };
const PART_ORDER: ExamPart[] = ["listening", "short", "text", "reading"];
/** favorites gone over in one round of the review, those left longest first */
const ROUND_SIZE = 10;

const tabLabel = (t: FavTab) => (t === "all" ? "すべて" : t === "exam" ? "試験" : TIER_LABEL[t]);
const formLabel = (f: Form) => (f.startsWith("part:") ? EXAM_PART_LABEL[f.slice(5) as ExamPart] : MODE_SHORT[f as Mode]);
const classOf = (f: Favorite): Tier | "exam" => (f.exam ? "exam" : f.question!.question.tier);
const formOf = (f: Favorite): Form => (f.exam ? `part:${f.exam.part}` : f.question!.mode);

function say(text: string) {
  if (isTtsSupported()) speak(text).catch(() => undefined);
}

function stamp(ts: string): string {
  return ts.slice(0, 16).replace("T", " ");
}

function shuffle<T>(list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Up to a round of favorites: never gone over first, then those gone over longest ago. */
function pickRound(items: Favorite[]): Favorite[] {
  return [...items].sort((a, b) => (a.lastReviewedAt ?? "").localeCompare(b.lastReviewedAt ?? "")).slice(0, ROUND_SIZE);
}

/** `sentence` with the first `answer` in it bold: the word a grammar or exam blank asked for. */
function marked(sentence: string, answer: string): ReactNode {
  const at = answer && answer !== "(none)" ? sentence.toLowerCase().indexOf(answer.toLowerCase()) : -1;
  if (at < 0) return sentence;
  return (
    <>
      {sentence.slice(0, at)}
      <b>{sentence.slice(at, at + answer.length)}</b>
      {sentence.slice(at + answer.length)}
    </>
  );
}

/**
 * What a favorite's line shows: the English (or what was asked) and, under it, what it means. A
 * grammar or exam sentence has its answer in bold and the point it asks about as a tag.
 */
function summary(f: Favorite): { title: ReactNode; tag?: string | null; sub: string | null; speak: string } {
  if (f.exam) {
    const e = f.exam;
    if (e.part === "listening") return { title: e.sentence, sub: `→ ${e.answer}`, speak: e.sentence };
    if (e.part === "reading") return { title: e.prompt ?? e.sentence, sub: `→ ${e.answer}`, speak: e.prompt ?? e.sentence };
    return { title: marked(e.sentence, e.answer), tag: e.point, sub: e.sentenceJa ?? null, speak: e.sentence };
  }
  const sq = f.question!;
  const q = sq.question;
  if (q.kind === "grammar") return { title: marked(sq.audioText, q.en), tag: sq.grammarNote?.title, sub: q.ja, speak: sq.audioText };
  if (q.kind === "dialogue") return { title: q.prompt ?? sq.audioText, sub: `→ ${q.en}`, speak: q.prompt ?? q.en };
  return { title: q.en, sub: q.ja, speak: q.en };
}

interface Props {
  rates: KcalRates;
  overview: ExamOverview;
  playMode: PlayMode;
  toast: (msg: string) => void;
}

/** A review under way: one round of the study questions or of the exam questions. */
type Reviewing = { round: number } & ({ kind: "study"; study: FavoriteRound } | { kind: "exam"; exam: ExamFavoriteRound });

/**
 * お気に入り: the questions starred (☆ → ★) in a study session or an exam, a line each (the English
 * and what it means; a grammar or exam sentence with its answer in bold), opening on a click to
 * the explanation without the wrong options. Tabs sort them by kind (英単語 … 例文, 試験) and chips
 * by how they were asked (選択 / 記入 / 発音 / ヒアリング, or the exam's parts). The review asks the
 * favorites on show again, ten at a time, paying nothing and recording nothing.
 */
export default function Favorites({ rates, overview, playMode, toast }: Props) {
  const [list, setList] = useState<Favorite[] | null>(null);
  const [tab, setTab] = useState<FavTab>("all");
  const [form, setForm] = useState<Form | "all">("all");
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  /** unstarred on this visit: kept on the page, with ☆, so a slip can be starred again */
  const [unstarred, setUnstarred] = useState<Set<number>>(() => new Set());
  const [reviewing, setReviewing] = useState<Reviewing | null>(null);
  const [dict, setDict] = useState<Dictionary | null>(null);

  const load = useCallback(async () => {
    try {
      const fresh = await api.listFavorites();
      setList(fresh);
      setUnstarred(new Set());
      return fresh;
    } catch (e) {
      toast(String(e));
      return null;
    }
  }, [toast]);

  useEffect(() => {
    void load();
    let alive = true;
    loadDictionary().then((d) => alive && setDict(d));
    return () => {
      alive = false;
      stopSpeaking();
    };
  }, [load]);

  const starred = useMemo(() => (list ?? []).filter((f) => !unstarred.has(f.id)), [list, unstarred]);
  const inTab = useCallback((f: Favorite, t: FavTab) => t === "all" || classOf(f) === t, []);
  // The tabs and chips go by every favorite on the page, unstarred ones too, so taking the last one
  // off a tab does not move the page away from it (and from the ☆ that puts it back).
  const tabs: FavTab[] = useMemo(
    () => ["all" as FavTab, ...[...TIERS, "exam" as const].filter((t) => (list ?? []).some((f) => classOf(f) === t))],
    [list],
  );
  // The chips: the ways the favorites of the tab were asked; none when there is only one.
  const forms: Form[] = useMemo(() => {
    const order: Form[] = tab === "exam" ? PART_ORDER.map((p) => `part:${p}` as const) : MODES;
    const present = order.filter((fm) => (list ?? []).some((f) => inTab(f, tab) && formOf(f) === fm));
    return present.length > 1 ? present : [];
  }, [tab, list, inTab]);

  // A tab gone empty (its last favorite unstarred and the list read again) falls back to すべて.
  useEffect(() => {
    if (!tabs.includes(tab)) setTab("all");
  }, [tabs, tab]);
  useEffect(() => {
    if (form !== "all" && !forms.includes(form)) setForm("all");
  }, [forms, form]);

  const matches = useCallback(
    (f: Favorite) => inTab(f, tab) && (form === "all" || formOf(f) === form),
    [inTab, tab, form],
  );
  const shown = useMemo(() => (list ?? []).filter(matches), [list, matches]);
  const pool = shown.filter((f) => !unstarred.has(f.id));
  const studyPool = pool.filter((f) => f.question);
  const examPool = pool.filter((f) => f.exam);

  const startStudy = useCallback(
    (items: Favorite[], round: number) => {
      const picked = shuffle(pickRound(items));
      const study: FavoriteRound = {
        items: picked.map((f) => ({ favoriteId: f.id, question: f.question! })),
        onAgain: async () => {
          const fresh = await load();
          const next = (fresh ?? []).filter((f) => f.question && matches(f));
          if (next.length > 0) startStudy(next, round + 1);
          else setReviewing(null);
        },
      };
      setReviewing({ round, kind: "study", study });
    },
    [load, matches],
  );

  const startExam = useCallback(
    (items: Favorite[], round: number) => {
      // In the order of an exam: the parts in turn, a passage's blanks together.
      const picked = pickRound(items).sort((a, b) => {
        const x = a.exam!;
        const y = b.exam!;
        return (
          PART_ORDER.indexOf(x.part) - PART_ORDER.indexOf(y.part) ||
          x.setId.localeCompare(y.setId) ||
          (x.blank ?? 0) - (y.blank ?? 0) ||
          x.id.localeCompare(y.id)
        );
      });
      const exam: ExamFavoriteRound = {
        items: picked.map((f) => ({ favoriteId: f.id, question: f.exam! })),
        onAgain: async () => {
          const fresh = await load();
          const next = (fresh ?? []).filter((f) => f.exam && matches(f));
          if (next.length > 0) startExam(next, round + 1);
          else setReviewing(null);
        },
      };
      setReviewing({ round, kind: "exam", exam });
    },
    [load, matches],
  );

  const stopReview = useCallback(() => {
    stopSpeaking();
    setReviewing(null);
    void load();
  }, [load]);

  const toggleStar = useCallback(
    async (f: Favorite) => {
      const on = unstarred.has(f.id);
      try {
        if (f.exam) await api.setExamFavorite(f.exam.id, on);
        else await api.setQuestionFavorite(f.question!.question.id, f.question!.mode, on);
        if (on) {
          // Starred again it is a new favorite: the list is read again to know it.
          await load();
          toast("★ お気に入りに戻しました");
        } else {
          setUnstarred((cur) => new Set(cur).add(f.id));
          toast("☆ お気に入りから外しました（もう一度押すと戻せます）");
        }
      } catch (e) {
        toast(String(e));
      }
    },
    [unstarred, load, toast],
  );

  const toggleOpen = (id: number) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allOpen = shown.length > 0 && shown.every((f) => open.has(f.id));
  const toggleAll = () =>
    setOpen((cur) => {
      const next = new Set(cur);
      for (const f of shown) {
        if (allOpen) next.delete(f.id);
        else next.add(f.id);
      }
      return next;
    });

  if (reviewing?.kind === "study") {
    return (
      <Study
        key={reviewing.round}
        mode="review"
        tier="mixed"
        category="all"
        rates={rates}
        playMode={playMode}
        favorites={reviewing.study}
        onExit={stopReview}
        onProgress={() => undefined}
        toast={toast}
      />
    );
  }
  if (reviewing?.kind === "exam") {
    return (
      <Exam
        key={reviewing.round}
        kind="favorites"
        favorites={reviewing.exam}
        overview={overview}
        playMode={playMode}
        onExit={stopReview}
        onProgress={() => undefined}
        toast={toast}
      />
    );
  }

  const roundNote = (n: number) => (n > ROUND_SIZE ? `${n}問から${ROUND_SIZE}問ずつ` : `${n}問`);
  const reviewButton = (label: string, items: Favorite[], start: (items: Favorite[], round: number) => void) => (
    <button
      className="btn btn-primary"
      disabled={items.length === 0}
      title={items.length > ROUND_SIZE ? `しばらく復習していない問題から${ROUND_SIZE}問ずつ出題します` : undefined}
      onClick={() => start(items, 1)}
    >
      ▶ {label}（{roundNote(items.length)}）
    </button>
  );

  return (
    <div className="screen favorites">
      <section className="card">
        <div className="section-head">
          <h2>
            ★ お気に入り {list && <span className="muted fav-total">{starred.length}問</span>}
          </h2>
          {pool.length > 0 && (
            <div className="row fav-review-buttons">
              {studyPool.length > 0 && examPool.length > 0 ? (
                <>
                  {reviewButton("学習の問題を復習", studyPool, startStudy)}
                  {reviewButton("試験の問題を復習", examPool, startExam)}
                </>
              ) : studyPool.length > 0 ? (
                reviewButton("この一覧を復習", studyPool, startStudy)
              ) : (
                reviewButton("この一覧を復習", examPool, startExam)
              )}
            </div>
          )}
        </div>
        <p className="muted small fav-intro">
          学習や試験の問題の右上の <b>☆</b> を押すと、ここに集まります。行をクリックすると解説が開きます。復習では一覧に出ている問題を出題します（カロリーはつかず、学習の復習や記録も変わりません）。
        </p>
      </section>

      <section className="card">
        {list === null ? (
          <div className="loading">読み込み中…</div>
        ) : list.length === 0 ? (
          <div className="recipe-empty">
            <div className="recipe-empty-icon">⭐</div>
            <p>まだお気に入りがありません。</p>
            <p className="muted">見返したい文法や用法の問題があったら、問題の右上の ☆ を押してみましょう。</p>
          </div>
        ) : (
          <>
            <div className="fav-toolbar">
              <div className="segmented fav-tabs">
                {tabs.map((t) => (
                  <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
                    {tabLabel(t)} {starred.filter((f) => inTab(f, t)).length}
                  </button>
                ))}
              </div>
              <button className="btn-small recipe-open-all" disabled={shown.length === 0} onClick={toggleAll}>
                {allOpen ? "一括で詳細を閉じる" : "一括で詳細を開く"}
              </button>
            </div>
            {forms.length > 0 && (
              <div className="fav-forms" role="group" aria-label="出題形式で絞り込む">
                <span className="muted small">形式</span>
                {(["all", ...forms] as (Form | "all")[]).map((fm) => (
                  <button key={fm} className={"chip" + (form === fm ? " active" : "")} onClick={() => setForm(fm)}>
                    {fm === "all" ? "すべて" : formLabel(fm)}{" "}
                    <span className="count">
                      {starred.filter((f) => inTab(f, tab) && (fm === "all" || formOf(f) === fm)).length}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {shown.length === 0 ? (
              <p className="muted">この条件のお気に入りはありません。</p>
            ) : (
              <ul className="recipe-list fav-list">
                {shown.map((f) => {
                  const isOpen = open.has(f.id);
                  const off = unstarred.has(f.id);
                  const s = summary(f);
                  const cls = classOf(f);
                  return (
                    <li key={f.id} className={"recipe-item fav-item" + (isOpen ? " open" : "") + (off ? " off" : "")}>
                      <div
                        className="recipe-item-head fav-item-head"
                        role="button"
                        tabIndex={0}
                        aria-expanded={isOpen}
                        title={isOpen ? "閉じる" : "解説を見る"}
                        onClick={() => toggleOpen(f.id)}
                        onKeyDown={(e) => {
                          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                            e.preventDefault();
                            toggleOpen(f.id);
                          }
                        }}
                      >
                        <span className="fav-tags">
                          <span className={"fav-class " + cls}>{tabLabel(cls)}</span>
                          <span className="fav-form">{formLabel(formOf(f))}</span>
                        </span>
                        <span className="fav-text">
                          <span className="fav-title">{s.title}</span>
                          {(s.tag || s.sub) && (
                            <span className="fav-sub">
                              {s.tag && <span className="fav-point">{s.tag}</span>}
                              {s.sub}
                            </span>
                          )}
                        </span>
                        <button
                          className="btn-link speak-btn fav-speak"
                          onClick={(e) => {
                            e.stopPropagation();
                            say(s.speak);
                          }}
                          disabled={!isTtsSupported()}
                          title="読み上げる"
                          aria-label="読み上げる"
                        >
                          🔊
                        </button>
                        <button
                          className={"fav-star-small" + (off ? "" : " on")}
                          onClick={(e) => {
                            e.stopPropagation();
                            void toggleStar(f);
                          }}
                          title={off ? "お気に入りに戻す" : "お気に入りから外す"}
                          aria-label={off ? "お気に入りに戻す" : "お気に入りから外す"}
                          aria-pressed={!off}
                        >
                          {off ? "☆" : "★"}
                        </button>
                        <span className="recipe-caret" aria-hidden="true">
                          ▾
                        </span>
                      </div>
                      {isOpen && (
                        <div className="recipe-item-body fav-detail">
                          {f.exam ? (
                            <ExamDetail q={f.exam} dict={dict} />
                          ) : (
                            <StudyDetail sq={f.question!} dict={dict} />
                          )}
                          <div className="muted small fav-foot">
                            {tabLabel(cls)}・{formLabel(formOf(f))}
                            {f.exam && `・${overview.levels.find((l) => l.level === f.exam!.level)?.label ?? ""}`}・{stamp(f.addedAt)}{" "}
                            に追加
                            {f.lastReviewedAt && `・最後の復習 ${stamp(f.lastReviewedAt)}`}
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
}

/* ---------- what a favorite opens to ---------- */

function SpeakButton({ text }: { text: string }) {
  return (
    <button className="btn-link speak-btn" onClick={() => say(text)} disabled={!isTtsSupported()} title="読み上げる" aria-label="読み上げる">
      🔊
    </button>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fav-line">
      <span className="label">{label}</span> <span className="fav-line-body">{children}</span>
    </div>
  );
}

/**
 * A study question summed up for looking back: the English and its meaning (a grammar sentence
 * completed, a dialogue's line and reply), the example, the grammar point and the notes a word or
 * a sentence has, but none of the wrong options.
 */
function StudyDetail({ sq, dict }: { sq: SessionQuestion; dict: Dictionary | null }) {
  const q = sq.question;
  return (
    <>
      {q.kind === "grammar" ? (
        <>
          <Line label="完成した文">
            <GlossedText text={sq.audioText} dict={dict} enabled highlight={q.en === "(none)" ? undefined : q.en} contextJa={q.ja} />
            <SpeakButton text={sq.audioText} />
          </Line>
          <div className="muted fav-ja">{q.ja}</div>
        </>
      ) : q.kind === "dialogue" ? (
        <>
          <Line label="聞こえる英語">
            <GlossedText text={q.prompt ?? ""} dict={dict} enabled contextJa={q.ja} />
            <SpeakButton text={q.prompt ?? ""} />
          </Line>
          <div className="muted fav-ja">{q.ja}</div>
          <Line label="応答">
            <GlossedText text={q.en} dict={dict} enabled />
            <SpeakButton text={q.en} />
          </Line>
        </>
      ) : (
        <>
          <Line label="英語">
            <strong>
              <GlossedText text={q.en} dict={dict} enabled={q.en.includes(" ")} contextJa={q.kind === "word" ? undefined : q.ja} />
            </strong>
            <SpeakButton text={q.en} />
          </Line>
          {sq.mode === "speaking" && <Pronunciation text={q.en} />}
          <Line label="意味">{q.ja}</Line>
        </>
      )}
      {q.example && (
        <Line label="例文">
          <GlossedText text={q.example} dict={dict} enabled highlight={q.en} contextJa={q.exampleJa} />
          <SpeakButton text={q.example} />
          {q.exampleJa && <div className="muted">{q.exampleJa}</div>}
        </Line>
      )}
      {sq.grammarNote && (
        <div className="grammar-note">
          <div className="grammar-note-title">📘 {sq.grammarNote.title}</div>
          <div>
            <GlossedText text={sq.grammarNote.body} dict={dict} enabled />
          </div>
          <div className="grammar-note-example">
            <GlossedText text={sq.grammarNote.example} dict={dict} enabled />
          </div>
        </div>
      )}
      {sq.notes && <WordNotesPanel notes={sq.notes} word={q.en} meaning={q.ja} dict={dict} gloss />}
    </>
  );
}

/**
 * A speaking favorite's English in IPA, as the speaking card shows it. A sound clicked (or
 * right-clicked) opens 発音のコツ under it with how to make that sound.
 */
function Pronunciation({ text }: { text: string }) {
  const [table, setTable] = useState<Pronunciations | null>(null);
  const [phoneme, setPhoneme] = useState<string | null>(null);
  const [tip, setTip] = useState<TipKey | null>(null);
  useEffect(() => {
    let alive = true;
    loadPronunciations()
      .then((t) => alive && setTable(t))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  if (!table) return null;
  const pick = (sound: string) => {
    setPhoneme(sound);
    const diagram = PHONEMES[sound]?.diagram;
    if (diagram) setTip(diagram);
  };
  return (
    <div className="fav-ipa">
      <IpaLine text={text} table={table} active={phoneme} onPick={pick} />
      {phoneme && (
        <PronunciationTips text={text} active={tip} onActiveChange={setTip} phoneme={phoneme} onPhonemeChange={setPhoneme} />
      )}
    </div>
  );
}

/** An exam question summed up: the passage (folded), what was asked, the answer and its explanation. */
function ExamDetail({ q, dict }: { q: ExamQuestion; dict: Dictionary | null }) {
  const own = q.blank ? `[${q.blank}]` : null;
  return (
    <>
      {q.passage && (q.part === "text" || q.part === "reading") && (
        <details className="exam-passage-ja fav-passage">
          <summary>本文を見る{q.title ? `（${q.title}）` : ""}</summary>
          {q.passage.split("\n").map((line, i) => (
            <p key={i}>
              {line.split(/(\[\d+\])/).map((seg, si) =>
                /^\[\d+\]$/.test(seg) ? (
                  <span key={si} className={"exam-blank" + (seg === own ? " done" : "")}>
                    {seg === own ? q.answer : seg.replace("[", "(").replace("]", ")")}
                  </span>
                ) : (
                  <span key={si}>{seg}</span>
                ),
              )}
            </p>
          ))}
          {q.passageJa && (
            <div className="muted">
              {q.passageJa.split("\n").map((l, i) => (
                <p key={i}>{l}</p>
              ))}
            </div>
          )}
        </details>
      )}
      {q.part === "listening" ? (
        <>
          <Line label="聞こえた英語">
            <GlossedText text={q.sentence} dict={dict} enabled contextJa={q.sentenceJa} />
            <SpeakButton text={q.sentence} />
          </Line>
          {q.sentenceJa && <div className="muted fav-ja">{q.sentenceJa}</div>}
          <Line label="応答">
            <strong>{q.answer}</strong>
            <SpeakButton text={q.answer} />
          </Line>
        </>
      ) : q.part === "reading" ? (
        <>
          <Line label="設問">
            <GlossedText text={q.prompt ?? ""} dict={dict} enabled context={q.sentence} contextJa={q.sentenceJa} />
          </Line>
          {q.promptJa && <div className="muted fav-ja">{q.promptJa}</div>}
          <Line label="正解">
            <strong>{q.answer}</strong>
          </Line>
        </>
      ) : (
        <>
          <Line label="完成した文">
            <GlossedText text={q.sentence} dict={dict} enabled highlight={q.answer} contextJa={q.sentenceJa} />
            <SpeakButton text={q.sentence} />
          </Line>
          {q.sentenceJa && <div className="muted fav-ja">{q.sentenceJa}</div>}
          <Line label="正解">
            <strong>{q.answer}</strong>
            {q.point && <span className="pill exam-point">{q.point}</span>}
          </Line>
        </>
      )}
      <div className="exam-explanation">
        <div className="grammar-note-title">📘 解説</div>
        <div>{q.explanation}</div>
      </div>
      {q.notes && <WordNotesPanel notes={q.notes} word={q.answer} meaning={dict?.[q.answer.toLowerCase()] ?? ""} dict={dict} gloss />}
    </>
  );
}
