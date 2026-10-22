// LexiLink のコンピューター（ふたりで対戦の 2P。先攻か後攻かは毎回ランダム）。
//
// It plays from what a person at the table could know, and nothing more: a card is shown to it
// (`see`) only when it is turned face up, on either side's turn, and its choices are made from the
// cards that can still be chosen and the cards face up now (`ComView`). The board itself (the face
// of a card face down) is never handed to it. What it knows of a card is its place and its pair (a
// person who sees "accept" and later "受け入れる" knows the two belong together).
//
// Remembering and recalling are two steps. A card shown is stored with the level's chance of
// remembering (記憶), up to the level's capacity. Before each card it chooses, it draws once whether
// it can recall what it stored (想起): if it can, that choice may use the memory; if it cannot, the
// choice is made at random among the cards face down, as if it remembered nothing, and the memory
// itself stays as it was for the next choice.
//
// The levels differ only in three numbers (`COM_LEVELS`); the thinking is the same for all.

import type { ComLevel } from "../types";

export type { ComLevel };
export const COM_LEVEL_ORDER: ComLevel[] = ["easy", "normal", "hard"];

export interface ComSettings {
  label: string;
  /** 記憶確率: how likely a card shown is stored (0–1, not a percentage), drawn each time a card is shown */
  remember: number;
  /** 記憶上限: how many places it can hold; past it, what was seen longest ago is forgotten */
  capacity: number;
  /** 想起確率: how likely it can use what it stored for one choice (0–1), drawn before each card it chooses */
  recall: number;
}

/** To make the computer stronger or weaker, change these numbers (the chances are 0–1: 0.3 is 30%). */
export const COM_LEVELS: Record<ComLevel, ComSettings> = {
  easy: { label: "やさしい", remember: 0.3, capacity: 4, recall: 0.5 },
  normal: { label: "普通", remember: 0.5, capacity: 6, recall: 0.7 },
  hard: { label: "難しい", remember: 1, capacity: 20, recall: 1 },
};

/** A card face up: its place on the board and the pair it belongs to. */
export interface ComFace {
  index: number;
  pair: number;
}

/** All the computer is given to choose by: the places still to choose from, and the cards face up. */
export interface ComView {
  /** places face down: neither taken nor face up now */
  selectable: number[];
  /** the cards face up now (the first of the computer's two, once it has turned it) */
  open: ComFace[];
}

export class LexiCom {
  /** what it stored: place → the pair there and when it was last seen (to forget the oldest) */
  private memory = new Map<number, { pair: number; seen: number }>();
  private clock = 0;

  constructor(
    readonly settings: ComSettings,
    private readonly rng: () => number = Math.random,
    /** the developer's log: each storing, each recall drawn and why each card was chosen */
    private readonly log: (line: string) => void = () => undefined,
  ) {
    const chance = (name: string, p: number) => {
      if (!(p >= 0 && p <= 1)) throw new Error(`LexiCom: ${name} は 0〜1 で書きます（${p}）。30% なら 0.3`);
    };
    chance("remember", settings.remember);
    chance("recall", settings.recall);
    if (!Number.isInteger(settings.capacity) || settings.capacity < 0) throw new Error(`LexiCom: capacity は 0 以上の整数です（${settings.capacity}）`);
  }

  /** 記憶: a card turned face up (on either turn) is stored with the level's chance. A miss of the
   * chance forgets nothing already stored. */
  see(card: ComFace) {
    this.clock++;
    const roll = this.rng();
    if (roll >= this.settings.remember) {
      this.log(`記憶 失敗（${roll.toFixed(2)} ≥ ${this.settings.remember}）: 位置 ${card.index} は覚えない（記憶 ${this.memory.size}/${this.settings.capacity}）`);
      return;
    }
    this.memory.set(card.index, { pair: card.pair, seen: this.clock });
    let forgot = "";
    while (this.memory.size > this.settings.capacity) {
      let oldest: number | null = null;
      for (const [index, m] of this.memory) if (oldest === null || m.seen < this.memory.get(oldest)!.seen) oldest = index;
      this.memory.delete(oldest!);
      forgot += `、上限を超えたので位置 ${oldest} を忘れた`;
    }
    this.log(`記憶 成功（${roll.toFixed(2)} < ${this.settings.remember}）: 位置 ${card.index} を覚えた${forgot}（記憶 ${this.memory.size}/${this.settings.capacity}）`);
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

  /** What it stored now, place → pair (for checking and testing; its choices go through `recall`). */
  remembered(): Map<number, number> {
    return new Map([...this.memory].map(([i, m]) => [i, m.pair]));
  }

  /** 想起: drawn once for one choice. Recalled, what it stored (place → pair) is usable for that
   * choice; not recalled, nothing is (null), and the memory stays as it is. */
  private recall(choice: string): Map<number, number> | null {
    const roll = this.rng();
    const ok = roll < this.settings.recall;
    this.log(`${choice}: 想起 ${ok ? "成功" : "失敗"}（${roll.toFixed(2)} ${ok ? "<" : "≥"} ${this.settings.recall}、記憶 ${this.memory.size}枚）`);
    return ok ? this.remembered() : null;
  }

  /** The first card of its turn. Recalled: one of a pair it remembers whole, else a place it knows
   * nothing of (else any place). Not recalled: any card face down, at random. The second is not
   * decided here: it gets a recall of its own. */
  pickFirst(view: ComView): number | null {
    const recalled = this.recall("1枚目");
    if (!recalled) return this.random(view.selectable, "1枚目: 記憶を使わず、裏向きのカードからランダム");
    const can = new Set(view.selectable);
    const known = [...recalled].filter(([i]) => can.has(i));
    for (const [i, pair] of known) {
      const partner = known.find(([j, p]) => j !== i && p === pair);
      if (partner) {
        this.log(`1枚目: 覚えているペア（位置 ${i} と ${partner[0]}）の ${i} を選んだ`);
        return i;
      }
    }
    const unknown = view.selectable.filter((i) => !recalled.has(i));
    if (unknown.length > 0) return this.random(unknown, "1枚目: そろったペアを覚えていないので、覚えていない位置からランダム");
    return this.random(view.selectable, "1枚目: 覚えていない位置がないので、裏向きのカードからランダム");
  }

  /** The second card, the first face up (`view.open`, recognised whether recalled or not).
   * Recalled: the first's partner if it remembers it. Not recalled, or the partner not remembered:
   * any card face down but the first, at random. */
  pickSecond(view: ComView): number | null {
    const first = view.open[0];
    if (!first) return this.pickFirst(view);
    const others = view.selectable.filter((i) => i !== first.index);
    const recalled = this.recall("2枚目");
    if (!recalled) return this.random(others, `2枚目: 記憶を使わず、1枚目（位置 ${first.index}）以外の裏向きのカードからランダム`);
    const partner = others.find((i) => recalled.get(i) === first.pair);
    if (partner !== undefined) {
      this.log(`2枚目: 1枚目（位置 ${first.index}）の相手を覚えていた → 位置 ${partner} を選んだ`);
      return partner;
    }
    return this.random(others, `2枚目: 1枚目（位置 ${first.index}）の相手を覚えていないので、1枚目以外の裏向きのカードからランダム`);
  }

  /** A place among `places` at random (the faces of the cards are not looked at). */
  private random(places: number[], why: string): number | null {
    if (places.length === 0) {
      this.log(`${why}: 選べるカードがない`);
      return null;
    }
    const pick = places[Math.floor(this.rng() * places.length)];
    this.log(`${why}（候補 ${places.length}枚）→ 位置 ${pick} を選んだ`);
    return pick;
  }
}
