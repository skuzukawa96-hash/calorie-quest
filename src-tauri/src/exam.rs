//! 試験: 30 questions laid out like a TOEIC reading and listening test, at one of three levels.
//!
//! An exam has four parts, in this order: 応答問題 (a line is heard, the reply is picked: Part 2),
//! 短文穴埋め (a sentence with a blank: Part 5), 長文穴埋め (a passage with four blanks, one of them
//! a whole sentence: Part 6) and 読解 (a passage and questions on it: Part 7). The questions of each
//! part are drawn at random from the level's pool in `data/exam-*.json`.
//!
//! 70% or more passes and pays the level's reward; less pays a flat 30 kcal for trying. Both are
//! paid every time an exam is handed in. A question missed goes into the exam's own review (apart
//! from the study review); put right there it pays 3 kcal and leaves the review.

use std::collections::HashMap;
use std::sync::OnceLock;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use tauri::State;

use crate::commands::{credit, err, load_daily, mark_studied, CmdResult, Studied, USER_ID};
use crate::models::{
    ExamAnswer, ExamLevelInfo, ExamOverview, ExamQuestion, ExamResult, ExamReviewResult, WordNotes,
};
use crate::srs;
use crate::util::{now_ts, shuffle, today};
use crate::AppState;

pub const LEVELS: [&str; 3] = ["basic", "toeic600", "toeic800"];
pub const EXAM_SIZE: usize = 30;
/// 応答問題 in an exam
const LISTENING: usize = 6;
/// 長文穴埋め passages in an exam (four blanks each)
const TEXT_SETS: usize = 1;
/// 読解 questions in an exam, taken a passage at a time
const READING: usize = 8;
pub const PASS_PERCENT: i64 = 70;
pub const EFFORT_KCAL: i64 = 30;
pub const REVIEW_KCAL: i64 = 3;
/// exam questions gone over in one review
pub const REVIEW_SIZE: usize = 10;

const EXAM_BASIC_JSON: &str = include_str!("../data/exam-basic.json");
const EXAM_600_JSON: &str = include_str!("../data/exam-600.json");
const EXAM_800_JSON: &str = include_str!("../data/exam-800.json");

pub fn label(level: &str) -> &'static str {
    match level {
        "basic" => "中学～高校基礎",
        "toeic600" => "TOEIC 500〜700点目安",
        _ => "TOEIC 800点目安",
    }
}

/// kcal for passing an exam of `level`.
pub fn reward(level: &str) -> i64 {
    match level {
        "basic" => 100,
        "toeic600" => 150,
        _ => 200,
    }
}

pub fn passes(correct: i64, total: i64) -> bool {
    total > 0 && correct * 100 >= total * PASS_PERCENT
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSeed {
    pub id: String,
    pub part: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub passage: Option<String>,
    #[serde(default)]
    pub passage_ja: Option<String>,
    pub questions: Vec<QuestionSeed>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionSeed {
    #[serde(default)]
    pub prompt: Option<String>,
    pub choices: Vec<String>,
    pub answer: String,
    #[serde(default)]
    pub ja: Option<String>,
    pub explanation: String,
    #[serde(default)]
    pub point: Option<String>,
}

/// Level → its sets, as written in the data.
pub fn sets() -> &'static HashMap<&'static str, Vec<SetSeed>> {
    static TABLE: OnceLock<HashMap<&'static str, Vec<SetSeed>>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let parse = |json: &str, file: &str| -> Vec<SetSeed> {
            serde_json::from_str(json).unwrap_or_else(|e| panic!("data/{file} must be a JSON array of exam sets: {e}"))
        };
        HashMap::from([
            ("basic", parse(EXAM_BASIC_JSON, "exam-basic.json")),
            ("toeic600", parse(EXAM_600_JSON, "exam-600.json")),
            ("toeic800", parse(EXAM_800_JSON, "exam-800.json")),
        ])
    })
}

