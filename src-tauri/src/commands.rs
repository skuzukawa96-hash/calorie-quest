use crate::db::{self, Q_COLS};
use crate::models::*;
use crate::srs;
use crate::util::{self, date_plus, now_ts, shuffle, today};
use crate::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use tauri::State;

type CmdResult<T> = Result<T, String>;
const USER_ID: i64 = 1;
/// Study modes the frontend may ask for; anything else is rejected before it reaches SQL.
pub const MODES: [&str; 4] = ["choice", "typing", "speaking", "listening"];

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/* ---------- shared queries ---------- */

fn load_user(conn: &Connection) -> rusqlite::Result<UserInfo> {
    conn.query_row(
        "SELECT id, name, total_study_days, current_streak, longest_streak, last_study_date, goal_snack_id
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
                goal_snack_id: r.get(6)?,
            })
        },
    )
}

fn load_daily(conn: &Connection, date: &str) -> rusqlite::Result<DailyStats> {
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

fn load_snack(conn: &Connection, id: i64) -> rusqlite::Result<Option<Snack>> {
    conn.query_row(
        "SELECT id, name, calories, icon, is_builtin FROM snacks WHERE id = ?1",
        params![id],
        db::row_to_snack,
    )
    .optional()
}

fn list_snacks_inner(conn: &Connection) -> rusqlite::Result<Vec<Snack>> {
    let mut stmt =
        conn.prepare("SELECT id, name, calories, icon, is_builtin FROM snacks ORDER BY calories ASC, id ASC")?;
    let rows = stmt.query_map([], db::row_to_snack)?;
    rows.collect()
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

/// Question counts per genre, in the order genres first appear in the seed data.
fn category_infos(conn: &Connection) -> rusqlite::Result<Vec<CategoryInfo>> {
    let mut stmt = conn.prepare(
        "SELECT category, difficulty, COUNT(*), MIN(id) FROM questions WHERE category != '' GROUP BY category, difficulty",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))
    })?;
    let mut out: Vec<(i64, CategoryInfo)> = Vec::new();
    for row in rows {
        let (name, difficulty, n, min_id) = row?;
        let idx = match out.iter().position(|(_, c)| c.name == name) {
            Some(i) => i,
            None => {
                out.push((min_id, CategoryInfo { name, total: 0, low: 0, mid: 0, high: 0 }));
                out.len() - 1
            }
        };
        let entry = &mut out[idx];
        entry.0 = entry.0.min(min_id);
        entry.1.total += n;
        match difficulty.as_str() {
            "low" => entry.1.low += n,
            "mid" => entry.1.mid += n,
            "high" => entry.1.high += n,
            _ => {}
        }
    }
    out.sort_by_key(|(first_id, _)| *first_id);
    Ok(out.into_iter().map(|(_, c)| c).collect())
}

fn kcal_rates() -> KcalRates {
    KcalRates {
        low: srs::KCAL_LOW,
        mid: srs::KCAL_MID,
        high: srs::KCAL_HIGH,
        review_multiplier: srs::REVIEW_MULTIPLIER,
        cheat_day_bonus: srs::CHEAT_DAY_BONUS,
    }
}

/* ---------- core logic (testable without Tauri) ---------- */

