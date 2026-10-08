//! Calorie reward rules and the spaced-repetition schedule.
use crate::util::date_plus;

/// A missed question comes back the next day, as a review.
pub const RETRY_DAYS: i64 = 1;
/// A review that took misses before it was done (消化) comes back this many days later.
pub const REVIEW_AGAIN_DAYS: i64 = 3;

/// How many misses in a day's review bring it back `REVIEW_AGAIN_DAYS` after it is done: one for a
/// pick (選択・ヒアリング), three for what is typed or spoken (記入・発音), where a slip of a letter or
/// of the recognizer is a miss too.
pub fn misses_to_review_again(mode: &str) -> i64 {
    match mode {
        "typing" | "speaking" => 3,
        _ => 1,
    }
}

/// 選択問題は英単語 1 kcal、それ以外（複合語・慣用句・文法・フレーズ・例文）は 2 kcal。
pub const KCAL_WORD_CHOICE: i64 = 1;
pub const KCAL_CHOICE: i64 = 2;
pub const REVIEW_MULTIPLIER: f64 = 1.5;
pub const CHEAT_DAY_BONUS: i64 = 300;
/// 使わずに残ったカロリーの貯蓄が、この量に達するごとにお菓子引換券1枚になる。
pub const SAVINGS_PER_TICKET: i64 = 2000;

/// Pronunciation score below which the question is scheduled for review even if it "passed"
/// (60, `PASS_SCORE` in scoring.ts): the line a spoken question is cleared at (CLEAR_SCORE there).
pub const SPEAKING_REVIEW_THRESHOLD: f64 = 65.0;

/// A review left undone for more than this many days after it was due goes back to the ordinary
/// questions (`commands::release_stale_reviews`), so the reviews do not pile up.
pub const STALE_REVIEW_DAYS: i64 = 7;

/// What a question counts as for its reward: 英単語, 複合語 (a word question in the 複合語 tab:
/// several words, a phrasal verb being a 英単語), 慣用句, or a sentence (文法・フレーズ・例文・会話).
/// The level a question is marked with does not count.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scored {
    Word,
    Compound,
    Idiom,
    Sentence,
}

pub fn scored(kind: &str, tier: &str) -> Scored {
    match kind {
        "word" if tier == "compound" => Scored::Compound,
        "word" => Scored::Word,
        "idiom" => Scored::Idiom,
        _ => Scored::Sentence,
    }
}

/// 記入問題: 英単語 2、複合語 4、慣用句 5 kcal。文（例文・長文・フレーズ）は1語 1 kcal で、
/// `per_word_kcal` が別に数える。
pub fn typing_kcal(s: Scored) -> i64 {
    match s {
        Scored::Word => 2,
        Scored::Compound => 4,
        Scored::Idiom => 5,
        Scored::Sentence => 0,
    }
}

/// 聞く（ヒアリング）・話す（発音）問題: 英単語 1、複合語 2、慣用句 3、文法・フレーズ・例文 5 kcal。
pub fn spoken_kcal(s: Scored) -> i64 {
    match s {
        Scored::Word => 1,
        Scored::Compound => 2,
        Scored::Idiom => 3,
        Scored::Sentence => 5,
    }
}

/// kcal for a correct answer, by what the question is and how it was asked. Speaking is scaled
/// by the recognizer's score (80 points of a 5 kcal sentence is 4).
pub fn kcal_for(s: Scored, mode: &str, correct: bool, score: Option<f64>) -> i64 {
    if !correct {
        return 0;
    }
    match mode {
        "choice" if s == Scored::Word => KCAL_WORD_CHOICE,
        "choice" => KCAL_CHOICE,
        "typing" => typing_kcal(s),
        "speaking" => {
            let score = score.unwrap_or(100.0).clamp(0.0, 100.0);
            ((spoken_kcal(s) as f64) * score / 100.0).round() as i64
        }
        _ => spoken_kcal(s),
    }
}

pub fn apply_review_bonus(kcal: i64) -> i64 {
    ((kcal as f64) * REVIEW_MULTIPLIER).round() as i64
}

