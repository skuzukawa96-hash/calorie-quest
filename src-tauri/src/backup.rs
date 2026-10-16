//! バックアップ: the whole record (learning history, recipe, snacks, exams, favorites) copied into
//! a file of its own, and put back from one. Backups go to Documents\CalorieQuest\backups, where the
//! learner can find them and keep them elsewhere too; the database itself lives in the app's data
//! folder, which a broken PC or a fresh install takes with it.

use crate::models::{BackupInfo, BackupList};
use crate::AppState;
use chrono::{DateTime, Local};
use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

const PREFIX: &str = "calorie-quest_";
const EXT: &str = ".db";
/// The database file in the app's data folder (lib.rs opens it).
pub const DB_FILE: &str = "calorie_quest.db";

/// Documents\CalorieQuest\backups, made if missing.
fn folder(app: &AppHandle) -> CmdResult<PathBuf> {
    let dir = app.path().document_dir().map_err(err)?.join("CalorieQuest").join("backups");
    std::fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

fn db_path(app: &AppHandle) -> CmdResult<PathBuf> {
    Ok(app.path().app_data_dir().map_err(err)?.join(DB_FILE))
}

/// A backup's file name, from when it was made: calorie-quest_2026-10-12_153000.db, with a
/// `note` before the extension for one made by the app itself (before-restore).
fn file_name(note: Option<&str>) -> String {
    let stamp = Local::now().format("%Y-%m-%d_%H%M%S");
    match note {
        Some(n) => format!("{PREFIX}{stamp}_{n}{EXT}"),
        None => format!("{PREFIX}{stamp}{EXT}"),
    }
}

/// Whether `name` is one of ours, a plain file name (nothing that climbs out of the folder).
fn is_backup_name(name: &str) -> bool {
    name.starts_with(PREFIX) && name.ends_with(EXT) && !name.contains(['/', '\\', ':']) && !name.contains("..")
}

/// Writes the whole database, as it is now, into `to`: a consistent copy even while the app runs.
pub fn write_backup(conn: &Connection, to: &Path) -> CmdResult<()> {
    if to.exists() {
        return Err("同じ名前のバックアップがあります。少し待ってからもう一度どうぞ".into());
    }
    conn.execute("VACUUM INTO ?1", [to.to_string_lossy()]).map_err(err)?;
    Ok(())
}

/// Whether `path` holds a Calorie Quest record: an SQLite file with its users and answers.
pub fn looks_like_ours(path: &Path) -> bool {
    let Ok(conn) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else { return false };
    let tables: rusqlite::Result<i64> = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'learning_history', 'daily_stats')",
        [],
        |r| r.get(0),
    );
    matches!(tables, Ok(3))
}

fn info(path: &Path) -> Option<BackupInfo> {
    let name = path.file_name()?.to_str()?.to_string();
    if !is_backup_name(&name) {
        return None;
    }
    let meta = std::fs::metadata(path).ok()?;
    let made: DateTime<Local> = meta.modified().ok()?.into();
    Some(BackupInfo {
        before_restore: name.ends_with(&format!("_before-restore{EXT}")),
        name,
        made_at: made.format("%Y-%m-%dT%H:%M:%S").to_string(),
        bytes: meta.len() as i64,
    })
}

/// The backups in the folder, newest first.
pub fn list_in(dir: &Path) -> CmdResult<Vec<BackupInfo>> {
    let mut out: Vec<BackupInfo> =
        std::fs::read_dir(dir).map_err(err)?.filter_map(|e| e.ok()).filter_map(|e| info(&e.path())).collect();
    out.sort_by(|a, b| b.made_at.cmp(&a.made_at).then(b.name.cmp(&a.name)));
    Ok(out)
}

/// Puts the record in `from` in place of the database at `db`, the open connection `live` being
/// swapped for the new one. What was there is kept in `safety` first; if anything fails after the
/// old connection is closed, the old file goes back and is opened again.
pub fn restore_into(live: &mut Connection, db: &Path, from: &Path, safety: &Path) -> CmdResult<()> {
    if !looks_like_ours(from) {
        return Err("Calorie Quest のバックアップではないようです".into());
    }
    write_backup(live, safety)?;
    // Closing the only connection checkpoints the WAL into the file and lets it go.
    drop(std::mem::replace(live, Connection::open_in_memory().map_err(err)?));
    let put = |source: &Path| -> CmdResult<Connection> {
        for side in ["-wal", "-shm"] {
            let p = PathBuf::from(format!("{}{side}", db.display()));
            if p.exists() {
                std::fs::remove_file(&p).map_err(err)?;
            }
        }
        std::fs::copy(source, db).map_err(err)?;
        // Opened as at start-up: an older backup gets the newer columns and questions.
        crate::db::init(db).map_err(err)
    };
    match put(from) {
        Ok(conn) => {
            *live = conn;
            Ok(())
        }
        Err(e) => {
            *live = put(safety).map_err(|e2| format!("{e}（元のデータにも戻せませんでした: {e2}）"))?;
            Err(format!("戻せませんでした: {e}（データは元のままです）"))
        }
    }
}

/// Deletes the backup `name` from the folder `dir`: only a file of ours, by its name in the folder.
pub fn delete_in(dir: &Path, name: &str) -> CmdResult<()> {
    if !is_backup_name(name) {
        return Err(format!("バックアップの名前が正しくありません: {name}"));
    }
    let path = dir.join(name);
    if !path.is_file() {
        return Err(format!("バックアップが見つかりません: {name}"));
    }
    std::fs::remove_file(&path).map_err(err)
}

