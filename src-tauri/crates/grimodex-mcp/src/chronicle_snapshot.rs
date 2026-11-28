//! MCP chronicle snapshot. The shared fixture suite checks the TS wire contract.
use std::collections::{HashMap, HashSet};

use grimodex_core::chronicle_calendar::ChronicleCalendar;
use grimodex_core::chronicle_order::{
    anchor_span, event_span, reading_order_from_list, relation_of_spans, resolve_scene_anchor_by_date, sort_chronicle_events,
    ChronicleAnchor, ChronicleAnchorContext, ChronicleAnchorEventRow, ChronicleAnchorSource,
    ChronicleEventSpanRow, ChronicleOrderRow, ChronicleRelation, SceneEventLink,
};
use grimodex_core::chronicle_time::{effective_event_precision, require_event_date};
use grimodex_db::chronicle_read::ChronicleScene;
use serde::{Deserialize, Serialize};

// ───────── output caps (mirror chronicleSnapshot.ts) ─────────
const MAX_RECENT: usize = 8;
const MAX_OFFPAGE: usize = 3;
const MAX_CHARACTERS: usize = 10;
const MAX_PICK_CHARACTERS: usize = 10;
const TITLE_CAP: usize = 40;
const NOTE_CAP: usize = 30;

// ───────── input row types (subset the derive reads) ─────────

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventInput {
    pub id: String,
    #[serde(default)]
    pub reveal_scene_id: Option<String>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub ordinal: String,
    #[serde(default)]
    pub primary_codex_id: Option<String>,
    #[serde(default)]
    pub location_codex_id: Option<String>,
    #[serde(default)]
    pub start_time: Option<i64>,
    #[serde(default)]
    pub end_time: Option<i64>,
    #[serde(default)]
    pub end_minute: Option<i64>,
    #[serde(default = "default_granularity")]
    pub end_granularity: String,
    #[serde(default)]
    pub start_minute: Option<i64>,
    #[serde(default = "default_granularity")]
    pub start_granularity: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default = "default_precision")]
    pub precision: String,
}

impl EventInput {
    fn anchor_row(&self) -> ChronicleAnchorEventRow {
        ChronicleAnchorEventRow {
            order: ChronicleOrderRow {
                id: self.id.clone(),
                ordinal: self.ordinal.clone(),
                span: ChronicleEventSpanRow {
                    start_time: self.start_time.map(|v| v as f64),
                    end_time: self.end_time.map(|v| v as f64),
                    start_minute: self.start_minute.map(|v| v as f64),
                    end_minute: self.end_minute.map(|v| v as f64),
                    start_granularity: self.start_granularity.clone(),
                    end_granularity: self.end_granularity.clone(),
                },
            },
            precision: self.precision.clone().into(),
        }
    }

    fn has_date(&self) -> bool {
        require_event_date(self.start_time, &self.start_granularity).is_ok()
    }

    fn effective_precision(&self) -> &str {
        effective_event_precision(self.start_time, &self.start_granularity, &self.precision)
    }
}

fn default_kind() -> String {
    "generic".to_string()
}

fn default_precision() -> String {
    "exact".to_string()
}

