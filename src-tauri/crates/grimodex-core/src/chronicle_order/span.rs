//! 年表の「日時の幅」（CED/1 の K2、判断の記録 DR-CED-3・4・5。画面の側 `chronicleSpan.ts` の写し）。
//!
//! 出来事・場面の作中日付・現在地を、同じ部品で「分の区間」にする。
//!
//! - 単位は分（日 × 1440 + 分）。区間は、始まりを含み、終わりを含まない。
//! - 日時が無ければ `None`（開始の日が無いか、粒度が `none`・知らない文字列）。
//! - 粒度の幅：`time` は 1 分、`day` は 1 日、`month`／`season`／`year` は暦から求めた期間。
//!   暦から求められない粒度（月の定義が無い、季節の境界が無い、1 年の日数が決まらない、
//!   暦が `None`）は、保存された開始の 1 日にする（決定 13）。
//! - 分は、粒度が `time` のときだけ数える（無ければ 0 分）。`day` 以上の粒度に残った分は数えない。
//!
//! 画面の側は JavaScript の数（浮動小数）で分を持つ。2^53 を超えると画面の側の値が正確で
//! なくなるので、始まりか終わりの分が ±(2^53 - 1) を超える幅は、求められないものとして
//! `None`（日時が無い）にする。通常の日付（日番号で ±6 兆日まで）には影響しない。

use serde::{Deserialize, Serialize};

use crate::chronicle_calendar::{
    calendar_days_per_year, date_to_day_number, day_number_to_date, days_in_year, month_length,
    ChronicleCalendar,
};

/// 1 日の分数。
///
/// `chronicle_time::MINUTES_PER_DAY`（`i64`）と同じ値の別の定義（画面の側の `chronicleSpan.ts` と
/// `chronicleTime.ts` の同じ事情）。この PR は既にある file を変えないので、
/// 切り替えの PR（`chronicle_time` を新しい関数に寄せる PR）で、どちらかに統合する。
pub const MINUTES_PER_DAY: i128 = 24 * 60;

/// 幅の分の値の絶対値の上限（JavaScript の数で正確に持てる整数の最大）。
const MAX_SAFE_MINUTES: i128 = 9_007_199_254_740_991;

/// 分の区間（始まりを含み、終わりを含まない）。常に `end > start`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChronicleSpan {
    /// 区間の始まり（分。含む）。
    pub start: i128,
    /// 区間の終わり（分。含まない）。
    pub end: i128,
}

/// 日時の始まり 1 点分の入力（出来事の開始・場面の作中日付・現在地に共通）。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleDateInput {
    /// 開始の日（紀元からの日数）。無ければ `None`。
    #[serde(default)]
    pub start_time: Option<f64>,
    /// 開始の分。無ければ `None`。
    #[serde(default)]
    pub start_minute: Option<f64>,
    /// 粒度。知らない文字列も受ける（日時が無いものとして扱う）。
    pub start_granularity: String,
}

/// 出来事の幅を出すのに要る欄。粒度は、知らない文字列も受ける。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleEventSpanRow {
    /// 開始の日。
    #[serde(default)]
    pub start_time: Option<f64>,
    /// 開始の分。
    #[serde(default)]
    pub start_minute: Option<f64>,
    /// 開始の粒度。
    pub start_granularity: String,
    /// 終わりの日。
    #[serde(default)]
    pub end_time: Option<f64>,
    /// 終わりの分。
    #[serde(default)]
    pub end_minute: Option<f64>,
    /// 終わりの粒度。
    pub end_granularity: String,
}

impl ChronicleEventSpanRow {
    fn start_input(&self) -> ChronicleDateInput {
        ChronicleDateInput {
            start_time: self.start_time,
            start_minute: self.start_minute,
            start_granularity: self.start_granularity.clone(),
        }
    }

    fn end_input(&self) -> ChronicleDateInput {
        ChronicleDateInput {
            start_time: self.end_time,
            start_minute: self.end_minute,
            start_granularity: self.end_granularity.clone(),
        }
    }
}

/// 現在地の出どころ。`scene` は場面自身の作中日付、`stamped` は場面に結び付いた出来事、
/// `proxy` は前方の最も近い場面の代理、`none` は決まらない。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChronicleAnchorSource {
    /// 場面自身の作中日付。
    Scene,
    /// 場面に結び付いた出来事。
    Stamped,
    /// 前方の最も近い場面の代理。
    Proxy,
    /// 決まらない。
    None,
}

/// 現在地の幅を出すのに要る欄。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleAnchorSpanInput {
    /// 現在地の出どころ。
    pub source: ChronicleAnchorSource,
    /// 開始の日。
    #[serde(default)]
    pub start_time: Option<f64>,
    /// 開始の分。
    #[serde(default)]
    pub start_minute: Option<f64>,
    /// 開始の粒度。
    pub start_granularity: String,
}

/// 日時を持てる粒度（`none` と知らない文字列は含まない）。
pub(crate) fn is_dated_granularity(granularity: &str) -> bool {
    matches!(granularity, "time" | "day" | "month" | "season" | "year")
}

