//! お菓子作りレシピ: the learner's own word list. Words arrive by right-clicking English in a
//! question or an explanation, are reviewed as flashcards, and are cleared out once learned.

use crate::models::{RecipeAddResult, RecipeAddStatus, RecipeWord, RecipeWordInput};
use crate::util::now_ts;
use crate::AppState;
use rusqlite::{params, Connection, OptionalExtension, Row};
use tauri::State;

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

const COLS: &str = "id, word, meaning, form, example, example_ja, added_at, reviews, last_reviewed_at, mastered_at";

/// Long enough for any expression in the bank ("keep your fingers crossed"), short enough that a
/// stray selection of a whole paragraph is refused rather than saved as one "word".
const MAX_WORD_CHARS: usize = 60;

fn row_to_word(r: &Row) -> rusqlite::Result<RecipeWord> {
    Ok(RecipeWord {
        id: r.get(0)?,
        word: r.get(1)?,
        meaning: r.get(2)?,
        form: r.get(3)?,
        example: r.get(4)?,
        example_ja: r.get(5)?,
        added_at: r.get(6)?,
        reviews: r.get(7)?,
        last_reviewed_at: r.get(8)?,
        mastered_at: r.get(9)?,
    })
}

fn load(conn: &Connection, id: i64) -> CmdResult<RecipeWord> {
    conn.query_row(&format!("SELECT {COLS} FROM recipe_words WHERE id = ?1"), params![id], row_to_word)
        .optional()
        .map_err(err)?
        .ok_or_else(|| "その単語はレシピにありません".to_string())
}

