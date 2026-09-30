// お菓子作りレシピ: right-clicking English anywhere in a question or an explanation saves the
// word to the learner's list. GlossedText reports the word through this context; the provider
// in App does the saving and says what happened.
import { createContext, useContext } from "react";
import { tokenize } from "./dictionary";
import type { RecipeKind } from "../types";

export interface RecipeCandidate {
  /** dictionary form, or a whole phrase */
  word: string;
  meaning: string;
  /** the form as it appeared ("heard") */
  form: string;
  /** the sentence it appeared in, and its translation when known */
  example: string;
  exampleJa: string;
  /** the phrase the word sits in, offered as a second entry ("doggy" in "doggy bag") */
  phrase?: { word: string; meaning: string };
  /** usage: a pattern right-clicked in 用法, saved whole and never read aloud */
  kind?: RecipeKind;
}

export type AddToRecipe = (candidate: RecipeCandidate) => void;

export const RecipeContext = createContext<AddToRecipe | null>(null);

/** Null outside the provider, where right-click keeps the browser's own menu. */
export function useAddToRecipe(): AddToRecipe | null {
  return useContext(RecipeContext);
}

const listeners = new Set<() => void>();

/** Lets the recipe screen refresh when a word is saved from a sentence shown on it. */
export function onRecipeChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function recipeChanged(): void {
  for (const listener of listeners) listener();
}

/**
 * The sentence worth keeping with a word. A question that is only the word itself ("apple",
 * "doggy bag") shows nothing the entry does not already say, so it is kept without one; a later
 * right-click from a real sentence fills it in. Neither is a Japanese explanation that merely
 * mentions the word ("a few / a little は「少しある」…") an English example.
 */
export function exampleFor(text: string): string {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text)) return "";
  return tokenize(text).length >= 3 ? text.trim() : "";
}
