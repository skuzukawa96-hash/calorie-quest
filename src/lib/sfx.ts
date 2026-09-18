// Tiny synthesized sound effects (no audio assets): cookie crunch, "oops", fanfare.

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function noiseBurst(c: AudioContext, at: number, dur: number, freq: number, q: number, gain: number) {
  const len = Math.max(1, Math.floor(c.sampleRate * dur));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const env = Math.pow(1 - i / len, 2.2);
    data[i] = (Math.random() * 2 - 1) * env;
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = freq;
  filter.Q.value = q;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(filter);
  filter.connect(g);
  g.connect(c.destination);
  src.start(at);
}

function tone(c: AudioContext, at: number, freq: number, dur: number, type: OscillatorType, gain: number) {
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, at);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

/** サクサク: three short filtered noise bites, like biting a cookie. */
export function playCrunch() {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  noiseBurst(c, t, 0.09, 2400, 0.8, 0.7);
  noiseBurst(c, t + 0.1, 0.08, 3200, 0.9, 0.55);
  noiseBurst(c, t + 0.19, 0.11, 1800, 0.7, 0.5);
  tone(c, t, 660, 0.08, "sine", 0.05);
}

/** Soft "boing" for a wrong answer. */
export function playWrong() {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  tone(c, t, 220, 0.18, "triangle", 0.12);
  tone(c, t + 0.16, 165, 0.28, "triangle", 0.12);
}

/** Little arpeggio for session end / tickets. */
export function playFanfare() {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  [523, 659, 784, 1047].forEach((f, i) => tone(c, t + i * 0.12, f, 0.28, "square", 0.06));
  tone(c, t + 0.5, 1319, 0.45, "sine", 0.08);
}

/** Click for UI actions like starting the microphone. */
export function playPop() {
  const c = audio();
  if (!c) return;
  tone(c, c.currentTime, 880, 0.07, "sine", 0.08);
}
