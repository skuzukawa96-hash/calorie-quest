// Icon-only buttons used across the screens: a knife and fork records a snack as eaten, a flexed arm a 課題
// done, a pink heart makes a goal, a red × deletes, a brown curved arrow undoes, two arrows switch a view.
// Each keeps its words in the tooltip and the accessible name.

interface Common {
  disabled?: boolean;
  onClick: () => void;
}

/**
 * 食べた！ as a knife and fork, drawn here in bold strokes: the 🍴 emoji shrinks to two grey
 * sticks at button size. A snack today's remainder does not cover is greyed out; it can still be
 * pressed, so eating over budget is recorded rather than hidden. `label` replaces the tooltip.
 */
export function EatButton({ affordable, label, disabled, onClick }: Common & { affordable: boolean; label?: string }) {
  const title =
    label ?? (affordable ? "食べた！（今日の残りカロリーで食べられます）" : "食べた！（今日の残りを超えます。記録はできます）");
  return (
    <button type="button" className={"icon-btn eat" + (affordable ? "" : " over")} disabled={disabled} title={title} aria-label={title} onClick={onClick}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <g fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          {/* fork: three tines joined by a curve, then the handle */}
          <path d="M5 2.8v5.4M8 2.8v5.4M11 2.8v5.4M5 8.2a3 3 0 0 0 6 0M8 11.2v10" />
          {/* knife: a curved blade, then the handle */}
          <path d="M19 2.8c-2.3 1.1-3.6 3.9-3.6 7.3v3.4H19zM17.4 13.5v7.7" fill="currentColor" />
        </g>
      </svg>
    </button>
  );
}

/**
 * 達成！ for a 課題 as a flexed arm (💪), drawn like the knife and fork in the same bold brown
 * strokes: one outline from the fist down the forearm and round the biceps.
 */
export function DoneButton({ label = "達成！（カロリーを獲得）", disabled, onClick }: Common & { label?: string }) {
  return (
    <button type="button" className="icon-btn done" disabled={disabled} title={label} aria-label={label} onClick={onClick}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M3.2 18.6C2.6 11 5 3 10.6 3a2.6 2.6 0 0 1 0 5.2c-.4 0-.8-.1-1.1-.2.3 1.9 1.4 3.9 2.6 5.2a4.9 4.9 0 0 1 9.4 2c0 3.4-3.9 5.8-8.6 5.8-3.6 0-7.2-.8-9.7-2.4z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/**
 * A heart as wide as it is tall (♡ in a font leans one way or the other), filled when `on`: the mark
 * of a goal, apart from the ★ that stars a question into お気に入り.
 */
export function Heart({ on }: { on: boolean }) {
  return (
    <svg className="heart" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 21C9.5 19.2 3.5 14.9 3.5 9.4a4.25 4.25 0 0 1 8.5-1.2 4.25 4.25 0 0 1 8.5 1.2C20.5 14.9 14.5 19.2 12 21z"
        fill={on ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** ♡ of a row of the お菓子図鑑 or the 課題一覧: pressed, the row is a goal and the heart filled. */
export function GoalButton({ on, disabled, onClick }: Common & { on: boolean }) {
  const label = on ? "目標から外す" : "目標にする（いくつでも登録できます）";
  return (
    <button
      type="button"
      className={"icon-btn goal" + (on ? " on" : "")}
      disabled={disabled}
      aria-pressed={on}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <Heart on={on} />
    </button>
  );
}

/** A red ×. `label` says what goes, since a list can hold several kinds of removal. */
export function DeleteButton({ label, disabled, onClick }: Common & { label: string }) {
  return (
    <button type="button" className="icon-btn delete" disabled={disabled} title={label} aria-label={label} onClick={onClick}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
    </button>
  );
}

/** A brown pencil: correct what the row says. */
export function EditButton({ label = "修正する", disabled, onClick }: Common & { label?: string }) {
  return (
    <button type="button" className="icon-btn edit" disabled={disabled} title={label} aria-label={label} onClick={onClick}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M4 20l1-4.2L15.6 5.2a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.2 19 4 20zM13.8 7l3.2 3.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/**
 * Two arrows the opposite ways (⇄) beside a heading: switches what the card shows (目標のお菓子 ⇄
 * 目標の課題, the kcal chart ⇄ the weight chart). `label` names what it switches to.
 */
export function SwitchViewButton({ label, disabled, onClick }: Common & { label: string }) {
  return (
    <button type="button" className="icon-btn switch-view" disabled={disabled} title={label} aria-label={label} onClick={onClick}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M4 8.5h14.5M15 5l3.5 3.5L15 12M20 15.5H5.5M9 12l-3.5 3.5L9 19"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/**
 * A brown arrow curling back, the usual sign for undo. `expanded` marks one that opens a list of
 * what to undo (a stack of the same snack) rather than undoing at once.
 */
export function UndoButton({
  label = "取り消す",
  disabled,
  onClick,
  expanded,
}: Common & { label?: string; expanded?: boolean }) {
  return (
    <button
      type="button"
      className={"icon-btn undo" + (expanded ? " open" : "")}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-expanded={expanded}
      onClick={onClick}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M8.5 5.5 4 10l4.5 4.5M4.5 10H14a5.5 5.5 0 0 1 0 11h-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
