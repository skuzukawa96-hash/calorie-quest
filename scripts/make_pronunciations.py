"""Builds src-tauri/data/pronunciations.json from the CMU Pronouncing Dictionary.

Only the words that speaking questions use are kept, written as IPA the way Japanese learner's
dictionaries write American English (iː, uː, ɜːr, ər, r, j), split into segments so the app can
make each sound clickable: "ˈ l aɪ b r ɛ r i". Only the primary stress is marked, before the
syllable it falls on (maximal onset); one-syllable words carry none. The dictionary's secondary
stresses (ˌɪmˈpɔrtənt) often disagree with learner's dictionaries, so they are left out.

    python scripts/make_pronunciations.py path/to/cmudict.dict

cmudict.dict: https://github.com/cmusphinx/cmudict (BSD-style licence, kept in
src-tauri/data/cmudict-LICENSE.txt). Words the dictionary lacks are left out; the app shows
their spelling instead.
"""
import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "src-tauri", "data")
NOT_QUESTIONS = {"glossary.json", "grammar-notes.json", "pronunciations.json", "word-parts.json", "tiers.json",
                 "word-examples.json", "word-usage.json", "idiom-origins.json", "word-related.json",
                 "word-pos.json", "word-confusables.json", "word-families.json", "irregular-verbs.json", "verb-types.json",
                 "exam-basic.json", "exam-600.json", "exam-800.json"}

VOWELS = {
    "AA": "ɑ", "AE": "æ", "AO": "ɔː", "AW": "aʊ", "AY": "aɪ", "EH": "ɛ", "EY": "eɪ",
    "IH": "ɪ", "IY": "iː", "OW": "oʊ", "OY": "ɔɪ", "UH": "ʊ", "UW": "uː",
}
CONSONANTS = {
    "B": "b", "CH": "tʃ", "D": "d", "DH": "ð", "F": "f", "G": "ɡ", "HH": "h", "JH": "dʒ",
    "K": "k", "L": "l", "M": "m", "N": "n", "NG": "ŋ", "P": "p", "R": "r", "S": "s",
    "SH": "ʃ", "T": "t", "TH": "θ", "V": "v", "W": "w", "Y": "j", "Z": "z", "ZH": "ʒ",
}
# Consonant clusters that can open an English syllable (ARPAbet), for placing stress marks.
ONSETS = {
    ("P", "L"), ("B", "L"), ("K", "L"), ("G", "L"), ("F", "L"), ("S", "L"),
    ("P", "R"), ("B", "R"), ("T", "R"), ("D", "R"), ("K", "R"), ("G", "R"), ("F", "R"), ("TH", "R"), ("SH", "R"),
    ("S", "P"), ("S", "T"), ("S", "K"), ("S", "M"), ("S", "N"), ("S", "W"), ("S", "F"),
    ("T", "W"), ("D", "W"), ("K", "W"), ("G", "W"), ("TH", "W"),
    ("P", "Y"), ("B", "Y"), ("F", "Y"), ("V", "Y"), ("K", "Y"), ("G", "Y"), ("M", "Y"), ("HH", "Y"), ("N", "Y"),
    ("S", "P", "L"), ("S", "P", "R"), ("S", "T", "R"), ("S", "K", "R"), ("S", "K", "W"), ("S", "P", "Y"), ("S", "K", "Y"),
}


def is_vowel(phone):
    return phone[-1].isdigit()


def onset_len(cluster):
    """How many consonants at the end of `cluster` open the next syllable."""
    for n in range(min(3, len(cluster)), 0, -1):
        tail = tuple(cluster[-n:])
        if n == 1:
            return 0 if tail[0] == "NG" else 1
        if tail in ONSETS:
            return n
    return 0


