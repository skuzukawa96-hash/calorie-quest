// Icon-only buttons used across the screens: 🍽️ records a snack as eaten, a red × deletes, a brown
// curved arrow undoes. Each keeps its words in the tooltip and the accessible name.

interface Common {
  disabled?: boolean;
  onClick: () => void;
}

/**
 * 食べた！ as a plate with knife and fork. A snack today's remainder does not cover is greyed out;
 * it can still be pressed, so eating over budget is recorded rather than hidden.
 */
export function EatButton({ affordable, disabled, onClick }: Common & { affordable: boolean }) {
  const title = affordable ? "食べた！（今日の残りカロリーで食べられます）" : "食べた！（今日の残りを超えます。記録はできます）";
  return (
    <button type="button" className={"icon-btn eat" + (affordable ? "" : " over")} disabled={disabled} title={title} aria-label={title} onClick={onClick}>
      🍽️
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

/** A brown arrow curling back, the usual sign for undo. */
export function UndoButton({ label = "取り消す", disabled, onClick }: Common & { label?: string }) {
  return (
    <button type="button" className="icon-btn undo" disabled={disabled} title={label} aria-label={label} onClick={onClick}>
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
