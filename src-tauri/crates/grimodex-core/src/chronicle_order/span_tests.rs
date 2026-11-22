//! 日時の幅の試験。試験用の例 `chronicle_order_vectors.json`（画面の側と共有）の `spanCases` の
//! 全件を、期待値と照合する（CED/1 の K3）。

use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;

use super::*;
use crate::chronicle_calendar::ChronicleCalendar;

const VECTORS: &str = include_str!("chronicle_order_vectors.json");

/// 例の `calendars` の名前（暦 8 種）。
const CALENDAR_NAMES: [&str; 8] = [
    "gregorian2000",
    "leapDecember",
    "noYear",
    "plain360",
    "plain360Unsorted",
    "reform1582",
    "singleSeason360",
    "yearOnly100",
];

/// 例の `spanCases` の id（並びも固定。case を黙って減らさない・並べ替えない）。
const SPAN_CASE_IDS: [&str; 99] = [
    "time-with-minute",
    "time-minute-null",
    "time-calendar-null",
    "time-last-minute",
    "day-leftover-minute",
    "day-calendar-null",
    "day-negative",
    "month-plain-mid",
    "month-plain-first",
    "month-plain-last",
    "month-leftover-minute",
    "month-negative-day",
    "month-gregorian-leap-feb",
    "month-gregorian-common-feb",
    "month-gregorian-century-feb",
    "month-leap-december",
    "month-leap-december-year4",
    "month-no-months-fallback",
    "month-no-year-fallback",
    "month-calendar-null",
    "month-reform-cutover",
    "month-reform-cutover-julian-day",
    "month-reform-after-cutover",
    "month-reform-gregorian-common-feb",
    "month-reform-gregorian-leap-feb",
    "month-reform-julian-common-feb",
    "month-reform-julian-leap-feb",
    "month-reform-julian-century-leap-feb",
    "year-plain-mid",
    "year-negative",
    "year-leftover-minute",
    "year-gregorian-leap-400",
    "year-gregorian-common",
    "year-gregorian-leap-4",
    "year-gregorian-century-common",
    "year-leap-december",
    "year-leap-december-common",
    "year-leap-december-year4",
    "year-no-months-calendar",
    "year-single-season-calendar",
    "year-no-year-fallback",
    "year-calendar-null",
    "year-reform-cutover",
    "year-reform-after",
    "year-reform-julian-leap-century",
    "season-plain-summer",
    "season-plain-winter",
    "season-plain-spring-year1",
    "season-plain-boundary-day",
    "season-plain-negative",
    "season-unsorted-boundaries",
    "season-leftover-minute",
    "season-gregorian-spring",
    "season-gregorian-autumn-boundary",
    "season-gregorian-winter-crosses-year",
    "season-gregorian-winter-before-first-boundary",
    "season-gregorian-winter-before-first-boundary-year0",
    "season-gregorian-winter-into-leap-year",
    "season-single-boundary-after",
    "season-single-boundary-before-first",
    "season-no-boundaries-fallback",
    "season-no-year-fallback",
    "season-no-boundaries-no-months-fallback",
    "season-calendar-null",
    "season-reform-spring",
    "season-reform-winter-crosses-cutover-year",
    "season-reform-spring-after",
    "end-day-day",
    "end-day-same-day",
    "end-time",
    "end-time-minute-null",
    "end-time-start-time",
    "end-day-after-start-time",
    "end-month",
    "end-season",
    "end-year",
    "end-none",
    "end-unknown-granularity",
    "end-time-null-with-granularity",
    "end-before-start",
    "end-ends-where-start-begins",
    "end-month-ends-where-start-month-begins",
    "end-start-month",
    "end-start-season-end-month",
    "end-start-year-end-year",
    "end-calendar-null-month",
    "end-reform-month",
    "none-start-null",
    "none-granularity-none",
    "none-unknown-granularity",
    "none-end-only",
    "none-all-null",
    "none-time-granularity-start-null",
    "none-calendar-null",
    "month-gregorian-negative-leap",
    "year-gregorian-negative-leap",
    "end-inside-start-month-before-stored-day",
    "time-minute-above-range",
    "time-minute-negative",
];