pub fn list(conn: &Connection) -> CmdResult<Vec<RecipeWord>> {
    let mut stmt = conn
        .prepare(&format!("SELECT {COLS} FROM recipe_words ORDER BY added_at DESC, id DESC"))
        .map_err(err)?;
    let rows = stmt.query_map([], row_to_word).map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

/// Saves a word, or reports that it is already there. The same word turns up in many sentences,
/// so a second right-click is not an error: it keeps the first entry, and a word that had been
/// marked learned goes back into review, since reaching for it again says it was not.
pub fn add(conn: &Connection, input: &RecipeWordInput) -> CmdResult<RecipeAddResult> {
    let word = input.word.trim();
    if !word.chars().any(char::is_alphabetic) {
        return Err("レシピに入れる英単語がありません".into());
    }
    if word.chars().count() > MAX_WORD_CHARS {
        return Err("長すぎてレシピに入れられません".into());
    }
    let existing: Option<RecipeWord> = conn
        .query_row(&format!("SELECT {COLS} FROM recipe_words WHERE word = ?1"), params![word], row_to_word)
        .optional()
        .map_err(err)?;
    let example = input.example.trim();

    if let Some(found) = existing {
        let status = if found.mastered_at.is_some() {
            conn.execute("UPDATE recipe_words SET mastered_at = NULL WHERE id = ?1", params![found.id])
                .map_err(err)?;
            RecipeAddStatus::Restored
        } else {
            RecipeAddStatus::Exists
        };
        // Saved first from a lone headword ("apple" on its own), it had no sentence to show.
        if found.example.is_empty() && !example.is_empty() {
            conn.execute(
                "UPDATE recipe_words SET example = ?2, example_ja = ?3, form = ?4 WHERE id = ?1",
                params![found.id, example, input.example_ja.trim(), input.form.trim()],
            )
            .map_err(err)?;
        }
        return Ok(RecipeAddResult { status, entry: load(conn, found.id)? });
    }

    conn.execute(
        "INSERT INTO recipe_words (word, meaning, form, example, example_ja, added_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![word, input.meaning.trim(), input.form.trim(), example, input.example_ja.trim(), now_ts()],
    )
    .map_err(err)?;
    Ok(RecipeAddResult { status: RecipeAddStatus::Added, entry: load(conn, conn.last_insert_rowid())? })
}

/// One flashcard answered: "覚えた" marks the word learned, "まだ" keeps it in review.
pub fn review(conn: &Connection, id: i64, remembered: bool) -> CmdResult<RecipeWord> {
    let now = now_ts();
    let changed = conn
        .execute(
            "UPDATE recipe_words SET reviews = reviews + 1, last_reviewed_at = ?2,
             mastered_at = CASE WHEN ?3 THEN ?2 ELSE NULL END WHERE id = ?1",
            params![id, now, remembered],
        )
        .map_err(err)?;
    if changed == 0 {
        return Err("その単語はレシピにありません".into());
    }
    load(conn, id)
}

/// Marks or unmarks a word as learned from the list, without counting it as a review.
pub fn set_mastered(conn: &Connection, id: i64, mastered: bool) -> CmdResult<RecipeWord> {
    let changed = conn
        .execute(
            "UPDATE recipe_words SET mastered_at = CASE WHEN ?2 THEN COALESCE(mastered_at, ?3) ELSE NULL END WHERE id = ?1",
            params![id, mastered, now_ts()],
        )
        .map_err(err)?;
    if changed == 0 {
        return Err("その単語はレシピにありません".into());
    }
    load(conn, id)
}

pub fn delete(conn: &Connection, ids: &[i64]) -> CmdResult<usize> {
    let mut stmt = conn.prepare("DELETE FROM recipe_words WHERE id = ?1").map_err(err)?;
    let mut removed = 0;
    for id in ids {
        removed += stmt.execute(params![id]).map_err(err)?;
    }
    Ok(removed)
}

/* ---------- Tauri commands ---------- */

#[tauri::command]
pub fn list_recipe_words(state: State<'_, AppState>) -> CmdResult<Vec<RecipeWord>> {
    let conn = state.db.lock().map_err(err)?;
    list(&conn)
}

#[tauri::command]
pub fn add_recipe_word(state: State<'_, AppState>, entry: RecipeWordInput) -> CmdResult<RecipeAddResult> {
    let conn = state.db.lock().map_err(err)?;
    add(&conn, &entry)
}

#[tauri::command]
pub fn review_recipe_word(state: State<'_, AppState>, id: i64, remembered: bool) -> CmdResult<RecipeWord> {
    let conn = state.db.lock().map_err(err)?;
    review(&conn, id, remembered)
}

#[tauri::command]
pub fn set_recipe_mastered(state: State<'_, AppState>, id: i64, mastered: bool) -> CmdResult<RecipeWord> {
    let conn = state.db.lock().map_err(err)?;
    set_mastered(&conn, id, mastered)
}

#[tauri::command]
pub fn delete_recipe_words(state: State<'_, AppState>, ids: Vec<i64>) -> CmdResult<usize> {
    let conn = state.db.lock().map_err(err)?;
    delete(&conn, &ids)
}

/* ---------- tests ---------- */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn input(word: &str, example: &str) -> RecipeWordInput {
        RecipeWordInput {
            word: word.into(),
            meaning: "聞く".into(),
            form: "heard".into(),
            example: example.into(),
            example_ja: if example.is_empty() { String::new() } else { "訳".into() },
        }
    }

    #[test]
    fn a_word_is_saved_once_with_the_sentence_it_came_from() {
        let c = db::init_in_memory().unwrap();
        let first = add(&c, &input("hear", "The moment I heard the news, I called you.")).unwrap();
        assert_eq!(first.status, RecipeAddStatus::Added);
        assert_eq!(first.entry.word, "hear");
        assert_eq!(first.entry.form, "heard");
        assert_eq!(first.entry.example, "The moment I heard the news, I called you.");
        assert!(first.entry.mastered_at.is_none());

        // The same word from another sentence, in any case, is the same entry.
        let again = add(&c, &input("Hear", "I can't hear you.")).unwrap();
        assert_eq!(again.status, RecipeAddStatus::Exists);
        assert_eq!(again.entry.id, first.entry.id);
        assert_eq!(again.entry.example, "The moment I heard the news, I called you.");
        assert_eq!(list(&c).unwrap().len(), 1);
    }

    #[test]
    fn a_word_saved_without_a_sentence_takes_the_first_one_offered() {
        let c = db::init_in_memory().unwrap();
        let bare = add(&c, &input("apple", "")).unwrap();
        assert!(bare.entry.example.is_empty());
        let later = add(&c, &input("apple", "She ate an apple.")).unwrap();
        assert_eq!(later.status, RecipeAddStatus::Exists);
        assert_eq!(later.entry.example, "She ate an apple.");
        assert_eq!(later.entry.example_ja, "訳");
    }

    #[test]
    fn nothing_that_is_not_a_word_is_saved() {
        let c = db::init_in_memory().unwrap();
        assert!(add(&c, &input("  ", "")).is_err());
        assert!(add(&c, &input("1995", "")).is_err());
        assert!(add(&c, &input(&"a".repeat(MAX_WORD_CHARS + 1), "")).is_err());
        assert!(list(&c).unwrap().is_empty());
    }

    #[test]
    fn reviewing_marks_words_learned_and_learned_words_can_be_cleared() {
        let c = db::init_in_memory().unwrap();
        let hear = add(&c, &input("hear", "")).unwrap().entry;
        let bag = add(&c, &input("doggy bag", "")).unwrap().entry;

        let not_yet = review(&c, hear.id, false).unwrap();
        assert_eq!(not_yet.reviews, 1);
        assert!(not_yet.last_reviewed_at.is_some());
        assert!(not_yet.mastered_at.is_none());

        let learned = review(&c, hear.id, true).unwrap();
        assert_eq!(learned.reviews, 2);
        assert!(learned.mastered_at.is_some());

        // Unmarking from the list puts it back without counting a review.
        let back = set_mastered(&c, hear.id, false).unwrap();
        assert!(back.mastered_at.is_none());
        assert_eq!(back.reviews, 2);
        assert!(set_mastered(&c, hear.id, true).unwrap().mastered_at.is_some());

        assert_eq!(delete(&c, &[hear.id]).unwrap(), 1);
        let left = list(&c).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, bag.id);
        assert!(review(&c, hear.id, true).is_err(), "a deleted word cannot be reviewed");
    }

    #[test]
    fn saving_a_learned_word_again_puts_it_back_into_review() {
        let c = db::init_in_memory().unwrap();
        let hear = add(&c, &input("hear", "")).unwrap().entry;
        review(&c, hear.id, true).unwrap();
        let again = add(&c, &input("hear", "")).unwrap();
        assert_eq!(again.status, RecipeAddStatus::Restored);
        assert!(again.entry.mastered_at.is_none());
    }
}
