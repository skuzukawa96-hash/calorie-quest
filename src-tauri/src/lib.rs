mod backup;
mod commands;
mod db;
mod diet;
mod exam;
mod favorite;
mod lexilink;
mod models;
mod recipe;
mod speech;
mod srs;
mod util;

use std::ops::{Deref, DerefMut};
use std::sync::{Condvar, Mutex, MutexGuard};
use tauri::Manager;

pub struct AppState {
    pub db: Db,
    /// what the home screen counts of the question bank, counted once (`commands::BankCounts`)
    pub bank: Mutex<Option<commands::BankCounts>>,
}

/// The database, opened behind the window as the app starts. Tauri builds the window before
/// `setup` runs, so the page asks for its first screen while a first start is still filling the
/// question bank (seconds on a phone): a command waits here for it, where it used to find the
/// state not managed yet.
pub struct Db {
    state: Mutex<Opening>,
    opened: Condvar,
}

enum Opening {
    Waiting,
    Open(rusqlite::Connection),
    Failed(String),
}

/// The open database, held for one command (`Db::lock`).
pub struct DbGuard<'a>(MutexGuard<'a, Opening>);

impl Deref for DbGuard<'_> {
    type Target = rusqlite::Connection;
    fn deref(&self) -> &rusqlite::Connection {
        match &*self.0 {
            Opening::Open(conn) => conn,
            _ => unreachable!("Db::lock hands out only an open database"),
        }
    }
}

impl DerefMut for DbGuard<'_> {
    fn deref_mut(&mut self) -> &mut rusqlite::Connection {
        match &mut *self.0 {
            Opening::Open(conn) => conn,
            _ => unreachable!("Db::lock hands out only an open database"),
        }
    }
}

impl Db {
    fn waiting() -> Self {
        Db { state: Mutex::new(Opening::Waiting), opened: Condvar::new() }
    }

    /// The database opened, or why it could not be: what every command waiting for it gets.
    fn opened(&self, result: Result<rusqlite::Connection, String>) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        *state = match result {
            Ok(conn) => Opening::Open(conn),
            Err(e) => Opening::Failed(e),
        };
        self.opened.notify_all();
    }

    /// The database for one command, once it is open.
    pub fn lock(&self) -> Result<DbGuard<'_>, String> {
        let state = self.state.lock().map_err(|e| e.to_string())?;
        let state = self.opened.wait_while(state, |s| matches!(s, Opening::Waiting)).map_err(|e| e.to_string())?;
        if let Opening::Failed(e) = &*state {
            return Err(format!("データベースを開けませんでした: {e}"));
        }
        Ok(DbGuard(state))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The state is there before the window asks for anything; its database opens in `setup`.
    let builder = tauri::Builder::default().manage(AppState { db: Db::waiting(), bank: Mutex::new(None) });
    // The phone's text-to-speech and speech recognizer (speech.rs).
    #[cfg(target_os = "android")]
    let builder = builder.plugin(speech::android_plugin());
    builder
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let app = app.handle().clone();
            // Behind the window, which shows 読み込み中 meanwhile: a first start fills the question
            // bank, too long to hold the window (and a phone's main thread) up for.
            std::thread::spawn(move || {
                let opened = std::fs::create_dir_all(&dir)
                    .map_err(|e| e.to_string())
                    .and_then(|()| db::init(&dir.join(backup::DB_FILE)).map_err(|e| e.to_string()));
                app.state::<AppState>().db.opened(opened);
                // The notes' tables, ready before the first お気に入り or answer asks for them, and
                // LexiLink's 対義語 before the first game of Opposites.
                db::warm_up();
                lexilink::warm_up();
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            backup::list_backups,
            backup::create_backup,
            backup::restore_backup,
            backup::delete_backup,
            lexilink::deal_lexilink,
            lexilink::finish_lexilink,
            backup::open_backup_folder,
            commands::get_dashboard,
            commands::get_session_questions,
            commands::submit_answer,
            commands::list_snacks,
            commands::add_snack,
            commands::update_snack,
            commands::delete_snack,
            commands::set_goal_snack,
            commands::log_snack_eaten,
            commands::log_one_off_snack,
            commands::get_today_consumption,
            commands::delete_consumption,
            commands::eat_with_ticket,
            commands::redeem_cheat_ticket,
            commands::set_play_mode,
            diet::set_diet_mode,
            diet::list_tasks,
            diet::add_task,
            diet::update_task,
            diet::delete_task,
            diet::set_goal_task,
            diet::log_task_done,
            diet::log_one_off_task,
            diet::get_today_tasks,
            diet::delete_task_done,
            diet::set_height,
            diet::record_weight,
            commands::get_stats,
            commands::get_dictionary,
            commands::get_idioms,
            commands::get_pronunciations,
            commands::get_word_notes,
            commands::get_word_tags,
            commands::reset_progress,
            commands::log_debug,
            exam::start_exam,
            exam::finish_exam,
            exam::get_exam_progress,
            exam::save_exam_progress,
            exam::discard_exam_progress,
            exam::get_exam_review,
            exam::answer_exam_review,
            favorite::get_favorite_keys,
            favorite::set_question_favorite,
            favorite::set_exam_favorite,
            favorite::list_favorites,
            favorite::review_favorite,
            recipe::list_recipe_words,
            recipe::add_recipe_word,
            recipe::review_recipe_word,
            recipe::set_recipe_mastered,
            recipe::set_recipe_words_mastered,
            recipe::set_recipe_favorite,
            recipe::set_recipe_words_favorite,
            recipe::exclude_recipe_words,
            recipe::delete_recipe_words,
            recipe::get_usage_meanings,
            speech::speech_capabilities,
            speech::native_synthesize,
            speech::native_synthesize_all,
            speech::native_recognize,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Calorie Quest");
}
