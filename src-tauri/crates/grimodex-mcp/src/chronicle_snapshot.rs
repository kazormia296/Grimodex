//! Pure Rust port of the TypeScript chronicle snapshot derivation
//! (`src/features/chronicle/chronicleSnapshot.ts` + `resolveSceneAnchor.ts` +
//! `chronicleTime.ts` season/reading-order helpers).
//!
//! `get_chronicle_state` must return **byte-identical** structured JSON to the
//! in-app `get_chronicle_state` agent tool. This module reproduces the derive
//! exactly so a CI fixture (`chronicle-snapshot/*.json`, shared with the TS
//! `chronicleSnapshot.fixtures.test.ts`) gates TS↔Rust drift.
//!
//! Determinism note: the TS pipeline feeds `listEvents` output (ordered by
//! `ordinal` asc, then `id` asc) into stable JS sorts. Rust `slice::sort_by` is
//! likewise stable, so as long as the caller hands us events in the same
//! (ordinal, id) order, tie-breaking matches. The fixtures pin the input order.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

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
    pub start_minute: Option<i64>,
    #[serde(default = "default_granularity")]
    pub start_granularity: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default = "default_precision")]
    pub precision: String,
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
pub struct SceneEventInput {
    pub scene_id: String,
    pub event_id: String,
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

/// A tree node, reduced to the fields the derive reads: `computeGlobalSceneOrder`
/// (reading order) plus the scene-own chronicle date (scene-anchor source).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneNode {
    pub id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub node_type: String,
    #[serde(default)]
    pub sort_order: String,
    /// シーン自身の暦日付（events と同じ日付モデルをシーンへ共有）。end_* は
    /// アンカー不使用なので持たない。`startGranularity != "none" && startTime
    /// != null` のとき scene-own アンカーが発火する。
    #[serde(default)]
    pub chronicle_start_time: Option<i64>,
    #[serde(default)]
    pub chronicle_start_minute: Option<i64>,
    #[serde(default = "default_granularity")]
    pub chronicle_start_granularity: String,
    #[serde(default = "default_precision")]
    pub chronicle_precision: String,
}