/// 開始の日が有限の数なら、その値。
fn finite_start_time(date: &ChronicleDateInput) -> Option<f64> {
    date.start_time.filter(|t| t.is_finite())
}

/// 日時がある＝開始の日が有限の数で、粒度が `time`／`day`／`month`／`season`／`year`（DR-CED-3）。
/// 欄を 1 つずつ受ける版。日時の有無の規則は、ここだけが持つ。
pub(crate) fn has_date_parts(time: Option<f64>, granularity: &str) -> bool {
    time.is_some_and(f64::is_finite) && is_dated_granularity(granularity)
}

/// 日時がある＝開始の日が有限の数で、粒度が `time`／`day`／`month`／`season`／`year`（DR-CED-3）。
pub fn has_chronicle_date(date: &ChronicleDateInput) -> bool {
    has_date_parts(date.start_time, &date.start_granularity)
}

/// `value` の絶対値が `limit` 以下か。`i128::MIN` でも桁あふれしない（`abs()` を使わない）。
fn within(value: i128, limit: i128) -> bool {
    (-limit..=limit).contains(&value)
}

/// 分の区間を作る。始まりか終わりが正確に持てる範囲の外なら `None`。
fn checked_span(start: i128, end: i128) -> Option<ChronicleSpan> {
    if !within(start, MAX_SAFE_MINUTES) || !within(end, MAX_SAFE_MINUTES) {
        return None;
    }
    Some(ChronicleSpan { start, end })
}

/// 保存された日 1 日ぶんの幅。
fn day_span(day: i128) -> Option<ChronicleSpan> {
    checked_span(day * MINUTES_PER_DAY, (day + 1) * MINUTES_PER_DAY)
}

/// 求めた期間（日数の始まりと終わり）を分の区間にする。
/// 終わりが始まり以下、または分が正確に持てる範囲の外のときは `None`にして、
/// 呼び出す側が「求められない」として、保存された 1 日に戻れるようにする。
fn span_of_days(start_day: i128, end_day: i128) -> Option<ChronicleSpan> {
    if end_day <= start_day {
        return None;
    }
    // 日が大きすぎる値の乗算で桁あふれしないように、先に日で範囲を見る。
    let limit = MAX_SAFE_MINUTES / MINUTES_PER_DAY + 1;
    if !within(start_day, limit) || !within(end_day, limit) {
        return None;
    }
    checked_span(start_day * MINUTES_PER_DAY, end_day * MINUTES_PER_DAY)
}

/// 1 年の日数が決まっているか（改暦は年の長さを実暦から求める）。
fn year_length_known(cal: &ChronicleCalendar) -> bool {
    cal.reform.is_some() || calendar_days_per_year(cal) > 0
}

/// その日が入る月の、初日から末日まで。月の定義が無ければ `None`。
fn month_span_of(day: i128, cal: &ChronicleCalendar) -> Option<ChronicleSpan> {
    let date = day_number_to_date(day, cal);
    let month_index = date.month_index?;
    // 改暦の月は、切替の日飛ばしで「日 − 月内日 + 1」が月初にならないので、暦に月初を聞く。
    let first = date_to_day_number(date.year, Some(month_index), Some(1), cal);
    let length = month_length(date.year, month_index, cal);
    if length <= 0 || day < first || day >= first + length {
        return None;
    }
    span_of_days(first, first + length)
}

/// その日が入る年の、初日から末日まで。1 年の日数が決まらなければ `None`。
fn year_span_of(day: i128, cal: &ChronicleCalendar) -> Option<ChronicleSpan> {
    if !year_length_known(cal) {
        return None;
    }
    let date = day_number_to_date(day, cal);
    let first = day - date.day_of_year;
    let length = days_in_year(date.year, cal);
    if length <= 0 || day >= first + length {
        return None;
    }
    span_of_days(first, first + length)
}

/// 季節の始まり（年内通日）を、昇順・有限の整数だけで返す。
///
/// 端数のある始まりは除く（`i128` の分の区間に載らないため。暦の編集画面は整数にし、
/// 抽出の暦の写しも安全整数を要求するので、通常の入力では起きない。画面の側は端数のまま使う）。
/// 桁が非常に大きい値は `as i128` で飽和するが、続く計算は桁あふれを検査して `None` にする。
fn sorted_season_starts(cal: &ChronicleCalendar) -> Vec<i128> {
    let mut starts: Vec<i128> = cal
        .season_boundaries
        .iter()
        .map(|b| b.start_day_of_year)
        .filter(|s| s.is_finite() && s.fract() == 0.0)
        .map(|s| s as i128)
        .collect();
    starts.sort_unstable();
    starts
}

