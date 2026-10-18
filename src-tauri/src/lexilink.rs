//! LexiLink: 英単語の神経衰弱. Twenty wrapped candies on the board, ten pairs: an English word and its
//! meaning (Word Match: a word question's English and the first, commonest sense of its Japanese),
//! or a word and its 対義語 (Opposites: antonyms.json), of one part of speech or of any. The board
//! never sets side by side what a player could not tell apart: two cards of the same English, two
//! meanings that read the same once their notes in （） are put aside (世話をする for look after and
//! take care of; （提案などを）断る and （はっきりと）断る are told apart by theirs), and in Opposites a word
//! whose opposite is a word of another pair. 「学習済みを優先」 takes the words the learner has met
//! first: answered in study, saved to the recipe, or the answer of an exam question asked; the rest
//! of the board is taken at random. ひとりで挑戦 pays 3 kcal a pair, −1 for each お手つき after the
//! third and 10 for clearing the board, without the play mode: a cleared game can come out below
//! zero, one left part-way pays what it is above zero. ふたりで対戦 pays 30 kcal for a game played to
//! the end. Either way the day counts as a day of study.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use rusqlite::{params, Connection};
use tauri::State;

use crate::commands::{credit_flat, err, load_daily, mark_studied, CmdResult, USER_ID};
use crate::db;
use crate::models::{LexiCard, LexiDeal, LexiFinish, LexiPair, LexiResult};
use crate::util::{now_ts, shuffle, today};
use crate::AppState;

pub const PAIRS: usize = 10;
pub const PAIR_KCAL: i64 = 3;
/// お手つき that cost nothing (ひとりで)
pub const FREE_MISSES: i64 = 3;
pub const MISS_KCAL: i64 = 1;
pub const CLEAR_KCAL: i64 = 10;
/// what a ふたりで対戦 played to the end pays
pub const VERSUS_KCAL: i64 = 30;
/// ふたりで対戦 against the computer, played to the end: lost or drawn
pub const COM_LOSE_KCAL: i64 = 10;

/// ふたりで対戦 against the computer, won: by the computer's level (None for no level).
pub fn com_win_kcal(level: &str) -> Option<i64> {
    match level {
        "easy" => Some(20),
        "normal" => Some(30),
        "hard" => Some(45),
        _ => None,
    }
}
pub const MODES: [&str; 2] = ["match", "opposites"];
pub const GENRES: [&str; 5] = ["random", "noun", "verb", "adjective", "adverb"];

/// A meaning as the board tells it apart: what it says once its notes in （） are put aside, and the
/// notes.
fn told_apart(meaning: &str) -> (String, String) {
    let (mut said, mut notes) = (String::new(), String::new());
    let mut depth = 0;
    for c in meaning.chars() {
        match c {
            '（' | '(' => {
                depth += 1;
                notes.push(c);
            }
            '）' | ')' => {
                depth -= 1;
                notes.push(c);
            }
            _ if depth > 0 => notes.push(c),
            _ => said.push(c),
        }
    }
    (said.trim().to_string(), notes)
}

/// Two meanings a player could not tell apart: the same once their notes are put aside, unless
/// both have notes and the notes differ.
fn alike(a: &str, b: &str) -> bool {
    let ((said_a, notes_a), (said_b, notes_b)) = (told_apart(a), told_apart(b));
    said_a == said_b && (notes_a.is_empty() || notes_b.is_empty() || notes_a == notes_b)
}

/// The commonest sense of a meaning: the first of its senses (a question writes the commonest first).
fn first_sense(ja: &str) -> String {
    db::gloss_senses(ja).into_iter().next().unwrap_or_else(|| ja.trim().to_string())
}

