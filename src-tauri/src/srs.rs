//! Calorie reward rules and the spaced-repetition schedule.
use crate::util::date_plus;

/// Review intervals in days, indexed by SRS level (翌日 → 3日後 → 1週間後 → 2週間後 → 1か月後).
pub const INTERVALS: [i64; 5] = [1, 3, 7, 14, 30];

/// kcal per correct answer. 10 correct = 20 / 40 / 100 kcal.
pub const KCAL_LOW: i64 = 2;
pub const KCAL_MID: i64 = 4;
pub const KCAL_HIGH: i64 = 10;
/// 英単語以外の選択問題は、種類にかかわらず 4 kcal。
pub const KCAL_CHOICE: i64 = 4;
/// 慣用句の記入問題は 6 kcal（例文・長文・フレーズの記入は 1語 1 kcal）。
pub const KCAL_IDIOM_TYPING: i64 = 6;
pub const REVIEW_MULTIPLIER: f64 = 1.5;
pub const CHEAT_DAY_BONUS: i64 = 300;
/// 使わずに残ったカロリーの貯蓄が、この量に達するごとにお菓子引換券1枚になる。
pub const SAVINGS_PER_TICKET: i64 = 2000;

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

/// kcal for a correct answer. Listening and speaking follow the question's level (低2/中4/高10,
/// speaking scaled by the score); choice pays 4 for anything but a word, and typing an idiom 6.
/// Typing a sentence (例文・長文・フレーズ) is paid per word instead, see `scores_per_word`.
pub fn kcal_for(kind: &str, difficulty: &str, mode: &str, correct: bool, score: Option<f64>) -> i64 {
    if !correct {
        return 0;
    }
    let base = base_kcal(difficulty);
    match mode {
        "speaking" => {
            let s = score.unwrap_or(100.0).clamp(0.0, 100.0);
            ((base as f64) * s / 100.0).round() as i64
        }
        "choice" if kind != "word" => KCAL_CHOICE,
        "typing" if kind == "idiom" => KCAL_IDIOM_TYPING,
        _ => base,
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

/// ヒントで1語開示するごとに獲得カロリーを半分にする（中難易度の記入問題以外）。
/// 回数は 0..=30 に丸める（`2f64.powi` が無限大になって i64 変換が飽和するのを防ぐ）。
pub fn apply_hint_penalty(kcal: i64, hints_used: i64) -> i64 {
    let halvings = hints_used.clamp(0, 30) as i32;
    ((kcal as f64) / 2f64.powi(halvings)).round() as i64
}

/// お菓子作りレシピの復習で1語正解したときのカロリーを 0.5 kcal 単位で数えたもの。
/// 意味を4択で選ぶと 0.5 kcal、日本語から英語を書くと 1 kcal。
pub fn recipe_half_kcal(mode: &str) -> Option<i64> {
    match mode {
        "choice" => Some(1),
        "typing" => Some(2),
        _ => None,
    }
}

/// その日のレシピ復習で貯まった 0.5 kcal 単位の点が `before` から `gained` 増えたとき、今日の
/// 獲得カロリーに足す kcal。小数点以下は切り捨てるが、端数は捨てずにその日の次の正解と合わせる
/// （0.5 + 0.5 = 1 kcal）。日付が変わると残った 0.5 kcal は切り捨てになる。
pub fn recipe_kcal_gain(before: i64, gained: i64) -> i64 {
    let before = before.max(0);
    (before + gained.max(0)) / 2 - before / 2
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
        // Words keep their level: 2 kcal whichever way they are asked.
        assert_eq!(kcal_for("word", "low", "choice", true, None) * 10, 20);
        assert_eq!(kcal_for("word", "low", "typing", true, None), 2);
        // Anything else picked from four pays 4, whatever its level.
        for kind in ["grammar", "phrase", "expression", "idiom", "sentence"] {
            let level = if matches!(kind, "idiom" | "sentence") { "high" } else { "mid" };
            assert_eq!(kcal_for(kind, level, "choice", true, None), 4, "{kind}");
        }
        // An idiom typed pays 6; listening and speaking keep the level's rate.
        assert_eq!(kcal_for("idiom", "high", "typing", true, None), 6);
        assert_eq!(kcal_for("idiom", "high", "listening", true, None), 10);
        assert_eq!(kcal_for("expression", "mid", "listening", true, None), 4);
        assert_eq!(kcal_for("idiom", "high", "speaking", true, Some(100.0)) * 10, 100);
        assert_eq!(kcal_for("sentence", "high", "speaking", true, Some(80.0)), 8);
        assert_eq!(kcal_for("idiom", "high", "speaking", false, Some(20.0)), 0);
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
    fn recipe_reviews_pay_half_a_calorie_or_one_and_drop_the_last_half() {
        assert_eq!(recipe_half_kcal("choice"), Some(1));
        assert_eq!(recipe_half_kcal("typing"), Some(2));
        assert_eq!(recipe_half_kcal("speaking"), None);
        // Three meanings picked in a row: 0.5 → 0, 1.0 → +1, 1.5 → 0.
        assert_eq!(recipe_kcal_gain(0, 1), 0);
        assert_eq!(recipe_kcal_gain(1, 1), 1);
        assert_eq!(recipe_kcal_gain(2, 1), 0);
        // A word typed is a whole calorie, whatever half is pending.
        assert_eq!(recipe_kcal_gain(0, 2), 1);
        assert_eq!(recipe_kcal_gain(3, 2), 1);
        assert_eq!(recipe_kcal_gain(5, -2), 0, "nothing is ever taken back");
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
