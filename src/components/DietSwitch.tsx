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
