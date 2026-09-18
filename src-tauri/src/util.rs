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
