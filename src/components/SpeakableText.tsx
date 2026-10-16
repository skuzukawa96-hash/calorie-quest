import { useState } from "react";
import type { Dictionary } from "../lib/dictionary";
import { isTtsSupported, speak } from "../lib/speech";
import GlossedText from "./GlossedText";

/**
 * English read aloud whole on a click, a phrasal verb or a compound as one ("get off", not "get"):
 * the word on the 正解 line and its 対義語. A right-click still saves it to the recipe (the phrase
 * first, then the word under the mouse); its meaning sits beside it, so no hover meaning.
 */
export default function SpeakableText({
  text,
  dict,
  context = "",
  contextJa,
}: {
  text: string;
  dict: Dictionary | null;
  /** the sentence a right-clicked word is saved with */
  context?: string;
  contextJa?: string | null;
}) {
  const [saying, setSaying] = useState(false);
  const canSpeak = isTtsSupported();
  const say = () => {
    setSaying(true);
    speak(text)
      .catch(() => undefined)
      .finally(() => setSaying(false));
  };
  return (
    <span
      className={"say-whole" + (saying ? " saying" : "")}
      lang="en"
      role={canSpeak ? "button" : undefined}
      title={canSpeak ? "クリックで読み上げ" : undefined}
      onClick={canSpeak ? say : undefined}
    >
      <GlossedText text={text} dict={dict} enabled={false} speakOnClick={false} context={context} contextJa={contextJa} />
    </span>
  );
}
