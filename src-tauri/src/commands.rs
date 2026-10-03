use crate::db::{self, Q_COLS};
use crate::models::*;
use crate::srs;
use crate::util::{self, date_plus, now_ts, shuffle, today};
use crate::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use tauri::State;

pub(crate) type CmdResult<T> = Result<T, String>;
pub(crate) const USER_ID: i64 = 1;
/// Study modes the frontend may ask for; anything else is rejected before it reaches SQL.
pub const MODES: [&str; 4] = ["choice", "typing", "speaking", "listening"];
/// ホームの「復習をはじめる」。期限の来た復習だけを、それぞれ間違えた形式で出す。
pub const REVIEW_SESSION: &str = "review";

pub(crate) fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/* ---------- shared queries ---------- */

fn load_user(conn: &Connection) -> rusqlite::Result<UserInfo> {
    conn.query_row(
        "SELECT id, name, total_study_days, current_streak, longest_streak, last_study_date, play_mode
         FROM users WHERE id = ?1",
        params![USER_ID],
        |r| {
            Ok(UserInfo {
                id: r.get(0)?,
                name: r.get(1)?,
                total_study_days: r.get(2)?,
                current_streak: r.get(3)?,
                longest_streak: r.get(4)?,
                last_study_date: r.get(5)?,
                play_mode: r.get(6)?,
            })
        },
    )
}

/// The play mode the learner picked (`users.play_mode`): hard / normal / easy.
pub(crate) fn play_mode(conn: &Connection) -> rusqlite::Result<String> {
    conn.query_row("SELECT play_mode FROM users WHERE id = ?1", params![USER_ID], |r| r.get(0))
}

/// What a reward did to the day.
pub(crate) struct Credit {
    /// the reward after the play mode, in eighths of a kcal (shown as 0.5 / 1.5 kcal …)
    pub eighths: i64,
    /// whole kcal added to the day's earnings now
    pub whole: i64,
    /// a fraction of a calorie waits for the next reward today
    pub pending: bool,
}

impl Credit {
    /// The reward in kcal, as shown to the learner.
    pub fn points(&self) -> f64 {
        self.eighths as f64 / srs::EIGHTHS as f64
    }
}

/// Pays a reward of `eighths` (1/8 kcal, before the play mode) into `day`: scaled by the play mode
/// (がんばり ×0.5、通常 ×1、お気軽 ×1.5), whole kcal go to the day's earnings and a fraction waits in
/// `daily_stats.kcal_eighths` for the next reward that day (dropped when the day ends). Every kcal
/// earned goes through here: answers, recipe reviews, exams and the cheat-day bonus.
pub(crate) fn credit(conn: &Connection, day: &str, eighths: i64) -> rusqlite::Result<Credit> {
    conn.execute("INSERT OR IGNORE INTO daily_stats (user_id, date) VALUES (?1, ?2)", params![USER_ID, day])?;
    let pending: i64 = conn.query_row(
        "SELECT kcal_eighths FROM daily_stats WHERE user_id = ?1 AND date = ?2",
        params![USER_ID, day],
        |r| r.get(0),
    )?;
    let scaled = srs::apply_play_mode(eighths, &play_mode(conn)?);
    let (whole, rest) = srs::split_kcal(pending, scaled);
    conn.execute(
        "UPDATE daily_stats SET kcal_earned = kcal_earned + ?3, kcal_eighths = ?4 WHERE user_id = ?1 AND date = ?2",
        params![USER_ID, day, whole, rest],
    )?;
    Ok(Credit { eighths: scaled, whole, pending: rest > 0 })
}

/// Switches the play mode; what is earned from then on is scaled by it.
pub fn set_play_mode_in(conn: &Connection, mode: &str) -> Result<String, String> {
    if !srs::PLAY_MODES.contains(&mode) {
        return Err(format!("unknown play mode {mode}"));
    }
    conn.execute("UPDATE users SET play_mode = ?1 WHERE id = ?2", params![mode, USER_ID]).map_err(err)?;
    Ok(mode.to_string())
}

pub(crate) fn load_daily(conn: &Connection, date: &str) -> rusqlite::Result<DailyStats> {
    let found = conn
        .query_row(
            "SELECT kcal_earned, kcal_consumed, answered, correct FROM daily_stats WHERE user_id = ?1 AND date = ?2",
            params![USER_ID, date],
            |r| {
                Ok(DailyStats {
                    date: date.to_string(),
                    kcal_earned: r.get(0)?,
                    kcal_consumed: r.get(1)?,
                    answered: r.get(2)?,
                    correct: r.get(3)?,
                })
            },
        )
        .optional()?;
    Ok(found.unwrap_or(DailyStats { date: date.to_string(), ..Default::default() }))
}

/// The columns `db::row_to_snack` reads, from `snacks s`, with how often each has been eaten.
const SNACK_COLS: &str = "s.id, s.name, s.calories, s.icon, s.is_builtin,
    (SELECT COUNT(*) FROM consumption_log c WHERE c.snack_id = s.id)";

fn load_snack(conn: &Connection, id: i64) -> rusqlite::Result<Option<Snack>> {
    conn.query_row(
        &format!("SELECT {SNACK_COLS} FROM snacks s WHERE s.id = ?1"),
        params![id],
        db::row_to_snack,
    )
    .optional()
}

fn list_snacks_inner(conn: &Connection) -> rusqlite::Result<Vec<Snack>> {
    let mut stmt = conn.prepare(&format!("SELECT {SNACK_COLS} FROM snacks s ORDER BY s.calories ASC, s.id ASC"))?;
    let rows = stmt.query_map([], db::row_to_snack)?;
    rows.collect()
}

/// The snacks set as goals, cheapest first: the next one within reach leads the list.
pub fn goal_snacks_inner(conn: &Connection) -> rusqlite::Result<Vec<Snack>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SNACK_COLS} FROM goal_snacks g JOIN snacks s ON s.id = g.snack_id
         ORDER BY s.calories ASC, g.added_at ASC, s.id ASC"
    ))?;
    let rows = stmt.query_map([], db::row_to_snack)?;
    rows.collect()
}

/// Snacks eaten today, whether paid in kcal or with a ticket.
fn eaten_today(conn: &Connection) -> rusqlite::Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT snack_id FROM consumption_log WHERE user_id = ?1 AND date = ?2 AND snack_id IS NOT NULL ORDER BY snack_id",
    )?;
    let rows = stmt.query_map(params![USER_ID, today()], |r| r.get(0))?;
    rows.collect()
}

pub fn set_goal(conn: &Connection, snack_id: i64, goal: bool) -> CmdResult<Vec<Snack>> {
    if goal {
        load_snack(conn, snack_id).map_err(err)?.ok_or_else(|| "snack not found".to_string())?;
        conn.execute(
            "INSERT OR IGNORE INTO goal_snacks (snack_id, added_at) VALUES (?1, ?2)",
            params![snack_id, now_ts()],
        )
        .map_err(err)?;
    } else {
        conn.execute("DELETE FROM goal_snacks WHERE snack_id = ?1", params![snack_id]).map_err(err)?;
    }
    goal_snacks_inner(conn).map_err(err)
}

fn due_review_count(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM learning_history WHERE user_id = ?1 AND needs_review = 1 AND next_due_at IS NOT NULL AND next_due_at <= ?2",
        params![USER_ID, today()],
        |r| r.get(0),
    )
}

fn tickets_available(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM cheat_tickets WHERE user_id = ?1 AND used_at IS NULL",
        params![USER_ID],
        |r| r.get(0),
    )
}

/* ---------- savings: yesterday's leftover kcal, and the snack tickets it becomes ---------- */

/// Moves the leftover of every finished day into savings, once per day, and turns each full
/// 2,000 kcal into an お菓子引換券. Runs lazily whenever the dashboard is loaded, so a day the
/// app was not opened is still counted the next time it is. Returns (kcal saved, tickets issued)
/// by this call; both are 0 once the past is settled.
pub fn settle_savings(conn: &Connection) -> rusqlite::Result<(i64, i64)> {
    let tx = conn.unchecked_transaction()?;
    let days: Vec<(String, i64, i64)> = {
        let mut stmt = tx.prepare(
            "SELECT date, kcal_earned, kcal_consumed FROM daily_stats
             WHERE user_id = ?1 AND date < ?2 AND saved_kcal IS NULL ORDER BY date",
        )?;
        let rows = stmt.query_map(params![USER_ID, today()], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    if days.is_empty() {
        return Ok((0, 0));
    }
    let mut saved = 0;
    for (date, earned, consumed) in &days {
        let leftover = srs::leftover_kcal(*earned, *consumed);
        tx.execute(
            "UPDATE daily_stats SET saved_kcal = ?1 WHERE user_id = ?2 AND date = ?3",
            params![leftover, USER_ID, date],
        )?;
        saved += leftover;
    }
    let balance: i64 =
        tx.query_row("SELECT savings_kcal FROM users WHERE id = ?1", params![USER_ID], |r| r.get(0))?;
    let (balance, issued) = srs::add_to_savings(balance, saved);
    tx.execute("UPDATE users SET savings_kcal = ?1 WHERE id = ?2", params![balance, USER_ID])?;
    let now = now_ts();
    for _ in 0..issued {
        tx.execute("INSERT INTO snack_tickets (user_id, issued_at) VALUES (?1, ?2)", params![USER_ID, now])?;
    }
    tx.commit()?;
    Ok((saved, issued))
}

fn snack_tickets_available(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM snack_tickets WHERE user_id = ?1 AND used_at IS NULL",
        params![USER_ID],
        |r| r.get(0),
    )
}

fn savings_info(conn: &Connection, just_saved: i64, just_issued: i64) -> rusqlite::Result<SavingsInfo> {
    Ok(SavingsInfo {
        balance: conn.query_row("SELECT savings_kcal FROM users WHERE id = ?1", params![USER_ID], |r| r.get(0))?,
        per_ticket: srs::SAVINGS_PER_TICKET,
        snack_tickets: snack_tickets_available(conn)?,
        just_saved,
        just_issued,
    })
}

/// Eats a snack with an お菓子引換券: it goes in today's log, but costs none of today's kcal.
pub fn eat_with_ticket_inner(conn: &Connection, snack_id: i64) -> CmdResult<DailyStats> {
    let snack = load_snack(conn, snack_id)
        .map_err(err)?
        .ok_or_else(|| "snack not found".to_string())?;
    let tx = conn.unchecked_transaction().map_err(err)?;
    let ticket: i64 = tx
        .query_row(
            "SELECT id FROM snack_tickets WHERE user_id = ?1 AND used_at IS NULL ORDER BY issued_at ASC, id ASC LIMIT 1",
            params![USER_ID],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?
        .ok_or_else(|| "使えるお菓子引換券がありません".to_string())?;
    let today = today();
    let now = now_ts();
    tx.execute(
        "INSERT INTO consumption_log (user_id, snack_id, snack_name, snack_icon, calories, date, eaten_at, ticket_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![USER_ID, snack.id, snack.name, snack.icon, snack.calories, today, now, ticket],
    )
    .map_err(err)?;
    let entry = tx.last_insert_rowid();
    tx.execute(
        "UPDATE snack_tickets SET used_at = ?1, consumption_id = ?2 WHERE id = ?3",
        params![now, entry, ticket],
    )
    .map_err(err)?;
    tx.commit().map_err(err)?;
    load_daily(conn, &today).map_err(err)
}

/// Takes an entry out of the log. A snack eaten with a ticket gives the ticket back; one paid in
/// kcal gives the kcal back to its day.
pub fn delete_consumption_inner(conn: &Connection, id: i64) -> CmdResult<DailyStats> {
    let entry: Option<(i64, String, Option<i64>)> = conn
        .query_row(
            "SELECT calories, date, ticket_id FROM consumption_log WHERE id = ?1 AND user_id = ?2",
            params![id, USER_ID],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(err)?;
    if let Some((calories, date, ticket)) = entry {
        conn.execute("DELETE FROM consumption_log WHERE id = ?1", params![id]).map_err(err)?;
        match ticket {
            Some(ticket) => {
                conn.execute(
                    "UPDATE snack_tickets SET used_at = NULL, consumption_id = NULL WHERE id = ?1",
                    params![ticket],
                )
                .map_err(err)?;
            }
            None => {
                conn.execute(
                    "UPDATE daily_stats SET kcal_consumed = MAX(0, kcal_consumed - ?1) WHERE user_id = ?2 AND date = ?3",
                    params![calories, USER_ID, date],
                )
                .map_err(err)?;
            }
        }
    }
    load_daily(conn, &today()).map_err(err)
}

/// Question counts per genre, in the order genres first appear in the seed data.
fn category_infos(conn: &Connection) -> rusqlite::Result<Vec<CategoryInfo>> {
    let mut stmt = conn.prepare(
        "SELECT category, tier, COUNT(*), MIN(id) FROM questions WHERE category != '' GROUP BY category, tier",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))
    })?;
    let mut out: Vec<(i64, CategoryInfo)> = Vec::new();
    for row in rows {
        let (name, tier, n, min_id) = row?;
        let idx = match out.iter().position(|(_, c)| c.name == name) {
            Some(i) => i,
            None => {
                out.push((
                    min_id,
                    CategoryInfo { name, total: 0, word: 0, compound: 0, grammar: 0, idiom: 0, phrase: 0, example: 0 },
                ));
                out.len() - 1
            }
        };
        let entry = &mut out[idx];
        entry.0 = entry.0.min(min_id);
        entry.1.total += n;
        match tier.as_str() {
            "word" => entry.1.word += n,
            "compound" => entry.1.compound += n,
            "grammar" => entry.1.grammar += n,
            "idiom" => entry.1.idiom += n,
            "phrase" => entry.1.phrase += n,
            "example" => entry.1.example += n,
            _ => {}
        }
    }
    out.sort_by_key(|(first_id, _)| *first_id);
    Ok(out.into_iter().map(|(_, c)| c).collect())
}

