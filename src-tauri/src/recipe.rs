//! お菓子作りレシピ: the learner's own word list. Words arrive by right-clicking English in a
//! question or an explanation and are reviewed by picking the meaning or typing the English. A
//! word is in review (復習中), learned (習得済み) or taken off the list (除外中, by ×); すべて is
//! every word not taken off. A correct review pays 0.5 kcal (picked) or 1 kcal (typed).

/// The tabs a review can go over: すべて, 復習中, 習得済み, 除外中.
pub const REVIEW_TARGETS: [&str; 4] = ["all", "learning", "mastered", "excluded"];

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

const COLS: &str = "id, word, meaning, form, example, example_ja, added_at, reviews, last_reviewed_at, mastered_at, kind, \
                    misses, excluded_at";

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
        misses: r.get(11)?,
        excluded_at: r.get(12)?,
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
/// learned or taken off the list goes back into review, since reaching for it again says it was
/// not done with.
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
    let example = example_sentence(input.example.trim(), input.example_ja.trim(), input.form.trim(), word);
    let example = example.as_str();

    if let Some(found) = existing {
        let status = if found.excluded_at.is_some() || found.mastered_at.is_some() {
            conn.execute(
                "UPDATE recipe_words SET mastered_at = NULL, excluded_at = NULL WHERE id = ?1",
                params![found.id],
            )
            .map_err(err)?;
            if found.excluded_at.is_some() {
                RecipeAddStatus::Unexcluded
            } else {
                RecipeAddStatus::Restored
            }
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

/// `text` has `word` (any case) with no letter right before or after it.
fn has_word(text: &str, word: &str) -> bool {
    let (text, word) = (text.to_lowercase(), word.to_lowercase());
    if word.is_empty() {
        return false;
    }
    text.match_indices(&word).any(|(at, _)| {
        let before = text[..at].chars().next_back();
        let after = text[at + word.len()..].chars().next();
        !before.is_some_and(char::is_alphabetic) && !after.is_some_and(char::is_alphabetic)
    })
}

/// The sentence of `example` a word is saved with: a passage with no Japanese of its own (an
/// exam's notice or email) is cut down to the sentence the word is in, by the form it was found in
/// or else the word. A sentence with its Japanese is kept whole, as the two go together.
pub(crate) fn example_sentence(example: &str, example_ja: &str, form: &str, word: &str) -> String {
    if !example_ja.is_empty() {
        return example.to_string();
    }
    let sentences = crate::exam::sentences(example);
    if sentences.len() < 2 {
        return example.to_string();
    }
    [form, word]
        .iter()
        .find_map(|w| sentences.iter().find(|s| has_word(s, w)))
        .cloned()
        .unwrap_or_else(|| example.to_string())
}

/// 用法 renamed when the slots came to be written A／B, 節, 形容詞 and the like, whose old way does not
/// tell the new one apart by its words (the ～ of become ～ is now A／形容詞).
const RENAMED_USAGES: &[(&str, &str)] = &[
    ("not ～ anymore", "not 原形 anymore"),
    ("become ～（名詞・形容詞）", "become A／形容詞"),
    ("be capable of ～", "be capable of A／-ing"),
    ("not ～ either", "not 原形 either"),
    ("Have you ever ～?", "Have you ever 過去分詞?"),
    ("look forward to ～", "look forward to A／-ing"),
    ("prove (to be) ～", "prove (to be) A／形容詞"),
    ("seem (to be) ～", "seem (to be) A／形容詞"),
    ("～, though.", "節, though."),
    ("turn out to be ～", "turn out to be A／形容詞"),
    ("What's wrong with ～?", "What's wrong with A?"),
];

/// A pattern with every slot as "_", the asides in （ ） left out and ways apart as "|": the old
/// "be confident in/about ～" and the new "be confident in/about A" are the same.
fn loose_pattern(pattern: &str) -> String {
    let mut plain = String::new();
    let mut aside = 0;
    for c in pattern.chars() {
        match c {
            '（' => aside += 1,
            '）' => aside -= 1,
            _ if aside == 0 => plain.push(c),
            _ => {}
        }
    }
    plain
        .replace('／', " | ")
        .replace(" / ", " | ")
        .split_whitespace()
        .map(|t| if ["～", "…", "A", "B", "節", "形容詞", "過去分詞"].contains(&t) { "_".to_string() } else { t.to_lowercase() })
        .collect::<Vec<_>>()
        .join(" ")
}

/// 用法 saved in the recipe in the old notation (be afraid of ～) move to the pattern they are now
/// (be afraid of A), with its Japanese. Runs at every start; one already moved is left alone.
pub(crate) fn migrate_usage_notation(conn: &Connection) -> rusqlite::Result<usize> {
    let saved: Vec<(i64, String)> = {
        let mut stmt = conn.prepare("SELECT id, word FROM recipe_words WHERE kind = 'usage'")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    let all: Vec<&crate::models::WordUsage> = crate::db::word_usages().values().flatten().collect();
    let mut moved = 0;
    for (id, word) in saved {
        if all.iter().any(|u| u.pattern == word) {
            continue;
        }
        let target = match RENAMED_USAGES.iter().find(|(old, _)| *old == word) {
            Some((_, new)) => all.iter().find(|u| u.pattern == *new).copied(),
            None => {
                let key = loose_pattern(&word);
                let mut hits: Vec<&&crate::models::WordUsage> = all.iter().filter(|u| loose_pattern(&u.pattern) == key).collect();
                hits.dedup_by(|a, b| a.pattern == b.pattern);
                (hits.len() == 1).then(|| *hits[0])
            }
        };
        let Some(u) = target else { continue };
        let taken: bool =
            conn.query_row("SELECT EXISTS (SELECT 1 FROM recipe_words WHERE word = ?1)", params![u.pattern], |r| r.get(0))?;
        if !taken {
            moved += conn.execute("UPDATE recipe_words SET word = ?2, meaning = ?3 WHERE id = ?1", params![id, u.pattern, u.ja])?;
        }
    }
    Ok(moved)
}

/// Words saved from a passage before they were cut down to their sentence (see `example_sentence`).
pub(crate) fn trim_passage_examples(conn: &Connection) -> rusqlite::Result<usize> {
    let rows: Vec<(i64, String, String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, example, form, word FROM recipe_words WHERE COALESCE(example_ja, '') = '' AND example <> ''",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    let mut changed = 0;
    for (id, example, form, word) in rows {
        let one = example_sentence(&example, "", &form, &word);
        if one != example {
            changed += conn.execute("UPDATE recipe_words SET example = ?2 WHERE id = ?1", params![id, one])?;
        }
    }
    Ok(changed)
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
/// written from the meaning) from the tab `target`. A right answer in すべて / 復習中 makes the
/// word learned, though the learner can still say まだ, which puts it back into review
/// (`set_mastered`); in 習得済み / 除外中 it leaves the word where it is. A wrong answer puts it
/// back into review (復習中, and so すべて) from any tab, learned or taken off, and counts as a
/// miss. Pay is counted in quarters per day, so two meanings picked make a whole calorie; whatever fraction is left when the day ends is dropped. A
/// word pays in full the first time it is right in a day and half after that.
pub fn review(conn: &mut Connection, id: i64, remembered: bool, mode: &str, target: &str) -> CmdResult<RecipeReviewResult> {
    srs::recipe_quarter_kcal(mode, true).ok_or_else(|| format!("unknown review mode {mode}"))?;
    if !REVIEW_TARGETS.contains(&target) {
        return Err(format!("unknown review target {target}"));
    }
    let learned = remembered && matches!(target, "all" | "learning");
    let back = !remembered;
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
         misses = misses + CASE WHEN ?3 THEN 0 ELSE 1 END,
         mastered_at = CASE WHEN ?5 THEN COALESCE(mastered_at, ?2) WHEN ?6 THEN NULL ELSE mastered_at END,
         excluded_at = CASE WHEN ?6 THEN NULL ELSE excluded_at END,
         paid_on = CASE WHEN ?3 THEN ?4 ELSE paid_on END
         WHERE id = ?1",
        params![id, now, remembered, day, learned, back],
    )
    .map_err(err)?;

    let quarters = if remembered { srs::recipe_quarter_kcal(mode, !repeat).unwrap_or(0) } else { 0 };
    let paid = crate::commands::credit(&tx, &day, quarters * srs::EIGHTHS / 4).map_err(err)?;
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
        points: paid.points(),
        repeat,
        kcal_earned: paid.whole,
        today_kcal,
        fraction_pending: paid.pending,
    })
}

/// Marks a word as learned (✓ 覚えた) or puts it back into review (復習に戻す) from the list,
/// without counting it as a review. Either way it leaves 除外中.
pub fn set_mastered(conn: &Connection, id: i64, mastered: bool) -> CmdResult<RecipeWord> {
    let changed = conn
        .execute(
            "UPDATE recipe_words SET mastered_at = CASE WHEN ?2 THEN COALESCE(mastered_at, ?3) ELSE NULL END,
             excluded_at = NULL WHERE id = ?1",
            params![id, mastered, now_ts()],
        )
        .map_err(err)?;
    if changed == 0 {
        return Err("その単語はレシピにありません".into());
    }
    load(conn, id)
}

/// Marks every word of `ids` learned, or puts them all back into review (すべて習得済みへ in 復習中,
/// すべて復習中へ in 習得済み), as ✓ 覚えた / 復習に戻す does for one word. Returns how many there were.
pub fn set_mastered_all(conn: &Connection, ids: &[i64], mastered: bool) -> CmdResult<usize> {
    let now = now_ts();
    let mut stmt = conn
        .prepare(
            "UPDATE recipe_words SET mastered_at = CASE WHEN ?2 THEN COALESCE(mastered_at, ?3) ELSE NULL END,
             excluded_at = NULL WHERE id = ?1",
        )
        .map_err(err)?;
    let mut changed = 0;
    for id in ids {
        changed += stmt.execute(params![id, mastered, now]).map_err(err)?;
    }
    Ok(changed)
}

/// Takes words off the list (× outside 除外中): they wait in 除外中 and leave すべて.
pub fn exclude(conn: &Connection, ids: &[i64]) -> CmdResult<usize> {
    let now = now_ts();
    let mut stmt =
        conn.prepare("UPDATE recipe_words SET excluded_at = COALESCE(excluded_at, ?2) WHERE id = ?1").map_err(err)?;
    let mut moved = 0;
    for id in ids {
        moved += stmt.execute(params![id, now]).map_err(err)?;
    }
    Ok(moved)
}

/// Deletes words for good (× in 除外中).
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
    target: String,
) -> CmdResult<RecipeReviewResult> {
    let mut conn = state.db.lock().map_err(err)?;
    review(&mut conn, id, remembered, &mode, &target)
}

#[tauri::command]
pub fn set_recipe_mastered(state: State<'_, AppState>, id: i64, mastered: bool) -> CmdResult<RecipeWord> {
    let conn = state.db.lock().map_err(err)?;
    set_mastered(&conn, id, mastered)
}

#[tauri::command]
pub fn set_recipe_words_mastered(state: State<'_, AppState>, ids: Vec<i64>, mastered: bool) -> CmdResult<usize> {
    let conn = state.db.lock().map_err(err)?;
    set_mastered_all(&conn, &ids, mastered)
}

#[tauri::command]
pub fn get_usage_meanings() -> Vec<String> {
    usage_meanings()
}

#[tauri::command]
pub fn exclude_recipe_words(state: State<'_, AppState>, ids: Vec<i64>) -> CmdResult<usize> {
    let conn = state.db.lock().map_err(err)?;
    exclude(&conn, &ids)
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
        assert!(usage_meanings().contains(&"Aを訪れる（to は付けない）".to_string()));
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

    /// In すべて / 復習中 a right answer makes a word learned; in 習得済み / 除外中 it leaves it where
    /// it is. A wrong answer puts it back into review from any tab, and counts as a miss.
    #[test]
    fn where_a_review_moves_a_word_depends_on_its_tab() {
        let mut c = db::init_in_memory().unwrap();
        let hear = add(&c, &input("hear", "")).unwrap().entry.id;
        let bag = add(&c, &input("doggy bag", "")).unwrap().entry.id;

        // 復習中: wrong stays, right is learned.
        let wrong = review(&mut c, hear, false, "choice", "learning").unwrap().entry;
        assert_eq!((wrong.reviews, wrong.misses), (1, 1));
        assert!(wrong.last_reviewed_at.is_some() && wrong.mastered_at.is_none());
        let right = review(&mut c, hear, true, "typing", "learning").unwrap().entry;
        assert_eq!((right.reviews, right.misses), (2, 1));
        let learned_at = right.mastered_at.clone().expect("right in 復習中 is learned");

        // すべて: right keeps the day it was learned; a learned word answered wrong goes back into review.
        let right = review(&mut c, hear, true, "choice", "all").unwrap().entry;
        assert_eq!(right.mastered_at.as_deref(), Some(learned_at.as_str()));
        let wrong = review(&mut c, hear, false, "choice", "all").unwrap().entry;
        assert!(wrong.mastered_at.is_none());
        assert_eq!(wrong.misses, 2);
        assert!(review(&mut c, hear, true, "choice", "all").unwrap().entry.mastered_at.is_some());

        // 習得済み: right stays learned, wrong goes back into review.
        assert!(review(&mut c, hear, true, "choice", "mastered").unwrap().entry.mastered_at.is_some());
        let back = review(&mut c, hear, false, "choice", "mastered").unwrap().entry;
        assert!(back.mastered_at.is_none());
        assert_eq!(back.misses, 3);

        // 除外中: right stays taken off, wrong comes back into review.
        assert_eq!(exclude(&c, &[bag]).unwrap(), 1);
        let kept = review(&mut c, bag, true, "choice", "excluded").unwrap().entry;
        assert!(kept.excluded_at.is_some());
        let returned = review(&mut c, bag, false, "choice", "excluded").unwrap().entry;
        assert!(returned.excluded_at.is_none() && returned.mastered_at.is_none());

        assert!(review(&mut c, hear, true, "choice", "lost").is_err(), "an unknown tab is refused");
    }

    /// × takes a word off the list into 除外中; 復習に戻す (or saving it again) brings it back into
    /// review, and × in 除外中 deletes it for good.
    /// A word right-clicked in an exam's passage keeps the sentence it is in, not the whole notice;
    /// words saved so before are cut down the same way, and a sentence with its Japanese stays whole.
    #[test]
    fn a_word_from_a_passage_keeps_only_its_sentence() {
        let c = db::init_in_memory().unwrap();
        let passage = "The 12th Annual Logistics Conference will take place at the Harbor Convention Center from October 8 to 10. This year's theme is \"Building Resilient Supply Chains.\" Ms. Lee will speak at 10 a.m. on the first day.";
        let mut entry = input("logistics", passage);
        entry.form = "Logistics".into();
        entry.example_ja = String::new();
        let saved = add(&c, &entry).unwrap().entry;
        assert_eq!(saved.example, "The 12th Annual Logistics Conference will take place at the Harbor Convention Center from October 8 to 10.");
        assert_eq!(
            example_sentence(passage, "", "speak", "speak"),
            "Ms. Lee will speak at 10 a.m. on the first day.",
            "Ms. is no end of a sentence"
        );
        assert_eq!(example_sentence(passage, "訳", "theme", "theme"), passage, "with its Japanese it stays whole");
        assert_eq!(example_sentence(passage, "", "logistic", "logistic"), passage, "a word not in it leaves it as it was");

        // Saved whole before: cut down once, at start.
        c.execute(
            "INSERT INTO recipe_words (word, meaning, form, example, example_ja, added_at) VALUES ('theme', 'テーマ', 'theme', ?1, '', '2026-10-01T00:00:00')",
            params![passage],
        )
        .unwrap();
        assert_eq!(trim_passage_examples(&c).unwrap(), 1);
        let theme = list(&c).unwrap().into_iter().find(|w| w.word == "theme").unwrap();
        assert_eq!(theme.example, "This year's theme is \"Building Resilient Supply Chains.\"");
        assert_eq!(trim_passage_examples(&c).unwrap(), 0, "nothing left to cut");
    }

    /// 用法 saved in the old notation move to the new one with its Japanese; one the bank no longer
    /// has stays as it was.
    #[test]
    fn usages_saved_in_the_old_notation_move_to_the_new() {
        let c = db::init_in_memory().unwrap();
        for (word, meaning) in [("be confident in/about ～", "～に自信がある"), ("look forward to ～", "～を楽しみに待つ"), ("no such ～", "なし")] {
            c.execute(
                "INSERT INTO recipe_words (word, meaning, form, example, example_ja, added_at, kind) VALUES (?1, ?2, '', '', '', '2026-10-01T00:00:00', 'usage')",
                params![word, meaning],
            )
            .unwrap();
        }
        assert_eq!(migrate_usage_notation(&c).unwrap(), 2);
        let saved: Vec<(String, String)> = list(&c).unwrap().into_iter().map(|w| (w.word, w.meaning)).collect();
        assert!(saved.contains(&("be confident in/about A".to_string(), "Aに自信がある".to_string())), "{saved:?}");
        assert!(saved.contains(&("look forward to A／-ing".to_string(), "A／-ingを楽しみに待つ".to_string())), "{saved:?}");
        assert!(saved.iter().any(|(w, _)| w == "no such ～"));
        assert_eq!(migrate_usage_notation(&c).unwrap(), 0, "nothing left to move");
    }

    /// The tabs' bulk buttons: every word of 復習中 learned, every word of 習得済み back in review.
    #[test]
    fn a_whole_tab_is_learned_or_put_back_at_once() {
        let c = db::init_in_memory().unwrap();
        let ids: Vec<i64> = ["apple", "banana", "cherry"].iter().map(|w| add(&c, &input(w, "")).unwrap().entry.id).collect();
        assert_eq!(set_mastered_all(&c, &ids, true).unwrap(), 3);
        assert!(list(&c).unwrap().iter().all(|w| w.mastered_at.is_some()));
        assert_eq!(set_mastered_all(&c, &ids[..2], false).unwrap(), 2);
        let learning: Vec<String> = list(&c).unwrap().into_iter().filter(|w| w.mastered_at.is_none()).map(|w| w.word).collect();
        assert_eq!(learning.len(), 2);
        assert!(!learning.contains(&"cherry".to_string()));
        assert_eq!(set_mastered_all(&c, &[9999], true).unwrap(), 0, "a word no longer there is skipped");
    }

    #[test]
    fn a_word_taken_off_waits_in_its_own_tab_until_put_back_or_deleted() {
        let mut c = db::init_in_memory().unwrap();
        let hear = add(&c, &input("hear", "")).unwrap().entry.id;
        let bag = add(&c, &input("doggy bag", "")).unwrap().entry.id;
        review(&mut c, hear, true, "choice", "learning").unwrap();

        assert_eq!(exclude(&c, &[hear, bag]).unwrap(), 2);
        let all = list(&c).unwrap();
        assert!(all.iter().all(|w| w.excluded_at.is_some()), "still listed, as taken off");
        // 復習に戻す: back into review, learned or not before.
        let back = set_mastered(&c, hear, false).unwrap();
        assert!(back.excluded_at.is_none() && back.mastered_at.is_none());
        // Saving it again brings it back too.
        let again = add(&c, &input("doggy bag", "")).unwrap();
        assert_eq!(again.status, RecipeAddStatus::Unexcluded);
        assert!(again.entry.excluded_at.is_none());

        exclude(&c, &[bag]).unwrap();
        assert_eq!(delete(&c, &[bag]).unwrap(), 1);
        let left = list(&c).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, hear);
        assert!(review(&mut c, bag, true, "choice", "excluded").is_err(), "a deleted word cannot be reviewed");
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
        let r = review(&mut c, ids[0], true, "choice", "all").unwrap();
        assert_eq!((r.points, r.kcal_earned, r.today_kcal, r.fraction_pending), (0.5, 0, 0, true));
        // A miss pays nothing and leaves the half waiting.
        let r = review(&mut c, ids[1], false, "choice", "all").unwrap();
        assert_eq!((r.points, r.kcal_earned, r.fraction_pending), (0.0, 0, true));
        // The second half makes a calorie.
        let r = review(&mut c, ids[2], true, "choice", "all").unwrap();
        assert_eq!((r.kcal_earned, r.today_kcal, r.fraction_pending), (1, 1, false));
        // A word typed is a calorie of its own; a pending half stays pending beside it.
        review(&mut c, ids[3], true, "choice", "all").unwrap();
        let r = review(&mut c, ids[4], true, "typing", "all").unwrap();
        assert_eq!((r.points, r.kcal_earned, r.today_kcal, r.fraction_pending), (1.0, 1, 2, true));
        assert_eq!(kcal(&c), 2, "1.5 + 1 = 2.5 kcal, of which the half is not paid");

        assert!(review(&mut c, ids[0], true, "speaking", "all").is_err());
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

        let first = review(&mut c, hear, true, "typing", "all").unwrap();
        assert!(!first.repeat);
        assert_eq!((first.points, first.kcal_earned), (1.0, 1));
        let learned_at = set_mastered(&c, hear, true).unwrap().mastered_at.expect("learned");

        // The same day, over the learned words again: still learned, still dated the first time,
        // and half a calorie for the same word typed again.
        let again = review(&mut c, hear, true, "typing", "all").unwrap();
        assert!(again.repeat);
        assert_eq!((again.points, again.kcal_earned, again.today_kcal), (0.5, 0, 1));
        assert_eq!(again.entry.mastered_at.as_deref(), Some(learned_at.as_str()));
        assert_eq!(again.entry.reviews, 2);
        // A third time is half too: 1 + 0.5 + 0.5 makes the second calorie.
        let third = review(&mut c, hear, true, "typing", "all").unwrap();
        assert_eq!((third.points, third.kcal_earned, third.today_kcal), (0.5, 1, 2));
        // Picked from four again that day: a quarter.
        let picked = review(&mut c, hear, true, "choice", "all").unwrap();
        assert_eq!((picked.points, picked.kcal_earned), (0.25, 0));

        // Forgotten: back into review, and a miss pays nothing.
        let forgot = review(&mut c, hear, false, "choice", "mastered").unwrap();
        assert!(forgot.entry.mastered_at.is_none());
        assert_eq!((forgot.points, forgot.kcal_earned), (0.0, 0));

        // Another word still pays in full today: 2.25 + 1 = 3.25 kcal, 3 of them paid.
        let other = review(&mut c, bag, true, "typing", "all").unwrap();
        assert!(!other.repeat);
        assert_eq!((other.points, other.today_kcal, other.fraction_pending), (1.0, 3, true));

        // The next day the word pays in full again.
        c.execute("UPDATE recipe_words SET paid_on = '2000-01-01' WHERE id = ?1", params![hear]).unwrap();
        assert_eq!(review(&mut c, hear, true, "typing", "all").unwrap().points, 1.0);
    }

    #[test]
    fn saving_a_learned_word_again_puts_it_back_into_review() {
        let c = db::init_in_memory().unwrap();
        let mut c = c;
        let hear = add(&c, &input("hear", "")).unwrap().entry;
        review(&mut c, hear.id, true, "choice", "all").unwrap();
        set_mastered(&c, hear.id, true).unwrap();
        let again = add(&c, &input("hear", "")).unwrap();
        assert_eq!(again.status, RecipeAddStatus::Restored);
        assert!(again.entry.mastered_at.is_none());
    }
}
