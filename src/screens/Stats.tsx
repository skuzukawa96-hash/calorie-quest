import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
        <div className="stat-grid stat-grid-5">
          <Stat label="累計学習日数" value={`${stats.totalStudyDays} 日`} />
          <Stat label="連続学習" value={`🔥 ${stats.currentStreak} 日`} />
          <Stat label="最長ストリーク" value={`${stats.longestStreak} 日`} />
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

const f1 = (n: number) => n.toFixed(1);

/**
 * A smooth line through the points that never overshoots them (a monotone cubic, Fritsch–Carlson):
 * a day of 0 kcal stays on 0 and a peak stays the peak.
 */
function smoothPath(points: [number, number][]): string {
  const n = points.length;
  if (n === 0) return "";
  const start = `M${f1(points[0][0])},${f1(points[0][1])}`;
  if (n === 1) return start;
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i + 1][0] - points[i][0]);
    slope.push((points[i + 1][1] - points[i][1]) / dx[i]);
  }
  const m = [slope[0]];
  for (let i = 1; i < n - 1; i++) m.push(slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2);
  m.push(slope[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / slope[i];
    const b = m[i + 1] / slope[i];
    const h = a * a + b * b;
    if (h > 9) {
      const t = 3 / Math.sqrt(h);
      m[i] = t * a * slope[i];
      m[i + 1] = t * b * slope[i];
    }
  }
  let d = start;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    const h = dx[i] / 3;
    d += ` C${f1(x0 + h)},${f1(y0 + m[i] * h)} ${f1(x1 - h)},${f1(y1 - m[i + 1] * h)} ${f1(x1)},${f1(y1)}`;
  }
  return d;
}

/**
 * The fortnight's kcal earned (after the play mode, as each day had it, in green) and eaten (in
 * red), as two smooth lines on one axis of round numbers from the lowest day to the highest of
 * either (not always from 0), each line's highest and lowest days named in the legend. Clicking a
 * 消費 dot opens, from the dot, what was eaten that day.
 */
function KcalLineChart({ days }: { days: DayPoint[] }) {
  /** the day whose snacks are open, from its 消費 dot */
  const [open, setOpen] = useState<number | null>(null);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open === null) return;
    // Anywhere but the window or another 消費 dot closes it; so does Escape.
    const away = (e: MouseEvent) => {
      const t = e.target as Element;
      if (!pop.current?.contains(t) && !t.closest?.(".lc-hit")) setOpen(null);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

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
    const path = smoothPath(values.map((v, i) => [x(i), y(v)]));
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
  const area = `${earned.path} L${f1(x(days.length - 1))},${f1(y(lo))} L${f1(x(0))},${f1(y(lo))} Z`;
  const toggle = (i: number) => setOpen((cur) => (cur === i ? null : i));
  const shown = open === null ? null : days[open];
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
      <div className="lc-plot">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="この2週間の獲得カロリーと消費カロリーの折れ線グラフ">
        <defs>
          <linearGradient id="lc-earned-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="lc-fill-top" />
            <stop offset="100%" className="lc-fill-bottom" />
          </linearGradient>
        </defs>
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
            // The highest day is filled in, at the same size as the others.
            const top = l.values[i] === l.max && l.max > l.min;
            const cls = `lc-dot ${l.key}` + (top ? " max" : "") + (l.key === "consumed" && open === i ? " open" : "");
            if (l.key === "earned") {
              return (
                <circle key={`${l.key}-${d.date}`} className={cls} cx={x(i)} cy={y(l.values[i])} r={3.5}>
                  <title>{`${day(d.date)} 獲得 ${d.kcalEarned} kcal（${d.answered} 問）`}</title>
                </circle>
              );
            }
            return (
              <g
                key={`${l.key}-${d.date}`}
                className="lc-point"
                role="button"
                tabIndex={0}
                aria-label={`${day(d.date)} に食べたお菓子`}
                aria-expanded={open === i}
                onClick={() => toggle(i)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggle(i);
                  }
                }}
              >
                <circle className={cls} cx={x(i)} cy={y(l.values[i])} r={3.5} />
                {/* a larger, invisible target, so a small dot is easy to click */}
                <circle className="lc-hit" cx={x(i)} cy={y(l.values[i])} r={11}>
                  <title>{`${day(d.date)} 消費 ${d.kcalConsumed} kcal（クリックで食べたお菓子）`}</title>
                </circle>
              </g>
            );
          }),
        )}
        {days.map((d, i) => (
          <text key={d.date} className="lc-axis" x={x(i)} y={H - 10} textAnchor="middle">
            {day(d.date)}
          </text>
        ))}
      </svg>
      {shown && open !== null && (
        <EatenPopover
          refEl={pop}
          day={shown}
          label={day(shown.date)}
          left={x(open) / W}
          top={y(shown.kcalConsumed) / H}
          onClose={() => setOpen(null)}
        />
      )}
      </div>
    </div>
  );
}

/**
 * What was eaten on a day, opening from its 消費 dot: a snack a line (icon, name, how many, the
 * kcal in all), the most kcal first. A snack eaten with a お菓子引換券 cost no kcal of the day, and
 * says so. Opens above the dot, or below it when the dot is high; at either end of the chart it
 * leans inwards.
 */
function EatenPopover({
  refEl,
  day,
  label,
  left,
  top,
  onClose,
}: {
  refEl: React.RefObject<HTMLDivElement | null>;
  day: DayPoint;
  label: string;
  /** where the dot is, as a share of the chart's width and height */
  left: number;
  top: number;
  onClose: () => void;
}) {
  const side = top < 0.45 ? "below" : "above";
  const lean = left < 0.2 ? "lean-right" : left > 0.8 ? "lean-left" : "";
  return (
    <div className="lc-pop-anchor" style={{ left: `${left * 100}%`, top: `${top * 100}%` }}>
      <div ref={refEl} className={`lc-pop ${side} ${lean}`} role="dialog" aria-label={`${label} に食べたお菓子`}>
        <div className="lc-pop-head">
          <span>
            <b>{label}</b> に食べたお菓子
          </span>
          <span className="lc-pop-total">{day.kcalConsumed} kcal</span>
          <button type="button" className="lc-pop-close" onClick={onClose} aria-label="閉じる" title="閉じる">
            ×
          </button>
        </div>
        {day.eaten.length === 0 ? (
          <div className="muted small lc-pop-empty">食べたお菓子はありません</div>
        ) : (
          <ul className="lc-pop-list">
            {day.eaten.map((e) => (
              <li key={`${e.icon}|${e.name}|${e.withTicket}`} className={e.withTicket ? "ticket" : ""}>
                <span className="lc-pop-icon">{e.icon}</span>
                <span className="lc-pop-name">{e.name}</span>
                <span className="lc-pop-count">×{e.count}</span>
                <span className="lc-pop-kcal">{e.withTicket ? "🎟 引換券" : `${e.kcal} kcal`}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
