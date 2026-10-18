// Tiny synthesized sound effects (no audio assets): cookie crunch, "oops", fanfare.

let ctx: AudioContext | null = null;

/** The one AudioContext of the app (the sounds, and LexiLink's words made ahead). Opening it the
 * first time holds the page up a third of a second (the sound device starts), so `warmUpAudio`
 * opens it while the app is idle, not on the first sound. */
export function audio(): AudioContext | null {
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/**
 * Opens the sound device and makes LexiLink's sounds ahead, a moment after the app starts: the
 * first sound (a candy unwrapped, an answer's crunch) then neither holds the page up nor comes late.
 * Opened before the learner has clicked anything, the context may wait suspended; the first click
 * anywhere lets it start.
 */
export function warmUpAudio() {
  const c = audio();
  if (c && c.state === "suspended") {
    window.addEventListener("pointerdown", () => void c.resume().catch(() => undefined), { once: true, capture: true });
  }
  prepareLexiSounds();
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

/* ---------- LexiLink: made ahead and brought to one level, so that nothing clips ---------- */

/** The parts a LexiLink sound is made of, in whichever context it is made in. */
function kit(c: BaseAudioContext, out: AudioNode) {
  const sr = c.sampleRate;
  const buf = (dur: number, fill: (d: Float32Array) => void) => {
    const b = c.createBuffer(1, Math.max(1, Math.floor(sr * dur)), sr);
    fill(b.getChannelData(0));
    return b;
  };
  const filt = (type: BiquadFilterType, f: number, q = 0.7) => {
    const x = c.createBiquadFilter();
    x.type = type;
    x.frequency.value = f;
    x.Q.value = q;
    return x;
  };
  const play = (b: AudioBuffer, at: number, chain: AudioNode[] = [], gain = 1) => {
    const s = c.createBufferSource();
    s.buffer = b;
    let n: AudioNode = s;
    for (const f of chain) {
      n.connect(f);
      n = f;
    }
    const g = c.createGain();
    g.gain.value = gain;
    n.connect(g);
    g.connect(out);
    s.start(at);
  };
  const decay = (dur: number, tau: number) =>
    buf(dur, (d) => {
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sr * tau));
    });
  const swell = (t: number) => Math.pow(Math.sin(Math.PI * t), 0.6);
  /** カサカサ: small crackles strewn unevenly, now thicker, now thinner */
  const crinkle = (dur: number, rate: number, env: (t: number) => number = swell) =>
    buf(dur, (d) => {
      let dens = 0.6;
      let i = 0;
      while (i < d.length) {
        dens = Math.min(1, Math.max(0.08, dens + (Math.random() - 0.5) * 0.35));
        i += Math.floor(-Math.log(1 - Math.random()) * (sr / (rate * dens * Math.max(env(i / d.length), 0.02)))) + 1;
        if (i >= d.length) break;
        const n = Math.floor(sr * (0.001 + Math.random() * 0.005));
        const amp = (0.25 + Math.random() * 0.75) * env(i / d.length);
        for (let k = 0; k < n && i + k < d.length; k++) d[i + k] += (Math.random() * 2 - 1) * amp * Math.pow(1 - k / n, 3);
      }
    });
  /** the soft rub under the crackles */
  const rustle = (dur: number, env: (t: number) => number) =>
    buf(dur, (d) => {
      let m = 0.5;
      let target = 0.5;
      for (let i = 0; i < d.length; i++) {
        if (i % 256 === 0) target = Math.random();
        m += (target - m) * 0.004;
        d[i] = (Math.random() * 2 - 1) * m * env(i / d.length);
      }
    });
  const tone = (at: number, f: number, dur: number, type: OscillatorType = "sine", g = 0.3, f2?: number) => {
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, at);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, at + dur);
    const gn = c.createGain();
    gn.gain.setValueAtTime(0.0001, at);
    gn.gain.exponentialRampToValueAtTime(g, at + 0.008);
    gn.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(gn);
    gn.connect(out);
    o.start(at);
    o.stop(at + dur + 0.05);
  };
  /** one bite of a candy: the hard snap, its ring and the crumbs, rounded off by `lp` */
  const crack = (at: number, f: number, g: number, thump: number, tau: number, bits: number, lp: number) => {
    const soft = [filt("lowpass", lp)];
    play(decay(0.004, 0.0012), at, [filt("highpass", 1800), ...soft], g * 1.2);
    play(decay(tau * 5, tau), at, [filt("bandpass", f, 2.2), ...soft], g * 2.4);
    tone(at, 160, 0.07, "sine", thump * g, 60);
    for (let k = 0; k < bits; k++)
      play(decay(0.006, 0.0015), at + 0.01 + Math.random() * 0.05, [filt("highpass", 3200), filt("lowpass", lp)], g * (0.25 + Math.random() * 0.35));
  };
  return { play, filt, swell, crinkle, rustle, tone, crack };
}

