use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub id: i64,
    pub key: String,
    /// word | phrase | grammar | idiom | sentence | dialogue | expression
    pub kind: String,
    /// low | mid | high: sets the listening and speaking rate (2 / 4 / 10 kcal)
    pub difficulty: String,
    /// The home screen's tab: word 英単語 | grammar 文法 | idiom 慣用句 | phrase フレーズ | example 例文
    pub tier: String,
    /// Genre (食べ物, 旅行・交通, 文法, ...); empty when unknown.
    pub category: String,
    /// Fine-grained semantic field (果物, 乗り物, 感情, ...) used to pick believable distractors.
    pub group: String,
    pub en: String,
    pub ja: String,
    /// Which study modes this question supports: choice | typing | speaking
    pub modes: Vec<String>,
    pub choices: Option<Vec<String>>,
    pub prompt: Option<String>,
    pub hint: Option<String>,
    pub audio_path: Option<String>,
    /// Idioms carry a sentence that shows the expression in use, with its translation.
    pub example: Option<String>,
    pub example_ja: Option<String>,
    /// Grammar questions name the point they test ("present-perfect", "relative-pronoun", ...).
    pub point: Option<String>,
}

/// The explanation shown with the answer to a grammar question, looked up from the question's
/// `point`. One note serves every question that tests the same thing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrammarNote {
    pub title: String,
    pub body: String,
    pub example: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionQuestion {
    pub question: Question,
    pub mode: String,
    pub is_review: bool,
    pub display: String,
    pub sub_display: Option<String>,
    pub options: Vec<String>,
    pub answer: String,
    /// Every English the grader accepts for a typing question. The prompt is Japanese, and the
    /// bank often holds more than one question meaning the same thing in the same group
    /// ("best of luck" and "keep your fingers crossed" are both 幸運を祈る), so marking anything
    /// but `answer` wrong would fail a learner who wrote a translation the bank itself teaches.
    pub accepted: Vec<String>,
    /// English to speak: the full sentence for grammar blanks, the spoken line for dialogues.
    pub audio_text: String,
    /// Listening mode hides the English until the answer is in.
    pub hide_text: bool,
    /// Grammar questions carry the explanation of the point they test, shown with the answer.
    pub grammar_note: Option<GrammarNote>,
    /// What a word or an idiom carries to its answer beyond the meaning: how the word is built,
    /// sentences using it, its patterns with prepositions, where the idiom comes from.
    pub notes: Option<WordNotes>,
}

/// The explanation under the answer to a word or an idiom, also shown when a word saved to the
/// recipe is reviewed. Each part is empty when the data has nothing for the word.
#[derive(Debug, Clone, Default, Serialize)]
pub struct WordNotes {
    /// prefix, root and suffix ("pre-" 前もって + paid 支払った)
    pub parts: Vec<WordPart>,
    /// sentences using the word
    pub examples: Vec<ExampleSentence>,
    /// patterns it is used in ("compare A with B" AとBを比較する), each with a sentence
    pub usages: Vec<WordUsage>,
    /// for an idiom whose origin is known: where it comes from
    pub origin: Option<String>,
}

