//! お気に入り: questions the learner starred (☆ → ★) in a study session or an exam, to look back over
//! and to go through again. A study question is starred in the mode it was asked in, so a word can
//! be a favorite by choice and by typing; an exam question is starred as it is (its part is its
//! form). Going through favorites again pays nothing and leaves the study review and the 記録 alone:
//! only when each was last gone over is kept, so that a round takes those left longest first.
//! Favorites are the learner's own, like the recipe, and survive 学習記録のリセット.

use rusqlite::{params, Connection};
use tauri::State;

use crate::commands::{build_session_question, err, CmdResult, MODES, USER_ID};
use crate::db;
use crate::exam;
use crate::models::{Favorite, FavoriteKeys, FavoriteQuestionKey};
use crate::util::now_ts;
use crate::AppState;

/// Stars (`on`) or unstars a study question in `mode`. Starring it twice keeps one favorite.
pub fn set_question(conn: &Connection, question_id: i64, mode: &str, on: bool) -> CmdResult<()> {
    if !MODES.contains(&mode) {
        return Err(format!("unknown mode {mode}"));
    }
    if on {
        let known: i64 =
            conn.query_row("SELECT COUNT(*) FROM questions WHERE id = ?1", params![question_id], |r| r.get(0)).map_err(err)?;
        if known == 0 {
            return Err(format!("question {question_id} not found"));
        }
        conn.execute(
            "INSERT OR IGNORE INTO favorites (user_id, question_id, mode, added_at) VALUES (?1, ?2, ?3, ?4)",
            params![USER_ID, question_id, mode, now_ts()],
        )
        .map_err(err)?;
    } else {
        conn.execute(
            "DELETE FROM favorites WHERE user_id = ?1 AND question_id = ?2 AND mode = ?3",
            params![USER_ID, question_id, mode],
        )
        .map_err(err)?;
    }
    Ok(())
}

/// Stars (`on`) or unstars an exam question ("e600-12-2").
pub fn set_exam(conn: &Connection, exam_id: &str, on: bool) -> CmdResult<()> {
    if on {
        if exam::question(exam_id).is_none() {
            return Err(format!("unknown exam question {exam_id}"));
        }
        conn.execute(
            "INSERT OR IGNORE INTO favorites (user_id, exam_id, added_at) VALUES (?1, ?2, ?3)",
            params![USER_ID, exam_id, now_ts()],
        )
        .map_err(err)?;
    } else {
        conn.execute("DELETE FROM favorites WHERE user_id = ?1 AND exam_id = ?2", params![USER_ID, exam_id])
            .map_err(err)?;
    }
    Ok(())
}

/// What is starred, for the ☆ / ★ on the questions of a session or an exam.
pub fn keys(conn: &Connection) -> rusqlite::Result<FavoriteKeys> {
    let mut stmt = conn.prepare("SELECT question_id, mode, exam_id FROM favorites WHERE user_id = ?1")?;
    let rows = stmt.query_map(params![USER_ID], |r| {
        Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?))
    })?;
    let mut out = FavoriteKeys { questions: Vec::new(), exams: Vec::new() };
    for row in rows {
        match row? {
            (Some(question_id), Some(mode), _) => out.questions.push(FavoriteQuestionKey { question_id, mode }),
            (_, _, Some(exam_id)) => out.exams.push(exam_id),
            _ => {}
        }
    }
    Ok(out)
}

/// Every favorite, the newest first, each with what the お気に入り page shows of it: a study
/// question built for its mode (with its explanation), or the exam question. One whose question is
/// gone from the bank is left out.
pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Favorite>> {
    let rows: Vec<(i64, Option<i64>, Option<String>, Option<String>, String, Option<String>)> = {
        let mut stmt = conn.prepare(
            "SELECT id, question_id, mode, exam_id, added_at, last_reviewed_at FROM favorites
             WHERE user_id = ?1 ORDER BY added_at DESC, id DESC",
        )?;
        let rows = stmt.query_map(params![USER_ID], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
        })?;
        rows.collect::<Result<_, _>>()?
    };
    let sql = format!("SELECT {} FROM questions q WHERE q.id = ?1", db::Q_COLS);
    let mut out = Vec::with_capacity(rows.len());
    for (id, question_id, mode, exam_id, added_at, last_reviewed_at) in rows {
        let (question, exam) = match (question_id, mode, exam_id) {
            (Some(qid), Some(mode), _) => {
                let q = match conn.query_row(&sql, params![qid], db::row_to_question) {
                    Ok(q) => q,
                    Err(rusqlite::Error::QueryReturnedNoRows) => continue,
                    Err(e) => return Err(e),
                };
                (Some(build_session_question(conn, q, &mode, false)?), None)
            }
            (_, _, Some(exam_id)) => match exam::question(&exam_id) {
                Some(q) => (None, Some(q)),
                None => continue,
            },
            _ => continue,
        };
        out.push(Favorite { id, added_at, last_reviewed_at, question, exam });
    }
    Ok(out)
}

