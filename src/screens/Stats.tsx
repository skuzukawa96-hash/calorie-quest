import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { LEVEL_SHORT, type Stats as StatsData } from "../types";

interface Props {
  onChanged: () => void;
  toast: (msg: string) => void;
}

export default function Stats({ onChanged, toast }: Props) {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(() => {
    api.getStats().then(setStats).catch((e) => toast(String(e)));
  }, [toast]);

  useEffect(load, [load]);

  if (!stats) {
    return (
      <div className="screen">
        <div className="card loading">集計しています…</div>
      </div>
    );
  }

  const maxKcal = Math.max(100, ...stats.last14Days.map((d) => d.kcalEarned));

  return (
    <div className="screen stats">
      <section className="card">
        <h2>学習記録</h2>
        <div className="stat-grid">
          <Stat label="累計学習日数" value={`${stats.totalStudyDays} 日`} />
          <Stat label="連続学習" value={`🔥 ${stats.currentStreak} 日`} />
          <Stat label="最長ストリーク" value={`${stats.longestStreak} 日`} />
          <Stat label="累計獲得カロリー" value={`${stats.totalKcal} kcal`} />
          <Stat label="累計回答数" value={`${stats.totalAnswered} 問`} />
          <Stat label="正答率" value={`${Math.round(stats.accuracy * 100)}%`} />
        </div>
      </section>

      <section className="card">
        <h2>この2週間の獲得カロリー</h2>
        <div className="chart">
          {stats.last14Days.map((d) => (
            <div key={d.date} className="chart-col" title={`${d.date}: ${d.kcalEarned} kcal / ${d.answered} 問`}>
              <div className="chart-bar-wrap">
                <div className="chart-bar" style={{ height: `${(d.kcalEarned / maxKcal) * 100}%` }} />
              </div>
              <div className="chart-label">{d.date.slice(5).replace("-", "/")}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="section-head">
          <h2>復習キュー</h2>
          <div className="muted">
            今日出題: <b>{stats.reviewDue}</b> 問 / 復習待ち合計: <b>{stats.reviewPending}</b> 問
          </div>
        </div>
        {stats.weakQuestions.length === 0 ? (
          <div className="muted">苦手な問題はまだありません。間違えた問題や発音スコアが低かった問題がここに並びます。</div>
        ) : (
          <table className="weak-table">
            <thead>
              <tr>
                <th>問題</th>
                <th>難易度</th>
                <th>間違い</th>
                <th>発音スコア</th>
                <th>次の出題</th>
                <th>段階</th>
              </tr>
            </thead>
            <tbody>
              {stats.weakQuestions.map((w) => (
                <tr key={w.question.id}>
                  <td>
                    <div>{w.question.en}</div>
                    <div className="muted small">{w.question.ja}</div>
                  </td>
                  <td>{LEVEL_SHORT[w.question.difficulty]}</td>
                  <td>{w.wrongCount} 回</td>
                  <td>{w.lastScore != null ? Math.round(w.lastScore) : "—"}</td>
                  <td>{w.nextDue ?? "卒業"}</td>
                  <td>{w.srsLevel} / 5</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>チートデイチケット</h2>
        <p className="muted">7日連続で学習するたびに発行。ホームで使うと無条件で +300 kcal。</p>
        {stats.tickets.length === 0 ? (
          <div className="muted">まだチケットはありません。連続 {7 - (stats.currentStreak % 7)} 日で次のチケット！</div>
        ) : (
          <ul className="ticket-list">
            {stats.tickets.map((t) => (
              <li key={t.id} className={t.usedAt ? "used" : ""}>
                🎫 {t.issuedForStreak} 日連続達成（{t.issuedAt.slice(0, 10)}） {t.usedAt ? `— 使用済み ${t.usedAt.slice(0, 10)}` : "— 未使用"}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card danger-zone">
        <h2>データ</h2>
        {!confirmReset ? (
          <button className="btn btn-ghost" onClick={() => setConfirmReset(true)}>
            学習記録をリセット…
          </button>
        ) : (
          <div className="row">
            <span>学習履歴・カロリー・ストリーク・チケットを消去します（お菓子図鑑は残ります）。</span>
            <button
              className="btn btn-danger"
              onClick={() => {
                api
                  .resetProgress()
                  .then(() => {
                    toast("学習記録をリセットしました");
                    setConfirmReset(false);
                    load();
                    onChanged();
                  })
                  .catch((e) => toast(String(e)));
              }}
            >
              本当にリセットする
            </button>
            <button className="btn" onClick={() => setConfirmReset(false)}>
              やめる
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="muted">{label}</div>
    </div>
  );
}
