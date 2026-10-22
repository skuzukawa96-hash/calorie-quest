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
