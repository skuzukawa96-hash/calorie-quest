import type { ReactNode } from "react";

/**
 * The icons of the app's own drawing, for what has no emoji (a dumbbell alone, a vacuum cleaner),
 * kept as "svg:<name>" where an emoji would be. Drawn flat in the emoji's colours, a little larger
 * than the text so they sit with the emoji around them.
 */
const DRAWN: Record<string, ReactNode> = {
  "svg:dumbbell": (
    <g transform="rotate(-35 16 16)">
      <rect x="6" y="14.3" width="20" height="3.4" rx="1.7" fill="#9aa3ad" />
      <rect x="6" y="14.3" width="20" height="1.3" rx=".65" fill="#cfd6dd" />
      <rect x="1.5" y="11.5" width="3.2" height="9" rx="1.4" fill="#2f3a46" />
      <rect x="4.2" y="8.2" width="4.4" height="15.6" rx="2" fill="#e4573f" />
      <rect x="4.2" y="8.2" width="4.4" height="3.6" rx="1.6" fill="#f08a6f" />
      <rect x="27.3" y="11.5" width="3.2" height="9" rx="1.4" fill="#2f3a46" />
      <rect x="23.4" y="8.2" width="4.4" height="15.6" rx="2" fill="#e4573f" />
      <rect x="23.4" y="8.2" width="4.4" height="3.6" rx="1.6" fill="#f08a6f" />
    </g>
  ),
  "svg:vacuum": (
    <>
      <path d="M13.5 15.5C13 9.5 16 6 20.5 6" fill="none" stroke="#4a5664" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M21 7l5 17.5" fill="none" stroke="#b3bcc6" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M19 4.6h4.2a1.4 1.4 0 0 1 1.4 1.4v1.4h-7V6a1.4 1.4 0 0 1 1.4-1.4z" fill="#2f3a46" />
      <path d="M22.6 24.2h6.6a1.6 1.6 0 0 1 1.6 1.6v1.5h-9.8v-1.5a1.6 1.6 0 0 1 1.6-1.6z" fill="#2f3a46" />
      <path d="M2.5 22.3c0-4.4 3.3-7.8 7.6-7.8h1.4c3.6 0 6.5 2.9 6.5 6.5v2.4c0 1.1-.9 2-2 2H4.5c-1.1 0-2-.9-2-2z" fill="#2f9c8f" />
      <path d="M5 19.4c.8-2 2.7-3.3 5-3.3h1.6" fill="none" stroke="#7fd1c6" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="7" cy="25.6" r="3.2" fill="#2f3a46" />
      <circle cx="7" cy="25.6" r="1.2" fill="#b3bcc6" />
    </>
  ),
};

/** What the drawn icons are, for a tooltip or a screen reader. */
const DRAWN_NAME: Record<string, string> = { "svg:dumbbell": "ダンベル", "svg:vacuum": "掃除機" };

/** An icon of a snack or a 課題: the emoji itself, or one of the drawn ones. */
export function ItemIcon({ icon }: { icon: string }) {
  const drawn = DRAWN[icon];
  if (!drawn) return <>{icon}</>;
  return (
    <svg className="item-icon" viewBox="0 0 32 32" role="img" aria-label={DRAWN_NAME[icon]}>
      {drawn}
    </svg>
  );
}

/** The icon and the name for a line of text (a toast): a drawn icon is left out, having no character. */
export function iconLabel(icon: string, name: string): string {
  return DRAWN[icon] ? name : `${icon} ${name}`;
}
