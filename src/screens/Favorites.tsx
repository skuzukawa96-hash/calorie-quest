import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import GlossedText from "../components/GlossedText";
import IpaLine from "../components/IpaLine";
import PencilIcon from "../components/PencilIcon";
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
  POINT_CATEGORIES,
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
/**
 * What the blue tags are called: the broad point a grammar question (its explanation's) or an exam
 * question asks about (時制, 比較, 代名詞…), by which the list is sorted and the review narrowed.
 */
const POINT_NOUN = "文法項目";

const tabLabel = (t: FavTab) => (t === "all" ? "すべて" : t === "exam" ? "試験" : TIER_LABEL[t]);
const formLabel = (f: Form) => (f.startsWith("part:") ? EXAM_PART_LABEL[f.slice(5) as ExamPart] : MODE_SHORT[f as Mode]);
const classOf = (f: Favorite): Tier | "exam" => (f.exam ? "exam" : f.question!.question.tier);
const formOf = (f: Favorite): Form => (f.exam ? `part:${f.exam.part}` : f.question!.mode);
/** Its 文法項目: an exam question's point, or a grammar question's explanation's; none for the others. */
const pointOf = (f: Favorite): string | null => (f.exam ? f.exam.point ?? null : f.question?.grammarNote?.category ?? null);
/** Where a 文法項目 comes in the list: in the order of POINT_CATEGORIES, those with none last. */
const pointRank = (p: string | null) => {
  const i = p === null ? -1 : POINT_CATEGORIES.indexOf(p);
  return i < 0 ? POINT_CATEGORIES.length : i;
};

/** 追加順 (newest first, or the other way round) and whether it goes by 文法項目, as last left. */
const ORDER_STORAGE = "cq-fav-order";

function loadOrder(): { reverse: boolean; grouped: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(ORDER_STORAGE) ?? "null");
    return { reverse: v?.reverse === true, grouped: v?.grouped === true };
  } catch {
    return { reverse: false, grouped: false };
  }
}

function saveOrder(reverse: boolean, grouped: boolean) {
  try {
    localStorage.setItem(ORDER_STORAGE, JSON.stringify({ reverse, grouped }));
  } catch {
    /* ignore */
  }
}

/** A menu that closes on a click elsewhere or Escape. */
function useClickAway(open: boolean, box: RefObject<HTMLElement | null>, setOpen: (open: boolean) => void) {
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open, box, setOpen]);
}

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

/**
 * What a review asks: every favorite on show that has not paid today (a review left part-way goes
 * on with those), or, once they all have, every one of them again (paying nothing more today).
 */
function roundOf(items: Favorite[]): Favorite[] {
  const unpaid = items.filter((f) => !f.paidToday);
  return unpaid.length > 0 ? unpaid : items;
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
  /** what the review paid is in today's kcal: the header reads it again */
  onProgress: () => void;
  toast: (msg: string) => void;
}

/** A review under way: one round of the study questions or of the exam questions. */
type Reviewing = { round: number } & ({ kind: "study"; study: FavoriteRound } | { kind: "exam"; exam: ExamFavoriteRound });

/**
 * お気に入り: the questions starred (☆ → ★) in a study session or an exam, a line each (the English
 * and what it means; a grammar or exam sentence with its answer in bold), opening on a click to
 * the explanation without the wrong options. Tabs sort them by kind (英単語 … 例文, 試験) and chips
 * by how they were asked (選択 / 記入 / 発音 / ヒアリング, or the exam's parts); 追加順 and 文法項目順
 * order them, and one 文法項目 can be picked (from the sort or beside the review buttons) to list
 * and review only it. The review asks every favorite on show not yet paid for today: answered right
 * one pays once a day (英単語 1 kcal, the others 2 kcal).
 */
