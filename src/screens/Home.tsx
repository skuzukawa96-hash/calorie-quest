import { useState } from "react";
import CalorieBar from "../components/CalorieBar";
import GoalAdder from "../components/GoalAdder";
import { DeleteButton, EatButton } from "../components/IconButtons";
import { api } from "../lib/api";
import { playCrunch, playFanfare } from "../lib/sfx";
import {
  ALL_CATEGORIES,
  categoryIcon,
  POS_LABEL,
  posCategory,
  TIER_LABEL,
  TIERS,
  type CategoryInfo,
  type Dashboard,
  type TierChoice,
  type Mode,
  type SessionMode,
  type Snack,
} from "../types";

interface Props {
  dash: Dashboard;
  onStart: (mode: SessionMode, tier: TierChoice, category: string) => void;
  onChanged: () => void;
  goToSnacks: () => void;
  toast: (msg: string) => void;
}

const MODES: Array<{ mode: Mode; icon: string; title: string; desc: string }> = [
  { mode: "choice", icon: "🍪", title: "選択問題", desc: "4択でテンポよく。単語の意味や文法の穴埋め。" },
  { mode: "typing", icon: "🍫", title: "記入問題", desc: "日本語に合う英語をタイピング。スペルを定着。" },
  { mode: "speaking", icon: "🎤", title: "発音問題", desc: "お手本を聞いてリピート。音声認識でスコア判定。" },
  { mode: "listening", icon: "👂", title: "ヒアリング問題", desc: "英語を聞いて意味を当てる。会話には英語で応答。" },
];

export default function Home({ dash, onStart, onChanged, goToSnacks, toast }: Props) {
  const [tier, setTier] = useState<TierChoice>("word");
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  const [redeeming, setRedeeming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const { today, user, goalSnacks, eatenToday, kcalRates, savings } = dash;

  // What is still left to spend today; a goal is within reach once it fits in there.
  const budget = today.kcalEarned - today.kcalConsumed;
  const need = (remaining: number, rate: number) => Math.ceil(remaining / rate);

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
  const dropGoal = (s: Snack) =>
    act(async () => {
      await api.setGoalSnack(s.id, false);
      toast(`${s.icon} ${s.name} を目標から外しました（お菓子図鑑には残っています）`);
    });

  const countFor = (c: CategoryInfo) => (tier === "mixed" ? c.total : c[tier]);
  const visibleCategories = dash.categories.filter((c) => countFor(c) > 0);
  const totalCount = visibleCategories.reduce((s, c) => s + countFor(c), 0);
  // 英単語 can also be narrowed to a part of speech; the genres come in the row below.
  const partsOfSpeech = tier === "word" ? dash.partsOfSpeech.filter((p) => p.total > 0) : [];
  // If the selected genre or part of speech has nothing in this tab, fall back to "all" silently.
  const effectiveCategory =
    visibleCategories.some((c) => c.name === category) || partsOfSpeech.some((p) => posCategory(p.pos) === category)
      ? category
      : ALL_CATEGORIES;

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
        <div className="hero-top">
          <div>
            <h1>今日のおやつ予算</h1>
            <p className="muted">
              英語の問題を解くほど、今日食べていいお菓子のカロリーが増えます。
            </p>
          </div>
          <div className="hero-badges">
            <div className="badge streak" title="連続学習日数">
              🔥 連続 {user.currentStreak} 日
            </div>
            <div className="badge" title="累計学習日数">
              📅 累計 {user.totalStudyDays} 日
            </div>
            <button
              className="badge savings"
              onClick={goToSnacks}
              title={`使わなかったカロリーは翌日に貯蓄され、${savings.perTicket.toLocaleString()} kcal でお菓子引換券1枚になります`}
            >
              🐷 貯蓄 {savings.balance.toLocaleString()} / {savings.perTicket.toLocaleString()} kcal
            </button>
            {savings.snackTickets > 0 && (
              <button className="badge ticket" onClick={goToSnacks} title="お菓子図鑑で、好きなお菓子をカロリーを使わずに食べられます">
                🎟 お菓子引換券 ×{savings.snackTickets}
              </button>
            )}
            {dash.ticketsAvailable > 0 && (
              <button className="badge ticket" onClick={redeem} disabled={redeeming}>
                🎫 チートデイチケット ×{dash.ticketsAvailable}（+{kcalRates.cheatDayBonus} kcal で使う）
              </button>
            )}
          </div>
        </div>
        <CalorieBar
          earned={today.kcalEarned}
          consumed={today.kcalConsumed}
          goals={goalSnacks}
          snacks={dash.snacks}
          eatenToday={eatenToday}
          onEat={busy ? undefined : (s) => void eat(s)}
        />
      </section>

      <section className="card goal">
        <div className="section-head">
          <h2>目標のお菓子</h2>
          <button className="btn-link" aria-expanded={adding} onClick={() => setAdding((a) => !a)}>
            {adding ? "閉じる" : "＋ 目標追加"}
          </button>
        </div>
        {adding && (
          <GoalAdder
            snacks={dash.snacks}
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
                `あと ${remaining} kcal：英単語なら ${need(remaining, kcalRates.low)} 問、` +
                `文法・慣用句・フレーズ・例文の選択問題なら ${need(remaining, kcalRates.choice)} 問`;
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
                      あと <b>{need(remaining, kcalRates.low)}</b> 問<span className="goal-status-kind">英単語</span>
                    </span>
                  )}
                  <div className="goal-actions">
                    <EatButton affordable={remaining === 0} disabled={busy} onClick={() => void eat(g)} />
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
            <button key={m.mode} className="mode-card" onClick={() => onStart(m.mode, tier, effectiveCategory)}>
              <div className="mode-icon">{m.icon}</div>
              <div className="mode-title">{m.title}</div>
              <div className="muted">{m.desc}</div>
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
    </div>
  );
}