/// The words (lowercase) the learner has met: word questions answered in study, the recipe's words,
/// and the answers of the exam questions asked.
pub fn learned_words(conn: &Connection) -> rusqlite::Result<HashSet<String>> {
    let mut out = HashSet::new();
    let mut stmt = conn.prepare(
        "SELECT DISTINCT lower(q.en) FROM learning_history h JOIN questions q ON q.id = h.question_id
         WHERE h.user_id = ?1 AND q.kind = 'word'",
    )?;
    for w in stmt.query_map(params![USER_ID], |r| r.get::<_, String>(0))? {
        out.insert(w?);
    }
    let mut stmt = conn.prepare("SELECT lower(word) FROM recipe_words")?;
    for w in stmt.query_map([], |r| r.get::<_, String>(0))? {
        out.insert(w?.trim().to_string());
    }
    let mut stmt = conn.prepare("SELECT set_id FROM exam_seen WHERE user_id = ?1")?;
    let asked: HashSet<String> = stmt.query_map(params![USER_ID], |r| r.get(0))?.collect::<Result<_, _>>()?;
    for sets in crate::exam::sets().values() {
        for set in sets.iter().filter(|s| asked.contains(&s.id)) {
            out.extend(set.questions.iter().map(|q| q.answer.trim().to_lowercase()));
        }
    }
    Ok(out)
}

/// The candidates in the order the board takes them: shuffled, and the learned ones first when asked.
fn ordered<T>(mut items: Vec<T>, prefer: bool, learned: impl Fn(&T) -> bool) -> Vec<T> {
    shuffle(&mut items);
    if prefer {
        // A stable sort: each side stays shuffled.
        items.sort_by_key(|x| !learned(x));
    }
    items
}

fn word_match(conn: &Connection, genre: &str, prefer: bool, learned: &HashSet<String>) -> rusqlite::Result<Vec<LexiPair>> {
    let mut stmt = conn.prepare(
        "SELECT en, ja FROM questions WHERE kind = 'word' AND tier IN ('word', 'compound') AND (?1 = 'random' OR pos = ?1)",
    )?;
    let words: Vec<(String, String)> = stmt
        .query_map(params![genre], |r| Ok((r.get::<_, String>(0)?, first_sense(&r.get::<_, String>(1)?))))?
        .collect::<Result<_, _>>()?;
    let mut picked: Vec<(String, String)> = Vec::new();
    for (en, meaning) in ordered(words, prefer, |(en, _)| learned.contains(&en.to_lowercase())) {
        if picked.len() == PAIRS {
            break;
        }
        if meaning.is_empty() || picked.iter().any(|(e, m)| e.eq_ignore_ascii_case(&en) || alike(m, &meaning)) {
            continue;
        }
        picked.push((en, meaning));
    }
    Ok(picked
        .into_iter()
        .map(|(en, meaning)| LexiPair {
            a: LexiCard { text: en.clone(), english: true, word: en.clone(), meaning: meaning.clone() },
            b: LexiCard { text: meaning.clone(), english: false, word: en, meaning },
        })
        .collect())
}

/// A pair of 対義語 as the board shows it: each word with its meaning and the part of speech that
/// meaning is.
struct Opposite {
    word: String,
    meaning: String,
    pos: Option<String>,
    opposite: String,
    its_meaning: String,
    its_pos: Option<String>,
}

/// Every pair of 対義語 with a meaning for both words, and each word's opposites in any sense
/// (lowercase). Made once: it is read from the data alone (antonyms.json and the dictionary), and
/// the parts of speech take a while to find.
struct Opposites {
    pairs: Vec<Opposite>,
    opposite_of: HashMap<String, HashSet<String>>,
}