/// Where a period does not end a sentence: a title before a name (Ms. Lee), and a time unless a
/// capital follows it ("at 10 a.m. to 8 p.m." is one sentence, "until 5 p.m. During …" two).
fn ends_sentence(before: &str, rest: &[char]) -> bool {
    let lower = before.to_lowercase();
    let word = lower.rsplit(' ').next().unwrap_or("");
    if ["mr.", "ms.", "mrs.", "dr.", "co.", "inc.", "st."].contains(&word) {
        return false;
    }
    if word.ends_with("a.m.") || word.ends_with("p.m.") {
        return rest.iter().find(|c| **c != ' ').is_some_and(|c| c.is_uppercase());
    }
    true
}

/// The passage's sentences, split after . ? ! and at line breaks.
fn sentences(passage: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in passage.lines() {
        let mut cur = String::new();
        let chars: Vec<char> = line.chars().collect();
        for (i, &c) in chars.iter().enumerate() {
            cur.push(c);
            if matches!(c, '.' | '?' | '!')
                && chars.get(i + 1).is_none_or(|n| *n == ' ')
                && (c != '.' || ends_sentence(&cur, &chars[i + 1..]))
            {
                out.push(cur.trim().to_string());
                cur.clear();
            }
        }
        if !cur.trim().is_empty() {
            out.push(cur.trim().to_string());
        }
    }
    out
}

/// `text` with every [n] filled in with the answer of blank n.
fn fill_blanks(text: &str, answers: &[String]) -> String {
    let mut out = text.to_string();
    for (i, a) in answers.iter().enumerate() {
        out = out.replace(&format!("[{}]", i + 1), a);
    }
    out
}

/// The explanation's word notes: the answer's own (its patterns, similar words) when it is a word
/// or a short phrase of the dictionary, and the patterns the sentences use.
fn notes_for(answer: &str, texts: &[String]) -> Option<WordNotes> {
    let short = answer.split_whitespace().count() <= 3 && !answer.contains(['.', ',', '?']);
    let mut notes = if short { crate::db::word_notes(answer).unwrap_or_default() } else { WordNotes::default() };
    notes.used = crate::db::used_words(texts);
    (!notes.is_empty()).then_some(notes)
}

fn build_question(level: &str, set: &SetSeed, index: usize) -> ExamQuestion {
    let q = &set.questions[index];
    let answers: Vec<String> = set.questions.iter().map(|q| q.answer.clone()).collect();
    let (sentence, sentence_ja, texts) = match set.part.as_str() {
        "short" => {
            let prompt = q.prompt.clone().unwrap_or_default();
            let done = crate::util::fill_blank(&prompt, &q.answer);
            (done.clone(), q.ja.clone(), vec![done])
        }
        "listening" => {
            let heard = q.prompt.clone().unwrap_or_default();
            (heard.clone(), q.ja.clone(), vec![heard, q.answer.clone()])
        }
        "text" if q.answer.ends_with(['.', '?', '!']) => {
            // A sentence put into the passage is its own sentence.
            (q.answer.clone(), None, vec![q.answer.clone()])
        }
        "text" => {
            let passage = set.passage.clone().unwrap_or_default();
            let marker = format!("[{}]", index + 1);
            let own = sentences(&passage).into_iter().find(|s| s.contains(&marker)).unwrap_or_default();
            let done = fill_blanks(&own, &answers);
            (done.clone(), None, vec![done])
        }
        _ => {
            // 読解: the question is about the passage; its words go to the recipe with the question.
            let asked = q.prompt.clone().unwrap_or_default();
            (asked, q.ja.clone(), Vec::new())
        }
    };
    let mut choices = q.choices.clone();
    shuffle(&mut choices);
    ExamQuestion {
        id: format!("{}-{}", set.id, index + 1),
        set_id: set.id.clone(),
        level: level.to_string(),
        part: set.part.clone(),
        title: set.title.clone(),
        passage: set.passage.clone(),
        passage_ja: set.passage_ja.clone(),
        blank: (set.part == "text").then_some(index as i64 + 1),
        prompt: q.prompt.clone(),
        prompt_ja: q.ja.clone(),
        choices,
        answer: q.answer.clone(),
        explanation: q.explanation.clone(),
        point: q.point.clone(),
        notes: notes_for(&q.answer, &texts),
        sentence,
        sentence_ja,
    }
}

