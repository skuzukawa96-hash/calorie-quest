// What each sound of the IPA line means and how to make it, for Japanese learners. The keys are
// exactly the sounds `src-tauri/data/pronunciations.json` is written in (`db::IPA_SEGMENTS`).
import type { TipKey } from "./scoring";

export interface PhonemeTip {
  /** what kind of sound, shown after the symbol */
  kind: string;
  text: string;
  sample: string;
  /** the mouth diagram that shows it, for the sounds that have one */
  diagram?: TipKey;
}

export const PHONEMES: Record<string, PhonemeTip> = {
  // ---- vowels ----
  "iː": { kind: "長い「イー」", text: "唇を左右に引き、舌の前の部分を高く上げて長めに伸ばします。", sample: "see / eat / green" },
  i: { kind: "弱い「イ」", text: "語の終わりなどに出る、力を抜いた短い「イ」。伸ばしません。", sample: "happy / city / money" },
  ɪ: { kind: "短い「イ」", text: "日本語の「イ」と「エ」の中間。唇の力を抜いて、短く緩く言います。", sample: "sit / big / English" },
  eɪ: { kind: "「エイ」", text: "「エ」から「イ」へなめらかに移ります。「エー」と伸ばさないのがコツ。", sample: "day / make / great" },
  ɛ: { kind: "「エ」", text: "日本語の「エ」に近い音ですが、口をもう少し大きく開けます。", sample: "bed / red / many" },
  æ: { kind: "「ア」と「エ」の間", text: "「エ」の口の形のまま「ア」と言う音。口を横に大きく開き、あごをしっかり下げます。", sample: "cat / apple / have" },
  ɑ: { kind: "口を大きく開けた「ア」", text: "口を縦に大きく開け、のどの奥から明るく「ア」と出します。", sample: "hot / father / stop" },
  "ɑː": { kind: "長い「アー」", text: "口を大きく開けて「アー」と伸ばし、続く r で舌を奥へ引きます。", sample: "car / star / park" },
  "ɔː": { kind: "「オー」", text: "唇を少し丸め、口を縦に開いて「オー」。日本語の「オ」より口を大きく開けます。", sample: "thought / water / more" },
  oʊ: { kind: "「オウ」", text: "「オ」から唇をすぼめて「ウ」へ移ります。「オー」と伸ばさないのがコツ。", sample: "go / home / boat" },
  ɔɪ: { kind: "「オイ」", text: "唇を丸めた「オ」から「イ」へ移ります。", sample: "boy / enjoy / voice" },
  aɪ: { kind: "「アイ」", text: "口を大きく開けた「ア」から「イ」へ。「ア」をはっきり言います。", sample: "time / high / buy" },
  aʊ: { kind: "「アウ」", text: "口を大きく開けた「ア」から、唇をすぼめて「ウ」へ移ります。", sample: "now / house / about" },
  ʊ: { kind: "短い「ウ」", text: "唇を軽く丸めた短い「ウ」。力を入れず、伸ばしません。", sample: "book / good / put" },
  "uː": { kind: "長い「ウー」", text: "唇を小さく丸めて前に突き出し、「ウー」と伸ばします。日本語の「ウ」より唇を使います。", sample: "food / blue / school" },
  u: { kind: "弱い「ウ」", text: "アクセントのない所の、軽く短い「ウ」。", sample: "into / to / influence" },
  ʌ: { kind: "短く強い「ア」", text: "口をあまり開けずに、短くはっきり「ア」。のどの奥から出します。", sample: "cup / love / money" },
  ə: { kind: "あいまい母音", text: "口の力を抜き、弱く短く「ア」と「ウ」の間の音。アクセントのない音節で一番よく出る音です。", sample: "about / banana / the" },
  "ɜːr": { kind: "「アー」と r の響き", text: "口をあまり開けず、舌を奥へ引いて丸めながら「アー」。最初から最後まで r の響きがあります。", sample: "bird / work / learn", diagram: "r" },
  ər: { kind: "弱い「アr」", text: "あいまい母音 ə に r の響きを付けます。語尾の -er / -or によく出ます。", sample: "teacher / water / doctor", diagram: "r" },

  // ---- consonants ----
  p: { kind: "息の破裂音", text: "唇を閉じて息をため、ぱっと離します。語頭では「プッ」と息が強く出ます。", sample: "pen / apple / stop" },
  b: { kind: "声の破裂音", text: "p と同じ口の形で、声を出しながら唇を離します。", sample: "big / baby / job" },
  t: { kind: "息の破裂音", text: "舌先を上の歯ぐきに当ててはじきます。「トゥ」と母音を付けないように。", sample: "top / time / cat" },
  d: { kind: "声の破裂音", text: "t と同じ位置で、声を出しながら舌先をはじきます。", sample: "day / ladder / good" },
  k: { kind: "息の破裂音", text: "舌の奥を上あごの奥に付け、息ではじきます。", sample: "cat / key / book" },
  ɡ: { kind: "声の破裂音", text: "k と同じ位置で、声を出しながらはじきます。", sample: "go / bag / big" },
  f: { kind: "息の摩擦音", text: "上の前歯を下唇に軽く当て、すき間から息だけを出します。「フ」にならないように。", sample: "fish / coffee / if", diagram: "fv" },
  v: { kind: "声の摩擦音", text: "f の口の形のまま声を出し、下唇を震わせます。「ブ」にしないのがコツ。", sample: "very / seven / have", diagram: "fv" },
  θ: { kind: "息の th", text: "舌先を上下の前歯で軽く挟み、すき間から息を出します。「ス」にならないように。", sample: "three / think / bath", diagram: "th" },
  ð: { kind: "声の th", text: "θ と同じ舌の位置で声を出します。「ズ」「ダ」にならないように。", sample: "this / mother / the", diagram: "th" },
  s: { kind: "息の摩擦音", text: "舌先を歯ぐきに近づけ、すき間から息を出します。「シ」にならないように（see と she は別の音）。", sample: "sea / sit / bus" },
  z: { kind: "声の摩擦音", text: "s の形のまま声を出します。舌先をどこにも付けず、すき間から鳴らします。", sample: "zoo / easy / is" },
  ʃ: { kind: "「シュ」", text: "唇を少し丸めて突き出し、舌を歯ぐきの少し後ろに近づけて息を出します。", sample: "she / fish / nation" },
  ʒ: { kind: "「ジュ」", text: "ʃ の形のまま声を出します。舌をどこにも付けず、柔らかく。", sample: "measure / usually / vision" },
  h: { kind: "息だけの「ハ」", text: "口の形は次の母音のまま、のどから息だけを出します。who は「フー」ではなく h の息で。", sample: "hat / who / ahead" },
  tʃ: { kind: "「チ」", text: "舌先を歯ぐきに付けてから、唇を少し突き出して「チ」とはじきます。", sample: "church / teacher / much" },
  dʒ: { kind: "「ヂ」", text: "tʃ と同じ形で、声を出しながらはじきます。", sample: "judge / job / age" },
  m: { kind: "鼻音", text: "唇を閉じて鼻から声を出します。語尾でも唇をしっかり閉じたまま。", sample: "man / summer / time" },
  n: { kind: "鼻音", text: "舌先を歯ぐきに付けて鼻から声を出します。語尾でも舌を付けたまま終えます。", sample: "no / dinner / sun" },
  ŋ: { kind: "鼻音「ング」の「ン」", text: "舌の奥を上あごの奥に付けて鼻から声を出します。最後に「グ」をはっきり付けないように。", sample: "sing / long / thinking" },
  l: { kind: "L の音", text: "舌先を上の歯ぐきにしっかり当て、舌の両わきから声を出します。語尾の l は「ウ」に近く聞こえます。", sample: "light / feel / hello", diagram: "l" },
  r: { kind: "R の音", text: "舌先はどこにも触れず、舌を後ろに引いて浮かせ、唇を軽く丸めます。", sample: "red / right / sorry", diagram: "r" },
  w: { kind: "W の音", text: "唇を強く丸めて突き出し、すぐ次の母音へ滑らせます。", sample: "we / water / one", diagram: "w" },
  j: { kind: "ヤ行の子音", text: "舌の中ほどを上あごに近づけて「ヤ・ユ・ヨ」の最初の音。year は ear と違って j から始まります。", sample: "yes / you / year" },
};

/** The stress mark: not a sound, but where the word is said strongest. */
export const STRESS_MARK = "ˈ";
