import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Mode } from "../types";

const questionKey = (questionId: number, mode: Mode) => `q:${questionId}:${mode}`;
const examKey = (examId: string) => `e:${examId}`;

/**
 * What is starred, loaded once for a session or an exam, and a way to star or unstar a question.
 * The star turns at once; a failed save turns it back and says so.
 */
export function useFavorites(toast: (msg: string) => void) {
  const [keys, setKeys] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    let alive = true;
    api
      .getFavoriteKeys()
      .then((k) => {
        if (!alive) return;
        setKeys(new Set([...k.questions.map((q) => questionKey(q.questionId, q.mode)), ...k.exams.map(examKey)]));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const flip = useCallback(
    async (key: string, save: (on: boolean) => Promise<void>) => {
      const on = !keys.has(key);
      const set = (value: boolean) =>
        setKeys((cur) => {
          const next = new Set(cur);
          if (value) next.add(key);
          else next.delete(key);
          return next;
        });
      set(on);
      try {
        await save(on);
        toast(on ? "★ お気に入りに登録しました" : "☆ お気に入りから外しました");
      } catch (e) {
        set(!on);
        toast(String(e));
      }
    },
    [keys, toast],
  );

  return {
    isQuestion: (questionId: number, mode: Mode) => keys.has(questionKey(questionId, mode)),
    isExam: (examId: string) => keys.has(examKey(examId)),
    toggleQuestion: (questionId: number, mode: Mode) =>
      flip(questionKey(questionId, mode), (on) => api.setQuestionFavorite(questionId, mode, on)),
    toggleExam: (examId: string) => flip(examKey(examId), (on) => api.setExamFavorite(examId, on)),
  };
}

/** ☆ / ★ in the top right corner of a question: starring it puts it in お気に入り. */
export default function FavoriteStar({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={"fav-star" + (on ? " on" : "")}
      aria-pressed={on}
      title={on ? "お気に入りから外す" : "お気に入りに登録する"}
      aria-label={on ? "お気に入りから外す" : "お気に入りに登録する"}
      onClick={onToggle}
    >
      {on ? "★" : "☆"}
    </button>
  );
}
