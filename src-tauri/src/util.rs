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
    ("sold", "sell"),
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

/// The choice that means "no article here" in a grammar question ("She goes to ___ school").
pub const NO_WORD: &str = "(none)";

/// A grammar prompt with its blank filled in. Picking "no article" leaves nothing in the gap, so
/// the blank goes together with one of the spaces around it: the completed sentence is shown and
/// read aloud, and "She goes to (none) school" is neither.
pub fn fill_blank(prompt: &str, answer: &str) -> String {
    if answer != NO_WORD {
        return prompt.replace("___", answer);
    }
    prompt.replace(" ___ ", " ").replace("___ ", "").replace(" ___", "").replace("___", "")
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

/* ---------- multi-word expressions ---------- */

const POSSESSIVES: &[&str] = &["my", "your", "his", "her", "its", "our", "their"];
const OBJECTS: &[&str] = &["me", "you", "him", "her", "it", "us", "them"];
const REFLEXIVES: &[&str] = &[
    "myself", "yourself", "himself", "herself", "itself", "ourselves", "yourselves", "themselves",
    "oneself",
];

/// Idioms are written with a stand-in pronoun ("keep your fingers crossed", "under someone's
/// nose") that the sentence fills with a real one ("kept my fingers crossed", "under her nose").
fn placeholder_matches(pattern: &str, word: &str) -> bool {
    match pattern {
        "your" | "my" | "his" | "her" | "their" | "our" | "its" => POSSESSIVES.contains(&word),
        // "someone's" loses its 's in tokens(), so it arrives here as "someone".
        "someone" | "somebody" | "one" => POSSESSIVES.contains(&word) || OBJECTS.contains(&word),
        "yourself" | "oneself" => REFLEXIVES.contains(&word),
        _ => false,
    }
}

/// Whether a word in a sentence can fill one slot of a phrase: the same word, an inflection of it
/// ("kept" for "keep", "bags" for "bag"), or a pronoun standing in for the idiom's placeholder.
pub fn phrase_token_matches(pattern: &str, word: &str) -> bool {
    pattern == word || placeholder_matches(pattern, word) || lemmas(word).iter().any(|l| l == pattern)
}

/// Every phrase in the dictionary, filed under the word it starts with so a sentence only tries the
/// handful that could begin at each position.
pub struct PhraseIndex {
    by_first: std::collections::HashMap<String, Vec<(Vec<String>, String)>>,
}

/// A run of words in a sentence that together form a dictionary phrase: `start..end` over the
/// sentence's words, and the phrase's dictionary form.
#[derive(Debug, Clone, PartialEq)]
pub struct PhraseSpan {
    pub start: usize,
    pub end: usize,
    pub key: String,
}

impl PhraseIndex {
    /// Builds the index from dictionary keys; single words are skipped, since a phrase needs two.
    pub fn new<'a>(keys: impl IntoIterator<Item = &'a String>) -> Self {
        let mut by_first: std::collections::HashMap<String, Vec<(Vec<String>, String)>> =
            std::collections::HashMap::new();
        for key in keys {
            let words = tokens(key);
            if words.len() < 2 {
                continue;
            }
            by_first.entry(words[0].clone()).or_default().push((words, key.clone()));
        }
        // Longest first, so "real estate agent" wins over a shorter phrase at the same spot.
        for list in by_first.values_mut() {
            list.sort_by(|a, b| b.0.len().cmp(&a.0.len()).then_with(|| a.1.cmp(&b.1)));
        }
        PhraseIndex { by_first }
    }

    /// The first-word keys a sentence word could be standing in for.
    fn candidates(&self, word: &str) -> Vec<String> {
        let mut out = lemmas(word);
        if POSSESSIVES.contains(&word) {
            out.extend(["your", "my", "his", "her", "their", "our", "its", "someone", "somebody", "one"].map(String::from));
        }
        if OBJECTS.contains(&word) {
            out.extend(["someone", "somebody", "one"].map(String::from));
        }
        if REFLEXIVES.contains(&word) {
            out.extend(["yourself", "oneself"].map(String::from));
        }
        out.sort();
        out.dedup();
        out
    }

    /// Left to right, longest match first; words covered by one phrase never start another.
    pub fn spans(&self, words: &[String]) -> Vec<PhraseSpan> {
        let mut out = Vec::new();
        let mut i = 0;
        while i < words.len() {
            let mut best: Option<(usize, &str)> = None;
            for first in self.candidates(&words[i]) {
                let Some(list) = self.by_first.get(&first) else { continue };
                for (pattern, key) in list {
                    if i + pattern.len() > words.len() || best.is_some_and(|(n, _)| n >= pattern.len()) {
                        continue;
                    }
                    let hit = pattern
                        .iter()
                        .zip(&words[i..])
                        .all(|(p, w)| phrase_token_matches(p, w));
                    if hit {
                        best = Some((pattern.len(), key.as_str()));
                    }
                }
            }
            match best {
                Some((n, key)) => {
                    out.push(PhraseSpan { start: i, end: i + n, key: key.to_string() });
                    i += n;
                }
                None => i += 1,
            }
        }
        out
    }
}