/// How many words of the 英単語 tab each part of speech has, in the order of the chips.
fn parts_of_speech(conn: &Connection) -> rusqlite::Result<Vec<PartOfSpeechInfo>> {
    db::PARTS_OF_SPEECH
        .iter()
        .map(|pos| {
            let total = conn.query_row(
                "SELECT COUNT(*) FROM questions WHERE tier = 'word' AND pos = ?1",
                params![pos],
                |r| r.get(0),
            )?;
            Ok(PartOfSpeechInfo { pos: pos.to_string(), total })
        })
        .collect()
}

fn kcal_rates() -> KcalRates {
    KcalRates {
        word_choice: srs::KCAL_WORD_CHOICE,
        choice: srs::KCAL_CHOICE,
        review_multiplier: srs::REVIEW_MULTIPLIER,
        cheat_day_bonus: srs::CHEAT_DAY_BONUS,
    }
}

/* ---------- core logic (testable without Tauri) ---------- */

/// The senses of a gloss, so 聞く and 聞く、聞こえる share one: split at 、 and the like, notes in
/// parentheses dropped ("(肉に)汁をかける" is 汁をかける).
fn senses(ja: &str) -> Vec<String> {
    ja.split(['、', '，', ',', ';', '；', '/', '／'])
        .map(|s| {
            let mut plain = String::new();
            let mut depth = 0;
            for c in s.chars() {
                match c {
                    '（' | '(' => depth += 1,
                    '）' | ')' => depth -= 1,
                    _ if depth == 0 => plain.push(c),
                    _ => {}
                }
            }
            plain.trim().to_string()
        })
        .filter(|s| !s.is_empty())
        .collect()
}

fn share_a_sense(a: &str, b: &str) -> bool {
    let sb = senses(b);
    senses(a).iter().any(|s| sb.contains(s))
}

/// Whether two glosses may mean nearly the same: a sense in common, a kanji in common (始める /
/// 開始する, 大きい / 巨大な) or kana senses that begin alike (ぶつかる / ぶつける). Wrong options are
/// kept away from the answer's meaning this way, so that none is a second right answer or one
/// only near, like 激怒した for angry (怒った). Suffix-like kanji (～的な, ～性, ～化) do not count.
fn meanings_close(a: &str, b: &str) -> bool {
    let kanji = |s: &str| -> std::collections::HashSet<char> {
        s.chars()
            .filter(|c| ('\u{4E00}'..='\u{9FFF}').contains(c) && !['的', '性', '化'].contains(c))
            .collect()
    };
    if !kanji(a).is_disjoint(&kanji(b)) {
        return true;
    }
    let is_kana = |c: char| ('\u{3041}'..='\u{30FF}').contains(&c);
    let sb = senses(b);
    senses(a).iter().any(|x| {
        sb.iter().any(|y| {
            x == y || {
                let common = x.chars().zip(y.chars()).take_while(|(p, q)| p == q).count();
                common >= 2 && x.chars().next().is_some_and(is_kana)
            }
        })
    })
}

fn levenshtein(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut prev = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cur = row[j + 1];
            row[j + 1] = if ca == *cb { prev } else { 1 + prev.min(row[j]).min(row[j + 1]) };
            prev = cur;
        }
    }
    row[b.len()]
}

/// Words a learner may take for one another by their spelling: house / horse, desert / dessert,
/// adapt / adopt. One letter apart (two for long words), single words of four letters or more.
fn spelled_alike(a: &str, b: &str) -> bool {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    if a == b || a.contains([' ', '-']) || b.contains([' ', '-']) {
        return false;
    }
    let (la, lb) = (a.chars().count(), b.chars().count());
    if la.min(lb) < 4 || la.abs_diff(lb) > 2 {
        return false;
    }
    let d = levenshtein(&a, &b);
    d == 1 || (d == 2 && la.min(lb) >= 7)
}

