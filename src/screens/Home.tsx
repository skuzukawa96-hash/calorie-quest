import { useState } from "react";
import CalorieBar from "../components/CalorieBar";
import { api } from "../lib/api";
import { playFanfare } from "../lib/sfx";
import {
  ALL_CATEGORIES,
  categoryIcon,
  DIFFICULTY_LABEL,
  type Dashboard,
  type Difficulty,
  type Mode,
} from "../types";

interface Props {
  dash: Dashboard;
  onStart: (mode: Mode, difficulty: Difficulty, category: string) => void;
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
  const { today, user, goalSnack, kcalRates, savings } = dash;

  const remaining = goalSnack ? Math.max(0, goalSnack.calories - today.kcalEarned) : 0;
  const need = (rate: number) => Math.ceil(remaining / rate);

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
        <CalorieBar earned={today.kcalEarned} consumed={today.kcalConsumed} goal={goalSnack} snacks={dash.snacks} />
      </section>

      <section className="card goal">
        {goalSnack ? (
          <>
            <div className="goal-head">
              <span className="goal-icon">{goalSnack.icon}</span>
              <div>
                <div className="label">目標のお菓子</div>
                <div className="goal-name">
                  {goalSnack.name} <span className="muted">{goalSnack.calories} kcal</span>
                </div>
              </div>
              <button className="btn-link" onClick={goToSnacks}>
                変更
              </button>
            </div>
            {remaining === 0 ? (
              <div className="goal-reached">🎉 もう食べられます！お疲れさま！</div>
            ) : (
              <div className="need-grid">
                <div className="need">
                  <div className="need-num">あと {need(kcalRates.low)} 問</div>
                  <div className="muted">英単語（{kcalRates.low} kcal/問）</div>
                </div>
                <div className="need">
                  <div className="need-num">あと {need(kcalRates.mid)} 問</div>
                  <div className="muted">フレーズ・文法（{kcalRates.mid} kcal/問）</div>
                </div>
                <div className="need">
                  <div className="need-num">あと {need(kcalRates.high)} 問</div>
                  <div className="muted">慣用句・長文（{kcalRates.high} kcal/問）</div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="goal-empty">
            <div>
              <div className="goal-name">目標のお菓子を決めよう</div>
              <div className="muted">「あと何問で食べられるか」が表示されるようになります。</div>
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
                今日の復習が <b>{dash.dueReviewCount} 問</b> あります。復習問題は正解でカロリー <b>×{kcalRates.reviewMultiplier}</b>！
              </span>
            ) : (
              <span className="muted">今日の復習はありません。間違えた問題は忘れる前に自動で再出題されます。</span>
            )}
          </div>
          {dash.dueReviewCount > 0 && (
            <button className="btn" onClick={() => onStart("choice", "mixed", ALL_CATEGORIES)}>
              復習をはじめる
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
