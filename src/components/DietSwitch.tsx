import type { ReactNode } from "react";
import { setDietView, useDietView, type DietView } from "../lib/dietView";
import { FlexedArm, ForkAndKnife } from "./IconButtons";

/**
 * ダイエット機能 in the top bar, left of the play mode: an on/off switch alone (the 間違いやすい語を優先
 * switch's knob, without words). On, the お菓子図鑑 and the home's goals switch to 課題 too and the
 * 記録 has a weight and BMI chart. Hovering it says what a click does.
 */
export default function DietSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      className={"switch-btn diet-switch" + (on ? " on" : "")}
      aria-pressed={on}
      aria-label="ダイエット機能"
      title={on ? "ダイエット機能をOFFにする" : "ダイエット機能をONにする"}
      onClick={() => onChange(!on)}
    >
      <span className="switch-knob" aria-hidden="true" />
    </button>
  );
}

/**
 * ダイエット機能 on, a phone's top bar: お菓子 or 課題 on every page at once (lib/dietView.ts), shown
 * as the knife and fork and the flexed arm of their own buttons, the side shown filled in.
 */
export function DietViewSwitch() {
  const view = useDietView();
  const side = (v: DietView, label: string, icon: ReactNode) => (
    <button
      type="button"
      className={view === v ? "on" : ""}
      aria-pressed={view === v}
      aria-label={label}
      title={label}
      onClick={() => setDietView(v)}
    >
      {icon}
    </button>
  );
  return (
    <span className="diet-view" role="group" aria-label="お菓子と課題の切り替え">
      {side("snacks", "お菓子を表示", <ForkAndKnife />)}
      {side("tasks", "課題を表示", <FlexedArm />)}
    </span>
  );
}
