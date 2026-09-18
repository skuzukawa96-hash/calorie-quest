//! Calorie reward rules and the spaced-repetition schedule.
use crate::util::date_plus;

/// Review intervals in days, indexed by SRS level (翌日 → 3日後 → 1週間後 → 2週間後 → 1か月後).
pub const INTERVALS: [i64; 5] = [1, 3, 7, 14, 30];

/// kcal per correct answer. 10 correct = 50 / 100 / 250 kcal as in the spec.
pub const KCAL_LOW: i64 = 5;
pub const KCAL_MID: i64 = 10;
pub const KCAL_HIGH: i64 = 25;
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
        assert_eq!(kcal_for("low", "choice", true, None) * 10, 50);
        assert_eq!(kcal_for("mid", "typing", true, None) * 10, 100);
        assert_eq!(kcal_for("high", "speaking", true, Some(100.0)) * 10, 250);
        assert_eq!(kcal_for("high", "speaking", true, Some(80.0)), 20);
        assert_eq!(kcal_for("high", "speaking", false, Some(20.0)), 0);
        assert_eq!(apply_review_bonus(10), 15);
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
