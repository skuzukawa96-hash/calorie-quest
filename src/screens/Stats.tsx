import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import {
  TIER_LABEL,
  TIERS,
  type DayPoint,
  type Mode,
  type StatCell,
  type Stats as StatsData,
} from "../types";

/** The totals that open a breakdown by tab and mode when clicked. */
type Metric = "kcal" | "answered" | "accuracy";
const METRIC_TITLE: Record<Metric, string> = {
  kcal: "分類・形式別の獲得カロリー",
  answered: "分類・形式別の回答数",
  accuracy: "分類・形式別の正答率",
};
const MODES: Mode[] = ["choice", "typing", "speaking", "listening"];
const MODE_SHORT: Record<Mode, string> = { choice: "選択", typing: "記入", speaking: "発音", listening: "ヒアリング" };

interface Props {
  onChanged: () => void;
  toast: (msg: string) => void;
}

export default function Stats({ onChanged, toast }: Props) {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  /** the breakdown on show, or none; clicking its total again closes it */
  const [metric, setMetric] = useState<Metric | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    api
      .getStats()
      .then(setStats)
      .catch((e) => setLoadError(String(e)));
  }, []);

  useEffect(load, [load]);

  // A failed load used to leave "集計しています…" on screen for good, with the reason gone
  // after a three-second toast.
  if (loadError && !stats) {
    return (
      <div className="screen">
        <div className="card">
          <p>記録を読み込めませんでした: {loadError}</p>
          <button className="btn" onClick={load}>
            再試行
          </button>
        </div>
      </div>
    );
  }
  if (!stats) {
    return (
      <div className="screen">
        <div className="card loading">集計しています…</div>
      </div>
    );
  }

  const toggle = (m: Metric) => setMetric((cur) => (cur === m ? null : m));
  // Per day studied: the days without study are left out of what the totals are divided by.
  const perStudyDay = (total: number) =>
    stats.totalStudyDays > 0 ? `${Math.round(total / stats.totalStudyDays)} kcal` : "—";

  return (
    <div className="screen stats">
      <section className="card">
        <h2>学習記録</h2>
        <div className="stat-grid stat-grid-4">
          <Stat label="累計学習日数" value={`${stats.totalStudyDays} 日`} />
          <Stat
            label="連続学習（最長）"
            value={
              <>
                🔥 {stats.currentStreak} 日<span className="stat-sub">（最長 {stats.longestStreak} 日）</span>
              </>
            }
          />
          <Stat
            label="平均獲得カロリー"
            value={perStudyDay(stats.totalKcal)}
            title="累計獲得カロリー ÷ 学習した日数（学習していない日は数えません）"
          />
          <Stat
            label="平均消費カロリー"
            value={perStudyDay(stats.totalConsumed)}
            title="食べたお菓子の累計カロリー ÷ 学習した日数（学習していない日は数えません）"
          />
        </div>
        <div className="stat-grid">
          <Stat label="累計獲得カロリー" value={`${stats.totalKcal} kcal`} open={metric === "kcal"} onClick={() => toggle("kcal")} />
          <Stat label="累計回答数" value={`${stats.totalAnswered} 問`} open={metric === "answered"} onClick={() => toggle("answered")} />
          <Stat
            label="正答率"
            value={`${Math.round(stats.accuracy * 100)}%`}
            open={metric === "accuracy"}
            onClick={() => toggle("accuracy")}
          />
        </div>
      </section>

      {metric && (
        <section className="card breakdown">
          <div className="section-head">
            <h2>{METRIC_TITLE[metric]}</h2>
            <button className="btn-link" onClick={() => setMetric(null)}>
              閉じる
            </button>
          </div>
          <Breakdown metric={metric} cells={stats.breakdown} />
          <p className="muted small">
            学習の問題（英単語〜例文）の分で、獲得カロリーは がんばり・お気軽 にかかわらず通常モードの値です。レシピ・試験・チートデイの分は、上の累計にだけ入ります。
          </p>
        </section>
      )}

      <section className="card">
        <h2>この2週間の獲得・消費カロリー</h2>
        <KcalLineChart days={stats.last14Days} />
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
                <th>分類</th>
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
                  <td>{TIER_LABEL[w.question.tier] ?? ""}</td>
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
            <span>学習履歴・カロリー・貯蓄・ストリーク・チケット・引換券を消去します（お菓子図鑑・レシピ・お気に入りは残ります）。</span>
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

/** A total; with `onClick` it is a button that opens and closes its breakdown. */
function Stat({
  label,
  value,
  title,
  open,
  onClick,
}: {
  label: string;
  value: ReactNode;
  /** how it is counted, on hover */
  title?: string;
  open?: boolean;
  onClick?: () => void;
}) {
  if (!onClick) {
    return (
      <div className="stat" title={title}>
        <div className="stat-value">{value}</div>
        <div className="muted">{label}</div>
      </div>
    );
  }
  return (
    <button
      type="button"
      className={"stat stat-toggle" + (open ? " open" : "")}
      aria-expanded={open}
      title={open ? "もう一度押すと閉じます" : "押すと分類・形式別に見られます"}
      onClick={onClick}
    >
      <div className="stat-value">{value}</div>
      <div className="muted">
        {label} <span className="stat-caret">{open ? "▾" : "▸"}</span>
      </div>
    </button>
  );
}

/** One metric over the study answers of some cells: kcal earned, answers, or the share right. */
function metricText(metric: Metric, cells: StatCell[]): string {
  const kcal = cells.reduce((s, c) => s + c.kcal, 0);
  const answered = cells.reduce((s, c) => s + c.answered, 0);
  const correct = cells.reduce((s, c) => s + c.correct, 0);
  if (metric === "kcal") return String(kcal);
  if (metric === "answered") return String(answered);
  return answered > 0 ? `${Math.round((correct / answered) * 100)}%` : "—";
}

/**
 * The tabs (英単語 … 例文) down, the modes (選択 / 記入 / 発音 / ヒアリング) across, and totals for
 * each, in one metric. A tab and mode never answered shows "—" for 正答率 and 0 otherwise.
 */
function Breakdown({ metric, cells }: { metric: Metric; cells: StatCell[] }) {
  const pick = (tier: string | null, mode: Mode | null) =>
    cells.filter((c) => (tier === null || c.tier === tier) && (mode === null || c.mode === mode));
  const unit = metric === "kcal" ? " kcal" : metric === "answered" ? " 問" : "";
  const cell = (list: StatCell[]) => {
    const text = metricText(metric, list);
    return text === "—" ? text : `${text}${unit}`;
  };
  return (
    <div className="breakdown-scroll">
      <table className="breakdown-table">
        <thead>
          <tr>
            <th>分類</th>
            {MODES.map((m) => (
              <th key={m}>{MODE_SHORT[m]}</th>
            ))}
            <th>合計</th>
          </tr>
        </thead>
        <tbody>
          {TIERS.map((t) => (
            <tr key={t}>
              <th>{TIER_LABEL[t]}</th>
              {MODES.map((m) => (
                <td key={m} className={pick(t, m).length ? "" : "empty"}>
                  {cell(pick(t, m))}
                </td>
              ))}
              <td className="total">{cell(pick(t, null))}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th>合計</th>
            {MODES.map((m) => (
              <td key={m} className="total">
                {cell(pick(null, m))}
              </td>
            ))}
            <td className="total grand">{cell(cells)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/**
 * Round steps for an axis from `min` to `max`, so it starts and ends on a tick: 40〜120 kcal by 20.
 * A flat fortnight still gets an axis around its value (0 kcal: 0〜10).
 */
function axis(min: number, max: number): { lo: number; hi: number; step: number } {
  if (max <= 0) return { lo: 0, hi: 10, step: 5 };
  const span = max > min ? max - min : max;
  const rough = span / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = Math.max(1, (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag);
  let lo = Math.floor(min / step) * step;
  let hi = Math.ceil(max / step) * step;
  // A flat fortnight: a step either side of its value.
  if (hi === lo) {
    lo = Math.max(0, lo - step);
    hi += step;
  }
  return { lo, hi, step };
}

/** One line of the chart: a day's value, its name, and the class that colours it. */
interface Series {
  key: "earned" | "consumed";
  label: string;
  value: (d: DayPoint) => number;
}
const SERIES: Series[] = [
  { key: "earned", label: "獲得", value: (d) => d.kcalEarned },
  { key: "consumed", label: "消費", value: (d) => d.kcalConsumed },
];

/**
 * The fortnight's kcal earned (after the play mode, as each day had it) and eaten, as two lines on
 * one axis of round numbers from the lowest day to the highest of either (not always from 0), each
 * line's highest and lowest days named in the legend.
 */
function KcalLineChart({ days }: { days: DayPoint[] }) {
  const all = days.flatMap((d) => SERIES.map((s) => s.value(d)));
  const { lo, hi, step } = axis(Math.min(...all), Math.max(...all));
  const W = 700;
  const H = 240;
  const left = 52;
  const right = 16;
  const top = 16;
  const bottom = 32;
  const x = (i: number) => left + (i * (W - left - right)) / Math.max(1, days.length - 1);
  const y = (v: number) => top + (H - top - bottom) * (1 - (v - lo) / (hi - lo));
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 1000; v += step) ticks.push(Math.round(v * 100) / 100);
  const day = (date: string) => date.slice(5).replace("-", "/");
  const lines = SERIES.map((s) => {
    const values = days.map(s.value);
    const max = Math.max(...values);
    const min = Math.min(...values);
    const path = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    return {
      ...s,
      values,
      max,
      min,
      maxDay: days[values.lastIndexOf(max)],
      minDay: days[values.lastIndexOf(min)],
      path,
    };
  });
  const earned = lines[0];
  const area = `${earned.path} L${x(days.length - 1).toFixed(1)},${y(lo).toFixed(1)} L${x(0).toFixed(1)},${y(lo).toFixed(1)} Z`;
  return (
    <div className="line-chart">
      <div className="muted small line-chart-legend">
        {lines.map((l) => (
          <span key={l.key} className={`lc-key ${l.key}`}>
            <i className="lc-swatch" />
            {l.label} 最大 <b>{l.max}</b> kcal（{day(l.maxDay.date)}）・最小 <b>{l.min}</b> kcal（{day(l.minDay.date)}）
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="この2週間の獲得カロリーと消費カロリーの折れ線グラフ">
        {ticks.map((t) => (
          <g key={t}>
            <line className="lc-grid" x1={left} x2={W - right} y1={y(t)} y2={y(t)} />
            <text className="lc-axis" x={left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle">
              {t}
            </text>
          </g>
        ))}
        <text className="lc-unit" x={left - 8} y={top - 6} textAnchor="end">
          kcal
        </text>
        <path className="lc-area" d={area} />
        {lines.map((l) => (
          <path key={l.key} className={`lc-line ${l.key}`} d={l.path} />
        ))}
        {lines.map((l) =>
          days.map((d, i) => {
            const top = l.values[i] === l.max && l.max > l.min;
            return (
              <circle key={`${l.key}-${d.date}`} className={`lc-dot ${l.key}` + (top ? " max" : "")} cx={x(i)} cy={y(l.values[i])} r={top ? 5 : 4}>
                <title>{`${d.date}: 獲得 ${d.kcalEarned} kcal / 消費 ${d.kcalConsumed} kcal / ${d.answered} 問`}</title>
              </circle>
            );
          }),
        )}
        {days.map((d, i) => (
          <text key={d.date} className="lc-axis" x={x(i)} y={H - 10} textAnchor="middle">
            {day(d.date)}
          </text>
        ))}
      </svg>
    </div>
  );
}
