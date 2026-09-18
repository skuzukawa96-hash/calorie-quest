import type { Snack } from "../types";

interface Props {
  earned: number;
  consumed: number;
  goal: Snack | null | undefined;
  snacks: Snack[];
}

/** Today's calorie progress with snack icons as milestones along the bar. */
export default function CalorieBar({ earned, consumed, goal, snacks }: Props) {
  const max = goal ? goal.calories : Math.max(250, Math.ceil((earned + 1) / 100) * 100);
  const pct = Math.min(100, (earned / max) * 100);

  // Unique-calorie built-in snacks that fit on the bar, at most 5 so the icons don't overlap.
  const seen = new Set<number>();
  const milestones = snacks
    .filter((s) => s.isBuiltin && s.calories <= max && s.calories > 0)
    .filter((s) => (seen.has(s.calories) ? false : (seen.add(s.calories), true)))
    .sort((a, b) => a.calories - b.calories);
  // Keep icons at least 9% of the bar apart so neighbours (e.g. 230 and 250 kcal) don't overlap.
  const shown: Snack[] = [];
  let lastPct = -100;
  for (const s of milestones) {
    const pct = (s.calories / max) * 100;
    if (pct - lastPct >= 9 && (!goal || pct <= 91)) {
      shown.push(s);
      lastPct = pct;
    }
  }

  const representative = snacks
    .filter((s) => s.calories <= earned)
    .sort((a, b) => b.calories - a.calories)[0];
  const budget = earned - consumed;

  return (
    <div className="calorie-bar">
      <div className="calorie-bar-head">
        <div>
          <div className="label">今日の獲得カロリー</div>
          <div className="kcal-big">
            {earned} <span>kcal</span>
          </div>
          {representative ? (
            <div className="muted">
              ≒ {representative.icon} {representative.name}（{representative.calories} kcal）
            </div>
          ) : (
            <div className="muted">問題を解いてお菓子のカロリーを貯めよう</div>
          )}
        </div>
        <div className="calorie-bar-budget">
          <div className="label">食べた分</div>
          <div className="kcal-mid">{consumed} kcal</div>
          <div className={"kcal-mid " + (budget < 0 ? "negative" : "positive")}>残り {budget} kcal</div>
        </div>
      </div>
      <div className="bar-track" role="progressbar" aria-valuenow={earned} aria-valuemin={0} aria-valuemax={max}>
        <div className="bar-fill" style={{ width: `${pct}%` }} />
        {shown.map((s) => {
          const left = Math.min(98, (s.calories / max) * 100);
          const reached = earned >= s.calories;
          return (
            <div
              key={s.id}
              className={"milestone " + (reached ? "reached" : "")}
              style={{ left: `${left}%` }}
              title={`${s.name} ${s.calories} kcal`}
            >
              <span className="milestone-icon">{s.icon}</span>
              <span className="milestone-kcal">{s.calories}</span>
            </div>
          );
        })}
        {goal && (
          <div className="milestone goal" style={{ left: "100%" }} title={`目標: ${goal.name}`}>
            <span className="milestone-icon">{goal.icon}</span>
            <span className="milestone-kcal">{goal.calories}</span>
          </div>
        )}
      </div>
    </div>
  );
}