/// Question id → (level, set, index), over every level.
fn index() -> &'static HashMap<String, (&'static str, usize, usize)> {
    static TABLE: OnceLock<HashMap<String, (&'static str, usize, usize)>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut out = HashMap::new();
        for (level, list) in sets() {
            for (si, set) in list.iter().enumerate() {
                for qi in 0..set.questions.len() {
                    out.insert(format!("{}-{}", set.id, qi + 1), (*level, si, qi));
                }
            }
        }
        out
    })
}

pub fn question(id: &str) -> Option<ExamQuestion> {
    let (level, si, qi) = *index().get(id)?;
    Some(build_question(level, &sets()[level][si], qi))
}

/// A new exam of `level`: 応答問題 6, 短文穴埋め to make up 30, 長文穴埋め one passage, 読解 8
/// questions, a passage at a time, each part drawn at random and the parts in TOEIC's order.
pub fn build_exam(level: &str) -> Result<Vec<ExamQuestion>, String> {
    let list = sets().get(level).ok_or_else(|| format!("unknown exam level {level}"))?;
    let mut of_part = |part: &str| -> Vec<usize> {
        let mut v: Vec<usize> = (0..list.len()).filter(|&i| list[i].part == part).collect();
        shuffle(&mut v);
        v
    };
    let listening: Vec<usize> = of_part("listening").into_iter().take(LISTENING).collect();
    let text: Vec<usize> = of_part("text").into_iter().take(TEXT_SETS).collect();
    let mut reading = Vec::new();
    let mut reading_count = 0;
    for i in of_part("reading") {
        let n = list[i].questions.len();
        if reading_count + n <= READING {
            reading.push(i);
            reading_count += n;
        }
    }
    let count = |sets: &[usize]| sets.iter().map(|&i| list[i].questions.len()).sum::<usize>();
    let short_needed = EXAM_SIZE.saturating_sub(count(&listening) + count(&text) + reading_count);
    let short: Vec<usize> = of_part("short").into_iter().take(short_needed).collect();

    let mut out = Vec::new();
    for group in [&listening, &short, &text, &reading] {
        for &si in group.iter() {
            for qi in 0..list[si].questions.len() {
                out.push(build_question(level, &list[si], qi));
            }
        }
    }
    Ok(out)
}

/// Grades an exam handed in, pays for it and puts the questions missed into the exam review
/// (those answered right leave it).
pub fn finish(conn: &mut Connection, level: &str, answers: &[ExamAnswer]) -> Result<ExamResult, String> {
    if !LEVELS.contains(&level) {
        return Err(format!("unknown exam level {level}"));
    }
    if answers.is_empty() {
        return Err("回答がありません".into());
    }
    let mut graded = Vec::new();
    for a in answers {
        let q = question(&a.id).ok_or_else(|| format!("unknown exam question {}", a.id))?;
        graded.push((a.id.as_str(), q.level, q.answer == a.chosen));
    }
    let total = graded.len() as i64;
    let correct = graded.iter().filter(|(_, _, ok)| *ok).count() as i64;
    let passed = passes(correct, total);
    let (today, now) = (today(), now_ts());

    let tx = conn.transaction().map_err(err)?;
    let kcal = if passed { reward(level) } else { EFFORT_KCAL };
    tx.execute(
        "INSERT INTO exam_attempts (user_id, level, date, total, correct, passed, kcal, finished_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![USER_ID, level, today, total, correct, passed as i64, kcal, now],
    )
    .map_err(err)?;
    let mut review_added = 0;
    for (id, qlevel, ok) in &graded {
        if *ok {
            tx.execute("DELETE FROM exam_mistakes WHERE user_id = ?1 AND question_id = ?2", params![USER_ID, id])
                .map_err(err)?;
        } else {
            let fresh = tx
                .execute(
                    "INSERT INTO exam_mistakes (user_id, question_id, level, added_at) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(user_id, question_id) DO UPDATE SET misses = misses + 1",
                    params![USER_ID, id, qlevel, now],
                )
                .map_err(err)?;
            review_added += fresh as i64;
        }
    }
    let paid = credit(&tx, &today, kcal * srs::EIGHTHS).map_err(err)?;
    tx.execute(
        "UPDATE daily_stats SET answered = answered + ?3, correct = correct + ?4 WHERE user_id = ?1 AND date = ?2",
        params![USER_ID, today, total, correct],
    )
    .map_err(err)?;
    let Studied { streak, new_ticket, .. } = mark_studied(&tx, &today, &now).map_err(err)?;
    let today_kcal = load_daily(&tx, &today).map_err(err)?.kcal_earned;
    tx.commit().map_err(err)?;
    Ok(ExamResult {
        level: level.to_string(),
        correct,
        total,
        passed,
        kcal_earned: paid.whole,
        points: paid.points(),
        today_kcal,
        streak,
        new_ticket,
        review_added,
    })
}