impl WordNotes {
    pub fn is_empty(&self) -> bool {
        self.parts.is_empty() && self.examples.is_empty() && self.usages.is_empty() && self.origin.is_none()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExampleSentence {
    pub en: String,
    pub ja: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordUsage {
    /// "compare A with B", with A / B / 人 / ~ standing for what fills the pattern
    pub pattern: String,
    pub ja: String,
    pub example: String,
    pub example_ja: String,
}

/// One piece of a word: a prefix ("pre"), a root ("paid") or a suffix ("ness"), with its meaning.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WordPart {
    /// "prefix" / "root" / "suffix"
    pub kind: String,
    pub text: String,
    pub ja: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub id: i64,
    pub name: String,
    pub total_study_days: i64,
    pub current_streak: i64,
    pub longest_streak: i64,
    pub last_study_date: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyStats {
    pub date: String,
    pub kcal_earned: i64,
    pub kcal_consumed: i64,
    pub answered: i64,
    pub correct: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snack {
    pub id: i64,
    pub name: String,
    pub calories: i64,
    pub icon: String,
    pub is_builtin: bool,
    /// how many times it has been recorded as eaten (with kcal or a ticket), for "よく食べる順"
    pub eaten_count: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KcalRates {
    pub low: i64,
    pub mid: i64,
    pub high: i64,
    /// any choice question but a word
    pub choice: i64,
    pub idiom_typing: i64,
    pub review_multiplier: f64,
    pub cheat_day_bonus: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryInfo {
    pub name: String,
    pub total: i64,
    /// questions per tab
    pub word: i64,
    pub grammar: i64,
    pub idiom: i64,
    pub phrase: i64,
    pub example: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub user: UserInfo,
    pub today: DailyStats,
    /// 目標のお菓子（カロリーの少ない順）
    pub goal_snacks: Vec<Snack>,
    /// 今日食べたお菓子の id（重複なし）。目標やバーのアイコンに「食べた」を付ける
    pub eaten_today: Vec<i64>,
    pub snacks: Vec<Snack>,
    pub categories: Vec<CategoryInfo>,
    pub due_review_count: i64,
    pub tickets_available: i64,
    pub kcal_rates: KcalRates,
    pub savings: SavingsInfo,
}

/// 使わなかったカロリーの貯蓄と、それが変わったお菓子引換券。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavingsInfo {
    pub balance: i64,
    /// この量で引換券1枚（2,000 kcal）
    pub per_ticket: i64,
    /// まだ使っていないお菓子引換券
    pub snack_tickets: i64,
    /// この呼び出しで締めた前日までの残り。締めるのは日付が変わって最初の1回だけなので、
    /// 0 でなければ画面で知らせる。
    pub just_saved: i64,
    pub just_issued: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerPayload {
    pub question_id: i64,
    pub mode: String,
    pub correct: bool,
    pub score: Option<f64>,
    /// 記入問題でヒントの単語を開示した数。1語ごとに獲得カロリーが半分になる。
    pub hints_used: Option<i64>,
    /// 記入問題で正解と食い違った語の数（違う語・抜けた語・余分な語）。中難易度の記入問題では
    /// 1語ごとに 1 kcal 減点し、残りを不正解でも支払う。
    #[serde(default)]
    pub mistakes: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerResult {
    pub kcal_earned: i64,
    pub today_kcal: i64,
    pub streak: i64,
    pub new_ticket: bool,
    pub first_study_today: bool,
    pub is_review: bool,
    pub needs_review: bool,
    pub next_due: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumptionEntry {
    pub id: i64,
    pub snack_name: String,
    pub snack_icon: String,
    pub calories: i64,
    pub eaten_at: String,
    /// お菓子引換券で食べた（カロリー予算を使っていない）
    pub with_ticket: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedeemResult {
    pub kcal_added: i64,
    pub today_kcal: i64,
    pub tickets_left: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ticket {
    pub id: i64,
    pub issued_at: String,
    pub issued_for_streak: i64,
    pub used_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayPoint {
    pub date: String,
    pub kcal_earned: i64,
    pub answered: i64,
    pub correct: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeakQuestion {
    pub question: Question,
    pub wrong_count: i64,
    pub last_score: Option<f64>,
    pub next_due: Option<String>,
    pub srs_level: i64,
}

/// One entry of お菓子作りレシピ, the learner's own word list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeWord {
    pub id: i64,
    /// Dictionary form ("hear"), or the whole expression for a phrase ("doggy bag").
    pub word: String,
    pub meaning: String,
    /// The form the learner right-clicked ("heard"), so the example can mark it.
    pub form: String,
    /// The sentence the word was found in, with its translation when the question had one.
    pub example: String,
    pub example_ja: String,
    pub added_at: String,
    pub reviews: i64,
    pub last_reviewed_at: Option<String>,
    /// Set once the learner has marked the word as learned; such words may be cleared out.
    pub mastered_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeWordInput {
    pub word: String,
    #[serde(default)]
    pub meaning: String,
    #[serde(default)]
    pub form: String,
    #[serde(default)]
    pub example: String,
    #[serde(default)]
    pub example_ja: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RecipeAddStatus {
    /// A new entry.
    Added,
    /// Already on the list and still being learned: nothing changes.
    Exists,
    /// Was marked learned, and the learner reached for it again, so it is back in review.
    Restored,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeAddResult {
    pub status: RecipeAddStatus,
    pub entry: RecipeWord,
}

/// One word reviewed from the recipe, and what it paid into today's budget.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecipeReviewResult {
    pub entry: RecipeWord,
    /// the answer earned its 0.5 / 1 kcal: right, and the word had not paid yet today
    pub counted: bool,
    /// whole kcal added to today just now (0.5 kcal waits for the next half)
    pub kcal_earned: i64,
    pub today_kcal: i64,
    /// half a calorie is waiting for the next correct pick today
    pub half_pending: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub total_study_days: i64,
    pub current_streak: i64,
    pub longest_streak: i64,
    pub total_kcal: i64,
    pub total_answered: i64,
    pub total_correct: i64,
    pub accuracy: f64,
    pub last_14_days: Vec<DayPoint>,
    pub weak_questions: Vec<WeakQuestion>,
    pub tickets: Vec<Ticket>,
    pub review_due: i64,
    pub review_pending: i64,
}
