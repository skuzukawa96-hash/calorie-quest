use chrono::{Local, TimeDelta};
use std::time::{SystemTime, UNIX_EPOCH};

/// Local calendar date as YYYY-MM-DD (streaks and SRS due dates are day-based).
pub fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

/// Local timestamp without timezone, sortable as a string.
pub fn now_ts() -> String {
    Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

pub fn date_plus(days: i64) -> String {
    (Local::now().date_naive() + TimeDelta::days(days))
        .format("%Y-%m-%d")
        .to_string()
}

/// Splits English text into lookup-ready words: lowercase, hyphens broken apart,
/// possessives dropped. The frontend tokenizes hovered text the same way.
///
/// Accents, digits and the dots inside an abbreviation are part of a word, not separators:
/// splitting on them turned "papier-mâché" into "m" and "ch", "K9" into "k" and "a.m." into "a"
/// and "m" — fragments no gloss can honestly describe. A run of digits on its own ("1995") is
/// dropped, since a year is not vocabulary.
pub fn tokens(text: &str) -> Vec<String> {
    text.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '\'' || c == '.' { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .map(|w| {
            w.trim_matches(|c: char| c == '\'' || c == '.')
                .trim_end_matches("'s")
                .to_string()
        })
        .filter(|w| w.chars().any(char::is_alphabetic))
        .collect()
}

/// Irregular verb forms, which no suffix rule can undo.
const IRREGULAR: &[(&str, &str)] = &[
    ("was", "be"), ("were", "be"), ("been", "be"), ("is", "be"), ("are", "be"), ("am", "be"),
    ("had", "have"), ("has", "have"), ("did", "do"), ("does", "do"), ("done", "do"),
    ("went", "go"), ("gone", "go"), ("came", "come"), ("saw", "see"), ("seen", "see"),
    ("took", "take"), ("taken", "take"), ("made", "make"), ("said", "say"), ("got", "get"),
    ("gotten", "get"), ("knew", "know"), ("known", "know"), ("thought", "think"),
    ("found", "find"), ("told", "tell"), ("became", "become"), ("left", "leave"),
    ("felt", "feel"), ("brought", "bring"), ("began", "begin"), ("begun", "begin"),
    ("kept", "keep"), ("held", "hold"), ("wrote", "write"), ("written", "write"),
    ("stood", "stand"), ("heard", "hear"), ("meant", "mean"), ("met", "meet"), ("ran", "run"),
    ("paid", "pay"), ("sat", "sit"), ("spoke", "speak"), ("spoken", "speak"), ("led", "lead"),
    ("grew", "grow"), ("grown", "grow"), ("lost", "lose"), ("fell", "fall"), ("fallen", "fall"),
    ("sent", "send"), ("built", "build"), ("understood", "understand"), ("drew", "draw"),
    ("drawn", "draw"), ("broke", "break"), ("broken", "break"), ("spent", "spend"),
    ("rose", "rise"), ("risen", "rise"), ("drove", "drive"), ("driven", "drive"),
    ("bought", "buy"), ("wore", "wear"), ("worn", "wear"), ("chose", "choose"),
    ("chosen", "choose"), ("ate", "eat"), ("eaten", "eat"), ("gave", "give"), ("given", "give"),
    ("slept", "sleep"), ("won", "win"), ("taught", "teach"), ("caught", "catch"),
    ("bitten", "bite"), ("threw", "throw"), ("thrown", "throw"), ("stole", "steal"),
    ("stolen", "steal"), ("bent", "bend"), ("forgot", "forget"), ("forgotten", "forget"),
    ("swam", "swim"), ("drank", "drink"), ("drunk", "drink"), ("sang", "sing"), ("sung", "sing"),
    ("woke", "wake"), ("woken", "wake"), ("hung", "hang"), ("blew", "blow"), ("blown", "blow"),
    ("flew", "fly"), ("flown", "fly"), ("slid", "slide"), ("swum", "swim"), ("lent", "lend"),
    ("stuck", "stick"), ("swept", "sweep"), ("dug", "dig"), ("hid", "hide"), ("shook", "shake"),
    ("threw", "throw"), ("rang", "ring"), ("rung", "ring"), ("sank", "sink"), ("laid", "lay"),
];

/// Candidate dictionary forms for an inflected English word ("studies" → study, "running" → run).
/// Deliberately over-generates: a wrong candidate simply misses in the dictionary.
pub fn lemmas(word: &str) -> Vec<String> {
    let w = word.to_lowercase();
    let mut out = vec![w.clone()];
    if let Some((_, base)) = IRREGULAR.iter().find(|(form, _)| *form == w) {
        out.push((*base).to_string());
    }
    let chars: Vec<char> = w.chars().collect();
    let n = chars.len();
    let doubled_tail = |cut: usize| -> bool { n > cut + 1 && chars[n - cut - 1] == chars[n - cut - 2] };
    let cut = |k: usize| -> String { chars[..n.saturating_sub(k)].iter().collect() };

    if w.ends_with("ies") && n > 3 {
        out.push(format!("{}y", cut(3)));
    }
    if w.ends_with("es") && n > 2 {
        out.push(cut(2));
    }
    if w.ends_with('s') && n > 1 {
        out.push(cut(1));
    }
    if w.ends_with("ied") && n > 3 {
        out.push(format!("{}y", cut(3)));
    }
    if w.ends_with("ed") && n > 2 {
        out.push(cut(2));
        out.push(cut(1));
        if doubled_tail(2) {
            out.push(cut(3));
        }
    }
    if w.ends_with("ing") && n > 3 {
        out.push(cut(3));
        out.push(format!("{}e", cut(3)));
        if doubled_tail(3) {
            out.push(cut(4));
        }
    }
    if w.ends_with("er") && n > 2 {
        out.push(cut(2));
        out.push(cut(1));
        if doubled_tail(2) {
            out.push(cut(3)); // bigger → big
        }
    }
    if w.ends_with("est") && n > 3 {
        out.push(cut(3));
        out.push(cut(2));
        if doubled_tail(3) {
            out.push(cut(4));
        }
    }
    if w.ends_with("ly") && n > 2 {
        out.push(cut(2));
    }
    // Words ending in -y switch to -i before a suffix (busy → busier, early → earliest).
    for i in 0..out.len() {
        if out[i].ends_with('i') {
            let mut y = out[i].clone();
            y.pop();
            y.push('y');
            out.push(y);
        }
    }
    out.retain(|s| !s.is_empty());
    out.dedup();
    out
}

/// Tiny xorshift shuffle so we don't need the `rand` crate for a 4-option quiz.
pub fn shuffle<T>(v: &mut [T]) {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x1234_5678);
    let mut s = (nanos ^ 0x9E37_79B9_7F4A_7C15) | 1;
    for i in (1..v.len()).rev() {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        let j = (s % (i as u64 + 1)) as usize;
        v.swap(i, j);
    }
}

#[cfg(test)]
mod tests {
    use super::lemmas;

    #[test]
    fn finds_dictionary_forms() {
        assert!(lemmas("studies").contains(&"study".to_string()));
        assert!(lemmas("running").contains(&"run".to_string()));
        assert!(lemmas("stopped").contains(&"stop".to_string()));
        assert!(lemmas("making").contains(&"make".to_string()));
        assert!(lemmas("boxes").contains(&"box".to_string()));
        assert!(lemmas("quickly").contains(&"quick".to_string()));
        assert!(lemmas("apple").contains(&"apple".to_string()));
        assert!(lemmas("bigger").contains(&"big".to_string()));
        assert!(lemmas("lost").contains(&"lose".to_string()));
        assert!(lemmas("fell").contains(&"fall".to_string()));
        assert!(lemmas("brought").contains(&"bring".to_string()));
    }

    #[test]
    fn splits_text_into_lookup_words() {
        assert_eq!(super::tokens("Caught red-handed!"), ["caught", "red", "handed"]);
        assert_eq!(super::tokens("my mother's car"), ["my", "mother", "car"]);
        assert_eq!(super::tokens("You'd better go."), ["you'd", "better", "go"]);
    }
}
