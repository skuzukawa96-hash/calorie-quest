import type { Snack } from "../types";

interface Props {
  earned: number;
  consumed: number;
  /** goal snacks; the bar runs up to the dearest of them */
  goals: Snack[];
  snacks: Snack[];
  /** ids of snacks eaten today, marked with a check */
  eatenToday: number[];
  /** clicking an icon records that snack as eaten */
  onEat?: (snack: Snack) => void;
}

/** Keep icons at least this far apart (% of the bar) so neighbours such as 230 and 250 kcal don't overlap. */
const MIN_GAP = 9;

/**
 * Today's calorie progress with snack icons as milestones along the bar. Every goal snack sits at
 * its own calorie mark, and a few built-in snacks fill the gaps. Clicking an icon eats that snack.
 * The bar shows what is left to spend, not what was earned: after 500 kcal earned and a 300 kcal
 * snack eaten it stands at 200, and only snacks that still fit are marked within reach.
 */
export default function CalorieBar({ earned, consumed, goals, snacks, eatenToday, onEat }: Props) {
  const budget = earned - consumed;
  const left = Math.max(0, budget);
  const max = goals.length > 0 ? Math.max(...goals.map((g) => g.calories)) : Math.max(250, Math.ceil((earned + 1) / 100) * 100);
  const pct = Math.min(100, (left / max) * 100);
  const at = (s: Snack) => Math.min(100, (s.calories / max) * 100);

  // Goals always show; then unique-calorie built-in snacks wherever there is room.
  const placed: Array<{ snack: Snack; goal: boolean }> = goals.map((snack) => ({ snack, goal: true }));
  const goalIds = new Set(goals.map((g) => g.id));
  const seen = new Set<number>(goals.map((g) => g.calories));
  const candidates = snacks
    .filter((s) => s.isBuiltin && s.calories > 0 && s.calories <= max && !goalIds.has(s.id))
    .filter((s) => (seen.has(s.calories) ? false : (seen.add(s.calories), true)))
    .sort((a, b) => a.calories - b.calories);
  for (const s of candidates) {
    if (placed.every((p) => Math.abs(at(p.snack) - at(s)) >= MIN_GAP)) placed.push({ snack: s, goal: false });
  }
  placed.sort((a, b) => a.snack.calories - b.snack.calories);

  const eaten = new Set(eatenToday);

  return (
    <div className="calorie-bar">
      {/* The day's total on the left; what went and what is left on the right, over the bar's end. */}
      <div className="calorie-bar-head">
        <div>
          <div className="label">今日の獲得カロリー</div>
          <div className="kcal-big">
            {earned} <span>kcal</span>
          </div>
        </div>
        <div className="kcal-split">
          <div className="negative">消費 {consumed} kcal</div>
          <div className={budget < 0 ? "negative" : "positive"}>残り {budget} kcal</div>
        </div>
      </div>
      <div className="bar-track" role="progressbar" aria-label="今日の残りカロリー" aria-valuenow={left} aria-valuemin={0} aria-valuemax={max}>
        <div className="bar-fill" style={{ width: `${pct}%` }} />
        {placed.map(({ snack: s, goal }) => {
          const ate = eaten.has(s.id);
          const cls = ["milestone", left >= s.calories ? "reached" : "", goal ? "goal" : "", ate ? "eaten" : ""]
            .filter(Boolean)
            .join(" ");
          const over = budget < s.calories ? "（今日の残りを超えます）" : "";
          return (
            <button
              key={s.id}
              type="button"
              className={cls}
              style={{ left: `${goal ? at(s) : Math.min(98, at(s))}%` }}
              disabled={!onEat}
              title={`${goal ? "目標: " : ""}${s.name} ${s.calories} kcal${ate ? "（今日食べた）" : ""}\nクリックで「食べた」を記録${over}`}
              onClick={() => onEat?.(s)}
            >
              <span className="milestone-icon">{s.icon}</span>
              {ate && <span className="milestone-check">✓</span>}
              <span className="milestone-kcal">{s.calories}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