// ───────── anchor + snapshot output types ─────────

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleAnchor {
    pub ordinal: String,
    pub start_time: Option<i64>,
    #[serde(default)]
    pub start_minute: Option<i64>,
    #[serde(default = "default_granularity")]
    pub start_granularity: String,
    #[serde(default)]
    pub precision: Option<String>,
    pub source: String, // "stamped" | "proxy" | "none"
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub proxy_scene_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotTime {
    pub source: String,
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
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CausalPair {
    pub cause_title: String,
    pub effect_title: String,
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

/// fractional-index lexicographic comparison. base62 ASCII keys compare
/// identically by byte order in JS (`a < b` on UTF-16 units) and Rust.
fn cmp_keys(a: &str, b: &str) -> Ordering {
    a.cmp(b)
}

/// `ordinal <= anchorOrdinal`. anchor.source=none carries ordinal "" → false.
fn at_or_before(ordinal: &str, anchor_ordinal: &str) -> bool {
    if anchor_ordinal.is_empty() {
        return false;
    }
    cmp_keys(ordinal, anchor_ordinal) != Ordering::Greater
}

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

/// `computeGlobalSceneOrder` の移植: ツリーを DFS し scene にグローバル順序
/// index を割り当てる。folder は index を消費せず再帰、note はスキップ。
pub fn compute_global_scene_order(nodes: &[SceneNode]) -> HashMap<String, i64> {
    let mut result: HashMap<String, i64> = HashMap::new();
    if nodes.is_empty() {
        return result;
    }
    let mut children_map: HashMap<Option<String>, Vec<SceneNode>> = HashMap::new();
    for node in nodes {
        children_map
            .entry(node.parent_id.clone())
            .or_default()
            .push(node.clone());
    }
    for children in children_map.values_mut() {
        children.sort_by(|a, b| cmp_keys(&a.sort_order, &b.sort_order));
    }

    // Recursive DFS over the sorted children groups; visit order is identical
    // to the recursive JS version (folder descends without consuming an index).
    fn dfs(
        parent: &Option<String>,
        children_map: &HashMap<Option<String>, Vec<SceneNode>>,
        index: &mut i64,
        result: &mut HashMap<String, i64>,
    ) {
        let Some(children) = children_map.get(parent) else {
            return;
        };
        for node in children {
            if node.node_type == "scene" {
                result.insert(node.id.clone(), *index);
                *index += 1;
            } else if node.node_type == "folder" {
                dfs(&Some(node.id.clone()), children_map, index, result);
            }
            // note: スキップ
        }
    }
    let mut index: i64 = 0;
    dfs(&None, &children_map, &mut index, &mut result);
    result
}

/// シーンが暦日付を持つか（scene-own アンカー発火条件）。
fn node_has_date(n: &SceneNode) -> bool {
    n.chronicle_start_granularity != "none" && n.chronicle_start_time.is_some()
}

/// `syntheticOrdinal(t)` の移植: `start_time != null && start_time <= t` の event の
/// うち start_time 最大（同点は ordinal 最大）の ordinal。該当なしは ""。
fn synthetic_ordinal(events: &[EventInput], t: i64) -> String {
    let mut best: Option<&EventInput> = None;
    for e in events {
        let Some(st) = e.start_time else { continue };
        if st > t {
            continue;
        }
        match best {
            None => best = Some(e),
            Some(b) => {
                let bst = b.start_time.unwrap_or(i64::MIN);
                if st > bst || (st == bst && cmp_keys(&e.ordinal, &b.ordinal) == Ordering::Greater)
                {
                    best = Some(e);
                }
            }
        }
    }
    best.map(|e| e.ordinal.clone()).unwrap_or_default()
}

/// stamped event 群の ordinal 最大を ChronicleAnchor へ（source は呼出側で設定）。
fn max_ordinal_anchor(evs: &[&EventInput]) -> Option<ChronicleAnchor> {
    let best = evs.iter().copied().reduce(|best, e| {
        if cmp_keys(&e.ordinal, &best.ordinal) == Ordering::Greater {
            e
        } else {
            best
        }
    })?;
    Some(ChronicleAnchor {
        ordinal: best.ordinal.clone(),
        start_time: best.start_time,
        start_minute: best.start_minute,
        start_granularity: best.start_granularity.clone(),
        precision: Some(best.precision.clone()),
        source: String::new(),
        proxy_scene_id: None,
    })
}

/// `resolveSceneAnchor` の移植（v2: scene-own → stamped → proxy → none）。
pub fn resolve_scene_anchor(
    scene_id: &str,
    nodes: &[SceneNode],
    scene_events: &[SceneEventInput],
    events: &[EventInput],
    reading_order: &HashMap<String, i64>,
) -> ChronicleAnchor {
    let event_by_id: HashMap<&str, &EventInput> =
        events.iter().map(|e| (e.id.as_str(), e)).collect();

    // sceneId → そのシーン自身の暦日付（scene-own アンカー源）。
    let scene_chron: HashMap<&str, &SceneNode> = nodes.iter().map(|n| (n.id.as_str(), n)).collect();

    // sceneId → 紐づく(実在 event)群。挿入順を保つため Vec<(scene, Vec<event>)>。
    let mut stamped_by_scene: Vec<(String, Vec<&EventInput>)> = Vec::new();
    let mut scene_index: HashMap<String, usize> = HashMap::new();
    for se in scene_events {
        let Some(ev) = event_by_id.get(se.event_id.as_str()) else {
            continue;
        };
        if let Some(&i) = scene_index.get(&se.scene_id) {
            stamped_by_scene[i].1.push(ev);
        } else {
            scene_index.insert(se.scene_id.clone(), stamped_by_scene.len());
            stamped_by_scene.push((se.scene_id.clone(), vec![ev]));
        }
    }

    // シーンの directAnchor（scene-own → stamped）。無ければ None。
    let direct_anchor = |sid: &str| -> Option<ChronicleAnchor> {
        // 1. scene-own
        if let Some(n) = scene_chron.get(sid) {
            if let Some(st) = n.chronicle_start_time {
                if n.chronicle_start_granularity != "none" {
                    return Some(ChronicleAnchor {
                        ordinal: synthetic_ordinal(events, st),
                        start_time: Some(st),
                        start_minute: n.chronicle_start_minute,
                        start_granularity: n.chronicle_start_granularity.clone(),
                        precision: Some(n.chronicle_precision.clone()),
                        source: "scene".to_string(),
                        proxy_scene_id: None,
                    });
                }
            }
        }
        // 2. stamped
        if let Some(&i) = scene_index.get(sid) {
            let mut a = max_ordinal_anchor(&stamped_by_scene[i].1)?;
            a.source = "stamped".to_string();
            return Some(a);
        }
        None
    };

    // 1. 現在シーンの directAnchor（"scene" か "stamped"）。
    if let Some(a) = direct_anchor(scene_id) {
        return a;
    }

    // 2. proxy — 前方(index 小)で最も近い「directAnchor を持つシーン」。
    if let Some(&current_index) = reading_order.get(scene_id) {
        let mut best_scene: Option<&str> = None;
        let mut best_index: i64 = -1;
        // 候補 = stamp 済シーン ∪ 暦日付を持つシーン。
        for (cand_scene, _) in &stamped_by_scene {
            if let Some(&idx) = reading_order.get(cand_scene) {
                if idx < current_index && idx > best_index {
                    best_index = idx;
                    best_scene = Some(cand_scene.as_str());
                }
            }
        }
        for n in nodes {
            if node_has_date(n) {
                if let Some(&idx) = reading_order.get(&n.id) {
                    if idx < current_index && idx > best_index {
                        best_index = idx;
                        best_scene = Some(n.id.as_str());
                    }
                }
            }
        }
        if let Some(bs) = best_scene {
            if let Some(mut a) = direct_anchor(bs) {
                a.source = "proxy".to_string();
                a.proxy_scene_id = Some(bs.to_string());
                return a;
            }
        }
    }

    // 3. none
    ChronicleAnchor {
        ordinal: String::new(),
        start_time: None,
        start_minute: None,
        start_granularity: "none".to_string(),
        precision: None,
        source: "none".to_string(),
        proxy_scene_id: None,
    }
}

/// `deriveCharacterStateAt` の移植。
pub fn derive_character_state_at(
    character_id: &str,
    anchor: &ChronicleAnchor,
    events: &[EventInput],
    calendar: Option<&CalendarInput>,
) -> (String, Option<i64>) {
    let t = anchor.start_time;
    let mut birth_time: Option<i64> = None;
    let mut death_time: Option<i64> = None;
    for e in events {
        if e.primary_codex_id.as_deref() != Some(character_id) {
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
    (if dead { "dead" } else { "alive" }.to_string(), age)
}

/// `deriveLastKnownLocation` の移植。
pub fn derive_last_known_location(
    character_id: &str,
    anchor: &ChronicleAnchor,
    events: &[EventInput],
    participant_event_ids: &HashSet<String>,
    codex_names: &HashMap<String, String>,
) -> Option<String> {
    let mut best: Option<&EventInput> = None;
    for e in events {
        if e.location_codex_id.is_none() {
            continue;
        }
        if !at_or_before(&e.ordinal, &anchor.ordinal) {
            continue;
        }
        let involved = e.primary_codex_id.as_deref() == Some(character_id)
            || participant_event_ids.contains(&e.id);
        if !involved {
            continue;
        }
        match best {
            None => best = Some(e),
            Some(b) if cmp_keys(&e.ordinal, &b.ordinal) == Ordering::Greater => best = Some(e),
            _ => {}
        }
    }
    let best = best?;
    let loc = best.location_codex_id.as_ref()?;
    codex_names.get(loc).cloned()
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
    format_relative_days(e.start_time, anchor.start_time, approx, calendar, lang)
}

fn derive_recent_events(
    anchor: &ChronicleAnchor,
    events: &[EventInput],
    calendar: Option<&CalendarInput>,
    lang: &str,
) -> Vec<SnapshotEvent> {
    let mut filtered: Vec<&EventInput> = events
        .iter()
        .filter(|e| e.kind == "generic" && at_or_before(&e.ordinal, &anchor.ordinal))
        .collect();
    filtered.sort_by(|a, b| cmp_keys(&b.ordinal, &a.ordinal));
    filtered
        .into_iter()
        .take(MAX_RECENT)
        .map(|e| SnapshotEvent {
            event_id: e.id.clone(),
            title: truncate(&e.title, TITLE_CAP),
            note: e
                .note
                .as_ref()
                .filter(|n| !n.is_empty())
                .map(|n| truncate(n, NOTE_CAP)),
            rel_time: rel_time_for(e, anchor, calendar, lang),
        })
        .collect()
}

fn derive_unresolved_causal(
    anchor: &ChronicleAnchor,
    events: &[EventInput],
    relations: &[RelationInput],
) -> Vec<CausalPair> {
    let by_id: HashMap<&str, &EventInput> = events.iter().map(|e| (e.id.as_str(), e)).collect();
    let mut out = Vec::new();
    for r in relations {
        let (Some(cause), Some(effect)) = (
            by_id.get(r.cause_id.as_str()),
            by_id.get(r.effect_id.as_str()),
        ) else {
            continue;
        };
        if at_or_before(&cause.ordinal, &anchor.ordinal)
            && !at_or_before(&effect.ordinal, &anchor.ordinal)
        {
            out.push(CausalPair {
                cause_title: truncate(&cause.title, TITLE_CAP),
                effect_title: truncate(&effect.title, TITLE_CAP),
            });
        }
    }
    out
}

fn derive_offpage_events(
    anchor: &ChronicleAnchor,
    events: &[EventInput],
    scene_events: &[SceneEventInput],
    calendar: Option<&CalendarInput>,
    lang: &str,
) -> Vec<SnapshotEvent> {
    let stamped: HashSet<&str> = scene_events.iter().map(|se| se.event_id.as_str()).collect();
    let kind_rank = |k: &str| -> i64 {
        if k == "generic" {
            1
        } else {
            0
        }
    };
    let mut filtered: Vec<&EventInput> = events
        .iter()
        .filter(|e| !stamped.contains(e.id.as_str()))
        .filter(|e| anchor.source == "none" || at_or_before(&e.ordinal, &anchor.ordinal))
        .collect();
    filtered.sort_by(|a, b| {
        let rk = kind_rank(&a.kind).cmp(&kind_rank(&b.kind));
        if rk != Ordering::Equal {
            return rk;
        }
        cmp_keys(&b.ordinal, &a.ordinal)
    });
    filtered
        .into_iter()
        .take(MAX_OFFPAGE)
        .map(|e| SnapshotEvent {
            event_id: e.id.clone(),
            title: truncate(&e.title, TITLE_CAP),
            note: e
                .note
                .as_ref()
                .filter(|n| !n.is_empty())
                .map(|n| truncate(n, NOTE_CAP)),
            rel_time: rel_time_for(e, anchor, calendar, lang),
        })
        .collect()
}

/// `pickSnapshotCharacters` の移植（Phase 1 固定ルール）。挿入順を保持。
pub fn pick_snapshot_characters(
    anchor: &ChronicleAnchor,
    events: &[EventInput],
    participants: &[ParticipantInput],
    max: usize,
) -> Vec<String> {
    if anchor.source == "none" {
        return Vec::new();
    }
    let mut ids: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let push = |ids: &mut Vec<String>, seen: &mut HashSet<String>, id: &str| {
        if seen.insert(id.to_string()) {
            ids.push(id.to_string());
        }
    };

    let mut recent: Vec<&EventInput> = events
        .iter()
        .filter(|e| at_or_before(&e.ordinal, &anchor.ordinal))
        .collect();
    recent.sort_by(|a, b| cmp_keys(&b.ordinal, &a.ordinal));
    recent.truncate(MAX_RECENT);
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

/// Direct inputs for `deriveChronicleSnapshot` (anchor + characterIds already
/// resolved). Mirrors `ChronicleSnapshotInput`.
pub struct DeriveInput<'a> {
    pub anchor: &'a ChronicleAnchor,
    pub events: &'a [EventInput],
    pub participants: &'a [ParticipantInput],
    pub relations: &'a [RelationInput],
    pub scene_events: &'a [SceneEventInput],
    pub calendar: Option<&'a CalendarInput>,
    pub character_ids: &'a [String],
    pub codex_names: &'a HashMap<String, String>,
    /// formattedDate（暦駆動整形）のロケール。"en" 以外は ja 扱い。
    pub lang: &'a str,
}

/// `deriveChronicleSnapshot` の移植。
pub fn derive_chronicle_snapshot(input: DeriveInput<'_>) -> ChronicleSnapshot {
    let season = match (input.anchor.start_time, input.calendar) {
        (Some(t), Some(cal)) => season_of(t, cal),
        _ => None,
    };

    // 暦＋粒度(≠none)＋start_time が揃うときのみ整形済み日付を確定。空文字は None。
    let lang = if input.lang == "en" { "en" } else { "ja" };
    let formatted_date = match (input.calendar, input.anchor.start_time) {
        (Some(cal), Some(st)) if input.anchor.start_granularity != "none" => {
            let s = format_chronicle_date(
                Some(st),
                input.anchor.start_minute,
                &input.anchor.start_granularity,
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
    for p in input.participants {
        participants_by_codex
            .entry(p.codex_entry_id.as_str())
            .or_default()
            .insert(p.event_id.clone());
    }
    let empty: HashSet<String> = HashSet::new();

    let characters: Vec<CharacterState> = input
        .character_ids
        .iter()
        .take(MAX_CHARACTERS)
        .map(|cid| {
            let (status, age) =
                derive_character_state_at(cid, input.anchor, input.events, input.calendar);
            let pset = participants_by_codex.get(cid.as_str()).unwrap_or(&empty);
            let location = derive_last_known_location(
                cid,
                input.anchor,
                input.events,
                pset,
                input.codex_names,
            );
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

    ChronicleSnapshot {
        time: SnapshotTime {
            source: input.anchor.source.clone(),
            start_time: input.anchor.start_time,
            season,
            precision: input.anchor.precision.clone(),
            formatted_date,
        },
        characters,
        recent_events: derive_recent_events(input.anchor, input.events, input.calendar, lang),
        unresolved_causal: derive_unresolved_causal(input.anchor, input.events, input.relations),
        offpage: derive_offpage_events(
            input.anchor,
            input.events,
            input.scene_events,
            input.calendar,
            lang,
        ),
    }
}

/// Whole-pipeline inputs (scene_id + raw rows) for `assemble_snapshot`. Shared
/// JSON shape with the `chronicle-snapshot/*.json` fixtures' `input`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssembleInput {
    pub scene_id: String,
    #[serde(default)]
    pub nodes: Vec<SceneNode>,
    #[serde(default)]
    pub events: Vec<EventInput>,
    #[serde(default)]
    pub participants: Vec<ParticipantInput>,
    #[serde(default)]
    pub relations: Vec<RelationInput>,
    #[serde(default)]
    pub scene_events: Vec<SceneEventInput>,
    #[serde(default)]
    pub calendar: Option<CalendarInput>,
    #[serde(default)]
    pub codex_names: HashMap<String, String>,
    /// formattedDate ロケール（既定 "ja"）。TS fixtures の input.lang と対称。
    #[serde(default)]
    pub lang: Option<String>,
}

/// resolveSceneAnchor → pickSnapshotCharacters → deriveChronicleSnapshot を一括
/// （getChronicleStateTool / fixture テストと同じパイプライン）。
pub fn assemble_snapshot(input: &AssembleInput) -> ChronicleSnapshot {
    let reading_order = compute_global_scene_order(&input.nodes);
    let anchor = resolve_scene_anchor(
        &input.scene_id,
        &input.nodes,
        &input.scene_events,
        &input.events,
        &reading_order,
    );
    let character_ids = pick_snapshot_characters(
        &anchor,
        &input.events,
        &input.participants,
        MAX_PICK_CHARACTERS,
    );
    derive_chronicle_snapshot(DeriveInput {
        anchor: &anchor,
        events: &input.events,
        participants: &input.participants,
        relations: &input.relations,
        scene_events: &input.scene_events,
        calendar: input.calendar.as_ref(),
        character_ids: &character_ids,
        codex_names: &input.codex_names,
        lang: input.lang.as_deref().unwrap_or("ja"),
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

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
            let got = assemble_snapshot(&input);
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

    fn ev(id: &str, ordinal: &str, start_time: Option<i64>) -> EventInput {
        EventInput {
            id: id.to_string(),
            title: String::new(),
            note: None,
            ordinal: ordinal.to_string(),
            primary_codex_id: None,
            location_codex_id: None,
            start_time,
            start_minute: None,
            start_granularity: "none".to_string(),
            kind: "generic".to_string(),
            precision: "exact".to_string(),
        }
    }

    fn scene_node(id: &str, sort: &str, start_time: Option<i64>, gran: &str) -> SceneNode {
        SceneNode {
            id: id.to_string(),
            parent_id: None,
            node_type: "scene".to_string(),
            sort_order: sort.to_string(),
            chronicle_start_time: start_time,
            chronicle_start_minute: None,
            chronicle_start_granularity: gran.to_string(),
            chronicle_precision: "exact".to_string(),
        }
    }

    #[test]
    fn resolve_scene_anchor_scene_own_uses_synthetic_ordinal() {
        let nodes = vec![scene_node("s1", "a0", Some(100), "day")];
        let events = vec![
            ev("e1", "a1", Some(10)),
            ev("e2", "a2", Some(50)),
            ev("e3", "a3", Some(200)),
        ];
        let order = compute_global_scene_order(&nodes);
        let a = resolve_scene_anchor("s1", &nodes, &[], &events, &order);
        assert_eq!(a.source, "scene");
        assert_eq!(a.start_time, Some(100));
        // startTime<=100 のうち最大=50(e2 a2) → synthetic ordinal=a2
        assert_eq!(a.ordinal, "a2");
    }

    #[test]
    fn resolve_scene_anchor_scene_own_beats_stamped() {
        let nodes = vec![scene_node("s1", "a0", Some(100), "day")];
        let events = vec![ev("e1", "a9", Some(5))];
        let scene_events = vec![SceneEventInput {
            scene_id: "s1".to_string(),
            event_id: "e1".to_string(),
        }];
        let order = compute_global_scene_order(&nodes);
        let a = resolve_scene_anchor("s1", &nodes, &scene_events, &events, &order);
        assert_eq!(a.source, "scene");
        assert_eq!(a.start_time, Some(100));
    }

    #[test]
    fn resolve_scene_anchor_none_granularity_does_not_fire_scene_own() {
        let nodes = vec![scene_node("s1", "a0", Some(100), "none")];
        let events = vec![ev("e1", "a3", Some(30))];
        let scene_events = vec![SceneEventInput {
            scene_id: "s1".to_string(),
            event_id: "e1".to_string(),
        }];
        let order = compute_global_scene_order(&nodes);
        let a = resolve_scene_anchor("s1", &nodes, &scene_events, &events, &order);
        assert_eq!(a.source, "stamped");
        assert_eq!(a.start_time, Some(30));
    }

    #[test]
    fn resolve_scene_anchor_proxy_considers_scene_own_scene() {
        let nodes = vec![
            scene_node("s1", "a0", Some(100), "day"),
            scene_node("s2", "a1", None, "none"),
        ];
        let events = vec![ev("e1", "a1", Some(10)), ev("e2", "a2", Some(80))];
        let order = compute_global_scene_order(&nodes);
        let a = resolve_scene_anchor("s2", &nodes, &[], &events, &order);
        assert_eq!(a.source, "proxy");
        assert_eq!(a.proxy_scene_id.as_deref(), Some("s1"));
        assert_eq!(a.start_time, Some(100));
        // s1 の scene-own anchor の synthetic ordinal=a2(e2 startTime80<=100)
        assert_eq!(a.ordinal, "a2");
    }

    #[test]
    fn at_or_before_none_anchor_is_false() {
        assert!(!at_or_before("a0", ""));
        assert!(at_or_before("a0", "a0"));
        assert!(at_or_before("a0", "a1"));
        assert!(!at_or_before("a2", "a1"));
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
