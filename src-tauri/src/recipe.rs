//! お菓子作りレシピ: the learner's own word list. Words arrive by right-clicking English in a
//! question or an explanation, are reviewed by picking the meaning or typing the English, and are
//! cleared out once learned. A correct review pays 0.5 kcal (picked) or 1 kcal (typed).

use crate::models::{RecipeAddResult, RecipeAddStatus, RecipeReviewResult, RecipeWord, RecipeWordInput};
use crate::srs;
use crate::util::{now_ts, today};
use crate::AppState;
use rusqlite::{params, Connection, OptionalExtension, Row};
use tauri::State;

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// The single player, as in `commands.rs`.
const USER_ID: i64 = 1;

const COLS: &str =
    "id, word, meaning, form, example, example_ja, added_at, reviews, last_reviewed_at, mastered_at, kind";

/// Long enough for any expression in the bank ("keep your fingers crossed"), short enough that a
/// stray selection of a whole paragraph is refused rather than saved as one "word".
const MAX_WORD_CHARS: usize = 60;

fn row_to_word(r: &Row) -> rusqlite::Result<RecipeWord> {
    let word: String = r.get(1)?;
    let meaning: String = r.get(2)?;
    let kind: String = r.get(10)?;
    Ok(RecipeWord {
        id: r.get(0)?,
        // A pattern is sorted as a pattern, whatever its verb is.
        pos: if kind == "usage" { "usage".to_string() } else { crate::db::recipe_pos(&word, &meaning) },
        kind,
        word,
        meaning,
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

    let kind = if input.kind == "usage" { "usage" } else { "word" };
    conn.execute(
        "INSERT INTO recipe_words (word, meaning, form, example, example_ja, added_at, kind) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![word, input.meaning.trim(), input.form.trim(), example, input.example_ja.trim(), now_ts(), kind],
    )
    .map_err(err)?;
    Ok(RecipeAddResult { status: RecipeAddStatus::Added, entry: load(conn, conn.last_insert_rowid())? })
}

/// The meanings of every pattern of 用法, for the wrong options when a pattern saved to the recipe
/// is reviewed: a meaning like 「AとBを比較する」 among nouns would give itself away.
pub fn usage_meanings() -> Vec<String> {
    let mut out: Vec<String> =
        crate::db::word_usages().values().flat_map(|us| us.iter().map(|u| u.ja.clone())).collect();
    out.sort();
    out.dedup();
    out
}

/// One word reviewed in `mode` ("choice": its meaning picked from four, "typing": the English
/// written from the meaning). Right pays into today's kcal and leaves the word where it is: a
/// right answer may be a lucky one, so the learner says whether the word is learned
/// (`set_mastered`, the 習得 / まだ buttons). Wrong puts it back into review, learned or not. Pay is
/// counted in quarters per day, so two meanings picked make a whole calorie; whatever fraction is
/// left when the day ends is dropped. A word pays in full the first time it is right in a day and
/// half after that, so going over the learned words again still counts, for less.
pub fn review(conn: &mut Connection, id: i64, remembered: bool, mode: &str) -> CmdResult<RecipeReviewResult> {
    srs::recipe_quarter_kcal(mode, true).ok_or_else(|| format!("unknown review mode {mode}"))?;
    let tx = conn.transaction().map_err(err)?;
    let now = now_ts();
    let day = today();
    let paid_on: Option<String> = tx
        .query_row("SELECT paid_on FROM recipe_words WHERE id = ?1", params![id], |r| r.get(0))
        .optional()
        .map_err(err)?
        .ok_or_else(|| "その単語はレシピにありません".to_string())?;
    let repeat = paid_on.as_deref() == Some(day.as_str());
    tx.execute(
        "UPDATE recipe_words SET reviews = reviews + 1, last_reviewed_at = ?2,
         mastered_at = CASE WHEN ?3 THEN mastered_at ELSE NULL END,
         paid_on = CASE WHEN ?3 THEN ?4 ELSE paid_on END
         WHERE id = ?1",
        params![id, now, remembered, day],
    )
    .map_err(err)?;

    tx.execute("INSERT OR IGNORE INTO daily_stats (user_id, date) VALUES (?1, ?2)", params![USER_ID, day])
        .map_err(err)?;
    let before: i64 = tx
        .query_row(
            "SELECT recipe_quarter_kcal FROM daily_stats WHERE user_id = ?1 AND date = ?2",
            params![USER_ID, day],
            |r| r.get(0),
        )
        .map_err(err)?;
    let gained = if remembered { srs::recipe_quarter_kcal(mode, !repeat).unwrap_or(0) } else { 0 };
    let kcal = srs::recipe_kcal_gain(before, gained);
    tx.execute(
        "UPDATE daily_stats SET recipe_quarter_kcal = recipe_quarter_kcal + ?3, kcal_earned = kcal_earned + ?4
         WHERE user_id = ?1 AND date = ?2",
        params![USER_ID, day, gained, kcal],
    )
    .map_err(err)?;
    let today_kcal: i64 = tx
        .query_row(
            "SELECT kcal_earned FROM daily_stats WHERE user_id = ?1 AND date = ?2",
            params![USER_ID, day],
            |r| r.get(0),
        )
        .map_err(err)?;
    let entry = load(&tx, id)?;
    tx.commit().map_err(err)?;
    Ok(RecipeReviewResult {
        entry,
        earned_quarters: gained,
        repeat,
        kcal_earned: kcal,
        today_kcal,
        fraction_pending: (before + gained) % 4 != 0,
    })
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
pub fn review_recipe_word(
    state: State<'_, AppState>,
    id: i64,
    remembered: bool,
    mode: String,
) -> CmdResult<RecipeReviewResult> {
    let mut conn = state.db.lock().map_err(err)?;
    review(&mut conn, id, remembered, &mode)
}

#[tauri::command]
pub fn set_recipe_mastered(state: State<'_, AppState>, id: i64, mastered: bool) -> CmdResult<RecipeWord> {
    let conn = state.db.lock().map_err(err)?;
    set_mastered(&conn, id, mastered)
}

#[tauri::command]
pub fn get_usage_meanings() -> Vec<String> {
    usage_meanings()
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
            kind: String::new(),
        }
    }

    /// A pattern right-clicked in 用法 is saved as one entry, kept apart from words: sorted as a
    /// pattern, and a word of the same spelling would be another entry.
    #[test]
    fn a_pattern_is_saved_as_a_usage() {
        let c = db::init_in_memory().unwrap();
        let usage = RecipeWordInput {
            word: "compare A with B".into(),
            meaning: "AとBを比較する".into(),
            form: String::new(),
            example: "We compared the new model with the old one.".into(),
            example_ja: "新型を旧型と比較した。".into(),
            kind: "usage".into(),
        };
        let r = add(&c, &usage).unwrap();
        assert_eq!(r.status, RecipeAddStatus::Added);
        assert_eq!((r.entry.kind.as_str(), r.entry.pos.as_str()), ("usage", "usage"));
        assert_eq!(r.entry.word, "compare A with B");
        let word = add(&c, &input("compare", "")).unwrap().entry;
        assert_eq!((word.kind.as_str(), word.pos.as_str()), ("word", "verb"));
        assert!(usage_meanings().contains(&"～を訪れる（to は付けない）".to_string()));
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

    /// A right answer does not make a word learned by itself: the learner marks it learned (習得)
    /// or keeps it in review (まだ). A wrong answer puts it back into review.
    #[test]
    fn reviewing_leaves_learning_to_the_learner_and_learned_words_can_be_cleared() {
        let mut c = db::init_in_memory().unwrap();
        let hear = add(&c, &input("hear", "")).unwrap().entry;
        let bag = add(&c, &input("doggy bag", "")).unwrap().entry;

        let not_yet = review(&mut c, hear.id, false, "choice").unwrap().entry;
        assert_eq!(not_yet.reviews, 1);
        assert!(not_yet.last_reviewed_at.is_some());
        assert!(not_yet.mastered_at.is_none());

        let right = review(&mut c, hear.id, true, "typing").unwrap().entry;
        assert_eq!(right.reviews, 2);
        assert!(right.mastered_at.is_none(), "right alone does not make it learned");
        // 習得: learned, without counting another review.
        let learned = set_mastered(&c, hear.id, true).unwrap();
        assert!(learned.mastered_at.is_some());
        assert_eq!(learned.reviews, 2);

        // まだ (or unmarking from the list) puts it back without counting a review.
        let back = set_mastered(&c, hear.id, false).unwrap();
        assert!(back.mastered_at.is_none());
        assert_eq!(back.reviews, 2);
        assert!(set_mastered(&c, hear.id, true).unwrap().mastered_at.is_some());

        assert_eq!(delete(&c, &[hear.id]).unwrap(), 1);
        let left = list(&c).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, bag.id);
        assert!(review(&mut c, hear.id, true, "choice").is_err(), "a deleted word cannot be reviewed");
    }

    #[test]
    fn a_meaning_picked_pays_half_a_calorie_and_a_word_typed_pays_one() {
        let mut c = db::init_in_memory().unwrap();
        let ids: Vec<i64> = ["hear", "apple", "bag", "cloud", "river"]
            .iter()
            .map(|w| add(&c, &input(w, "")).unwrap().entry.id)
            .collect();
        let kcal = |c: &Connection| -> i64 {
            c.query_row("SELECT kcal_earned FROM daily_stats WHERE date = ?1", params![today()], |r| r.get(0))
                .unwrap()
        };

        // 0.5 kcal: nothing whole yet, and nothing is lost either.
        let r = review(&mut c, ids[0], true, "choice").unwrap();
        assert_eq!((r.earned_quarters, r.kcal_earned, r.today_kcal, r.fraction_pending), (2, 0, 0, true));
        // A miss pays nothing and leaves the half waiting.
        let r = review(&mut c, ids[1], false, "choice").unwrap();
        assert_eq!((r.earned_quarters, r.kcal_earned, r.fraction_pending), (0, 0, true));
        // The second half makes a calorie.
        let r = review(&mut c, ids[2], true, "choice").unwrap();
        assert_eq!((r.kcal_earned, r.today_kcal, r.fraction_pending), (1, 1, false));
        // A word typed is a calorie of its own; a pending half stays pending beside it.
        review(&mut c, ids[3], true, "choice").unwrap();
        let r = review(&mut c, ids[4], true, "typing").unwrap();
        assert_eq!((r.earned_quarters, r.kcal_earned, r.today_kcal, r.fraction_pending), (4, 1, 2, true));
        assert_eq!(kcal(&c), 2, "1.5 + 1 = 2.5 kcal, of which the half is not paid");

        assert!(review(&mut c, ids[0], true, "speaking").is_err());
        assert_eq!(kcal(&c), 2, "an unknown mode changes nothing");
    }

    /// Learned words can be gone over again: right leaves them learned (from the day they were
    /// first learned), wrong puts them back into review. A word pays in full the first time it is
    /// right in a day (0.5 / 1 kcal) and half that every time after (0.25 / 0.5 kcal).
    #[test]
    fn a_word_right_again_the_same_day_pays_half() {
        let mut c = db::init_in_memory().unwrap();
        let hear = add(&c, &input("hear", "")).unwrap().entry.id;
        let bag = add(&c, &input("doggy bag", "")).unwrap().entry.id;

        let first = review(&mut c, hear, true, "typing").unwrap();
        assert!(!first.repeat);
        assert_eq!((first.earned_quarters, first.kcal_earned), (4, 1));
        let learned_at = set_mastered(&c, hear, true).unwrap().mastered_at.expect("learned");

        // The same day, over the learned words again: still learned, still dated the first time,
        // and half a calorie for the same word typed again.
        let again = review(&mut c, hear, true, "typing").unwrap();
        assert!(again.repeat);
        assert_eq!((again.earned_quarters, again.kcal_earned, again.today_kcal), (2, 0, 1));
        assert_eq!(again.entry.mastered_at.as_deref(), Some(learned_at.as_str()));
        assert_eq!(again.entry.reviews, 2);
        // A third time is half too: 1 + 0.5 + 0.5 makes the second calorie.
        let third = review(&mut c, hear, true, "typing").unwrap();
        assert_eq!((third.earned_quarters, third.kcal_earned, third.today_kcal), (2, 1, 2));
        // Picked from four again that day: a quarter.
        let picked = review(&mut c, hear, true, "choice").unwrap();
        assert_eq!((picked.earned_quarters, picked.kcal_earned), (1, 0));

        // Forgotten: back into review, and a miss pays nothing.
        let forgot = review(&mut c, hear, false, "choice").unwrap();
        assert!(forgot.entry.mastered_at.is_none());
        assert_eq!((forgot.earned_quarters, forgot.kcal_earned), (0, 0));

        // Another word still pays in full today: 2.25 + 1 = 3.25 kcal, 3 of them paid.
        let other = review(&mut c, bag, true, "typing").unwrap();
        assert!(!other.repeat);
        assert_eq!((other.earned_quarters, other.today_kcal, other.fraction_pending), (4, 3, true));

        // The next day the word pays in full again.
        c.execute("UPDATE recipe_words SET paid_on = '2000-01-01' WHERE id = ?1", params![hear]).unwrap();
        assert_eq!(review(&mut c, hear, true, "typing").unwrap().earned_quarters, 4);
    }

    #[test]
    fn saving_a_learned_word_again_puts_it_back_into_review() {
        let c = db::init_in_memory().unwrap();
        let mut c = c;
        let hear = add(&c, &input("hear", "")).unwrap().entry;
        review(&mut c, hear.id, true, "choice").unwrap();
        set_mastered(&c, hear.id, true).unwrap();
        let again = add(&c, &input("hear", "")).unwrap();
        assert_eq!(again.status, RecipeAddStatus::Restored);
        assert!(again.entry.mastered_at.is_none());
    }
}