type Kit = ReturnType<typeof kit>;
interface Made {
  build: (k: Kit) => void;
  /** seconds to make */
  dur: number;
  /** the loudest point, of full scale */
  level: number;
}

const twoBumps = (t: number) => Math.max(Math.exp(-Math.pow((t - 0.2) / 0.13, 2)), Math.exp(-Math.pow((t - 0.68) / 0.13, 2)));

/** The sounds of LexiLink, as chosen from the candidates. */
const LEXI_SOUNDS = {
  /** a candy unwrapped: 紙の包みのカサッ (カサ…カサッ) */
  unwrap: {
    dur: 0.7,
    level: 0.6,
    build: (k) => {
      k.play(k.rustle(0.5, twoBumps), 0, [k.filt("bandpass", 2600, 0.5)], 0.8);
      k.play(k.crinkle(0.5, 300, twoBumps), 0, [k.filt("highpass", 1500), k.filt("lowpass", 6000)], 0.7);
    },
  },
  /** a pair taken, the candies eaten: ぽりぽり */
  crunch: {
    dur: 0.7,
    level: 0.65,
    build: (k) => [0, 0.17, 0.34].forEach((t, i) => k.crack(t, 1500, 1 - i * 0.2, 0.45, 0.016, 3, 4500)),
  },
  /** お手つき, wrapped again: 包み直すカサ */
  rewrap: {
    dur: 0.3,
    level: 0.45,
    build: (k) => k.play(k.crinkle(0.16, 600), 0, [k.filt("highpass", 2600), k.filt("lowpass", 8000)]),
  },
  /** the pair lights up: キラッ */
  sparkle: {
    dur: 0.5,
    level: 0.5,
    build: (k) => [1568, 2093, 2637].forEach((f, i) => k.tone(i * 0.045, f, 0.25, "sine", 0.4)),
  },
  /** 対戦 won: 高めのファンファーレ */
  win: {
    dur: 1.2,
    level: 0.55,
    build: (k) => {
      [784, 1047, 1319].forEach((f, i) => k.tone(i * 0.1, f, 0.2, "square", 0.3));
      k.tone(0.32, 1568, 0.7, "square", 0.25);
      k.tone(0.32, 1568, 0.7, "sine", 0.3);
    },
  },
  /** 対戦 drawn: やわらかい下降チャイム */
  draw: {
    dur: 0.7,
    level: 0.5,
    build: (k) => {
      k.tone(0, 659, 0.2, "sine", 0.5);
      k.tone(0.15, 523, 0.35, "sine", 0.5);
    },
  },
  /** the other player's turn: ポン */
  turn: { dur: 0.2, level: 0.4, build: (k) => k.tone(0, 880, 0.08, "sine", 0.5) },
} satisfies Record<string, Made>;

export type LexiSound = keyof typeof LEXI_SOUNDS;

/** Three takes of each (the crackles fall differently each time), made once. */
const made = new Map<LexiSound, Promise<AudioBuffer[]>>();

async function makeOne(spec: Made): Promise<AudioBuffer> {
  // made at the rate the device plays, so nothing is resampled as it plays
  const sr = ctx?.sampleRate ?? 48000;
  const oc = new OfflineAudioContext(1, Math.ceil(sr * spec.dur), sr);
  spec.build(kit(oc, oc.destination));
  const b = await oc.startRendering();
  const d = b.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak > 0) for (let i = 0; i < d.length; i++) d[i] *= spec.level / peak;
  const fade = Math.floor(sr * 0.01);
  for (let i = 0; i < fade; i++) d[d.length - 1 - i] *= i / fade;
  return b;
}

function takes(name: LexiSound): Promise<AudioBuffer[]> {
  let p = made.get(name);
  if (!p) {
    const spec: Made = LEXI_SOUNDS[name];
    p = Promise.all([0, 1, 2].map(() => makeOne(spec)));
    made.set(name, p);
  }
  return p;
}

/** Makes LexiLink's sounds ahead (when the app is idle, and again when a game opens if not yet), so
 * the first candy does not wait for its. */
export function prepareLexiSounds() {
  // the device first, for the rate the sounds are made at
  audio();
  try {
    (Object.keys(LEXI_SOUNDS) as LexiSound[]).forEach((n) => void takes(n).catch(() => undefined));
  } catch {
    /* no audio */
  }
}

export function playLexi(name: LexiSound) {
  const c = audio();
  if (!c) return;
  takes(name)
    .then((list) => {
      const s = c.createBufferSource();
      s.buffer = list[Math.floor(Math.random() * list.length)];
      s.connect(c.destination);
      s.start();
    })
    .catch(() => undefined);
}

/** A bright two-note chime for a 課題 done (ダイエット機能): kcal earned, not eaten. */
export function playDone() {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  tone(c, t, 784, 0.14, "sine", 0.09);
  tone(c, t + 0.1, 1175, 0.3, "sine", 0.09);
}
