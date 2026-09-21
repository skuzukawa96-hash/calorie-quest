use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub id: i64,
    pub key: String,
    /// word | phrase | grammar | idiom | sentence
    pub kind: String,
    /// low | mid | high
    pub difficulty: String,
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
    pub goal_snack_id: Option<i64>,
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
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KcalRates {
    pub low: i64,
    pub mid: i64,
    pub high: i64,
    pub review_multiplier: f64,
    pub cheat_day_bonus: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryInfo {
    pub name: String,
    pub total: i64,
    pub low: i64,
    pub mid: i64,
    pub high: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub user: UserInfo,
    pub today: DailyStats,
    pub goal_snack: Option<Snack>,
    pub snacks: Vec<Snack>,
    pub categories: Vec<CategoryInfo>,
    pub due_review_count: i64,
    pub tickets_available: i64,
    pub kcal_rates: KcalRates,
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
