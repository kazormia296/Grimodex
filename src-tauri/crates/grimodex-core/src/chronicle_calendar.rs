//! 作中暦の計算（画面の側 `chronicleTime.ts` の日付・日番号・季節の関数と同じ結果を返す写し）。
//!
//! 年表の「日時の幅」（[`crate::chronicle_order`]）が使う暦の関数だけを、DB に依らない
//! 構造体の上に置く。入力の JSON は画面の側の `ChronicleCalendar` と同じ形（camelCase。
//! 無い欄・`null` の欄は、画面の側の「未指定」と同じ既定）で受ける。
//!
//! 結果を揃えるための決まり:
//!
//! - 日番号・年・月などの整数は `i128` で持つ。割り算と剰余は JavaScript の `Math.floor`
//!   に合わせて床（`div_euclid`／`rem_euclid`）で丸める（負の日・起点より前の年でも同じ）。
//! - 月の定義が空、1 年の日数が 0 以下、うるう月の番号が範囲の外、のときの防御の分岐も、
//!   画面の側と同じに写す。
//! - 画面の側が JavaScript の浮動小数で受ける欄のうち、整数として使われるもの
//!   （`daysPerYear`・`startYear`・月の日数の端数以外）は、整数だけを受ける。
//!   季節の始まりの日は、有限の整数だけを使う（画面の側の `Number.isFinite` の除外に加えて、
//!   端数のあるものも除く。保存される値は整数で、端数は分の幅が整数でなくなるため）。
//! - 画面の側にある曜日・元号・タイムゾーン・年齢などは、幅の計算に要らないので、
//!   曜日（`weekday_of`）以外は写さない。
//!
//! 改暦（ユリウス暦からグレゴリオ暦）は `reform` にある。公開するのは定義の型
//! （[`CalendarReform`]・[`GregorianStart`]）だけで、JDN の変換などの内部の関数は、
//! 幅の計算の外から使う予定が無いので、この crate の中に閉じる（使う PR で広げる）。
//! 曜日（`weekday_of`）も同じ。

mod reform;

use serde::{Deserialize, Deserializer};

use reform::{reform_date_to_day, reform_day_to_date, reform_days_in_year, reform_month_length};
pub use reform::{CalendarReform, GregorianStart};

/// 季節の境界。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeasonBoundary {
    /// 季節の名前（例「冬」）。
    #[serde(default)]
    pub name: String,
    /// その季節が始まる年内通日（0 始まり）。`null`・欠けは NaN（使わない値）として読む。
    #[serde(default = "nan", deserialize_with = "de_f64_or_nan")]
    pub start_day_of_year: f64,
}

fn nan() -> f64 {
    f64::NAN
}

fn de_f64_or_nan<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    Ok(Option::<f64>::deserialize(d)?.unwrap_or(f64::NAN))
}

/// 月の整数の日数。端数は切り捨てる（画面の側の `Math.floor`）。`null` は 0。
fn de_floor_i64<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
    // 浮動小数から整数への `as` は飽和し、NaN は 0 になる。
    Ok(Option::<f64>::deserialize(d)?.map_or(0, |f| f.floor() as i64))
}

/// 暦の月の定義（名前と日数）。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthDef {
    /// 月の名前。
    #[serde(default)]
    pub name: String,
    /// その月の日数（基準）。計算では 1 未満を 1 にそろえる。
    #[serde(default, deserialize_with = "de_floor_i64")]
    pub days: i64,
}

impl MonthDef {
    /// 計算に使う基準の日数（画面の側の `Math.max(1, Math.floor(days))`）。
    fn effective_days(&self) -> i128 {
        i128::from(self.days.max(1))
    }
}

/// うるう年の種類。`none` は 1 年の長さが一定（既定）。`gregorian` は暦年に 4／100／400 の
/// 規則を当て、`month_index` の月に 1 日足す。知らない種類は `none` と同じに扱う。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind")]
pub enum LeapRule {
    /// 1 年の長さが一定。
    #[serde(rename = "none")]
    None,
    /// グレゴリオ式のうるう年。
    #[serde(rename = "gregorian")]
    Gregorian {
        /// 1 日足す月の番号（0 始まり）。範囲の外・欠けは、どの月にも足されない
        /// （年の日数にだけ 1 日が足される）。
        #[serde(default, rename = "monthIndex")]
        month_index: Option<f64>,
    },
    /// 知らない種類。`none` と同じ。
    #[serde(other)]
    Other,
}

