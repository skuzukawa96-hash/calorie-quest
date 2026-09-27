// Text comparison, pronunciation scoring and "tricky sound" detection.

export const PASS_SCORE = 60;

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein<T>(a: T[], b: T[]): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev: number[] = [];
  for (let j = 0; j <= n; j++) prev.push(j);
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

/** 0..1 similarity mixing word-level and character-level edit distance. */
export function similarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const wa = na.split(" ");
  const wb = nb.split(" ");
  const wordSim = 1 - levenshtein(wa, wb) / Math.max(wa.length, wb.length);
  const ca = na.replace(/ /g, "").split("");
  const cb = nb.replace(/ /g, "").split("");
  const charSim = 1 - levenshtein(ca, cb) / Math.max(ca.length, cb.length);
  return Math.max(0, Math.min(1, 0.5 * wordSim + 0.5 * charSim));
}

/**
 * Typing answers: case, punctuation and spacing are ignored; letters must match exactly.
 * Any of `accepted` counts, since the bank can teach several English renderings of one Japanese.
 */
export function checkTyping(accepted: string | string[], input: string): boolean {
  const strip = (s: string) => normalizeText(s).replace(/'/g, "");
  const stripped = strip(input);
  return (Array.isArray(accepted) ? accepted : [accepted]).some((a) => strip(a) === stripped);
}

/** One word of a typed answer, lined up against the expected answer. */
export interface WordMark {
  /** the learner's word, or for a missing word the one that was expected */
  word: string;
  status: "ok" | "wrong" | "extra" | "missing";
}

export interface TypingGrade {
  correct: boolean;
  /** words that differ from the closest accepted answer: wrong, missing or extra (0 when correct) */
  mistakes: number;
  marks: WordMark[];
}

/** A word as the grader compares it: case, punctuation and apostrophes ignored, like checkTyping. */
function wordKey(w: string): string {
  return normalizeText(w).replace(/['\s]/g, "");
}

function words(s: string): string[] {
  return s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
}

/** Word-level edit distance with the path, so each word can be marked. */
function alignWords(input: string[], answer: string[]): { edits: number; marks: WordMark[] } {
  const a = input.map(wordKey);
  const b = answer.map(wordKey);
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  const marks: WordMark[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) {
      marks.push({ word: input[i - 1], status: a[i - 1] === b[j - 1] ? "ok" : "wrong" });
      i--;
      j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      marks.push({ word: input[i - 1], status: "extra" });
      i--;
    } else {
      marks.push({ word: answer[j - 1], status: "missing" });
      j--;
    }
  }
  return { edits: d[a.length][b.length], marks: marks.reverse() };
}

/**
 * Grades a typed answer and says which words were off. Correctness is exactly `checkTyping`; the
 * mistake count is the word-level distance to the closest accepted answer, so "He like cooking."
 * for "He likes cooking." is one mistake (a wrong word), as is a word left out or one too many.
 */
export function gradeTyping(accepted: string | string[], input: string): TypingGrade {
  const list = Array.isArray(accepted) ? accepted : [accepted];
  const correct = checkTyping(list, input);
  const typed = words(input);
  let best: { edits: number; marks: WordMark[] } | null = null;
  for (const a of list) {
    const r = alignWords(typed, words(a));
    if (!best || r.edits < best.edits) best = r;
  }
  const marks = best?.marks ?? [];
  if (correct) return { correct, mistakes: 0, marks: marks.map((m) => ({ ...m, status: "ok" as const })) };
  // A wrong answer is at least one mistake, even where word keys happen to agree ("well-known").
  return { correct, mistakes: Math.max(1, best?.edits ?? 1), marks };
}

export interface PronunciationScore {
  score: number;
  similarity: number;
  fluency: number;
  best: string;
}

export interface NativeJudgement {
  matched: boolean;
  confidence: "high" | "medium" | "low" | "rejected";
  rawConfidence: number;
  text: string;
}

/**
 * Score = 80% text match + 20% fluency.
 * - Web Speech API: match = similarity between the target and the best transcript; fluency
 *   compares time-to-result with a natural pace.
 * - Native (Windows) recognizer: match comes from the engine's confidence for the target
 *   phrase in a list grammar; fluency uses the measured phrase duration.
 */
export function scorePronunciation(
  target: string,
  transcripts: string[],
  durationMs: number,
  native?: NativeJudgement,
): PronunciationScore {
  let best = "";
  let bestSim = 0;
  const words = normalizeText(target).split(" ").filter(Boolean).length;
  let expectedMs = words * 450 + 1200;

  if (native) {
    best = native.text;
    if (native.matched) {
      const floor = native.confidence === "high" ? 0.9 : native.confidence === "medium" ? 0.75 : native.confidence === "low" ? 0.6 : 0.3;
      bestSim = Math.max(floor, Math.min(1, native.rawConfidence));
    } else if (native.confidence === "rejected" || !native.text) {
      bestSim = 0.2;
    } else {
      bestSim = Math.min(0.5, similarity(target, native.text));
    }
    // PhraseDuration excludes leading/trailing silence, so allow less slack.
    expectedMs = words * 450 + 400;
  } else {
    for (const t of transcripts) {
      const s = similarity(target, t);
      if (s > bestSim) {
        bestSim = s;
        best = t;
      }
    }
    if (!best && transcripts.length) best = transcripts[0];
  }

  const fluency = durationMs <= 0 ? 1 : Math.max(0, Math.min(1, expectedMs / durationMs));
  const score = Math.round(100 * (0.8 * bestSim + 0.2 * fluency));
  return { score, similarity: bestSim, fluency, best };
}

export type TipKey = "r" | "l" | "th" | "fv" | "w";

/** Sounds Japanese learners commonly struggle with, detected from spelling. */
export function detectTrickySounds(text: string): TipKey[] {
  const t = text.toLowerCase();
  const keys: TipKey[] = [];
  if (/th/.test(t)) keys.push("th");
  if (/r/.test(t)) keys.push("r");
  if (/l/.test(t)) keys.push("l");
  if (/[fv]/.test(t)) keys.push("fv");
  if (/\bw[aeiouhr]/.test(t)) keys.push("w");
  return keys;
}

/**
 * ヒント1語分。"Nice" -> "N___"（記号はそのまま、2文字目以降の英字だけ伏せる）。
 * `everyWord` のときは、そのままだと丸見えになる語（"I"・"a"・"3D"）も "_" で伏せる。
 * 1語ごとに配点する問題では、どの語も開示できないと「全部開示したら 0 kcal」にならないため。
 */
export function maskWord(word: string, everyWord = false): string {
  const m = word.match(/^([a-zA-Z])(.*)$/);
  const masked = m ? m[1] + m[2].replace(/[a-zA-Z]/g, "_") : word;
  if (everyWord && masked === word && /[\p{L}\p{N}]/u.test(word)) return word.replace(/[\p{L}\p{N}]/gu, "_");
  return masked;
}

/** 答えの単語数。`srs::answer_word_count` と同じく、英字か数字を含む語を数える。 */
export function answerWordCount(answer: string): number {
  return answer.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** 中難易度の記入問題は1語 1 kcal、ヒント1語ごとに −1 kcal（`srs::scores_per_word`）。 */
export function scoresPerWord(difficulty: string, mode: string): boolean {
  return difficulty === "mid" && mode === "typing";
}
