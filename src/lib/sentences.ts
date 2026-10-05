/** Mirrors exam::ends_sentence: a title before a name (Ms. Lee) and a time before a small letter do not end one. */
function endsSentence(before: string, rest: string): boolean {
  const word = before.toLowerCase().split(" ").pop() ?? "";
  if (["mr.", "ms.", "mrs.", "dr.", "co.", "inc.", "st."].includes(word)) return false;
  if (word.endsWith("a.m.") || word.endsWith("p.m.")) return /^\s*[A-Z]/.test(rest);
  return true;
}

/** Mirrors exam::sentences: a passage split after . ? ! (with a closing quote right after one) and at line breaks. */
export function sentences(passage: string): string[] {
  const out: string[] = [];
  for (const line of passage.split("\n")) {
    let cur = "";
    for (let i = 0; i < line.length; i++) {
      cur += line[i];
      if (!".?!".includes(line[i])) continue;
      const quote = line[i + 1] === '"' || line[i + 1] === "”";
      const next = i + 1 + (quote ? 1 : 0);
      // After a closing quote the sentence goes on into a small letter ("Is it new?" she asked).
      const goesOn = quote && /^\s*\p{Ll}/u.test(line.slice(next));
      if ((next >= line.length || line[next] === " ") && !goesOn && (line[i] !== "." || endsSentence(cur, line.slice(next)))) {
        if (quote) cur += line[i + 1];
        out.push(cur.trim());
        cur = "";
        i = next - 1;
      }
    }
    if (cur.trim()) out.push(cur.trim());
  }
  return out;
}

/** `text` has `word` (any case) with no letter right before or after it. */
function hasWord(text: string, word: string): boolean {
  const t = text.toLowerCase();
  const w = word.toLowerCase();
  if (!w) return false;
  for (let at = t.indexOf(w); at >= 0; at = t.indexOf(w, at + 1)) {
    const before = t.slice(0, at);
    const after = t.slice(at + w.length);
    if (!/\p{L}$/u.test(before) && !/^\p{L}/u.test(after)) return true;
  }
  return false;
}

/**
 * Mirrors recipe::example_sentence: a passage with no Japanese of its own is cut down to the
 * sentence the word is in (by the form it was found in, else the word); one with its Japanese stays whole.
 */
export function exampleSentence(example: string, exampleJa: string, form: string, word: string): string {
  if (exampleJa) return example;
  const list = sentences(example);
  if (list.length < 2) return example;
  for (const w of [form, word]) {
    const found = list.find((s) => hasWord(s, w));
    if (found) return found;
  }
  return example;
}
