// ダイエット機能 on a phone: one switch in the top bar shows the snacks or the 課題 on every page at
// once (the home's goals, the 図鑑 with today's record, the 記録's chart), in place of the ⇄ each of
// those pages has on a PC.
import { useSyncExternalStore } from "react";

/** お菓子 (the snacks and the kcal chart) or 課題 (the 課題 and the weight chart) */
export type DietView = "snacks" | "tasks";

const KEY = "cq-diet-view";

function load(): DietView {
  try {
    return localStorage.getItem(KEY) === "tasks" ? "tasks" : "snacks";
  } catch {
    return "snacks";
  }
}

let view: DietView = load();
const listeners = new Set<() => void>();

export function setDietView(next: DietView) {
  view = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* ignore */
  }
  for (const listener of listeners) listener();
}

/** Which side the top bar's switch shows, kept for the next time. */
export function useDietView(): DietView {
  return useSyncExternalStore(
    (changed) => {
      listeners.add(changed);
      return () => listeners.delete(changed);
    },
    () => view,
  );
}
