//! 並び・判定・現在地・仮の日時・時点の読み方の試験。試験用の例 `chronicle_order_vectors.json`
//! （画面の側と共有）の `orderCases`・`relationCases`・`anchorCases`・`provisionalCases` の
//! 全件を、期待値と照合する（CED/1 の K3）。case の id の一覧と件数は固定する。

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;

use super::*;
use crate::chronicle_calendar::ChronicleCalendar;

const VECTORS: &str = include_str!("chronicle_order_vectors.json");

/// 例の `orderCases` の id（並びも固定する）。
const ORDER_CASE_IDS: [&str; 14] = [
    "order-tie-ordinal-then-id",
    "order-date-before-ordinal",
    "order-month-uses-span-start",
    "order-season-and-year-use-span-start",
    "order-calendar-null-no-span-start",
    "order-undated-last",
    "order-ordinal-forms",
    "order-time-vs-day",
    "order-end-ignored",
    "order-reform-month",
    "order-gregorian-year",
    "order-negative-days",
    "order-all-undated",
    "order-empty",
];

/// 例の `relationCases` の id（並びも固定する）。
const RELATION_CASE_IDS: [&str; 54] = [
    "rel-all-before",
    "rel-all-after",
    "rel-same-day-concurrent",
    "rel-adjacent-day-before",
    "rel-adjacent-day-after",
    "rel-month-event-contains-anchor",
    "rel-interval-overlap",
    "rel-interval-ends-before-anchor",
    "rel-interval-starts-after-anchor",
    "rel-time-event-day-anchor-concurrent",
    "rel-time-event-day-anchor-before",
    "rel-time-event-day-anchor-after",
    "rel-day-event-time-anchor-concurrent",
    "rel-time-vs-time-before",
    "rel-time-vs-time-same",
    "rel-time-vs-time-after",
    "rel-day-event-time-anchor-prev-day",
    "rel-month-anchor-event-before-stored-day",
    "rel-month-anchor-event-end-of-month",
    "rel-month-anchor-next-month",
    "rel-month-anchor-prev-month",
    "rel-season-anchor-inside",
    "rel-season-anchor-next",
    "rel-year-anchor-prev",
    "rel-year-anchor-first",
    "rel-year-anchor-last",
    "rel-year-anchor-next",
    "rel-stamped-anchor-concurrent",
    "rel-stamped-month-anchor-whole-month",
    "rel-proxy-same-day-before",
    "rel-proxy-month-overlap-before",
    "rel-proxy-anchor-month-overlap-before",
    "rel-proxy-after",
    "rel-proxy-before",
    "rel-proxy-interval-overlap-before",
    "rel-anchor-none-unknown",
    "rel-anchor-none-with-fields-unknown",
    "rel-event-undated-unknown",
    "rel-event-granularity-none-unknown",
    "rel-event-undated-proxy-unknown",
    "rel-anchor-granularity-none-unknown",
    "rel-anchor-time-null-unknown",
    "rel-month-event-calendar-null-before",
    "rel-month-event-calendar-null-concurrent",
    "rel-gregorian-leap-day-month",
    "rel-gregorian-leap-day-next-month",
    "rel-gregorian-leap-day-next-day",
    "rel-reform-consecutive-days",
    "rel-reform-cutover-month-concurrent",
    "rel-reform-year-concurrent",
    "rel-reform-next-month-after",
    "rel-season-event-vs-day-anchor",
    "rel-winter-crossing-year",
    "rel-anchor-unknown-granularity-string-unknown",
];

/// 例の `anchorCases` の id（並びも固定する）。
const ANCHOR_CASE_IDS: [&str; 39] = [
    "anchor-scene-date-beats-stamped",
    "anchor-scene-date-time-approx",
    "anchor-scene-date-unknown-precision",
    "anchor-scene-granularity-none-not-a-date",
    "anchor-scene-granularity-unknown-string-not-a-date",
    "anchor-scene-start-null-not-a-date",
    "anchor-stamped-single",
    "anchor-stamped-latest-by-date-all-a0",
    "anchor-stamped-date-beats-ordinal",
    "anchor-stamped-same-date-ordinal-breaks-tie",
    "anchor-stamped-same-date-same-ordinal-id-breaks-tie",
    "anchor-stamped-month-event-sorts-by-span-start",
    "anchor-stamped-time-event-beats-day-with-leftover-minute",
    "anchor-stamped-time-later-minute",
    "anchor-stamped-end-time-ignored",
    "anchor-approx-is-material",
    "anchor-unknown-excluded-when-exact-exists",
    "anchor-unknown-only-scene-borrows",
    "anchor-undated-event-is-not-material",
    "anchor-undated-event-not-material-even-under-c3a",
    "anchor-proxy-skips-scene-with-only-non-material",
    "anchor-proxy-from-scene-date",
    "anchor-proxy-scene-date-nearer-than-event-scene",
    "anchor-proxy-scene-date-beats-its-own-events",
    "anchor-proxy-nearest-by-reading-order-not-by-date",
    "anchor-proxy-uses-reading-order-not-input-order",
    "anchor-no-borrow-from-later-scene",
    "anchor-current-scene-not-in-reading-order",
    "anchor-current-scene-not-in-reading-order-own-event",
    "anchor-orphan-link-ignored",
    "anchor-orphan-link-only-is-none",
    "anchor-empty",
    "anchor-c3a-all-unknown-stamped",
    "anchor-c3a-all-unknown-proxy",
    "anchor-c3a-undated-event-counts-as-unknown",
    "anchor-c3a-off-when-dated-live-scene",
    "anchor-c3a-off-when-one-event-not-unknown",
    "anchor-c3a-off-when-one-event-approx",
    "anchor-calendar-null",
];