export default function Favorites({ rates, overview, playMode, onProgress, toast }: Props) {
  const [list, setList] = useState<Favorite[] | null>(null);
  const [tab, setTab] = useState<FavTab>("all");
  const [form, setForm] = useState<Form | "all">("all");
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  /** unstarred on this visit: kept on the page, with ☆, so a slip can be starred again */
  const [unstarred, setUnstarred] = useState<Set<number>>(() => new Set());
  const [reviewing, setReviewing] = useState<Reviewing | null>(null);
  const [dict, setDict] = useState<Dictionary | null>(null);
  /** 追加順: newest first, or (clicked again) oldest first */
  const [reverse, setReverse] = useState(() => loadOrder().reverse);
  /** 文法項目順: the list in 文法項目 (時制 → 主語と動詞の一致 → …), each under its heading */
  const [grouped, setGrouped] = useState(() => loadOrder().grouped);
  /** one 文法項目 only, for the list and the review (from the sort's menu or the 範囲 beside the buttons) */
  const [only, setOnly] = useState<string | null>(null);
  const [sortMenu, setSortMenu] = useState(false);
  const [rangeMenu, setRangeMenu] = useState(false);
  const sortBox = useRef<HTMLDivElement>(null);
  const rangeBox = useRef<HTMLDivElement>(null);
  useClickAway(sortMenu, sortBox, setSortMenu);
  useClickAway(rangeMenu, rangeBox, setRangeMenu);
  useEffect(() => saveOrder(reverse, grouped), [reverse, grouped]);

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

  const inTabAndForm = useCallback(
    (f: Favorite) => inTab(f, tab) && (form === "all" || formOf(f) === form),
    [inTab, tab, form],
  );
  // The 文法項目 of the tab and form, with how many favorites each has, in their order.
  const points = useMemo(() => {
    const count = new Map<string, number>();
    for (const f of starred) {
      const p = pointOf(f);
      if (p && inTabAndForm(f)) count.set(p, (count.get(p) ?? 0) + 1);
    }
    return [...count].sort(([a], [b]) => pointRank(a) - pointRank(b)).map(([point, n]) => ({ point, n }));
  }, [starred, inTabAndForm]);
  // A 文法項目 no favorite of the tab and form has any more lists them all again.
  useEffect(() => {
    if (only !== null && !points.some((p) => p.point === only)) setOnly(null);
  }, [points, only]);

  const matches = useCallback(
    (f: Favorite) => inTabAndForm(f) && (only === null || pointOf(f) === only),
    [inTabAndForm, only],
  );
  const shown = useMemo(() => {
    const sign = reverse ? -1 : 1;
    return (list ?? [])
      .filter(matches)
      .sort(
        (a, b) =>
          (grouped ? pointRank(pointOf(a)) - pointRank(pointOf(b)) : 0) ||
          sign * (b.addedAt.localeCompare(a.addedAt) || b.id - a.id),
      );
  }, [list, matches, grouped, reverse]);
  const pool = shown.filter((f) => !unstarred.has(f.id));
  const studyPool = pool.filter((f) => f.question);
  const examPool = pool.filter((f) => f.exam);

  const startStudy = useCallback(
    (items: Favorite[], round: number) => {
      const picked = shuffle(roundOf(items));
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
      const picked = roundOf(items).sort((a, b) => {
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

  // The first click lines the list up by 文法項目; after that it opens the menu.
  const clickPointSort = () => (grouped || only !== null ? setSortMenu((m) => !m) : setGrouped(true));
  const pickPoint = (point: string | null, group = true) => {
    setOnly(point);
    setGrouped(group);
    setSortMenu(false);
    setRangeMenu(false);
  };

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
        onProgress={onProgress}
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
        onProgress={onProgress}
        toast={toast}
      />
    );
  }

  /** A review button: 学習 in a light green with a notebook, 試験 in a light blue with the green pencil. */
  const reviewButton = (kind: "study" | "exam", label: string, items: Favorite[], start: (items: Favorite[], round: number) => void) => {
    const unpaid = items.filter((f) => !f.paidToday).length;
    const note =
      unpaid === items.length ? `${items.length}問` : unpaid > 0 ? `残り${unpaid}問` : `${items.length}問 ✓`;
    const title =
      unpaid === items.length
        ? "正解すると1問につき1日1回カロリーがもらえます（英単語 1 kcal、ほかは 2 kcal）"
        : unpaid > 0
          ? `今日まだカロリーをもらっていない${unpaid}問を出題します（${items.length - unpaid}問は今日もらいました）`
          : "今日はすべてカロリーをもらいました。最初から全部を出題します（今日はもうカロリーはつきません）";
    return (
      <button className={"btn fav-review " + kind} disabled={items.length === 0} title={title} onClick={() => start(items, 1)}>
        <span className="fav-review-icon" aria-hidden="true">
          {kind === "study" ? "📓" : <PencilIcon />}
        </span>
        {label}（{note}）
      </button>
    );
  };

  return (
    <div className="screen favorites">
      <section className="card">
        <div className="section-head fav-head">
          <h2>
            <span className="fav-head-star">★</span> お気に入り {list && <span className="muted fav-total">{starred.length}問</span>}
          </h2>
          {pool.length > 0 && (
            <div className="row fav-review-buttons">
              {points.length > 0 && (
                <div className="fav-range" ref={rangeBox}>
                  <button
                    className={"chip fav-range-btn" + (only ? " active" : "")}
                    aria-haspopup="menu"
                    aria-expanded={rangeMenu}
                    title={`${POINT_NOUN}を選ぶと、その${POINT_NOUN}の問題だけを一覧に出して復習します`}
                    onClick={() => setRangeMenu((m) => !m)}
                  >
                    範囲：{only ?? "すべて"} <span className="recipe-caret-small">▾</span>
                  </button>
                  {rangeMenu && (
                    <div className="recipe-pos-menu fav-point-menu" role="menu">
                      <button role="menuitemradio" aria-checked={only === null} onClick={() => pickPoint(null, grouped)}>
                        <span>すべて</span>
                        <span className="count">{starred.filter(inTabAndForm).length}</span>
                      </button>
                      {points.map(({ point, n }) => (
                        <button key={point} role="menuitemradio" aria-checked={only === point} onClick={() => pickPoint(point, grouped)}>
                          <span>{point}</span>
                          <span className="count">{n}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {studyPool.length > 0 && examPool.length > 0 ? (
                <>
                  {reviewButton("study", "学習の問題を復習", studyPool, startStudy)}
                  {reviewButton("exam", "試験の問題を復習", examPool, startExam)}
                </>
              ) : studyPool.length > 0 ? (
                reviewButton("study", "この一覧を復習", studyPool, startStudy)
              ) : (
                reviewButton("exam", "この一覧を復習", examPool, startExam)
              )}
            </div>
          )}
        </div>
        <p className="muted small fav-intro">
          学習や試験の問題の右上の <b>☆</b> を押すと、ここに集まります。行をクリックすると解説が開きます。復習では一覧に出ている問題をすべて出題し、正解すると1問につき1日1回カロリーがもらえます（英単語 1 kcal、ほかは 2 kcal）。途中でやめても、同じ日ならまだカロリーをもらっていない問題から続きます。
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
                  <button
                    key={t}
                    className={(tab === t ? "active " : "") + (t === "all" ? "" : t === "exam" ? "exam" : "study")}
                    onClick={() => setTab(t)}
                  >
                    {tabLabel(t)} {starred.filter((f) => inTab(f, t)).length}
                  </button>
                ))}
              </div>
              <button className="btn-small recipe-open-all" disabled={shown.length === 0} onClick={toggleAll}>
                {allOpen ? "一括で詳細を閉じる" : "一括で詳細を開く"}
              </button>
              <div className="segmented recipe-sort fav-sort" role="group" aria-label="並び替え">
                {points.length > 0 && (
                  <div className="recipe-pos" ref={sortBox}>
                    <button
                      className={grouped || only ? "active" : ""}
                      aria-haspopup="menu"
                      aria-expanded={sortMenu}
                      title={grouped || only ? `${POINT_NOUN}を選ぶ` : `${POINT_NOUN}（時制・比較・代名詞…）ごとに並べる`}
                      onClick={clickPointSort}
                    >
                      {only ? `${only}のみ` : `${POINT_NOUN}順`}
                      {(grouped || only) && <span className="recipe-caret-small"> ▾</span>}
                    </button>
                    {sortMenu && (
                      <div className="recipe-pos-menu fav-point-menu" role="menu">
                        <button role="menuitemradio" aria-checked={grouped && only === null} onClick={() => pickPoint(null)}>
                          <span>すべての{POINT_NOUN}</span>
                          <span className="count">{starred.filter(inTabAndForm).length}</span>
                        </button>
                        {points.map(({ point, n }) => (
                          <button key={point} role="menuitemradio" aria-checked={only === point} onClick={() => pickPoint(point)}>
                            <span>{point}のみ</span>
                            <span className="count">{n}</span>
                          </button>
                        ))}
                        <hr />
                        <button role="menuitem" onClick={() => pickPoint(null, false)}>
                          <span>{POINT_NOUN}順をやめる</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
                <button className="active" title="もう一度押すと逆順" onClick={() => setReverse((r) => !r)}>
                  追加順<span className="recipe-dir">{reverse ? "古→新" : "新→古"}</span>
                </button>
              </div>
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
                {shown.map((f, i) => {
                  const isOpen = open.has(f.id);
                  const off = unstarred.has(f.id);
                  const s = summary(f);
                  const cls = classOf(f);
                  const point = pointOf(f);
                  const heading = grouped && (i === 0 || pointOf(shown[i - 1]) !== point);
                  return [
                    heading && (
                      <li key={"point-" + (point ?? "none")} className="recipe-group">
                        {point ?? `${POINT_NOUN}なし`}{" "}
                        <span>{shown.filter((x) => pointOf(x) === point).length}</span>
                      </li>
                    ),
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
                            {point && `・${point}`}
                            {f.exam && `・${overview.levels.find((l) => l.level === f.exam!.level)?.label ?? ""}`}・{stamp(f.addedAt)}{" "}
                            に追加
                            {f.lastReviewedAt && `・最後の復習 ${stamp(f.lastReviewedAt)}`}
                            {f.paidToday && "・今日のカロリー獲得済み"}
                          </div>
                        </div>
                      )}
                    </li>,
                  ];
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