/// Up to `count` exam questions waiting in review, those missed longest ago first.
pub fn review_questions(conn: &Connection, count: usize) -> rusqlite::Result<Vec<ExamQuestion>> {
    let mut stmt = conn.prepare(
        "SELECT question_id FROM exam_mistakes WHERE user_id = ?1 ORDER BY added_at, question_id LIMIT ?2",
    )?;
    let ids: Vec<String> = stmt.query_map(params![USER_ID, count as i64], |r| r.get(0))?.collect::<Result<_, _>>()?;
    Ok(ids.iter().filter_map(|id| question(id)).collect())
}

fn review_count(conn: &Connection, level: Option<&str>) -> rusqlite::Result<i64> {
    match level {
        Some(l) => conn.query_row(
            "SELECT COUNT(*) FROM exam_mistakes WHERE user_id = ?1 AND level = ?2",
            params![USER_ID, l],
            |r| r.get(0),
        ),
        None => conn.query_row("SELECT COUNT(*) FROM exam_mistakes WHERE user_id = ?1", params![USER_ID], |r| r.get(0)),
    }
}

/// An exam question answered in the review: right pays 3 kcal and takes it out of the review.
pub fn answer_review(conn: &mut Connection, id: &str, chosen: &str) -> Result<ExamReviewResult, String> {
    let q = question(id).ok_or_else(|| format!("unknown exam question {id}"))?;
    let correct = q.answer == chosen;
    let (today, now) = (today(), now_ts());
    let tx = conn.transaction().map_err(err)?;
    let waiting: bool = tx
        .query_row(
            "SELECT 1 FROM exam_mistakes WHERE user_id = ?1 AND question_id = ?2",
            params![USER_ID, id],
            |_| Ok(true),
        )
        .optional()
        .map_err(err)?
        .unwrap_or(false);
    // Only a question still in review pays: answering one twice in a row pays once.
    let kcal = if correct && waiting { REVIEW_KCAL } else { 0 };
    if correct {
        tx.execute("DELETE FROM exam_mistakes WHERE user_id = ?1 AND question_id = ?2", params![USER_ID, id])
            .map_err(err)?;
    } else {
        tx.execute(
            "UPDATE exam_mistakes SET misses = misses + 1 WHERE user_id = ?1 AND question_id = ?2",
            params![USER_ID, id],
        )
        .map_err(err)?;
    }
    let paid = credit(&tx, &today, kcal * srs::EIGHTHS).map_err(err)?;
    tx.execute(
        "UPDATE daily_stats SET answered = answered + 1, correct = correct + ?3 WHERE user_id = ?1 AND date = ?2",
        params![USER_ID, today, correct as i64],
    )
    .map_err(err)?;
    mark_studied(&tx, &today, &now).map_err(err)?;
    let today_kcal = load_daily(&tx, &today).map_err(err)?.kcal_earned;
    let remaining = review_count(&tx, None).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(ExamReviewResult { correct, kcal_earned: paid.whole, points: paid.points(), today_kcal, remaining })
}