/// A favorite gone over in its review, right or wrong: only the time is kept.
pub fn mark_reviewed(conn: &Connection, id: i64) -> CmdResult<()> {
    conn.execute(
        "UPDATE favorites SET last_reviewed_at = ?3 WHERE user_id = ?1 AND id = ?2",
        params![USER_ID, id, now_ts()],
    )
    .map_err(err)?;
    Ok(())
}

/* ---------- Tauri commands ---------- */

#[tauri::command]
pub fn get_favorite_keys(state: State<'_, AppState>) -> CmdResult<FavoriteKeys> {
    let conn = state.db.lock().map_err(err)?;
    keys(&conn).map_err(err)
}

#[tauri::command]
pub fn set_question_favorite(state: State<'_, AppState>, question_id: i64, mode: String, on: bool) -> CmdResult<()> {
    let conn = state.db.lock().map_err(err)?;
    set_question(&conn, question_id, &mode, on)
}

#[tauri::command]
pub fn set_exam_favorite(state: State<'_, AppState>, exam_id: String, on: bool) -> CmdResult<()> {
    let conn = state.db.lock().map_err(err)?;
    set_exam(&conn, &exam_id, on)
}

#[tauri::command]
pub fn list_favorites(state: State<'_, AppState>) -> CmdResult<Vec<Favorite>> {
    let conn = state.db.lock().map_err(err)?;
    list(&conn).map_err(err)
}

#[tauri::command]
pub fn mark_favorite_reviewed(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let conn = state.db.lock().map_err(err)?;
    mark_reviewed(&conn, id)
}

/* ---------- tests ---------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        db::init_in_memory().expect("in-memory db")
    }

    fn question_id(c: &Connection, key: &str) -> i64 {
        c.query_row("SELECT id FROM questions WHERE key = ?1", params![key], |r| r.get(0)).unwrap()
    }

    fn an_exam_id() -> String {
        exam::build_exam("basic").unwrap()[0].id.clone()
    }

    #[test]
    fn a_question_is_starred_in_its_mode_and_an_exam_question_as_it_is() {
        let c = conn();
        let word = question_id(&c, "w001");
        let grammar = question_id(&c, "g001");
        let exam_id = an_exam_id();
        set_question(&c, word, "choice", true).unwrap();
        set_question(&c, word, "typing", true).unwrap();
        set_question(&c, word, "choice", true).unwrap(); // twice keeps one
        set_question(&c, grammar, "choice", true).unwrap();
        set_exam(&c, &exam_id, true).unwrap();

        let k = keys(&c).unwrap();
        assert_eq!(k.questions.len(), 3, "a word by choice and by typing are two favorites");
        assert_eq!(k.exams, vec![exam_id.clone()]);

        let list = list(&c).unwrap();
        assert_eq!(list.len(), 4);
        let typed = list.iter().find_map(|f| f.question.as_ref().filter(|q| q.question.id == word && q.mode == "typing"));
        assert!(typed.is_some(), "built for the mode it was starred in");
        let g = list.iter().find_map(|f| f.question.as_ref().filter(|q| q.question.id == grammar)).unwrap();
        assert!(g.grammar_note.is_some(), "a grammar favorite carries its explanation");
        assert_eq!(list.iter().filter_map(|f| f.exam.as_ref()).next().unwrap().id, exam_id);

        set_question(&c, word, "typing", false).unwrap();
        set_exam(&c, &exam_id, false).unwrap();
        let k = keys(&c).unwrap();
        assert_eq!(k.questions.len(), 2);
        assert!(k.exams.is_empty());
    }

    #[test]
    fn what_is_not_a_question_cannot_be_starred() {
        let c = conn();
        let word = question_id(&c, "w001");
        assert!(set_question(&c, word, "review", true).is_err());
        assert!(set_question(&c, 9_999_999, "choice", true).is_err());
        assert!(set_exam(&c, "no-such-set-1", true).is_err());
        assert!(list(&c).unwrap().is_empty());
    }

    #[test]
    fn going_over_a_favorite_pays_nothing_and_leaves_the_study_alone() {
        let c = conn();
        let word = question_id(&c, "w002");
        set_question(&c, word, "choice", true).unwrap();
        let id = list(&c).unwrap()[0].id;
        assert!(list(&c).unwrap()[0].last_reviewed_at.is_none());
        mark_reviewed(&c, id).unwrap();
        assert!(list(&c).unwrap()[0].last_reviewed_at.is_some());
        let count = |table: &str| -> i64 { c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap() };
        assert_eq!(count("answer_log"), 0);
        assert_eq!(count("learning_history"), 0);
        assert_eq!(count("daily_stats"), 0);
    }
}