/// Determiners that read the same with a singular or a plural noun, so swapping the noun's number
/// leaves the phrase grammatical. "a" and "these" are deliberately absent: they pin the number.
const TWO_WAY_DETERMINERS: &[&str] = &["the", "his", "her", "my", "your", "our", "their", "its"];

/// Words that pin the noun to plural even through a determiner: "all the shelves" has no singular,
/// and neither does "one of the students".
const FORCES_PLURAL: &[&str] = &[
    "all", "both", "many", "few", "several", "numerous", "various", "most", "some", "one", "two",
    "three", "four", "five", "six", "seven", "eight", "nine", "ten", "dozens", "hundreds",
    "thousands", "plenty", "number", "group", "pair", "couple", "bunch", "lots", "none", "each",
    "every", "list", "series", "row", "line", "set",
];

/// Nouns English keeps plural. Answering "glass" for "glasses" is simply wrong, so these are left
/// alone rather than forgiven.
const ALWAYS_PLURAL: &[&str] = &[
    "glasses", "sunglasses", "scissors", "pants", "trousers", "jeans", "shorts", "pajamas",
    "clothes", "stairs", "headphones", "earphones", "binoculars", "tweezers", "pliers",
    "belongings", "goods", "groceries", "savings", "surroundings", "outskirts", "congratulations",
    "thanks", "means", "series", "species", "news", "mathematics", "physics", "economics",
    "politics", "remains", "arms", "hands", "eyes", "ears", "feet", "legs", "shoulders", "knees",
    "teeth", "fingers", "toes", "lips", "hips", "wrists", "ankles", "elbows", "nails", "lungs",
    "paws", "wings", "shoes", "socks", "gloves", "boots", "slippers", "chopsticks", "lines",
    "ropes", "books", "shots", "times", "words", "guns", "rules", "strings", "nerves", "cards",
    "findings", "drums", "customs", "leftovers", "valuables", "refreshments", "odds", "wits",
];

/// The letters of a token, lowercased, with punctuation dropped.
pub fn bare_word(token: &str) -> String {
    token.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase()
}

/// True when the word cannot continue a noun phrase, so whatever came before it was the head.
pub fn is_phrase_boundary(word: &str) -> bool {
    word.ends_with("ing")
        || word.ends_with("ed")
        || [
            "at", "in", "on", "by", "for", "with", "of", "to", "from", "about", "under", "over",
            "between", "among", "into", "onto", "during", "since", "until", "before", "after",
            "through", "across", "along", "around", "behind", "below", "beside", "near", "and",
            "or", "but", "that", "which", "who", "whose", "when", "where", "while", "because",
        ]
        .contains(&word)
}

