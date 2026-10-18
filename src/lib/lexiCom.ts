// LexiLink のコンピューター（ふたりで対戦の後攻）。
//
// It plays from what a person at the table could know, and nothing more: a card is shown to it
// (`see`) only when it is turned face up, on either side's turn, and its choices are made from the
// cards that can still be chosen and the cards face up now (`ComView`). The board itself (the face
// of a card face down) is never handed to it. What it knows of a card is its place and its pair (a
// person who sees "accept" and later "受け入れる" knows the two belong together).
//
// The levels differ only in two numbers (`COM_LEVELS`): how likely a card shown is remembered, and
// how many places it can hold; the thinking is the same for all.

export type ComLevel = "easy" | "normal" | "hard";
export const COM_LEVEL_ORDER: ComLevel[] = ["easy", "normal", "hard"];

export interface ComSettings {
  label: string;
  /** how likely a card shown is remembered (0–1), drawn each time a card is shown */
  remember: number;
  /** how many places it can hold; past it, what was seen longest ago is forgotten */
  capacity: number;
}

/** To make the computer stronger or weaker, change these numbers. */
export const COM_LEVELS: Record<ComLevel, ComSettings> = {
  easy: { label: "やさしい", remember: 0.4, capacity: 4 },
  normal: { label: "普通", remember: 0.75, capacity: 10 },
  hard: { label: "難しい", remember: 1, capacity: 20 },
};

/** A card face up: its place on the board and the pair it belongs to. */
export interface ComFace {
  index: number;
  pair: number;
}

/** All the computer is given to choose by: the places still to choose from, and the cards face up. */
export interface ComView {
  /** places neither taken nor face up now */
  selectable: number[];
  /** the cards face up now (the first of the computer's two, once it has turned it) */
  open: ComFace[];
}

export class LexiCom {
  /** what it remembers: place → the pair there and when it was last seen (to forget the oldest) */
  private memory = new Map<number, { pair: number; seen: number }>();
  private clock = 0;

  constructor(
    readonly settings: ComSettings,
    private readonly rng: () => number = Math.random,
  ) {}

  /** A card turned face up (on either turn): remembered with the level's chance. A miss of the
   * chance forgets nothing already remembered. */
  see(card: ComFace) {
    this.clock++;
    if (this.rng() >= this.settings.remember) return;
    this.memory.set(card.index, { pair: card.pair, seen: this.clock });
    while (this.memory.size > this.settings.capacity) {
      let oldest: number | null = null;
      for (const [index, m] of this.memory) if (oldest === null || m.seen < this.memory.get(oldest)!.seen) oldest = index;
      this.memory.delete(oldest!);
    }
  }

  /** A pair taken (by either side): its places leave the memory. */
  forget(indices: number[]) {
    indices.forEach((i) => this.memory.delete(i));
  }

  /** A new game: nothing remembered. */
  reset() {
    this.memory.clear();
    this.clock = 0;
  }

  /** What it remembers now, place → pair (for checking and testing). */
  remembered(): Map<number, number> {
    return new Map([...this.memory].map(([i, m]) => [i, m.pair]));
  }

  /** The first card of its turn: one of a pair it remembers whole, else a place it knows nothing of
   * (else any place). */
  pickFirst(view: ComView): number | null {
    const can = new Set(view.selectable);
    const known = [...this.memory].filter(([i]) => can.has(i));
    for (const [i, m] of known) {
      if (known.some(([j, n]) => j !== i && n.pair === m.pair)) return i;
    }
    return this.unknownOr(view.selectable);
  }

  /** The second card, the first face up (`view.open`): its partner if remembered, else a place it
   * knows nothing of (else any place). The first card is recognised while it is face up, remembered
   * or not. */
  pickSecond(view: ComView): number | null {
    const first = view.open[0];
    if (!first) return this.pickFirst(view);
    const others = view.selectable.filter((i) => i !== first.index);
    const partner = others.find((i) => this.memory.get(i)?.pair === first.pair);
    if (partner !== undefined) return partner;
    return this.unknownOr(others);
  }

  private unknownOr(places: number[]): number | null {
    const unknown = places.filter((i) => !this.memory.has(i));
    const from = unknown.length > 0 ? unknown : places;
    return from.length > 0 ? from[Math.floor(this.rng() * from.length)] : null;
  }
}