fn default_granularity() -> String {
    "none".to_string()
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParticipantInput {
    pub event_id: String,
    pub codex_entry_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationInput {
    pub cause_id: String,
    pub effect_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeasonBoundary {
    pub name: String,
    pub start_day_of_year: i64,
}

/// 暦の月定義（`chronicleTime.ts::MonthDef` の移植）。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthDef {
    #[serde(default)]
    pub name: String,
    pub days: i64,
}

/// 閏年ルール（TS `LeapRule` の移植）。none=年長一定。gregorian=4/100/400 で
/// month_index の月へ +1 日。
#[derive(Clone, Debug, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LeapRule {
    #[default]
    None,
    Gregorian {
        #[serde(rename = "monthIndex", default)]
        month_index: usize,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarInput {
    pub days_per_year: i64,
    #[serde(default)]
    pub season_boundaries: Vec<SeasonBoundary>,
    /// 暦の開始年ラベル（day 0 = start_year の最初の月の1日）。未指定=0。
    #[serde(default)]
    pub start_year: i64,
    /// 月定義。空なら月概念なし（年内通日のみ扱う）。
    #[serde(default)]
    pub months: Vec<MonthDef>,
    /// 曜日名。空なら曜日概念なし。週長=配列長。
    /// TS `ChronicleCalendar.weekdayNames` とのカレンダー契約のため受理するが、
    /// `formatChronicleDate` は曜日を出力に使わないため本 derive では未参照。
    #[serde(default)]
    #[allow(dead_code)]
    pub weekday_names: Vec<String>,
    /// day番号0に対応する weekday_names の index。現在の snapshot 出力では未使用だが、
    /// TS の ChronicleCalendar と同じ入力契約を保つ。
    #[serde(default)]
    #[allow(dead_code)]
    pub weekday_start_index: i64,
    /// 閏年ルール（未指定=none）。
    #[serde(default)]
    pub leap: LeapRule,
    /// 年齢の数え方（'full'=満年齢 / 'counting'=数え年）。未指定=full。
    #[serde(default)]
    pub age_reckoning: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotTime {
    pub source: ChronicleAnchorSource,
    pub start_time: Option<i64>,
    pub season: Option<String>,
    pub precision: Option<String>,
    /// 暦駆動の整形済み日付（`formatChronicleDate`）。揃わなければ None。
    pub formatted_date: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CharacterState {
    pub codex_id: String,
    pub name: String,
    pub status: String, // "alive" | "dead" | "unborn" | "unknown"
    pub age: Option<i64>,
    pub location: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEvent {
    pub event_id: String,
    pub title: String,
    pub note: Option<String>,
    /// アンカーから見た相対時間ラベル（`formatRelativeDays` の結果）。暦なし/日付
    /// 欠落/未来は None。fixture の書き漏れをテストで落とすため #[serde(default)] は付けない。
    pub rel_time: Option<String>,
    pub precision: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub reveal_scene: Option<RevealSceneMark>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RevealSceneMark {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub revealed_to_reader: Option<bool>,
}

/// 読む順と題から、開示場面の共通マークを作る。
pub fn make_reveal_scene_mark(
    reveal_scene_id: &str,
    base_scene_id: Option<&str>,
    reading_order: &HashMap<String, i64>,
    title: &str,
) -> Option<RevealSceneMark> {
    let reveal_order = *reading_order.get(reveal_scene_id)?;
    Some(RevealSceneMark {
        id: reveal_scene_id.to_string(),
        title: title.to_string(),
        revealed_to_reader: base_scene_id
            .and_then(|id| reading_order.get(id))
            .map(|current| *current >= reveal_order),
    })
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CausalPair {
    pub cause_title: String,
    pub effect_title: String,
    pub cause_precision: String,
    pub effect_precision: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleSnapshot {
    pub time: SnapshotTime,
    pub characters: Vec<CharacterState>,
    pub recent_events: Vec<SnapshotEvent>,
    pub unresolved_causal: Vec<CausalPair>,
    pub offpage: Vec<SnapshotEvent>,
}

// ───────── helpers ─────────

/// Truncate to `cap` Unicode scalar values, appending "…" when over.
///
/// NOTE: JS `String.length`/`slice` count UTF-16 code units; Rust counts
/// scalar values. They diverge only for astral characters (emoji, rare CJK
/// ext-B). For BMP text — including all common CJK — the counts match. Fixtures
/// keep titles/notes within the caps so truncation is a no-op and this
/// boundary difference never surfaces in the parity gate.
fn truncate(s: &str, cap: usize) -> String {
    if s.chars().count() > cap {
        let head: String = s.chars().take(cap).collect();
        format!("{head}…")
    } else {
        s.to_string()
    }
}

///数値時刻 → 作中季節名（`chronicleTime.ts::seasonOf` の移植）。
pub fn season_of(time: i64, calendar: &CalendarInput) -> Option<String> {
    if calendar_days_per_year(calendar) <= 0 || calendar.season_boundaries.is_empty() {
        return None;
    }
    let day_of_year = day_number_to_date(time, calendar).day_of_year;
    let mut sorted = calendar.season_boundaries.clone();
    sorted.sort_by_key(|b| b.start_day_of_year);
    // 巻き戻し既定値（年末→年初の循環）= 最後の境界。
    let mut current = sorted.last().cloned();
    for b in &sorted {
        if day_of_year >= b.start_day_of_year {
            current = Some(b.clone());
        } else {
            break;
        }
    }
    current.map(|b| b.name)
}

// ───────── 暦駆動の整形済み日付（`chronicleTime.ts` の移植） ─────────

/// 暦の day 番号から導出した作中日付の構成要素（`ChronicleDate` の移植）。
struct ChronicleDate {
    year: i64,
    /// 月インデックス(0-based)。月未定義なら None。
    month_index: Option<usize>,
    /// 月内日(1-based)。月未定義なら None。
    day_of_month: Option<i64>,
    /// 年内通日(0-based)。
    day_of_year: i64,
}

/// 暦の実効「1年の日数」（`calendarDaysPerYear` の移植）。months があれば
/// 月長合計（各 max(1)）、無ければ stored days_per_year。
fn calendar_days_per_year(cal: &CalendarInput) -> i64 {
    if !cal.months.is_empty() {
        let sum: i64 = cal.months.iter().map(|m| m.days.max(1)).sum();
        if sum > 0 {
            return sum;
        }
    }
    cal.days_per_year
}

/// グレゴリオ閏年判定（`isGregorianLeap` の移植）。
fn is_gregorian_leap(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

/// 暦年 year が閏年か（leap 非グレゴリオなら false）。`isLeapYear` の移植。
fn is_leap_year(year: i64, cal: &CalendarInput) -> bool {
    matches!(cal.leap, LeapRule::Gregorian { .. }) && is_gregorian_leap(year)
}

/// 暦年 year・month_index の月の日数（閏月なら +1）。`monthLength` の移植。
fn month_length(year: i64, month_index: usize, cal: &CalendarInput) -> i64 {
    let Some(m) = cal.months.get(month_index) else {
        return 0;
    };
    let base = m.days.max(1);
    if let LeapRule::Gregorian { month_index: li } = cal.leap {
        if month_index == li && is_leap_year(year, cal) {
            return base + 1;
        }
    }
    base
}

/// 半開区間 [lo, hi) 内で m の倍数の個数（負数対応・floor 一貫）。`divisibleCount` の移植。
fn divisible_count(lo: i64, hi: i64, m: i64) -> i64 {
    if hi <= lo {
        return 0;
    }
    (hi - 1).div_euclid(m) - (lo - 1).div_euclid(m)
}

/// 半開区間 [lo, hi) 内のグレゴリオ閏年数。`gregLeapsIn` の移植。
fn greg_leaps_in(lo: i64, hi: i64) -> i64 {
    divisible_count(lo, hi, 4) - divisible_count(lo, hi, 100) + divisible_count(lo, hi, 400)
}

/// 暦年 year の「年内通日 0」が載る day 番号。`yearStartDay` の移植。
fn year_start_day(year: i64, cal: &CalendarInput) -> i64 {
    let start_year = cal.start_year;
    let base = calendar_days_per_year(cal);
    let extra = if matches!(cal.leap, LeapRule::Gregorian { .. }) {
        if year >= start_year {
            greg_leaps_in(start_year, year)
        } else {
            -greg_leaps_in(year, start_year)
        }
    } else {
        0
    };
    (year - start_year) * base + extra
}

/// day 番号 → 作中日付の構成要素（`dayNumberToDate` の移植）。
fn day_number_to_date(day_number: i64, cal: &CalendarInput) -> ChronicleDate {
    let d = day_number;
    let dpy = calendar_days_per_year(cal);
    let start_year = cal.start_year;
    if dpy <= 0 {
        return ChronicleDate {
            year: start_year,
            month_index: None,
            day_of_month: None,
            day_of_year: 0,
        };
    }
    let (year, day_of_year) = if matches!(cal.leap, LeapRule::Gregorian { .. }) {
        let mut y = start_year + d.div_euclid(dpy);
        while year_start_day(y, cal) > d {
            y -= 1;
        }
        while year_start_day(y + 1, cal) <= d {
            y += 1;
        }
        (y, d - year_start_day(y, cal))
    } else {
        (start_year + d.div_euclid(dpy), d.rem_euclid(dpy))
    };
    let mut month_index: Option<usize> = None;
    let mut day_of_month: Option<i64> = None;
    if !cal.months.is_empty() {
        let mut rem = day_of_year;
        for i in 0..cal.months.len() {
            let len = month_length(year, i, cal);
            if rem < len {
                month_index = Some(i);
                day_of_month = Some(rem + 1);
                break;
            }
            rem -= len;
        }
        // months 合計 < day_of_year の防御（stored daysPerYear が月長合計超過時）。
        if month_index.is_none() {
            let last = cal.months.len() - 1;
            month_index = Some(last);
            day_of_month = Some(month_length(year, last, cal));
        }
    }
    ChronicleDate {
        year,
        month_index,
        day_of_month,
        day_of_year,
    }
}

/// 出生日→出来事日の年齢（`computeAge` の移植）。full=満年齢 / counting=数え年。
pub fn compute_age(birth_day: i64, event_day: i64, cal: &CalendarInput) -> i64 {
    let b = day_number_to_date(birth_day, cal);
    let e = day_number_to_date(event_day, cal);
    if cal.age_reckoning == "counting" {
        return e.year - b.year + 1;
    }
    let mut age = e.year - b.year;
    let before_anniversary = match (e.month_index, b.month_index) {
        (Some(em), Some(bm)) => {
            em < bm || (em == bm && e.day_of_month.unwrap_or(0) < b.day_of_month.unwrap_or(0))
        }
        _ => e.day_of_year < b.day_of_year,
    };
    if before_anniversary {
        age -= 1;
    }
    age
}

/// 分(0..1439) → "HH:MM"（`formatTimeOfDay` の移植）。None は None。
fn format_time_of_day(minute: Option<i64>) -> Option<String> {
    let minute = minute?;
    let m = minute.rem_euclid(24 * 60);
    let hh = m / 60;
    let mm = m % 60;
    Some(format!("{hh:02}:{mm:02}"))
}

/// day 番号＋分＋粒度 → 表示文字列（`formatChronicleDate` の移植）。
/// none/None は空文字。lang は "ja" のみ日本語、それ以外は英語整形（呼出側で正規化）。
///
/// 既知の TS↔Rust 乖離: TS 側 formatChronicleDate は eras（元号）/timezone を反映するが、
/// Rust の CalendarInput はそれらのフィールドを持たず本関数にも元号/TZ 分岐が無い。
/// fixture に eras/timezone を入れない限りパリティゲートは緑。元号/TZ の Rust 移植は
/// 別フォローアップ（現状 MCP の formattedDate/startDate は元号非対応）。
pub fn format_chronicle_date(
    day_number: Option<i64>,
    minute: Option<i64>,
    granularity: &str,
    cal: &CalendarInput,
    lang: &str,
) -> String {
    if granularity == "none" {
        return String::new();
    }
    let Some(day_number) = day_number else {
        return String::new();
    };
    let ja = lang == "ja";
    let date = day_number_to_date(day_number, cal);
    let month_name: Option<String> = match date.month_index {
        Some(mi) => match cal.months.get(mi) {
            Some(m) => Some(m.name.clone()),
            None => Some((mi + 1).to_string()),
        },
        None => None,
    };

    if granularity == "year" {
        return if ja {
            format!("{}年", date.year)
        } else {
            format!("Year {}", date.year)
        };
    }
    if granularity == "season" {
        let s = season_of(day_number, cal).unwrap_or_else(|| "?".to_string());
        return if ja {
            format!("{}年・{}", date.year, s)
        } else {
            format!("{} {}", s, date.year)
        };
    }
    if granularity == "month" {
        let mn = month_name.clone().unwrap_or_default();
        return if ja {
            format!("{}年{}", date.year, mn)
        } else {
            format!("{} {}", mn, date.year).trim().to_string()
        };
    }

    // day / time
    let day_part = match date.day_of_month {
        Some(dom) => {
            if ja {
                format!("{dom}日")
            } else {
                format!("{dom}")
            }
        }
        None => {
            if ja {
                format!("第{}日", date.day_of_year + 1)
            } else {
                format!("{}", date.day_of_year + 1)
            }
        }
    };
    let mn = month_name.unwrap_or_default();
    let day_str = if ja {
        format!("{}年{}{}", date.year, mn, day_part)
    } else {
        format!("{} {}, {}", mn, day_part, date.year)
            .trim()
            .to_string()
    };
    if granularity == "time" {
        return match format_time_of_day(minute) {
            Some(tod) => format!("{day_str} {tod}"),
            None => day_str,
        };
    }
    day_str
}

/// アンカーから見た出来事の相対時間ラベル（`formatRelativeDays` の移植）。
/// None/未来(delta<0) は None。整数演算のみ（TS と丸め一致）。
pub fn format_relative_days(
    event_day: Option<i64>,
    anchor_day: Option<i64>,
    approx: bool,
    cal: Option<&CalendarInput>,
    lang: &str,
) -> Option<String> {
    let cal = cal?;
    let event_day = event_day?;
    let anchor_day = anchor_day?;
    let delta = anchor_day - event_day;
    if delta < 0 {
        return None;
    }
    let ja = lang == "ja";
    if delta == 0 {
        return Some(if ja {
            "同日".to_string()
        } else {
            "same day".to_string()
        });
    }
    // round(a/b) を整数で（正の値の round-half-up）: (2a+b)/(2b)。
    let round_div = |a: i64, b: i64| -> i64 { (2 * a + b) / (2 * b) };

    let dpy = calendar_days_per_year(cal);
    let month_count = cal.months.len() as i64;

    if dpy > 0 && delta >= dpy {
        let n = round_div(delta, dpy);
        return Some(if ja {
            format!("約{n}年前")
        } else {
            format!("about {n} year{} earlier", if n == 1 { "" } else { "s" })
        });
    }
    if dpy > 0 && month_count > 0 {
        let months = round_div(delta * month_count, dpy);
        if months >= 2 {
            return Some(if ja {
                format!("約{months}ヶ月前")
            } else {
                format!(
                    "about {months} month{} earlier",
                    if months == 1 { "" } else { "s" }
                )
            });
        }
    }
    Some(if ja {
        format!("{}{delta}日前", if approx { "約" } else { "" })
    } else {
        format!(
            "{}{delta} day{} earlier",
            if approx { "about " } else { "" },
            if delta == 1 { "" } else { "s" }
        )
    })
}

fn derive_character_state_at(
    character_id: &str,
    anchor: &ChronicleAnchor,
    events: &[EventInput],
    calendar: Option<&CalendarInput>,
) -> (String, Option<i64>) {
    let t = anchor.start_time.map(|day| day as i64);
    let mut birth_time: Option<i64> = None;
    let mut death_time: Option<i64> = None;
    let mut uncertain_death = false;
    for e in events {
        if e.primary_codex_id.as_deref() != Some(character_id) {
            continue;
        }
        // 日時の無い出来事の実効の確度は "unknown"。
        if e.effective_precision() == "unknown" {
            // 不明の死亡（CED/2）：日時が無ければいつも、あれば仮の日が現在地以前のとき。
            if e.kind == "death" {
                uncertain_death |=
                    !e.has_date() || t.zip(e.start_time).is_some_and(|(t, d)| d <= t);
            }
            continue;
        }
        let Some(st) = e.start_time else { continue };
        if e.kind == "birth" {
            birth_time = Some(birth_time.map_or(st, |b| b.min(st)));
        } else if e.kind == "death" {
            death_time = Some(death_time.map_or(st, |d| d.min(st)));
        }
    }

    let (Some(t), Some(birth)) = (t, birth_time) else {
        return ("unknown".to_string(), None);
    };
    if birth > t {
        return ("unborn".to_string(), None);
    }
    let dead = death_time.is_some_and(|d| d <= t);
    let ref_time = if dead { death_time.unwrap() } else { t };
    let age = match calendar {
        Some(c) if calendar_days_per_year(c) > 0 => Some(compute_age(birth, ref_time, c)),
        _ => None,
    };
    let status = if dead {
        "dead"
    } else if death_time.is_none() && uncertain_death {
        "unknown"
    } else {
        "alive"
    };
    (status.to_string(), age)
}

/// K1 descending order, with K2/K2a and the current-scene mark kept distinct.
struct PositionedEvent<'a> {
    event: &'a EventInput,
    relation: ChronicleRelation,
    current: bool,
}

impl PositionedEvent<'_> {
    fn recent(&self) -> bool {
        matches!(self.relation, ChronicleRelation::Before | ChronicleRelation::Concurrent)
    }

    fn known(&self) -> bool {
        self.recent() || self.current
    }
}

/// 粗い粒度（日より粗い）。相対時間の「約」化判定に使う。正メンバーシップ判定で
/// TS の COARSE_GRANULARITY と一致させる（!= "none" だと欠落キーで解釈が割れる）。
fn is_coarse_granularity(g: &str) -> bool {
    matches!(g, "year" | "season" | "month")
}

/// アンカーからの相対時間ラベル（`relTimeFor` の移植）。
fn rel_time_for(
    e: &EventInput,
    anchor: &ChronicleAnchor,
    calendar: Option<&CalendarInput>,
    lang: &str,
) -> Option<String> {
    let approx = e.precision != "exact"
        || is_coarse_granularity(&e.start_granularity)
        || is_coarse_granularity(&anchor.start_granularity);
    format_relative_days(e.start_time, anchor.start_time.map(|day| day as i64), approx, calendar, lang)
}

fn snapshot_event(
    e: &EventInput,
    anchor: &ChronicleAnchor,
    calendar: Option<&CalendarInput>,
    lang: &str,
) -> SnapshotEvent {
    SnapshotEvent {
        event_id: e.id.clone(),
        title: truncate(&e.title, TITLE_CAP),
        note: e.note.as_ref().filter(|n| !n.is_empty()).map(|n| truncate(n, NOTE_CAP)),
        rel_time: rel_time_for(e, anchor, calendar, lang),
        precision: e.effective_precision().to_owned(),
        reveal_scene: None,
    }
}

fn derive_unresolved_causal(events: &[PositionedEvent<'_>], relations: &[RelationInput]) -> Vec<CausalPair> {
    let by_id: HashMap<_, _> = events.iter().map(|e| (&e.event.id, e)).collect();
    let mut out = Vec::new();
    for r in relations {
        let (Some(cause), Some(effect)) = (by_id.get(&r.cause_id), by_id.get(&r.effect_id)) else {
            continue;
        };
        if cause.known() && !effect.current && effect.relation == ChronicleRelation::After {
            out.push(CausalPair {
                cause_title: truncate(&cause.event.title, TITLE_CAP),
                effect_title: truncate(&effect.event.title, TITLE_CAP),
                cause_precision: cause.event.effective_precision().to_owned(),
                effect_precision: effect.event.effective_precision().to_owned(),
            });
        }
    }
    out
}

/// `pickSnapshotCharacters` の移植（Phase 1 固定ルール）。挿入順を保持。
fn pick_snapshot_characters(
    events: &[PositionedEvent<'_>],
    participants: &[ParticipantInput],
    max: usize,
) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let push = |ids: &mut Vec<String>, seen: &mut HashSet<String>, id: &str| {
        if seen.insert(id.to_string()) {
            ids.push(id.to_string());
        }
    };

    let recent: Vec<_> = events.iter()
        .filter(|e| e.known())
        .take(MAX_RECENT)
        .map(|e| e.event)
        .collect();
    let recent_ids: HashSet<&str> = recent.iter().map(|e| e.id.as_str()).collect();

    for e in &recent {
        if let Some(pc) = &e.primary_codex_id {
            push(&mut ids, &mut seen, pc);
        }
    }
    for p in participants {
        if recent_ids.contains(p.event_id.as_str()) {
            push(&mut ids, &mut seen, &p.codex_entry_id);
        }
    }
    ids.truncate(max);
    ids
}

fn derive_chronicle_snapshot(
    input: &AssembleInput,
    anchor: &ChronicleAnchor,
    ordered: &[PositionedEvent<'_>],
) -> ChronicleSnapshot {
    let calendar = input.calendar.as_ref();
    let anchor_day = anchor.start_time.map(|day| day as i64);
    let season = match (anchor_day, calendar) {
        (Some(t), Some(cal)) => season_of(t, cal),
        _ => None,
    };

    // 暦＋粒度(≠none)＋start_time が揃うときのみ整形済み日付を確定。空文字は None。
    let lang = if input.lang.as_deref() == Some("en") { "en" } else { "ja" };
    let formatted_date = match (calendar, anchor_day) {
        (Some(cal), Some(st)) if anchor.start_granularity != "none" => {
            let s = format_chronicle_date(
                Some(st),
                anchor.start_minute.map(|v| v as i64),
                &anchor.start_granularity,
                cal,
                lang,
            );
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        }
        _ => None,
    };

    // characterId → 参加 eventId 集合
    let mut participants_by_codex: HashMap<&str, HashSet<String>> = HashMap::new();
    for p in &input.participants {
        participants_by_codex
            .entry(p.codex_entry_id.as_str())
            .or_default()
            .insert(p.event_id.clone());
    }
    let empty: HashSet<String> = HashSet::new();

    let characters: Vec<CharacterState> = pick_snapshot_characters(ordered, &input.participants, MAX_PICK_CHARACTERS)
        .iter()
        .take(MAX_CHARACTERS)
        .map(|cid| {
            let (status, age) =
                derive_character_state_at(cid, anchor, &input.events, calendar);
            let pset = participants_by_codex.get(cid.as_str()).unwrap_or(&empty);
            let location = ordered.iter().find(|e| {
                e.known() && e.event.location_codex_id.is_some()
                    && (e.event.primary_codex_id.as_ref() == Some(cid) || pset.contains(&e.event.id))
            }).and_then(|e| e.event.location_codex_id.as_ref())
              .and_then(|id| input.codex_names.get(id)).cloned();
            CharacterState {
                codex_id: cid.clone(),
                name: input
                    .codex_names
                    .get(cid)
                    .cloned()
                    .unwrap_or_else(|| cid.clone()),
                status,
                age,
                location,
            }
        })
        .collect();

    let stamped: HashSet<_> = input.scene_events.iter().map(|link| &link.event_id).collect();
    let mut offpage: Vec<_> = ordered.iter()
        .filter(|e| !stamped.contains(&e.event.id))
        .filter(|e| anchor.source == ChronicleAnchorSource::None || e.recent())
        .collect();
    offpage.sort_by_key(|e| (e.event.kind == "generic", !e.event.has_date()));
    let render = |e: &PositionedEvent<'_>| snapshot_event(e.event, anchor, calendar, lang);

    ChronicleSnapshot {
        time: SnapshotTime {
            source: anchor.source,
            start_time: anchor_day,
            season,
            precision: anchor.precision.as_ref().map(|p| p.as_str().to_owned()),
            formatted_date,
        },
        characters,
        recent_events: ordered.iter().filter(|e| e.event.kind == "generic" && e.recent())
            .take(MAX_RECENT).map(render).collect(),
        unresolved_causal: derive_unresolved_causal(ordered, &input.relations),
        offpage: offpage.into_iter().take(MAX_OFFPAGE).map(render).collect(),
    }
}

/// Whole-pipeline inputs (scene_id + raw rows) for `assemble_snapshot`. Shared
/// JSON shape with the `chronicle-snapshot/*.json` fixtures' `input`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssembleInput {
    pub scene_id: String,
    #[serde(default)]
    pub events: Vec<EventInput>,
    #[serde(default)]
    pub participants: Vec<ParticipantInput>,
    #[serde(default)]
    pub relations: Vec<RelationInput>,
    #[serde(default)]
    pub scene_events: Vec<SceneEventLink>,
    #[serde(default)]
    pub calendar: Option<CalendarInput>,
    #[serde(default)]
    pub codex_names: HashMap<String, String>,
    /// formattedDate ロケール（既定 "ja"）。TS fixtures の input.lang と対称。
    #[serde(default)]
    pub lang: Option<String>,
}

fn add_reveal_marks(
    snapshot: &mut ChronicleSnapshot,
    scene_id: &str,
    events: &[EventInput],
    nodes: &[ChronicleScene],
) {
    let reading_order = reading_order_from_list(nodes);
    let title_by_id: HashMap<&str, &str> = nodes
        .iter()
        .filter_map(|node| {
            node.title
                .as_deref()
                .map(|title| (node.id.as_str(), title))
        })
        .collect();
    let mut marks = HashMap::new();
    for event in events {
        let Some(id) = event.reveal_scene_id.as_deref().filter(|id| !id.is_empty()) else {
            continue;
        };
        let Some(title) = title_by_id.get(id) else {
            continue;
        };
        let Some(mark) = make_reveal_scene_mark(id, Some(scene_id), &reading_order, title) else {
            continue;
        };
        marks.insert(event.id.as_str(), mark);
    }
    for event in snapshot
        .recent_events
        .iter_mut()
        .chain(snapshot.offpage.iter_mut())
    {
        event.reveal_scene = marks.get(event.event_id.as_str()).cloned();
    }
}

pub fn assemble_snapshot(
    input: &AssembleInput,
    scenes: &[ChronicleScene],
    reveal_scenes: &[ChronicleScene],
    calendar: Option<&ChronicleCalendar>,
) -> ChronicleSnapshot {
    let rows: Vec<_> = input.events.iter().map(EventInput::anchor_row).collect();
    let reading_order = reading_order_from_list(scenes);
    let dates = scenes.iter().filter_map(|s| Some((s.id.clone(), s.date()?))).collect();
    let links: Vec<_> = input.scene_events.iter()
        .filter(|link| reading_order.contains_key(&link.scene_id)).cloned().collect();
    let context = ChronicleAnchorContext {
        scene_events: &links,
        events: &rows,
        reading_order: &reading_order,
        scene_chronicle: Some(&dates),
        calendar,
        has_dated_live_scene: None,
    };
    let anchor = resolve_scene_anchor_by_date(&input.scene_id, &context);
    let current: HashSet<_> = links.iter().filter(|link| link.scene_id == input.scene_id)
        .map(|link| &link.event_id).collect();
    let span = anchor_span(&anchor.span_input(), calendar);
    let by_id: HashMap<_, _> = input.events.iter().map(|e| (&e.id, e)).collect();
    let sorted = sort_chronicle_events(rows.iter().map(|r| &r.order).collect(), calendar);
    let borrowed = anchor.source == ChronicleAnchorSource::Proxy;
    let ordered: Vec<_> = sorted.into_iter().rev().map(|row| {
        let relation = relation_of_spans(event_span(&row.span, calendar), span, borrowed);
        PositionedEvent {
            event: by_id[&row.id],
            relation,
            current: relation != ChronicleRelation::Unknown && current.contains(&row.id),
        }
    }).collect();
    let mut snapshot = derive_chronicle_snapshot(input, &anchor, &ordered);
    add_reveal_marks(&mut snapshot, &input.scene_id, &input.events, reveal_scenes);
    snapshot
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn fixture_scenes(nodes: &serde_json::Value) -> Vec<ChronicleScene> {
        let db = crate::db::tests::make_simple_db();
        db.execute("INSERT INTO projects (id, title) VALUES ('fixture', 'Novel')", []).unwrap();
        db.execute("INSERT INTO tree_nodes (id, project_id, parent_id, node_type, sort_order,
            archived_at, title, chronicle_start_time, chronicle_start_minute,
            chronicle_start_granularity, chronicle_end_time, chronicle_end_minute,
            chronicle_end_granularity, chronicle_precision) SELECT
            value->>'$.id' AS id, 'fixture' AS project_id, value->>'$.parentId' AS parent_id,
            value->>'$.nodeType' AS node_type, value->>'$.sortOrder' AS sort_order,
            value->>'$.archivedAt' AS archived_at, coalesce(value->>'$.title', '') AS title,
            value->>'$.chronicleStartTime' AS chronicle_start_time,
            value->>'$.chronicleStartMinute' AS chronicle_start_minute,
            coalesce(value->>'$.chronicleStartGranularity', 'none') AS chronicle_start_granularity,
            NULL AS chronicle_end_time, NULL AS chronicle_end_minute, 'none' AS chronicle_end_granularity,
            coalesce(value->>'$.chroniclePrecision', 'exact') AS chronicle_precision
            FROM json_each(?1) WHERE type = 'object'", [nodes.to_string()]).unwrap();
        grimodex_db::chronicle_read::live_scenes(&db, "fixture").unwrap()
    }

    /// Every JSON fixture under `tests/fixtures/chronicle-snapshot` (shared with
    /// the TS `chronicleSnapshot.fixtures.test.ts`) must derive to its
    /// `expected` snapshot. This is the Rust half of the TS↔Rust drift gate.
    #[test]
    fn fixtures_match_expected_snapshot() {
        let dir = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../src/features/chronicle/fixtures/chronicle-snapshot"
        );
        let mut count = 0;
        for entry in std::fs::read_dir(dir).expect("fixture dir") {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let raw = std::fs::read_to_string(&path).unwrap();
            let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
            let input: AssembleInput =
                serde_json::from_value(parsed["input"].clone()).expect("input");
            let expected: ChronicleSnapshot =
                serde_json::from_value(parsed["expected"].clone()).expect("expected");
            let data = &parsed["input"];
            let scenes = fixture_scenes(&data["nodes"]);
            let reveal = data.get("revealNodes").map(fixture_scenes);
            let calendar: Option<ChronicleCalendar> = serde_json::from_value(data["calendar"].clone()).unwrap();
            let got = assemble_snapshot(&input, &scenes, reveal.as_deref().unwrap_or(&scenes), calendar.as_ref());
            assert_eq!(
                got,
                expected,
                "snapshot drift in fixture {}",
                path.display()
            );
            count += 1;
        }
        assert!(count >= 3, "expected at least 3 fixtures, found {count}");
    }

    fn cal_rel(months: bool) -> CalendarInput {
        CalendarInput {
            days_per_year: 360,
            season_boundaries: vec![],
            start_year: 0,
            months: if months {
                (1..=12)
                    .map(|i| MonthDef {
                        name: format!("{i}月"),
                        days: 30,
                    })
                    .collect()
            } else {
                vec![]
            },
            weekday_names: vec![],
            weekday_start_index: 0,
            leap: LeapRule::None,
            age_reckoning: String::new(),
        }
    }

    #[test]
    fn format_relative_days_matches_ts_thresholds() {
        let c360 = cal_rel(false);
        let cm = cal_rel(true);
        // null / 未来
        assert_eq!(
            format_relative_days(Some(0), Some(100), false, None, "ja"),
            None
        );
        assert_eq!(
            format_relative_days(None, Some(100), false, Some(&c360), "ja"),
            None
        );
        assert_eq!(
            format_relative_days(Some(100), Some(0), false, Some(&c360), "ja"),
            None
        );
        // 同日
        assert_eq!(
            format_relative_days(Some(50), Some(50), false, Some(&c360), "ja").as_deref(),
            Some("同日")
        );
        assert_eq!(
            format_relative_days(Some(50), Some(50), false, Some(&c360), "en").as_deref(),
            Some("same day")
        );
        // 年
        assert_eq!(
            format_relative_days(Some(0), Some(360), false, Some(&c360), "ja").as_deref(),
            Some("約1年前")
        );
        assert_eq!(
            format_relative_days(Some(0), Some(7100), false, Some(&c360), "ja").as_deref(),
            Some("約20年前")
        );
        assert_eq!(
            format_relative_days(Some(0), Some(540), false, Some(&c360), "ja").as_deref(),
            Some("約2年前")
        );
        assert_eq!(
            format_relative_days(Some(0), Some(720), false, Some(&c360), "en").as_deref(),
            Some("about 2 years earlier")
        );
        // 月
        assert_eq!(
            format_relative_days(Some(0), Some(212), false, Some(&cm), "ja").as_deref(),
            Some("約7ヶ月前")
        );
        assert_eq!(
            format_relative_days(Some(0), Some(45), false, Some(&cm), "en").as_deref(),
            Some("about 2 months earlier")
        );
        // 日
        assert_eq!(
            format_relative_days(Some(0), Some(30), false, Some(&c360), "ja").as_deref(),
            Some("30日前")
        );
        assert_eq!(
            format_relative_days(Some(0), Some(30), false, Some(&cm), "ja").as_deref(),
            Some("30日前")
        );
        assert_eq!(
            format_relative_days(Some(0), Some(30), true, Some(&c360), "ja").as_deref(),
            Some("約30日前")
        );
        assert_eq!(
            format_relative_days(Some(0), Some(1), false, Some(&c360), "en").as_deref(),
            Some("1 day earlier")
        );
        assert_eq!(
            format_relative_days(Some(0), Some(5), true, Some(&c360), "en").as_deref(),
            Some("about 5 days earlier")
        );
    }

    #[test]
    fn season_of_wraps_year_end() {
        let cal = CalendarInput {
            days_per_year: 360,
            season_boundaries: vec![
                SeasonBoundary {
                    name: "春".into(),
                    start_day_of_year: 0,
                },
                SeasonBoundary {
                    name: "夏".into(),
                    start_day_of_year: 90,
                },
                SeasonBoundary {
                    name: "秋".into(),
                    start_day_of_year: 180,
                },
                SeasonBoundary {
                    name: "冬".into(),
                    start_day_of_year: 270,
                },
            ],
            start_year: 0,
            months: vec![],
            weekday_names: vec![],
            weekday_start_index: 0,
            leap: LeapRule::None,
            age_reckoning: String::new(),
        };
        assert_eq!(season_of(0, &cal).as_deref(), Some("春"));
        assert_eq!(season_of(95, &cal).as_deref(), Some("夏"));
        assert_eq!(season_of(359, &cal).as_deref(), Some("冬"));
        // wrap: day 720 == day 0
        assert_eq!(season_of(720, &cal).as_deref(), Some("春"));
    }

    #[test]
    fn snapshot_never_compares_ordinals_directly() {
        let source = include_str!("chronicle_snapshot.rs").split("#[cfg(test)]").next().unwrap();
        let accesses: Vec<_> = source.lines().map(str::trim).filter(|line| line.contains(".ordinal")).collect();
        assert_eq!(accesses, ["ordinal: self.ordinal.clone(),"]);
    }

    #[test]
    fn current_mark_and_overlapping_period_have_distinct_snapshot_roles() {
        let input: AssembleInput = serde_json::from_value(serde_json::json!({
            "sceneId": "s",
            "events": [
                {"id":"now", "title":"Later", "ordinal":"a0", "startTime":30, "startGranularity":"day",
                 "primaryCodexId":"hero", "locationCodexId":"port"},
                {"id":"period", "ordinal":"a9", "startTime":5, "startGranularity":"day",
                 "endTime":10, "endGranularity":"day"},
                {"id":"future", "title":"Future", "startTime":40, "startGranularity":"day"},
                {"id":"born", "kind":"birth", "primaryCodexId":"hero", "startTime":0, "startGranularity":"day"},
                {"id":"died", "kind":"death", "primaryCodexId":"hero", "startTime":1,
                 "startGranularity":"day", "precision":"unknown"},
                {"id":"legacy", "precision":"exact"}
            ],
            "sceneEvents":[{"sceneId":"s","eventId":"now"}, {"sceneId":"s","eventId":"legacy"}],
            "relations":[{"causeId":"now","effectId":"future"}, {"causeId":"period","effectId":"now"},
                         {"causeId":"now","effectId":"legacy"}],
            "codexNames":{"port":"Port"}
        })).unwrap();
        let scenes = fixture_scenes(&serde_json::json!([{
            "id":"s", "nodeType":"scene", "sortOrder":"a0",
            "chronicleStartTime":10, "chronicleStartGranularity":"day"
        }]));
        let state = assemble_snapshot(&input, &scenes, &scenes, None);
        assert_eq!(state.time.source, ChronicleAnchorSource::Scene);
        assert_eq!(state.recent_events.len(), 1);
        assert_eq!(state.recent_events[0].event_id, "period");
        assert_eq!(state.characters.len(), 1);
        // "died" は現在地以前の不明の死亡なので、生死は "unknown"（CED/2）。
        assert_eq!(state.characters[0].status, "unknown");
        assert_eq!(state.characters[0].location.as_deref(), Some("Port"));
        assert_eq!(state.unresolved_causal.len(), 1);
        assert_eq!(state.unresolved_causal[0].cause_title, "Later");
        assert_eq!(state.unresolved_causal[0].effect_title, "Future");
    }

    fn cal_months() -> CalendarInput {
        CalendarInput {
            days_per_year: 360,
            season_boundaries: vec![
                SeasonBoundary {
                    name: "春".into(),
                    start_day_of_year: 0,
                },
                SeasonBoundary {
                    name: "夏".into(),
                    start_day_of_year: 90,
                },
                SeasonBoundary {
                    name: "秋".into(),
                    start_day_of_year: 180,
                },
                SeasonBoundary {
                    name: "冬".into(),
                    start_day_of_year: 270,
                },
            ],
            start_year: 1000,
            months: (1..=12)
                .map(|i| MonthDef {
                    name: format!("{i}月"),
                    days: 30,
                })
                .collect(),
            weekday_names: vec![],
            weekday_start_index: 0,
            leap: LeapRule::None,
            age_reckoning: String::new(),
        }
    }

    #[test]
    fn format_chronicle_date_branches() {
        let cal = cal_months();
        // 1000 + floor(96212/360)=1267年, dayOfYear 92 → 4月3日, 540分 → 09:00。
        assert_eq!(
            format_chronicle_date(Some(96212), Some(540), "time", &cal, "ja"),
            "1267年4月3日 09:00"
        );
        assert_eq!(
            format_chronicle_date(Some(96212), Some(540), "day", &cal, "ja"),
            "1267年4月3日"
        );
        assert_eq!(
            format_chronicle_date(Some(96212), None, "month", &cal, "ja"),
            "1267年4月"
        );
        assert_eq!(
            format_chronicle_date(Some(96212), None, "season", &cal, "ja"),
            "1267年・夏"
        );
        assert_eq!(
            format_chronicle_date(Some(96212), None, "year", &cal, "ja"),
            "1267年"
        );
        // en 整形。
        assert_eq!(
            format_chronicle_date(Some(96212), Some(540), "time", &cal, "en"),
            "4月 3, 1267 09:00"
        );
        assert_eq!(
            format_chronicle_date(Some(96212), None, "year", &cal, "en"),
            "Year 1267"
        );
        // none / null は空文字。
        assert_eq!(
            format_chronicle_date(Some(96212), Some(540), "none", &cal, "ja"),
            ""
        );
        assert_eq!(
            format_chronicle_date(None, Some(540), "time", &cal, "ja"),
            ""
        );
    }

    #[test]
    fn format_chronicle_date_monthless() {
        // 月定義なし暦: dayPart は「第N日」/dayOfYear+1。
        let cal = CalendarInput {
            days_per_year: 100,
            season_boundaries: vec![],
            start_year: 0,
            months: vec![],
            weekday_names: vec![],
            weekday_start_index: 0,
            leap: LeapRule::None,
            age_reckoning: String::new(),
        };
        // day 205 → year 2, dayOfYear 5 → 第6日。
        assert_eq!(
            format_chronicle_date(Some(205), None, "day", &cal, "ja"),
            "2年第6日"
        );
        assert_eq!(
            format_chronicle_date(Some(205), None, "day", &cal, "en"),
            "6, 2"
        );
    }

    fn gregorian() -> CalendarInput {
        CalendarInput {
            days_per_year: 365,
            season_boundaries: vec![],
            start_year: 2000,
            months: [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
                .iter()
                .enumerate()
                .map(|(i, &days)| MonthDef {
                    name: format!("{}", i + 1),
                    days,
                })
                .collect(),
            weekday_names: vec![],
            weekday_start_index: 0,
            leap: LeapRule::Gregorian { month_index: 1 },
            age_reckoning: String::new(),
        }
    }

    #[test]
    fn gregorian_leap_parity_with_ts() {
        let cal = gregorian();
        // day 0 = 2000-01-01。閏年 2000 は 366 日 → day 366 = 2001-01-01。
        let d = day_number_to_date(366, &cal);
        assert_eq!(
            (d.year, d.month_index, d.day_of_month),
            (2001, Some(0), Some(1))
        );
        // 2000-02-29 が存在。
        assert_eq!(month_length(2000, 1, &cal), 29);
        assert_eq!(month_length(2001, 1, &cal), 28);
        // 4/100/400。
        assert!(is_leap_year(2000, &cal));
        assert!(!is_leap_year(1900, &cal));
        assert!(is_leap_year(2004, &cal));
    }

    #[test]
    fn season_of_uses_leap_aware_day_of_year() {
        let mut cal = gregorian();
        cal.season_boundaries = vec![
            SeasonBoundary {
                name: "春".to_string(),
                start_day_of_year: 0,
            },
            SeasonBoundary {
                name: "夏".to_string(),
                start_day_of_year: 90,
            },
            SeasonBoundary {
                name: "秋".to_string(),
                start_day_of_year: 180,
            },
            SeasonBoundary {
                name: "冬".to_string(),
                start_day_of_year: 270,
            },
        ];
        // 2000 の閏日を跨いだ 2001-12-31。単純 days_per_year mod だと春へ誤判定する。
        let dec31_2001 = year_start_day(2001, &cal) + 364;
        assert_eq!(season_of(dec31_2001, &cal).as_deref(), Some("冬"));
    }

    #[test]
    fn compute_age_full_and_counting() {
        let mut cal = gregorian();
        // 誕生日 2000-06-15、出来事 2020-06-14（誕生日前）→ 満19。
        let birth = year_start_day(2000, &cal) + 31 + 29 + 31 + 30 + 31 + 14; // 6/15
        let before = year_start_day(2020, &cal) + 31 + 28 + 31 + 30 + 31 + 13; // 6/14 (2020 閏)
        assert_eq!(compute_age(birth, before, &cal), 19);
        cal.age_reckoning = "counting".to_string();
        // 数え年 = 暦年差+1 = 2020-2000+1 = 21。
        assert_eq!(compute_age(birth, before, &cal), 21);
    }
}
