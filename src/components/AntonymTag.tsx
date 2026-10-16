import type { Dictionary } from "../lib/dictionary";
import type { Antonym } from "../types";
import GlossedText from "./GlossedText";
import { MeaningWithTags } from "./PosTags";

/**
 * ⇔ refuse [他] 断る: a word's 対義語 after its meaning on the 正解 line (a study word question, a
 * word of the recipe reviewed). The word reads aloud on a click and can be right-clicked into the
 * recipe; its meaning sits beside it, so no hover meaning.
 */
export default function AntonymTag({ antonym, dict }: { antonym: Antonym; dict: Dictionary | null }) {
  return (
    <span className="antonym" title="対義語">
      <span className="antonym-mark" aria-label="対義語">
        ⇔
      </span>
      <strong lang="en">
        <GlossedText text={antonym.word} dict={dict} enabled={false} context="" />
      </strong>
      <span className="antonym-meaning">
        <MeaningWithTags word={antonym.word} meaning={antonym.meaning} dict={dict} others={false} />
      </span>
    </span>
  );
}