/// 文を書く記入問題（例文・長文・フレーズ）は答えの長さで配点する: 1語につき 1 kcal。
/// 一律の点だと、3語の文も15語の文も同じ価値になってしまうため。
pub fn scores_per_word(kind: &str, mode: &str) -> bool {
    mode == "typing" && matches!(kind, "phrase" | "sentence" | "expression")
}

/// 答えの単語数。空白で区切った語のうち、英字か数字を含むものを数える（"I" も "a" も1語、
/// "Let's" は1語、単独の記号は数えない）。フロントのヒント表示も同じ区切り方をする。
pub fn answer_word_count(answer: &str) -> i64 {
    answer
        .split_whitespace()
        .filter(|w| w.chars().any(char::is_alphanumeric))
        .count() as i64
}

/// 1語 1 kcal で、ヒントで開示した語1つにつき 1 kcal、打ち間違えた語1つにつき 1 kcal 減点する。
/// "He likes cooking." を "He like cooking." と答えたら 3 − 1 = 2 kcal。0 未満にはならない。
/// 不正解でも間違えた語の数が分からなければ（`mistakes` が無い）0 kcal のまま。
pub fn per_word_kcal(answer: &str, correct: bool, hints_used: i64, mistakes: Option<i64>) -> i64 {
    let missed = match (correct, mistakes) {
        (true, _) => 0,
        // 不正解なら少なくとも1語は違っている。
        (false, Some(m)) => m.max(1),
        (false, None) => return 0,
    };
    (answer_word_count(answer) - hints_used.max(0) - missed).max(0)
}

/// 記入問題のヒント（文の記入は `per_word_kcal` が1語ごとに減点する）。英単語は1語でも開示すると
/// 0 kcal、複合語・慣用句は1語開示するごとに半分（四捨五入）。
/// 回数は 0..=30 に丸める（`2f64.powi` が無限大になって i64 変換が飽和するのを防ぐ）。
pub fn apply_hint_penalty(s: Scored, kcal: i64, hints_used: i64) -> i64 {
    if hints_used <= 0 {
        return kcal;
    }
    if s == Scored::Word {
        return 0;
    }
    let halvings = hints_used.clamp(0, 30) as i32;
    ((kcal as f64) / 2f64.powi(halvings)).round() as i64
}

/// お菓子作りレシピの復習で1語正解したときのカロリーを 0.25 kcal 単位で数えたもの。その日はじめて
/// 正解した語は、意味を4択で選ぶと 0.5 kcal、日本語から英語を書くと 1 kcal。同じ日の2回目からは
/// その半分（0.25 / 0.5 kcal）で、3回目以降も同じ。
pub fn recipe_quarter_kcal(mode: &str, first_today: bool) -> Option<i64> {
    let full = match mode {
        "choice" => 2,
        "typing" => 4,
        _ => return None,
    };
    Some(if first_today { full } else { full / 2 })
}

/// 獲得カロリーは 1/8 kcal 単位で数える。どの報酬も 1 kcal か 0.25 kcal の整数倍なので、
/// がんばりモードで半分にしても、お気軽モードで 1.5 倍にしても割り切れる。
pub const EIGHTHS: i64 = 8;

/// 遊び方（モード）: がんばり（獲得カロリーが半分）・通常（等倍）・お気軽（1.5 倍）。
pub const PLAY_MODES: [&str; 3] = ["hard", "normal", "easy"];

/// A reward of `eighths` (1/8 kcal) under `play_mode`, still in eighths: がんばり ×0.5、通常 ×1、
/// お気軽 ×1.5. An unknown mode counts as 通常.
pub fn apply_play_mode(eighths: i64, play_mode: &str) -> i64 {
    let eighths = eighths.max(0);
    match play_mode {
        "hard" => eighths / 2,
        "easy" => eighths * 3 / 2,
        _ => eighths,
    }
}

/// The day's pending fraction (`pending` eighths) with `gained` eighths more: (whole kcal for the
/// day's budget, eighths left waiting). 小数点以下は切り捨てるが、端数は捨てずにその日の次の報酬と
/// 合わせる（0.5 + 0.25 + 0.25 = 1 kcal）。日付が変わると残った端数は切り捨てになる。
pub fn split_kcal(pending: i64, gained: i64) -> (i64, i64) {
    let total = pending.max(0) + gained.max(0);
    (total / EIGHTHS, total % EIGHTHS)
}

