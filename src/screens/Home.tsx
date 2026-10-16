import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import CalorieBar from "../components/CalorieBar";
import GoalAdder, { SNACK_GOALS, TASK_GOALS } from "../components/GoalAdder";
import { DeleteButton, DoneButton, EatButton, SwitchViewButton } from "../components/IconButtons";
import { iconLabel, ItemIcon } from "../components/ItemIcon";
import PencilIcon from "../components/PencilIcon";
import WeightForm from "../components/WeightForm";
import { api } from "../lib/api";
import { playCrunch, playDone, playFanfare } from "../lib/sfx";
import {
  ALL_CATEGORIES,
  categoryIcon,
  grammarPointCategory,
  PLAY_MODE_INFO,
  POS_LABEL,
  posCategory,
  remainingKcal,
  TIER_LABEL,
  TIERS,
  type CategoryInfo,
  type Dashboard,
  type ExamLevel,
  type TierChoice,
  type Mode,
  type SessionMode,
  type Snack,
  type Task,
} from "../types";

interface Props {
  dash: Dashboard;
  onStart: (mode: SessionMode, tier: TierChoice, category: string) => void;
  /** 試験 of a level, and the review of the exam questions missed */
  onExam: (level: ExamLevel) => void;
  onExamReview: () => void;
  onChanged: () => void;
  goToSnacks: () => void;
  /** お菓子引換券 in use: each goal shows a 引換券 button (the 図鑑 shows them too) */
  ticketMode: boolean;
  onTicketMode: (on: boolean) => void;
  toast: (msg: string) => void;
}

/** Each card: the icon beside the title, then two lines of what it is, one phrase a line. The
 * pointing finger and the pencil are the ones of the recipe's 選択式 / 記入式 reviews. */
/** The tab and genre (or part of speech) picked to study, kept for the next time home is shown. */
const STUDY_CHOICE_KEY = "cq-home-study";

function loadStudyChoice(): { tier: TierChoice; category: string } {
  try {
    const v = JSON.parse(localStorage.getItem(STUDY_CHOICE_KEY) ?? "null");
    const tier = [...TIERS, "mixed"].includes(v?.tier) ? (v.tier as TierChoice) : "word";
    return { tier, category: typeof v?.category === "string" ? v.category : ALL_CATEGORIES };
  } catch {
    return { tier: "word", category: ALL_CATEGORIES };
  }
}

function saveStudyChoice(tier: TierChoice, category: string) {
  try {
    localStorage.setItem(STUDY_CHOICE_KEY, JSON.stringify({ tier, category }));
  } catch {
    /* ignore */
  }
}

/** 目標のお菓子 or, with ダイエット機能, 目標の課題: the goal card shows one, kept for the next time. */
type GoalTab = "snacks" | "tasks";
const GOAL_TAB_KEY = "cq-home-goal-tab";

function loadGoalTab(): GoalTab {
  try {
    return localStorage.getItem(GOAL_TAB_KEY) === "tasks" ? "tasks" : "snacks";
  } catch {
    return "snacks";
  }
}

function saveGoalTab(tab: GoalTab) {
  try {
    localStorage.setItem(GOAL_TAB_KEY, tab);
  } catch {
    /* ignore */
  }
}

const MODES: Array<{ mode: Mode; icon: ReactNode; title: string; desc: [string, string] }> = [
  { mode: "choice", icon: "👆", title: "選択問題", desc: ["4択でテンポよく", "単語の意味や文法の穴埋め"] },
  { mode: "typing", icon: <PencilIcon />, title: "記入問題", desc: ["日本語に合う英語をタイピング", "スペルを定着"] },
  { mode: "speaking", icon: "🎤", title: "発音問題", desc: ["お手本を聞いてリピート", "音声認識でスコア判定"] },
  { mode: "listening", icon: "👂", title: "ヒアリング問題", desc: ["英語を聞いて意味を当てる", "会話には英語で応答"] },
];

