use std::{env, fs, path::PathBuf};

fn main() {
    generate_question_pack_list();
    tauri_build::build()
}

/// Every JSON in `data/` except the seed file, the glossary, the grammar notes, the
/// pronunciations, the word parts and the tabs of example sentences is a question pack. The list used to
/// be typed out by hand in `db.rs` and again in `mockBackend.ts`, so a new pack could be registered
/// on one side only and silently change the question set on just that platform. Deriving it from
/// the directory makes the files on disk the single source of truth; `include_str!` still embeds
/// them, so the binary stays self-contained.
fn generate_question_pack_list() {
    let data = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("data");
    println!("cargo:rerun-if-changed={}", data.display());

    let mut packs: Vec<String> = fs::read_dir(&data)
        .expect("src-tauri/data must exist")
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| is_pack(name))
        .collect();
    packs.sort_by_key(|name| sort_key(name));

    let entries: String = packs
        .iter()
        .map(|name| {
            let path = data.join(name).to_string_lossy().into_owned();
            format!("    ({name:?}, include_str!({path:?})),\n")
        })
        .collect();

    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join("question_packs.rs");
    fs::write(out, format!("&[\n{entries}]")).expect("failed to write the pack list");
}

fn is_pack(name: &str) -> bool {
    name.ends_with(".json")
        && name != "questions.json"
        && name != "glossary.json"
        && name != "grammar-notes.json"
        && name != "pronunciations.json"
        && name != "word-parts.json"
        && name != "tiers.json"
        && name != "word-examples.json"
        && name != "word-usage.json"
        && name != "idiom-origins.json"
        && name != "word-related.json"
        && name != "word-pos.json"
        && name != "word-confusables.json"
        && name != "word-families.json"
        && name != "irregular-verbs.json"
        && name != "verb-types.json"
        && name != "glossary-pos.json"
        && name != "retired-words.json"
        && name != "pos-order.json"
        && name != "sense-pos.json"
        && name != "homonyms.json"
        && !name.starts_with("exam-")
}

/// Groups packs by family and orders them numerically, so `-2` comes before `-10` and the seeded
/// order stays the one a reader would expect rather than "-10, -11, -2". A trailing letter is kept
/// as a tiebreaker so words-2a and words-2b sit together just before words-3.
fn sort_key(name: &str) -> (String, u32, String) {
    let stem = name.trim_end_matches(".json");
    let Some((family, tail)) = stem.rsplit_once('-') else {
        return (stem.to_string(), 0, String::new());
    };
    let digits: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
    match digits.parse() {
        Ok(n) => (family.to_string(), n, tail[digits.len()..].to_string()),
        // No number at all ("listening-dialogues"): order by the whole stem, ahead of its numbered siblings.
        Err(_) => (stem.to_string(), 0, String::new()),
    }
}