/// 例の `provisionalCases` の id（並びも固定する）。
const PROVISIONAL_CASE_IDS: [&str; 29] = [
    "prov-after-latest-start",
    "prov-end-day-counts",
    "prov-end-granularity-none-ignored",
    "prov-end-before-start",
    "prov-scene-date-later",
    "prov-scene-date-earlier",
    "prov-scene-granularity-none-ignored",
    "prov-scene-only",
    "prov-no-dates-at-all",
    "prov-nothing-to-place",
    "prov-no-events",
    "prov-order-ordinal-then-created-then-id",
    "prov-all-ordinal-a0-created-order",
    "prov-created-at-mixed-formats",
    "prov-created-at-same-instant-id-breaks-tie",
    "prov-created-at-fractional-seconds",
    "prov-granularity-none-with-day-is-not-a-target",
    "prov-month-event-uses-stored-day",
    "prov-end-only-event-is-a-target",
    "prov-negative-days",
    "prov-start-granularity-unknown-string-day-counts",
    "prov-end-granularity-unknown-string-ignored",
    "prov-scene-granularity-unknown-string-ignored",
    "prov-season-event-uses-stored-day",
    "prov-year-event-uses-stored-day",
    "prov-end-month-event-uses-stored-end-day",
    "prov-created-at-unreadable-sorts-last",
    "prov-created-at-identical-unreadable-id-breaks-tie",
    "prov-created-at-both-unreadable-different-id-breaks-tie",
];

#[derive(Deserialize)]
struct OrderCase {
    id: String,
    description: String,
    calendar: Option<String>,
    events: Vec<ChronicleOrderRow>,
    #[serde(rename = "expectedOrder")]
    expected_order: Vec<String>,
}

#[derive(Deserialize)]
struct RelationCase {
    id: String,
    description: String,
    calendar: Option<String>,
    event: ChronicleEventSpanRow,
    anchor: ChronicleAnchorSpanInput,
    expected: ChronicleRelation,
}

