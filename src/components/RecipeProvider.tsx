import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { exampleFor, RecipeContext, recipeChanged, type RecipeCandidate } from "../lib/recipe";
import { playPop } from "../lib/sfx";

interface Note {
  text: string;
  /** "doggy" was saved; "doggy bag" is offered with one more click */
  offer?: RecipeCandidate;
}

/**
 * Saves right-clicked words to お菓子作りレシピ and confirms each one. The message never repeats
 * the meaning: a word can be right-clicked while its question is still open, and the meaning may
 * be the very answer being asked for.
 */
export default function RecipeProvider({ children }: { children: ReactNode }) {
  const [note, setNote] = useState<Note | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const show = useCallback((n: Note) => {
    setNote(n);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNote(null), n.offer ? 6000 : 3000);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const add = useCallback(
    async (c: RecipeCandidate) => {
      const example = exampleFor(c.example);
      try {
        const r = await api.addRecipeWord({
          word: c.word,
          meaning: c.meaning,
          form: c.form,
          example,
          exampleJa: example ? c.exampleJa : "",
        });
        const w = r.entry.word;
        const text =
          r.status === "added"
            ? `🧁 「${w}」をレシピに追加しました`
            : r.status === "restored"
              ? `🧁 「${w}」を習得済みから復習に戻しました`
              : `「${w}」はもうレシピに入っています`;
        if (r.status !== "exists") playPop();
        // Even a word already listed may have just gained its example sentence.
        recipeChanged();
        const offer =
          c.phrase && c.phrase.word.toLowerCase() !== w.toLowerCase()
            ? { word: c.phrase.word, meaning: c.phrase.meaning, form: c.phrase.word, example: c.example, exampleJa: c.exampleJa }
            : undefined;
        show({ text, offer });
      } catch (e) {
        show({ text: "レシピに追加できませんでした: " + String(e) });
      }
    },
    [show],
  );

  return (
    <RecipeContext.Provider value={add}>
      {children}
      {note && (
        <div className="toast recipe-toast" role="status">
          <span>{note.text}</span>
          {note.offer && (
            <button type="button" className="recipe-toast-offer" onClick={() => void add(note.offer!)}>
              熟語「{note.offer.word}」も追加
            </button>
          )}
        </div>
      )}
    </RecipeContext.Provider>
  );
}
