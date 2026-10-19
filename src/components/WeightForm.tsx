import { useState } from "react";
import { api } from "../lib/api";
import { playDone } from "../lib/sfx";
import type { WeightPoint } from "../types";
import { EditButton } from "./IconButtons";

/** One decimal always (21.0, not 21). */
export const d1 = (n: number) => n.toFixed(1);

/**
 * 体重 / 記録 (ダイエット機能): today's weight, from the home's 目標の課題 or the 記録's weight chart,
 * whichever comes first, once a day; recording it pays `bonus` kcal (体重記録のデイリーボーナス).
 * 体脂肪率 goes beside it when the scale measures it; left empty, the weight alone is recorded.
 * The BMI is worked out from the height kept (`HeightSetting`); with none yet, `noHeight` says where
 * to give it and the weight waits. Once recorded, today's weight, BMI and 体脂肪率 stand in the
 * form's place (the BMI is shown there only, not in the chart).
 */
export default function WeightForm({
  heightCm,
  today,
  bonus,
  noHeight,
  onRecorded,
  toast,
}: {
  heightCm: number | null;
  today: WeightPoint | null;
  bonus: number;
  /** what to say while there is no height yet */
  noHeight: string;
  onRecorded: () => void;
  toast: (msg: string, ms?: number) => void;
}) {
  const [weight, setWeight] = useState("");
  const [fat, setFat] = useState("");
  const [busy, setBusy] = useState(false);

  if (today) {
    return (
      <span className="weight-today" title="今日の体重は記録済みです（記録できるのは1日1回）">
        ⚖️ 今日 <b>{d1(today.weightKg)}</b> kg・BMI <b>{d1(today.bmi)}</b>
        {today.bodyFat !== null && (
          <>
            ・体脂肪率 <b>{d1(today.bodyFat)}</b> %
          </>
        )}
        <span className="pill eaten">✓ 記録済み</span>
      </span>
    );
  }
  if (heightCm === null) return <span className="weight-today">⚖️ {noHeight}</span>;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.recordWeight(Number(weight), fat.trim() === "" ? null : Number(fat));
      playDone();
      const withFat = r.point.bodyFat !== null ? `・体脂肪率 ${d1(r.point.bodyFat)} %` : "";
      toast(`⚖️ 体重記録のデイリーボーナス${r.bonus}kcal獲得（${d1(r.point.weightKg)} kg・BMI ${d1(r.point.bmi)}${withFat}）`, 4000);
      // Not kept for the next day's form (left open past midnight, it would offer yesterday's weight).
      setWeight("");
      setFat("");
      onRecorded();
    } catch (err) {
      toast(String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="weight-form" onSubmit={(e) => void submit(e)}>
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
      {/* Not every scale measures it: left empty, the weight alone is recorded. */}
      <label title="体重計で測れるときだけ（空けたままでも記録できます）">
        体脂肪率
        <input
          type="number"
          inputMode="decimal"
          step="0.1"
          min={1}
          max={75}
          value={fat}
          placeholder="任意"
          onChange={(e) => setFat(e.target.value)}
        />
        %
      </label>
      <button
        className="btn btn-primary btn-small"
        type="submit"
        disabled={busy || !weight}
        title={`今日の体重を記録します（1日1回、+${bonus} kcal のデイリーボーナス）`}
      >
        記録 +{bonus} kcal
      </button>
    </form>
  );
}

/**
 * 身長 in the 記録: given once and kept, so it is shown, not asked for every day; the pencil changes
 * it (the weights already recorded keep the BMI they had).
 */
export function HeightSetting({
  heightCm,
  onSaved,
  toast,
}: {
  heightCm: number | null;
  onSaved: () => void;
  toast: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(heightCm === null);
  const [height, setHeight] = useState(heightCm !== null ? String(heightCm) : "");
  const [busy, setBusy] = useState(false);

  if (!editing && heightCm !== null) {
    return (
      <span className="height-setting">
        身長 <b>{d1(heightCm)}</b> cm
        <EditButton
          label="身長を変更"
          onClick={() => {
            setHeight(String(heightCm));
            setEditing(true);
          }}
        />
      </span>
    );
  }
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const h = await api.setHeight(Number(height));
      toast(`身長を ${d1(h)} cm にしました（次に変更するまでこの身長で BMI を出します）`);
      setEditing(false);
      onSaved();
    } catch (err) {
      toast(String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="weight-form" onSubmit={(e) => void submit(e)}>
      <label>
        身長
        <input
          type="number"
          inputMode="decimal"
          step="0.1"
          min={50}
          max={250}
          value={height}
          autoFocus={heightCm !== null}
          onChange={(e) => setHeight(e.target.value)}
        />
        cm
      </label>
      <button className="btn btn-small" type="submit" disabled={busy || !height}>
        保存
      </button>
      {heightCm !== null && (
        <button className="btn btn-small" type="button" disabled={busy} onClick={() => setEditing(false)}>
          やめる
        </button>
      )}
    </form>
  );
}
