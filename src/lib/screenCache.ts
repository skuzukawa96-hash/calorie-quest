import { api } from "./api";
import type { Favorite, RecipeWord, Stats } from "../types";

/**
 * What お気に入り / レシピ / 記録 loaded last, kept while the app runs. A screen opened again shows it
 * at once and loads afresh behind it (the same data draws the same), so a switch of tab does not
 * blink 読み込み中 in between.
 */
interface Kept {
  favorites: Favorite[];
  recipe: RecipeWord[];
  stats: Stats;
}

const kept: Partial<Kept> = {};

/** What the screen loaded last (or was loaded ahead for it), or null the first time. */
export function keptData<K extends keyof Kept>(key: K): Kept[K] | null {
  return kept[key] ?? null;
}

export function keep<K extends keyof Kept>(key: K, value: Kept[K]): void {
  kept[key] = value;
}

/**
 * The three screens' data loaded ahead, a little after start-up (once the home screen is up and the
 * notes' tables are built behind it), so that even the first opening shows at once. What a screen
 * has loaded itself by then is not overwritten.
 */
export function preloadScreens(): void {
  const ahead = <K extends keyof Kept>(key: K, load: () => Promise<Kept[K]>) =>
    load()
      .then((value) => {
        if (!kept[key]) kept[key] = value;
      })
      .catch(() => undefined);
  void ahead("stats", api.getStats).then(() => ahead("recipe", api.listRecipeWords)).then(() => ahead("favorites", api.listFavorites));
}