/// 現在地の期待値（出来事の id つき）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedAnchor {
    source: ChronicleAnchorSource,
    start_time: Option<f64>,
    start_minute: Option<f64>,
    start_granularity: String,
    precision: Option<ChroniclePrecision>,
    proxy_scene_id: Option<String>,
    event_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnchorCase {
    id: String,
    description: String,
    calendar: Option<String>,
    current_scene_id: String,
    events: Vec<ChronicleAnchorEventRow>,
    scene_events: Vec<SceneEventLink>,
    reading_order: Vec<String>,
    scene_chronicle: BTreeMap<String, SceneChronicleDate>,
    has_dated_live_scene: bool,
    expected: ExpectedAnchor,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProvisionalCase {
    id: String,
    description: String,
    events: Vec<ChronicleProvisionalEventRow>,
    live_scene_dates: Vec<ChronicleProvisionalSceneDate>,
    expected: Vec<ChronicleProvisionalDate>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vectors {
    calendars: BTreeMap<String, ChronicleCalendar>,
    order_cases: Vec<OrderCase>,
    relation_cases: Vec<RelationCase>,
    anchor_cases: Vec<AnchorCase>,
    provisional_cases: Vec<ProvisionalCase>,
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
fn case_ids_and_counts_are_pinned() {
    let v = vectors();
    let ids = |list: Vec<&str>| list.into_iter().map(str::to_owned).collect::<Vec<_>>();
    assert_eq!(
        v.order_cases
            .iter()
            .map(|c| c.id.as_str())
            .collect::<Vec<_>>(),
        ids(ORDER_CASE_IDS.to_vec())
    );
    assert_eq!(
        v.relation_cases
            .iter()
            .map(|c| c.id.as_str())
            .collect::<Vec<_>>(),
        ids(RELATION_CASE_IDS.to_vec())
    );
    assert_eq!(
        v.anchor_cases
            .iter()
            .map(|c| c.id.as_str())
            .collect::<Vec<_>>(),
        ids(ANCHOR_CASE_IDS.to_vec())
    );
    assert_eq!(
        v.provisional_cases
            .iter()
            .map(|c| c.id.as_str())
            .collect::<Vec<_>>(),
        ids(PROVISIONAL_CASE_IDS.to_vec())
    );
    assert_eq!(v.order_cases.len(), 14);
    assert_eq!(v.relation_cases.len(), 54);
    assert_eq!(v.anchor_cases.len(), 39);
    assert_eq!(v.provisional_cases.len(), 29);
}

#[test]
fn case_ids_are_unique_and_reference_known_calendars() {
    let v = vectors();
    let unique = |ids: Vec<&str>| ids.iter().collect::<BTreeSet<_>>().len() == ids.len();
    assert!(unique(
        v.order_cases.iter().map(|c| c.id.as_str()).collect()
    ));
    assert!(unique(
        v.relation_cases.iter().map(|c| c.id.as_str()).collect()
    ));
    assert!(unique(
        v.anchor_cases.iter().map(|c| c.id.as_str()).collect()
    ));
    assert!(unique(
        v.provisional_cases.iter().map(|c| c.id.as_str()).collect()
    ));
    for c in &v.order_cases {
        assert!(!c.description.is_empty(), "{}", c.id);
        v.calendar(&c.calendar);
    }
    for c in &v.relation_cases {
        assert!(!c.description.is_empty(), "{}", c.id);
        v.calendar(&c.calendar);
    }
    for c in &v.anchor_cases {
        assert!(!c.description.is_empty(), "{}", c.id);
        v.calendar(&c.calendar);
    }
    for c in &v.provisional_cases {
        assert!(!c.description.is_empty(), "{}", c.id);
    }
}

/// anchorCases の入力の形を、JSON の実物で確かめる（readingOrder は配列で、添字が番号。
/// sceneChronicle は sceneId をキーにした object。hasDatedLiveScene は boolean）。
#[test]
fn anchor_case_input_shape_matches_the_documented_one() {
    let raw: serde_json::Value = serde_json::from_str(VECTORS).expect("vector file");
    let cases = raw["anchorCases"]
        .as_array()
        .expect("anchorCases is an array");
    assert_eq!(cases.len(), 39);
    for c in cases {
        let id = c["id"].as_str().expect("id");
        assert!(c["readingOrder"].is_array(), "{id}");
        assert!(
            c["readingOrder"]
                .as_array()
                .expect("array")
                .iter()
                .all(serde_json::Value::is_string),
            "{id}"
        );
        assert!(c["sceneChronicle"].is_object(), "{id}");
        assert!(c["hasDatedLiveScene"].is_boolean(), "{id}");
        assert!(c["sceneEvents"].is_array(), "{id}");
        assert!(c["events"].is_array(), "{id}");
        assert!(c["currentSceneId"].is_string(), "{id}");
        assert!(c["expected"].is_object(), "{id}");
    }
    let provisional = raw["provisionalCases"].as_array().expect("array");
    assert_eq!(provisional.len(), 29);
    for c in provisional {
        let id = c["id"].as_str().expect("id");
        assert!(c["events"].is_array(), "{id}");
        assert!(c["liveSceneDates"].is_array(), "{id}");
        assert!(c["expected"].is_array(), "{id}");
    }
}

/// 期待値の欄の集合を、生の JSON で固定する。期待値の struct の `Option` の欄は、欄が消える
/// （または欄名を書き間違える）と `None` になって、黙って通ってしまうため。
#[test]
fn expected_field_sets_are_pinned_in_the_raw_json() {
    let raw: serde_json::Value = serde_json::from_str(VECTORS).expect("vector file");
    let keys_of = |value: &serde_json::Value| -> Vec<String> {
        let mut keys: Vec<String> = value.as_object().expect("object").keys().cloned().collect();
        keys.sort_unstable();
        keys
    };
    let anchor_expected = [
        "eventId",
        "precision",
        "proxySceneId",
        "source",
        "startGranularity",
        "startMinute",
        "startTime",
    ];
    for c in raw["anchorCases"].as_array().expect("anchorCases") {
        let id = c["id"].as_str().expect("id");
        assert_eq!(keys_of(&c["expected"]), anchor_expected, "{id}");
    }
    for c in raw["provisionalCases"]
        .as_array()
        .expect("provisionalCases")
    {
        let id = c["id"].as_str().expect("id");
        for e in c["expected"].as_array().expect("expected array") {
            assert_eq!(keys_of(e), ["id", "startTime"], "{id}");
        }
    }
    for c in raw["relationCases"].as_array().expect("relationCases") {
        let id = c["id"].as_str().expect("id");
        assert!(c["expected"].is_string(), "{id}");
        assert_eq!(
            keys_of(c),
            [
                "anchor",
                "calendar",
                "description",
                "event",
                "expected",
                "id"
            ],
            "{id}"
        );
    }
    for c in raw["orderCases"].as_array().expect("orderCases") {
        let id = c["id"].as_str().expect("id");
        assert!(c["expectedOrder"].is_array(), "{id}");
        assert_eq!(
            keys_of(c),
            ["calendar", "description", "events", "expectedOrder", "id"],
            "{id}"
        );
    }
}

fn ids_of(events: &[ChronicleOrderRow]) -> Vec<String> {
    events.iter().map(|e| e.id.clone()).collect()
}

#[test]
fn every_order_case_matches_its_expected_order() {
    let v = vectors();
    for c in &v.order_cases {
        let cal = v.calendar(&c.calendar);
        let sorted = sort_chronicle_events(c.events.clone(), cal);
        assert_eq!(
            ids_of(&sorted),
            c.expected_order,
            "{} ({})",
            c.id,
            c.description
        );
        // 比較関数は全順序なので、入力の並びに依らない。
        let mut reversed = c.events.clone();
        reversed.reverse();
        assert_eq!(
            ids_of(&sort_chronicle_events(reversed, cal)),
            c.expected_order,
            "{} reversed",
            c.id
        );
        let mut rotated = c.events.clone();
        if !rotated.is_empty() {
            rotated.rotate_left(1);
        }
        assert_eq!(
            ids_of(&sort_chronicle_events(rotated, cal)),
            c.expected_order,
            "{} rotated",
            c.id
        );
        // 比較関数を直接 sort に渡しても同じ。
        let mut direct = c.events.clone();
        direct.sort_by(|a, b| compare_chronicle_events(a, b, cal));
        assert_eq!(ids_of(&direct), c.expected_order, "{} direct", c.id);
    }
}

#[test]
fn every_relation_case_matches_its_expected_relation() {
    let v = vectors();
    for c in &v.relation_cases {
        let got = classify_event_relation(&c.event, &c.anchor, v.calendar(&c.calendar));
        assert_eq!(got, c.expected, "{} ({})", c.id, c.description);
    }
}

fn run_anchor(
    c: &AnchorCase,
    v: &Vectors,
    has_dated_live_scene: Option<bool>,
) -> ChronicleAnchorResolution {
    let reading_order = reading_order_from_list(&c.reading_order);
    let ctx = ChronicleAnchorContext {
        scene_events: &c.scene_events,
        events: &c.events,
        reading_order: &reading_order,
        scene_chronicle: Some(&c.scene_chronicle),
        calendar: v.calendar(&c.calendar),
        has_dated_live_scene,
    };
    resolve_chronicle_anchor_by_date(&c.current_scene_id, &ctx)
}

#[test]
fn every_anchor_case_matches_its_expected_anchor() {
    let v = vectors();
    for c in &v.anchor_cases {
        let got = run_anchor(c, &v, Some(c.has_dated_live_scene));
        let e = &c.expected;
        let label = format!("{} ({})", c.id, c.description);
        assert_eq!(got.anchor.source, e.source, "{label}: source");
        assert_eq!(got.anchor.start_time, e.start_time, "{label}: startTime");
        assert_eq!(
            got.anchor.start_minute, e.start_minute,
            "{label}: startMinute"
        );
        assert_eq!(
            got.anchor.start_granularity, e.start_granularity,
            "{label}: startGranularity"
        );
        assert_eq!(got.anchor.precision, e.precision, "{label}: precision");
        assert_eq!(
            got.anchor.proxy_scene_id, e.proxy_scene_id,
            "{label}: proxySceneId"
        );
        assert_eq!(got.event_id, e.event_id, "{label}: eventId");
    }
}

/// `hasDatedLiveScene` を省くと、`sceneChronicle` に日付のある場面があるかで決める。
/// 例の値が、その既定と同じ case では、省いても結果が変わらない。
#[test]
fn omitted_has_dated_live_scene_defaults_to_the_scene_chronicle() {
    let v = vectors();
    for c in &v.anchor_cases {
        let derived = c.scene_chronicle.values().any(|sc| {
            sc.start_time.is_some_and(f64::is_finite)
                && matches!(
                    sc.start_granularity.as_str(),
                    "time" | "day" | "month" | "season" | "year"
                )
        });
        if derived == c.has_dated_live_scene {
            assert_eq!(
                run_anchor(c, &v, None),
                run_anchor(c, &v, Some(derived)),
                "{}",
                c.id
            );
        }
    }
}

#[test]
fn anchor_resolution_to_span_input_keeps_the_source_and_the_start() {
    let v = vectors();
    let c = v
        .anchor_cases
        .iter()
        .find(|c| c.id == "anchor-proxy-from-scene-date")
        .expect("case");
    let got = run_anchor(c, &v, Some(c.has_dated_live_scene));
    let input = got.anchor.span_input();
    assert_eq!(input.source, ChronicleAnchorSource::Proxy);
    assert_eq!(input.start_time, got.anchor.start_time);
    assert!(anchor_span(&input, v.calendar(&c.calendar)).is_some());
}

#[test]
fn every_provisional_case_matches_its_expected_dates() {
    let v = vectors();
    for c in &v.provisional_cases {
        let got = provisional_event_dates(&c.events, &c.live_scene_dates);
        assert_eq!(got, c.expected, "{} ({})", c.id, c.description);
    }
}

fn prov_row(id: &str, start: Option<f64>, granularity: &str) -> ChronicleProvisionalEventRow {
    ChronicleProvisionalEventRow {
        id: id.to_owned(),
        ordinal: "a0".to_owned(),
        created_at: "2026-01-01T00:00:00.000Z".to_owned(),
        start_time: start,
        end_time: None,
        start_granularity: granularity.to_owned(),
        end_granularity: "none".to_owned(),
    }
}

#[test]
fn provisional_base_day_floors_fractional_days_and_starts_at_zero_without_dates() {
    assert_eq!(provisional_base_day(&[], &[]), 0.0);
    let events = [
        prov_row("a", Some(10.9), "day"),
        prov_row("b", None, "none"),
    ];
    assert_eq!(provisional_base_day(&events, &[]), 11.0);
    let negative = [prov_row("a", Some(-3.5), "day")];
    assert_eq!(provisional_base_day(&negative, &[]), -3.0);
}

#[test]
fn provisional_ignores_non_finite_days() {
    let events = [
        prov_row("nan", Some(f64::NAN), "day"),
        prov_row("inf", Some(f64::INFINITY), "day"),
    ];
    assert_eq!(provisional_base_day(&events, &[]), 0.0);
    // 開始の日が有限でない出来事は、日時の無い出来事として、仮の日時を入れる。
    let dates = provisional_event_dates(&events, &[]);
    assert_eq!(dates.len(), 2);
}

#[test]
fn relation_of_spans_handles_missing_spans_and_touching_spans() {
    let s = |start, end| Some(ChronicleSpan { start, end });
    assert_eq!(
        relation_of_spans(None, s(0, 10), false),
        ChronicleRelation::Unknown
    );
    assert_eq!(
        relation_of_spans(s(0, 10), None, true),
        ChronicleRelation::Unknown
    );
    // 接する（終わり＝始まり）は重ならない。
    assert_eq!(
        relation_of_spans(s(0, 10), s(10, 20), false),
        ChronicleRelation::Before
    );
    assert_eq!(
        relation_of_spans(s(10, 20), s(0, 10), false),
        ChronicleRelation::After
    );
    assert_eq!(
        relation_of_spans(s(0, 15), s(10, 20), false),
        ChronicleRelation::Concurrent
    );
    // 借りた現在地のときは、重なる出来事も「これまで」。
    assert_eq!(
        relation_of_spans(s(0, 15), s(10, 20), true),
        ChronicleRelation::Before
    );
    assert_eq!(
        relation_of_spans(s(30, 40), s(10, 20), true),
        ChronicleRelation::After
    );
}

#[test]
fn relation_names_are_the_fixture_strings() {
    for (name, relation) in [
        ("before", ChronicleRelation::Before),
        ("concurrent", ChronicleRelation::Concurrent),
        ("after", ChronicleRelation::After),
        ("unknown", ChronicleRelation::Unknown),
    ] {
        let parsed: ChronicleRelation = serde_json::from_str(&format!("\"{name}\"")).expect("name");
        assert_eq!(parsed, relation);
    }
}

#[test]
fn ids_compare_by_byte_order() {
    assert_eq!(cmp_ids("a", "b"), Ordering::Less);
    assert_eq!(cmp_ids("B", "a"), Ordering::Less);
    assert_eq!(cmp_ids("e-10", "e-9"), Ordering::Less);
    assert_eq!(cmp_ids("same", "same"), Ordering::Equal);
}

#[test]
fn sort_is_stable_and_does_not_touch_the_input_events() {
    let row = |id: &str, ordinal: &str, start: Option<f64>| ChronicleOrderRow {
        id: id.to_owned(),
        ordinal: ordinal.to_owned(),
        span: ChronicleEventSpanRow {
            start_time: start,
            start_minute: None,
            start_granularity: if start.is_some() { "day" } else { "none" }.to_owned(),
            end_time: None,
            end_minute: None,
            end_granularity: "none".to_owned(),
        },
    };
    // 同じ id・裏の並び・日の出来事は同点なので、入力の順を保つ（終わりの欄の印で見分ける）。
    let mut first = row("same", "a0", Some(5.0));
    first.span.end_minute = Some(1.0);
    let mut second = row("same", "a0", Some(5.0));
    second.span.end_minute = Some(2.0);
    let events = vec![
        row("late", "a0", Some(9.0)),
        first.clone(),
        row("undated", "a0", None),
        second.clone(),
    ];
    let sorted = sort_chronicle_events(events, None);
    assert_eq!(sorted[0], first);
    assert_eq!(sorted[1], second);
    assert_eq!(ids_of(&sorted), vec!["same", "same", "late", "undated"]);
}

/// 画面の側（`temporal-polyfill` 1.0.1 の `Temporal.Instant.from`）の実物の出力と一致する値の表。
/// 表の値は、画面の側と同じ手順（`normalizeInstantString` → `Instant.from` → `epochMilliseconds`）を
/// 実際に走らせて得た。
const INSTANT_TABLE: &[(&str, Option<i64>)] = &[
    ("2026-01-01T00:00:00.000Z", Some(1767225600000)),
    ("2026-01-01T00:00:00Z", Some(1767225600000)),
    ("2026-01-01T00:00Z", Some(1767225600000)),
    ("2026-01-01T00Z", Some(1767225600000)),
    ("2026-01-01", None),
    ("2026-01-01T00:00:00", None),
    ("2026-01-01 00:00:00", Some(1767225600000)),
    ("2026-01-01 00:00:00Z", Some(1767225600000)),
    ("2026-01-01 00:00:00+09:00", Some(1767193200000)),
    ("2026-01-01t00:00:00z", Some(1767225600000)),
    ("2026-01-01T00:00:00+0900", Some(1767193200000)),
    ("2026-01-01T00:00:00+09", Some(1767193200000)),
    ("2026-01-01T00:00:00+09:00:30", Some(1767193170000)),
    ("2026-01-01T00:00:00.123456789Z", Some(1767225600123)),
    ("2026-01-01T00:00:00.1234567891Z", None),
    ("2026-01-01T00:00:00,5Z", Some(1767225600500)),
    ("20260101T000000Z", Some(1767225600000)),
    ("20260101T0000Z", Some(1767225600000)),
    ("+002026-01-01T00:00:00Z", Some(1767225600000)),
    ("-000001-01-01T00:00:00Z", Some(-62198755200000)),
    ("-000000-01-01T00:00:00Z", None),
    ("2026-01-01T23:59:60Z", Some(1767311999000)),
    ("2026-01-01T24:00:00Z", None),
    ("2026-02-30T00:00:00Z", None),
    ("2026-01-01T00:00:00Z[UTC]", Some(1767225600000)),
    ("2026-01-01T00:00:00+09:00[Asia/Tokyo]", Some(1767193200000)),
    ("2026-01-01T00:00:00Z[u-ca=iso8601]", Some(1767225600000)),
    ("2026-01-01T00:00:00Z[u-ca=gregory]", Some(1767225600000)),
    ("2026-01-01T00:00:00[Asia/Tokyo]", None),
    ("2026-W01-1T00:00:00Z", None),
    ("  2026-01-01T00:00:00Z  ", Some(1767225600000)),
    ("2026-01-01 00:00", None),
    ("2026-01-01 00:00:00.5", Some(1767225600500)),
    ("2026-01-01 00:00:00.1234567891", None),
    ("2026-01-01 00:00:00 ", Some(1767225600000)),
    ("\t2026-01-01 00:00:00", Some(1767225600000)),
    ("12026-01-01T00:00:00Z", None),
    ("2026-1-1T00:00:00Z", None),
    ("2026-01-01T0:00:00Z", None),
    ("2026-01-01T00:00:00.Z", None),
    ("2026-01-01T00:00:00+09:00:00.5", Some(1767193199500)),
    ("2026-01-01T00:00:00-00:00", Some(1767225600000)),
    ("275760-09-13T00:00:00Z", None),
    ("+275760-09-13T00:00:00Z", Some(8640000000000000)),
    ("+275760-09-13T00:00:00.001Z", None),
    ("-271821-04-20T00:00:00Z", Some(-8640000000000000)),
    ("-271821-04-19T23:59:59.999Z", None),
    ("+275760-09-13T00:00:00+01:00", Some(8639999996400000)),
    ("2026-01-01 T00:00:00Z", None),
    ("1969-12-31T23:59:59.9999Z", Some(-1)),
    ("1969-12-31T23:59:59.5Z", Some(-500)),
    ("1969-12-31 23:59:59.9999999", Some(-1)),
    ("0000-01-01T00:00:00Z", Some(-62167219200000)),
    ("2026-01-01T00:00:00+24:00", None),
    ("2026-01-01T00:00:00+23:59", Some(1767139260000)),
    ("2026-01-01T00:00:60Z", Some(1767225659000)),
    ("2026-01-01T00:00:00 Z", None),
    ("2026-01-01T00:00:00Z[!UTC]", Some(1767225600000)),
    ("2026-01-01T00:00:00Z[foo=bar]", Some(1767225600000)),
    (
        "2026-01-01T00:00:00Z[u-ca=iso8601][foo=bar]",
        Some(1767225600000),
    ),
    ("2026-01-01T00:00:00+09:00[+09:00]", Some(1767193200000)),
    ("2026-01-01T00:00:00Z[+09:00]", Some(1767225600000)),
    ("2026-01-01T00:00:00Z[UTC][UTC]", None),
    ("2026-01-01T00:00:00Z[!foo=bar]", None),
    ("2026-01-01T00:00:00Z[Foo=bar]", None),
    ("2026-01-01T00:00:00Z[]", Some(1767225600000)),
    ("2026-01-01T00:00:00Z[", None),
    ("2026-01-01T00:00:00Z[+25:00]", None),
    ("2026-01-01T00:00:00Z[+09:00:30]", None),
    ("2026-01-01T00:00:00Z[+0900]", Some(1767225600000)),
    ("2026-01-01T00:00:00Z[+0900:30]", Some(1767225600000)),
    ("2026-01-01T00:00:00Z[u-ca=iso8601][!u-ca=gregory]", None),
    ("2026-01-01T00:00:00Z[!u-ca=gregory]", Some(1767225600000)),
    ("2026-0101T00:00:00Z", None),
    ("202601-01T00:00:00Z", None),
    ("20260101T00:00:00Z", Some(1767225600000)),
    ("2026-01-01T000000Z", Some(1767225600000)),
    ("2026-01-01T0000:00Z", None),
    ("2026-01-01T00:0000Z", None),
    ("2026-01-01T00:00:00+9", None),
    ("2026-01-01T00:00:00+0900:00", None),
    ("2026-01-01T00:00:00+090000.5", Some(1767193199500)),
    ("2026-01-01T00:00:00+09:60", Some(1767189600000)),
    ("2026-01-01T00:00:00+09:00:60", Some(1767193140000)),
    (
        "2026-01-01T00:00:00+23:59:59.999999999",
        Some(1767139200000),
    ),
    ("2026-01-01T00:00:00+24", None),
    ("2026-01-01 00:00:00.5Z", Some(1767225600500)),
    ("2026-01-01 00:00:00,5", None),
    ("2026-01-01 00:00:00.5+01:00", Some(1767222000500)),
    ("2026-01-01T00:00:00Z\n", Some(1767225600000)),
    (" 2026-01-01T00:00:00Z", Some(1767225600000)),
    ("﻿2026-01-01T00:00:00Z", Some(1767225600000)),
    ("2026-01-01T00:00:00Z", None),
    ("+999999-01-01T00:00:00Z", None),
    ("2024-02-29T00:00:00Z", Some(1709164800000)),
    ("2023-02-29T00:00:00Z", None),
    ("2100-02-29T00:00:00Z", None),
    ("2000-02-29T00:00:00Z", Some(951782400000)),
    ("-000004-02-29T00:00:00Z", Some(-62288352000000)),
    ("2026-04-31T00:00:00Z", None),
    ("2026-01-01T00:60:00Z", None),
    ("2026-01-01T00:00:61Z", None),
    ("２０２６-01-01T00:00:00Z", None),
    ("", None),
    ("   ", None),
    ("not-a-date", None),
    ("aaa", None),
    ("zzz", None),
    ("2026-01-01T00:00:00Z[a]x", None),
    ("2026-01-01T00:00:00Z[a][b][c][d][e][f][g][h][i]", None),
    ("2026-01-01T00:00:00Z[a][b][c][d][e][f][g][h][i][j]", None),
    ("1970-01-01T00:00:00Z", Some(0)),
    ("1970-01-01T00:00:00.999Z", Some(999)),
    ("1970-01-01T00:00:00.9999999Z", Some(999)),
    ("2026-03-01 09:59:59", Some(1772359199000)),
    ("2026-03-01 10:00:01", Some(1772359201000)),
    ("2026-03-01 10:00:00.500", Some(1772359200500)),
];

#[test]
fn instant_strings_match_the_screen_side_reading() {
    for (input, expected) in INSTANT_TABLE {
        assert_eq!(
            instant_epoch_milliseconds(input),
            *expected,
            "input: {input:?}"
        );
    }
}

#[test]
fn created_at_compares_as_an_instant_with_unreadable_values_last() {
    let c = compare_created_at;
    // 形が違っても、同じ時刻は同じ。
    assert_eq!(
        c("2026-03-01T10:00:00.000Z", "2026-03-01 10:00:00"),
        Ordering::Equal
    );
    assert_eq!(
        c("2026-03-01T19:00:00+09:00", "2026-03-01T10:00:00Z"),
        Ordering::Equal
    );
    // ミリ秒より細かい桁は切り捨てる。
    assert_eq!(
        c("2026-03-01T10:00:00.0004Z", "2026-03-01T10:00:00.0009Z"),
        Ordering::Equal
    );
    assert_eq!(
        c("2026-03-01T10:00:00.001Z", "2026-03-01T10:00:00.0009Z"),
        Ordering::Greater
    );
    // 文字列の順ではなく、時刻の順。
    assert_eq!(
        c("2026-03-01T10:00:00+09:00", "2026-03-01T05:00:00Z"),
        Ordering::Less
    );
    // 読めない値は、読める値の後ろ。両方読めなければ同じ。
    assert_eq!(c("not-a-date", "2026-03-01T10:00:00Z"), Ordering::Greater);
    assert_eq!(c("2026-03-01T10:00:00Z", "not-a-date"), Ordering::Less);
    assert_eq!(c("aaa", "zzz"), Ordering::Equal);
    assert_eq!(c("", ""), Ordering::Equal);
    // オフセットの無い形は、読めない（画面の側と同じ）。
    assert_eq!(
        c("2026-03-01T10:00:00", "2026-03-01T10:00:00Z"),
        Ordering::Greater
    );
}

/// 場面の確度（`chronicle_precision`）は DB に CHECK が無い。知らない文字列でも、入力の全体の
/// 読み取りは失敗せず、画面の側と同じに、そのまま現在地に返る。
#[test]
fn an_unknown_scene_precision_passes_through_to_the_anchor() {
    let scene: SceneChronicleDate = serde_json::from_str(
        r#"{"startTime":5,"startMinute":null,"startGranularity":"day","precision":"weird"}"#,
    )
    .expect("scene date with an unknown precision");
    assert_eq!(
        scene.precision,
        ChroniclePrecision::Other("weird".to_owned())
    );
    let mut scene_chronicle = BTreeMap::new();
    scene_chronicle.insert("s1".to_owned(), scene);
    let reading_order = reading_order_from_list(&["s1"]);
    let ctx = ChronicleAnchorContext {
        scene_events: &[],
        events: &[],
        reading_order: &reading_order,
        scene_chronicle: Some(&scene_chronicle),
        calendar: None,
        has_dated_live_scene: None,
    };
    let resolution = resolve_chronicle_anchor_by_date("s1", &ctx);
    assert_eq!(resolution.anchor.source, ChronicleAnchorSource::Scene);
    assert_eq!(resolution.anchor.start_time, Some(5.0));
    assert_eq!(
        resolution.anchor.precision,
        Some(ChroniclePrecision::Other("weird".to_owned()))
    );
    let json = serde_json::to_value(&resolution.anchor).expect("anchor json");
    assert_eq!(json["precision"], "weird");
    assert_eq!(json["source"], "scene");
}

#[test]
fn precision_names_round_trip_as_the_fixture_strings() {
    for (name, precision) in [
        ("exact", ChroniclePrecision::Exact),
        ("approx", ChroniclePrecision::Approx),
        ("unknown", ChroniclePrecision::Unknown),
    ] {
        let json = format!("\"{name}\"");
        assert_eq!(
            serde_json::from_str::<ChroniclePrecision>(&json).expect("precision"),
            precision
        );
        assert_eq!(serde_json::to_string(&precision).expect("json"), json);
    }
}

/// 確度が知らない文字列の出来事は、`unknown` ではないので、材料にできる（画面の側は
/// `precision !== "unknown"`）。
#[test]
fn an_event_with_an_unknown_precision_is_material() {
    let event: ChronicleAnchorEventRow = serde_json::from_str(
        r#"{"id":"e1","ordinal":"a0","startTime":3,"startMinute":null,"startGranularity":"day",
            "endTime":null,"endMinute":null,"endGranularity":"none","precision":"weird"}"#,
    )
    .expect("event");
    let events = [event];
    let links = [SceneEventLink {
        scene_id: "s1".to_owned(),
        event_id: "e1".to_owned(),
    }];
    // 日付のある場面が別にあれば、`unknown` の出来事は材料にならない。知らない文字列は、なる。
    let mut scene_chronicle = BTreeMap::new();
    scene_chronicle.insert(
        "other".to_owned(),
        SceneChronicleDate {
            start_time: Some(1.0),
            start_minute: None,
            start_granularity: "day".to_owned(),
            precision: ChroniclePrecision::Exact,
        },
    );
    let reading_order = reading_order_from_list(&["other", "s1"]);
    let ctx = ChronicleAnchorContext {
        scene_events: &links,
        events: &events,
        reading_order: &reading_order,
        scene_chronicle: Some(&scene_chronicle),
        calendar: None,
        has_dated_live_scene: None,
    };
    let resolution = resolve_chronicle_anchor_by_date("s1", &ctx);
    assert_eq!(resolution.anchor.source, ChronicleAnchorSource::Stamped);
    assert_eq!(resolution.event_id.as_deref(), Some("e1"));
    assert_eq!(
        resolution.anchor.precision,
        Some(ChroniclePrecision::Other("weird".to_owned()))
    );
}
