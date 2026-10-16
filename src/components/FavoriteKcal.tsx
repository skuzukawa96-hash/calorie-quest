import { formatKcal } from "../lib/scoring";
import type { FavoriteReview, PlayMode } from "../types";
import { PlayModeTag } from "./PlayModeSwitch";

/**
 * What an answer of お気に入りの復習 paid: its kcal (once a day, after the play mode), or that it
 * paid today already: the study's and the exam's favorites alike.
 */
export default function FavoriteKcal({ fav, playMode }: { fav: FavoriteReview | null; playMode: PlayMode }) {
  if (fav?.paidBefore) {
    return (
      <div className="feedback-kcal fav-review-note" title="お気に入りの復習のカロリーは、1問につき1日1回です">
        ★ 今日はカロリー獲得済み
      </div>
    );
  }
  return (
    <div className="feedback-kcal" title="お気に入りの復習のカロリーは、1問につき1日1回です">
      +{formatKcal(fav?.points ?? 0)} kcal
      {(fav?.points ?? 0) > 0 && <PlayModeTag mode={playMode} />}
    </div>
  );
}
