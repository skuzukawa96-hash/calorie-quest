use crate::models::{Question, Snack};
use crate::util::now_ts;
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::path::Path;

pub const Q_COLS: &str =
    "q.id, q.key, q.kind, q.difficulty, q.en, q.ja, q.modes, q.choices, q.prompt, q.hint, q.audio_path, q.category";

/// Main seed file: carries the seed `version` plus the original question set.
const QUESTIONS_JSON: &str = include_str!("../data/questions.json");
/// Additional question packs (plain JSON arrays). Add a file here and bump `version` in questions.json.
const EXTRA_QUESTION_PACKS: &[(&str, &str)] = &[
    ("words-2a.json", include_str!("../data/words-2a.json")),
    ("words-2b.json", include_str!("../data/words-2b.json")),
    ("phrases-2.json", include_str!("../data/phrases-2.json")),
    ("grammar-2.json", include_str!("../data/grammar-2.json")),
    ("idioms-2.json", include_str!("../data/idioms-2.json")),
    ("sentences-2.json", include_str!("../data/sentences-2.json")),
];

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'Player',
  total_study_days INTEGER NOT NULL DEFAULT 0,
  current_streak INTEGER NOT NULL DEFAULT 0,
  longest_streak INTEGER NOT NULL DEFAULT 0,
  last_study_date TEXT,
  goal_snack_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  en TEXT NOT NULL,
  ja TEXT NOT NULL,
  modes TEXT NOT NULL,
  choices TEXT,
  prompt TEXT,
  hint TEXT,
  audio_path TEXT,
  category TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS learning_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  correct_count INTEGER NOT NULL DEFAULT 0,
  wrong_count INTEGER NOT NULL DEFAULT 0,
  last_correct INTEGER,
  last_score REAL,
  srs_level INTEGER NOT NULL DEFAULT 0,
  needs_review INTEGER NOT NULL DEFAULT 0,
  last_studied_at TEXT NOT NULL,
  next_due_at TEXT,
  UNIQUE(user_id, question_id)
);
CREATE TABLE IF NOT EXISTS answer_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  mode TEXT NOT NULL,
  correct INTEGER NOT NULL,
  score REAL,
  kcal INTEGER NOT NULL,
  is_review INTEGER NOT NULL DEFAULT 0,
  answered_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_stats (
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  kcal_earned INTEGER NOT NULL DEFAULT 0,
  kcal_consumed INTEGER NOT NULL DEFAULT 0,
  answered INTEGER NOT NULL DEFAULT 0,
  correct INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);
CREATE TABLE IF NOT EXISTS snacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  calories INTEGER NOT NULL,
  icon TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS consumption_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  snack_id INTEGER,
  snack_name TEXT NOT NULL,
  snack_icon TEXT NOT NULL,
  calories INTEGER NOT NULL,
  date TEXT NOT NULL,
  eaten_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cheat_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  issued_at TEXT NOT NULL,
  issued_for_streak INTEGER NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_history_due ON learning_history (user_id, needs_review, next_due_at);
CREATE INDEX IF NOT EXISTS idx_log_date ON answer_log (user_id, answered_at);
";

const BUILTIN_SNACKS: &[(&str, i64, &str)] = &[
    ("クッキー 1枚", 50, "🍪"),
    ("チョコレート 数かけ", 100, "🍫"),
    ("せんべい 2枚", 100, "🍘"),
    ("グミ 1袋", 120, "🍬"),
    ("プリン", 150, "🍮"),
    ("大福", 230, "🍡"),
    ("アイスクリーム 1個", 250, "🍦"),
    ("ドーナツ", 300, "🍩"),
    ("ポテトチップス 1袋", 330, "🥨"),
    ("ショートケーキ", 350, "🍰"),
];

#[derive(serde::Deserialize)]
struct SeedFile {
    version: i64,
    questions: Vec<SeedQuestion>,
}

#[derive(serde::Deserialize)]
struct SeedQuestion {
    key: String,
    kind: String,
    difficulty: String,
    en: String,
    ja: String,
    modes: Vec<String>,
    #[serde(default)]
    choices: Option<Vec<String>>,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    hint: Option<String>,
    #[serde(default)]
    audio_path: Option<String>,
    /// Genre such as 食べ物 / 旅行・交通 / 文法; empty when unknown.
    #[serde(default)]
    category: String,
}

pub fn init(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    setup(conn)
}

/// In-memory database with the same schema and seed data (used by tests).
#[cfg(test)]
pub fn init_in_memory() -> rusqlite::Result<Connection> {
    setup(Connection::open_in_memory()?)
}

fn setup(conn: Connection) -> rusqlite::Result<Connection> {
    conn.execute_batch(SCHEMA)?;
    ensure_column(&conn, "questions", "category", "TEXT NOT NULL DEFAULT ''")?;
    conn.execute(
        "INSERT OR IGNORE INTO users (id, name, created_at) VALUES (1, 'Player', ?1)",
        params![now_ts()],
    )?;
    seed_questions(&conn)?;
    seed_snacks(&conn)?;
    Ok(conn)
}

/// Adds a column to an existing table (databases created by older builds).
fn ensure_column(conn: &Connection, table: &str, column: &str, ddl: &str) -> rusqlite::Result<()> {
    let exists = {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let names = stmt.query_map([], |r| r.get::<_, String>(1))?;
        let found = names.filter_map(Result::ok).any(|n| n == column);
        found
    };
    if !exists {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {ddl}"))?;
    }
    Ok(())
}

pub fn meta_get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", params![key], |r| r.get(0))
        .optional()
}