#[derive(Deserialize)]
struct SpanCase {
    id: String,
    description: String,
    calendar: Option<String>,
    event: ChronicleEventSpanRow,
    expected: Option<ChronicleSpan>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vectors {
    schema_version: u32,
    purpose: String,
    calendars: BTreeMap<String, ChronicleCalendar>,
    span_cases: Vec<SpanCase>,
}

fn vectors() -> Vectors {
    serde_json::from_str(VECTORS).expect("vector file")
}

impl Vectors {
    fn calendar(&self, name: &Option<String>) -> Option<&ChronicleCalendar> {
        name.as_ref().map(|n| {
            self.calendars
                .get(n)
                .unwrap_or_else(|| panic!("unknown calendar: {n}"))
        })
    }
}

#[test]
fn fixture_shape_and_span_case_ids_are_pinned() {
    let v = vectors();
    assert_eq!(v.schema_version, 1);
    assert!(!v.purpose.is_empty());
    let calendar_names: Vec<&str> = v.calendars.keys().map(String::as_str).collect();
    assert_eq!(calendar_names, CALENDAR_NAMES);
    let ids: Vec<&str> = v.span_cases.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, SPAN_CASE_IDS);
    assert_eq!(v.span_cases.len(), 99);
}

#[test]
fn span_case_ids_are_unique_and_reference_known_calendars() {
    let v = vectors();
    let unique: BTreeSet<&str> = v.span_cases.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(unique.len(), v.span_cases.len());
    for c in &v.span_cases {
        if let Some(name) = &c.calendar {
            assert!(v.calendars.contains_key(name), "{}", c.id);
        }
        assert!(!c.description.is_empty(), "{}", c.id);
    }
}

#[test]
fn every_span_case_matches_its_expected_value() {
    let v = vectors();
    for c in &v.span_cases {
        let got = event_span(&c.event, v.calendar(&c.calendar));
        assert_eq!(got, c.expected, "{} ({})", c.id, c.description);
    }
}

fn date(time: Option<f64>, minute: Option<f64>, granularity: &str) -> ChronicleDateInput {
    ChronicleDateInput {
        start_time: time,
        start_minute: minute,
        start_granularity: granularity.to_owned(),
    }
}

#[test]
fn has_chronicle_date_needs_a_finite_day_and_a_known_granularity() {
    for g in ["time", "day", "month", "season", "year"] {
        assert!(has_chronicle_date(&date(Some(0.0), None, g)), "{g}");
    }
    for g in ["none", "", "week", "Day"] {
        assert!(!has_chronicle_date(&date(Some(0.0), None, g)), "{g}");
    }
    assert!(!has_chronicle_date(&date(None, None, "day")));
    assert!(!has_chronicle_date(&date(Some(f64::NAN), None, "day")));
    assert!(!has_chronicle_date(&date(Some(f64::INFINITY), None, "day")));
}

#[test]
fn date_span_floors_a_fractional_day_and_minute() {
    let span = chronicle_date_span(&date(Some(10.9), Some(600.7), "time"), None);
    assert_eq!(
        span,
        Some(ChronicleSpan {
            start: 10 * 1440 + 600,
            end: 10 * 1440 + 601
        })
    );
    let span = chronicle_date_span(&date(Some(-0.5), None, "day"), None);
    assert_eq!(
        span,
        Some(ChronicleSpan {
            start: -1440,
            end: 0
        })
    );
}

#[test]
fn date_span_is_none_outside_the_exactly_representable_range() {
    assert_eq!(
        chronicle_date_span(&date(Some(1e300), None, "day"), None),
        None
    );
    assert_eq!(
        chronicle_date_span(&date(Some(1.0), Some(1e300), "time"), None),
        None
    );
    assert_eq!(
        chronicle_date_span(&date(Some(-1e300), Some(-1e300), "time"), None),
        None
    );
    // 範囲の内側の端は求まる。
    let edge = 6_000_000_000_000.0;
    assert!(chronicle_date_span(&date(Some(edge), None, "day"), None).is_some());
}

