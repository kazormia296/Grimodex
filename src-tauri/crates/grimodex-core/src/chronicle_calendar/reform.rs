//! ユリウス暦からグレゴリオ暦への改暦（画面の側 `chronicleReform.ts` と同じ結果を返す写し）。
//!
//! 実暦のユリウス／グレゴリオ変換をユリウス通日（JDN）経由で行う。切替の前はユリウス閏
//! （4 年ごと）、後はグレゴリオ閏（4／100／400）で、切替の日飛ばしは日付のラベルだけに出る
//! （日番号は連続する）。純関数だけで、乱数・時刻・IO を使わない。
//!
//! 整数は `i128` で持つ。割り算は JavaScript の `Math.floor` に合わせて床（`div_euclid`）で
//! 丸める（負の日・起点より前の年でも同じ結果になる）。

use serde::Deserialize;

/// 切替後の最初のグレゴリオ暦の日付（月は 0 始まり）。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GregorianStart {
    /// 暦年。
    pub year: i64,
    /// 月の番号（0 始まり）。
    pub month_index: i64,
    /// 月内の日（1 始まり）。
    pub day_of_month: i64,
}

/// 改暦の定義。`gregorian_start` 以降がグレゴリオ暦で、その前がユリウス暦。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarReform {
    /// 切替後の最初のグレゴリオ暦の日付。
    pub gregorian_start: GregorianStart,
    /// 改暦の識別名（表示用・任意）。計算には使わない。
    #[serde(default)]
    pub region: Option<String>,
}

/// 暦の年・月・日（月は JDN 変換では 1〜12）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CivilDate {
    /// 暦年。
    pub year: i128,
    /// 月。
    pub month: i128,
    /// 日。
    pub day: i128,
}

/// 改暦の暦の日付（月は 0 始まり）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReformDate {
    /// 暦年。
    pub year: i128,
    /// 月の番号（0 始まり）。
    pub month_index: i128,
    /// 月内の日（1 始まり）。
    pub day_of_month: i128,
}

/// 床の割り算（`Math.floor(a / b)` と同じ。`b` は正）。
fn fl(a: i128, b: i128) -> i128 {
    a.div_euclid(b)
}

/// グレゴリオ暦の (年, 月 = 1〜12, 日) をユリウス通日（JDN）にする。
pub fn gregorian_to_jdn(year: i128, month: i128, day: i128) -> i128 {
    let a = fl(14 - month, 12);
    let y = year + 4800 - a;
    let m = month + 12 * a - 3;
    day + fl(153 * m + 2, 5) + 365 * y + fl(y, 4) - fl(y, 100) + fl(y, 400) - 32045
}

/// ユリウス暦の (年, 月 = 1〜12, 日) をユリウス通日（JDN）にする。
pub fn julian_to_jdn(year: i128, month: i128, day: i128) -> i128 {
    let a = fl(14 - month, 12);
    let y = year + 4800 - a;
    let m = month + 12 * a - 3;
    day + fl(153 * m + 2, 5) + 365 * y + fl(y, 4) - 32083
}

/// ユリウス通日（JDN）をグレゴリオ暦の (年, 月 = 1〜12, 日) にする。
pub fn jdn_to_gregorian(jdn: i128) -> CivilDate {
    let a = jdn + 32044;
    let b = fl(4 * a + 3, 146_097);
    let c = a - fl(146_097 * b, 4);
    let d = fl(4 * c + 3, 1461);
    let e = c - fl(1461 * d, 4);
    let m = fl(5 * e + 2, 153);
    CivilDate {
        day: e - fl(153 * m + 2, 5) + 1,
        month: m + 3 - 12 * fl(m, 10),
        year: 100 * b + d - 4800 + fl(m, 10),
    }
}

/// ユリウス通日（JDN）をユリウス暦の (年, 月 = 1〜12, 日) にする。
pub fn jdn_to_julian(jdn: i128) -> CivilDate {
    let c = jdn + 32082;
    let d = fl(4 * c + 3, 1461);
    let e = c - fl(1461 * d, 4);
    let m = fl(5 * e + 2, 153);
    CivilDate {
        day: e - fl(153 * m + 2, 5) + 1,
        month: m + 3 - 12 * fl(m, 10),
        year: d - 4800 + fl(m, 10),
    }
}

/// 切替後の最初のグレゴリオ日付の JDN（これ以上がグレゴリオ暦）。
pub fn cutover_jdn(reform: &CalendarReform) -> i128 {
    let g = &reform.gregorian_start;
    gregorian_to_jdn(
        i128::from(g.year),
        i128::from(g.month_index) + 1,
        i128::from(g.day_of_month),
    )
}

/// 日番号 0（= 起点の年の 1 月 1 日）の JDN。その日が切替の前ならユリウス暦、後ならグレゴリオ暦。
pub fn reform_jdn0(start_year: i128, reform: &CalendarReform) -> i128 {
    let j = julian_to_jdn(start_year, 1, 1);
    if j >= cutover_jdn(reform) {
        gregorian_to_jdn(start_year, 1, 1)
    } else {
        j
    }
}

/// 日付が切替の後（グレゴリオ暦）か。（年, 月, 日）の辞書順の比較。
fn is_after_cutover(
    year: i128,
    month_index: i128,
    day_of_month: i128,
    reform: &CalendarReform,
) -> bool {
    let g = &reform.gregorian_start;
    if year != i128::from(g.year) {
        return year > i128::from(g.year);
    }
    if month_index != i128::from(g.month_index) {
        return month_index > i128::from(g.month_index);
    }
    day_of_month >= i128::from(g.day_of_month)
}

/// 改暦の暦の日番号を、年・月（0 始まり）・日にする。
pub fn reform_day_to_date(day: i128, start_year: i128, reform: &CalendarReform) -> ReformDate {
    let jdn = day + reform_jdn0(start_year, reform);
    let dt = if jdn >= cutover_jdn(reform) {
        jdn_to_gregorian(jdn)
    } else {
        jdn_to_julian(jdn)
    };
    ReformDate {
        year: dt.year,
        month_index: dt.month - 1,
        day_of_month: dt.day,
    }
}

/// 改暦の暦の年・月（0 始まり）・日を、日番号にする。
pub fn reform_date_to_day(
    year: i128,
    month_index: i128,
    day_of_month: i128,
    start_year: i128,
    reform: &CalendarReform,
) -> i128 {
    let jdn = if is_after_cutover(year, month_index, day_of_month, reform) {
        gregorian_to_jdn(year, month_index + 1, day_of_month)
    } else {
        julian_to_jdn(year, month_index + 1, day_of_month)
    };
    jdn - reform_jdn0(start_year, reform)
}

/// 改暦の暦の (年, 月の番号) の日数（切替の月は短い。12 か月に固定）。
pub fn reform_month_length(year: i128, month_index: i128, reform: &CalendarReform) -> i128 {
    let (next_year, next_month) = if month_index >= 11 {
        (year + 1, 0)
    } else {
        (year, month_index + 1)
    };
    // 月初どうしの JDN の差（起点の年は差で相殺されるので 0 でよい）。
    reform_date_to_day(next_year, next_month, 1, 0, reform)
        - reform_date_to_day(year, month_index, 1, 0, reform)
}

/// 改暦の暦の暦年の総日数（切替の年は短い）。
pub fn reform_days_in_year(year: i128, reform: &CalendarReform) -> i128 {
    reform_date_to_day(year + 1, 0, 1, 0, reform) - reform_date_to_day(year, 0, 1, 0, reform)
}
