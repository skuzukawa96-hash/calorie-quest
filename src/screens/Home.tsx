import { useState } from "react";
import CalorieBar from "../components/CalorieBar";
import { api } from "../lib/api";
import { playCrunch, playFanfare } from "../lib/sfx";
import {
  ALL_CATEGORIES,
  categoryIcon,
  DIFFICULTY_LABEL,
  type Dashboard,
  type Difficulty,
  type Mode,
  type SessionMode,
  type Snack,
} from "../types";

interface Props {
  dash: Dashboard;
  onStart: (mode: SessionMode, difficulty: Difficulty, category: string) => void;
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
  const [difficulty, setDifficulty] = useState<Difficulty>("low");
  const [category, setCategory] = useState<string>(ALL_CATEGORIES);
  const [redeeming, setRedeeming] = useState(false);
  const [busy, setBusy] = useState(false);
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

  const countFor = (c: { total: number; low: number; mid: number; high: number }) =>
    difficulty === "mixed" ? c.total : c[difficulty];
  const visibleCategories = dash.categories.filter((c) => countFor(c) > 0);
  const totalCount = visibleCategories.reduce((s, c) => s + countFor(c), 0);
  // If the selected genre has nothing at this difficulty, fall back to "all" silently.
  const effectiveCategory = visibleCategories.some((c) => c.name === category) ? category : ALL_CATEGORIES;

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
        {goalSnacks.length > 0 ? (
          <>
            <div className="section-head">
              <h2>目標のお菓子</h2>
              <button className="btn-link" onClick={goToSnacks}>
                ＋ 図鑑から追加
              </button>
            </div>
            <ul className="goal-list">
              {goalSnacks.map((g) => {
                const remaining = Math.max(0, g.calories - budget);
                const ate = eatenToday.includes(g.id);
                return (
                  <li key={g.id} className={"goal-row" + (ate ? " eaten" : "")}>
                    <span className="goal-icon">{g.icon}</span>
                    <div className="goal-main">
                      <div className="goal-name">
                        {g.name} <span className="muted">{g.calories} kcal</span>
                        {ate && <span className="pill eaten">✓ 今日食べた</span>}
                      </div>
                      {remaining === 0 ? (
                        <div className="goal-reached">🎉 もう食べられます！</div>
                      ) : (
                        <div className="goal-need">
                          あと <b>{need(remaining, kcalRates.low)}</b> 問（英単語）・<b>{need(remaining, kcalRates.mid)}</b> 問（フレーズ・文法）・
                          <b>{need(remaining, kcalRates.high)}</b> 問（慣用句・長文）
                        </div>
                      )}
                    </div>
                    <div className="goal-actions">
                      <button
                        className={"btn-small eat " + (remaining === 0 ? "" : "over")}
                        disabled={busy}
                        title={remaining === 0 ? "今日の残りカロリーで食べられます" : "今日の残りを超えます（記録は可能）"}
                        onClick={() => void eat(g)}
                      >
                        食べた！
                      </button>
                      <button className="btn-link danger" disabled={busy} title="目標から外します（お菓子図鑑には残ります）" onClick={() => void dropGoal(g)}>
                        削除
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <div className="goal-empty">
            <div>
              <div className="goal-name">目標のお菓子を決めよう</div>
              <div className="muted">「あと何問で食べられるか」が表示されるようになります。いくつでも登録できます。</div>
            </div>
            <button className="btn btn-primary" onClick={goToSnacks}>
              お菓子図鑑を開く
            </button>
          </div>
        )}
      </section>

      <section className="card">
        <div className="section-head">
          <h2>学習をはじめる</h2>
          <div className="segmented">
            {(["low", "mid", "high", "mixed"] as Difficulty[]).map((d) => (
              <button key={d} className={difficulty === d ? "active" : ""} onClick={() => setDifficulty(d)}>
                {DIFFICULTY_LABEL[d]}
              </button>
            ))}
          </div>
        </div>
        <div className="category-row" role="group" aria-label="ジャンル">
          <button
            className={"chip " + (effectiveCategory === ALL_CATEGORIES ? "active" : "")}
            onClick={() => setCategory(ALL_CATEGORIES)}
          >
            📚 すべて（{totalCount}）
          </button>
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
            <button key={m.mode} className="mode-card" onClick={() => onStart(m.mode, difficulty, effectiveCategory)}>
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