/** What each level of 試験 is, one phrase a line. */
const EXAM_DESC: Record<ExamLevel, [string, string]> = {
  basic: ["中学～高校で習う文法と単語", "身近な場面の英語"],
  toeic600: ["TOEIC 500〜700点が目安", "オフィス・お店・旅行の英語"],
  toeic800: ["TOEIC 800点が目安", "仮定法・倒置や推測を問う読解"],
};

export default function Home({
  dash,
  onStart,
  onExam,
  onExamReview,
  onChanged,
  goToSnacks,
  ticketMode,
  onTicketMode,
  toast,
}: Props) {
  // As last picked: after a session, home comes back to the same tab and genre.
  const [tier, setTier] = useState<TierChoice>(() => loadStudyChoice().tier);
  const [category, setCategory] = useState<string>(() => loadStudyChoice().category);
  useEffect(() => saveStudyChoice(tier, category), [tier, category]);
  const [redeeming, setRedeeming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [goalTab, setGoalTab] = useState<GoalTab>(loadGoalTab);
  const { today, user, goalSnacks, goalTasks, eatenToday, doneToday, kcalRates, savings } = dash;
  // The 課題 are there only with ダイエット機能 on; turned off, the card is the snacks' again.
  const showTasks = user.dietMode && goalTab === "tasks";
  // A form open for one side is not left open on the other (by ⇄, or ダイエット機能 turned off in the top bar).
  useEffect(() => setAdding(false), [showTasks]);
  const switchGoals = () => {
    const next: GoalTab = showTasks ? "snacks" : "tasks";
    setGoalTab(next);
    saveGoalTab(next);
  };

  // What is still left to spend today; a goal is within reach once it fits in there.
  const budget = remainingKcal(today);
  // Questions to go at the play mode's rate: がんばり halves what each pays.
  const modeRate = PLAY_MODE_INFO[user.playMode].multiplier;
  const need = (remaining: number, rate: number) => Math.ceil(remaining / (rate * modeRate));

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      toast(String(e));
    } finally {
      setBusy(false);
    }
  };
  const eat = (s: Snack) =>
    act(async () => {
      await api.logSnackEaten(s.id);
      playCrunch();
      toast(`${s.icon} ${s.name}（${s.calories} kcal）を食べました。取り消しはお菓子図鑑から`);
    });
  const eatWithTicket = (s: Snack) =>
    act(async () => {
      await api.eatWithTicket(s.id);
      playCrunch();
      toast(`🎟 引換券で ${s.icon} ${s.name} を食べました（カロリーは使っていません）`);
    });
  const dropGoal = (s: Snack) =>
    act(async () => {
      await api.setGoalSnack(s.id, false);
      toast(`${s.icon} ${s.name} を目標から外しました（お菓子図鑑には残っています）`);
    });
  const doTask = (t: Task) =>
    act(async () => {
      await api.logTaskDone(t.id);
      playDone();
      toast(`💪 ${iconLabel(t.icon, t.name)} を達成しました（+${t.calories} kcal）。取り消しはお菓子図鑑から`);
    });
  const dropTask = (t: Task) =>
    act(async () => {
      await api.setGoalTask(t.id, false);
      toast(`${iconLabel(t.icon, t.name)} を目標から外しました（課題一覧には残っています）`);
    });

  const countFor = (c: CategoryInfo) => (tier === "mixed" ? c.total : c[tier]);
  const visibleCategories = dash.categories.filter((c) => countFor(c) > 0);
  const totalCount = visibleCategories.reduce((s, c) => s + countFor(c), 0);
  // 英単語 can also be narrowed to a part of speech, and 文法 to a 文法項目 (時制, 接続詞…); the
  // genres come in the row below.
  const partsOfSpeech = tier === "word" ? dash.partsOfSpeech.filter((p) => p.total > 0) : [];
  const grammarPoints = tier === "grammar" ? dash.grammarPoints.filter((p) => p.total > 0) : [];
  // If the selected genre, part of speech or 文法項目 has nothing in this tab, fall back to "all" silently.
  const effectiveCategory =
    visibleCategories.some((c) => c.name === category) ||
    partsOfSpeech.some((p) => posCategory(p.pos) === category) ||
    grammarPoints.some((p) => grammarPointCategory(p.point) === category)
      ? category
      : ALL_CATEGORIES;

  // How many questions each mode has for what is picked; a mode with none cannot be started.
  const modeTotals = useMemo(() => {
    const totals: Record<Mode, number> = { choice: 0, typing: 0, speaking: 0, listening: 0 };
    for (const m of dash.modeCounts) {
      if (tier !== "mixed" && m.tier !== tier) continue;
      if (
        effectiveCategory !== ALL_CATEGORIES &&
        m.category !== effectiveCategory &&
        `pos:${m.pos}` !== effectiveCategory &&
        (!m.grammarPoint || grammarPointCategory(m.grammarPoint) !== effectiveCategory)
      )
        continue;
      for (const mode of MODES) totals[mode.mode] += m[mode.mode];
    }
    return totals;
  }, [dash.modeCounts, tier, effectiveCategory]);

  const redeem = async () => {
    setRedeeming(true);
    try {
      const r = await api.redeemCheatTicket();
      playFanfare();
      toast(`🎫 チートデイ！ +${r.kcalAdded} kcal（今日 ${r.todayKcal} kcal）`);
      onChanged();
    } catch (e) {
      toast(String(e));
    } finally {
      setRedeeming(false);
    }
  };

  return (
    <div className="screen home">
      <section className="card hero">
        {/* The title and the lead on the left; the streak, days and savings on the right of the
            title, and the tickets (when there are any) under them, on the line of the lead. */}
        <div className="hero-top">
          <h1>今日のおやつ予算</h1>
          <p className="muted hero-lead">英語の問題を解くほど、今日食べていいお菓子のカロリーが増えます。</p>
          <div className="hero-badges">
            <div className="badge streak" title="連続学習日数">
              🔥 連続 {user.currentStreak} 日
            </div>
            <div className="badge" title="累計学習日数">
              📅 累計 {user.totalStudyDays} 日
            </div>
            {/* filled under its words as far as the savings have come toward a ticket, like a gauge */}
            <button
              className="badge savings"
              onClick={goToSnacks}
              style={{ "--saved": `${Math.min(100, (savings.balance / savings.perTicket) * 100)}%` } as CSSProperties}
              title={`使わなかったカロリーは翌日に貯蓄され、${savings.perTicket.toLocaleString()} kcal でお菓子引換券1枚になります`}
            >
              🐷 貯蓄 {savings.balance.toLocaleString()} / {savings.perTicket.toLocaleString()} kcal
            </button>
          </div>
          <div className="hero-tickets">
            {savings.snackTickets > 0 && (
              <button
                className={"badge ticket" + (ticketMode ? " active" : "")}
                aria-pressed={ticketMode}
                onClick={() => onTicketMode(!ticketMode)}
                title={
                  ticketMode
                    ? "もう一度押すと「引換券」ボタンを隠します"
                    : "押すと、目標のお菓子とお菓子図鑑に「引換券」ボタンが出ます（カロリーを使わずに食べられます）"
                }
              >
                🎟 お菓子引換券 ×{savings.snackTickets}
              </button>
            )}
            {dash.ticketsAvailable > 0 && (
              <button
                className="badge ticket"
                onClick={redeem}
                disabled={redeeming}
                title={`押すとチケットを1枚使って、今日の獲得カロリーに +${kcalRates.cheatDayBonus} kcal（7日連続で学習するたびに1枚もらえます）`}
              >
                🎫 チートデイチケット ×{dash.ticketsAvailable}
              </button>
            )}
          </div>
        </div>
        <CalorieBar
          earned={today.kcalEarned}
          consumed={today.kcalConsumed}
          carried={today.carriedKcal}
          goals={goalSnacks}
          snacks={dash.snacks}
          eatenToday={eatenToday}
          onEat={busy ? undefined : (s) => void eat(s)}
        />
      </section>

      <section className="card goal">
        <div className="section-head">
          <h2 className="title-with-switch">
            {user.dietMode && (
              <SwitchViewButton label={showTasks ? "目標のお菓子に切り替える" : "目標の課題に切り替える"} onClick={switchGoals} />
            )}
            {showTasks ? "目標の課題" : "目標のお菓子"}
          </h2>
          <div className="goal-head-right">
            {/* today's weight, once a day here or in the 記録 (体重記録のデイリーボーナス) */}
            {showTasks && (
              <WeightForm
                heightCm={user.heightCm ?? null}
                today={dash.weightToday ?? null}
                bonus={kcalRates.weightBonus}
                noHeight="身長を「記録」の体重のグラフで入れると、ここで体重を記録できます"
                onRecorded={onChanged}
                toast={toast}
              />
            )}
            <button className="btn-link" aria-expanded={adding} onClick={() => setAdding((a) => !a)}>
              {adding ? "閉じる" : showTasks ? "＋ 課題追加" : "＋ 目標追加"}
            </button>
          </div>
        </div>
        {showTasks ? (
          <>
            {adding && (
              <GoalAdder
                kind={TASK_GOALS}
                items={dash.tasks}
                goalIds={new Set(goalTasks.map((g) => g.id))}
                onAdded={onChanged}
                onClose={() => setAdding(false)}
                toast={toast}
              />
            )}
            {goalTasks.length > 0 ? (
              <ul className="goal-list">
                {goalTasks.map((t) => {
                  const did = doneToday.includes(t.id);
                  return (
                    <li key={t.id} className={"goal-row task-row" + (did ? " eaten" : "")}>
                      <span className="goal-icon">
                        <ItemIcon icon={t.icon} />
                      </span>
                      <span className="goal-name" title={t.name}>
                        {t.name}
                        <span className="goal-kcal earned">+{t.calories} kcal</span>
                        {did && <span className="pill eaten">✓ 今日やった</span>}
                      </span>
                      <div className="goal-actions">
                        <DoneButton disabled={busy} onClick={() => void doTask(t)} />
                        <DeleteButton label="目標から外す（課題一覧には残ります）" disabled={busy} onClick={() => void dropTask(t)} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              !adding && (
                <p className="muted goal-empty">
                  目標の課題を決めると、ここからすぐ達成を記録できます（💪 を押すとカロリーがもらえます）。「＋ 課題追加」から、いくつでも登録できます。
                </p>
              )
            )}
          </>
        ) : (
          <>
            {ticketMode && (
              <p className="ticket-note">
                🎟 引換券を使うお菓子の「引換券」を押してください。カロリーを使わずに食べられます
                {goalSnacks.length === 0 ? "（目標のお菓子がないので、お菓子図鑑から使えます）" : "（目標にないお菓子はお菓子図鑑から）"}。
              </p>
            )}
            {adding && (
              <GoalAdder
                kind={SNACK_GOALS}
                items={dash.snacks}
                goalIds={new Set(goalSnacks.map((g) => g.id))}
                onAdded={onChanged}
                onClose={() => setAdding(false)}
                toast={toast}
              />
            )}
            {goalSnacks.length > 0 ? (
              <ul className="goal-list">
                {goalSnacks.map((g) => {
                  const remaining = Math.max(0, g.calories - budget);
                  const ate = eatenToday.includes(g.id);
                  const filled = Math.min(100, (Math.max(0, budget) / g.calories) * 100);
                  // One line per goal: the word count leads, the other kinds of question are in the tooltip.
                  const breakdown =
                    `あと ${remaining} kcal（選択問題なら）：英単語 ${need(remaining, kcalRates.wordChoice)} 問、` +
                    `複合語・慣用句 ${need(remaining, kcalRates.phraseChoice)} 問、` +
                    `文法・フレーズ・例文 ${need(remaining, kcalRates.sentenceChoice)} 問`;
                  return (
                    <li key={g.id} className={"goal-row" + (ate ? " eaten" : "") + (remaining === 0 ? " reached" : "")}>
                      <span className="goal-icon">{g.icon}</span>
                      <span className="goal-name" title={g.name}>
                        {g.name}
                        <span className="goal-kcal">{g.calories} kcal</span>
                        {ate && <span className="pill eaten">✓ 今日食べた</span>}
                      </span>
                      <span className="goal-meter" aria-hidden="true">
                        <span style={{ width: `${filled}%` }} />
                      </span>
                      {remaining === 0 ? (
                        <span className="goal-status reached">🎉 食べられます</span>
                      ) : (
                        <span className="goal-status" title={breakdown}>
                          あと <b>{need(remaining, kcalRates.wordChoice)}</b> 問<span className="goal-status-kind">英単語</span>
                        </span>
                      )}
                      <div className="goal-actions">
                        <EatButton affordable={remaining === 0} disabled={busy} onClick={() => void eat(g)} />
                        {ticketMode && (
                          <button
                            className="btn-small ticket"
                            disabled={busy}
                            title="お菓子引換券を1枚使って、カロリーを使わずに食べます"
                            onClick={() => void eatWithTicket(g)}
                          >
                            🎟 引換券
                          </button>
                        )}
                        <DeleteButton label="目標から外す（お菓子図鑑には残ります）" disabled={busy} onClick={() => void dropGoal(g)} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              !adding && (
                <p className="muted goal-empty">
                  目標のお菓子を決めると「あと何問で食べられるか」が表示されます。「＋ 目標追加」から、いくつでも登録できます。
                </p>
              )
            )}
          </>
        )}
      </section>

      <section className="card">
        <div className="section-head">
          <h2>学習をはじめる</h2>
          <div className="segmented">
            {[...TIERS, "mixed" as const].map((t) => (
              <button key={t} className={tier === t ? "active" : ""} onClick={() => setTier(t)}>
                {TIER_LABEL[t]}
              </button>
            ))}
          </div>
        </div>
        <div className="category-main" role="group" aria-label="絞り込み">
          <button
            className={"chip chip-main " + (effectiveCategory === ALL_CATEGORIES ? "active" : "")}
            onClick={() => setCategory(ALL_CATEGORIES)}
          >
            すべて（{totalCount}）
          </button>
          {partsOfSpeech.map((p) => (
            <button
              key={p.pos}
              className={"chip chip-main " + (effectiveCategory === posCategory(p.pos) ? "active" : "")}
              onClick={() => setCategory(posCategory(p.pos))}
            >
              {POS_LABEL[p.pos]}（{p.total}）
            </button>
          ))}
          {grammarPoints.map((p) => (
            <button
              key={p.point}
              className={"chip chip-main " + (effectiveCategory === grammarPointCategory(p.point) ? "active" : "")}
              onClick={() => setCategory(grammarPointCategory(p.point))}
            >
              {p.point}（{p.total}）
            </button>
          ))}
        </div>
        <div className="category-row category-genres" role="group" aria-label="ジャンル">
          {visibleCategories.map((c) => (
            <button
              key={c.name}
              className={"chip " + (effectiveCategory === c.name ? "active" : "")}
              onClick={() => setCategory(c.name)}
            >
              {categoryIcon(c.name)} {c.name}（{countFor(c)}）
            </button>
          ))}
        </div>
        <div className="mode-grid">
          {MODES.map((m) => (
            <button
              key={m.mode}
              className={"mode-card" + (modeTotals[m.mode] === 0 ? " empty" : "")}
              disabled={modeTotals[m.mode] === 0}
              title={modeTotals[m.mode] === 0 ? `この分類・ジャンルには${m.title}がありません` : undefined}
              onClick={() => onStart(m.mode, tier, effectiveCategory)}
            >
              <div className="mode-head">
                <span className="mode-icon">{m.icon}</span>
                <span className="mode-title">{m.title}</span>
                <span className="mode-count">{modeTotals[m.mode].toLocaleString()}問</span>
              </div>
              <div className="mode-desc">
                <span>{m.desc[0]}</span>
                <span>{m.desc[1]}</span>
              </div>
              <div className="mode-cta">10問チャレンジ →</div>
            </button>
          ))}
        </div>
        <div className="review-row">
          <div>
            <strong>🔁 復習</strong>{" "}
            {dash.dueReviewCount > 0 ? (
              <span>
                今日の復習が <b>{dash.dueReviewCount} 問</b> あります。間違えたときと同じ形式で出題され、正解でカロリー{" "}
                <b>×{kcalRates.reviewMultiplier}</b>！
                <span className="muted small review-rule">
                  間違えた復習は正解するまで今日の復習に残り、残った分だけ明日に繰り越します（{kcalRates.staleReviewDays}日を過ぎると通常の出題に戻ります）。
                </span>
              </span>
            ) : (
              <span className="muted">今日の復習はありません。間違えた問題は忘れる前に自動で再出題されます。</span>
            )}
          </div>
          {dash.dueReviewCount > 0 && (
            <button className="btn" onClick={() => onStart("review", "mixed", ALL_CATEGORIES)}>
              復習をはじめる
            </button>
          )}
        </div>
      </section>

      <section className="card exam-card">
        <div className="section-head">
          <h2>📝 試験</h2>
          <span className="muted small">
            TOEIC形式・{dash.exam.questionCount}問・正答率{dash.exam.passPercent}%以上で合格
          </span>
        </div>
        <p className="muted exam-intro">
          応答問題（リスニング）→ 短文穴埋め → 長文穴埋め → 読解問題の順に出題されます。
          <br />
          合格すると難易度に応じたカロリー、不合格でも難易度に応じた挑戦ボーナスがもらえます（何回受けてももらえます）。
        </p>
        <div className="mode-grid exam-grid">
          {dash.exam.levels.map((l) => {
            const best = l.bestCorrect !== null && l.bestTotal ? `${l.bestCorrect} / ${l.bestTotal}` : null;
            return (
              <button key={l.level} className="mode-card exam-level" onClick={() => onExam(l.level)}>
                <div className="mode-head">
                  <span className="mode-title">{l.label}</span>
                  {/* Today's pass only: the mark is gone the next day. */}
                  {l.passedToday && <span className="pill mastered">✓ 合格</span>}
                  {l.suspended && (
                    <span className="pill suspended" title="中断した試験があります。押すと続きから再開するか聞かれます">
                      ⏸ 中断中 {l.suspended.answered}/{l.suspended.total}
                    </span>
                  )}
                </div>
                <div className="mode-desc">
                  <span>{EXAM_DESC[l.level][0]}</span>
                  <span>{EXAM_DESC[l.level][1]}</span>
                </div>
                <div className="exam-level-foot">
                  <span className="exam-reward" title={`不合格でも挑戦ボーナス +${l.effort} kcal`}>
                    合格 +{l.reward} kcal<span className="exam-effort">・不合格 +{l.effort}</span>
                  </span>
                  <span className="muted">{best ? `ベスト ${best}` : "未受験"}</span>
                </div>
                <div className="mode-cta">{dash.exam.questionCount}問に挑戦 →</div>
              </button>
            );
          })}
        </div>
        <div className="review-row">
          <div>
            <strong>🔁 試験の復習</strong>{" "}
            {dash.exam.reviewCount > 0 ? (
              <span>
                試験で間違えた問題が <b>{dash.exam.reviewCount} 問</b> あります。正解すると1問 <b>+{dash.exam.reviewKcal} kcal</b>、復習から外れます。
              </span>
            ) : (
              <span className="muted">試験で間違えた問題は、ここから復習できます（「学習をはじめる」の復習とは別です）。</span>
            )}
          </div>
          {dash.exam.reviewCount > 0 && (
            <button className="btn" onClick={onExamReview}>
              復習をはじめる
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