pub fn overview(conn: &Connection) -> rusqlite::Result<ExamOverview> {
    let mut levels = Vec::new();
    for level in LEVELS {
        let (attempts, passed_ever): (i64, bool) = conn.query_row(
            "SELECT COUNT(*), COALESCE(MAX(passed), 0) FROM exam_attempts WHERE user_id = ?1 AND level = ?2",
            params![USER_ID, level],
            |r| Ok((r.get(0)?, r.get::<_, i64>(1)? == 1)),
        )?;
        let best: Option<(i64, i64)> = conn
            .query_row(
                "SELECT correct, total FROM exam_attempts WHERE user_id = ?1 AND level = ?2
                 ORDER BY CAST(correct AS REAL) / total DESC, finished_at DESC LIMIT 1",
                params![USER_ID, level],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        levels.push(ExamLevelInfo {
            level: level.to_string(),
            label: label(level).to_string(),
            reward: reward(level),
            attempts,
            best_correct: best.map(|b| b.0),
            best_total: best.map(|b| b.1),
            passed_ever,
            review_count: review_count(conn, Some(level))?,
        });
    }
    Ok(ExamOverview {
        levels,
        review_count: review_count(conn, None)?,
        question_count: EXAM_SIZE as i64,
        pass_percent: PASS_PERCENT,
        effort_kcal: EFFORT_KCAL,
        review_kcal: REVIEW_KCAL,
    })
}

/* ---------- Tauri commands ---------- */

#[tauri::command]
pub fn start_exam(level: String) -> CmdResult<Vec<ExamQuestion>> {
    build_exam(&level)
}

#[tauri::command]
pub fn finish_exam(state: State<'_, AppState>, level: String, answers: Vec<ExamAnswer>) -> CmdResult<ExamResult> {
    let mut conn = state.db.lock().map_err(err)?;
    finish(&mut conn, &level, &answers)
}

#[tauri::command]
pub fn get_exam_review(state: State<'_, AppState>) -> CmdResult<Vec<ExamQuestion>> {
    let conn = state.db.lock().map_err(err)?;
    review_questions(&conn, REVIEW_SIZE).map_err(err)
}

#[tauri::command]
pub fn answer_exam_review(state: State<'_, AppState>, id: String, chosen: String) -> CmdResult<ExamReviewResult> {
    let mut conn = state.db.lock().map_err(err)?;
    answer_review(&mut conn, &id, &chosen)
}

/* ---------- tests ---------- */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use std::collections::HashSet;

    fn conn() -> Connection {
        db::init_in_memory().expect("in-memory db")
    }

    fn answers(exam: &[ExamQuestion], right: usize) -> Vec<ExamAnswer> {
        exam.iter()
            .enumerate()
            .map(|(i, q)| ExamAnswer {
                id: q.id.clone(),
                chosen: if i < right { q.answer.clone() } else { q.choices.iter().find(|c| **c != q.answer).unwrap().clone() },
            })
            .collect()
    }

    /// Every set is well formed: its part is known, each question has 4 choices (応答問題 3) that
    /// differ, the answer among them, an explanation; a 長文穴埋め passage has a blank [n] for
    /// each of its questions and nothing else in brackets; ids are unique across levels.
    #[test]
    fn exam_data_is_well_formed() {
        let mut ids = HashSet::new();
        for (level, list) in sets() {
            for set in list {
                assert!(ids.insert(set.id.clone()), "{} twice", set.id);
                let n = set.questions.len();
                match set.part.as_str() {
                    "listening" | "short" => assert_eq!(n, 1, "{}: one question per set", set.id),
                    "text" => {
                        assert_eq!(n, 4, "{}: a 長文穴埋め passage has four blanks", set.id);
                        let p = set.passage.as_deref().unwrap_or_else(|| panic!("{} has no passage", set.id));
                        for i in 1..=n {
                            assert_eq!(p.matches(&format!("[{i}]")).count(), 1, "{}: blank [{i}]", set.id);
                        }
                        assert!(!p.contains(&format!("[{}]", n + 1)), "{}: a blank without a question", set.id);
                    }
                    "reading" => {
                        assert!((2..=4).contains(&n), "{}: {n} questions", set.id);
                        assert!(set.passage.is_some() && set.passage_ja.is_some(), "{} lacks its passage", set.id);
                    }
                    other => panic!("{}: unknown part {other}", set.id),
                }
                if matches!(set.part.as_str(), "text" | "reading") {
                    assert!(set.passage_ja.as_deref().is_some_and(|j| !j.trim().is_empty()), "{}: passage without Japanese", set.id);
                }
                for (i, q) in set.questions.iter().enumerate() {
                    let at = format!("{} ({level}) #{}", set.id, i + 1);
                    let want = if set.part == "listening" { 3 } else { 4 };
                    assert_eq!(q.choices.len(), want, "{at}: {} choices", q.choices.len());
                    assert_eq!(q.choices.iter().collect::<HashSet<_>>().len(), want, "{at}: choices repeat");
                    assert!(q.choices.contains(&q.answer), "{at}: answer {} is not a choice", q.answer);
                    assert!(!q.explanation.trim().is_empty(), "{at}: no explanation");
                    if set.part == "short" {
                        let p = q.prompt.as_deref().unwrap_or_else(|| panic!("{at}: no sentence"));
                        assert_eq!(p.matches("___").count(), 1, "{at}: one blank");
                        assert!(q.ja.is_some(), "{at}: no Japanese");
                    }
                    if matches!(set.part.as_str(), "listening" | "reading") {
                        assert!(q.prompt.is_some() && q.ja.is_some(), "{at}: no prompt or its Japanese");
                    }
                }
            }
        }
    }

    /// Each level has questions enough for several different exams.
    #[test]
    fn every_level_can_make_varied_exams() {
        for level in LEVELS {
            let list = &sets()[level];
            let count = |part: &str| list.iter().filter(|s| s.part == part).map(|s| s.questions.len()).sum::<usize>();
            assert!(count("listening") >= LISTENING * 2, "{level}: {} 応答問題", count("listening"));
            assert!(count("short") >= 24, "{level}: {} 短文穴埋め", count("short"));
            assert!(list.iter().filter(|s| s.part == "text").count() >= 3, "{level}: 長文穴埋め");
            assert!(count("reading") >= READING * 2 - 2, "{level}: {} 読解", count("reading"));
        }
    }

    #[test]
    fn an_exam_has_thirty_questions_in_toeic_order() {
        for level in LEVELS {
            let exam = build_exam(level).unwrap();
            assert_eq!(exam.len(), EXAM_SIZE, "{level}");
            let parts: Vec<&str> = exam.iter().map(|q| q.part.as_str()).collect();
            let order = ["listening", "short", "text", "reading"];
            assert!(parts.windows(2).all(|w| {
                order.iter().position(|p| *p == w[0]) <= order.iter().position(|p| *p == w[1])
            }), "{level}: {parts:?}");
            assert_eq!(parts.iter().filter(|p| **p == "listening").count(), LISTENING);
            assert_eq!(parts.iter().filter(|p| **p == "text").count(), 4);
            assert!(exam.iter().all(|q| q.choices.contains(&q.answer) && !q.sentence.is_empty()), "{level}");
            assert_eq!(exam.iter().map(|q| &q.id).collect::<HashSet<_>>().len(), EXAM_SIZE, "{level}: a question twice");
        }
    }

    /// 70% passes and pays the level's reward, less pays 30 for trying, every time an exam is
    /// handed in.
    #[test]
    fn exams_pay_every_time() {
        let mut c = conn();
        let exam = build_exam("toeic600").unwrap();
        let fail = finish(&mut c, "toeic600", &answers(&exam, 20)).unwrap();
        assert!(!fail.passed);
        assert_eq!(fail.kcal_earned, EFFORT_KCAL);
        let again = finish(&mut c, "toeic600", &answers(&exam, 5)).unwrap();
        assert_eq!(again.kcal_earned, EFFORT_KCAL, "a second try the same day pays too");
        let pass = finish(&mut c, "toeic600", &answers(&exam, 21)).unwrap();
        assert!(pass.passed, "21 of 30 is 70%");
        assert_eq!(pass.kcal_earned, 150);
        assert_eq!(finish(&mut c, "toeic600", &answers(&exam, 30)).unwrap().kcal_earned, 150);
        let basic = build_exam("basic").unwrap();
        assert_eq!(finish(&mut c, "basic", &answers(&basic, 30)).unwrap().kcal_earned, 100);
        let today_kcal = load_daily(&c, &today()).unwrap().kcal_earned;
        assert_eq!(today_kcal, EFFORT_KCAL * 2 + 150 * 2 + 100);
        let o = overview(&c).unwrap();
        let t600 = o.levels.iter().find(|l| l.level == "toeic600").unwrap();
        assert_eq!(t600.attempts, 4);
        assert_eq!((t600.best_correct, t600.best_total), (Some(30), Some(30)));
        assert!(t600.passed_ever);
    }

    /// Questions missed go into the exam review, apart from the study review; put right there
    /// they pay 3 kcal and leave it.
    #[test]
    fn missed_exam_questions_are_reviewed_on_their_own() {
        let mut c = conn();
        let exam = build_exam("toeic800").unwrap();
        let r = finish(&mut c, "toeic800", &answers(&exam, 25)).unwrap();
        assert_eq!(r.review_added, 5);
        assert_eq!(overview(&c).unwrap().review_count, 5);
        let study_due: i64 = c
            .query_row("SELECT COUNT(*) FROM learning_history WHERE needs_review = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(study_due, 0, "the study review is untouched");
        let review = review_questions(&c, REVIEW_SIZE).unwrap();
        assert_eq!(review.len(), 5);
        let wrong = review[0].choices.iter().find(|c| **c != review[0].answer).unwrap().clone();
        let miss = answer_review(&mut c, &review[0].id, &wrong).unwrap();
        assert_eq!((miss.correct, miss.kcal_earned, miss.remaining), (false, 0, 5));
        let right = answer_review(&mut c, &review[0].id, &review[0].answer.clone()).unwrap();
        assert_eq!((right.correct, right.kcal_earned, right.remaining), (true, REVIEW_KCAL, 4));
        let twice = answer_review(&mut c, &review[0].id, &review[0].answer.clone()).unwrap();
        assert_eq!(twice.kcal_earned, 0, "a question already put right pays no more");
        // Answered right in a later exam, a question leaves the review too.
        let redo: Vec<ExamAnswer> =
            review[1..].iter().map(|q| ExamAnswer { id: q.id.clone(), chosen: q.answer.clone() }).collect();
        finish(&mut c, "toeic800", &redo).unwrap();
        assert_eq!(overview(&c).unwrap().review_count, 0);
    }

    #[test]
    fn a_passage_splits_into_sentences_past_titles_and_times() {
        assert_eq!(
            sentences("Dear Ms. Lee, we open at 10 a.m. to 8 p.m. every day. Visit us until 5 p.m. During the sale, call Mr. Kim."),
            vec![
                "Dear Ms. Lee, we open at 10 a.m. to 8 p.m. every day.",
                "Visit us until 5 p.m.",
                "During the sale, call Mr. Kim.",
            ]
        );
    }

    /// A 長文穴埋め question carries the sentence of its blank, completed, for the recipe and notes.
    #[test]
    fn a_text_blank_carries_its_completed_sentence() {
        let (level, set) = LEVELS
            .iter()
            .flat_map(|l| sets()[l].iter().map(move |s| (*l, s)))
            .find(|(_, s)| s.part == "text")
            .unwrap();
        for i in 0..set.questions.len() {
            let q = build_question(level, set, i);
            assert!(!q.sentence.contains('['), "{}: {}", q.id, q.sentence);
            assert!(q.sentence.contains(&set.questions[i].answer), "{}: {}", q.id, q.sentence);
            // A sentence put in is the whole sentence, not the one after it too.
            if set.questions[i].answer.ends_with('.') {
                assert_eq!(q.sentence, set.questions[i].answer, "{}", q.id);
            }
        }
    }
}