pub fn meta_set(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// Parses every bundled question file. Panics on malformed data: the files ship inside the binary,
/// so a mistake there is a build problem, not a runtime condition.
fn load_seed() -> SeedFile {
    let mut seed: SeedFile =
        serde_json::from_str(QUESTIONS_JSON).expect("data/questions.json must be valid JSON");
    for (name, json) in EXTRA_QUESTION_PACKS {
        let pack: Vec<SeedQuestion> =
            serde_json::from_str(json).unwrap_or_else(|e| panic!("data/{name} must be a valid JSON array: {e}"));
        seed.questions.extend(pack);
    }
    seed
}

fn seed_questions(conn: &Connection) -> rusqlite::Result<()> {
    let seed = load_seed();
    let current: i64 = meta_get(conn, "seed_version")?
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if current >= seed.version {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO questions (key, kind, difficulty, en, ja, modes, choices, prompt, hint, audio_path, category)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, difficulty = excluded.difficulty,
               en = excluded.en, ja = excluded.ja, modes = excluded.modes, choices = excluded.choices,
               prompt = excluded.prompt, hint = excluded.hint, audio_path = excluded.audio_path,
               category = excluded.category",
        )?;
        for q in &seed.questions {
            let modes = serde_json::to_string(&q.modes).unwrap_or_else(|_| "[]".into());
            let choices = q
                .choices
                .as_ref()
                .map(|c| serde_json::to_string(c).unwrap_or_default());
            stmt.execute(params![
                q.key, q.kind, q.difficulty, q.en, q.ja, modes, choices, q.prompt, q.hint, q.audio_path, q.category
            ])?;
        }
    }
    meta_set(&tx, "seed_version", &seed.version.to_string())?;
    tx.commit()
}

fn seed_snacks(conn: &Connection) -> rusqlite::Result<()> {
    if meta_get(conn, "snacks_seeded")?.is_some() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    for (name, kcal, icon) in BUILTIN_SNACKS {
        tx.execute(
            "INSERT INTO snacks (name, calories, icon, is_builtin, created_at) VALUES (?1, ?2, ?3, 1, ?4)",
            params![name, kcal, icon, now_ts()],
        )?;
    }
    meta_set(&tx, "snacks_seeded", "1")?;
    tx.commit()
}

pub fn row_to_question(row: &Row) -> rusqlite::Result<Question> {
    let modes: String = row.get(6)?;
    let choices: Option<String> = row.get(7)?;
    Ok(Question {
        id: row.get(0)?,
        key: row.get(1)?,
        kind: row.get(2)?,
        difficulty: row.get(3)?,
        en: row.get(4)?,
        ja: row.get(5)?,
        modes: serde_json::from_str(&modes).unwrap_or_default(),
        choices: choices.and_then(|c| serde_json::from_str(&c).ok()),
        prompt: row.get(8)?,
        hint: row.get(9)?,
        audio_path: row.get(10)?,
        category: row.get(11)?,
    })
}

pub fn row_to_snack(row: &Row) -> rusqlite::Result<Snack> {
    Ok(Snack {
        id: row.get(0)?,
        name: row.get(1)?,
        calories: row.get(2)?,
        icon: row.get(3)?,
        is_builtin: row.get::<_, i64>(4)? != 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    #[test]
    fn seed_data_is_well_formed_and_has_at_least_1000_questions() {
        let seed = load_seed();
        assert!(seed.questions.len() >= 1000, "expected >= 1000 questions, got {}", seed.questions.len());

        let mut keys = HashSet::new();
        let mut ja_by_group: HashMap<(String, String), HashSet<String>> = HashMap::new();
        for q in &seed.questions {
            assert!(keys.insert(q.key.as_str()), "duplicate key {}", q.key);
            assert!(!q.category.is_empty(), "{} has no category", q.key);
            assert!(["low", "mid", "high"].contains(&q.difficulty.as_str()), "{} bad difficulty", q.key);
            assert!(["word", "phrase", "grammar", "idiom", "sentence"].contains(&q.kind.as_str()), "{} bad kind", q.key);
            assert!(!q.modes.is_empty() && q.modes.iter().all(|m| ["choice", "typing", "speaking"].contains(&m.as_str())), "{} bad modes", q.key);
            assert!(!q.en.trim().is_empty() && !q.ja.trim().is_empty(), "{} empty text", q.key);
            if q.kind == "grammar" {
                let choices = q.choices.as_ref().unwrap_or_else(|| panic!("{} grammar needs choices", q.key));
                assert_eq!(choices.len(), 4, "{} needs 4 choices", q.key);
                assert!(choices.contains(&q.en), "{} answer must be among the choices", q.key);
                assert_eq!(choices.iter().collect::<HashSet<_>>().len(), 4, "{} choices must be distinct", q.key);
                assert!(q.prompt.as_deref().map(|p| p.contains("___")).unwrap_or(false), "{} prompt needs ___", q.key);
            }
            // Same-genre distractors are drawn from `ja`, so translations must not collide within a genre.
            if q.kind == "word" {
                let set = ja_by_group.entry((q.category.clone(), q.kind.clone())).or_default();
                assert!(set.insert(q.ja.clone()), "{}: duplicate translation '{}' in genre {}", q.key, q.ja, q.category);
            }
        }
    }

    #[test]
    fn database_contains_every_seed_question() {
        let conn = init_in_memory().unwrap();
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM questions", [], |r| r.get(0)).unwrap();
        assert_eq!(rows as usize, load_seed().questions.len());
    }
}
