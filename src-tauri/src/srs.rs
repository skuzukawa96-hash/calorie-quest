//! Calorie reward rules and the spaced-repetition schedule.
use crate::util::date_plus;

/// Review intervals in days, indexed by SRS level (翌日 → 3日後 → 1週間後 → 2週間後 → 1か月後).
pub const INTERVALS: [i64; 5] = [1, 3, 7, 14, 30];

/// kcal per correct answer. 10 correct = 20 / 40 / 100 kcal.
pub const KCAL_LOW: i64 = 2;
pub const KCAL_MID: i64 = 4;
pub const KCAL_HIGH: i64 = 10;
pub const REVIEW_MULTIPLIER: f64 = 1.5;
pub const CHEAT_DAY_BONUS: i64 = 300;

/// Pronunciation score below which the question is scheduled for review even if it "passed".
pub const SPEAKING_REVIEW_THRESHOLD: f64 = 70.0;

pub fn base_kcal(difficulty: &str) -> i64 {
    match difficulty {
        "low" => KCAL_LOW,
        "mid" => KCAL_MID,
        "high" => KCAL_HIGH,
        _ => KCAL_LOW,
    }
}

pub fn kcal_for(difficulty: &str, mode: &str, correct: bool, score: Option<f64>) -> i64 {
    if !correct {
        return 0;
    }
    let base = base_kcal(difficulty);
    if mode == "speaking" {
        let s = score.unwrap_or(100.0).clamp(0.0, 100.0);
        ((base as f64) * s / 100.0).round() as i64
    } else {
        base
    }
}

pub fn apply_review_bonus(kcal: i64) -> i64 {
    ((kcal as f64) * REVIEW_MULTIPLIER).round() as i64
}

/// 中難易度の記入問題（フレーズ）は答えの長さで配点する: 1語につき 1 kcal。
/// 一律 4 kcal だと、3語のフレーズも10語のフレーズも同じ価値になってしまうため。
pub fn scores_per_word(difficulty: &str, mode: &str) -> bool {
    difficulty == "mid" && mode == "typing"
}

/// 答えの単語数。空白で区切った語のうち、英字か数字を含むものを数える（"I" も "a" も1語、
/// "Let's" は1語、単独の記号は数えない）。フロントのヒント表示も同じ区切り方をする。
pub fn answer_word_count(answer: &str) -> i64 {
    answer
        .split_whitespace()
        .filter(|w| w.chars().any(char::is_alphanumeric))
        .count() as i64
}

/// 1語 1 kcal で、ヒントで開示した語1つにつき 1 kcal 減点する。0 未満にはならない。
pub fn per_word_kcal(answer: &str, correct: bool, hints_used: i64) -> i64 {
    if !correct {
        return 0;
    }
    (answer_word_count(answer) - hints_used.max(0)).max(0)
}

/// ヒントで1語開示するごとに獲得カロリーを半分にする（中難易度の記入問題以外）。
/// 回数は 0..=30 に丸める（`2f64.powi` が無限大になって i64 変換が飽和するのを防ぐ）。
pub fn apply_hint_penalty(kcal: i64, hints_used: i64) -> i64 {
    let halvings = hints_used.clamp(0, 30) as i32;
    ((kcal as f64) / 2f64.powi(halvings)).round() as i64
}

/// Returns (new_level, needs_review, next_due_date).
pub fn next_state(level: i64, in_review: bool, correct: bool, low_score: bool) -> (i64, bool, Option<String>) {
    if !correct || low_score {
        return (0, true, Some(date_plus(INTERVALS[0])));
    }
    if in_review {
        let next = level + 1;
        if next as usize >= INTERVALS.len() {
            (next, false, None)
        } else {
            (next, true, Some(date_plus(INTERVALS[next as usize])))
        }
    } else {
        (level, false, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kcal_matches_spec() {
        assert_eq!(kcal_for("low", "choice", true, None) * 10, 20);
        assert_eq!(kcal_for("mid", "typing", true, None) * 10, 40);
        assert_eq!(kcal_for("high", "speaking", true, Some(100.0)) * 10, 100);
        assert_eq!(kcal_for("high", "speaking", true, Some(80.0)), 8);
        assert_eq!(kcal_for("high", "speaking", false, Some(20.0)), 0);
        assert_eq!(apply_review_bonus(10), 15);
    }

    #[test]
    fn each_revealed_hint_word_halves_the_reward() {
        assert_eq!(apply_hint_penalty(10, 0), 10);
        assert_eq!(apply_hint_penalty(10, 1), 5);
        assert_eq!(apply_hint_penalty(10, 2), 3, "2.5 rounds up");
        assert_eq!(apply_hint_penalty(10, 3), 1);
        assert_eq!(apply_hint_penalty(0, 3), 0, "a wrong answer stays at zero");
        assert_eq!(apply_hint_penalty(10, -1), 10, "negative counts never add kcal");
        assert_eq!(apply_hint_penalty(10, 99), 0, "an absurd count just zeroes the reward");
        assert!(
            apply_hint_penalty(i64::MAX, i64::MAX) < i64::MAX,
            "huge counts must not overflow the exponent and saturate back up"
        );
    }

    #[test]
    fn mid_typing_pays_a_calorie_per_word_less_one_per_hint() {
        assert!(scores_per_word("mid", "typing"));
        assert!(!scores_per_word("mid", "choice"));
        assert!(!scores_per_word("low", "typing"));
        assert!(!scores_per_word("high", "typing"));

        let answer = "She kept the leftovers in the fridge.";
        assert_eq!(answer_word_count(answer), 7);
        assert_eq!(per_word_kcal(answer, true, 0), 7);
        assert_eq!(per_word_kcal(answer, true, 2), 5);
        assert_eq!(per_word_kcal(answer, true, 7), 0);
        assert_eq!(per_word_kcal(answer, true, 99), 0, "never below zero");
        assert_eq!(per_word_kcal(answer, true, -3), 7, "negative counts never add kcal");
        assert_eq!(per_word_kcal(answer, false, 0), 0);
        // Contractions are one word; a lone dash is not a word at all.
        assert_eq!(answer_word_count("Let's go - I think it's time."), 6);
    }

    #[test]
    fn srs_progression() {
        let (l, r, d) = next_state(3, false, false, false);
        assert_eq!((l, r), (0, true));
        assert!(d.is_some());
        let (l, r, _) = next_state(0, true, true, false);
        assert_eq!((l, r), (1, true));
        let (l, r, d) = next_state(4, true, true, false);
        assert_eq!((l, r, d), (5, false, None));
        let (l, r, _) = next_state(2, false, true, false);
        assert_eq!((l, r), (2, false));
    }
}