/// 作中暦。画面の側の `ChronicleCalendar` のうち、日付・日番号・季節・幅に使う欄。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleCalendar {
    /// 1 年の基準の日数。月の定義があれば月の日数の合計が正本で、この値は月が無いときの代わり。
    pub days_per_year: i64,
    /// 季節の境界。始まりの日の昇順の循環した区間として読む。
    #[serde(default)]
    pub season_boundaries: Vec<SeasonBoundary>,
    /// 暦の開始年。日番号 0 は、この年の最初の月の 1 日。未指定は 0。
    #[serde(default)]
    pub start_year: Option<i64>,
    /// 月の定義。空・未指定なら、月の概念が無い（年内通日だけを扱う）。
    #[serde(default)]
    pub months: Option<Vec<MonthDef>>,
    /// 曜日の名前。空・未指定なら曜日が無い。
    #[serde(default)]
    pub weekday_names: Option<Vec<String>>,
    /// 日番号 0 の曜日の番号。未指定は 0。
    #[serde(default)]
    pub weekday_start_index: Option<i64>,
    /// うるう年の規則。未指定は `none`。
    #[serde(default)]
    pub leap: Option<LeapRule>,
    /// ユリウス暦からグレゴリオ暦への改暦。指定があれば、日付と日番号の変換・月と年の長さは
    /// 実暦の変換に任せる。
    #[serde(default)]
    pub reform: Option<CalendarReform>,
}

/// 日番号から求めた作中の日付。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChronicleDate {
    /// 暦年（開始年を基準にした年）。
    pub year: i128,
    /// 月の番号（0 始まり）。月が無ければ `None`。
    pub month_index: Option<i128>,
    /// 月内の日（1 始まり）。月が無ければ `None`。
    pub day_of_month: Option<i128>,
    /// 年内通日（0 始まり）。
    pub day_of_year: i128,
    /// 曜日の番号（0 始まり）。曜日が無ければ `None`。
    pub weekday_index: Option<i128>,
}

impl ChronicleCalendar {
    fn start_year(&self) -> i128 {
        i128::from(self.start_year.unwrap_or(0))
    }
}

/// 暦の実効の基準 1 年の日数。月の定義があれば月の日数の合計、無ければ保存された
/// `days_per_year`（うるう日は含まない）。
pub fn calendar_days_per_year(cal: &ChronicleCalendar) -> i128 {
    if let Some(months) = cal.months.as_ref().filter(|m| !m.is_empty()) {
        let sum: i128 = months.iter().map(MonthDef::effective_days).sum();
        if sum > 0 {
            return sum;
        }
    }
    i128::from(cal.days_per_year)
}

/// グレゴリオ式のうるう年か（暦年に 4／100／400 の規則。負の年も床で一貫）。
/// 先発グレゴリオ暦の月の日数（`chronicle_order::instant`）も、この 1 つを使う。
pub(crate) fn is_gregorian_leap(year: i128) -> bool {
    year.rem_euclid(4) == 0 && (year.rem_euclid(100) != 0 || year.rem_euclid(400) == 0)
}

/// 暦年がうるう年か（規則がグレゴリオ式でなければ常に偽）。
pub fn is_leap_year(year: i128, cal: &ChronicleCalendar) -> bool {
    matches!(cal.leap, Some(LeapRule::Gregorian { .. })) && is_gregorian_leap(year)
}

/// 暦年の総日数（基準とうるう日）。改暦のある暦では実暦の年の長さ（切替の年は短い）。
pub fn days_in_year(year: i128, cal: &ChronicleCalendar) -> i128 {
    if let Some(reform) = &cal.reform {
        return reform_days_in_year(year, reform);
    }
    calendar_days_per_year(cal) + i128::from(is_leap_year(year, cal))
}