/* ---------- Tauri commands ---------- */

#[tauri::command]
pub fn list_backups(app: AppHandle) -> CmdResult<BackupList> {
    let dir = folder(&app)?;
    Ok(BackupList { folder: dir.display().to_string(), backups: list_in(&dir)? })
}

#[tauri::command]
pub fn create_backup(app: AppHandle, state: State<'_, AppState>) -> CmdResult<BackupInfo> {
    let to = folder(&app)?.join(file_name(None));
    let conn = state.db.lock().map_err(err)?;
    write_backup(&conn, &to)?;
    info(&to).ok_or_else(|| "バックアップを書けませんでした".to_string())
}

#[tauri::command]
pub fn restore_backup(app: AppHandle, state: State<'_, AppState>, name: String) -> CmdResult<()> {
    if !is_backup_name(&name) {
        return Err(format!("バックアップの名前が正しくありません: {name}"));
    }
    let dir = folder(&app)?;
    let from = dir.join(&name);
    if !from.is_file() {
        return Err(format!("バックアップが見つかりません: {name}"));
    }
    let safety = dir.join(file_name(Some("before-restore")));
    let mut conn = state.db.lock().map_err(err)?;
    restore_into(&mut conn, &db_path(&app)?, &from, &safety)
}

/// Deletes one backup (the list's ×, asked first).
#[tauri::command]
pub fn delete_backup(app: AppHandle, name: String) -> CmdResult<()> {
    delete_in(&folder(&app)?, &name)
}

/// Opens the backups folder in Explorer.
#[tauri::command]
pub fn open_backup_folder(app: AppHandle) -> CmdResult<()> {
    let dir = folder(&app)?;
    std::process::Command::new("explorer").arg(&dir).spawn().map_err(err)?;
    Ok(())
}

/* ---------- tests ---------- */

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder of its own under the temp dir, gone when the test is.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("calorie-quest-test-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn studied_days(conn: &Connection) -> i64 {
        conn.query_row("SELECT total_study_days FROM users WHERE id = 1", [], |r| r.get(0)).unwrap()
    }

    /// A backup is the record as it was; restoring it brings that back, keeps what was there in a
    /// backup of its own, and the database opened again works as at start-up.
    #[test]
    fn a_backup_brings_the_record_back_as_it_was() {
        let dir = Scratch::new("restore");
        let db = dir.0.join(DB_FILE);
        let mut live = crate::db::init(&db).unwrap();
        live.execute("UPDATE users SET total_study_days = 5 WHERE id = 1", []).unwrap();
        let saved = dir.0.join(file_name(None));
        write_backup(&live, &saved).unwrap();
        assert!(write_backup(&live, &saved).is_err(), "an existing backup is not written over");
        assert!(looks_like_ours(&saved));

        live.execute("UPDATE users SET total_study_days = 9 WHERE id = 1", []).unwrap();
        let safety = dir.0.join(file_name(Some("before-restore")));
        restore_into(&mut live, &db, &saved, &safety).unwrap();
        assert_eq!(studied_days(&live), 5, "back as it was");
        assert!(live.query_row("SELECT COUNT(*) FROM questions", [], |r| r.get::<_, i64>(0)).unwrap() > 1000);
        let kept = Connection::open(&safety).unwrap();
        assert_eq!(studied_days(&kept), 9, "what was there before is kept");

        let names: Vec<String> = list_in(&dir.0).unwrap().into_iter().map(|b| b.name).collect();
        assert_eq!(names.len(), 2, "{names:?}");
        assert!(list_in(&dir.0).unwrap().iter().any(|b| b.before_restore));
    }

    /// A backup can be deleted from the list; only one of ours, by its name in the folder.
    #[test]
    fn a_backup_is_deleted_by_its_name() {
        let dir = Scratch::new("delete");
        let live = crate::db::init(&dir.0.join(DB_FILE)).unwrap();
        let saved = dir.0.join(file_name(None));
        write_backup(&live, &saved).unwrap();
        let name = saved.file_name().unwrap().to_str().unwrap().to_string();
        assert_eq!(list_in(&dir.0).unwrap().len(), 1);
        delete_in(&dir.0, &name).unwrap();
        assert!(list_in(&dir.0).unwrap().is_empty());
        assert!(delete_in(&dir.0, &name).is_err(), "gone already");
        assert!(delete_in(&dir.0, DB_FILE).is_err(), "the database itself is not a backup");
        assert!(delete_in(&dir.0, "../calorie-quest_x.db").is_err());
        assert!(dir.0.join(DB_FILE).exists());
    }

    /// Anything that is not one of ours is refused, and the record stays as it is.
    #[test]
    fn something_else_is_not_restored() {
        let dir = Scratch::new("refuse");
        let db = dir.0.join(DB_FILE);
        let mut live = crate::db::init(&db).unwrap();
        live.execute("UPDATE users SET total_study_days = 3 WHERE id = 1", []).unwrap();
        let junk = dir.0.join(format!("{PREFIX}junk{EXT}"));
        std::fs::write(&junk, b"not a database").unwrap();
        let safety = dir.0.join(file_name(Some("before-restore")));
        assert!(restore_into(&mut live, &db, &junk, &safety).is_err());
        assert_eq!(studied_days(&live), 3);
        assert!(!safety.exists(), "nothing was touched");
        for name in ["../calorie-quest_x.db", "calorie-quest_x.txt", "other.db", "calorie-quest_a\\b.db"] {
            assert!(!is_backup_name(name), "{name}");
        }
        assert!(is_backup_name(&file_name(None)));
    }
}
