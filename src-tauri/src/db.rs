use crate::models::{Question, Snack};
use crate::util::now_ts;
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::collections::HashMap;
use std::path::Path;

pub const Q_COLS: &str =
    "q.id, q.key, q.kind, q.difficulty, q.en, q.ja, q.modes, q.choices, q.prompt, q.hint, q.audio_path, q.category, q.word_group, q.example, q.example_ja";

/// Main seed file: carries the seed `version` plus the original question set.
const QUESTIONS_JSON: &str = include_str!("../data/questions.json");
/// Additional question packs (plain JSON arrays). Add a file here and bump `version` in questions.json.
const EXTRA_QUESTION_PACKS: &[(&str, &str)] = &[
    ("words-2a.json", include_str!("../data/words-2a.json")),
    ("words-2b.json", include_str!("../data/words-2b.json")),
    ("words-3.json", include_str!("../data/words-3.json")),
    ("words-4.json", include_str!("../data/words-4.json")),
    ("words-5.json", include_str!("../data/words-5.json")),
    ("words-6.json", include_str!("../data/words-6.json")),
    ("words-7.json", include_str!("../data/words-7.json")),
    ("words-8.json", include_str!("../data/words-8.json")),
    ("words-9.json", include_str!("../data/words-9.json")),
    ("words-10.json", include_str!("../data/words-10.json")),
    ("words-11.json", include_str!("../data/words-11.json")),
    ("words-12.json", include_str!("../data/words-12.json")),
    ("words-13.json", include_str!("../data/words-13.json")),
    ("phrases-2.json", include_str!("../data/phrases-2.json")),
    ("phrases-3.json", include_str!("../data/phrases-3.json")),
    ("phrases-4.json", include_str!("../data/phrases-4.json")),
    ("phrases-5.json", include_str!("../data/phrases-5.json")),
    ("phrases-6.json", include_str!("../data/phrases-6.json")),
    ("phrases-7.json", include_str!("../data/phrases-7.json")),
    ("phrases-8.json", include_str!("../data/phrases-8.json")),
    ("grammar-2.json", include_str!("../data/grammar-2.json")),
    ("grammar-3.json", include_str!("../data/grammar-3.json")),
    ("grammar-4.json", include_str!("../data/grammar-4.json")),
    ("grammar-5.json", include_str!("../data/grammar-5.json")),
    ("grammar-6.json", include_str!("../data/grammar-6.json")),
    ("grammar-7.json", include_str!("../data/grammar-7.json")),
    ("idioms-2.json", include_str!("../data/idioms-2.json")),
    ("idioms-3.json", include_str!("../data/idioms-3.json")),
    ("idioms-4.json", include_str!("../data/idioms-4.json")),
    ("idioms-5.json", include_str!("../data/idioms-5.json")),
    ("idioms-6.json", include_str!("../data/idioms-6.json")),
    ("idioms-7.json", include_str!("../data/idioms-7.json")),
    ("sentences-2.json", include_str!("../data/sentences-2.json")),
    ("sentences-3.json", include_str!("../data/sentences-3.json")),
    ("sentences-4.json", include_str!("../data/sentences-4.json")),
    ("sentences-5.json", include_str!("../data/sentences-5.json")),
    ("sentences-6.json", include_str!("../data/sentences-6.json")),
    ("sentences-7.json", include_str!("../data/sentences-7.json")),
    ("listening-dialogues.json", include_str!("../data/listening-dialogues.json")),
    ("listening-dialogues-2.json", include_str!("../data/listening-dialogues-2.json")),
    ("listening-dialogues-3.json", include_str!("../data/listening-dialogues-3.json")),
    ("listening-dialogues-4.json", include_str!("../data/listening-dialogues-4.json")),
    ("listening-dialogues-5.json", include_str!("../data/listening-dialogues-5.json")),
    ("listening-dialogues-6.json", include_str!("../data/listening-dialogues-6.json")),
    ("listening-dialogues-7.json", include_str!("../data/listening-dialogues-7.json")),
];
/// Japanese glosses for words that appear inside sentences but are not questions themselves.
const GLOSSARY_JSON: &str = include_str!("../data/glossary.json");

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
  category TEXT NOT NULL DEFAULT '',
  word_group TEXT NOT NULL DEFAULT '',
  example TEXT,
  example_ja TEXT
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
    /// Fine-grained semantic field used for distractors; empty falls back to the genre.
    #[serde(default)]
    group: String,
    /// Sentence showing an idiom in use, plus its Japanese translation.
    #[serde(default)]
    example: Option<String>,
    #[serde(default, rename = "exampleJa")]
    example_ja: Option<String>,
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
    ensure_column(&conn, "questions", "word_group", "TEXT NOT NULL DEFAULT ''")?;
    ensure_column(&conn, "questions", "example", "TEXT")?;
    ensure_column(&conn, "questions", "example_ja", "TEXT")?;
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
            "INSERT INTO questions (key, kind, difficulty, en, ja, modes, choices, prompt, hint, audio_path, category, word_group, example, example_ja)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, difficulty = excluded.difficulty,
               en = excluded.en, ja = excluded.ja, modes = excluded.modes, choices = excluded.choices,
               prompt = excluded.prompt, hint = excluded.hint, audio_path = excluded.audio_path,
               category = excluded.category, word_group = excluded.word_group,
               example = excluded.example, example_ja = excluded.example_ja",
        )?;
        for q in &seed.questions {
            let modes = serde_json::to_string(&q.modes).unwrap_or_else(|_| "[]".into());
            let choices = q
                .choices
                .as_ref()
                .map(|c| serde_json::to_string(c).unwrap_or_default());
            let group = if q.group.is_empty() { &q.category } else { &q.group };
            stmt.execute(params![
                q.key, q.kind, q.difficulty, q.en, q.ja, modes, choices, q.prompt, q.hint, q.audio_path, q.category,
                group, q.example, q.example_ja
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
        group: row.get(12)?,
        example: row.get(13)?,
        example_ja: row.get(14)?,
    })
}