/// 暦年・月の番号の月の日数（うるう月なら 1 日多い）。月が無い（番号が範囲の外を含む）なら 0。
pub fn month_length(year: i128, month_index: i128, cal: &ChronicleCalendar) -> i128 {
    if let Some(reform) = &cal.reform {
        return reform_month_length(year, month_index, reform);
    }
    let Some(month) = usize::try_from(month_index)
        .ok()
        .and_then(|i| cal.months.as_ref().and_then(|m| m.get(i)))
    else {
        return 0;
    };
    let base = month.effective_days();
    if let Some(LeapRule::Gregorian {
        month_index: Some(leap_month),
    }) = &cal.leap
    {
        if *leap_month == month_index as f64 && is_leap_year(year, cal) {
            return base + 1;
        }
    }
    base
}

/// 半開区間 [lo, hi) にある `m` の倍数の個数（負の数でも床で一貫）。
fn divisible_count(lo: i128, hi: i128, m: i128) -> i128 {
    if hi <= lo {
        return 0;
    }
    (hi - 1).div_euclid(m) - (lo - 1).div_euclid(m)
}

/// 半開区間 [lo, hi) にあるグレゴリオ式のうるう年の数。
fn greg_leaps_in(lo: i128, hi: i128) -> i128 {
    divisible_count(lo, hi, 4) - divisible_count(lo, hi, 100) + divisible_count(lo, hi, 400)
}

