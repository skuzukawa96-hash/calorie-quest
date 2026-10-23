// A phone or tablet (the Android app): no mouse to hover or right-click with, and no Enter key
// under the thumb. Words that tell the learner how to do something say タップ / 長押し there.
import { useSyncExternalStore } from "react";

export const touchScreen =
  typeof window !== "undefined" && window.matchMedia("(hover: none) and (pointer: coarse)").matches;

/** クリック, or タップ on a touch screen */
export const CLICK = touchScreen ? "タップ" : "クリック";

/** 右クリック, or 長押し on a touch screen (Android sends a long press as a contextmenu event) */
export const RIGHT_CLICK = touchScreen ? "長押し" : "右クリック";

/** "次へ（Enter）" with a keyboard, "次へ" without one */
export const withEnter = (label: string) => (touchScreen ? label : `${label}（Enter）`);

/** styles.css's phone layout (max-width: 640px) */
const PHONE_WIDTH = "(max-width: 640px)";

/** Whether the window is as narrow as a phone's screen, kept current as it is resized. */
export function usePhoneWidth(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const query = window.matchMedia(PHONE_WIDTH);
      query.addEventListener("change", changed);
      return () => query.removeEventListener("change", changed);
    },
    () => window.matchMedia(PHONE_WIDTH).matches,
  );
}

/**
 * The ref of what opens under a question once it is answered (the explanation and 次へ): on a
 * touch screen, where it opens below the screen's edge, it is scrolled into view as it appears.
 */
export function revealOnTouch(el: HTMLElement | null) {
  if (!touchScreen || !el) return;
  requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", block: "nearest" }));
}

/**
 * The lines of chips under `root` that slide sideways on a phone (`rows`, a selector): the chip
 * picked in each scrolled into sight when it is out of it, as when 例文 was picked last time.
 */
export function revealPicked(root: HTMLElement | null, rows: string) {
  if (!root) return;
  for (const row of root.querySelectorAll<HTMLElement>(rows)) {
    const on = row.querySelector<HTMLElement>(".active, .on");
    if (!on || row.scrollWidth <= row.clientWidth) continue;
    const r = row.getBoundingClientRect();
    const c = on.getBoundingClientRect();
    if (c.right > r.right - 28) row.scrollLeft += c.right - r.right + 40;
    else if (c.left < r.left) row.scrollLeft -= r.left - c.left + 14;
  }
}
