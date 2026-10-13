//! ダイエット機能: 課題（腕立て伏せ・窓ふき・宿題…やるとカロリーがもらえること）と、体重・BMI の記録。
//! 課題はお菓子の逆で、図鑑と同じく一覧・目標・今日の記録（取り消し）を持つ。課題と体重の記録が払う
//! カロリーは学習者が書いた値（体重は1日1回 10 kcal）なので、遊び方モード（がんばり・お気軽）は掛けない。

use crate::commands::{checked_item, err, load_daily, CmdResult, USER_ID};
use crate::db::{meta_get, meta_set};
use crate::models::{DailyStats, Task, TaskEntry, WeightPoint, WeightResult};
use crate::util::{now_ts, today};
use crate::AppState;
use rusqlite::{params, Connection, OptionalExtension, Row};
use tauri::State;

/// What the first weight recorded in a day pays.
pub const WEIGHT_BONUS_KCAL: i64 = 10;
/// The most a 課題 may pay: a slip of a key (3000 for 30) would hand out a day's snacks.
pub const TASK_MAX_KCAL: i64 = 1000;
const WEIGHT_KG: std::ops::RangeInclusive<f64> = 10.0..=300.0;
const HEIGHT_CM: std::ops::RangeInclusive<f64> = 50.0..=250.0;

/// The 課題 put in the list once, on the first start, as the snack book's first snacks are.
const BUILTIN_TASKS: &[(&str, i64, &str)] = &[
    ("腕立て伏せ 10回", 30, "💪"),
    ("スクワット 20回", 30, "🏋️"),
    ("洗濯物をたたむ", 30, "🧺"),
    ("食器洗い", 40, "🍽️"),
    ("散歩 30分", 50, "🚶"),
    ("窓ふき", 50, "🧽"),
    ("部屋の掃除", 60, "🧹"),
    ("宿題", 100, "📚"),
];

/// The columns `row_to_task` reads, from `tasks t`, with how often each has been done.
const TASK_COLS: &str = "t.id, t.name, t.calories, t.icon, t.is_builtin,
    (SELECT COUNT(*) FROM task_log l WHERE l.task_id = t.id)";

fn row_to_task(r: &Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get(0)?,
        name: r.get(1)?,
        calories: r.get(2)?,
        icon: r.get(3)?,
        is_builtin: r.get::<_, i64>(4)? != 0,
        done_count: r.get(5)?,
    })
}

pub fn seed_tasks(conn: &Connection) -> rusqlite::Result<()> {
    if meta_get(conn, "tasks_seeded")?.is_some() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    for (name, kcal, icon) in BUILTIN_TASKS {
        tx.execute(
            "INSERT INTO tasks (name, calories, icon, is_builtin, created_at) VALUES (?1, ?2, ?3, 1, ?4)",
            params![name, kcal, icon, now_ts()],
        )?;
    }
    meta_set(&tx, "tasks_seeded", "1")?;
    tx.commit()
}

/// The list, the cheapest first as the snack book is.
pub fn list_tasks_in(conn: &Connection) -> rusqlite::Result<Vec<Task>> {
    let mut stmt = conn.prepare(&format!("SELECT {TASK_COLS} FROM tasks t ORDER BY t.calories ASC, t.id ASC"))?;
    let rows = stmt.query_map([], row_to_task)?;
    rows.collect()
}

fn load_task(conn: &Connection, id: i64) -> rusqlite::Result<Option<Task>> {
    conn.query_row(&format!("SELECT {TASK_COLS} FROM tasks t WHERE t.id = ?1"), params![id], row_to_task)
        .optional()
}

/// The 課題 set as goals (the home's 課題 tab), the cheapest first.
pub fn goal_tasks(conn: &Connection) -> rusqlite::Result<Vec<Task>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {TASK_COLS} FROM goal_tasks g JOIN tasks t ON t.id = g.task_id
         ORDER BY t.calories ASC, g.added_at ASC, t.id ASC"
    ))?;
    let rows = stmt.query_map([], row_to_task)?;
    rows.collect()
}

/// The 課題 done today, each once.
pub fn done_today(conn: &Connection) -> rusqlite::Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT task_id FROM task_log WHERE user_id = ?1 AND date = ?2 AND task_id IS NOT NULL ORDER BY task_id",
    )?;
    let rows = stmt.query_map(params![USER_ID, today()], |r| r.get(0))?;
    rows.collect()
}