def to_ipa(phones):
    nuclei = [i for i, p in enumerate(phones) if is_vowel(p)]
    marks = {}
    if len(nuclei) > 1:
        prev = -1
        for v in nuclei:
            stress = phones[v][-1]
            cluster = [p for p in phones[prev + 1 : v]]
            start = v - (len(cluster) if prev < 0 else onset_len(cluster))
            # A few compounds carry two primary stresses (overhead); the first one is marked.
            if stress == "1" and not marks:
                marks[start] = "ˈ"
            prev = v
    out = []
    for i, p in enumerate(phones):
        if i in marks:
            out.append(marks[i])
        if is_vowel(p):
            base, stress = p[:-1], p[-1]
            last = i == len(phones) - 1
            following = phones[i + 1] if i + 1 < len(phones) else None
            if base == "AH":
                out.append("ʌ" if stress in "12" else "ə")
            elif base == "ER":
                out.append("ɜːr" if stress in "12" else "ər")
            elif base == "IY" and (stress == "0" or (last and stress == "2")):
                out.append("i")  # happy, library: the weak final i (she, see keep iː)
            elif base == "UW" and stress == "0":
                out.append("u")  # into, to
            elif base == "AA" and following == "R":
                out.append("ɑː")  # car, star
            else:
                out.append(VOWELS[base])
        else:
            out.append(CONSONANTS[p])
    return " ".join(out)


def words_of(text):
    """Mirrors the app's split: lowercase, curly apostrophes straightened, letters and ' kept."""
    text = text.lower().replace("\u2019", "'")
    return [w.strip("'") for w in re.findall(r"[a-z']+", text) if w.strip("'")]


def speaking_words():
    words = set()
    for path in glob.glob(os.path.join(DATA, "*.json")):
        if os.path.basename(path) in NOT_QUESTIONS:
            continue
        data = json.load(open(path, encoding="utf-8"))
        questions = data["questions"] if isinstance(data, dict) else data
        for q in questions:
            if "speaking" in q.get("modes", []):
                words.update(words_of(q["en"]))
    return words


VOICELESS = {"P", "T", "K", "F", "TH"}
SIBILANTS = {"S", "Z", "SH", "ZH", "CH", "JH"}


def inflected(word, cmu):
    """Phones for a form the dictionary lacks but whose base it has: possessive or plural -s,
    past -ed and -ing ("rinsed" from rinse, "polishes" from polish, "advisor's" from advisor)."""
    def s_ending(base):
        last = base[-1]
        if last in SIBILANTS:
            return base + ["IH0", "Z"]
        return base + (["S"] if last in VOICELESS else ["Z"])

    if word.endswith("'s") and word[:-2] in cmu:
        return s_ending(cmu[word[:-2]])
    if word.endswith("es") and word[:-2] in cmu and cmu[word[:-2]][-1] in SIBILANTS:
        return s_ending(cmu[word[:-2]])
    if word.endswith("s") and word[:-1] in cmu:
        return s_ending(cmu[word[:-1]])
    if word.endswith("ed"):
        for base in (word[:-2], word[:-1], word[:-3] if word[-3:-2] == word[-4:-3] else None):
            if base and base in cmu:
                phones = cmu[base]
                last = phones[-1]
                if last in {"T", "D"}:
                    return phones + ["IH0", "D"]
                return phones + (["T"] if last in VOICELESS | {"S", "SH", "CH"} else ["D"])
    if word.endswith("ing"):
        for base in (word[:-3], word[:-3] + "e", word[:-4] if word[-4:-3] == word[-5:-4] else None):
            if base and base in cmu:
                return cmu[base] + ["IH0", "NG"]
    return None


def main():
    cmu = {}
    for line in open(sys.argv[1], encoding="utf-8"):
        line = line.split("#")[0].strip()
        if not line:
            continue
        head, *phones = line.split()
        if "(" in head:  # alternative pronunciations: keep the first
            continue
        cmu[head] = phones
    wanted = speaking_words()
    table = {}
    for w in sorted(wanted):
        phones = cmu.get(w) or inflected(w, cmu)
        if phones:
            table[w] = to_ipa(phones)
    missing = sorted(wanted - table.keys())
    with open(os.path.join(DATA, "pronunciations.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(table, f, ensure_ascii=False, indent=0, sort_keys=True)
        f.write("\n")
    print(f"{len(table)} words written, {len(missing)} missing from the dictionary")
    print(" ".join(missing[:200]))


if __name__ == "__main__":
    main()