/// その日に使わずに残ったカロリー。食べすぎた日（マイナス）は貯蓄を減らさず 0 とする。
pub fn leftover_kcal(earned: i64, consumed: i64) -> i64 {
    (earned - consumed).max(0)
}

/// 貯蓄に `saved` kcal を足したあとの (残高, 新しく発行する引換券の枚数)。
/// 2,000 kcal ごとに1枚になり、端数は残高として次に持ち越す。
pub fn add_to_savings(balance: i64, saved: i64) -> (i64, i64) {
    let total = balance.max(0) + saved.max(0);
    (total % SAVINGS_PER_TICKET, total / SAVINGS_PER_TICKET)
}

/// Returns (new_level, needs_review, next_due_date). `due_on` is the day a review answered as one
/// (due today or before) was due, and `missed_today` how often that review was missed today, in
/// `mode`.
/// - A miss (or a low pronunciation score) of any other question goes to tomorrow's review.
/// - A miss of a due review keeps the day it was due: it stays in today's review until it is
///   answered right, and only what is left carries over to the next day.
/// - A review answered right is done (消化). If it was missed that day first (once for a pick, 3
///   times for typing or speaking: `misses_to_review_again`), it comes back 3 days later, and that
///   review goes by the same rule; otherwise it is asked no more. The level counts the reviews done.
pub fn next_state(
    level: i64,
    in_review: bool,
    due_on: Option<&str>,
    correct: bool,
    low_score: bool,
    missed_today: i64,
    mode: &str,
) -> (i64, bool, Option<String>) {
    if !correct || low_score {
        let due = due_on.map(str::to_string).unwrap_or_else(|| date_plus(RETRY_DAYS));
        return (0, true, Some(due));
    }
    if !in_review {
        return (level, false, None);
    }
    if missed_today >= misses_to_review_again(mode) {
        (level + 1, true, Some(date_plus(REVIEW_AGAIN_DAYS)))
    } else {
        (level + 1, false, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kcal_matches_spec() {
        use Scored::*;
        // What a question counts as: a compound is a word question of the 複合語 tab, a phrasal
        // verb a 英単語; every sentence-like kind is a sentence.
        assert_eq!(scored("word", "word"), Word);
        assert_eq!(scored("word", "compound"), Compound);
        assert_eq!(scored("idiom", "idiom"), Idiom);
        for kind in ["grammar", "phrase", "sentence", "expression", "dialogue"] {
            assert_eq!(scored(kind, "example"), Sentence, "{kind}");
        }
        assert_eq!(scored("phrase", "idiom"), Sentence, "a sentence using an idiom is a sentence");

        // 選択: 英単語 1、それ以外 2。
        assert_eq!(kcal_for(Word, "choice", true, None), 1);
        for s in [Compound, Idiom, Sentence] {
            assert_eq!(kcal_for(s, "choice", true, None), 2, "{s:?}");
        }
        // 記入: 英単語 2、複合語 4、慣用句 5。
        assert_eq!(kcal_for(Word, "typing", true, None), 2);
        assert_eq!(kcal_for(Compound, "typing", true, None), 4);
        assert_eq!(kcal_for(Idiom, "typing", true, None), 5);
        // ヒアリング・発音: 英単語 1、複合語 2、慣用句 3、文 5。発音はスコアで按分。
        for (s, kcal) in [(Word, 1), (Compound, 2), (Idiom, 3), (Sentence, 5)] {
            assert_eq!(kcal_for(s, "listening", true, None), kcal, "{s:?}");
            assert_eq!(kcal_for(s, "speaking", true, Some(100.0)), kcal, "{s:?}");
        }
        assert_eq!(kcal_for(Sentence, "speaking", true, Some(80.0)), 4);
        assert_eq!(kcal_for(Idiom, "speaking", false, Some(20.0)), 0);
        assert_eq!(kcal_for(Sentence, "choice", false, None), 0);
        assert_eq!(apply_review_bonus(10), 15);
    }

    #[test]
    fn a_hint_zeroes_a_word_and_halves_a_compound_or_an_idiom() {
        use Scored::*;
        assert_eq!(apply_hint_penalty(Word, 2, 0), 2);
        assert_eq!(apply_hint_penalty(Word, 2, 1), 0, "one revealed word and a word pays nothing");
        assert_eq!(apply_hint_penalty(Word, 3, 2), 0, "nor does its review");
        assert_eq!(apply_hint_penalty(Compound, 4, 1), 2);
        assert_eq!(apply_hint_penalty(Compound, 4, 2), 1);
        assert_eq!(apply_hint_penalty(Idiom, 5, 1), 3, "2.5 rounds up");
        assert_eq!(apply_hint_penalty(Idiom, 5, 2), 1);
        assert_eq!(apply_hint_penalty(Idiom, 0, 3), 0, "a wrong answer stays at zero");
        assert_eq!(apply_hint_penalty(Idiom, 10, -1), 10, "negative counts never add kcal");
        assert_eq!(apply_hint_penalty(Idiom, 10, 99), 0, "an absurd count just zeroes the reward");
        assert!(
            apply_hint_penalty(Idiom, i64::MAX, i64::MAX) < i64::MAX,
            "huge counts must not overflow the exponent and saturate back up"
        );
    }

    #[test]
    fn mid_typing_pays_a_calorie_per_word_less_one_per_hint() {
        for kind in ["phrase", "sentence", "expression"] {
            assert!(scores_per_word(kind, "typing"), "{kind}");
            assert!(!scores_per_word(kind, "choice"), "{kind}");
        }
        assert!(!scores_per_word("word", "typing"));
        assert!(!scores_per_word("idiom", "typing"));

        let answer = "She kept the leftovers in the fridge.";
        assert_eq!(answer_word_count(answer), 7);
        assert_eq!(per_word_kcal(answer, true, 0, None), 7);
        assert_eq!(per_word_kcal(answer, true, 2, None), 5);
        assert_eq!(per_word_kcal(answer, true, 7, None), 0);
        assert_eq!(per_word_kcal(answer, true, 99, None), 0, "never below zero");
        assert_eq!(per_word_kcal(answer, true, -3, None), 7, "negative counts never add kcal");
        assert_eq!(per_word_kcal(answer, true, 0, Some(3)), 7, "a correct answer has no mistakes to charge");

        // A slip costs the word it was in, not the whole answer.
        assert_eq!(per_word_kcal("He likes cooking.", false, 0, Some(1)), 2);
        assert_eq!(per_word_kcal("He likes cooking.", false, 1, Some(1)), 1, "hint and slip both count");
        assert_eq!(per_word_kcal("He likes cooking.", false, 0, Some(5)), 0);
        assert_eq!(per_word_kcal("He likes cooking.", false, 0, Some(0)), 2, "wrong means at least one word off");
        assert_eq!(per_word_kcal(answer, false, 0, None), 0, "no count, no partial credit");
        // Contractions are one word; a lone dash is not a word at all.
        assert_eq!(answer_word_count("Let's go - I think it's time."), 6);
    }

    #[test]
    fn recipe_reviews_pay_in_quarters_and_half_after_the_first_time_a_day() {
        // The first right answer of the day for a word: 0.5 / 1 kcal; again that day: half of it.
        assert_eq!(recipe_quarter_kcal("choice", true), Some(2));
        assert_eq!(recipe_quarter_kcal("typing", true), Some(4));
        assert_eq!(recipe_quarter_kcal("choice", false), Some(1));
        assert_eq!(recipe_quarter_kcal("typing", false), Some(2));
        assert_eq!(recipe_quarter_kcal("speaking", true), None);
    }

    #[test]
    fn play_modes_scale_every_reward_and_fractions_wait_for_the_next() {
        // がんばり ×0.5、通常 ×1、お気軽 ×1.5, in eighths of a calorie.
        assert_eq!(apply_play_mode(8, "hard"), 4);
        assert_eq!(apply_play_mode(8, "normal"), 8);
        assert_eq!(apply_play_mode(8, "easy"), 12);
        assert_eq!(apply_play_mode(2, "hard"), 1, "a quarter halved is an eighth");
        assert_eq!(apply_play_mode(2, "easy"), 3);
        assert_eq!(apply_play_mode(16, "unknown"), 16, "anything else is 通常");
        assert_eq!(apply_play_mode(-8, "easy"), 0, "nothing is ever taken back");
        for m in PLAY_MODES {
            for kcal in 0..20 {
                for quarters in [kcal * 4, kcal * 4 + 1, kcal * 4 + 2] {
                    let eighths = quarters * 2;
                    let scaled = apply_play_mode(eighths, m) as f64;
                    let exact = eighths as f64 * if m == "hard" { 0.5 } else if m == "easy" { 1.5 } else { 1.0 };
                    assert_eq!(scaled, exact, "{m}: {eighths} eighths must divide evenly");
                }
            }
        }
        // Words picked in がんばり: 0.5 → 0, 1.0 → +1. A pending half joins the next reward.
        assert_eq!(split_kcal(0, 4), (0, 4));
        assert_eq!(split_kcal(4, 4), (1, 0));
        assert_eq!(split_kcal(4, 12), (2, 0), "0.5 + 1.5 = 2");
        assert_eq!(split_kcal(7, 1), (1, 0));
        assert_eq!(split_kcal(3, 16), (2, 3));
        assert_eq!(split_kcal(5, -2), (0, 5), "nothing is ever taken back");
    }

    #[test]
    fn leftovers_fill_savings_and_every_2000_becomes_a_ticket() {
        assert_eq!(leftover_kcal(600, 400), 200);
        assert_eq!(leftover_kcal(100, 300), 0, "an over-eaten day takes nothing out of savings");
        assert_eq!(add_to_savings(0, 200), (200, 0));
        assert_eq!(add_to_savings(1900, 100), (0, 1));
        assert_eq!(add_to_savings(1900, 2250), (150, 2));
        assert_eq!(add_to_savings(500, -50), (500, 0), "nothing negative is ever saved");
    }

    #[test]
    fn srs_progression() {
        let tomorrow = date_plus(1);
        let again = Some(date_plus(3));
        assert_eq!(next_state(3, false, None, false, false, 0, "choice"), (0, true, Some(tomorrow.clone())), "a miss: tomorrow's review");
        assert_eq!(next_state(0, false, None, true, true, 0, "speaking"), (0, true, Some(tomorrow)), "a low score too");
        assert_eq!(next_state(0, true, Some("2026-01-01"), true, false, 0, "choice"), (1, false, None), "a review right at once: done");
        // A pick missed once that day comes back 3 days later; typed or spoken, three misses do.
        assert_eq!(next_state(0, true, Some("2026-01-01"), true, false, 1, "choice"), (1, true, again.clone()));
        assert_eq!(next_state(0, true, Some("2026-01-01"), true, false, 1, "listening"), (1, true, again.clone()));
        assert_eq!(next_state(0, true, Some("2026-01-01"), true, false, 2, "typing"), (1, false, None), "two slips: done");
        assert_eq!(next_state(0, true, Some("2026-01-01"), true, false, 3, "typing"), (1, true, again.clone()));
        assert_eq!(next_state(0, true, Some("2026-01-01"), true, false, 3, "speaking"), (1, true, again.clone()));
        // The review 3 days later goes by the same rule.
        assert_eq!(next_state(1, true, Some("2026-01-04"), true, false, 1, "choice"), (2, true, again));
        assert_eq!(next_state(2, true, Some("2026-01-07"), true, false, 0, "choice"), (3, false, None));
        assert_eq!(next_state(2, false, None, true, false, 0, "choice"), (2, false, None));
        // A missed review stays on the day it was due, so it is still due today and carries over.
        assert_eq!(next_state(2, true, Some("2026-01-01"), false, false, 1, "choice"), (0, true, Some("2026-01-01".to_string())));
        assert_eq!(next_state(2, true, Some("2026-01-01"), true, true, 0, "speaking"), (0, true, Some("2026-01-01".to_string())));
    }
}