pub fn set_diet_mode_in(conn: &Connection, on: bool) -> CmdResult<bool> {
    conn.execute("UPDATE users SET diet_mode = ?1 WHERE id = ?2", params![on as i64, USER_ID]).map_err(err)?;
    Ok(on)
}

fn checked_task(name: &str, calories: i64, icon: &str) -> CmdResult<(String, String)> {
    checked_item("課題", name, calories, TASK_MAX_KCAL, icon, "💪")
}

pub fn add_task_in(conn: &Connection, name: &str, calories: i64, icon: &str) -> CmdResult<Task> {
    let (name, icon) = checked_task(name, calories, icon)?;
    conn.execute(
        "INSERT INTO tasks (name, calories, icon, is_builtin, created_at) VALUES (?1, ?2, ?3, 0, ?4)",
        params![name, calories, icon, now_ts()],
    )
    .map_err(err)?;
    load_task(conn, conn.last_insert_rowid()).map_err(err)?.ok_or_else(|| "failed to load task".to_string())
}

/// Corrects a 課題, one of the first ones too. What was done keeps the name and kcal it had then.
pub fn update_task_in(conn: &Connection, id: i64, name: &str, calories: i64, icon: &str) -> CmdResult<Task> {
    let (name, icon) = checked_task(name, calories, icon)?;
    let changed = conn
        .execute("UPDATE tasks SET name = ?2, calories = ?3, icon = ?4 WHERE id = ?1", params![id, name, calories, icon])
        .map_err(err)?;
    if changed == 0 {
        return Err("task not found".into());
    }
    load_task(conn, id).map_err(err)?.ok_or_else(|| "task not found".to_string())
}

/// Takes a 課題 out of the list (and the goals); what was done stays in the log.
pub fn delete_task_in(conn: &Connection, id: i64) -> CmdResult<()> {
    conn.execute("DELETE FROM goal_tasks WHERE task_id = ?1", params![id]).map_err(err)?;
    conn.execute("DELETE FROM tasks WHERE id = ?1", params![id]).map_err(err)?;
    Ok(())
}

pub fn set_goal_task_in(conn: &Connection, id: i64, goal: bool) -> CmdResult<Vec<Task>> {
    if goal {
        load_task(conn, id).map_err(err)?.ok_or_else(|| "task not found".to_string())?;
        conn.execute("INSERT OR IGNORE INTO goal_tasks (task_id, added_at) VALUES (?1, ?2)", params![id, now_ts()])
            .map_err(err)?;
    } else {
        conn.execute("DELETE FROM goal_tasks WHERE task_id = ?1", params![id]).map_err(err)?;
    }
    goal_tasks(conn).map_err(err)
}

/// Adds whole kcal to a day's earnings as they are: a 課題 or a weight pays what it says, whatever
/// the play mode.
fn earn_flat(conn: &Connection, day: &str, kcal: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO daily_stats (user_id, date, kcal_earned) VALUES (?1, ?2, ?3)
         ON CONFLICT(user_id, date) DO UPDATE SET kcal_earned = kcal_earned + excluded.kcal_earned",
        params![USER_ID, day, kcal],
    )?;
    Ok(())
}

/// Records a 課題 of the list done now, and adds its kcal to today's.
pub fn log_done(conn: &Connection, task_id: i64) -> CmdResult<DailyStats> {
    let task = load_task(conn, task_id).map_err(err)?.ok_or_else(|| "task not found".to_string())?;
    earn_on(conn, Some(task.id), &task.name, &task.icon, task.calories)
}

/// Records a 課題 done once without putting it in the list or the goals (the 💪 of ＋ 課題追加).
pub fn log_one_off_done(conn: &Connection, name: &str, calories: i64, icon: &str) -> CmdResult<DailyStats> {
    let (name, icon) = checked_task(name, calories, icon)?;
    earn_on(conn, None, &name, &icon, calories)
}

fn earn_on(conn: &Connection, task_id: Option<i64>, name: &str, icon: &str, calories: i64) -> CmdResult<DailyStats> {
    let day = today();
    let tx = conn.unchecked_transaction().map_err(err)?;
    tx.execute(
        "INSERT INTO task_log (user_id, task_id, task_name, task_icon, calories, date, done_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![USER_ID, task_id, name, icon, calories, day, now_ts()],
    )
    .map_err(err)?;
    earn_flat(&tx, &day, calories).map_err(err)?;
    tx.commit().map_err(err)?;
    load_daily(conn, &day).map_err(err)
}

