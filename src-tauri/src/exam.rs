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

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use tauri::State;

use crate::commands::{credit, err, load_daily, mark_studied, CmdResult, Studied, USER_ID};
use crate::models::{
    ExamAnswer, ExamLevelInfo, ExamOverview, ExamProgress, ExamQuestion, ExamResult, ExamReviewResult, ExamSuspended,
    WordNotes,
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

/// The passage's sentences, split after . ? ! (and a closing quote right after one: theme is
/// "Supply Chains.") and at line breaks.
pub(crate) fn sentences(passage: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in passage.lines() {
        let mut cur = String::new();
        let chars: Vec<char> = line.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            cur.push(c);
            if matches!(c, '.' | '?' | '!') {
                let quote = matches!(chars.get(i + 1), Some('"' | '”'));
                let next = i + 1 + quote as usize;
                // After a closing quote the sentence goes on into a small letter ("Is it new?" she asked).
                let goes_on = quote && chars[next..].iter().find(|n| **n != ' ').is_some_and(|n| n.is_lowercase());
                if chars.get(next).is_none_or(|n| *n == ' ')
                    && !goes_on
                    && (c != '.' || ends_sentence(&cur, &chars[next..]))
                {
                    if quote {
                        cur.push(chars[i + 1]);
                    }
                    out.push(cur.trim().to_string());
                    cur.clear();
                    i = next;
                    continue;
                }
            }
            i += 1;
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
    notes.irregular = crate::db::irregulars_in(texts);
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

/// A new exam of `level` drawn at random, as if nothing had been asked before.
pub fn build_exam(level: &str) -> Result<Vec<ExamQuestion>, String> {
    build_exam_from(level, &HashMap::new())
}

/// A new exam of `level`: 応答問題 6, 短文穴埋め to make up 30, 長文穴埋め one passage, 読解 8
/// questions, a passage at a time, the parts in TOEIC's order. Each part takes the sets not asked
/// yet first, then those asked longest ago (`seen`: set id → when last asked), at random among
/// equals, so exams do not repeat a question while the bank still has some not asked.
pub fn build_exam_from(level: &str, seen: &HashMap<String, String>) -> Result<Vec<ExamQuestion>, String> {
    let list = sets().get(level).ok_or_else(|| format!("unknown exam level {level}"))?;
    let of_part = |part: &str| -> Vec<usize> {
        let mut v: Vec<usize> = (0..list.len()).filter(|&i| list[i].part == part).collect();
        shuffle(&mut v);
        // Stable: never asked ("") first, then the oldest, the shuffle kept among equals.
        v.sort_by_key(|&i| seen.get(&list[i].id).cloned().unwrap_or_default());
        v
    };
    let listening: Vec<usize> = of_part("listening").into_iter().take(LISTENING).collect();
    let text: Vec<usize> = of_part("text").into_iter().take(TEXT_SETS).collect();
    let count = |sets: &[usize]| sets.iter().map(|&i| list[i].questions.len()).sum::<usize>();
    // 読解 comes a passage (2 to 4 questions) at a time: the passages not asked yet that come
    // closest to READING, topped up with those asked longest ago only when they make fewer than
    // READING - 2; the 短文穴埋め make up the rest.
    let (fresh, asked): (Vec<usize>, Vec<usize>) =
        of_part("reading").into_iter().partition(|&i| !seen.contains_key(&list[i].id));
    let sizes = |v: &[usize]| v.iter().map(|&i| (i, list[i].questions.len())).collect::<Vec<_>>();
    let mut reading = fullest(&sizes(&fresh), READING);
    if count(&reading) < READING - 2 {
        let room = READING - count(&reading);
        reading.extend(fullest(&sizes(&asked), room));
    }
    let reading_count = count(&reading);
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

/// The first of `items` ((id, size), in the order to prefer) that together come closest to `room`
/// without going over: exactly `room` when some do.
fn fullest(items: &[(usize, usize)], room: usize) -> Vec<usize> {
    fn search(items: &[(usize, usize)], room: usize, at: usize, chosen: &mut Vec<usize>, sum: usize, best: &mut (usize, Vec<usize>)) {
        if sum > best.0 {
            *best = (sum, chosen.clone());
        }
        if best.0 == room {
            return;
        }
        for i in at..items.len() {
            let (id, n) = items[i];
            if sum + n <= room {
                chosen.push(id);
                search(items, room, i + 1, chosen, sum + n, best);
                chosen.pop();
                if best.0 == room {
                    return;
                }
            }
        }
    }
    let mut best = (0, Vec::new());
    search(items, room, 0, &mut Vec::new(), 0, &mut best);
    best.1
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
    // Handed in: nothing of this level is left part-way any more, and every question was asked.
    tx.execute("DELETE FROM exam_progress WHERE user_id = ?1 AND level = ?2", params![USER_ID, level]).map_err(err)?;
    mark_seen(&tx, answers.iter().map(|a| a.id.as_str())).map_err(err)?;
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

/// When each set of `level` was last asked: set id → time.
pub fn seen_sets(conn: &Connection, level: &str) -> rusqlite::Result<HashMap<String, String>> {
    let ids: HashSet<&str> = sets().get(level).map(|l| l.iter().map(|s| s.id.as_str()).collect()).unwrap_or_default();
    let mut stmt = conn.prepare("SELECT set_id, asked_at FROM exam_seen WHERE user_id = ?1")?;
    let rows = stmt.query_map(params![USER_ID], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    let mut out = HashMap::new();
    for row in rows {
        let (id, at) = row?;
        if ids.contains(id.as_str()) {
            out.insert(id, at);
        }
    }
    Ok(out)
}

/// Marks the sets of the questions answered (`ids`, question ids) as asked now.
fn mark_seen<'a>(conn: &Connection, ids: impl IntoIterator<Item = &'a str>) -> rusqlite::Result<()> {
    let now = now_ts();
    for id in ids {
        let Some(&(level, si, _)) = index().get(id) else { continue };
        conn.execute(
            "INSERT INTO exam_seen (user_id, set_id, asked_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id, set_id) DO UPDATE SET asked_at = excluded.asked_at",
            params![USER_ID, sets()[level][si].id, now],
        )?;
    }
    Ok(())
}

/* ---------- 中断: an exam left part-way, kept to go on with ---------- */

/// Keeps the exam of `level` left part-way: its questions in order and the answers so far. Every
/// answer saves it, so leaving by 中断, by another tab or by closing the app all keep it. With no
/// answer there is nothing to keep.
pub fn save_progress(conn: &Connection, level: &str, question_ids: &[String], answers: &[ExamAnswer]) -> Result<(), String> {
    if !LEVELS.contains(&level) {
        return Err(format!("unknown exam level {level}"));
    }
    if answers.is_empty() {
        return discard_progress(conn, level);
    }
    // A question answered has been asked, even if the exam is given up afterwards.
    mark_seen(conn, answers.iter().map(|a| a.id.as_str())).map_err(err)?;
    let ids = serde_json::to_string(question_ids).map_err(err)?;
    let answers = serde_json::to_string(answers).map_err(err)?;
    conn.execute(
        "INSERT INTO exam_progress (user_id, level, question_ids, answers, saved_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(user_id, level) DO UPDATE SET
           question_ids = excluded.question_ids, answers = excluded.answers, saved_at = excluded.saved_at",
        params![USER_ID, level, ids, answers, now_ts()],
    )
    .map_err(err)?;
    Ok(())
}

/// The question ids and answers kept for `level`, as they were saved.
fn stored_progress(conn: &Connection, level: &str) -> rusqlite::Result<Option<(Vec<String>, Vec<ExamAnswer>, String)>> {
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT question_ids, answers, saved_at FROM exam_progress WHERE user_id = ?1 AND level = ?2",
            params![USER_ID, level],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    Ok(row.map(|(ids, answers, saved_at)| {
        (serde_json::from_str(&ids).unwrap_or_default(), serde_json::from_str(&answers).unwrap_or_default(), saved_at)
    }))
}

/// The exam of `level` left part-way, its questions made again from their ids. One the bank no
/// longer has every question of (the data changed since) is dropped rather than half shown.
pub fn progress(conn: &Connection, level: &str) -> Result<Option<ExamProgress>, String> {
    let Some((ids, answers, saved_at)) = stored_progress(conn, level).map_err(err)? else {
        return Ok(None);
    };
    let questions: Option<Vec<ExamQuestion>> = ids.iter().map(|id| question(id)).collect();
    match questions {
        Some(questions) if !questions.is_empty() && !answers.is_empty() && answers.iter().all(|a| ids.contains(&a.id)) => {
            Ok(Some(ExamProgress { level: level.to_string(), questions, answers, saved_at }))
        }
        _ => discard_progress(conn, level).map(|_| None),
    }
}

/// Forgets the exam of `level` left part-way (いいえ, start again).
pub fn discard_progress(conn: &Connection, level: &str) -> Result<(), String> {
    conn.execute("DELETE FROM exam_progress WHERE user_id = ?1 AND level = ?2", params![USER_ID, level])
        .map_err(err)?;
    Ok(())
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
        let passed_today: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM exam_attempts WHERE user_id = ?1 AND level = ?2 AND date = ?3 AND passed = 1)",
            params![USER_ID, level, today()],
            |r| r.get(0),
        )?;
        levels.push(ExamLevelInfo {
            level: level.to_string(),
            label: label(level).to_string(),
            reward: reward(level),
            attempts,
            best_correct: best.map(|b| b.0),
            best_total: best.map(|b| b.1),
            passed_ever,
            passed_today,
            review_count: review_count(conn, Some(level))?,
            suspended: stored_progress(conn, level)?
                .map(|(ids, answers, _)| ExamSuspended { answered: answers.len() as i64, total: ids.len() as i64 }),
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
pub fn start_exam(state: State<'_, AppState>, level: String) -> CmdResult<Vec<ExamQuestion>> {
    let conn = state.db.lock().map_err(err)?;
    let seen = seen_sets(&conn, &level).map_err(err)?;
    build_exam_from(&level, &seen)
}

#[tauri::command]
pub fn finish_exam(state: State<'_, AppState>, level: String, answers: Vec<ExamAnswer>) -> CmdResult<ExamResult> {
    let mut conn = state.db.lock().map_err(err)?;
    finish(&mut conn, &level, &answers)
}

#[tauri::command]
pub fn get_exam_progress(state: State<'_, AppState>, level: String) -> CmdResult<Option<ExamProgress>> {
    let conn = state.db.lock().map_err(err)?;
    progress(&conn, &level)
}

#[tauri::command]
pub fn save_exam_progress(
    state: State<'_, AppState>,
    level: String,
    question_ids: Vec<String>,
    answers: Vec<ExamAnswer>,
) -> CmdResult<()> {
    let conn = state.db.lock().map_err(err)?;
    save_progress(&conn, &level, &question_ids, &answers)
}

#[tauri::command]
pub fn discard_exam_progress(state: State<'_, AppState>, level: String) -> CmdResult<()> {
    let conn = state.db.lock().map_err(err)?;
    discard_progress(&conn, &level)
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

    /// Each level has questions enough for five exams in a row with nothing asked twice.
    #[test]
    fn every_level_can_make_varied_exams() {
        const EXAMS: usize = 5;
        for level in LEVELS {
            let list = &sets()[level];
            let count = |part: &str| list.iter().filter(|s| s.part == part).map(|s| s.questions.len()).sum::<usize>();
            assert!(count("listening") >= LISTENING * EXAMS, "{level}: {} 応答問題", count("listening"));
            assert!(count("short") >= 12 * EXAMS, "{level}: {} 短文穴埋め", count("short"));
            assert!(list.iter().filter(|s| s.part == "text").count() >= TEXT_SETS * EXAMS, "{level}: 長文穴埋め");
            assert!(count("reading") >= READING * EXAMS, "{level}: {} 読解", count("reading"));
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
        assert!(t600.passed_today, "the 合格 mark shows today");
        // The next day the mark is gone; the best score stays.
        c.execute("UPDATE exam_attempts SET date = ?1", params![crate::util::date_plus(-1)]).unwrap();
        let t600 = overview(&c).unwrap().levels.into_iter().find(|l| l.level == "toeic600").unwrap();
        assert!(t600.passed_ever && !t600.passed_today);
        assert_eq!(t600.best_correct, Some(30));
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

    /// Exams take what has not been asked yet: one after another, no set comes back while the level
    /// still has sets of that part not asked.
    #[test]
    fn exams_ask_what_has_not_been_asked_first() {
        for level in LEVELS {
            let mut c = conn();
            let list = &sets()[level];
            let mut asked: HashMap<&str, HashSet<String>> = HashMap::new();
            // Each exam's sets, part by part, until a part has fewer sets left than one exam takes.
            for round in 0..4 {
                let exam = build_exam_from(level, &seen_sets(&c, level).unwrap()).unwrap();
                assert_eq!(exam.len(), EXAM_SIZE, "{level} #{round}");
                let mut this: HashMap<&str, HashSet<String>> = HashMap::new();
                for q in &exam {
                    let part = list.iter().find(|s| s.id == q.set_id).unwrap().part.as_str();
                    this.entry(part).or_default().insert(q.set_id.clone());
                }
                for (part, ids) in &this {
                    let before = asked.entry(part).or_default();
                    let pool = list.iter().filter(|s| s.part == *part).count();
                    if pool - before.len() >= ids.len() {
                        assert!(ids.is_disjoint(before), "{level} #{round}: a {part} set asked again too soon");
                    }
                    before.extend(ids.iter().cloned());
                }
                finish(&mut c, level, &answers(&exam, 30)).unwrap();
            }
        }
    }

    /// An exam left part-way is kept with its answers until it is handed in or given up, and only
    /// for its own level.
    #[test]
    fn an_exam_left_part_way_is_kept_until_handed_in() {
        let mut c = conn();
        let exam = build_exam("toeic600").unwrap();
        let ids: Vec<String> = exam.iter().map(|q| q.id.clone()).collect();
        assert_eq!(progress(&c, "toeic600").unwrap().map(|p| p.questions.len()), None);

        let so_far = answers(&exam[..3], 2);
        save_progress(&c, "toeic600", &ids, &so_far).unwrap();
        let level = |c: &Connection, l: &str| overview(c).unwrap().levels.into_iter().find(|x| x.level == l).unwrap();
        assert_eq!(level(&c, "toeic600").suspended, Some(ExamSuspended { answered: 3, total: 30 }));
        assert_eq!(level(&c, "basic").suspended, None);
        let kept = progress(&c, "toeic600").unwrap().expect("kept");
        assert_eq!(kept.questions.iter().map(|q| q.id.clone()).collect::<Vec<_>>(), ids, "the same questions in order");
        assert_eq!(kept.answers, so_far);

        // Each answer saves again; one more is kept.
        save_progress(&c, "toeic600", &ids, &answers(&exam[..4], 4)).unwrap();
        assert_eq!(level(&c, "toeic600").suspended.unwrap().answered, 4);

        // Handed in, it is gone.
        finish(&mut c, "toeic600", &answers(&exam, 30)).unwrap();
        assert!(progress(&c, "toeic600").unwrap().is_none());
        assert_eq!(level(&c, "toeic600").suspended, None);

        // Given up (いいえ), it is gone too; nothing answered keeps nothing.
        save_progress(&c, "basic", &ids, &so_far).unwrap();
        discard_progress(&c, "basic").unwrap();
        assert!(progress(&c, "basic").unwrap().is_none());
        save_progress(&c, "basic", &ids, &[]).unwrap();
        assert!(progress(&c, "basic").unwrap().is_none());

        // One whose questions the bank no longer has is dropped.
        let mut gone = ids.clone();
        gone[0] = "no-such-set-1".into();
        save_progress(&c, "toeic800", &gone, &so_far).unwrap();
        assert!(progress(&c, "toeic800").unwrap().is_none());
        assert_eq!(level(&c, "toeic800").suspended, None);
        assert!(save_progress(&c, "toeic999", &ids, &so_far).is_err());
    }

    #[test]
    fn a_closing_quote_ends_its_sentence() {
        assert_eq!(
            sentences("The theme is \"Supply Chains.\" Ms. Lee will speak. \"Is it new?\" she asked."),
            vec!["The theme is \"Supply Chains.\"", "Ms. Lee will speak.", "\"Is it new?\" she asked."]
        );
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
