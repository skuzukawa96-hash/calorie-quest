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

use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
    /// what the home screen counts of the question bank, counted once (`commands::BankCounts`)
    pub bank: Mutex<Option<commands::BankCounts>>,
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let conn = db::init(&dir.join(backup::DB_FILE))?;
            app.manage(AppState { db: Mutex::new(conn), bank: Mutex::new(None) });
            // The notes' tables, ready before the first お気に入り or answer asks for them, and
            // LexiLink's 対義語 before the first game of Opposites.
            std::thread::spawn(|| {
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
