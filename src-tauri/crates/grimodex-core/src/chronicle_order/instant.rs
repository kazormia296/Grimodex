//! 時点の文字列の読み方（画面の側 `electron/shared/readDomain/lib/time.ts` の
//! `instantEpochMilliseconds` の写し。DR-CED-12）。
//!
//! 画面の側は、次の 2 段で読む。この関数は、同じ形だけを読み、同じ値を返す。
//!
//! 1. `normalizeInstantString`：前後の空白を除き、SQLite の `datetime('now')` が返す
//!    「年-月-日 時:分:秒（小数 1〜9 桁は任意）」だけを、UTC の `年-月-日T時:分:秒Z` に直す。
//! 2. `Temporal.Instant.from`（`temporal-polyfill` 1.0.1）：ISO 8601／RFC 3339 の時点
//!    （オフセットか `Z` が必須。年は 4 桁か符号つき 6 桁。区切りは `T`・`t`・空白。
//!    日付・時刻・オフセットは、基本形〔区切りなし〕でも拡張形〔`-`・`:`〕でも読めるが、
//!    日付の 2 つの区切りは同じ、時刻の 2 つの区切りは同じでなければならない。
//!    秒の小数は 1〜9 桁で `.` か `,`。秒の 60 は 59 にする。角かっこの注釈は 9 個まで）。
//!    オフセットの無い「年-月-日T時:分:秒」は読めない。
//!
//! 返す値は、UTC の 1970-01-01 からのミリ秒（ミリ秒より細かい桁は切り捨てる。負の時刻は床）。
//! 読めない値は `None`。画面の側が読めない形を、ここで読まない。
//! 試験用に、実物（`temporal-polyfill`）の出力と突き合わせて確かめてある。

use std::cmp::Ordering;

use crate::chronicle_calendar::is_gregorian_leap;

const NANOS_PER_SECOND: i128 = 1_000_000_000;
const NANOS_PER_MINUTE: i128 = 60 * NANOS_PER_SECOND;
const NANOS_PER_HOUR: i128 = 60 * NANOS_PER_MINUTE;
const NANOS_PER_DAY: i128 = 24 * NANOS_PER_HOUR;
const NANOS_PER_MILLI: i128 = 1_000_000;
/// 表せる時点の限り（±8.64e15 ミリ秒。画面の側の `Temporal.Instant` と同じ）。
const EPOCH_NANO_LIMIT: i128 = 8_640_000_000_000_000 * NANOS_PER_MILLI;

/// 作った日時を、時刻として比べる（DR-CED-12）。ミリ秒まで。
///
/// 読める値どうしは、時刻の順。読めない値は、読める値の後ろ。
/// 両方とも読めないときは、同じとして扱い、次の鍵（id）に渡す。
/// 文字列としては比べない（実行環境の並びの規則に、結果を左右させない）。
pub fn compare_created_at(a: &str, b: &str) -> Ordering {
    compare_epoch_milliseconds(instant_epoch_milliseconds(a), instant_epoch_milliseconds(b))
}

/// 読み終えた時刻（ミリ秒）どうしの比較。読めない（`None`）は、読めるものの後ろ。
pub fn compare_epoch_milliseconds(left: Option<i64>, right: Option<i64>) -> Ordering {
    match (left, right) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(l), Some(r)) => l.cmp(&r),
    }
}

/// 時点の文字列を、UTC のエポックからのミリ秒にする。読めなければ `None`。
pub fn instant_epoch_milliseconds(input: &str) -> Option<i64> {
    let normalized = normalize_instant_string(input);
    if normalized.is_empty() {
        return None;
    }
    let nanos = parse_instant_nanos(&normalized)?;
    i64::try_from(nanos.div_euclid(NANOS_PER_MILLI)).ok()
}