/// Nouns with no plural: "the informations" is not English, so a singular answer stays singular.
const MASS_NOUNS: &[&str] = &[
    "water", "milk", "juice", "tea", "rice", "bread", "butter", "cheese", "meat", "sugar", "salt",
    "pepper", "flour", "oil", "food", "money", "cash", "furniture", "luggage", "baggage",
    "equipment", "information", "advice", "news", "homework", "housework", "traffic", "weather",
    "music", "research", "knowledge", "progress", "evidence", "education", "fun", "help", "health",
    "happiness", "sadness", "anger", "love", "space", "air", "oxygen", "smoke", "dust", "sand",
    "snow", "ice", "wood", "plastic", "metal", "gold", "silver", "electricity", "energy", "mail",
    "software", "jewelry", "clothing", "machinery", "transportation", "accommodation", "garbage",
    "trash", "pollution", "sleep", "patience", "courage", "luck", "peace", "safety", "silence",
    "stuff", "wildlife", "poetry", "literature", "vocabulary", "slang", "feedback", "grass",
    "hair", "weather", "laundry", "scenery", "pasta", "soup", "chaos", "damage", "wealth",
];

/// Plurals the -s rules do not reach.
const IRREGULAR_PLURALS: &[(&str, &str)] = &[
    ("child", "children"), ("person", "people"), ("man", "men"), ("woman", "women"),
    ("foot", "feet"), ("tooth", "teeth"), ("mouse", "mice"), ("goose", "geese"),
    ("leaf", "leaves"), ("life", "lives"), ("knife", "knives"), ("wife", "wives"),
    ("shelf", "shelves"), ("wolf", "wolves"), ("half", "halves"), ("loaf", "loaves"),
    ("thief", "thieves"), ("calf", "calves"), ("scarf", "scarves"),
];

/// Verbs that take a bare infinitive, which never agrees with the noun in front of it. "We watched
/// the lizard bask" and "We watched the lizards bask" are both English.
const BARE_INFINITIVE_VERBS: &[&str] = &[
    "watch", "watched", "watches", "see", "saw", "sees", "hear", "heard", "hears", "notice",
    "noticed", "notices", "feel", "felt", "feels", "let", "lets", "make", "made", "makes",
    "have", "had", "has", "help", "helped", "helps", "observe", "observed",
];

/// The regular plural of a countable noun.
pub fn plural_of(word: &str) -> Option<String> {
    let w = word.to_lowercase();
    if w.len() < 2 || MASS_NOUNS.contains(&w.as_str()) {
        return None;
    }
    if let Some((_, plural)) = IRREGULAR_PLURALS.iter().find(|(s, _)| *s == w) {
        return Some(plural.to_string());
    }
    // Anything that already looks plural, or never takes one, is left alone.
    if w.ends_with('s') || w.ends_with("ese") || w.ends_with("fish") || w.ends_with("sheep") {
        return None;
    }
    for suffix in ["x", "z", "ch", "sh"] {
        if w.ends_with(suffix) {
            return Some(format!("{w}es"));
        }
    }
    if let Some(stem) = w.strip_suffix('y') {
        if !stem.ends_with(['a', 'e', 'i', 'o', 'u']) {
            return Some(format!("{stem}ies"));
        }
    }
    Some(format!("{w}s"))
}

/// What may follow the noun. A finite verb may not: it agrees with the noun, so "the guests arrive"
/// has no singular unless the verb moves too. A preposition, a conjunction, an adverb, a participle
/// or the end of the sentence all read the same either way.
fn number_neutral_after(next: Option<&str>, governed_by_perception_verb: bool) -> bool {
    let Some(word) = next else { return true };
    if word.is_empty() {
        return true;
    }
    // "We watched the lizard bask": the bare infinitive belongs to "watched", not to the noun.
    if governed_by_perception_verb && !word.ends_with('s') {
        return true;
    }
    word.ends_with("ing")
        || word.ends_with("ed")
        || word.ends_with("ly")
        || [
            "at", "in", "on", "by", "for", "with", "of", "to", "from", "about", "under", "over",
            "between", "among", "into", "onto", "during", "since", "until", "before", "after",
            "through", "across", "along", "around", "behind", "below", "beside", "near", "off",
            "out", "up", "down", "against", "without", "within", "inside", "outside", "and", "or",
            "but", "that", "which", "who", "whose", "when", "where", "while", "because", "so",
            // A determiner starts a new phrase, so the noun was not the subject of a verb.
            "a", "an", "the", "this", "these", "those", "every", "each", "all", "some", "any",
            "no", "more", "most", "my", "your", "his", "her", "our", "their", "its", "one", "two",
            "three", "several", "both", "another", "other",
            // Adverbs that carry no -ly.
            "never", "always", "often", "again", "still", "also", "too", "here", "there", "now",
            "then", "today", "yesterday", "tomorrow", "well", "back", "away", "home", "together",
            "first", "last", "early", "late", "soon", "just", "even", "only", "almost",
        ]
        .contains(&word)
}