/// English word (lowercase) → Japanese gloss, for the hover dictionary.
///
/// Built from the word questions plus the glossary of supporting vocabulary, then expanded so that
/// every inflected form appearing in a question ("studies", "running") is a key in its own right.
/// That keeps the frontend to a plain lookup.
pub fn dictionary(conn: &Connection) -> rusqlite::Result<HashMap<String, String>> {
    let mut map: HashMap<String, String> =
        serde_json::from_str(GLOSSARY_JSON).expect("data/glossary.json must be a valid JSON object");

    {
        let mut stmt = conn.prepare("SELECT en, ja FROM questions WHERE kind = 'word'")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for row in rows {
            let (en, ja) = row?;
            // Question data wins over the glossary: it is the vocabulary being studied.
            for word in crate::util::tokens(&en) {
                map.entry(word).or_insert_with(|| ja.clone());
            }
            map.insert(en.to_lowercase(), ja);
        }
    }

    let texts: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT en, COALESCE(prompt, ''), COALESCE(choices, ''), COALESCE(example, '') FROM questions")?;
        let rows = stmt.query_map([], |r| {
            Ok(format!(
                "{} {} {} {}",
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?
            ))
        })?;
        rows.collect::<Result<_, _>>()?
    };
    let mut derived: HashMap<String, String> = HashMap::new();
    for text in &texts {
        for word in crate::util::tokens(text) {
            if map.contains_key(&word) || derived.contains_key(&word) {
                continue;
            }
            if let Some(gloss) = crate::util::lemmas(&word).iter().find_map(|l| map.get(l)) {
                derived.insert(word, gloss.clone());
            }
        }
    }
    map.extend(derived);
    Ok(map)
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
    fn seed_data_is_well_formed_and_has_at_least_10000_questions() {
        let seed = load_seed();
        assert!(seed.questions.len() >= 10000, "expected >= 10000 questions, got {}", seed.questions.len());

        let mut keys = HashSet::new();
        let mut ja_by_group: HashMap<(String, String), HashSet<String>> = HashMap::new();
        let mut group_sizes: HashMap<(String, String), usize> = HashMap::new();
        for q in &seed.questions {
            assert!(keys.insert(q.key.as_str()), "duplicate key {}", q.key);
            assert!(!q.category.is_empty(), "{} has no category", q.key);
            assert!(!q.group.is_empty(), "{} has no group", q.key);
            assert!(["low", "mid", "high"].contains(&q.difficulty.as_str()), "{} bad difficulty", q.key);
            assert!(
                ["word", "phrase", "grammar", "idiom", "sentence", "dialogue"].contains(&q.kind.as_str()),
                "{} bad kind",
                q.key
            );
            assert!(
                !q.modes.is_empty()
                    && q.modes.iter().all(|m| ["choice", "typing", "speaking", "listening"].contains(&m.as_str())),
                "{} bad modes",
                q.key
            );
            assert!(!q.en.trim().is_empty() && !q.ja.trim().is_empty(), "{} empty text", q.key);
            if q.kind == "grammar" || q.kind == "dialogue" {
                let choices = q.choices.as_ref().unwrap_or_else(|| panic!("{} needs choices", q.key));
                assert_eq!(choices.len(), 4, "{} needs 4 choices", q.key);
                assert!(choices.contains(&q.en), "{} answer must be among the choices", q.key);
                assert_eq!(choices.iter().collect::<HashSet<_>>().len(), 4, "{} choices must be distinct", q.key);
                let prompt = q.prompt.as_deref().unwrap_or_else(|| panic!("{} needs a prompt", q.key));
                if q.kind == "grammar" {
                    assert!(prompt.contains("___"), "{} prompt needs ___", q.key);
                } else {
                    assert!(!prompt.trim().is_empty(), "{} prompt is empty", q.key);
                }
            }
            // Every idiom shows a sentence using the expression, so the learner sees it in context.
            if q.kind == "idiom" {
                let example = q.example.as_deref().unwrap_or_else(|| panic!("{} needs an example", q.key));
                let example_ja = q.example_ja.as_deref().unwrap_or_else(|| panic!("{} needs exampleJa", q.key));
                assert!(!example.trim().is_empty() && !example_ja.trim().is_empty(), "{} has an empty example", q.key);
                // The example must actually contain the idiom's key words, not just any sentence.
                let head: Vec<String> = crate::util::tokens(&q.en)
                    .into_iter()
                    .filter(|w| !["a", "an", "the", "your", "you", "someone", "something", "it", "of", "in", "on"].contains(&w.as_str()))
                    .collect();
                let example_words = crate::util::tokens(example);
                let hit = head.iter().filter(|w| {
                    example_words.iter().any(|e| e == *w || crate::util::lemmas(e).contains(w))
                });
                assert!(hit.count() >= head.len().min(2), "{}: example does not use the idiom: {example}", q.key);
            }
            // Distractors are drawn from `ja` within the same semantic group, so they must be distinct there.
            if q.kind == "word" {
                let set = ja_by_group.entry((q.group.clone(), q.kind.clone())).or_default();
                assert!(set.insert(q.ja.clone()), "{}: duplicate translation '{}' in group {}", q.key, q.ja, q.group);
            }
            *group_sizes.entry((q.group.clone(), q.kind.clone())).or_default() += 1;
        }
        // Every group needs 4 members so a question can be surrounded by same-field distractors.
        // Dialogues are exempt: their replies are written out in the data, not drawn from siblings.
        for ((group, kind), n) in &group_sizes {
            if kind == "dialogue" {
                continue;
            }
            assert!(*n >= 4, "group {group} ({kind}) has only {n} questions; needs at least 4");
        }
    }

    #[test]
    fn database_contains_every_seed_question() {
        let conn = init_in_memory().unwrap();
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM questions", [], |r| r.get(0)).unwrap();
        assert_eq!(rows as usize, load_seed().questions.len());
    }

    /// The hover dictionary must cover the vocabulary used inside multi-word questions.
    #[test]
    fn dictionary_covers_words_used_in_sentences() {
        let conn = init_in_memory().unwrap();
        let dict = dictionary(&conn).unwrap();
        assert!(dict.len() > 1000, "dictionary too small: {}", dict.len());

        let mut uncovered: Vec<String> = Vec::new();
        for q in load_seed().questions.iter().filter(|q| q.kind != "word") {
            let mut texts = vec![q.en.clone()];
            if let Some(p) = &q.prompt {
                texts.push(p.clone());
            }
            texts.extend(q.choices.clone().unwrap_or_default());
            texts.extend(q.example.clone());
            for text in texts {
                for word in crate::util::tokens(&text) {
                    if !dict.contains_key(&word) {
                        uncovered.push(format!("{} ({})", word, q.key));
                    }
                }
            }
        }
        uncovered.sort();
        uncovered.dedup();
        assert!(uncovered.is_empty(), "words without a gloss: {}", uncovered.join(", "));
    }
}