fn opposite_table() -> &'static Opposites {
    static TABLE: OnceLock<Opposites> = OnceLock::new();
    TABLE.get_or_init(|| {
        let all = db::antonym_pairs();
        let mut opposite_of: HashMap<String, HashSet<String>> = HashMap::new();
        for (w, _, o, _) in &all {
            let (w, o) = (w.to_lowercase(), o.to_lowercase());
            opposite_of.entry(w.clone()).or_default().insert(o.clone());
            opposite_of.entry(o).or_default().insert(w);
        }
        let shown = |word: &str| db::shown_meaning(word).map(|m| first_sense(&m));
        let part_of_speech = |word: &str, meaning: &str| db::recipe_poses(word, meaning).into_iter().next();
        let pairs = all
            .into_iter()
            .filter_map(|(word, w_sense, opposite, o_sense)| {
                let meaning = w_sense.or_else(|| shown(&word))?;
                let its_meaning = o_sense.or_else(|| shown(&opposite))?;
                let (pos, its_pos) = (part_of_speech(&word, &meaning), part_of_speech(&opposite, &its_meaning));
                Some(Opposite { word, meaning, pos, opposite, its_meaning, its_pos })
            })
            .collect();
        Opposites { pairs, opposite_of }
    })
}

/// Made ahead at start-up, so the first game of Opposites does not wait for it.
pub fn warm_up() {
    let _ = opposite_table();
}

fn opposites(genre: &str, prefer: bool, learned: &HashSet<String>) -> Vec<LexiPair> {
    let table = opposite_table();
    let of_genre = |pos: &Option<String>| genre == "random" || pos.as_deref() == Some(genre);
    let pairs: Vec<&Opposite> = table.pairs.iter().filter(|p| of_genre(&p.pos) && of_genre(&p.its_pos)).collect();
    let mut picked: Vec<&Opposite> = Vec::new();
    let mut used: HashSet<String> = HashSet::new();
    let met = |p: &&Opposite| learned.contains(&p.word.to_lowercase()) || learned.contains(&p.opposite.to_lowercase());
    for pair in ordered(pairs, prefer, met) {
        if picked.len() == PAIRS {
            break;
        }
        let (w, o) = (pair.word.to_lowercase(), pair.opposite.to_lowercase());
        // A pair whose word is the opposite of another pair's word (big–little beside large–small)
        // is not set on the same board.
        let crosses = |x: &String| table.opposite_of.get(x).is_some_and(|set| set.iter().any(|y| used.contains(y)));
        // A word meaning what a word of another pair means (stable and steady, 安定した) would pair
        // with that one's opposite too (stable–shaky beside shaky–steady).
        let same_sense = picked
            .iter()
            .any(|q| [&pair.meaning, &pair.its_meaning].iter().any(|m| alike(m, &q.meaning) || alike(m, &q.its_meaning)));
        if used.contains(&w) || used.contains(&o) || crosses(&w) || crosses(&o) || same_sense {
            continue;
        }
        used.insert(w);
        used.insert(o);
        picked.push(pair);
    }
    picked
        .into_iter()
        .map(|p| LexiPair {
            a: LexiCard { text: p.word.clone(), english: true, word: p.word.clone(), meaning: p.meaning.clone() },
            b: LexiCard { text: p.opposite.clone(), english: true, word: p.opposite.clone(), meaning: p.its_meaning.clone() },
        })
        .collect()
}

/// The ten pairs of a game of `mode` (match / opposites) and `genre` (random or a part of speech).
pub fn deal(conn: &Connection, mode: &str, genre: &str, prefer_learned: bool) -> CmdResult<LexiDeal> {
    if !MODES.contains(&mode) {
        return Err(format!("unknown LexiLink mode {mode}"));
    }
    if !GENRES.contains(&genre) {
        return Err(format!("unknown LexiLink genre {genre}"));
    }
    let learned = if prefer_learned { learned_words(conn).map_err(err)? } else { HashSet::new() };
    let pairs = if mode == "match" { word_match(conn, genre, prefer_learned, &learned).map_err(err)? } else { opposites(genre, prefer_learned, &learned) };
    if pairs.len() < PAIRS {
        return Err("このジャンルでは10ペアそろいません".into());
    }
    Ok(LexiDeal { mode: mode.to_string(), genre: genre.to_string(), pairs })
}