/// Candidate singulars for a plural noun. "boxes" drops -es and "horses" only drops -s, and
/// nothing in the spelling says which, so both are offered and the dictionary picks.
pub fn singular_candidates(word: &str) -> Vec<String> {
    let w = word.to_lowercase();
    if w.len() < 4 || !w.ends_with('s') || w.ends_with("ss") || ALWAYS_PLURAL.contains(&w.as_str()) {
        return Vec::new();
    }
    let mut out = Vec::new();
    if let Some(stem) = w.strip_suffix("ies") {
        if stem.len() >= 2 {
            out.push(format!("{stem}y"));
        }
    }
    if let Some(stem) = w.strip_suffix("ves") {
        out.push(format!("{stem}f"));
        out.push(format!("{stem}fe"));
    }
    if w.ends_with("es") {
        out.push(w[..w.len() - 2].to_string());
    }
    out.push(w[..w.len() - 1].to_string());
    out
}

/// The singular of a plural noun, when the plural is formed the regular way.
pub fn singular_of(word: &str) -> Option<String> {
    let w = word.to_lowercase();
    if w.len() < 4 || !w.ends_with('s') || w.ends_with("ss") || ALWAYS_PLURAL.contains(&w.as_str()) {
        return None;
    }
    if let Some(stem) = w.strip_suffix("ies") {
        return (stem.len() >= 2).then(|| format!("{stem}y"));
    }
    for suffix in ["ses", "xes", "zes", "ches", "shes"] {
        if w.ends_with(suffix) {
            return Some(w[..w.len() - 2].to_string());
        }
    }
    w.strip_suffix('s').map(str::to_string)
}


/// Puts `singular` back into the token in place of its letters, keeping the surrounding
/// punctuation and a leading capital ("Horses," -> "Horse,").
fn respell(token: &str, singular: &str) -> String {
    let start = token.find(char::is_alphanumeric).unwrap_or(0);
    let end = token.rfind(char::is_alphanumeric).map_or(start, |i| i + token[i..].chars().next().unwrap().len_utf8());
    let mut word = singular.to_string();
    if token[start..end].chars().next().is_some_and(char::is_uppercase) {
        word = word
            .char_indices()
            .map(|(i, c)| if i == 0 { c.to_ascii_uppercase() } else { c })
            .collect();
    }
    format!("{}{}{}", &token[..start], word, &token[end..])
}

