import { useState } from "react";
import { api } from "../lib/api";
import { playDone } from "../lib/sfx";
import type { WeightPoint } from "../types";

/** One decimal always (21.0, not 21). */
export const d1 = (n: number) => n.toFixed(1);

/**
 * 体重 / 記録 (ダイエット機能): today's weight, from the home's 目標の課題 or the 記録's weight chart,
 * whichever comes first, once a day; recording it pays `bonus` kcal (体重記録のデイリーボーナス).
 * The height comes from the last time (asked for here only when there is none yet, or always with
 * `askHeight`). Once recorded, today's weight and BMI stand in the form's place.
 */
export default function WeightForm({
  heightCm,
  today,
  bonus,
  askHeight = false,
  onRecorded,
  toast,
}: {
  heightCm: number | null;
  today: WeightPoint | null;
  bonus: number;
  askHeight?: boolean;
  onRecorded: () => void;
  toast: (msg: string, ms?: number) => void;
}) {
  const [height, setHeight] = useState(heightCm !== null ? String(heightCm) : "");
  const [weight, setWeight] = useState("");
  const [busy, setBusy] = useState(false);

  if (today) {
    return (
      <span className="weight-today" title="今日の体重は記録済みです（記録できるのは1日1回）">
        ⚖️ 今日 <b>{d1(today.weightKg)}</b> kg・BMI <b>{d1(today.bmi)}</b>
        <span className="pill eaten">✓ 記録済み</span>
      </span>
    );
  }
  const showHeight = askHeight || heightCm === null;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.recordWeight(Number(weight), Number(showHeight ? height : heightCm));
      playDone();
      toast(`⚖️ 体重記録のデイリーボーナス${r.bonus}kcal獲得（${d1(r.point.weightKg)} kg・BMI ${d1(r.point.bmi)}）`, 4000);
      onRecorded();
    } catch (err) {
      toast(String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="weight-form" onSubmit={(e) => void submit(e)}>
      {showHeight && (
        <label>
          身長
          <input type="number" inputMode="decimal" step="0.1" min={50} max={250} value={height} onChange={(e) => setHeight(e.target.value)} />
          cm
        </label>
      )}
      <label>
        体重
        <input
          type="number"
          inputMode="decimal"
          step="0.1"
          min={10}
          max={300}
          value={weight}
          placeholder="今日"
          onChange={(e) => setWeight(e.target.value)}
        />
        kg
      </label>
      <button
        className="btn btn-primary btn-small"
        type="submit"
        disabled={busy || !weight || (showHeight && !height)}
        title={`今日の体重を記録します（1日1回、+${bonus} kcal のデイリーボーナス）`}
      >
        記録 +{bonus} kcal
      </button>
    </form>
  );
}