/// What a ひとりで挑戦 adds: 3 kcal a pair, −1 for each お手つき after the third, 10 for clearing the
/// board. A cleared game can come out below zero; one left part-way adds what it is above zero.
pub fn solo_kcal(pairs: i64, misses: i64, cleared: bool) -> i64 {
    let total = pairs * PAIR_KCAL - (misses - FREE_MISSES).max(0) * MISS_KCAL + if cleared { CLEAR_KCAL } else { 0 };
    if cleared {
        total
    } else {
        total.max(0)
    }
}

/// A game ended (finished, or left part-way): its kcal go into today as they are (no play mode), and
/// the day counts as a day of study.
pub fn finish(conn: &mut Connection, game: &LexiFinish) -> CmdResult<LexiResult> {
    if !(1..=2).contains(&game.players) || !(0..=PAIRS as i64).contains(&game.pairs) || game.misses < 0 {
        return Err("LexiLink の結果が正しくありません".into());
    }
    if game.cleared && game.pairs != PAIRS as i64 {
        return Err("LexiLink の結果が正しくありません（ペアがそろっていません）".into());
    }
    let kcal = if game.players == 1 {
        solo_kcal(game.pairs, game.misses, game.cleared)
    } else if let Some(level) = game.com.as_deref() {
        // Against the computer: won, by its level; lost or drawn, a little; left part-way, nothing.
        let win = com_win_kcal(level).ok_or_else(|| format!("unknown LexiLink COM level {level}"))?;
        let mine = game.player_pairs.filter(|p| (0..=game.pairs).contains(p)).ok_or("LexiLink の結果が正しくありません（取ったペア）")?;
        if !game.cleared {
            0
        } else if mine > PAIRS as i64 - mine {
            win
        } else {
            COM_LOSE_KCAL
        }
    } else if game.cleared {
        VERSUS_KCAL
    } else {
        0
    };
    let (day, now) = (today(), now_ts());
    let tx = conn.transaction().map_err(err)?;
    let added = credit_flat(&tx, &day, kcal, "lexilink").map_err(err)?;
    let studied = mark_studied(&tx, &day, &now).map_err(err)?;
    let today_kcal = load_daily(&tx, &day).map_err(err)?.kcal_earned;
    tx.commit().map_err(err)?;
    Ok(LexiResult { kcal_earned: added, today_kcal, streak: studied.streak, new_ticket: studied.new_ticket })
}

/* ---------- Tauri commands ---------- */

// Off the main thread (`async`): a command on it holds up the window (the candies' animation, the
// sounds' timers) for as long as it takes.

#[tauri::command(async)]
pub fn deal_lexilink(state: State<'_, AppState>, mode: String, genre: String, prefer_learned: bool) -> CmdResult<LexiDeal> {
    let conn = state.db.lock().map_err(err)?;
    deal(&conn, &mode, &genre, prefer_learned)
}

#[tauri::command(async)]
pub fn finish_lexilink(state: State<'_, AppState>, game: LexiFinish) -> CmdResult<LexiResult> {
    let mut conn = state.db.lock().map_err(err)?;
    finish(&mut conn, &game)
}

