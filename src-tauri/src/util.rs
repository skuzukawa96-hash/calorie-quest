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
pub fn tokens(text: &str) -> Vec<String> {
    text.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphabetic() || c == '\'' { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .map(|w| w.trim_matches('\'').trim_end_matches("'s").to_string())
        .filter(|w| !w.is_empty())
        .collect()
}

/// Candidate dictionary forms for an inflected English word ("studies" → study, "running" → run).
/// Deliberately over-generates: a wrong candidate simply misses in the dictionary.
pub fn lemmas(word: &str) -> Vec<String> {
    let w = word.to_lowercase();
    let mut out = vec![w.clone()];
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
    }

    #[test]
    fn splits_text_into_lookup_words() {
        assert_eq!(super::tokens("Caught red-handed!"), ["caught", "red", "handed"]);
        assert_eq!(super::tokens("my mother's car"), ["my", "mother", "car"]);
        assert_eq!(super::tokens("You'd better go."), ["you'd", "better", "go"]);
    }
}