/// A word question's wrong meanings, all of its part of speech: 勝つ (win) against 野球 and
/// ハイキング is no question, the nouns rule themselves out. Words it is a near synonym of (its
/// 類似表現 groups) are left out. Up to two come from the words it is
/// confused with (its set in word-confusables.json, then words spelt alike: 負ける for win, 馬 for
/// house), the rest from its own group, then its genre, then any word of the part of speech, single
/// words before compounds when it is one. None when the question has no part of speech.
fn word_distractors(conn: &Connection, q: &Question) -> rusqlite::Result<Option<Vec<Distractor>>> {
    struct Candidate {
        en: String,
        ja: String,
        group: String,
        category: String,
        tier: String,
    }
    let pos: Option<String> =
        conn.query_row("SELECT pos FROM questions WHERE id = ?1", params![q.id], |r| r.get(0))?;
    let Some(pos) = pos else {
        return Ok(None);
    };
    let mut stmt = conn.prepare_cached(
        "SELECT en, ja, word_group, category, tier FROM questions \
         WHERE kind = 'word' AND pos = ?1 AND id != ?2 AND ja != ?3",
    )?;
    let mut candidates: Vec<Candidate> = stmt
        .query_map(params![pos, q.id, q.ja], |r| {
            Ok(Candidate { en: r.get(0)?, ja: r.get(1)?, group: r.get(2)?, category: r.get(3)?, tier: r.get(4)? })
        })?
        .collect::<Result<_, _>>()?;
    shuffle(&mut candidates);

    let confused: Vec<String> = db::confusables().get(&q.en.to_lowercase()).cloned().unwrap_or_default();
    // Words of its 類似表現 groups are near in meaning (学ぶ is no wrong answer for study), unless
    // the pair is one of the confusable ones set side by side on purpose (lend / borrow).
    let near: Vec<String> = db::related_words(&q.en.to_lowercase())
        .into_iter()
        .filter(|w| !confused.contains(w))
        .collect();
    // The word's other senses count as right answers too: 閉まった is no wrong answer for close
    // (近い) when close is also 閉める.
    let other_senses: Vec<String> = conn
        .prepare_cached("SELECT ja FROM questions WHERE kind = 'word' AND lower(en) = lower(?1) AND id != ?2")?
        .query_map(params![q.en, q.id], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let mut picked: Vec<Distractor> = Vec::new();
    // One sense per English word: change is not asked against both of charge's (請求する, 充電する).
    let mut picked_en: Vec<String> = Vec::new();
    // `checked`: the pair was set side by side by hand (a confusable set: 上がる / 上げる for rise and
    // raise), so only a shared sense rules it out. Anything else must keep clear of the meaning,
    // even in the word's own group: 激怒した is no wrong answer for angry (怒った).
    let mut take = |fits: &dyn Fn(&Candidate) -> bool, checked: bool, up_to: usize| {
        for c in &candidates {
            if picked.len() >= up_to {
                break;
            }
            // The same English in another sense (pass: 通り過ぎる / 合格する) is no wrong answer.
            if !fits(c)
                || c.en.eq_ignore_ascii_case(&q.en)
                || near.contains(&c.en.to_lowercase())
                || picked_en.contains(&c.en.to_lowercase())
                || share_a_sense(&c.ja, &q.ja)
                || picked.iter().any(|(p, _)| share_a_sense(p, &c.ja))
                || (!checked && meanings_close(&c.ja, &q.ja))
                || other_senses.iter().any(|o| meanings_close(&c.ja, o))
            {
                continue;
            }
            picked.push((c.ja.clone(), c.en.clone()));
            picked_en.push(c.en.to_lowercase());
        }
    };
    take(&|c| confused.contains(&c.en.to_lowercase()), true, 2);
    take(&|c| spelled_alike(&c.en, &q.en), false, 2);
    take(&|c| c.group == q.group, false, 3);
    take(&|c| c.category == q.category, false, 3);
    take(&|c| c.tier == q.tier, false, 3);
    take(&|_| true, false, 3);
    // A part of speech too small to keep clear of the meaning: a shared sense is still out.
    take(&|_| true, true, 3);
    Ok(Some(picked))
}

/// Three plausible wrong translations, taken from the tightest semantic circle that has enough
/// members: same fine-grained group → same genre → same kind → anything. Picking from the same
/// group is what makes the quiz worth doing: for "salt" the alternatives are other seasonings,
/// not a random animal. Word questions keep to their part of speech (`word_distractors`).
fn japanese_distractors(conn: &Connection, q: &Question) -> rusqlite::Result<Vec<Distractor>> {
    if q.kind == "word" {
        if let Some(opts) = word_distractors(conn, q)? {
            if opts.len() >= 3 {
                return Ok(opts);
            }
        }
    }
    let mut opts: Vec<Distractor> = Vec::new();

    let mut fill = |sql: &str, field: &str| -> rusqlite::Result<()> {
        if opts.len() >= 3 {
            return Ok(());
        }
        let mut stmt = conn.prepare(sql)?;
        let found: Vec<Distractor> = stmt
            .query_map(params![q.id, q.kind, field, q.ja], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        extend_unique_meanings(&mut opts, found, &q.ja);
        Ok(())
    };

    fill(
        "SELECT ja, en FROM questions WHERE id != ?1 AND kind = ?2 AND word_group = ?3 AND ja != ?4 ORDER BY RANDOM() LIMIT 8",
        &q.group,
    )?;
    fill(
        "SELECT ja, en FROM questions WHERE id != ?1 AND kind = ?2 AND category = ?3 AND ja != ?4 ORDER BY RANDOM() LIMIT 8",
        &q.category,
    )?;
    fill(
        "SELECT ja, en FROM questions WHERE id != ?1 AND kind = ?2 AND ?3 IS NOT NULL AND ja != ?4 ORDER BY RANDOM() LIMIT 8",
        &q.category,
    )?;

    if opts.len() < 3 {
        let mut stmt =
            conn.prepare("SELECT ja, en FROM questions WHERE id != ?1 AND ja != ?2 ORDER BY RANDOM() LIMIT 8")?;
        let any: Vec<Distractor> = stmt
            .query_map(params![q.id, q.ja], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<Result<_, _>>()?;
        extend_unique_meanings(&mut opts, any, &q.ja);
    }
    Ok(opts)
}

/// A wrong option in Japanese with the English it translates (野球, baseball). The English is
/// shown in the option once the question is answered, so a wrong choice teaches a word too.
type Distractor = (String, String);

/// `extend_unique` for Japanese options, which are told apart by their meaning.
fn extend_unique_meanings(opts: &mut Vec<Distractor>, more: Vec<Distractor>, answer: &str) {
    for (ja, en) in more {
        if opts.len() >= 3 {
            break;
        }
        if ja != answer && !opts.iter().any(|(o, _)| *o == ja) {
            opts.push((ja, en));
        }
    }
}

/// A question's four Japanese options, shuffled, and the English of each one.
fn japanese_options(conn: &Connection, q: &Question) -> rusqlite::Result<(Vec<String>, Vec<String>)> {
    let mut opts = japanese_distractors(conn, q)?;
    opts.push((q.ja.clone(), q.en.clone()));
    shuffle(&mut opts);
    Ok(opts.into_iter().unzip())
}

/// Every English the bank considers a correct rendering of this question's Japanese: its own `en`
/// plus any sibling in the same group whose `ja` is identical. Synonymous idioms and reworded
/// phrases both land here, and the learner is typing from the Japanese alone, so any of them is a
/// right answer.
fn accepted_answers(conn: &Connection, q: &Question) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT en FROM questions WHERE id != ?1 AND kind = ?2 AND word_group = ?3 AND ja = ?4",
    )?;
    let siblings: Vec<String> = stmt
        .query_map(params![q.id, q.kind, &q.group, &q.ja], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let mut out = vec![q.en.clone()];
    for s in siblings {
        if !out.contains(&s) {
            out.push(s);
        }
    }
    // An idiom's wording is fixed -- "hit the books" is not "hit the book" -- so only ordinary
    // sentences get the singular reading of a plural the Japanese could not have signalled.
    if q.kind != "idiom" {
        for variant in util::number_variants(&q.en, db::is_known_word, db::is_countable_noun) {
            if !out.contains(&variant) {
                out.push(variant);
            }
        }
    }
    Ok(out)
}

/// Three plausible wrong replies for a dialogue, from the same tightening circle as
/// `japanese_distractors`: same group → same genre → any other dialogue. Replies are borrowed from
/// sibling conversations so every option is a real English sentence about the same topic. Writing
/// them into the data instead produced options the learner could rule out on shape alone.
fn english_distractors(conn: &Connection, q: &Question) -> rusqlite::Result<Vec<String>> {
    let mut opts: Vec<String> = Vec::new();

    let mut fill = |sql: &str, field: &str| -> rusqlite::Result<()> {
        if opts.len() >= 3 {
            return Ok(());
        }
        let mut stmt = conn.prepare(sql)?;
        let found: Vec<String> = stmt
            .query_map(params![q.id, q.kind, field, q.en], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        extend_unique(&mut opts, found, &q.en);
        Ok(())
    };

    fill(
        "SELECT en FROM questions WHERE id != ?1 AND kind = ?2 AND word_group = ?3 AND en != ?4 ORDER BY RANDOM() LIMIT 8",
        &q.group,
    )?;
    fill(
        "SELECT en FROM questions WHERE id != ?1 AND kind = ?2 AND category = ?3 AND en != ?4 ORDER BY RANDOM() LIMIT 8",
        &q.category,
    )?;
    fill(
        "SELECT en FROM questions WHERE id != ?1 AND kind = ?2 AND ?3 IS NOT NULL AND en != ?4 ORDER BY RANDOM() LIMIT 8",
        &q.category,
    )?;
    Ok(opts)
}

/// The English the app speaks: grammar blanks are filled in so the learner hears a real sentence,
/// dialogues play the other speaker's line.
fn audio_text_for(q: &Question) -> String {
    match q.kind.as_str() {
        "grammar" => q
            .prompt
            .as_ref()
            .map(|p| util::fill_blank(p, &q.en))
            .unwrap_or_else(|| q.en.clone()),
        "dialogue" => q.prompt.clone().unwrap_or_else(|| q.en.clone()),
        _ => q.en.clone(),
    }
}

pub(crate) fn build_session_question(
    conn: &Connection,
    q: Question,
    mode: &str,
    is_review: bool,
) -> rusqlite::Result<SessionQuestion> {
    let audio_text = audio_text_for(&q);
    let mut hide_text = false;
    // `option_en` stays empty where the options are English already.
    let (display, sub_display, options, option_en, answer) = match mode {
        "choice" => {
            if let Some(ch) = q.choices.clone() {
                // Grammar-style question: the prompt has a blank, choices are given.
                let mut opts = ch;
                shuffle(&mut opts);
                (
                    q.prompt.clone().unwrap_or_else(|| q.en.clone()),
                    Some(q.ja.clone()),
                    opts,
                    Vec::new(),
                    q.en.clone(),
                )
            } else {
                let (opts, en) = japanese_options(conn, &q)?;
                (q.en.clone(), None, opts, en, q.ja.clone())
            }
        }
        "typing" => (q.ja.clone(), q.prompt.clone(), Vec::new(), Vec::new(), q.en.clone()),
        "listening" => {
            hide_text = true;
            if q.kind == "dialogue" {
                // Heard: one side of a conversation. Answer: the natural reply, in English.
                let mut opts = english_distractors(conn, &q)?;
                if opts.len() < 3 {
                    // Genre too small to borrow from: fall back to the replies written in the data.
                    extend_unique(&mut opts, q.choices.clone().unwrap_or_default(), &q.en);
                }
                opts.push(q.en.clone());
                shuffle(&mut opts);
                (String::new(), Some(q.ja.clone()), opts, Vec::new(), q.en.clone())
            } else {
                // Heard: the English. Answer: what it means, in Japanese.
                let (opts, en) = japanese_options(conn, &q)?;
                (String::new(), None, opts, en, q.ja.clone())
            }
        }
        _ => (q.en.clone(), Some(q.ja.clone()), Vec::new(), Vec::new(), q.en.clone()),
    };
    // Only typing is graded by comparing free text; everywhere else the learner picks an option.
    let accepted = if mode == "typing" {
        accepted_answers(conn, &q)?
    } else {
        vec![answer.clone()]
    };
    let grammar_note = grammar_note_for(&q);
    let notes = notes_for(&q, &audio_text);
    Ok(SessionQuestion {
        question: q,
        mode: mode.to_string(),
        is_review,
        display,
        sub_display,
        options,
        option_en,
        answer,
        accepted,
        audio_text,
        hide_text,
        grammar_note,
        notes,
    })
}

/// What the answer explains beyond the meaning. A word: how it is built, sentences, patterns and
/// similar words. Anything else is a sentence: the words in it whose patterns it uses (and, for
/// an idiom, where it comes from).
fn notes_for(q: &Question, audio_text: &str) -> Option<WordNotes> {
    if q.kind == "word" {
        let mut notes = db::word_notes(&q.en).unwrap_or_default();
        // A verb's forms (cut-cut-cut; for come back, those of come); a noun spelled like one
        // ("a cut") has none.
        if db::word_pos().get(&q.key).map_or(true, |pos| pos == "verb") {
            notes.irregular = db::irregular_of(&q.en).into_iter().collect();
        }
        return (!notes.is_empty()).then_some(notes);
    }
    let texts: Vec<String> = match q.kind.as_str() {
        "grammar" => vec![audio_text.to_string()],
        "idiom" => std::iter::once(q.en.clone()).chain(q.example.clone()).collect(),
        "dialogue" => q.prompt.iter().cloned().chain(std::iter::once(q.en.clone())).collect(),
        _ => vec![q.en.clone()],
    };
    let mut notes = if q.kind == "idiom" { db::word_notes(&q.en).unwrap_or_default() } else { WordNotes::default() };
    notes.used = db::used_words(&texts);
    notes.irregular = db::irregulars_in(&texts);
    (!notes.is_empty()).then_some(notes)
}

/// The explanation to show with a grammar answer. Questions of other kinds have no point, and an
/// unknown point yields nothing rather than an empty box: a test keeps the two files in step.
fn grammar_note_for(q: &Question) -> Option<GrammarNote> {
    let point = q.point.as_deref()?;
    let note = db::grammar_notes().get(point)?;
    Some(GrammarNote {
        title: note.title.clone(),
        body: note.body.clone(),
        example: note.example.clone(),
    })
}

fn extend_unique(opts: &mut Vec<String>, more: Vec<String>, answer: &str) {
    for m in more {
        if opts.len() >= 3 {
            break;
        }
        if m != answer && !opts.contains(&m) {
            opts.push(m);
        }
    }
}

/// Whether `q` can be asked in `mode`. Listening also plays anything recorded for speaking.
fn offers_mode(q: &Question, mode: &str) -> bool {
    q.modes.iter().any(|m| m == mode || (mode == "listening" && m == "speaking"))
}

/// The mode a due review is asked in: the one it was missed in. A question that went into review
/// before that was recorded is asked by choice where it has one, else in the first mode it offers.
fn review_mode_for(q: &Question, missed_in: Option<String>) -> String {
    match missed_in {
        Some(m) if MODES.contains(&m.as_str()) && offers_mode(q, &m) => m,
        _ if offers_mode(q, "choice") => "choice".to_string(),
        _ => q.modes.first().cloned().unwrap_or_else(|| "choice".to_string()),
    }
}

/// Due reviews first (at most 60% of the session), then unseen/fresh questions; shuffled.
/// A review joins only sessions of the mode it was missed in. `tier` is a tab (word / compound /
/// grammar / idiom / phrase / example) or "mixed", `category` a genre name, a part of speech of
/// the word tab ("pos:noun" / "pos:verb" / "pos:adjective" / "pos:adverb") or "all"; `mode` may also be
/// [`REVIEW_SESSION`].
pub fn session_questions(
    conn: &Connection,
    mode: &str,
    tier: &str,
    category: &str,
    count: u32,
) -> rusqlite::Result<Vec<SessionQuestion>> {
    let count = count.clamp(1, 50) as i64;
    if mode == REVIEW_SESSION {
        return review_session(conn, tier, category, count);
    }
    let mode_like = format!("%\"{}\"%", mode);
    let today = today();
    let max_reviews = ((count as f64) * 0.6).ceil() as i64;
    // Listening reuses anything that has English audio, plus the dialogue-only questions.
    let mode_clause = if mode == "listening" {
        "(q.modes LIKE ?3 OR q.modes LIKE '%\"speaking\"%')"
    } else {
        "q.modes LIKE ?3"
    };

    let review_sql = format!(
        "SELECT {Q_COLS} FROM questions q
         JOIN learning_history h ON h.question_id = q.id
         WHERE h.user_id = ?1 AND h.needs_review = 1 AND h.next_due_at IS NOT NULL AND h.next_due_at <= ?2
           AND {mode_clause} AND (?4 = 'mixed' OR q.tier = ?4)
           AND (?5 = 'all' OR q.category = ?5 OR ('pos:' || q.pos) = ?5)
           AND (h.review_mode IS NULL OR h.review_mode = ?7)
         ORDER BY h.next_due_at ASC, RANDOM() LIMIT ?6"
    );
    let reviews: Vec<Question> = {
        let mut stmt = conn.prepare(&review_sql)?;
        let rows = stmt.query_map(
            params![USER_ID, today, mode_like, tier, category, max_reviews, mode],
            db::row_to_question,
        )?;
        rows.collect::<Result<_, _>>()?
    };

    let remaining = count - reviews.len() as i64;
    let exclude: Vec<String> = reviews.iter().map(|q| q.id.to_string()).collect();
    let exclude_clause = if exclude.is_empty() {
        String::new()
    } else {
        format!("AND q.id NOT IN ({})", exclude.join(","))
    };
    let fresh_mode_clause = mode_clause.replace("?3", "?2");
    let fresh_sql = format!(
        "SELECT {Q_COLS} FROM questions q
         LEFT JOIN learning_history h ON h.question_id = q.id AND h.user_id = ?1
         WHERE {fresh_mode_clause} AND (?3 = 'mixed' OR q.tier = ?3)
           AND (?4 = 'all' OR q.category = ?4 OR ('pos:' || q.pos) = ?4)
           AND (h.needs_review IS NULL OR h.needs_review = 0) {exclude_clause}
         ORDER BY (h.last_studied_at IS NOT NULL), RANDOM() LIMIT ?5"
    );
    let fresh: Vec<Question> = {
        let mut stmt = conn.prepare(&fresh_sql)?;
        let rows = stmt.query_map(
            params![USER_ID, mode_like, tier, category, remaining],
            db::row_to_question,
        )?;
        rows.collect::<Result<_, _>>()?
    };

    let mut out = Vec::with_capacity(count as usize);
    for q in reviews {
        out.push(build_session_question(conn, q, mode, true)?);
    }
    for q in fresh {
        out.push(build_session_question(conn, q, mode, false)?);
    }
    shuffle(&mut out);
    Ok(out)
}

/// ホームの「復習をはじめる」: every due review, whatever its mode, each asked in the mode it was
/// missed in, so a phrase got wrong by typing is typed again rather than picked from four.
/// Nothing fresh is mixed in.
fn review_session(conn: &Connection, tier: &str, category: &str, count: i64) -> rusqlite::Result<Vec<SessionQuestion>> {
    let sql = format!(
        "SELECT {Q_COLS}, h.review_mode FROM questions q
         JOIN learning_history h ON h.question_id = q.id
         WHERE h.user_id = ?1 AND h.needs_review = 1 AND h.next_due_at IS NOT NULL AND h.next_due_at <= ?2
           AND (?3 = 'mixed' OR q.tier = ?3) AND (?4 = 'all' OR q.category = ?4 OR ('pos:' || q.pos) = ?4)
         ORDER BY h.next_due_at ASC, RANDOM() LIMIT ?5"
    );
    let due: Vec<(Question, Option<String>)> = {
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![USER_ID, today(), tier, category, count], |r| {
            Ok((db::row_to_question(r)?, r.get(db::Q_COL_COUNT)?))
        })?;
        rows.collect::<Result<_, _>>()?
    };
    let mut out = Vec::with_capacity(due.len());
    for (q, missed_in) in due {
        let mode = review_mode_for(&q, missed_in);
        out.push(build_session_question(conn, q, &mode, true)?);
    }
    shuffle(&mut out);
    Ok(out)
}

/// Records one answer: kcal reward, SRS schedule, daily stats, streak and cheat-day tickets.
pub fn record_answer(conn: &mut Connection, payload: &AnswerPayload) -> Result<AnswerResult, String> {
    let tx = conn.transaction().map_err(err)?;
    let today = today();
    let now = now_ts();

    let (kind, tier, answer): (String, String, String) = tx
        .query_row(
            "SELECT kind, tier, en FROM questions WHERE id = ?1",
            params![payload.question_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| format!("question {} not found", payload.question_id))?;
    let scored = srs::scored(&kind, &tier);

    let hist: Option<(i64, i64, Option<String>)> = tx
        .query_row(
            "SELECT srs_level, needs_review, next_due_at FROM learning_history WHERE user_id = ?1 AND question_id = ?2",
            params![USER_ID, payload.question_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(err)?;
    let (level, needs_review, next_due) = hist.unwrap_or((0, 0, None));
    let in_review = needs_review == 1;
    let is_due_review = in_review
        && next_due
            .as_deref()
            .map(|d| d <= today.as_str())
            .unwrap_or(false);

    let low_score = payload.mode == "speaking"
        && payload
            .score
            .map(|s| s < srs::SPEAKING_REVIEW_THRESHOLD)
            .unwrap_or(false);
    let hints_used = payload.hints_used.unwrap_or(0);
    let per_word = srs::scores_per_word(&kind, &payload.mode);
    let mut kcal = if per_word {
        // 1語 1 kcal、ヒント1語ごとに −1 kcal。復習の ×1.5 はその結果に掛ける。
        srs::per_word_kcal(&answer, payload.correct, hints_used, payload.mistakes)
    } else {
        srs::kcal_for(scored, &payload.mode, payload.correct, payload.score)
    };
    if is_due_review && payload.correct {
        kcal = srs::apply_review_bonus(kcal);
    }
    if !per_word {
        kcal = srs::apply_hint_penalty(scored, kcal, hints_used);
    }
    let (new_level, new_needs_review, new_next_due) =
        srs::next_state(level, in_review, payload.correct, low_score);
    // A miss is reviewed in the mode it happened in; a correct answer leaves that as it was.
    let missed_in = (!payload.correct || low_score).then(|| payload.mode.clone());

    tx.execute(
        "INSERT INTO learning_history
           (user_id, question_id, correct_count, wrong_count, last_correct, last_score, srs_level, needs_review, last_studied_at, next_due_at, review_mode)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(user_id, question_id) DO UPDATE SET
           correct_count = correct_count + excluded.correct_count,
           wrong_count = wrong_count + excluded.wrong_count,
           last_correct = excluded.last_correct,
           last_score = excluded.last_score,
           srs_level = excluded.srs_level,
           needs_review = excluded.needs_review,
           last_studied_at = excluded.last_studied_at,
           next_due_at = excluded.next_due_at,
           review_mode = COALESCE(excluded.review_mode, review_mode)",
        params![
            USER_ID,
            payload.question_id,
            payload.correct as i64,
            (!payload.correct) as i64,
            payload.correct as i64,
            payload.score,
            new_level,
            new_needs_review as i64,
            now,
            new_next_due,
            missed_in
        ],
    )
    .map_err(err)?;

    tx.execute(
        "INSERT INTO answer_log (user_id, question_id, mode, correct, score, kcal, is_review, answered_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            USER_ID,
            payload.question_id,
            payload.mode,
            payload.correct as i64,
            payload.score,
            kcal,
            is_due_review as i64,
            now
        ],
    )
    .map_err(err)?;

    // The log keeps what the question pays; the play mode scales it on the way to the day.
    let paid = credit(&tx, &today, kcal * srs::EIGHTHS).map_err(err)?;
    tx.execute(
        "UPDATE daily_stats SET answered = answered + 1, correct = correct + ?3 WHERE user_id = ?1 AND date = ?2",
        params![USER_ID, today, payload.correct as i64],
    )
    .map_err(err)?;

    let Studied { streak, first_study_today, new_ticket } = mark_studied(&tx, &today, &now).map_err(err)?;

    let today_stats = load_daily(&tx, &today).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(AnswerResult {
        kcal_earned: paid.whole,
        points: paid.points(),
        fraction_pending: paid.pending,
        today_kcal: today_stats.kcal_earned,
        streak,
        new_ticket,
        first_study_today,
        is_review: is_due_review,
        needs_review: new_needs_review,
        next_due: new_next_due,
    })
}

/// What studying today did to the streak.
pub(crate) struct Studied {
    pub streak: i64,
    pub first_study_today: bool,
    /// the streak reached a multiple of 7 and earned a cheat-day ticket
    pub new_ticket: bool,
}

/// Streak bookkeeping, once per calendar day: the first answer of a day (a question, or an exam
/// handed in) extends yesterday's streak or starts a new one.
pub(crate) fn mark_studied(conn: &Connection, today: &str, now: &str) -> rusqlite::Result<Studied> {
    let user = load_user(conn)?;
    if user.last_study_date.as_deref() == Some(today) {
        return Ok(Studied { streak: user.current_streak, first_study_today: false, new_ticket: false });
    }
    let streak = if user.last_study_date.as_deref() == Some(date_plus(-1).as_str()) { user.current_streak + 1 } else { 1 };
    let longest = user.longest_streak.max(streak);
    conn.execute(
        "UPDATE users SET current_streak = ?1, longest_streak = ?2, total_study_days = total_study_days + 1, last_study_date = ?3 WHERE id = ?4",
        params![streak, longest, today, USER_ID],
    )?;
    let new_ticket = streak % 7 == 0;
    if new_ticket {
        conn.execute(
            "INSERT INTO cheat_tickets (user_id, issued_at, issued_for_streak) VALUES (?1, ?2, ?3)",
            params![USER_ID, now, streak],
        )?;
    }
    Ok(Studied { streak, first_study_today: true, new_ticket })
}

pub fn redeem_ticket(conn: &Connection) -> Result<RedeemResult, String> {
    let ticket_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM cheat_tickets WHERE user_id = ?1 AND used_at IS NULL ORDER BY issued_at ASC LIMIT 1",
            params![USER_ID],
            |r| r.get(0),
        )
        .optional()
        .map_err(err)?;
    let Some(ticket_id) = ticket_id else {
        return Err("使えるチートデイチケットがありません".into());
    };
    let today = today();
    conn.execute(
        "UPDATE cheat_tickets SET used_at = ?1 WHERE id = ?2",
        params![now_ts(), ticket_id],
    )
    .map_err(err)?;
    let paid = credit(conn, &today, srs::CHEAT_DAY_BONUS * srs::EIGHTHS).map_err(err)?;
    let stats = load_daily(conn, &today).map_err(err)?;
    Ok(RedeemResult {
        kcal_added: paid.whole,
        today_kcal: stats.kcal_earned,
        tickets_left: tickets_available(conn).map_err(err)?,
    })
}

/* ---------- Tauri commands ---------- */

#[tauri::command]
pub fn set_play_mode(state: State<'_, AppState>, mode: String) -> CmdResult<String> {
    let conn = state.db.lock().map_err(err)?;
    set_play_mode_in(&conn, &mode)
}

#[tauri::command]
pub fn get_dashboard(state: State<'_, AppState>) -> CmdResult<Dashboard> {
    let conn = state.db.lock().map_err(err)?;
    load_dashboard(&conn)
}

pub fn load_dashboard(conn: &Connection) -> CmdResult<Dashboard> {
    let (just_saved, just_issued) = settle_savings(conn).map_err(err)?;
    let user = load_user(conn).map_err(err)?;
    let today_stats = load_daily(conn, &today()).map_err(err)?;
    Ok(Dashboard {
        today: today_stats,
        goal_snacks: goal_snacks_inner(conn).map_err(err)?,
        eaten_today: eaten_today(conn).map_err(err)?,
        snacks: list_snacks_inner(conn).map_err(err)?,
        categories: category_infos(conn).map_err(err)?,
        parts_of_speech: parts_of_speech(conn).map_err(err)?,
        due_review_count: due_review_count(conn).map_err(err)?,
        tickets_available: tickets_available(conn).map_err(err)?,
        kcal_rates: kcal_rates(),
        savings: savings_info(conn, just_saved, just_issued).map_err(err)?,
        exam: crate::exam::overview(conn).map_err(err)?,
        user,
    })
}

#[tauri::command]
pub fn get_session_questions(
    state: State<'_, AppState>,
    mode: String,
    tier: String,
    category: Option<String>,
    count: u32,
) -> CmdResult<Vec<SessionQuestion>> {
    if mode != REVIEW_SESSION && !MODES.contains(&mode.as_str()) {
        return Err(format!("unknown mode {mode}"));
    }
    let conn = state.db.lock().map_err(err)?;
    let category = category.filter(|c| !c.trim().is_empty()).unwrap_or_else(|| "all".to_string());
    session_questions(&conn, &mode, &tier, &category, count).map_err(err)
}

/// English word (lowercase) → Japanese gloss, for the hover dictionary in the study screen.
#[tauri::command]
pub fn get_dictionary(state: State<'_, AppState>) -> CmdResult<HashMap<String, String>> {
    let conn = state.db.lock().map_err(err)?;
    db::dictionary(&conn).map_err(err)
}

/// IPA for the words of speaking questions (see `db::pronunciations`).
#[tauri::command]
pub fn get_pronunciations() -> HashMap<String, String> {
    db::pronunciations().clone()
}

/// What the answer explains about a word, for a word saved to the recipe (see `db::word_notes`).
#[tauri::command]
pub fn get_word_notes(word: String) -> Option<WordNotes> {
    let mut notes = db::word_notes(&word).unwrap_or_default();
    notes.irregular = db::irregular_of(&word).into_iter().collect();
    (!notes.is_empty()).then_some(notes)
}

/// The dictionary keys that are idioms (see `db::idiom_keys`).
#[tauri::command]
pub fn get_idioms(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    let conn = state.db.lock().map_err(err)?;
    db::idiom_keys(&conn).map_err(err)
}

#[tauri::command]
pub fn submit_answer(state: State<'_, AppState>, payload: AnswerPayload) -> CmdResult<AnswerResult> {
    let mut conn = state.db.lock().map_err(err)?;
    record_answer(&mut conn, &payload)
}

#[tauri::command]
pub fn list_snacks(state: State<'_, AppState>) -> CmdResult<Vec<Snack>> {
    let conn = state.db.lock().map_err(err)?;
    list_snacks_inner(&conn).map_err(err)
}

#[tauri::command]
pub fn add_snack(state: State<'_, AppState>, name: String, calories: i64, icon: String) -> CmdResult<Snack> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("お菓子の名前を入力してください".into());
    }
    if !(1..=5000).contains(&calories) {
        return Err("カロリーは1〜5000の範囲で入力してください".into());
    }
    let icon = if icon.trim().is_empty() { "🍬".to_string() } else { icon };
    let conn = state.db.lock().map_err(err)?;
    conn.execute(
        "INSERT INTO snacks (name, calories, icon, is_builtin, created_at) VALUES (?1, ?2, ?3, 0, ?4)",
        params![name, calories, icon, now_ts()],
    )
    .map_err(err)?;
    let id = conn.last_insert_rowid();
    load_snack(&conn, id)
        .map_err(err)?
        .ok_or_else(|| "failed to load snack".to_string())
}

/// Corrects a snack of the book, one of the first ones as well as one the learner added: what they
/// eat is not always what the book first said. Goals follow it; what was eaten keeps the name and
/// kcal it had then.
pub fn update_snack_in(conn: &Connection, id: i64, name: &str, calories: i64, icon: &str) -> CmdResult<Snack> {
    let name = name.trim();
    if name.is_empty() {
        return Err("お菓子の名前を入力してください".into());
    }
    if !(1..=5000).contains(&calories) {
        return Err("カロリーは1〜5000の範囲で入力してください".into());
    }
    let icon = if icon.trim().is_empty() { "🍬" } else { icon };
    let changed = conn
        .execute("UPDATE snacks SET name = ?2, calories = ?3, icon = ?4 WHERE id = ?1", params![id, name, calories, icon])
        .map_err(err)?;
    if changed == 0 {
        return Err("snack not found".into());
    }
    load_snack(conn, id).map_err(err)?.ok_or_else(|| "snack not found".to_string())
}

/// Takes a snack out of the book, one of the first ones too (they are put in once, on the first
/// start, and do not come back). It leaves the goals; what was eaten stays in the log.
pub fn delete_snack_in(conn: &Connection, id: i64) -> CmdResult<()> {
    conn.execute("DELETE FROM goal_snacks WHERE snack_id = ?1", params![id]).map_err(err)?;
    conn.execute("DELETE FROM snacks WHERE id = ?1", params![id]).map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn update_snack(state: State<'_, AppState>, id: i64, name: String, calories: i64, icon: String) -> CmdResult<Snack> {
    let conn = state.db.lock().map_err(err)?;
    update_snack_in(&conn, id, &name, calories, &icon)
}

#[tauri::command]
pub fn delete_snack(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let conn = state.db.lock().map_err(err)?;
    delete_snack_in(&conn, id)
}

/// Adds a snack to the goals (`goal: true`) or takes it off; the snack stays in the book.
#[tauri::command]
pub fn set_goal_snack(state: State<'_, AppState>, id: i64, goal: bool) -> CmdResult<Vec<Snack>> {
    let conn = state.db.lock().map_err(err)?;
    set_goal(&conn, id, goal)
}

#[tauri::command]
pub fn log_snack_eaten(state: State<'_, AppState>, snack_id: i64) -> CmdResult<DailyStats> {
    let conn = state.db.lock().map_err(err)?;
    log_eaten(&conn, snack_id)
}

/// Records a snack eaten today and spends its kcal from today's budget.
pub fn log_eaten(conn: &Connection, snack_id: i64) -> CmdResult<DailyStats> {
    let snack = load_snack(conn, snack_id)
        .map_err(err)?
        .ok_or_else(|| "snack not found".to_string())?;
    let today = today();
    conn.execute(
        "INSERT INTO consumption_log (user_id, snack_id, snack_name, snack_icon, calories, date, eaten_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![USER_ID, snack.id, snack.name, snack.icon, snack.calories, today, now_ts()],
    )
    .map_err(err)?;
    conn.execute(
        "INSERT INTO daily_stats (user_id, date, kcal_consumed) VALUES (?1, ?2, ?3)
         ON CONFLICT(user_id, date) DO UPDATE SET kcal_consumed = kcal_consumed + excluded.kcal_consumed",
        params![USER_ID, today, snack.calories],
    )
    .map_err(err)?;
    load_daily(conn, &today).map_err(err)
}

#[tauri::command]
pub fn get_today_consumption(state: State<'_, AppState>) -> CmdResult<Vec<ConsumptionEntry>> {
    let conn = state.db.lock().map_err(err)?;
    let mut stmt = conn
        .prepare("SELECT id, snack_name, snack_icon, calories, eaten_at, ticket_id IS NOT NULL FROM consumption_log WHERE user_id = ?1 AND date = ?2 ORDER BY eaten_at DESC")
        .map_err(err)?;
    let rows = stmt
        .query_map(params![USER_ID, today()], |r| {
            Ok(ConsumptionEntry {
                id: r.get(0)?,
                snack_name: r.get(1)?,
                snack_icon: r.get(2)?,
                calories: r.get(3)?,
                eaten_at: r.get(4)?,
                with_ticket: r.get(5)?,
            })
        })
        .map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

#[tauri::command]
pub fn delete_consumption(state: State<'_, AppState>, id: i64) -> CmdResult<DailyStats> {
    let conn = state.db.lock().map_err(err)?;
    delete_consumption_inner(&conn, id)
}

#[tauri::command]
pub fn eat_with_ticket(state: State<'_, AppState>, snack_id: i64) -> CmdResult<DailyStats> {
    let conn = state.db.lock().map_err(err)?;
    eat_with_ticket_inner(&conn, snack_id)
}

#[tauri::command]
pub fn redeem_cheat_ticket(state: State<'_, AppState>) -> CmdResult<RedeemResult> {
    let conn = state.db.lock().map_err(err)?;
    redeem_ticket(&conn)
}

#[tauri::command]
pub fn get_stats(state: State<'_, AppState>) -> CmdResult<Stats> {
    let conn = state.db.lock().map_err(err)?;
    load_stats(&conn)
}

/// Everything on the 記録 screen: totals, the last two weeks, the weakest questions and tickets.
pub fn load_stats(conn: &Connection) -> CmdResult<Stats> {
    let user = load_user(conn).map_err(err)?;
    let (total_kcal, total_consumed, total_answered, total_correct): (i64, i64, i64, i64) = conn
        .query_row(
            "SELECT COALESCE(SUM(kcal_earned), 0), COALESCE(SUM(kcal_consumed), 0), COALESCE(SUM(answered), 0), COALESCE(SUM(correct), 0)
             FROM daily_stats WHERE user_id = ?1",
            params![USER_ID],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(err)?;
    let accuracy = if total_answered > 0 {
        total_correct as f64 / total_answered as f64
    } else {
        0.0
    };

    let start = date_plus(-13);
    let mut by_date: HashMap<String, (i64, i64, i64, i64)> = HashMap::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT date, kcal_earned, kcal_consumed, answered, correct FROM daily_stats WHERE user_id = ?1 AND date >= ?2",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map(params![USER_ID, start], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?, r.get::<_, i64>(4)?),
                ))
            })
            .map_err(err)?;
        for row in rows {
            let (d, v) = row.map_err(err)?;
            by_date.insert(d, v);
        }
    }
    // What was eaten each day, for the chart's 消費 dots: a snack a line, the most kcal first.
    let mut eaten_by_date: HashMap<String, Vec<EatenSnack>> = HashMap::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT date, snack_icon, snack_name, ticket_id IS NOT NULL, COUNT(*), SUM(calories) FROM consumption_log
                 WHERE user_id = ?1 AND date >= ?2 GROUP BY date, snack_icon, snack_name, ticket_id IS NOT NULL",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map(params![USER_ID, start], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    EatenSnack { icon: r.get(1)?, name: r.get(2)?, with_ticket: r.get(3)?, count: r.get(4)?, kcal: r.get(5)? },
                ))
            })
            .map_err(err)?;
        for row in rows {
            let (d, snack) = row.map_err(err)?;
            eaten_by_date.entry(d).or_default().push(snack);
        }
    }
    let last_14_days = (0..14)
        .map(|i| {
            let date = date_plus(i - 13);
            let (k, e, a, c) = by_date.get(&date).copied().unwrap_or((0, 0, 0, 0));
            let mut eaten = eaten_by_date.remove(&date).unwrap_or_default();
            eaten.sort_by(|x, y| x.with_ticket.cmp(&y.with_ticket).then(y.kcal.cmp(&x.kcal)).then(x.name.cmp(&y.name)));
            DayPoint { date, kcal_earned: k, kcal_consumed: e, answered: a, correct: c, eaten }
        })
        .collect();

    let weak_questions = {
        let sql = format!(
            "SELECT {Q_COLS}, h.wrong_count, h.last_score, h.next_due_at, h.srs_level
             FROM learning_history h JOIN questions q ON q.id = h.question_id
             WHERE h.user_id = ?1 AND (h.needs_review = 1 OR h.wrong_count > 0)
             ORDER BY h.needs_review DESC, h.wrong_count DESC, COALESCE(h.last_score, 0) ASC LIMIT 12"
        );
        let mut stmt = conn.prepare(&sql).map_err(err)?;
        let rows = stmt
            .query_map(params![USER_ID], |r| {
                // The history columns come right after the question's own.
                let h = db::Q_COL_COUNT;
                Ok(WeakQuestion {
                    question: db::row_to_question(r)?,
                    wrong_count: r.get(h)?,
                    last_score: r.get(h + 1)?,
                    next_due: r.get(h + 2)?,
                    srs_level: r.get(h + 3)?,
                })
            })
            .map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)?
    };

    let tickets = {
        let mut stmt = conn
            .prepare("SELECT id, issued_at, issued_for_streak, used_at FROM cheat_tickets WHERE user_id = ?1 ORDER BY issued_at DESC LIMIT 20")
            .map_err(err)?;
        let rows = stmt
            .query_map(params![USER_ID], |r| {
                Ok(Ticket {
                    id: r.get(0)?,
                    issued_at: r.get(1)?,
                    issued_for_streak: r.get(2)?,
                    used_at: r.get(3)?,
                })
            })
            .map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)?
    };

    let review_pending: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM learning_history WHERE user_id = ?1 AND needs_review = 1",
            params![USER_ID],
            |r| r.get(0),
        )
        .map_err(err)?;

    // The study answers by tab and mode: what they earned at 通常 (the play mode left aside), how
    // many, how many right. Recipe reviews, exams and the cheat-day bonus are not questions of a
    // tab, so they are not here.
    let breakdown = {
        let mut stmt = conn
            .prepare(
                "SELECT q.tier, a.mode, COALESCE(SUM(a.kcal), 0), COUNT(*), COALESCE(SUM(a.correct), 0)
                 FROM answer_log a JOIN questions q ON q.id = a.question_id
                 WHERE a.user_id = ?1 GROUP BY q.tier, a.mode ORDER BY q.tier, a.mode",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map(params![USER_ID], |r| {
                Ok(StatCell {
                    tier: r.get(0)?,
                    mode: r.get(1)?,
                    kcal: r.get(2)?,
                    answered: r.get(3)?,
                    correct: r.get(4)?,
                })
            })
            .map_err(err)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(err)?
    };

    Ok(Stats {
        total_study_days: user.total_study_days,
        current_streak: user.current_streak,
        longest_streak: user.longest_streak,
        total_kcal,
        total_consumed,
        total_answered,
        total_correct,
        accuracy,
        last_14_days,
        weak_questions,
        tickets,
        review_due: due_review_count(conn).map_err(err)?,
        review_pending,
        breakdown,
    })
}

