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

/** Typing answers: case, punctuation and spacing are ignored; letters must match exactly. */
export function checkTyping(answer: string, input: string): boolean {
  const strip = (s: string) => normalizeText(s).replace(/'/g, "");
  return strip(answer) === strip(input);
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

/** "Nice to meet you." -> "N___ t_ m___ y__." */
export function makeHint(answer: string): string {
  return answer
    .split(" ")
    .map((w) => {
      const m = w.match(/^([a-zA-Z])(.*)$/);
      if (!m) return w;
      return m[1] + m[2].replace(/[a-zA-Z]/g, "_");
    })
    .join(" ");
}