fn anchor(source: ChronicleAnchorSource, time: Option<f64>, g: &str) -> ChronicleAnchorSpanInput {
    ChronicleAnchorSpanInput {
        source,
        start_time: time,
        start_minute: None,
        start_granularity: g.to_owned(),
    }
}

#[test]
fn anchor_span_is_none_for_a_missing_anchor_or_a_missing_date() {
    let v = vectors();
    let plain = v.calendars.get("plain360");
    assert_eq!(
        anchor_span(
            &anchor(ChronicleAnchorSource::None, Some(10.0), "day"),
            plain
        ),
        None
    );
    assert_eq!(
        anchor_span(&anchor(ChronicleAnchorSource::Scene, None, "day"), plain),
        None
    );
    assert_eq!(
        anchor_span(
            &anchor(ChronicleAnchorSource::Proxy, Some(10.0), "none"),
            plain
        ),
        None
    );
}

#[test]
fn anchor_span_uses_the_start_granularity_for_every_source() {
    let v = vectors();
    let plain = v.calendars.get("plain360");
    // plain360 の 100 日目は 4 月（M4、通日 90..120）の中で、季節は夏（90..180）。
    for source in [
        ChronicleAnchorSource::Scene,
        ChronicleAnchorSource::Stamped,
        ChronicleAnchorSource::Proxy,
    ] {
        assert_eq!(
            anchor_span(&anchor(source, Some(100.0), "month"), plain),
            Some(ChronicleSpan {
                start: 90 * 1440,
                end: 120 * 1440
            })
        );
        assert_eq!(
            anchor_span(&anchor(source, Some(100.0), "season"), plain),
            Some(ChronicleSpan {
                start: 90 * 1440,
                end: 180 * 1440
            })
        );
    }
}

#[test]
fn json_enum_names_are_the_fixture_strings() {
    let a: ChronicleAnchorSpanInput = serde_json::from_str(
        r#"{"source":"proxy","startTime":5,"startMinute":null,"startGranularity":"day"}"#,
    )
    .expect("anchor");
    assert_eq!(a.source, ChronicleAnchorSource::Proxy);
    assert_eq!(a.start_time, Some(5.0));
    assert_eq!(a.start_minute, None);
}

/// 例の JSON の期待値の欄を、生の JSON で数える（`Option` の欄は、欄が消えても `None` になって
/// 黙って通るので、欄の有無そのものを固定する）。
#[test]
fn span_case_fields_are_pinned_in_the_raw_json() {
    let raw: serde_json::Value = serde_json::from_str(VECTORS).expect("vector file");
    let cases = raw["spanCases"].as_array().expect("spanCases is an array");
    assert_eq!(cases.len(), 99);
    let mut with_span = 0;
    for c in cases {
        let id = c["id"].as_str().expect("id");
        let object = c.as_object().expect("case object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["calendar", "description", "event", "expected", "id"],
            "{id}"
        );
        let expected = &c["expected"];
        if expected.is_null() {
            continue;
        }
        with_span += 1;
        let mut span_keys: Vec<&str> = expected
            .as_object()
            .unwrap_or_else(|| panic!("{id}: expected is null or an object"))
            .keys()
            .map(String::as_str)
            .collect();
        span_keys.sort_unstable();
        assert_eq!(span_keys, ["end", "start"], "{id}");
    }
    // 幅の無い（日時が無い）期待値は 7 件。
    assert_eq!(with_span, 92);
}

/// 暦の JSON から、`event_span` を求める（極端な値で panic しないことの確認に使う）。
fn span_of_calendar_json(
    calendar: &serde_json::Value,
    start_time: f64,
    granularity: &str,
) -> Option<ChronicleSpan> {
    let calendar: ChronicleCalendar =
        serde_json::from_value(calendar.clone()).expect("calendar json");
    let row = ChronicleEventSpanRow {
        start_time: Some(start_time),
        start_minute: None,
        start_granularity: granularity.to_owned(),
        end_time: None,
        end_minute: None,
        end_granularity: "none".to_owned(),
    };
    event_span(&row, Some(&calendar))
}

