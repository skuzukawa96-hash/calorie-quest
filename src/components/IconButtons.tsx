// Icon-only buttons used across the screens: a knife and fork records a snack as eaten, a red × deletes, a brown
// curved arrow undoes. Each keeps its words in the tooltip and the accessible name.

interface Common {
  disabled?: boolean;
  onClick: () => void;
}

/**
 * 食べた！ as a knife and fork, drawn here in bold strokes: the 🍴 emoji shrinks to two grey
 * sticks at button size. A snack today's remainder does not cover is greyed out; it can still be
 * pressed, so eating over budget is recorded rather than hidden.
 */
export function EatButton({ affordable, disabled, onClick }: Common & { affordable: boolean }) {
  const title = affordable ? "食べた！（今日の残りカロリーで食べられます）" : "食べた！（今日の残りを超えます。記録はできます）";
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
