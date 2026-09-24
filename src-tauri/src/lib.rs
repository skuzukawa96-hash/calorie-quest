mod commands;
mod db;
mod models;
mod recipe;
mod speech;
mod srs;
mod util;

use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub db: Mutex<rusqlite::Connection>,
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let conn = db::init(&dir.join("calorie_quest.db"))?;
            app.manage(AppState { db: Mutex::new(conn) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_dashboard,
            commands::get_session_questions,
            commands::submit_answer,
            commands::list_snacks,
            commands::add_snack,
            commands::delete_snack,
            commands::set_goal_snack,
            commands::log_snack_eaten,
            commands::get_today_consumption,
            commands::delete_consumption,
            commands::redeem_cheat_ticket,
            commands::get_stats,
            commands::get_dictionary,
            commands::reset_progress,
            commands::log_debug,
            recipe::list_recipe_words,
            recipe::add_recipe_word,
            recipe::review_recipe_word,
            recipe::set_recipe_mastered,
            recipe::delete_recipe_words,
            speech::speech_capabilities,
            speech::native_synthesize,
            speech::native_recognize,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Calorie Quest");
}