/// JavaScript の `String.prototype.trim` が除く文字（空白と行の終わり）。
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `normalizeInstantString`：前後の空白を除き、SQLite の UTC 時刻だけを `T…Z` の形に直す。
fn normalize_instant_string(value: &str) -> String {
    let trimmed = value.trim_matches(is_js_whitespace);
    let chars: Vec<char> = trimmed.chars().collect();
    if is_sqlite_utc_timestamp(&chars) {
        let date: String = chars[..10].iter().collect();
        let time: String = chars[11..].iter().collect();
        return format!("{date}T{time}Z");
    }
    trimmed.to_owned()
}

/// `^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$`
fn is_sqlite_utc_timestamp(c: &[char]) -> bool {
    let digit = |i: usize| c.get(i).is_some_and(char::is_ascii_digit);
    let is = |i: usize, ch: char| c.get(i) == Some(&ch);
    let fixed = (0..4).all(digit)
        && is(4, '-')
        && digit(5)
        && digit(6)
        && is(7, '-')
        && digit(8)
        && digit(9)
        && is(10, ' ')
        && digit(11)
        && digit(12)
        && is(13, ':')
        && digit(14)
        && digit(15)
        && is(16, ':')
        && digit(17)
        && digit(18);
    if !fixed {
        return false;
    }
    if c.len() == 19 {
        return true;
    }
    // 小数部：'.' と 1〜9 桁の数字で終わる。
    is(19, '.') && (2..=10).contains(&(c.len() - 19)) && (20..c.len()).all(digit)
}

/// 文字列の読み位置（`Copy` なので、巻き戻しは値の入れ替えでできる）。
#[derive(Clone, Copy)]
struct Cursor<'a> {
    chars: &'a [char],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn at_end(&self) -> bool {
        self.pos >= self.chars.len()
    }

    /// 次が `ch` なら読み進める。
    fn eat(&mut self, ch: char) -> bool {
        if self.peek() == Some(ch) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    /// ちょうど `n` 桁の ASCII 数字を読む。
    fn digits(&mut self, n: usize) -> Option<i128> {
        let slice = self.chars.get(self.pos..self.pos + n)?;
        if !slice.iter().all(char::is_ascii_digit) {
            return None;
        }
        self.pos += n;
        Some(
            slice
                .iter()
                .fold(0i128, |acc, d| acc * 10 + i128::from(*d as u8 - b'0')),
        )
    }

    /// `[.,]\d{1,9}`（読めたら、9 桁に右を 0 で埋めたナノ秒の値）。
    fn fraction(&mut self) -> Option<i128> {
        let mut probe = *self;
        if !(probe.eat('.') || probe.eat(',')) {
            return None;
        }
        let mut value = 0i128;
        let mut count = 0usize;
        while count < 9 {
            match probe.peek() {
                Some(d) if d.is_ascii_digit() => {
                    value = value * 10 + i128::from(d as u8 - b'0');
                    probe.pos += 1;
                    count += 1;
                }
                _ => break,
            }
        }
        if count == 0 {
            return None;
        }
        for _ in count..9 {
            value *= 10;
        }
        *self = probe;
        Some(value)
    }
}

/// 時・分・秒（と小数）。無い欄は 0。
#[derive(Default)]
struct TimeParts {
    hour: i128,
    minute: i128,
    second: i128,
    nano: i128,
}

/// `(\d{2})(?:(:?)(\d{2})(?:\sep(\d{2})(?:[.,](\d{1,9}))?)?)?`（sep は分の前の区切りと同じ）。
fn parse_time(cur: &mut Cursor<'_>) -> Option<TimeParts> {
    let mut parts = TimeParts {
        hour: cur.digits(2)?,
        ..TimeParts::default()
    };
    let mut probe = *cur;
    let colon = probe.eat(':');
    if let Some(minute) = probe.digits(2) {
        parts.minute = minute;
        let mut with_second = probe;
        if !colon || with_second.eat(':') {
            if let Some(second) = with_second.digits(2) {
                parts.second = second;
                probe = with_second;
                if let Some(nano) = probe.fraction() {
                    parts.nano = nano;
                }
            }
        }
        *cur = probe;
    }
    Some(parts)
}