/// The 課題 done today, the latest first (as the snacks eaten are).
pub fn today_tasks(conn: &Connection) -> rusqlite::Result<Vec<TaskEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, task_name, task_icon, calories, done_at FROM task_log WHERE user_id = ?1 AND date = ?2 ORDER BY done_at DESC, id DESC",
    )?;
    let rows = stmt.query_map(params![USER_ID, today()], |r| {
        Ok(TaskEntry { id: r.get(0)?, task_name: r.get(1)?, task_icon: r.get(2)?, calories: r.get(3)?, done_at: r.get(4)? })
    })?;
    rows.collect()
}

/// Takes a 課題 done out of the log, and its kcal back from its day.
pub fn delete_done_in(conn: &Connection, id: i64) -> CmdResult<DailyStats> {
    let entry: Option<(i64, String)> = conn
        .query_row(
            "SELECT calories, date FROM task_log WHERE id = ?1 AND user_id = ?2",
            params![id, USER_ID],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(err)?;
    if let Some((calories, date)) = entry {
        let tx = conn.unchecked_transaction().map_err(err)?;
        tx.execute("DELETE FROM task_log WHERE id = ?1", params![id]).map_err(err)?;
        tx.execute(
            "UPDATE daily_stats SET kcal_earned = MAX(0, kcal_earned - ?1) WHERE user_id = ?2 AND date = ?3",
            params![calories, USER_ID, date],
        )
        .map_err(err)?;
        tx.commit().map_err(err)?;
    }
    load_daily(conn, &today()).map_err(err)
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// BMI: the weight in kg over the height in metres squared, to one decimal.
pub fn bmi(weight_kg: f64, height_cm: f64) -> f64 {
    let m = height_cm / 100.0;
    round1(weight_kg / (m * m))
}

fn point(date: String, weight_kg: f64, height_cm: f64) -> WeightPoint {
    WeightPoint { date, weight_kg, height_cm, bmi: bmi(weight_kg, height_cm) }
}

/// Records today's weight at the height given (which is kept for the next time). The first record of
/// a day pays [`WEIGHT_BONUS_KCAL`]; recording again the same day corrects it and pays nothing.
pub fn record_weight_in(conn: &Connection, weight_kg: f64, height_cm: f64) -> CmdResult<WeightResult> {
    if !weight_kg.is_finite() || !WEIGHT_KG.contains(&weight_kg) {
        return Err("体重は10〜300 kgの範囲で入力してください".into());
    }
    if !height_cm.is_finite() || !HEIGHT_CM.contains(&height_cm) {
        return Err("身長は50〜250 cmの範囲で入力してください".into());
    }
    let (w, h) = (round1(weight_kg), round1(height_cm));
    let day = today();
    let now = now_ts();
    let tx = conn.unchecked_transaction().map_err(err)?;
    tx.execute("UPDATE users SET height_cm = ?1 WHERE id = ?2", params![h, USER_ID]).map_err(err)?;
    let first = tx
        .execute(
            "INSERT OR IGNORE INTO weight_log (user_id, date, weight_kg, height_cm, bonus_kcal, recorded_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![USER_ID, day, w, h, WEIGHT_BONUS_KCAL, now],
        )
        .map_err(err)?
        == 1;
    if first {
        earn_flat(&tx, &day, WEIGHT_BONUS_KCAL).map_err(err)?;
    } else {
        tx.execute(
            "UPDATE weight_log SET weight_kg = ?3, height_cm = ?4, recorded_at = ?5 WHERE user_id = ?1 AND date = ?2",
            params![USER_ID, day, w, h, now],
        )
        .map_err(err)?;
    }
    tx.commit().map_err(err)?;
    Ok(WeightResult {
        point: point(day.clone(), w, h),
        bonus: if first { WEIGHT_BONUS_KCAL } else { 0 },
        today: load_daily(conn, &day).map_err(err)?,
    })
}

/// The weights recorded from `start` on, oldest first.
pub fn weights_since(conn: &Connection, start: &str) -> rusqlite::Result<Vec<WeightPoint>> {
    let mut stmt =
        conn.prepare("SELECT date, weight_kg, height_cm FROM weight_log WHERE user_id = ?1 AND date >= ?2 ORDER BY date")?;
    let rows = stmt.query_map(params![USER_ID, start], |r| Ok(point(r.get(0)?, r.get(1)?, r.get(2)?)))?;
    rows.collect()
}

/* ---------- Tauri commands ---------- */

#[tauri::command]
pub fn set_diet_mode(state: State<'_, AppState>, on: bool) -> CmdResult<bool> {
    let conn = state.db.lock().map_err(err)?;
    set_diet_mode_in(&conn, on)
}

#[tauri::command]
pub fn list_tasks(state: State<'_, AppState>) -> CmdResult<Vec<Task>> {
    let conn = state.db.lock().map_err(err)?;
    list_tasks_in(&conn).map_err(err)
}

#[tauri::command]
pub fn add_task(state: State<'_, AppState>, name: String, calories: i64, icon: String) -> CmdResult<Task> {
    let conn = state.db.lock().map_err(err)?;
    add_task_in(&conn, &name, calories, &icon)
}

#[tauri::command]
pub fn update_task(state: State<'_, AppState>, id: i64, name: String, calories: i64, icon: String) -> CmdResult<Task> {
    let conn = state.db.lock().map_err(err)?;
    update_task_in(&conn, id, &name, calories, &icon)
}

#[tauri::command]
pub fn delete_task(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let conn = state.db.lock().map_err(err)?;
    delete_task_in(&conn, id)
}

#[tauri::command]
pub fn set_goal_task(state: State<'_, AppState>, id: i64, goal: bool) -> CmdResult<Vec<Task>> {
    let conn = state.db.lock().map_err(err)?;
    set_goal_task_in(&conn, id, goal)
}

#[tauri::command]
pub fn log_task_done(state: State<'_, AppState>, task_id: i64) -> CmdResult<DailyStats> {
    let conn = state.db.lock().map_err(err)?;
    log_done(&conn, task_id)
}

#[tauri::command]
pub fn log_one_off_task(state: State<'_, AppState>, name: String, calories: i64, icon: String) -> CmdResult<DailyStats> {
    let conn = state.db.lock().map_err(err)?;
    log_one_off_done(&conn, &name, calories, &icon)
}

#[tauri::command]
pub fn get_today_tasks(state: State<'_, AppState>) -> CmdResult<Vec<TaskEntry>> {
    let conn = state.db.lock().map_err(err)?;
    today_tasks(&conn).map_err(err)
}

#[tauri::command]
pub fn delete_task_done(state: State<'_, AppState>, id: i64) -> CmdResult<DailyStats> {
    let conn = state.db.lock().map_err(err)?;
    delete_done_in(&conn, id)
}

#[tauri::command]
pub fn record_weight(state: State<'_, AppState>, weight_kg: f64, height_cm: f64) -> CmdResult<WeightResult> {
    let conn = state.db.lock().map_err(err)?;
    record_weight_in(&conn, weight_kg, height_cm)
}

/* ---------- tests ---------- */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{load_dashboard, set_play_mode_in};
    use crate::db;

    fn earned(conn: &Connection) -> i64 {
        load_daily(conn, &today()).unwrap().kcal_earned
    }

    /// The first start puts a few 課題 in the list, once; a 課題 done pays what it says (the play
    /// mode left aside), shows in today's log and as done today, and its undo takes the kcal back.
    #[test]
    fn a_task_done_earns_its_kcal_and_its_undo_takes_them_back() {
        let conn = db::init_in_memory().unwrap();
        assert_eq!(list_tasks_in(&conn).unwrap().len(), BUILTIN_TASKS.len());
        seed_tasks(&conn).unwrap();
        assert_eq!(list_tasks_in(&conn).unwrap().len(), BUILTIN_TASKS.len(), "seeded once");

        set_play_mode_in(&conn, "hard").unwrap();
        let task = add_task_in(&conn, " 窓ふき（2階） ", 50, "").unwrap();
        assert_eq!((task.name.as_str(), task.icon.as_str()), ("窓ふき（2階）", "💪"));
        assert_eq!(log_done(&conn, task.id).unwrap().kcal_earned, 50, "no ×0.5 for a 課題");
        log_done(&conn, task.id).unwrap();
        assert_eq!(earned(&conn), 100);
        assert_eq!(done_today(&conn).unwrap(), vec![task.id]);
        assert_eq!(load_task(&conn, task.id).unwrap().unwrap().done_count, 2);

        let log = today_tasks(&conn).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!((log[0].task_name.as_str(), log[0].calories), ("窓ふき（2階）", 50));
        assert_eq!(delete_done_in(&conn, log[0].id).unwrap().kcal_earned, 50);
        assert_eq!(today_tasks(&conn).unwrap().len(), 1);

        assert!(add_task_in(&conn, "", 50, "🧹").is_err());
        assert!(add_task_in(&conn, "腹筋", 0, "💪").is_err());
        assert!(add_task_in(&conn, "腹筋", TASK_MAX_KCAL + 1, "💪").is_err());
    }

    /// The 💪 of ＋ 課題追加 earns and logs a 課題 without putting it in the list or the goals; a goal
    /// leaves with its 課題, whose log stays.
    #[test]
    fn a_task_done_once_joins_no_list_and_goals_follow_the_list() {
        let conn = db::init_in_memory().unwrap();
        let before = list_tasks_in(&conn).unwrap().len();
        log_one_off_done(&conn, "大掃除", 200, "🧹").unwrap();
        assert_eq!(earned(&conn), 200);
        assert_eq!(list_tasks_in(&conn).unwrap().len(), before);
        assert!(done_today(&conn).unwrap().is_empty());
        assert_eq!(today_tasks(&conn).unwrap()[0].task_name, "大掃除");

        let task = add_task_in(&conn, "ストレッチ", 20, "🧘").unwrap();
        assert_eq!(set_goal_task_in(&conn, task.id, true).unwrap().len(), 1);
        set_goal_task_in(&conn, task.id, true).unwrap();
        assert_eq!(goal_tasks(&conn).unwrap().len(), 1, "a goal once");
        let fixed = update_task_in(&conn, task.id, "ストレッチ 10分", 25, "🧘").unwrap();
        assert_eq!(goal_tasks(&conn).unwrap()[0].name, fixed.name);
        log_done(&conn, task.id).unwrap();
        delete_task_in(&conn, task.id).unwrap();
        assert!(goal_tasks(&conn).unwrap().is_empty());
        assert_eq!(today_tasks(&conn).unwrap().len(), 2, "what was done stays in the log");
        assert!(set_goal_task_in(&conn, task.id, true).is_err());
    }

    /// Today's weight pays 10 kcal the first time only; recording again corrects it. The height is
    /// kept, and the BMI is worked out from the height of the record.
    #[test]
    fn a_weight_pays_once_a_day_and_makes_a_bmi() {
        let conn = db::init_in_memory().unwrap();
        set_play_mode_in(&conn, "easy").unwrap();
        let first = record_weight_in(&conn, 63.64, 170.0).unwrap();
        assert_eq!(first.bonus, WEIGHT_BONUS_KCAL);
        assert_eq!(first.today.kcal_earned, WEIGHT_BONUS_KCAL, "no ×1.5 for a weight");
        assert_eq!((first.point.weight_kg, first.point.bmi), (63.6, 22.0));
        let again = record_weight_in(&conn, 63.2, 170.0).unwrap();
        assert_eq!(again.bonus, 0);
        assert_eq!(earned(&conn), WEIGHT_BONUS_KCAL);
        let weights = weights_since(&conn, &today()).unwrap();
        assert_eq!(weights.len(), 1);
        assert_eq!((weights[0].weight_kg, weights[0].bmi), (63.2, 21.9));
        assert_eq!(load_dashboard(&conn).unwrap().user.height_cm, Some(170.0));

        assert!(record_weight_in(&conn, 5.0, 170.0).is_err());
        assert!(record_weight_in(&conn, 60.0, 30.0).is_err());
        assert!(record_weight_in(&conn, f64::NAN, 170.0).is_err());
    }

    /// The switch in the top bar: the home and the other screens read it from the dashboard.
    #[test]
    fn the_diet_mode_is_kept() {
        let conn = db::init_in_memory().unwrap();
        assert!(!load_dashboard(&conn).unwrap().user.diet_mode, "off at first");
        set_diet_mode_in(&conn, true).unwrap();
        let dash = load_dashboard(&conn).unwrap();
        assert!(dash.user.diet_mode);
        assert_eq!(dash.tasks.len(), BUILTIN_TASKS.len());
        set_diet_mode_in(&conn, false).unwrap();
        assert!(!load_dashboard(&conn).unwrap().user.diet_mode);
    }
}