/// Japanese does not mark number, so nothing in "私たちはトカゲが石壁で日光浴するのを見ました"
/// says whether it was one lizard or several. Where the prompt cannot say it, the other number has
/// to count too. Only a noun sitting right after a two-way determiner qualifies: that keeps both
/// readings grammatical ("He collects stamp" and "a lizards" are not English) and it is also what
/// proves the word is a noun rather than a verb agreeing with its subject ("the boy runs").
pub fn number_variants(
    sentence: &str,
    known: impl Fn(&str) -> bool,
    countable: impl Fn(&str) -> bool,
) -> Vec<String> {
    let tokens: Vec<&str> = sentence.split(' ').collect();
    let bare = |t: &str| t.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();

    let mut swaps: Vec<(usize, String)> = Vec::new();
    for i in 1..tokens.len() {
        if !TWO_WAY_DETERMINERS.contains(&bare(tokens[i - 1]).as_str()) {
            continue;
        }
        if (2..=3).any(|back| {
            i.checked_sub(back)
                .is_some_and(|j| FORCES_PLURAL.contains(&bare(tokens[j]).as_str()))
        }) {
            continue;
        }
        let word = bare(tokens[i]);
        let governed = i
            .checked_sub(2)
            .is_some_and(|j| BARE_INFINITIVE_VERBS.contains(&bare(tokens[j]).as_str()));
        let next = tokens.get(i + 1).map(|t| bare(t));
        if !number_neutral_after(next.as_deref(), governed) {
            continue;
        }

        // Plural answer, singular reading -- and the other way round for a singular answer.
        let other = if word.ends_with('s') {
            singular_candidates(&word).into_iter().find(|c| known(c))
        } else if known(&word) && countable(&word) {
            plural_of(&word).filter(|p| *p != word)
        } else {
            None
        };
        let Some(other) = other else { continue };
        swaps.push((i, respell(tokens[i], &other)));
        if swaps.len() == 3 {
            break; // one sentence never needs more, and the subsets below stay a handful
        }
    }
    if swaps.is_empty() {
        return Vec::new();
    }

    // Every combination, so "the pillows to the curtains" also accepts both in the singular.
    let mut out = Vec::new();
    for mask in 1..(1u32 << swaps.len()) {
        let mut words: Vec<String> = tokens.iter().map(|t| t.to_string()).collect();
        for (bit, (at, replacement)) in swaps.iter().enumerate() {
            if mask & (1 << bit) != 0 {
                words[*at] = replacement.clone();
            }
        }
        out.push(words.join(" "));
    }
    out
}

#[cfg(test)]
mod plural_tests {
    use super::number_variants;

    /// The tests only ever vary the sentence, so the two predicates are fixed here.
    fn number_variants_t(sentence: &str, known: fn(&str) -> bool) -> Vec<String> {
        number_variants(sentence, known, countable)
    }

    fn countable(w: &str) -> bool {
        !matches!(w, "water" | "information")
    }

    fn known(w: &str) -> bool {
        ["horse", "guest", "pipe", "stamp", "run", "glass", "curtain", "pillow", "new", "lizard",
         "boy", "water", "information"]
            .contains(&w)
    }

    #[test]
    fn forgives_a_plural_only_where_the_singular_is_still_english() {
        // The reported case: the Japanese cannot say whether it was one horse or several.
        assert_eq!(
            number_variants_t("He carried water to the horses every morning.", known),
            vec!["He carried water to the horse every morning."]
        );

        // Nouns English keeps plural stay wrong in the singular.
        assert!(number_variants_t("She cleaned her glasses carefully.", known).is_empty());

        // A subject needs its verb to move too, so there is no one-word singular.
        assert!(number_variants_t("Let's tidy up before the guests arrive.", known).is_empty());
        assert!(number_variants_t("The pipes were made of copper.", known).is_empty());

        // Without a determiner the singular is not a sentence: "He collects stamp" is not English.
        assert!(number_variants_t("He collects vintage stamps from the world.", known).is_empty());

        // A verb agreeing with its subject is never a noun to forgive.
        assert!(number_variants_t("The boy runs fast.", known).is_empty());

        // "all the" and "one of the" demand a plural whatever the determiner allows on its own.
        assert!(number_variants_t("He rearranged all the curtains.", known).is_empty());
        assert!(number_variants_t("She is one of the guests here.", known).is_empty());

        // The reported singular: "the lizards bask" is equally good, because the bare infinitive
        // after "watched" never agrees with the noun.
        assert_eq!(
            number_variants_t("We watched the lizard bask on the warm stone wall.", known),
            vec!["We watched the lizards bask on the warm stone wall."]
        );

        // A noun with no plural keeps its singular.
        assert!(number_variants_t("She drank the water quickly.", known).is_empty());
        assert!(number_variants_t("He read the information carefully.", known).is_empty());

        // Two plurals give every reading, so writing both in the singular also counts.
        let both = number_variants_t("She matched the pillows to the curtains.", known);
        assert_eq!(both.len(), 3, "got {both:?}");
        assert!(both.contains(&"She matched the pillow to the curtain.".to_string()));
    }
}