/// オフセット 1 つぶん（符号つきナノ秒）。小数は秒のもの。
fn parse_offset(cur: &mut Cursor<'_>) -> Option<i128> {
    let negative = match cur.peek()? {
        '+' => false,
        '-' => true,
        _ => return None,
    };
    cur.pos += 1;
    let hour = cur.digits(2)?;
    let mut minute = 0;
    let mut second = 0;
    let mut nano = 0;
    let mut probe = *cur;
    let colon = probe.eat(':');
    if let Some(m) = probe.digits(2) {
        minute = m;
        let mut with_second = probe;
        if !colon || with_second.eat(':') {
            if let Some(s) = with_second.digits(2) {
                second = s;
                probe = with_second;
                if let Some(n) = probe.fraction() {
                    nano = n;
                }
            }
        }
        *cur = probe;
    }
    let magnitude =
        hour * NANOS_PER_HOUR + minute * NANOS_PER_MINUTE + second * NANOS_PER_SECOND + nano;
    Some(if negative { -magnitude } else { magnitude })
}

/// 角かっこの注釈（`[!?…]`）を 9 個まで読む。読み終えた後に文字が残れば `None`。
/// 返すのは、(critical かどうか, 中身) の並び。
fn parse_annotations(cur: &mut Cursor<'_>) -> Option<Vec<(bool, String)>> {
    let mut out = Vec::new();
    while out.len() < 9 && cur.peek() == Some('[') {
        let close = cur.chars[cur.pos + 1..].iter().position(|&c| c == ']')?;
        let inner = &cur.chars[cur.pos + 1..cur.pos + 1 + close];
        let (critical, body) = match inner.first() {
            Some('!') => (true, &inner[1..]),
            _ => (false, inner),
        };
        out.push((critical, body.iter().collect()));
        cur.pos += close + 2;
    }
    if cur.at_end() {
        Some(out)
    } else {
        None
    }
}

/// 注釈の意味の検査（`organizeAnnotationParts`）。時間帯の注釈の中身を返す。拒まれたら `None`。
fn organize_annotations(annotations: &[(bool, String)]) -> Option<Option<String>> {
    let mut calendar_ids = 0usize;
    let mut calendar_critical = false;
    let mut time_zone: Option<String> = None;
    for (critical, body) in annotations {
        let pieces: Vec<&str> = body.split('=').collect();
        let value = pieces[pieces.len() - 1];
        let name = if pieces.len() >= 2 {
            pieces[pieces.len() - 2]
        } else {
            ""
        };
        if !name.is_empty() {
            if name == "u-ca" {
                calendar_ids += 1;
                calendar_critical = calendar_critical || *critical;
            } else if *critical || name.chars().any(|c| c.is_ascii_uppercase()) {
                return None;
            }
        } else {
            if time_zone.as_deref().is_some_and(|z| !z.is_empty()) {
                return None;
            }
            time_zone = Some(value.to_owned());
        }
    }
    if calendar_ids > 1 && calendar_critical {
        return None;
    }
    Some(time_zone)
}

