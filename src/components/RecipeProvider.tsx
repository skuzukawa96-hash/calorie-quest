import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { exampleFor, RecipeContext, recipeChanged, type RecipeCandidate } from "../lib/recipe";
import { playPop } from "../lib/sfx";

interface Note {
  text: string;
  /** a yes/no question, answered with the note's buttons */
  ask?: { yes: () => void; no: () => void };
}

/** How long a plain confirmation stays, and how long a question waits for an answer. */
const SHOW_MS = 3000;
const ASK_MS = 12000;

/**
 * Saves right-clicked words to お菓子作りレシピ and confirms each one. The message never repeats
 * the meaning: a word can be right-clicked while its question is still open, and the meaning may
 * be the very answer being asked for.
 *
 * A word inside a phrase ("doggy" in "doggy bag", "crossed" in "kept my fingers crossed") is
 * usually clicked for the phrase, and the word alone can be far easier than the phrase: so the
 * phrase is offered first, and the word is offered only if the phrase is turned down. Nothing is
 * saved until one of them is accepted.
 */
export default function RecipeProvider({ children }: { children: ReactNode }) {
  const [note, setNote] = useState<Note | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const show = useCallback((n: Note | null) => {
    setNote(n);
    window.clearTimeout(timer.current);
    if (n) timer.current = window.setTimeout(() => setNote(null), n.ask ? ASK_MS : SHOW_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const save = useCallback(
    async (c: RecipeCandidate) => {
      const example = exampleFor(c.example);
      try {
        const r = await api.addRecipeWord({
          word: c.word,
          meaning: c.meaning,
          form: c.form,
          example,
          exampleJa: example ? c.exampleJa : "",
          kind: c.kind,
        });
        const w = r.entry.kind === "usage" ? `用法「${r.entry.word}」` : `「${r.entry.word}」`;
        const text =
          r.status === "added"
            ? `🧁 ${w}をレシピに追加しました`
            : r.status === "restored"
              ? `🧁 ${w}を習得済みから復習に戻しました`
              : r.status === "unexcluded"
                ? `🧁 ${w}を除外中から復習に戻しました`
                : `${w}はもうレシピに入っています`;
        if (r.status !== "exists") playPop();
        // Even a word already listed may have just gained its example sentence.
        recipeChanged();
        show({ text });
      } catch (e) {
        show({ text: "レシピに追加できませんでした: " + String(e) });
      }
    },
    [show],
  );

  const add = useCallback(
    (c: RecipeCandidate) => {
      const phrase = c.phrase && c.phrase.word.toLowerCase() !== c.word.toLowerCase() ? c.phrase : undefined;
      if (!phrase) {
        void save(c);
        return;
      }
      const askWord = () =>
        show({
          text: `「${c.word}」を単語としてレシピに登録しますか？`,
          ask: { yes: () => void save(c), no: () => show(null) },
        });
      show({
        text: `熟語「${phrase.word}」をレシピに登録しますか？`,
        ask: {
          yes: () => void save({ ...c, word: phrase.word, meaning: phrase.meaning, form: phrase.word, phrase: undefined }),
          no: askWord,
        },
      });
    },
    [save, show],
  );

  return (
    <RecipeContext.Provider value={add}>
      {children}
      {note && (
        <div className="toast recipe-toast" role={note.ask ? "alertdialog" : "status"}>
          <span>{note.text}</span>
          {note.ask && (
            <span className="recipe-toast-answers">
              <button type="button" className="recipe-toast-offer yes" onClick={note.ask.yes}>
                はい
              </button>
              <button type="button" className="recipe-toast-offer" onClick={note.ask.no}>
                いいえ
              </button>
            </span>
          )}
        </div>
      )}
    </RecipeContext.Provider>
  );
}