#[tauri::command]
pub fn reset_progress(state: State<'_, AppState>) -> CmdResult<()> {
    let conn = state.db.lock().map_err(err)?;
    conn.execute_batch(
        "DELETE FROM learning_history; DELETE FROM answer_log; DELETE FROM daily_stats;
         DELETE FROM consumption_log; DELETE FROM cheat_tickets; DELETE FROM snack_tickets;
         UPDATE users SET total_study_days = 0, current_streak = 0, longest_streak = 0, last_study_date = NULL,
           savings_kcal = 0;
         UPDATE recipe_words SET paid_on = NULL;
         DELETE FROM exam_attempts; DELETE FROM exam_mistakes;",
    )
    .map_err(err)
}

#[tauri::command]
pub fn log_debug(message: String) {
    println!("[frontend] {message}");
}

/* ---------- tests ---------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        db::init_in_memory().expect("in-memory db")
    }

    fn question_id(conn: &Connection, key: &str) -> i64 {
        conn.query_row("SELECT id FROM questions WHERE key = ?1", params![key], |r| r.get(0))
            .expect("seed question")
    }

    fn history(conn: &Connection, qid: i64) -> (i64, i64, Option<String>) {
        conn.query_row(
            "SELECT srs_level, needs_review, next_due_at FROM learning_history WHERE user_id = 1 AND question_id = ?1",
            params![qid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .expect("history row")
    }

    fn answer(conn: &mut Connection, qid: i64, mode: &str, correct: bool, score: Option<f64>) -> AnswerResult {
        answer_with_hints(conn, qid, mode, correct, score, None)
    }

    fn answer_with_hints(
        conn: &mut Connection,
        qid: i64,
        mode: &str,
        correct: bool,
        score: Option<f64>,
        hints_used: Option<i64>,
    ) -> AnswerResult {
        record_answer(
            conn,
            &AnswerPayload { question_id: qid, mode: mode.into(), correct, score, hints_used, mistakes: None },
        )
        .expect("record")
    }

    #[test]
    fn seeds_questions_and_snacks() {
        let c = conn();
        let n: i64 = c.query_row("SELECT COUNT(*) FROM questions", [], |r| r.get(0)).unwrap();
        assert!(n >= 100, "expected seed questions, got {n}");
        let s: i64 = c.query_row("SELECT COUNT(*) FROM snacks WHERE is_builtin = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(s, 10);
    }

    #[test]
    fn a_word_picked_from_four_earns_one_kcal() {
        let mut c = conn();
        let qid = question_id(&c, "w001");
        let r = answer(&mut c, qid, "choice", true, None);
        assert_eq!(r.kcal_earned, 1);
        assert_eq!(r.today_kcal, 1);
        assert!(r.first_study_today);
        assert_eq!(r.streak, 1);
        assert!(!r.needs_review);
        let d = load_daily(&c, &today()).unwrap();
        assert_eq!((d.answered, d.correct), (1, 1));
    }

    /// The 記録 screen stayed on "集計しています…" once any question had been missed: the weak-question
    /// query reads the history columns after `Q_COLS`, and `point` joined `Q_COLS` without the
    /// indices moving along, so every row failed to load and so did the whole screen.
    #[test]
    fn stats_list_the_questions_that_were_missed() {
        let mut c = conn();
        let empty = load_stats(&c).unwrap();
        assert!(empty.weak_questions.is_empty());

        let word = question_id(&c, "w002");
        let grammar = question_id(&c, "g1682");
        let known = question_id(&c, "w001");
        answer(&mut c, word, "typing", false, None);
        answer(&mut c, grammar, "choice", false, None);
        answer(&mut c, known, "choice", true, None);

        let s = load_stats(&c).unwrap();
        assert_eq!((s.total_answered, s.total_correct), (3, 1));
        assert_eq!(s.review_pending, 2);
        assert_eq!(s.weak_questions.len(), 2);
        for w in &s.weak_questions {
            assert!([word, grammar].contains(&w.question.id));
            assert_eq!(w.wrong_count, 1);
            assert_eq!(w.srs_level, 0);
            assert_eq!(w.next_due.as_deref(), Some(date_plus(1).as_str()));
            assert!(w.last_score.is_none());
        }
        let g = s.weak_questions.iter().find(|w| w.question.id == grammar).unwrap();
        assert_eq!(g.question.point.as_deref(), Some("time-clause-tense"));
    }

    /// 記録 by tab and mode: what the study answers earned at 通常 (whatever the play mode), how
    /// many there were and how many were right, one cell per tab and mode.
    #[test]
    fn stats_break_the_answers_down_by_tab_and_mode() {
        let mut c = conn();
        let word = question_id(&c, "w001");
        let idiom = question_id(&c, "i002");
        answer(&mut c, word, "choice", true, None); // 1 kcal
        answer(&mut c, word, "choice", false, None);
        set_play_mode_in(&c, "hard").unwrap();
        answer(&mut c, idiom, "typing", true, None); // 5 kcal at 通常, 2.5 paid
        let s = load_stats(&c).unwrap();
        let cell = |tier: &str, mode: &str| s.breakdown.iter().find(|b| b.tier == tier && b.mode == mode).cloned();
        let w = cell("word", "choice").expect("英単語 × 選択");
        assert_eq!((w.kcal, w.answered, w.correct), (1, 2, 1));
        let i = cell("idiom", "typing").expect("慣用句 × 記入");
        assert_eq!((i.kcal, i.answered, i.correct), (5, 1, 1), "counted at 通常 though がんばり paid 2.5");
        assert!(cell("word", "typing").is_none(), "a pair never answered has no cell");
        assert_eq!(s.breakdown.iter().map(|b| b.answered).sum::<i64>(), s.total_answered);

        // The fortnight's chart is what the days earned (after the play mode) and ate, and what was
        // eaten each day, the most kcal first.
        let pudding = snack_id(&c, "プリン");
        log_eaten(&c, snack_id(&c, "クッキー 1枚")).unwrap();
        log_eaten(&c, pudding).unwrap();
        log_eaten(&c, pudding).unwrap();
        let s = load_stats(&c).unwrap();
        let day = s.last_14_days.last().unwrap();
        assert_eq!(day.date, today());
        assert_eq!((day.kcal_earned, day.kcal_consumed), (3, 350), "1 + 2.5 under がんばり, the half kept for later");
        assert_eq!((s.total_kcal, s.total_consumed, s.total_study_days), (3, 350, 1), "what the averages divide");
        let eaten: Vec<(&str, i64, i64)> = day.eaten.iter().map(|e| (e.name.as_str(), e.count, e.kcal)).collect();
        assert_eq!(eaten, vec![("プリン", 2, 300), ("クッキー 1枚", 1, 50)]);
        assert!(s.last_14_days[0].eaten.is_empty());
    }

    #[test]
    fn wrong_answer_schedules_review_tomorrow() {
        let mut c = conn();
        let qid = question_id(&c, "w002");
        let r = answer(&mut c, qid, "typing", false, None);
        assert_eq!(r.kcal_earned, 0);
        assert!(r.needs_review);
        assert_eq!(r.next_due.as_deref(), Some(date_plus(1).as_str()));
        let (level, needs, due) = history(&c, qid);
        assert_eq!((level, needs), (0, 1));
        assert_eq!(due.as_deref(), Some(date_plus(1).as_str()));
        // Not due yet: it must not be served again today, neither as review nor as fresh.
        for _ in 0..5 {
            let s = session_questions(&c, "typing", "word", "all", 50).unwrap();
            assert!(s.iter().all(|q| q.question.id != qid));
        }
    }

    #[test]
    fn due_review_pays_bonus_and_advances_level() {
        let mut c = conn();
        let qid = question_id(&c, "w003");
        answer(&mut c, qid, "choice", false, None);
        c.execute("UPDATE learning_history SET next_due_at = ?1 WHERE question_id = ?2", params![today(), qid]).unwrap();
        assert_eq!(due_review_count(&c).unwrap(), 1);

        let session = session_questions(&c, "choice", "word", "all", 10).unwrap();
        let served = session.iter().find(|q| q.question.id == qid).expect("due question served");
        assert!(served.is_review);
        assert_eq!(served.options.len(), 4);
        assert!(served.options.contains(&served.answer));

        let r = answer(&mut c, qid, "choice", true, None);
        assert!(r.is_review);
        assert_eq!(r.kcal_earned, 2, "1 kcal x 1.5 rounded");
        let (level, needs, due) = history(&c, qid);
        assert_eq!((level, needs), (1, 1));
        assert_eq!(due.as_deref(), Some(date_plus(3).as_str()));
    }

    /// A word with a known make-up carries it to the answer; other kinds never do.
    #[test]
    fn a_word_question_carries_its_parts() {
        let c = conn();
        let id: i64 = c
            .query_row("SELECT id FROM questions WHERE kind = 'word' AND en = 'telescope'", [], |r| r.get(0))
            .expect("telescope is a word question");
        let q = c
            .query_row(&format!("SELECT {Q_COLS} FROM questions q WHERE q.id = ?1"), params![id], db::row_to_question)
            .unwrap();
        let s = build_session_question(&c, q, "choice", false).unwrap();
        let notes = s.notes.expect("telescope has notes");
        assert!(!notes.examples.is_empty(), "every word has an example");
        let parts = notes.parts;
        assert_eq!(parts.iter().map(|p| p.text.as_str()).collect::<Vec<_>>(), vec!["tele", "scope"]);
        assert_eq!(parts[0].kind, "prefix");
        let phrase = question_id(&c, "p001");
        let q = c
            .query_row(&format!("SELECT {Q_COLS} FROM questions q WHERE q.id = ?1"), params![phrase], db::row_to_question)
            .unwrap();
        let notes = build_session_question(&c, q, "choice", false).unwrap().notes;
        assert!(notes.map_or(true, |n| n.parts.is_empty() && n.examples.is_empty()), "a phrase has no parts or examples of its own");
    }

    /// A phrase got wrong by typing comes back to be typed: in typing sessions and in the review
    /// session from home, never as a four-way pick in a choice session.
    #[test]
    fn a_miss_is_reviewed_in_the_mode_it_was_missed_in() {
        let mut c = conn();
        let typed = question_id(&c, "p001");
        let picked = question_id(&c, "w003");
        let spoken = question_id(&c, "i001");
        answer(&mut c, typed, "typing", false, None);
        answer(&mut c, picked, "choice", false, None);
        answer(&mut c, spoken, "speaking", true, Some(40.0)); // passed, but low enough for review
        c.execute("UPDATE learning_history SET next_due_at = ?1", params![today()]).unwrap();

        let in_session = |c: &Connection, mode: &str, qid: i64| {
            session_questions(c, mode, "mixed", "all", 50).unwrap().into_iter().find(|q| q.question.id == qid)
        };
        assert!(in_session(&c, "choice", typed).is_none(), "not picked from four");
        let t = in_session(&c, "typing", typed).expect("typed again in a typing session");
        assert!(t.is_review);
        assert!(in_session(&c, "typing", picked).is_none());
        assert!(in_session(&c, "choice", picked).expect("choice review").is_review);

        let review = session_questions(&c, REVIEW_SESSION, "mixed", "all", 10).unwrap();
        assert_eq!(review.len(), 3, "only the due reviews, nothing fresh");
        assert!(review.iter().all(|q| q.is_review));
        let mode_of = |qid: i64| review.iter().find(|q| q.question.id == qid).unwrap().mode.clone();
        assert_eq!(mode_of(typed), "typing");
        assert_eq!(mode_of(picked), "choice");
        assert_eq!(mode_of(spoken), "speaking");
        let t = review.iter().find(|q| q.question.id == typed).unwrap();
        assert_eq!(t.answer, "Nice to meet you.");
        assert!(t.options.is_empty());

        // Answered right in its review, it stays a typing review until it graduates.
        answer(&mut c, typed, "typing", true, None);
        c.execute("UPDATE learning_history SET next_due_at = ?1", params![today()]).unwrap();
        assert!(in_session(&c, "typing", typed).is_some());
        assert!(in_session(&c, "choice", typed).is_none());
    }

    /// A question that went into review before the mode was recorded is asked by choice where it
    /// can be, and joins sessions of any mode.
    #[test]
    fn an_unrecorded_review_is_asked_by_choice() {
        let mut c = conn();
        let qid = question_id(&c, "p002");
        answer(&mut c, qid, "typing", false, None);
        c.execute("UPDATE learning_history SET next_due_at = ?1, review_mode = NULL", params![today()]).unwrap();
        let review = session_questions(&c, REVIEW_SESSION, "mixed", "all", 10).unwrap();
        assert_eq!(review[0].mode, "choice");
        assert_eq!(review[0].options.len(), 4);
        for mode in ["choice", "typing"] {
            let s = session_questions(&c, mode, "mixed", "all", 50).unwrap();
            assert!(s.iter().any(|q| q.question.id == qid && q.is_review), "{mode}");
        }
    }

    #[test]
    fn speaking_score_scales_kcal_and_low_scores_go_to_review() {
        let mut c = conn();
        let qid = question_id(&c, "p001"); // a sentence spoken: 5 kcal
        let r = answer(&mut c, qid, "speaking", true, Some(80.0));
        assert_eq!(r.kcal_earned, 4);
        assert!(!r.needs_review);
        let r = answer(&mut c, qid, "speaking", true, Some(65.0));
        assert_eq!(r.kcal_earned, 3, "3.25 rounds down");
        assert!(r.needs_review, "scores under 70 are scheduled for review");
    }

    /// がんばり halves every reward, お気軽 makes it 1.5 times: a word picked pays 0.5 / 1 / 1.5 kcal,
    /// and a fraction waits for the next reward of the day. The mode is the learner's setting.
    #[test]
    fn play_modes_scale_what_every_answer_pays() {
        let mut c = conn();
        assert_eq!(load_user(&c).unwrap().play_mode, "normal");
        assert!(set_play_mode_in(&c, "lazy").is_err());

        set_play_mode_in(&c, "hard").unwrap();
        assert_eq!(load_user(&c).unwrap().play_mode, "hard");
        let id = question_id(&c, "w001");
        let first = answer(&mut c, id, "choice", true, None);
        assert_eq!((first.points, first.kcal_earned, first.today_kcal, first.fraction_pending), (0.5, 0, 0, true));
        let id = question_id(&c, "w002");
        let second = answer(&mut c, id, "choice", true, None);
        assert_eq!((second.points, second.kcal_earned, second.today_kcal, second.fraction_pending), (0.5, 1, 1, false));

        set_play_mode_in(&c, "easy").unwrap();
        let id = question_id(&c, "w003");
        let easy = answer(&mut c, id, "choice", true, None);
        assert_eq!((easy.points, easy.kcal_earned, easy.today_kcal), (1.5, 1, 2));
        let id = question_id(&c, "i002");
        let idiom = answer(&mut c, id, "typing", true, None);
        assert_eq!((idiom.points, idiom.kcal_earned, idiom.today_kcal), (7.5, 8, 10), "0.5 pending + 7.5 = 8");

        set_play_mode_in(&c, "normal").unwrap();
        let id = question_id(&c, "w004");
        let normal = answer(&mut c, id, "choice", true, None);
        assert_eq!((normal.points, normal.kcal_earned, normal.today_kcal), (1.0, 1, 11));
        let id = question_id(&c, "w005");
        let wrong = answer(&mut c, id, "choice", false, None);
        assert_eq!((wrong.points, wrong.kcal_earned), (0.0, 0));
    }

    /// The first word question of the 複合語 tab.
    fn compound_id(c: &Connection) -> i64 {
        c.query_row("SELECT id FROM questions WHERE kind = 'word' AND tier = 'compound' ORDER BY id LIMIT 1", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn a_revealed_hint_zeroes_a_word_and_halves_a_compound_or_an_idiom() {
        let mut c = conn();
        let idiom = question_id(&c, "i001"); // an idiom typed: 5 kcal
        let r = answer_with_hints(&mut c, idiom, "typing", true, None, Some(2));
        assert_eq!(r.kcal_earned, 1, "5 kcal halved twice, 1.25 rounds down");
        assert_eq!(r.today_kcal, 1, "the daily total only counts what was earned");
        let compound = compound_id(&c); // a compound typed: 4 kcal
        assert_eq!(answer_with_hints(&mut c, compound, "typing", true, None, Some(1)).kcal_earned, 2);
        let word = question_id(&c, "w001"); // a word typed: 2 kcal, nothing with a hint
        assert_eq!(answer_with_hints(&mut c, word, "typing", true, None, Some(1)).kcal_earned, 0);
        let word = question_id(&c, "w002");
        assert_eq!(answer_with_hints(&mut c, word, "typing", true, None, Some(0)).kcal_earned, 2);
    }

    /// The points for each kind of question in each mode (1 point = 1 kcal): picked from four, a
    /// word 1 and the rest 2; typed, a word 2, a compound 4, an idiom 5 and a sentence one a word;
    /// heard or spoken, a word 1, a compound 2, an idiom 3 and a grammar, phrase or example
    /// sentence 5. The level a question is marked with does not count.
    #[test]
    fn every_kind_pays_its_points_in_every_mode() {
        let mut c = conn();
        let compound = compound_id(&c);
        let word = question_id(&c, "w010");
        let idiom = question_id(&c, "i002");
        let sentence = question_id(&c, "s031");
        let expression = question_id(&c, "x020"); // Anything you say.
        let grammar = question_id(&c, "g001");
        let dialogue: i64 = c.query_row("SELECT id FROM questions WHERE kind = 'dialogue' LIMIT 1", [], |r| r.get(0)).unwrap();
        for (id, mode, kcal) in [
            (word, "choice", 1),
            (compound, "choice", 2),
            (idiom, "choice", 2),
            (sentence, "choice", 2),
            (grammar, "choice", 2),
            (word, "typing", 2),
            (compound, "typing", 4),
            (idiom, "typing", 5),
            (expression, "typing", 3),
            (word, "listening", 1),
            (compound, "listening", 2),
            (idiom, "listening", 3),
            (sentence, "listening", 5),
            (dialogue, "listening", 5),
            (word, "speaking", 1),
            (compound, "speaking", 2),
            (idiom, "speaking", 3),
            (expression, "speaking", 5),
        ] {
            assert_eq!(answer(&mut c, id, mode, true, Some(100.0)).kcal_earned, kcal, "question {id} by {mode}");
        }
        let long = question_id(&c, "s033");
        let en: String = c.query_row("SELECT en FROM questions WHERE id = ?1", params![long], |r| r.get(0)).unwrap();
        assert_eq!(answer(&mut c, long, "typing", true, None).kcal_earned, srs::answer_word_count(&en));
    }

    #[test]
    fn mid_typing_pays_per_word_and_loses_one_per_revealed_word() {
        let mut c = conn();
        // "Could you say that again?" is five words.
        let qid = question_id(&c, "p003");
        let r = answer_with_hints(&mut c, qid, "typing", true, None, Some(2));
        assert_eq!(r.kcal_earned, 3, "5 words, 2 revealed");

        let full = question_id(&c, "p001"); // "Nice to meet you." — four words
        assert_eq!(answer(&mut c, full, "typing", true, None).kcal_earned, 4);

        // The same kind of phrase picked from four pays the flat choice rate.
        let other = question_id(&c, "p002");
        assert_eq!(answer(&mut c, other, "choice", true, None).kcal_earned, srs::KCAL_CHOICE);

        // A slip in one word costs that word only, and the question still comes back tomorrow.
        let slip = question_id(&c, "p004");
        let words = srs::answer_word_count(&c.query_row("SELECT en FROM questions WHERE id = ?1", params![slip], |r| r.get::<_, String>(0)).unwrap());
        let r = record_answer(
            &mut c,
            &AnswerPayload { question_id: slip, mode: "typing".into(), correct: false, score: None, hints_used: None, mistakes: Some(1) },
        )
        .unwrap();
        assert_eq!(r.kcal_earned, words - 1);
        assert!(r.needs_review);
        // Partial credit is for sentences only: a slip in a word still earns nothing.
        let word = question_id(&c, "w010");
        let r = record_answer(
            &mut c,
            &AnswerPayload { question_id: word, mode: "typing".into(), correct: false, score: None, hints_used: None, mistakes: Some(1) },
        )
        .unwrap();
        assert_eq!(r.kcal_earned, 0);

        // A review pays ×1.5 on what the words earned: (5 − 1) × 1.5 = 6.
        let missed = question_id(&c, "p003");
        answer(&mut c, missed, "typing", false, None);
        c.execute("UPDATE learning_history SET next_due_at = ?1 WHERE question_id = ?2", params![today(), missed]).unwrap();
        let r = answer_with_hints(&mut c, missed, "typing", true, None, Some(1));
        assert!(r.is_review);
        assert_eq!(r.kcal_earned, 6);
    }

    fn day(conn: &Connection, date: &str, earned: i64, consumed: i64) {
        conn.execute(
            "INSERT INTO daily_stats (user_id, date, kcal_earned, kcal_consumed) VALUES (1, ?1, ?2, ?3)",
            params![date, earned, consumed],
        )
        .unwrap();
    }

    fn saved_on(conn: &Connection, date: &str) -> Option<i64> {
        conn.query_row("SELECT saved_kcal FROM daily_stats WHERE date = ?1", params![date], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn a_finished_days_leftover_goes_to_savings_once() {
        let c = conn();
        day(&c, &date_plus(-2), 600, 400); // 200 left over
        day(&c, &date_plus(-1), 100, 300); // ate more than earned: nothing to save
        day(&c, &today(), 500, 0); // today is not over yet

        assert_eq!(settle_savings(&c).unwrap(), (200, 0));
        assert_eq!(saved_on(&c, &date_plus(-2)), Some(200));
        assert_eq!(saved_on(&c, &date_plus(-1)), Some(0));
        assert_eq!(saved_on(&c, &today()), None);
        let d = load_dashboard(&c).unwrap();
        assert_eq!(d.savings.balance, 200);
        assert_eq!((d.savings.just_saved, d.savings.just_issued), (0, 0), "already settled");
        assert_eq!(d.savings.per_ticket, 2000);
        assert_eq!(d.today.kcal_earned, 500, "savings are a separate pot: today's budget is untouched");
    }

    #[test]
    fn every_2000_saved_becomes_a_snack_ticket() {
        let c = conn();
        c.execute("UPDATE users SET savings_kcal = 1900 WHERE id = 1", []).unwrap();
        day(&c, &date_plus(-1), 2350, 100);
        let d = load_dashboard(&c).unwrap();
        assert_eq!((d.savings.just_saved, d.savings.just_issued), (2250, 2));
        assert_eq!(d.savings.balance, 150);
        assert_eq!(d.savings.snack_tickets, 2);
    }

    fn snack_id(conn: &Connection, name: &str) -> i64 {
        conn.query_row("SELECT id FROM snacks WHERE name = ?1", params![name], |r| r.get(0)).unwrap()
    }

    #[test]
    fn several_snacks_can_be_goals_and_eating_one_shows_on_the_dashboard() {
        let c = conn();
        let cake = snack_id(&c, "ショートケーキ");
        let pudding = snack_id(&c, "プリン");
        set_goal(&c, cake, true).unwrap();
        let goals = set_goal(&c, pudding, true).unwrap();
        assert_eq!(goals.iter().map(|s| s.id).collect::<Vec<_>>(), vec![pudding, cake], "cheapest first");
        assert_eq!(set_goal(&c, cake, true).unwrap().len(), 2, "adding twice keeps one entry");

        let d = log_eaten(&c, pudding).unwrap();
        assert_eq!(d.kcal_consumed, 150);
        let dash = load_dashboard(&c).unwrap();
        assert_eq!(dash.eaten_today, vec![pudding]);
        assert_eq!(dash.goal_snacks.len(), 2, "eating a goal does not remove it");

        // Taking it off the goals leaves the snack in the book.
        let goals = set_goal(&c, pudding, false).unwrap();
        assert_eq!(goals.iter().map(|s| s.id).collect::<Vec<_>>(), vec![cake]);
        assert!(load_snack(&c, pudding).unwrap().is_some());
        assert!(set_goal(&c, 999_999, true).is_err(), "no goal for a snack that does not exist");
    }

    /// The book can be sorted by how often each snack is eaten, tickets included.
    #[test]
    fn snacks_count_how_often_they_were_eaten() {
        let c = conn();
        let cookie = snack_id(&c, "クッキー 1枚");
        let pudding = snack_id(&c, "プリン");
        log_eaten(&c, cookie).unwrap();
        log_eaten(&c, cookie).unwrap();
        c.execute("INSERT INTO snack_tickets (user_id, issued_at) VALUES (1, ?1)", params![now_ts()]).unwrap();
        eat_with_ticket_inner(&c, cookie).unwrap();
        log_eaten(&c, pudding).unwrap();
        let count = |id: i64| list_snacks_inner(&c).unwrap().into_iter().find(|s| s.id == id).unwrap().eaten_count;
        assert_eq!(count(cookie), 3);
        assert_eq!(count(pudding), 1);
        assert_eq!(count(snack_id(&c, "大福")), 0);
        set_goal(&c, cookie, true).unwrap();
        assert_eq!(goal_snacks_inner(&c).unwrap()[0].eaten_count, 3);
        assert_eq!(load_snack(&c, pudding).unwrap().unwrap().eaten_count, 1);
    }

    #[test]
    fn a_snack_ticket_pays_for_a_snack_and_comes_back_if_undone() {
        let c = conn();
        let cake: i64 = c.query_row("SELECT id FROM snacks WHERE name = 'ショートケーキ'", [], |r| r.get(0)).unwrap();
        assert!(eat_with_ticket_inner(&c, cake).is_err(), "no ticket yet");

        c.execute("INSERT INTO snack_tickets (user_id, issued_at) VALUES (1, ?1)", params![now_ts()]).unwrap();
        let d = eat_with_ticket_inner(&c, cake).unwrap();
        assert_eq!(d.kcal_consumed, 0, "a ticket costs no kcal");
        assert_eq!(snack_tickets_available(&c).unwrap(), 0);
        let (id, with_ticket): (i64, bool) = c
            .query_row("SELECT id, ticket_id IS NOT NULL FROM consumption_log", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert!(with_ticket);

        // Undoing it gives the ticket back and leaves the day's kcal alone.
        let d = delete_consumption_inner(&c, id).unwrap();
        assert_eq!(d.kcal_consumed, 0);
        assert_eq!(snack_tickets_available(&c).unwrap(), 1);
    }

    #[test]
    fn streak_continues_from_yesterday_and_issues_ticket_on_day_seven() {
        let mut c = conn();
        c.execute(
            "UPDATE users SET current_streak = 6, longest_streak = 6, total_study_days = 6, last_study_date = ?1 WHERE id = 1",
            params![date_plus(-1)],
        )
        .unwrap();
        let qid = question_id(&c, "p001");
        let r = answer(&mut c, qid, "choice", true, None);
        assert_eq!(r.streak, 7);
        assert!(r.new_ticket);
        assert_eq!(tickets_available(&c).unwrap(), 1);
        // A second answer on the same day changes nothing about the streak.
        let r2 = answer(&mut c, qid, "choice", true, None);
        assert_eq!(r2.streak, 7);
        assert!(!r2.new_ticket && !r2.first_study_today);

        let redeemed = redeem_ticket(&c).unwrap();
        assert_eq!(redeemed.kcal_added, srs::CHEAT_DAY_BONUS);
        assert_eq!(redeemed.today_kcal, 2 + 2 + srs::CHEAT_DAY_BONUS);
        assert_eq!(redeemed.tickets_left, 0);
        assert!(redeem_ticket(&c).is_err());
    }

    #[test]
    fn broken_streak_restarts_at_one() {
        let mut c = conn();
        c.execute(
            "UPDATE users SET current_streak = 4, longest_streak = 4, last_study_date = ?1 WHERE id = 1",
            params![date_plus(-3)],
        )
        .unwrap();
        let qid = question_id(&c, "g001");
        let r = answer(&mut c, qid, "choice", true, None);
        assert_eq!(r.streak, 1);
        let u = load_user(&c).unwrap();
        assert_eq!(u.longest_streak, 4);
    }

    #[test]
    fn session_respects_mode_and_tier() {
        let c = conn();
        let s = session_questions(&c, "typing", "idiom", "all", 10).unwrap();
        assert!(!s.is_empty());
        assert!(s.iter().all(|q| q.question.tier == "idiom" && q.question.modes.iter().any(|m| m == "typing")));
        let g = session_questions(&c, "choice", "grammar", "all", 50).unwrap();
        assert!(g.iter().all(|q| q.question.tier == "grammar"));
        assert!(g.iter().any(|q| q.question.kind == "grammar"), "grammar questions appear in choice mode");
        assert!(g.iter().filter(|q| q.question.kind == "grammar").all(|q| q.options.len() == 4 && q.options.contains(&q.answer)));
        let p = session_questions(&c, "choice", "phrase", "all", 50).unwrap();
        assert!(p.iter().all(|q| q.question.tier == "phrase"));
        assert!(p.iter().any(|q| q.question.kind == "expression"), "the phrases to learn by heart are in the phrase tab");
        let e = session_questions(&c, "typing", "example", "all", 50).unwrap();
        assert!(e.iter().all(|q| q.question.tier == "example" && matches!(q.question.kind.as_str(), "phrase" | "sentence")));
    }

    /// 英単語 holds the one-word words and can be narrowed to a part of speech; 複合語 holds the
    /// words of several words.
    #[test]
    fn words_split_into_single_words_and_compounds_and_by_part_of_speech() {
        let c = conn();
        let words = session_questions(&c, "choice", "word", "all", 50).unwrap();
        // A phrasal verb (get up) goes with the single words.
        assert!(words.iter().all(|q| q.question.kind == "word"
            && (!q.question.en.contains([' ', '-']) || db::word_pos().get(&q.question.key).map(String::as_str) == Some("verb"))));
        let compounds = session_questions(&c, "choice", "compound", "all", 50).unwrap();
        assert!(!compounds.is_empty());
        assert!(compounds.iter().all(|q| q.question.kind == "word"
            && q.question.en.contains([' ', '-'])
            && db::word_pos().get(&q.question.key).map(String::as_str) != Some("verb")));
        for pos in db::PARTS_OF_SPEECH {
            let s = session_questions(&c, "choice", "word", &format!("pos:{pos}"), 50).unwrap();
            assert!(!s.is_empty(), "no {pos} session");
            assert!(s.iter().all(|q| db::word_pos().get(&q.question.key).map(String::as_str) == Some(pos)), "{pos}");
        }
        let counts = parts_of_speech(&c).unwrap();
        assert_eq!(counts.iter().map(|p| p.pos.as_str()).collect::<Vec<_>>(), db::PARTS_OF_SPEECH);
        let singles: i64 = c.query_row("SELECT COUNT(*) FROM questions WHERE tier = 'word'", [], |r| r.get(0)).unwrap();
        assert_eq!(counts.iter().map(|p| p.total).sum::<i64>(), singles, "every word counts under one part of speech");
    }

    fn question_by_key(c: &Connection, key: &str) -> Question {
        let qid = question_id(c, key);
        c.query_row(&format!("SELECT {Q_COLS} FROM questions q WHERE q.id = ?1"), params![qid], db::row_to_question)
            .unwrap()
    }

    /// Meaning (Japanese) → the parts of speech of the word questions that have it.
    fn pos_of_meanings(c: &Connection) -> HashMap<String, Vec<String>> {
        let mut stmt = c.prepare("SELECT ja, pos FROM questions WHERE kind = 'word'").unwrap();
        let rows: Vec<(String, String)> =
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<Result<_, _>>().unwrap();
        let mut out: HashMap<String, Vec<String>> = HashMap::new();
        for (ja, pos) in rows {
            out.entry(ja).or_default().push(pos);
        }
        out
    }

    /// The wrong meanings alone, without their English.
    fn distractor_meanings(c: &Connection, q: &Question) -> Vec<String> {
        japanese_distractors(c, q).unwrap().into_iter().map(|(ja, _)| ja).collect()
    }

    #[test]
    fn distractors_come_from_the_same_semantic_group() {
        let c = conn();
        let q = question_by_key(&c, "w072"); // salt / 塩, group 調味料
        assert_eq!(q.group, "調味料");
        let group_meanings: Vec<String> = {
            let mut stmt = c.prepare("SELECT ja FROM questions WHERE word_group = ?1").unwrap();
            stmt.query_map(params![q.group], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
        };
        let meanings = pos_of_meanings(&c);
        // Repeat: the picks are random. A word spelt like salt may come in, the rest are seasonings.
        for _ in 0..20 {
            let opts = distractor_meanings(&c, &q);
            assert_eq!(opts.len(), 3);
            assert!(opts.iter().filter(|o| group_meanings.contains(o)).count() >= 2, "{opts:?}");
            for o in &opts {
                assert!(meanings[o].iter().any(|p| p == "noun"), "'{o}' is not a noun's meaning");
                assert_ne!(o, &q.ja);
            }
        }
    }

    /// win (勝つ) was once asked against 野球 / ハイキング / サーフィン: a verb among nouns answers
    /// itself. Its options are verbs, and lose, the word it is confused with, is among them.
    #[test]
    fn a_verb_is_asked_against_verbs_and_the_word_it_is_confused_with() {
        let c = conn();
        let meanings = pos_of_meanings(&c);
        let win = c
            .query_row("SELECT key FROM questions WHERE kind = 'word' AND en = 'win'", [], |r| r.get::<_, String>(0))
            .unwrap();
        let q = question_by_key(&c, &win);
        let lose: String =
            c.query_row("SELECT ja FROM questions WHERE kind = 'word' AND en = 'lose'", [], |r| r.get(0)).unwrap();
        for _ in 0..10 {
            let opts = distractor_meanings(&c, &q);
            assert_eq!(opts.len(), 3);
            assert!(opts.contains(&lose), "{opts:?}");
            for o in &opts {
                assert!(meanings[o].iter().any(|p| p == "verb"), "'{o}' is not a verb's meaning ({opts:?})");
            }
        }
    }

    /// Every word question, whatever its part of speech, is asked against three meanings of words of
    /// that part of speech, none of which shares a sense with the answer or with another option.
    #[test]
    fn word_options_keep_to_the_part_of_speech() {
        let c = conn();
        let meanings = pos_of_meanings(&c);
        let mut stmt = c.prepare("SELECT key, pos FROM questions WHERE kind = 'word' ORDER BY id").unwrap();
        let keys: Vec<(String, String)> =
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<Result<_, _>>().unwrap();
        let mut bad = Vec::new();
        // Every verb, adjective and adverb, and a spread of the nouns (there are thousands).
        for (i, (key, pos)) in keys.iter().enumerate() {
            if pos == "noun" && i % 9 != 0 {
                continue;
            }
            let q = question_by_key(&c, key);
            let opts = distractor_meanings(&c, &q);
            let wrong_pos = opts.iter().any(|o| !meanings.get(o).is_some_and(|ps| ps.contains(pos)));
            let clash = opts.iter().any(|o| share_a_sense(o, &q.ja))
                || opts.iter().enumerate().any(|(i, a)| opts[i + 1..].iter().any(|b| share_a_sense(a, b)));
            if opts.len() != 3 || wrong_pos || clash {
                bad.push(format!("{} {} ({pos}): {opts:?}", q.en, q.ja));
            }
        }
        assert!(bad.is_empty(), "{} word questions with bad options:\n{}", bad.len(), bad.join("\n"));
    }

    /// Prints the options of a few words, to look over by eye:
    /// `cargo test show_word_options -- --ignored --nocapture`, or WORDS="win,happy" for others.
    #[test]
    #[ignore]
    fn show_word_options() {
        let c = conn();
        let words = std::env::var("WORDS").unwrap_or_else(|_| "win,salt,happy,quickly,house,buy,angry,bored,run".into());
        for w in words.split(',') {
            let keys: Vec<String> = {
                let mut stmt = c.prepare("SELECT key FROM questions WHERE kind = 'word' AND en = ?1").unwrap();
                stmt.query_map(params![w.trim()], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
            };
            for key in keys {
                let q = question_by_key(&c, &key);
                for _ in 0..3 {
                    println!("{} {} [{}] → {:?}", q.en, q.ja, q.group, distractor_meanings(&c, &q));
                }
            }
        }
    }

    #[test]
    fn listening_hides_the_text_and_plays_audio() {
        let c = conn();
        let s = session_questions(&c, "listening", "mixed", "all", 20).unwrap();
        assert!(!s.is_empty());
        for q in &s {
            assert!(q.hide_text, "{} should hide its text", q.question.key);
            assert!(!q.audio_text.trim().is_empty(), "{} has nothing to play", q.question.key);
            assert!(!q.audio_text.contains("___"), "{} still has a blank", q.question.key);
            assert_eq!(q.options.len(), 4, "{} needs 4 options", q.question.key);
            assert!(q.options.contains(&q.answer));
            assert_eq!(q.options.iter().collect::<std::collections::HashSet<_>>().len(), 4);
            assert!(q.display.is_empty(), "{} must not reveal the text", q.question.key);
        }
    }

    #[test]
    fn listening_includes_dialogue_questions_with_english_replies() {
        let c = conn();
        // Dialogues are mid/high; draw enough to be sure at least one shows up.
        let mut seen = false;
        for _ in 0..10 {
            let s = session_questions(&c, "listening", "phrase", "日常生活", 20).unwrap();
            if let Some(d) = s.iter().find(|q| q.question.kind == "dialogue") {
                seen = true;
                assert_eq!(d.audio_text, d.question.prompt.clone().unwrap());
                assert_eq!(d.answer, d.question.en);
                assert!(d.options.iter().all(|o| o.is_ascii()), "replies should be English");
                break;
            }
        }
        assert!(seen, "no dialogue question was ever served in listening mode");
    }

    #[test]
    fn typing_accepts_every_sibling_rendering_of_the_same_japanese() {
        let c = conn();
        // The learner types from the Japanese alone, so if the bank teaches two English renderings
        // of one meaning in one group, both have to count. Otherwise a correct answer is marked
        // wrong purely because the session happened to draw the other key.
        let mut stmt = c
            .prepare(
                "SELECT a.id FROM questions a JOIN questions b \
                 ON a.id != b.id AND a.kind = b.kind AND a.word_group = b.word_group \
                 AND a.ja = b.ja AND a.en != b.en \
                 WHERE a.modes LIKE '%typing%' LIMIT 1",
            )
            .unwrap();
        let shared: Option<i64> = stmt.query_row([], |r| r.get(0)).optional().unwrap();
        let Some(id) = shared else {
            return; // No shared translations in the bank: nothing to protect.
        };

        let q = c
            .query_row(&format!("SELECT {Q_COLS} FROM questions q WHERE q.id = ?1"), params![id], db::row_to_question)
            .unwrap();
        let accepted = accepted_answers(&c, &q).unwrap();
        assert!(accepted.contains(&q.en), "{} must accept its own English", q.key);
        assert!(
            accepted.len() > 1,
            "{} shares its Japanese '{}' with another question but accepts only '{}'",
            q.key,
            q.ja,
            q.en
        );

        // And the session hands that list to the frontend, which is what does the grading.
        let sq = build_session_question(&c, q, "typing", false).unwrap();
        assert_eq!(sq.accepted, accepted, "typing must expose the accepted answers");
    }

    #[test]
    fn typing_forgives_a_plural_the_japanese_could_not_have_signalled() {
        let c = conn();
        let load = |key: &str| {
            c.query_row(
                &format!("SELECT {Q_COLS} FROM questions q WHERE q.key = ?1"),
                params![key],
                db::row_to_question,
            )
            .unwrap()
        };

        // "彼は毎朝、馬たちに水を運びました" now says plural, but nothing stops a learner reading
        // it as one horse, and "the horse" is the same English sentence.
        let q = load("p2506");
        let accepted = accepted_answers(&c, &q).unwrap();
        assert!(accepted.contains(&q.en), "{} must accept its own English", q.key);
        assert!(
            accepted.iter().any(|a| a.contains("to the horse ")),
            "{} should also accept the singular, got {accepted:?}",
            q.key
        );
        let sq = build_session_question(&c, q, "typing", false).unwrap();
        assert!(sq.accepted.len() > 1, "the session must hand the frontend both readings");

        // And the other way round: "私たちはトカゲが…日光浴するのを見ました" is just as silent
        // about number, and after "watched" the bare infinitive agrees with nothing.
        let q = load("p4527");
        let accepted = accepted_answers(&c, &q).unwrap();
        assert!(
            accepted.iter().any(|a| a.contains("the lizards bask")),
            "{} should also accept the plural, got {accepted:?}",
            q.key
        );

        // An idiom is a fixed wording: "hit the book" is not English.
        let idiom: Vec<String> = c
            .prepare("SELECT en FROM questions WHERE kind = 'idiom' AND en LIKE 'hit the books%'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for en in idiom {
            let q = c
                .query_row(
                    &format!("SELECT {Q_COLS} FROM questions q WHERE q.en = ?1"),
                    params![en],
                    db::row_to_question,
                )
                .unwrap();
            assert_eq!(accepted_answers(&c, &q).unwrap().len(), 1, "{} must stay exact", q.key);
        }

        // Whatever is forgiven is still the same sentence, one word shorter in letters only.
        let mut stmt = c
            .prepare("SELECT kind, en FROM questions WHERE modes LIKE '%typing%'")
            .unwrap();
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        // Over-pluralising an uncountable noun is the mistake this must never wave through.
        let mass = [
            "informations", "advices", "furnitures", "homeworks", "musics", "datas", "paperworks",
            "breads", "luggages", "equipments", "weathers", "traffics", "moneys", "knowledges",
            "evidences", "softwares", "researches", "progresses",
        ];
        let mut total = 0;
        for (kind, en) in &rows {
            if kind == "idiom" {
                continue; // accepted_answers never asks for their variants
            }
            for v in util::number_variants(en, db::is_known_word, db::is_countable_noun) {
                total += 1;
                assert_eq!(
                    v.split_whitespace().count(),
                    en.split_whitespace().count(),
                    "a variant must keep the sentence intact: {en} -> {v}"
                );
                assert_ne!(&v, en, "a variant must actually differ: {en}");
                let lower = v.to_lowercase();
                for bad in mass {
                    assert!(!lower.contains(bad), "{en} -> {v} invents an uncountable plural");
                }
            }
        }
        assert!(total > 1000, "only {total} readings were forgiven; the rule stopped matching");
    }

    #[test]
    fn every_grammar_question_is_served_with_its_explanation() {
        let c = conn();
        let mut stmt = c
            .prepare(&format!("SELECT {Q_COLS} FROM questions q WHERE q.kind = 'grammar'"))
            .unwrap();
        let all: Vec<Question> = stmt
            .query_map([], db::row_to_question)
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(!all.is_empty(), "no grammar questions were seeded");

        // Sampled rather than exhaustive: building every session question runs distractor queries.
        for q in all.iter().step_by(37) {
            let key = q.key.clone();
            let sq = build_session_question(&c, q.clone(), "choice", false).unwrap();
            let note = sq
                .grammar_note
                .unwrap_or_else(|| panic!("{key} was served without an explanation"));
            assert!(!note.title.trim().is_empty(), "{key} got a note with no title");
            assert!(!note.body.trim().is_empty(), "{key} got a note with no body");
        }

        // Other kinds have nothing to explain, so the panel stays off for them.
        let word = c
            .query_row(
                &format!("SELECT {Q_COLS} FROM questions q WHERE q.kind = 'word' LIMIT 1"),
                [],
                db::row_to_question,
            )
            .unwrap();
        let sq = build_session_question(&c, word, "choice", false).unwrap();
        assert!(sq.grammar_note.is_none(), "only grammar questions carry an explanation");
    }

    /// Once answered, each Japanese option shows the English it translates: staycation's 持ち寄り夕食会
    /// is a potluck. Every option's English is a question of the bank with that very meaning, and
    /// the answer's is the question's own. Options already in English carry none.
    #[test]
    fn japanese_options_carry_their_english() {
        let c = conn();
        let mut stmt = c.prepare("SELECT 1 FROM questions WHERE en = ?1 AND ja = ?2").unwrap();
        let mut checked = 0;
        for mode in ["choice", "listening"] {
            for tier in ["word", "compound", "idiom", "phrase", "example", "grammar"] {
                for sq in session_questions(&c, mode, tier, "all", 15).unwrap() {
                    if sq.question.choices.is_some() || sq.question.kind == "dialogue" {
                        assert!(sq.option_en.is_empty(), "{} has English options", sq.question.key);
                        continue;
                    }
                    assert_eq!(sq.option_en.len(), sq.options.len(), "{}", sq.question.key);
                    for (ja, en) in sq.options.iter().zip(&sq.option_en) {
                        if *ja == sq.answer {
                            assert_eq!(en, &sq.question.en, "{}", sq.question.key);
                        }
                        assert!(stmt.exists(params![en, ja]).unwrap(), "{}: {ja} is not {en}", sq.question.key);
                    }
                    checked += 1;
                }
            }
        }
        assert!(checked >= 50, "only {checked} questions with Japanese options were served");
    }

    #[test]
    fn dialogue_replies_are_borrowed_from_other_dialogues() {
        let c = conn();
        // The replies written into the data all follow a handful of templates ("He plays chess."),
        // so the odd one out was the answer and the learner never had to listen. Options must be
        // borrowed from sibling dialogues instead.
        let mut checked = 0;
        for _ in 0..20 {
            let s = session_questions(&c, "listening", "phrase", "食べ物", 20).unwrap();
            for d in s.iter().filter(|q| q.question.kind == "dialogue") {
                assert_eq!(d.options.len(), 4, "{} should offer four replies", d.question.key);
                assert!(d.options.contains(&d.question.en), "{} lost its answer", d.question.key);
                let baked = d.question.choices.clone().unwrap_or_default();
                let borrowed = d.options.iter().filter(|o| **o != d.question.en && !baked.contains(o)).count();
                assert!(borrowed > 0, "{} still serves only its written replies: {:?}", d.question.key, d.options);
                checked += 1;
            }
            if checked >= 5 {
                break;
            }
        }
        assert!(checked >= 5, "not enough dialogue questions were served to check");
    }

    #[test]
    fn grammar_audio_fills_in_the_blank() {
        let c = conn();
        let qid = question_id(&c, "g001");
        let q = c
            .query_row(&format!("SELECT {Q_COLS} FROM questions q WHERE q.id = ?1"), params![qid], db::row_to_question)
            .unwrap();
        assert_eq!(audio_text_for(&q), "She plays tennis every Sunday.");

        // Choosing "no article" leaves the gap empty rather than reading out the choice's label.
        let qid = question_id(&c, "g1188");
        let q = c
            .query_row(&format!("SELECT {Q_COLS} FROM questions q WHERE q.id = ?1"), params![qid], db::row_to_question)
            .unwrap();
        assert_eq!(q.en, util::NO_WORD);
        assert_eq!(audio_text_for(&q), "She goes to school by bus every day.");
        assert_eq!(util::fill_blank("___ is the best policy.", util::NO_WORD), "is the best policy.");
    }

    #[test]
    fn session_filters_by_category_and_uses_genre_distractors() {
        let c = conn();
        let food = session_questions(&c, "choice", "word", "食べ物", 20).unwrap();
        assert!(!food.is_empty());
        assert!(food.iter().all(|q| q.question.category == "食べ物"));
        for q in &food {
            assert_eq!(q.options.len(), 4);
            assert!(q.options.contains(&q.answer));
            let unique: std::collections::HashSet<&String> = q.options.iter().collect();
            assert_eq!(unique.len(), 4, "options must be distinct: {:?}", q.options);
        }
        // Every seeded question has a genre, and the dashboard summary covers all of them.
        let missing: i64 = c.query_row("SELECT COUNT(*) FROM questions WHERE category = ''", [], |r| r.get(0)).unwrap();
        assert_eq!(missing, 0);
        let cats = category_infos(&c).unwrap();
        let total: i64 = cats.iter().map(|x| x.total).sum();
        let all: i64 = c.query_row("SELECT COUNT(*) FROM questions", [], |r| r.get(0)).unwrap();
        assert_eq!(total, all);
        assert!(cats.iter().any(|x| x.name == "文法" && x.grammar > 0));
        for c in &cats {
            assert_eq!(
                c.total,
                c.word + c.compound + c.grammar + c.idiom + c.phrase + c.example,
                "{} counts every tab",
                c.name
            );
        }
        assert!(cats.iter().any(|x| x.name == "あいさつ・あいづち" && x.phrase > 0));
    }

    #[test]
    fn notes_show_irregular_verbs_and_words_easily_confused() {
        let c = conn();
        let first = |filter: &str| -> Question {
            c.query_row(&format!("SELECT {Q_COLS} FROM questions q WHERE {filter} LIMIT 1"), [], db::row_to_question)
                .unwrap_or_else(|_| panic!("no question where {filter}"))
        };
        // A word question that is an irregular verb has its forms.
        let buy = first("q.kind = 'word' AND q.en = 'buy'");
        let notes = notes_for(&buy, &audio_text_for(&buy)).unwrap();
        assert_eq!(notes.irregular.iter().map(|v| v.past.as_str()).collect::<Vec<_>>(), vec!["bought"]);
        // A sentence: the forms of the verbs it uses, and lend with 類似表現 and the pattern it may
        // be using though no pattern of it is found.
        let lend = first("q.en = 'Could you lend me your textbook?'");
        let notes = notes_for(&lend, &audio_text_for(&lend)).unwrap();
        assert_eq!(notes.irregular.iter().map(|v| v.base.as_str()).collect::<Vec<_>>(), vec!["lend"]);
        let used = notes.used.iter().find(|w| w.word == "lend").expect("lend is easily confused with borrow");
        assert!(!used.related.is_empty());
        assert!(used.usages.iter().any(|u| u.pattern.starts_with("lend 人")), "{:?}", used.usages);
    }

    #[test]
    fn a_first_snack_can_be_corrected_or_taken_out() {
        let c = conn();
        let pudding = snack_id(&c, "プリン");
        set_goal(&c, pudding, true).unwrap();
        let s = update_snack_in(&c, pudding, " コンビニのプリン ", 230, "🍮").unwrap();
        assert_eq!((s.name.as_str(), s.calories), ("コンビニのプリン", 230));
        assert!(s.is_builtin, "still one of the first snacks");
        assert_eq!(load_dashboard(&c).unwrap().goal_snacks[0].calories, 230, "the goal follows it");
        assert!(update_snack_in(&c, pudding, "", 230, "🍮").is_err());
        assert!(update_snack_in(&c, pudding, "プリン", 0, "🍮").is_err());
        delete_snack_in(&c, pudding).unwrap();
        assert!(load_snack(&c, pudding).unwrap().is_none());
        assert!(load_dashboard(&c).unwrap().goal_snacks.is_empty(), "and leaves the goals");
    }
}