/// 暦年の「年内通日 0」の日番号（開始年の年初が日番号 0）。
fn year_start_day(year: i128, cal: &ChronicleCalendar) -> i128 {
    let start_year = cal.start_year();
    let base = calendar_days_per_year(cal);
    let extra = if matches!(cal.leap, Some(LeapRule::Gregorian { .. })) {
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

/// 日番号から曜日の番号。曜日の名前が無ければ `None`。
fn weekday_of(day: i128, cal: &ChronicleCalendar) -> Option<i128> {
    let len = cal.weekday_names.as_ref().map_or(0, Vec::len);
    if len == 0 {
        return None;
    }
    let start = i128::from(cal.weekday_start_index.unwrap_or(0));
    Some((day + start).rem_euclid(len as i128))
}

/// グレゴリオ式のうるう年のある暦で、日番号 `d` が入る年（`year_start_day(y) <= d` を満たす
/// 最大の年）を求める。画面の側は推定の年から 1 年ずつ補正するが、年の始まりは年について
/// 単調に増える（1 年の日数は 1 以上）ので、解は 1 つに決まり、二分探索で同じ年を求める。
fn gregorian_year_of(d: i128, dpy: i128, cal: &ChronicleCalendar) -> i128 {
    let start_year = cal.start_year();
    let estimate = start_year + d.div_euclid(dpy);
    let (mut lo, mut hi);
    if year_start_day(estimate, cal) > d {
        // 推定が大きすぎる。下へ広げて、始まりが d 以下になる年を探す。
        hi = estimate;
        let mut step = 1;
        lo = estimate - step;
        while year_start_day(lo, cal) > d {
            hi = lo;
            step *= 2;
            lo -= step;
        }
    } else {
        lo = estimate;
        let mut step = 1;
        hi = estimate + step;
        while year_start_day(hi, cal) <= d {
            lo = hi;
            step *= 2;
            hi += step;
        }
    }
    // 不変条件: year_start_day(lo) <= d < year_start_day(hi)。
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        if year_start_day(mid, cal) <= d {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    lo
}

/// 日番号（紀元からの通日）から、作中の日付の構成要素を求める。
///
/// 日番号 0 は、開始年の最初の月の 1 日。負の日も、床の割り算で前の年へ循環する。
/// 1 年の日数が 0 以下（改暦の暦は除く）なら、開始年・月なし・年内通日 0 を返す。
pub fn day_number_to_date(day: i128, cal: &ChronicleCalendar) -> ChronicleDate {
    let d = day;
    let dpy = calendar_days_per_year(cal);
    let start_year = cal.start_year();
    let weekday_index = weekday_of(d, cal);
    if let Some(reform) = &cal.reform {
        let r = reform_day_to_date(d, start_year, reform);
        let year_start = reform_date_to_day(r.year, 0, 1, start_year, reform);
        return ChronicleDate {
            year: r.year,
            month_index: Some(r.month_index),
            day_of_month: Some(r.day_of_month),
            day_of_year: d - year_start,
            weekday_index,
        };
    }
    if dpy <= 0 {
        return ChronicleDate {
            year: start_year,
            month_index: None,
            day_of_month: None,
            day_of_year: 0,
            weekday_index,
        };
    }
    let year;
    let day_of_year;
    if matches!(cal.leap, Some(LeapRule::Gregorian { .. })) {
        year = gregorian_year_of(d, dpy, cal);
        day_of_year = d - year_start_day(year, cal);
    } else {
        year = start_year + d.div_euclid(dpy);
        day_of_year = d.rem_euclid(dpy);
    }
    let mut month_index = None;
    let mut day_of_month = None;
    if let Some(months) = cal.months.as_ref().filter(|m| !m.is_empty()) {
        let mut rem = day_of_year;
        for i in 0..months.len() {
            let len = month_length(year, i as i128, cal);
            if rem < len {
                month_index = Some(i as i128);
                day_of_month = Some(rem + 1);
                break;
            }
            rem -= len;
        }
        // 月の日数の合計より年内通日が大きいときの防御（保存された 1 年の日数が月の合計より
        // 大きい、うるう月の番号が範囲の外、など）。最後の月の末日にする。
        if month_index.is_none() {
            let last = months.len() as i128 - 1;
            month_index = Some(last);
            day_of_month = Some(month_length(year, last, cal));
        }
    }
    ChronicleDate {
        year,
        month_index,
        day_of_month,
        day_of_year,
        weekday_index,
    }
}

/// 作中の日付から日番号。[`day_number_to_date`] の逆。
///
/// 月・日が無い（年だけ・年と月だけ）ときは、その期間の先頭の日を返す。月の番号と日は、
/// 範囲の中へ丸める（月は 0〜月数-1、日は 1〜その月の日数）。
pub fn date_to_day_number(
    year: i128,
    month_index: Option<i128>,
    day_of_month: Option<i128>,
    cal: &ChronicleCalendar,
) -> i128 {
    if let Some(reform) = &cal.reform {
        return reform_date_to_day(
            year,
            month_index.unwrap_or(0),
            day_of_month.unwrap_or(1),
            cal.start_year(),
            reform,
        );
    }
    let base = year_start_day(year, cal);
    let mut day_of_year = 0;
    let months = cal.months.as_ref().filter(|m| !m.is_empty());
    if let (Some(months), Some(mi)) = (months, month_index) {
        let mi = mi.clamp(0, months.len() as i128 - 1);
        for i in 0..mi {
            day_of_year += month_length(year, i, cal);
        }
        let len = month_length(year, mi, cal);
        // 月の日数は 1 以上なので、`clamp` の上限が下限を下回ることはない。
        let dom = day_of_month.unwrap_or(1).min(len).max(1);
        day_of_year += dom - 1;
    } else if let Some(dom) = day_of_month {
        day_of_year = (dom - 1).max(0);
    }
    base + day_of_year
}

/// 季節の境界を、始まりの日の昇順（同じ日は元の順）に並べる。
fn sorted_season_boundaries(boundaries: &[SeasonBoundary]) -> Vec<&SeasonBoundary> {
    let mut sorted: Vec<&SeasonBoundary> = boundaries.iter().collect();
    sorted.sort_by(|a, b| a.start_day_of_year.total_cmp(&b.start_day_of_year));
    sorted
}

/// 日番号から、その日の作中の季節の名前。
///
/// 境界は始まりの日の昇順の循環した区間。最初の境界より前の通日は、最後の季節が年末から
/// 巻き込んでいるものとして、最後の境界へ巻き戻す。1 年の日数が 0 以下か、境界が無ければ `None`。
pub fn season_of(day: i128, cal: &ChronicleCalendar) -> Option<&str> {
    if calendar_days_per_year(cal) <= 0 || cal.season_boundaries.is_empty() {
        return None;
    }
    let day_of_year = day_number_to_date(day, cal).day_of_year as f64;
    let sorted = sorted_season_boundaries(&cal.season_boundaries);
    let mut current = sorted[sorted.len() - 1]; // 巻き戻しの既定（年末から年初への循環）。
    for b in sorted {
        if day_of_year >= b.start_day_of_year {
            current = b;
        } else {
            break;
        }
    }
    Some(current.name.as_str())
}

#[cfg(test)]
mod tests;