/// 季節の始まりが極端に大きい暦（約 ±1.7e38 を超えると `as i128` が飽和する）で、
/// panic せず、画面の側と同じに、保存された日の 1 日にもどる。
#[test]
fn extreme_season_starts_fall_back_to_the_stored_day() {
    for extreme in [1e300, -1e300, 1e39, -1e39, 1e38, -1e38, 1e30, 1e18] {
        let calendar = serde_json::json!({
            "daysPerYear": 360,
            "seasonBoundaries": [{ "name": "x", "startDayOfYear": extreme }],
        });
        for day in [-1619.0, 0.0, 69.0, 4_000_000_000_000.0] {
            assert_eq!(
                span_of_calendar_json(&calendar, day, "season"),
                Some(ChronicleSpan {
                    start: day as i128 * 1440,
                    end: (day as i128 + 1) * 1440
                }),
                "start {extreme}, day {day}"
            );
        }
    }
    // 2 つの境界の片方だけが極端でも、panic しない（`Some` か `None` のどちらか）。
    let calendar = serde_json::json!({
        "daysPerYear": 360,
        "seasonBoundaries": [
            { "name": "a", "startDayOfYear": 0 },
            { "name": "b", "startDayOfYear": 1e300 },
        ],
    });
    for day in [-1619.0, 0.0, 69.0, 4_000_000_000_000.0] {
        assert!(span_of_calendar_json(&calendar, day, "season").is_some());
    }
}

/// 暦の側の極端な値（月の日数・1 年の日数・開始年・改暦の年）でも、`event_span` は
/// panic せず、`Some` か `None` を返す。
#[test]
fn extreme_calendar_values_never_panic() {
    let i64_max = i64::MAX;
    let i64_min = i64::MIN;
    let calendars = [
        serde_json::json!({"daysPerYear": i64_max, "seasonBoundaries": []}),
        serde_json::json!({"daysPerYear": i64_min, "seasonBoundaries": []}),
        serde_json::json!({"daysPerYear": 360, "seasonBoundaries": [], "startYear": i64_max}),
        serde_json::json!({"daysPerYear": 360, "seasonBoundaries": [], "startYear": i64_min}),
        serde_json::json!({
            "daysPerYear": 360, "seasonBoundaries": [{"name": "s", "startDayOfYear": 10}],
            "months": [{"name": "m", "days": 1e300}, {"name": "n", "days": 1e300}],
        }),
        serde_json::json!({
            "daysPerYear": 360, "seasonBoundaries": [{"name": "s", "startDayOfYear": 10}],
            "months": [{"name": "m", "days": -1e300}],
        }),
        serde_json::json!({
            "daysPerYear": i64_max, "seasonBoundaries": [{"name": "s", "startDayOfYear": 1e300}],
            "startYear": i64_max, "leap": {"kind": "gregorian", "monthIndex": 0},
            "months": [{"name": "m", "days": i64_max}, {"name": "n", "days": i64_max}],
        }),
        serde_json::json!({
            "daysPerYear": 360, "seasonBoundaries": [{"name": "s", "startDayOfYear": 10}],
            "startYear": i64_min, "leap": {"kind": "gregorian", "monthIndex": 1e300},
        }),
        serde_json::json!({
            "daysPerYear": 365, "seasonBoundaries": [{"name": "s", "startDayOfYear": 10}],
            "months": [{"name": "m", "days": 31}],
            "reform": {"gregorianStart": {"year": 1_000_000_000_000_000_i64, "monthIndex": 0, "dayOfMonth": 1}},
        }),
        serde_json::json!({
            "daysPerYear": 365, "seasonBoundaries": [{"name": "s", "startDayOfYear": 10}],
            "startYear": i64_max,
            "reform": {"gregorianStart": {"year": i64_min, "monthIndex": 99, "dayOfMonth": -5}},
        }),
    ];
    for calendar in &calendars {
        for day in [
            -4_000_000_000_000.0,
            -1.0,
            0.0,
            69.0,
            4_000_000_000_000.0,
            6_000_000_000_000.0,
        ] {
            for granularity in ["time", "day", "month", "season", "year"] {
                // 値は問わない（`Some` か `None`）。panic しないことだけを見る。
                let _ = span_of_calendar_json(calendar, day, granularity);
            }
        }
    }
}