/// 時間帯の注釈がオフセットの形（`+09:00` など）のときの検査（`parseOffsetNanoMaybe(id, true)`）。
/// 時・分だけを許し、1 日以上は拒む。オフセットの形でなければ、検査しない（通す）。
fn time_zone_annotation_is_acceptable(id: &str) -> bool {
    let chars: Vec<char> = id.chars().collect();
    let mut cur = Cursor {
        chars: &chars,
        pos: 0,
    };
    let negative_or_positive = matches!(cur.peek(), Some('+') | Some('-'));
    if !negative_or_positive {
        return true;
    }
    cur.pos += 1;
    // ([+-])(\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,9}))?)?)?  （全体）
    let Some(hour) = cur.digits(2) else {
        return true;
    };
    let mut minute = None;
    let mut second = None;
    let mut fraction = false;
    let mut probe = cur;
    probe.eat(':');
    if let Some(m) = probe.digits(2) {
        minute = Some(m);
        let mut with_second = probe;
        with_second.eat(':');
        if let Some(s) = with_second.digits(2) {
            second = Some(s);
            probe = with_second;
            if probe.fraction().is_some() {
                fraction = true;
            }
        }
        cur = probe;
    }
    if !cur.at_end() {
        return true;
    }
    // 形の検査：区切りの入れ方がそろっているか。
    let body: String = chars[1..].iter().collect();
    let main = match body.find(['.', ',']) {
        Some(i) => &body[..i],
        None => body.as_str(),
    };
    let pieces: Vec<&str> = main.split(':').collect();
    let well_formed = if pieces.len() == 1 {
        matches!(main.len(), 2 | 4 | 6)
    } else {
        (pieces.len() == 2 || pieces.len() == 3) && pieces.iter().all(|p| p.len() == 2)
    };
    if !well_formed {
        return true;
    }
    if second.is_some() || fraction {
        return false;
    }
    hour * 3600 + minute.unwrap_or(0) * 60 < 86_400
}

fn gregorian_month_days(year: i128, month: i128) -> i128 {
    match month {
        2 if is_gregorian_leap(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// 先発グレゴリオ暦の日付から、1970-01-01 を 0 とする日数。
fn days_from_civil(year: i128, month: i128, day: i128) -> i128 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `Temporal.Instant.from` に相当する読み。UTC のエポックからのナノ秒を返す。
fn parse_instant_nanos(s: &str) -> Option<i128> {
    let chars: Vec<char> = s.chars().collect();
    let mut cur = Cursor {
        chars: &chars,
        pos: 0,
    };

    // 年：符号つき 6 桁か、4 桁。
    let year = match cur.peek()? {
        sign @ ('+' | '-') => {
            cur.pos += 1;
            let magnitude = cur.digits(6)?;
            if sign == '-' {
                if magnitude == 0 {
                    return None;
                }
                -magnitude
            } else {
                magnitude
            }
        }
        _ => cur.digits(4)?,
    };
    // 月と日：区切りの `-` は 2 か所そろって有るか、無い。
    let dashed = cur.eat('-');
    let month = cur.digits(2)?;
    if dashed && !cur.eat('-') {
        return None;
    }
    let day = cur.digits(2)?;

    // 時刻（必須。無ければオフセットも無いので読めない）。
    if !(cur.eat('T') || cur.eat('t') || cur.eat(' ')) {
        return None;
    }
    let time = parse_time(&mut cur)?;
    // `Z` か、オフセット（必須）。
    let offset_nanos = if cur.eat('Z') || cur.eat('z') {
        0
    } else {
        let offset = parse_offset(&mut cur)?;
        if offset.abs() >= NANOS_PER_DAY {
            return None;
        }
        offset
    };

    let annotations = parse_annotations(&mut cur)?;
    let time_zone = organize_annotations(&annotations)?;
    if let Some(id) = &time_zone {
        if !time_zone_annotation_is_acceptable(id) {
            return None;
        }
    }

    // 値の検査（秒の 60 は 59 にする）。
    let second = if time.second == 60 { 59 } else { time.second };
    if !(1..=12).contains(&month)
        || day < 1
        || day > gregorian_month_days(year, month)
        || time.hour > 23
        || time.minute > 59
        || second > 59
    {
        return None;
    }
    let local_nanos = days_from_civil(year, month, day) * NANOS_PER_DAY
        + time.hour * NANOS_PER_HOUR
        + time.minute * NANOS_PER_MINUTE
        + second * NANOS_PER_SECOND
        + time.nano;
    let epoch = local_nanos - offset_nanos;
    if !(-EPOCH_NANO_LIMIT..=EPOCH_NANO_LIMIT).contains(&epoch) {
        return None;
    }
    Some(epoch)
}