/// Three plausible wrong translations, taken from the tightest semantic circle that has enough
/// members: same fine-grained group → same genre → same kind → anything. Picking from the same
/// group is what makes the quiz worth doing: for "salt" the alternatives are other seasonings,
/// not a random animal.
fn japanese_distractors(conn: &Connection, q: &Question) -> rusqlite::Result<Vec<String>> {
    let mut opts: Vec<String> = Vec::new();

    let mut fill = |sql: &str, field: &str| -> rusqlite::Result<()> {
        if opts.len() >= 3 {
            return Ok(());
        }
        let mut stmt = conn.prepare(sql)?;
        let found: Vec<String> = stmt
            .query_map(params![q.id, q.kind, field, q.ja], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        extend_unique(&mut opts, found, &q.ja);
        Ok(())
    };

    fill(
        "SELECT ja FROM questions WHERE id != ?1 AND kind = ?2 AND word_group = ?3 AND ja != ?4 ORDER BY RANDOM() LIMIT 8",
        &q.group,
    )?;
    fill(
        "SELECT ja FROM questions WHERE id != ?1 AND kind = ?2 AND category = ?3 AND ja != ?4 ORDER BY RANDOM() LIMIT 8",
        &q.category,
    )?;
    fill(
        "SELECT ja FROM questions WHERE id != ?1 AND kind = ?2 AND ?3 IS NOT NULL AND ja != ?4 ORDER BY RANDOM() LIMIT 8",
        &q.category,
    )?;

    if opts.len() < 3 {
        let mut stmt = conn.prepare("SELECT ja FROM questions WHERE id != ?1 AND ja != ?2 ORDER BY RANDOM() LIMIT 8")?;
        let any: Vec<String> = stmt
            .query_map(params![q.id, q.ja], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        extend_unique(&mut opts, any, &q.ja);
    }
    Ok(opts)
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

fn build_session_question(
    conn: &Connection,
    q: Question,
    mode: &str,
    is_review: bool,
) -> rusqlite::Result<SessionQuestion> {
    let audio_text = audio_text_for(&q);
    let mut hide_text = false;
    let (display, sub_display, options, answer) = match mode {
        "choice" => {
            if let Some(ch) = q.choices.clone() {
                // Grammar-style question: the prompt has a blank, choices are given.
                let mut opts = ch;
                shuffle(&mut opts);
                (
                    q.prompt.clone().unwrap_or_else(|| q.en.clone()),
                    Some(q.ja.clone()),
                    opts,
                    q.en.clone(),
                )
            } else {
                let mut opts = japanese_distractors(conn, &q)?;
                opts.push(q.ja.clone());
                shuffle(&mut opts);
                (q.en.clone(), None, opts, q.ja.clone())
            }
        }
        "typing" => (q.ja.clone(), q.prompt.clone(), Vec::new(), q.en.clone()),
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
                (String::new(), Some(q.ja.clone()), opts, q.en.clone())
            } else {
                // Heard: the English. Answer: what it means, in Japanese.
                let mut opts = japanese_distractors(conn, &q)?;
                opts.push(q.ja.clone());
                shuffle(&mut opts);
                (String::new(), None, opts, q.ja.clone())
            }
        }
        _ => (q.en.clone(), Some(q.ja.clone()), Vec::new(), q.en.clone()),
    };
    // Only typing is graded by comparing free text; everywhere else the learner picks an option.
    let accepted = if mode == "typing" {
        accepted_answers(conn, &q)?
    } else {
        vec![answer.clone()]
    };
    let grammar_note = grammar_note_for(&q);
    Ok(SessionQuestion {
        question: q,
        mode: mode.to_string(),
        is_review,
        display,
        sub_display,
        options,
        answer,
        accepted,
        audio_text,
        hide_text,
        grammar_note,
    })
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

/// Due reviews first (at most 60% of the session), then unseen/fresh questions; shuffled.
/// `category` is a genre name or "all".
pub fn session_questions(
    conn: &Connection,
    mode: &str,
    difficulty: &str,
    category: &str,
    count: u32,
) -> rusqlite::Result<Vec<SessionQuestion>> {
    let count = count.clamp(1, 50) as i64;
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
           AND {mode_clause} AND (?4 = 'mixed' OR q.difficulty = ?4) AND (?5 = 'all' OR q.category = ?5)
         ORDER BY h.next_due_at ASC, RANDOM() LIMIT ?6"
    );
    let reviews: Vec<Question> = {
        let mut stmt = conn.prepare(&review_sql)?;
        let rows = stmt.query_map(
            params![USER_ID, today, mode_like, difficulty, category, max_reviews],
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
         WHERE {fresh_mode_clause} AND (?3 = 'mixed' OR q.difficulty = ?3) AND (?4 = 'all' OR q.category = ?4)
           AND (h.needs_review IS NULL OR h.needs_review = 0) {exclude_clause}
         ORDER BY (h.last_studied_at IS NOT NULL), RANDOM() LIMIT ?5"
    );
    let fresh: Vec<Question> = {
        let mut stmt = conn.prepare(&fresh_sql)?;
        let rows = stmt.query_map(
            params![USER_ID, mode_like, difficulty, category, remaining],
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

/// Records one answer: kcal reward, SRS schedule, daily stats, streak and cheat-day tickets.
pub fn record_answer(conn: &mut Connection, payload: &AnswerPayload) -> Result<AnswerResult, String> {
    let tx = conn.transaction().map_err(err)?;
    let today = today();
    let now = now_ts();

    let difficulty: String = tx
        .query_row(
            "SELECT difficulty FROM questions WHERE id = ?1",
            params![payload.question_id],
            |r| r.get(0),
        )
        .map_err(|_| format!("question {} not found", payload.question_id))?;

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
    let mut kcal = srs::kcal_for(&difficulty, &payload.mode, payload.correct, payload.score);
    if is_due_review && payload.correct {
        kcal = srs::apply_review_bonus(kcal);
    }
    kcal = srs::apply_hint_penalty(kcal, payload.hints_used.unwrap_or(0));
    let (new_level, new_needs_review, new_next_due) =
        srs::next_state(level, in_review, payload.correct, low_score);

    tx.execute(
        "INSERT INTO learning_history
           (user_id, question_id, correct_count, wrong_count, last_correct, last_score, srs_level, needs_review, last_studied_at, next_due_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(user_id, question_id) DO UPDATE SET
           correct_count = correct_count + excluded.correct_count,
           wrong_count = wrong_count + excluded.wrong_count,
           last_correct = excluded.last_correct,
           last_score = excluded.last_score,
           srs_level = excluded.srs_level,
           needs_review = excluded.needs_review,
           last_studied_at = excluded.last_studied_at,
           next_due_at = excluded.next_due_at",
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
            new_next_due
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

    tx.execute(
        "INSERT INTO daily_stats (user_id, date, kcal_earned, answered, correct) VALUES (?1, ?2, ?3, 1, ?4)
         ON CONFLICT(user_id, date) DO UPDATE SET
           kcal_earned = kcal_earned + excluded.kcal_earned,
           answered = answered + 1,
           correct = correct + excluded.correct",
        params![USER_ID, today, kcal, payload.correct as i64],
    )
    .map_err(err)?;

    // Streak bookkeeping happens once per calendar day.
    let user = load_user(&tx).map_err(err)?;
    let mut streak = user.current_streak;
    let mut first_study_today = false;
    let mut new_ticket = false;
    if user.last_study_date.as_deref() != Some(today.as_str()) {
        first_study_today = true;
        streak = if user.last_study_date.as_deref() == Some(date_plus(-1).as_str()) {
            user.current_streak + 1
        } else {
            1
        };
        let longest = user.longest_streak.max(streak);
        tx.execute(
            "UPDATE users SET current_streak = ?1, longest_streak = ?2, total_study_days = total_study_days + 1, last_study_date = ?3 WHERE id = ?4",
            params![streak, longest, today, USER_ID],
        )
        .map_err(err)?;
        if streak % 7 == 0 {
            tx.execute(
                "INSERT INTO cheat_tickets (user_id, issued_at, issued_for_streak) VALUES (?1, ?2, ?3)",
                params![USER_ID, now, streak],
            )
            .map_err(err)?;
            new_ticket = true;
        }
    }

    let today_stats = load_daily(&tx, &today).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(AnswerResult {
        kcal_earned: kcal,
        today_kcal: today_stats.kcal_earned,
        streak,
        new_ticket,
        first_study_today,
        is_review: is_due_review,
        needs_review: new_needs_review,
        next_due: new_next_due,
    })
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
    conn.execute(
        "INSERT INTO daily_stats (user_id, date, kcal_earned) VALUES (?1, ?2, ?3)
         ON CONFLICT(user_id, date) DO UPDATE SET kcal_earned = kcal_earned + excluded.kcal_earned",
        params![USER_ID, today, srs::CHEAT_DAY_BONUS],
    )
    .map_err(err)?;
    let stats = load_daily(conn, &today).map_err(err)?;
    Ok(RedeemResult {
        kcal_added: srs::CHEAT_DAY_BONUS,
        today_kcal: stats.kcal_earned,
        tickets_left: tickets_available(conn).map_err(err)?,
    })
}

/* ---------- Tauri commands ---------- */

#[tauri::command]
pub fn get_dashboard(state: State<'_, AppState>) -> CmdResult<Dashboard> {
    let conn = state.db.lock().map_err(err)?;
    let user = load_user(&conn).map_err(err)?;
    let today_stats = load_daily(&conn, &today()).map_err(err)?;
    let goal_snack = match user.goal_snack_id {
        Some(id) => load_snack(&conn, id).map_err(err)?,
        None => None,
    };
    Ok(Dashboard {
        today: today_stats,
        goal_snack,
        snacks: list_snacks_inner(&conn).map_err(err)?,
        categories: category_infos(&conn).map_err(err)?,
        due_review_count: due_review_count(&conn).map_err(err)?,
        tickets_available: tickets_available(&conn).map_err(err)?,
        kcal_rates: kcal_rates(),
        user,
    })
}

#[tauri::command]
pub fn get_session_questions(
    state: State<'_, AppState>,
    mode: String,
    difficulty: String,
    category: Option<String>,
    count: u32,
) -> CmdResult<Vec<SessionQuestion>> {
    if !MODES.contains(&mode.as_str()) {
        return Err(format!("unknown mode {mode}"));
    }
    let conn = state.db.lock().map_err(err)?;
    let category = category.filter(|c| !c.trim().is_empty()).unwrap_or_else(|| "all".to_string());
    session_questions(&conn, &mode, &difficulty, &category, count).map_err(err)
}

/// English word (lowercase) → Japanese gloss, for the hover dictionary in the study screen.
#[tauri::command]
pub fn get_dictionary(state: State<'_, AppState>) -> CmdResult<HashMap<String, String>> {
    let conn = state.db.lock().map_err(err)?;
    db::dictionary(&conn).map_err(err)
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

#[tauri::command]
pub fn delete_snack(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let conn = state.db.lock().map_err(err)?;
    conn.execute(
        "UPDATE users SET goal_snack_id = NULL WHERE id = ?1 AND goal_snack_id = ?2",
        params![USER_ID, id],
    )
    .map_err(err)?;
    conn.execute("DELETE FROM snacks WHERE id = ?1", params![id]).map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn set_goal_snack(state: State<'_, AppState>, id: Option<i64>) -> CmdResult<Option<Snack>> {
    let conn = state.db.lock().map_err(err)?;
    conn.execute("UPDATE users SET goal_snack_id = ?1 WHERE id = ?2", params![id, USER_ID])
        .map_err(err)?;
    match id {
        Some(id) => load_snack(&conn, id).map_err(err),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn log_snack_eaten(state: State<'_, AppState>, snack_id: i64) -> CmdResult<DailyStats> {
    let conn = state.db.lock().map_err(err)?;
    let snack = load_snack(&conn, snack_id)
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
    load_daily(&conn, &today).map_err(err)
}

#[tauri::command]
pub fn get_today_consumption(state: State<'_, AppState>) -> CmdResult<Vec<ConsumptionEntry>> {
    let conn = state.db.lock().map_err(err)?;
    let mut stmt = conn
        .prepare("SELECT id, snack_name, snack_icon, calories, eaten_at FROM consumption_log WHERE user_id = ?1 AND date = ?2 ORDER BY eaten_at DESC")
        .map_err(err)?;
    let rows = stmt
        .query_map(params![USER_ID, today()], |r| {
            Ok(ConsumptionEntry {
                id: r.get(0)?,
                snack_name: r.get(1)?,
                snack_icon: r.get(2)?,
                calories: r.get(3)?,
                eaten_at: r.get(4)?,
            })
        })
        .map_err(err)?;
    rows.collect::<Result<_, _>>().map_err(err)
}

#[tauri::command]
pub fn delete_consumption(state: State<'_, AppState>, id: i64) -> CmdResult<DailyStats> {
    let conn = state.db.lock().map_err(err)?;
    let entry: Option<(i64, String)> = conn
        .query_row(
            "SELECT calories, date FROM consumption_log WHERE id = ?1 AND user_id = ?2",
            params![id, USER_ID],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(err)?;
    if let Some((calories, date)) = entry {
        conn.execute("DELETE FROM consumption_log WHERE id = ?1", params![id]).map_err(err)?;
        conn.execute(
            "UPDATE daily_stats SET kcal_consumed = MAX(0, kcal_consumed - ?1) WHERE user_id = ?2 AND date = ?3",
            params![calories, USER_ID, date],
        )
        .map_err(err)?;
    }
    load_daily(&conn, &today()).map_err(err)
}

#[tauri::command]
pub fn redeem_cheat_ticket(state: State<'_, AppState>) -> CmdResult<RedeemResult> {
    let conn = state.db.lock().map_err(err)?;
    redeem_ticket(&conn)
}

#[tauri::command]
pub fn get_stats(state: State<'_, AppState>) -> CmdResult<Stats> {
    let conn = state.db.lock().map_err(err)?;
    let user = load_user(&conn).map_err(err)?;
    let (total_kcal, total_answered, total_correct): (i64, i64, i64) = conn
        .query_row(
            "SELECT COALESCE(SUM(kcal_earned), 0), COALESCE(SUM(answered), 0), COALESCE(SUM(correct), 0) FROM daily_stats WHERE user_id = ?1",
            params![USER_ID],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(err)?;
    let accuracy = if total_answered > 0 {
        total_correct as f64 / total_answered as f64
    } else {
        0.0
    };

    let start = date_plus(-13);
    let mut by_date: HashMap<String, (i64, i64, i64)> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT date, kcal_earned, answered, correct FROM daily_stats WHERE user_id = ?1 AND date >= ?2")
            .map_err(err)?;
        let rows = stmt
            .query_map(params![USER_ID, start], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?),
                ))
            })
            .map_err(err)?;
        for row in rows {
            let (d, v) = row.map_err(err)?;
            by_date.insert(d, v);
        }
    }
    let last_14_days = (0..14)
        .map(|i| {
            let date = date_plus(i - 13);
            let (k, a, c) = by_date.get(&date).copied().unwrap_or((0, 0, 0));
            DayPoint { date, kcal_earned: k, answered: a, correct: c }
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
                Ok(WeakQuestion {
                    question: db::row_to_question(r)?,
                    wrong_count: r.get(15)?,
                    last_score: r.get(16)?,
                    next_due: r.get(17)?,
                    srs_level: r.get(18)?,
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

    Ok(Stats {
        total_study_days: user.total_study_days,
        current_streak: user.current_streak,
        longest_streak: user.longest_streak,
        total_kcal,
        total_answered,
        total_correct,
        accuracy,
        last_14_days,
        weak_questions,
        tickets,
        review_due: due_review_count(&conn).map_err(err)?,
        review_pending,
    })
}

#[tauri::command]
pub fn reset_progress(state: State<'_, AppState>) -> CmdResult<()> {
    let conn = state.db.lock().map_err(err)?;
    conn.execute_batch(
        "DELETE FROM learning_history; DELETE FROM answer_log; DELETE FROM daily_stats;
         DELETE FROM consumption_log; DELETE FROM cheat_tickets;
         UPDATE users SET total_study_days = 0, current_streak = 0, longest_streak = 0, last_study_date = NULL;",
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
        record_answer(conn, &AnswerPayload { question_id: qid, mode: mode.into(), correct, score, hints_used })
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
    fn correct_low_answer_earns_two_kcal() {
        let mut c = conn();
        let qid = question_id(&c, "w001");
        let r = answer(&mut c, qid, "choice", true, None);
        assert_eq!(r.kcal_earned, 2);
        assert_eq!(r.today_kcal, 2);
        assert!(r.first_study_today);
        assert_eq!(r.streak, 1);
        assert!(!r.needs_review);
        let d = load_daily(&c, &today()).unwrap();
        assert_eq!((d.answered, d.correct), (1, 1));
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
            let s = session_questions(&c, "typing", "low", "all", 50).unwrap();
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

        let session = session_questions(&c, "choice", "low", "all", 10).unwrap();
        let served = session.iter().find(|q| q.question.id == qid).expect("due question served");
        assert!(served.is_review);
        assert_eq!(served.options.len(), 4);
        assert!(served.options.contains(&served.answer));

        let r = answer(&mut c, qid, "choice", true, None);
        assert!(r.is_review);
        assert_eq!(r.kcal_earned, 3, "2 kcal x 1.5 rounded");
        let (level, needs, due) = history(&c, qid);
        assert_eq!((level, needs), (1, 1));
        assert_eq!(due.as_deref(), Some(date_plus(3).as_str()));
    }

    #[test]
    fn speaking_score_scales_kcal_and_low_scores_go_to_review() {
        let mut c = conn();
        let qid = question_id(&c, "i001"); // high difficulty: 10 kcal
        let r = answer(&mut c, qid, "speaking", true, Some(80.0));
        assert_eq!(r.kcal_earned, 8);
        assert!(!r.needs_review);
        let r = answer(&mut c, qid, "speaking", true, Some(65.0));
        assert_eq!(r.kcal_earned, 7, "6.5 rounds up");
        assert!(r.needs_review, "scores under 70 are scheduled for review");
    }

    #[test]
    fn revealed_hint_words_halve_the_reward() {
        let mut c = conn();
        let qid = question_id(&c, "i001"); // high difficulty: 10 kcal
        let r = answer_with_hints(&mut c, qid, "typing", true, None, Some(2));
        assert_eq!(r.kcal_earned, 3, "10 kcal halved twice, 2.5 rounds up");
        assert_eq!(r.today_kcal, 3, "the daily total only counts what was earned");
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
        assert_eq!(redeemed.today_kcal, 4 + 4 + srs::CHEAT_DAY_BONUS);
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
    fn session_respects_mode_and_difficulty() {
        let c = conn();
        let s = session_questions(&c, "typing", "high", "all", 10).unwrap();
        assert!(!s.is_empty());
        assert!(s.iter().all(|q| q.question.difficulty == "high" && q.question.modes.iter().any(|m| m == "typing")));
        let g = session_questions(&c, "choice", "mid", "all", 50).unwrap();
        assert!(g.iter().any(|q| q.question.kind == "grammar"), "grammar questions appear in choice mode");
        assert!(g.iter().filter(|q| q.question.kind == "grammar").all(|q| q.options.len() == 4 && q.options.contains(&q.answer)));
    }

    #[test]
    fn distractors_come_from_the_same_semantic_group() {
        let c = conn();
        let qid = question_id(&c, "w072"); // salt / 塩, group 調味料
        let q = c
            .query_row(&format!("SELECT {Q_COLS} FROM questions q WHERE q.id = ?1"), params![qid], db::row_to_question)
            .unwrap();
        assert_eq!(q.group, "調味料");
        let group_meanings: Vec<String> = {
            let mut stmt = c.prepare("SELECT ja FROM questions WHERE word_group = ?1").unwrap();
            stmt.query_map(params![q.group], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
        };
        // Repeat: the picks are random, every draw must stay inside the group.
        for _ in 0..20 {
            let opts = japanese_distractors(&c, &q).unwrap();
            assert_eq!(opts.len(), 3);
            for o in &opts {
                assert!(group_meanings.contains(o), "'{o}' is not a 調味料 meaning");
                assert_ne!(o, &q.ja);
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
            let s = session_questions(&c, "listening", "mid", "日常生活", 20).unwrap();
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

    #[test]
    fn dialogue_replies_are_borrowed_from_other_dialogues() {
        let c = conn();
        // The replies written into the data all follow a handful of templates ("He plays chess."),
        // so the odd one out was the answer and the learner never had to listen. Options must be
        // borrowed from sibling dialogues instead.
        let mut checked = 0;
        for _ in 0..20 {
            let s = session_questions(&c, "listening", "mid", "食べ物", 20).unwrap();
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
        let food = session_questions(&c, "choice", "low", "食べ物", 20).unwrap();
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
        assert!(cats.iter().any(|x| x.name == "文法" && x.mid > 0));
    }
}
