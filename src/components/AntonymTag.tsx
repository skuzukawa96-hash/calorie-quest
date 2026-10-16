import type { Dictionary } from "../lib/dictionary";
import type { Antonym } from "../types";
import { MeaningWithTags } from "./PosTags";
import SpeakableText from "./SpeakableText";

/**
 * ⇔ refuse [他] 断る: a word's 対義語 after its meaning on the 正解 line (a study word question, a
 * word of the recipe reviewed). The word reads aloud whole on a click (get on as one) and can be
 * right-clicked into the recipe.
 */
export default function AntonymTag({ antonym, dict }: { antonym: Antonym; dict: Dictionary | null }) {
  return (
    <span className="antonym" title="対義語">
      <span className="antonym-mark" aria-label="対義語">
        ⇔
      </span>
      <strong>
        <SpeakableText text={antonym.word} dict={dict} />
      </strong>
      <span className="antonym-meaning">
        <MeaningWithTags word={antonym.word} meaning={antonym.meaning} dict={dict} others={false} />
      </span>
    </span>
  );
}
