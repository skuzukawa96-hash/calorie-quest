/**
 * ダイエット機能 in the top bar, left of the play mode: an on/off switch like 間違いやすい語を優先.
 * On, the お菓子図鑑 gets the 課題一覧, the home's goals a 課題 side and the 記録 a weight and BMI
 * chart. Hovering it says what a click does.
 */
export default function DietSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      className={"switch-btn diet-switch" + (on ? " on" : "")}
      aria-pressed={on}
      title={on ? "ダイエット機能をOFFにする" : "ダイエット機能をONにする"}
      onClick={() => onChange(!on)}
    >
      <span className="switch-knob" aria-hidden="true" />
      ダイエット
    </button>
  );
}