/* ---------- tests ---------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        db::init_in_memory().expect("in-memory db")
    }

    #[test]
    fn meanings_a_player_cannot_tell_apart_are_alike() {
        assert!(alike("世話をする", "世話をする"), "look after / take care of");
        assert!(!alike("（提案などを）断る", "（はっきりと）断る"), "reject / refuse: told apart by their notes");
        assert!(alike("断る", "（丁重に）断る"), "one without notes could be either");
        assert!(!alike("断る", "受け入れる"));
    }

    /// Word Match: ten pairs of the part of speech asked, no English twice, no two meanings alike.
    #[test]
    fn a_word_match_board_has_ten_pairs_told_apart() {
        let c = conn();
        for genre in GENRES {
            for _ in 0..5 {
                let d = deal(&c, "match", genre, false).unwrap();
                assert_eq!(d.pairs.len(), PAIRS, "{genre}");
                let mut english = HashSet::new();
                for p in &d.pairs {
                    assert!(p.a.english && !p.b.english);
                    assert!(english.insert(p.a.text.to_lowercase()), "{genre}: {} twice", p.a.text);
                    if genre != "random" {
                        // ski is a noun and a verb, each a question of its own
                        let of_genre: i64 = c
                            .query_row("SELECT COUNT(*) FROM questions WHERE kind = 'word' AND en = ?1 AND pos = ?2", params![p.a.text, genre], |r| r.get(0))
                            .unwrap();
                        assert!(of_genre > 0, "{genre}: {}", p.a.text);
                    }
                }
                for (i, p) in d.pairs.iter().enumerate() {
                    for q in &d.pairs[i + 1..] {
                        assert!(!alike(&p.b.text, &q.b.text), "{genre}: {} / {}", p.b.text, q.b.text);
                    }
                }
            }
        }
    }

    /// Opposites: ten pairs of the part of speech asked, no word twice, and no word the opposite of a
    /// word of another pair, or meaning the same as one (stable and steady).
    #[test]
    fn an_opposites_board_has_ten_pairs_that_cross_nowhere() {
        let c = conn();
        let mut opposite: HashSet<(String, String)> = HashSet::new();
        for (w, _, o, _) in db::antonym_pairs() {
            opposite.insert((w.to_lowercase(), o.to_lowercase()));
            opposite.insert((o.to_lowercase(), w.to_lowercase()));
        }
        for genre in GENRES {
            for _ in 0..5 {
                let d = deal(&c, "opposites", genre, false).unwrap();
                assert_eq!(d.pairs.len(), PAIRS, "{genre}");
                let words: Vec<String> = d.pairs.iter().flat_map(|p| [p.a.word.to_lowercase(), p.b.word.to_lowercase()]).collect();
                assert_eq!(words.iter().collect::<HashSet<_>>().len(), words.len(), "{genre}: a word twice");
                for (i, p) in d.pairs.iter().enumerate() {
                    assert!(p.a.english && p.b.english && !p.a.meaning.is_empty() && !p.b.meaning.is_empty());
                    for q in d.pairs.iter().skip(i + 1) {
                        for x in [&p.a, &p.b] {
                            for y in [&q.a, &q.b] {
                                assert!(!opposite.contains(&(x.word.to_lowercase(), y.word.to_lowercase())), "{genre}: {} / {}", x.word, y.word);
                                assert!(!alike(&x.meaning, &y.meaning), "{genre}: {} and {} mean the same", x.word, y.word);
                            }
                        }
                    }
                    if genre != "random" {
                        for card in [&p.a, &p.b] {
                            assert_eq!(db::recipe_poses(&card.word, &card.meaning).first().map(String::as_str), Some(genre), "{}", card.word);
                        }
                    }
                }
            }
        }
    }

    /// 学習済みを優先: the words met in study come first.
    #[test]
    fn learned_words_come_first() {
        let c = conn();
        let ids: Vec<(i64, String)> = c
            .prepare("SELECT id, en FROM questions WHERE kind = 'word' AND tier = 'word' AND pos = 'noun' ORDER BY id LIMIT 40")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for (id, _) in &ids {
            c.execute(
                "INSERT INTO learning_history (user_id, question_id, last_studied_at) VALUES (1, ?1, '2026-10-01T00:00:00')",
                params![id],
            )
            .unwrap();
        }
        let met: HashSet<String> = ids.iter().map(|(_, en)| en.to_lowercase()).collect();
        let d = deal(&c, "match", "noun", true).unwrap();
        assert!(d.pairs.iter().all(|p| met.contains(&p.a.word.to_lowercase())), "only learned words while there are enough");
        assert!(learned_words(&c).unwrap().is_superset(&met));
    }

    /// ひとりで: 3 a pair, −1 for each お手つき after the third, +10 for clearing; a game left part-way
    /// adds nothing below zero, a cleared one can take some away. The play mode does not touch it.
    #[test]
    fn a_game_pays_by_its_pairs_and_misses_without_the_play_mode() {
        assert_eq!(solo_kcal(10, 3, true), 40);
        assert_eq!(solo_kcal(10, 6, true), 37);
        assert_eq!(solo_kcal(10, 50, true), -7);
        assert_eq!(solo_kcal(2, 3, false), 6);
        assert_eq!(solo_kcal(1, 10, false), 0);

        let mut c = conn();
        crate::commands::set_play_mode_in(&c, "hard").unwrap();
        let solo = |pairs, misses, cleared| LexiFinish { players: 1, pairs, misses, cleared, ..Default::default() };
        let r = finish(&mut c, &solo(10, 6, true)).unwrap();
        assert_eq!((r.kcal_earned, r.today_kcal, r.streak), (37, 37, 1), "the day counts as a day of study");
        let r = finish(&mut c, &solo(10, 50, true)).unwrap();
        assert_eq!((r.kcal_earned, r.today_kcal), (-7, 30));
        let r = finish(&mut c, &solo(3, 20, false)).unwrap();
        assert_eq!(r.kcal_earned, 0);
        let versus = |cleared| LexiFinish { players: 2, pairs: if cleared { 10 } else { 4 }, misses: 0, cleared, ..Default::default() };
        assert_eq!(finish(&mut c, &versus(true)).unwrap().kcal_earned, VERSUS_KCAL);
        assert_eq!(finish(&mut c, &versus(false)).unwrap().kcal_earned, 0);
        assert!(finish(&mut c, &LexiFinish { players: 1, pairs: 4, misses: 0, cleared: true, ..Default::default() }).is_err());

        let s = crate::commands::load_stats(&c).unwrap();
        assert_eq!((s.breakdown.lexilink.times, s.breakdown.lexilink.kcal), (5, 60), "the games that paid nothing are games too");
        assert_eq!(s.total_kcal, 60, "the table and the total agree");
        // A cleared game's minus never takes the day below zero.
        let mut fresh = conn();
        assert_eq!(finish(&mut fresh, &solo(10, 50, true)).unwrap().kcal_earned, 0);
    }

    /// ふたりで対戦 against the computer: won, 20 / 30 / 45 by its level; lost or drawn, 10; left
    /// part-way, nothing. Against a person it stays 30.
    #[test]
    fn a_game_against_the_computer_pays_by_its_level_and_the_outcome() {
        let mut c = conn();
        let com = |level: &str, mine: i64, cleared: bool| LexiFinish {
            players: 2,
            pairs: if cleared { 10 } else { 4 },
            misses: 0,
            cleared,
            com: Some(level.to_string()),
            player_pairs: Some(mine),
        };
        let paid = |c: &mut Connection, game: LexiFinish| finish(c, &game).unwrap().kcal_earned;
        assert_eq!(paid(&mut c, com("easy", 6, true)), 20);
        assert_eq!(paid(&mut c, com("normal", 7, true)), 30);
        assert_eq!(paid(&mut c, com("hard", 10, true)), 45);
        assert_eq!(paid(&mut c, com("hard", 3, true)), COM_LOSE_KCAL, "lost");
        assert_eq!(paid(&mut c, com("normal", 5, true)), COM_LOSE_KCAL, "drawn");
        assert_eq!(paid(&mut c, com("hard", 3, false)), 0, "left part-way");
        assert!(finish(&mut c, &com("expert", 6, true)).is_err(), "no such level");
        assert!(finish(&mut c, &LexiFinish { player_pairs: None, ..com("easy", 6, true) }).is_err(), "whose pairs");
        assert!(finish(&mut c, &com("easy", 11, true)).is_err(), "more pairs than taken");
    }
}