/// その日が入る季節の、始まりから、次の境界の前まで。
///
/// `season_of` と同じ巻き込みの規則：最初の境界より前の通日は、前の年の最後の境界から続く季節。
/// 最後の季節は、次の年の最初の境界まで続く（年をまたぐ）。境界が無ければ `None`。
/// 季節の始まりが極端に大きく、日数の計算が桁あふれするときも `None`
/// （画面の側も、そのとき期間を求められず、保存された日の 1 日に戻る）。
fn season_span_of(day: i128, cal: &ChronicleCalendar) -> Option<ChronicleSpan> {
    if !year_length_known(cal) {
        return None;
    }
    let starts = sorted_season_starts(cal);
    let first_start = *starts.first()?;
    let date = day_number_to_date(day, cal);
    let year_first = day.checked_sub(date.day_of_year)?;
    let doy = date.day_of_year;
    let (start, end);
    if doy < first_start {
        // 前の年の最後の季節が、年初まで巻き込んでいる。
        let last_start = starts[starts.len() - 1];
        start = year_first
            .checked_sub(days_in_year(date.year - 1, cal))?
            .checked_add(last_start)?;
        end = year_first.checked_add(first_start)?;
    } else {
        let mut i = 0;
        while i + 1 < starts.len() && starts[i + 1] <= doy {
            i += 1;
        }
        start = year_first.checked_add(starts[i])?;
        end = if i + 1 < starts.len() {
            year_first.checked_add(starts[i + 1])?
        } else {
            year_first
                .checked_add(days_in_year(date.year, cal))?
                .checked_add(first_start)?
        };
    }
    if end <= start || day < start || day >= end {
        return None;
    }
    span_of_days(start, end)
}

/// 有限の分は切り捨てて、無ければ 0。
fn minute_or_zero(minute: Option<f64>) -> i128 {
    minute.filter(|m| m.is_finite()).map_or(0, |m| {
        // 桁あふれを避けるため、先に十分大きい値へ丸める（範囲の外は幅の検査で `None` になる）。
        m.floor().clamp(-1e18, 1e18) as i128
    })
}

/// 日時の始まり 1 点の、粒度の幅（DR-CED-4）。日時が無ければ `None`。
///
/// 月・季節・年は、暦から求めた期間（保存された日が期間の初日でなくてよい）。
/// 暦から求められなければ、保存された日の 1 日。
pub fn chronicle_date_span(
    date: &ChronicleDateInput,
    calendar: Option<&ChronicleCalendar>,
) -> Option<ChronicleSpan> {
    if !has_chronicle_date(date) {
        return None;
    }
    let start_time = finite_start_time(date)?.floor();
    // 日が大きすぎる値は、分にしたとき正確に持てない。
    if start_time.abs() > (MAX_SAFE_MINUTES / MINUTES_PER_DAY + 1) as f64 {
        return None;
    }
    let day = start_time as i128;
    match date.start_granularity.as_str() {
        "time" => {
            let start = day * MINUTES_PER_DAY + minute_or_zero(date.start_minute);
            checked_span(start, start + 1)
        }
        "month" => calendar
            .and_then(|c| month_span_of(day, c))
            .or_else(|| day_span(day)),
        "season" => calendar
            .and_then(|c| season_span_of(day, c))
            .or_else(|| day_span(day)),
        "year" => calendar
            .and_then(|c| year_span_of(day, c))
            .or_else(|| day_span(day)),
        // "day"。分が残っていても数えない。
        _ => day_span(day),
    }
}

/// 出来事の幅（K2）。開始の幅の始まりから、終わりがあれば、終わりの粒度の幅の終わりまで。
///
/// 終わりが無い・終わりの粒度が `none`／知らない文字列・終わりが開始の幅の始まり以前
/// （終わりの幅の全部が開始より前）のときは、終わりが無いものとして、開始の粒度の幅を返す。
/// 開始に日時が無ければ `None`（終わりだけがある出来事を含む）。
/// 「終わりが開始より前」の「開始」は、開始の幅の始まりである（DR-CED-10）。保存された開始の日ではない。
/// 月・季節・年の開始で、終わりが、その幅の中の、保存された日より前の日のときは、終わりを使う。
pub fn event_span(
    row: &ChronicleEventSpanRow,
    calendar: Option<&ChronicleCalendar>,
) -> Option<ChronicleSpan> {
    let start_span = chronicle_date_span(&row.start_input(), calendar)?;
    if row.end_time.is_none() {
        return Some(start_span);
    }
    match chronicle_date_span(&row.end_input(), calendar) {
        Some(end_span) if end_span.end > start_span.start => Some(ChronicleSpan {
            start: start_span.start,
            end: end_span.end,
        }),
        _ => Some(start_span),
    }
}

/// 現在地の幅。場面の作中日付で決まった現在地は、その日付の粒度の幅。
/// 出来事で決まった現在地は、その出来事の開始の粒度の幅だけで、終わりは使わない（◇11、DR-CED-5）。
/// 現在地が決まらない（`source` が `none`）か、日時が無ければ `None`。
pub fn anchor_span(
    anchor: &ChronicleAnchorSpanInput,
    calendar: Option<&ChronicleCalendar>,
) -> Option<ChronicleSpan> {
    if anchor.source == ChronicleAnchorSource::None {
        return None;
    }
    chronicle_date_span(
        &ChronicleDateInput {
            start_time: anchor.start_time,
            start_minute: anchor.start_minute,
            start_granularity: anchor.start_granularity.clone(),
        },
        calendar,
    )
}
