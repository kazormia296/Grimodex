//! 暦の単体の試験。期待値のうち表になっているものは、画面の側（`chronicleTime.ts`・
//! `chronicleReform.ts`）の関数を同じ暦・同じ入力で実行した結果である。

use std::collections::BTreeMap;

use serde::Deserialize;

use super::*;
use reform::{
    gregorian_to_jdn, jdn_to_gregorian, jdn_to_julian, julian_to_jdn, reform_date_to_day,
    reform_day_to_date,
};

/// 幅の試験と共有する例の file（暦 8 種）。
const VECTORS: &str = include_str!("../chronicle_order/chronicle_order_vectors.json");

#[derive(Deserialize)]
struct Vectors {
    calendars: BTreeMap<String, ChronicleCalendar>,
}

fn calendars() -> BTreeMap<String, ChronicleCalendar> {
    let v: Vectors = serde_json::from_str(VECTORS).expect("vector file");
    assert_eq!(v.calendars.len(), 8);
    v.calendars
}

fn cal(json: &str) -> ChronicleCalendar {
    serde_json::from_str(json).expect("calendar json")
}

fn twelve_months(days: i64) -> String {
    let months: Vec<String> = (0..12)
        .map(|i| format!(r#"{{"name":"M{i}","days":{days}}}"#))
        .collect();
    format!("[{}]", months.join(","))
}

/// (暦, 日番号, 年, 月の番号, 月内日, 年内通日, 季節)。
type DayRow = (
    &'static str,
    i128,
    i128,
    Option<i128>,
    Option<i128>,
    i128,
    Option<&'static str>,
);

const DAY_TABLE: &[DayRow] = &[
    (
        "plain360",
        -1000000,
        -2778,
        Some(2),
        Some(21),
        80,
        Some("春"),
    ),
    ("plain360", -100000, -278, Some(2), Some(21), 80, Some("春")),
    ("plain360", -1461, -5, Some(11), Some(10), 339, Some("冬")),
    ("plain360", -366, -2, Some(11), Some(25), 354, Some("冬")),
    ("plain360", -365, -2, Some(11), Some(26), 355, Some("冬")),
    ("plain360", -1, -1, Some(11), Some(30), 359, Some("冬")),
    ("plain360", 0, 0, Some(0), Some(1), 0, Some("春")),
    ("plain360", 1, 0, Some(0), Some(2), 1, Some("春")),
    ("plain360", 59, 0, Some(1), Some(30), 59, Some("春")),
    ("plain360", 60, 0, Some(2), Some(1), 60, Some("春")),
    ("plain360", 359, 0, Some(11), Some(30), 359, Some("冬")),
    ("plain360", 360, 1, Some(0), Some(1), 0, Some("春")),
    ("plain360", 364, 1, Some(0), Some(5), 4, Some("春")),
    ("plain360", 365, 1, Some(0), Some(6), 5, Some("春")),
    ("plain360", 366, 1, Some(0), Some(7), 6, Some("春")),
    ("plain360", 730, 2, Some(0), Some(11), 10, Some("春")),
    ("plain360", 1000, 2, Some(9), Some(11), 280, Some("冬")),
    ("plain360", 123456, 342, Some(11), Some(7), 336, Some("冬")),
    ("plain360", 730000, 2027, Some(9), Some(11), 280, Some("冬")),
    (
        "plain360Unsorted",
        -1000000,
        -2778,
        Some(2),
        Some(21),
        80,
        Some("春"),
    ),
    (
        "plain360Unsorted",
        -100000,
        -278,
        Some(2),
        Some(21),
        80,
        Some("春"),
    ),
    (
        "plain360Unsorted",
        -1461,
        -5,
        Some(11),
        Some(10),
        339,
        Some("冬"),
    ),
    (
        "plain360Unsorted",
        -366,
        -2,
        Some(11),
        Some(25),
        354,
        Some("冬"),
    ),
    (
        "plain360Unsorted",
        -365,
        -2,
        Some(11),
        Some(26),
        355,
        Some("冬"),
    ),
    (
        "plain360Unsorted",
        -1,
        -1,
        Some(11),
        Some(30),
        359,
        Some("冬"),
    ),
    ("plain360Unsorted", 0, 0, Some(0), Some(1), 0, Some("春")),
    ("plain360Unsorted", 1, 0, Some(0), Some(2), 1, Some("春")),
    ("plain360Unsorted", 59, 0, Some(1), Some(30), 59, Some("春")),
    ("plain360Unsorted", 60, 0, Some(2), Some(1), 60, Some("春")),
    (
        "plain360Unsorted",
        359,
        0,
        Some(11),
        Some(30),
        359,
        Some("冬"),
    ),
    ("plain360Unsorted", 360, 1, Some(0), Some(1), 0, Some("春")),
    ("plain360Unsorted", 364, 1, Some(0), Some(5), 4, Some("春")),
    ("plain360Unsorted", 365, 1, Some(0), Some(6), 5, Some("春")),
    ("plain360Unsorted", 366, 1, Some(0), Some(7), 6, Some("春")),
    (
        "plain360Unsorted",
        730,
        2,
        Some(0),
        Some(11),
        10,
        Some("春"),
    ),
    (
        "plain360Unsorted",
        1000,
        2,
        Some(9),
        Some(11),
        280,
        Some("冬"),
    ),
    (
        "plain360Unsorted",
        123456,
        342,
        Some(11),
        Some(7),
        336,
        Some("冬"),
    ),
    (
        "plain360Unsorted",
        730000,
        2027,
        Some(9),
        Some(11),
        280,
        Some("冬"),
    ),
    (
        "gregorian2000",
        -1000000,
        -738,
        Some(1),
        Some(3),
        33,
        Some("冬"),
    ),
    (
        "gregorian2000",
        -100000,
        1726,
        Some(2),
        Some(18),
        76,
        Some("春"),
    ),
    (
        "gregorian2000",
        -1461,
        1996,
        Some(0),
        Some(1),
        0,
        Some("冬"),
    ),
    (
        "gregorian2000",
        -366,
        1998,
        Some(11),
        Some(31),
        364,
        Some("冬"),
    ),
    ("gregorian2000", -365, 1999, Some(0), Some(1), 0, Some("冬")),
    (
        "gregorian2000",
        -1,
        1999,
        Some(11),
        Some(31),
        364,
        Some("冬"),
    ),
    ("gregorian2000", 0, 2000, Some(0), Some(1), 0, Some("冬")),
    ("gregorian2000", 1, 2000, Some(0), Some(2), 1, Some("冬")),
    ("gregorian2000", 59, 2000, Some(1), Some(29), 59, Some("冬")),
    ("gregorian2000", 60, 2000, Some(2), Some(1), 60, Some("春")),
    (
        "gregorian2000",
        359,
        2000,
        Some(11),
        Some(25),
        359,
        Some("冬"),
    ),
    (
        "gregorian2000",
        360,
        2000,
        Some(11),
        Some(26),
        360,
        Some("冬"),
    ),
    (
        "gregorian2000",
        364,
        2000,
        Some(11),
        Some(30),
        364,
        Some("冬"),
    ),
    (
        "gregorian2000",
        365,
        2000,
        Some(11),
        Some(31),
        365,
        Some("冬"),
    ),
    ("gregorian2000", 366, 2001, Some(0), Some(1), 0, Some("冬")),
    (
        "gregorian2000",
        730,
        2001,
        Some(11),
        Some(31),
        364,
        Some("冬"),
    ),
    (
        "gregorian2000",
        1000,
        2002,
        Some(8),
        Some(27),
        269,
        Some("秋"),
    ),
    (
        "gregorian2000",
        123456,
        2338,
        Some(0),
        Some(5),
        4,
        Some("冬"),
    ),
    (
        "gregorian2000",
        730000,
        3998,
        Some(8),
        Some(3),
        245,
        Some("秋"),
    ),
    ("leapDecember", -1000000, -2776, Some(1), Some(4), 33, None),
    ("leapDecember", -100000, -278, Some(4), Some(28), 147, None),
    ("leapDecember", -1461, -5, Some(11), Some(11), 340, None),
    ("leapDecember", -366, -2, Some(11), Some(25), 354, None),
    ("leapDecember", -365, -2, Some(11), Some(26), 355, None),
    ("leapDecember", -1, -1, Some(11), Some(30), 359, None),
    ("leapDecember", 0, 0, Some(0), Some(1), 0, None),
    ("leapDecember", 1, 0, Some(0), Some(2), 1, None),
    ("leapDecember", 59, 0, Some(1), Some(30), 59, None),
    ("leapDecember", 60, 0, Some(2), Some(1), 60, None),
    ("leapDecember", 359, 0, Some(11), Some(30), 359, None),
    ("leapDecember", 360, 0, Some(11), Some(31), 360, None),
    ("leapDecember", 364, 1, Some(0), Some(4), 3, None),
    ("leapDecember", 365, 1, Some(0), Some(5), 4, None),
    ("leapDecember", 366, 1, Some(0), Some(6), 5, None),
    ("leapDecember", 730, 2, Some(0), Some(10), 9, None),
    ("leapDecember", 1000, 2, Some(9), Some(10), 279, None),
    ("leapDecember", 123456, 342, Some(8), Some(14), 253, None),
    ("leapDecember", 730000, 2026, Some(4), Some(29), 148, None),
    ("yearOnly100", -1000000, -10000, None, None, 0, None),
    ("yearOnly100", -100000, -1000, None, None, 0, None),
    ("yearOnly100", -1461, -15, None, None, 39, None),
    ("yearOnly100", -366, -4, None, None, 34, None),
    ("yearOnly100", -365, -4, None, None, 35, None),
    ("yearOnly100", -1, -1, None, None, 99, None),
    ("yearOnly100", 0, 0, None, None, 0, None),
    ("yearOnly100", 1, 0, None, None, 1, None),
    ("yearOnly100", 59, 0, None, None, 59, None),
    ("yearOnly100", 60, 0, None, None, 60, None),
    ("yearOnly100", 359, 3, None, None, 59, None),
    ("yearOnly100", 360, 3, None, None, 60, None),
    ("yearOnly100", 364, 3, None, None, 64, None),
    ("yearOnly100", 365, 3, None, None, 65, None),
    ("yearOnly100", 366, 3, None, None, 66, None),
    ("yearOnly100", 730, 7, None, None, 30, None),
    ("yearOnly100", 1000, 10, None, None, 0, None),
    ("yearOnly100", 123456, 1234, None, None, 56, None),
    ("yearOnly100", 730000, 7300, None, None, 0, None),
    (
        "singleSeason360",
        -1000000,
        -2778,
        None,
        None,
        80,
        Some("雨季"),
    ),
    (
        "singleSeason360",
        -100000,
        -278,
        None,
        None,
        80,
        Some("雨季"),
    ),
    ("singleSeason360", -1461, -5, None, None, 339, Some("雨季")),
    ("singleSeason360", -366, -2, None, None, 354, Some("雨季")),
    ("singleSeason360", -365, -2, None, None, 355, Some("雨季")),
    ("singleSeason360", -1, -1, None, None, 359, Some("雨季")),
    ("singleSeason360", 0, 0, None, None, 0, Some("雨季")),
    ("singleSeason360", 1, 0, None, None, 1, Some("雨季")),
    ("singleSeason360", 59, 0, None, None, 59, Some("雨季")),
    ("singleSeason360", 60, 0, None, None, 60, Some("雨季")),
    ("singleSeason360", 359, 0, None, None, 359, Some("雨季")),
    ("singleSeason360", 360, 1, None, None, 0, Some("雨季")),
    ("singleSeason360", 364, 1, None, None, 4, Some("雨季")),
    ("singleSeason360", 365, 1, None, None, 5, Some("雨季")),
    ("singleSeason360", 366, 1, None, None, 6, Some("雨季")),
    ("singleSeason360", 730, 2, None, None, 10, Some("雨季")),
    ("singleSeason360", 1000, 2, None, None, 280, Some("雨季")),
    (
        "singleSeason360",
        123456,
        342,
        None,
        None,
        336,
        Some("雨季"),
    ),
    (
        "singleSeason360",
        730000,
        2027,
        None,
        None,
        280,
        Some("雨季"),
    ),
    ("noYear", -1000000, 0, None, None, 0, None),
    ("noYear", -100000, 0, None, None, 0, None),
    ("noYear", -1461, 0, None, None, 0, None),
    ("noYear", -366, 0, None, None, 0, None),
    ("noYear", -365, 0, None, None, 0, None),
    ("noYear", -1, 0, None, None, 0, None),
    ("noYear", 0, 0, None, None, 0, None),
    ("noYear", 1, 0, None, None, 0, None),
    ("noYear", 59, 0, None, None, 0, None),
    ("noYear", 60, 0, None, None, 0, None),
    ("noYear", 359, 0, None, None, 0, None),
    ("noYear", 360, 0, None, None, 0, None),
    ("noYear", 364, 0, None, None, 0, None),
    ("noYear", 365, 0, None, None, 0, None),
    ("noYear", 366, 0, None, None, 0, None),
    ("noYear", 730, 0, None, None, 0, None),
    ("noYear", 1000, 0, None, None, 0, None),
    ("noYear", 123456, 0, None, None, 0, None),
    ("noYear", 730000, 0, None, None, 0, None),
    (
        "reform1582",
        -1000000,
        -1156,
        Some(1),
        Some(25),
        55,
        Some("冬"),
    ),
    (
        "reform1582",
        -100000,
        1308,
        Some(2),
        Some(20),
        79,
        Some("春"),
    ),
    ("reform1582", -1461, 1578, Some(0), Some(1), 0, Some("冬")),
    (
        "reform1582",
        -366,
        1580,
        Some(11),
        Some(31),
        365,
        Some("冬"),
    ),
    ("reform1582", -365, 1581, Some(0), Some(1), 0, Some("冬")),
    ("reform1582", -1, 1581, Some(11), Some(31), 364, Some("冬")),
    ("reform1582", 0, 1582, Some(0), Some(1), 0, Some("冬")),
    ("reform1582", 1, 1582, Some(0), Some(2), 1, Some("冬")),
    ("reform1582", 59, 1582, Some(2), Some(1), 59, Some("冬")),
    ("reform1582", 60, 1582, Some(2), Some(2), 60, Some("春")),
    ("reform1582", 359, 1583, Some(0), Some(5), 4, Some("冬")),
    ("reform1582", 360, 1583, Some(0), Some(6), 5, Some("冬")),
    ("reform1582", 364, 1583, Some(0), Some(10), 9, Some("冬")),
    ("reform1582", 365, 1583, Some(0), Some(11), 10, Some("冬")),
    ("reform1582", 366, 1583, Some(0), Some(12), 11, Some("冬")),
    ("reform1582", 730, 1584, Some(0), Some(11), 10, Some("冬")),
    ("reform1582", 1000, 1584, Some(9), Some(7), 280, Some("秋")),
    (
        "reform1582",
        123456,
        1920,
        Some(0),
        Some(16),
        15,
        Some("冬"),
    ),
    (
        "reform1582",
        730000,
        3580,
        Some(8),
        Some(13),
        256,
        Some("秋"),
    ),
    ("reform1582", 245, 1582, Some(8), Some(3), 245, Some("秋")),
    ("reform1582", 275, 1582, Some(9), Some(3), 275, Some("秋")),
    ("reform1582", 276, 1582, Some(9), Some(4), 276, Some("秋")),
    ("reform1582", 277, 1582, Some(9), Some(15), 277, Some("秋")),
    ("reform1582", 278, 1582, Some(9), Some(16), 278, Some("秋")),
    ("reform1582", 306, 1582, Some(10), Some(13), 306, Some("秋")),
    ("reform1582", 641, 1583, Some(9), Some(14), 286, Some("秋")),
    ("reform1582", -124, 1581, Some(7), Some(30), 241, Some("夏")),
    ("reform1582", -4724, 1569, Some(0), Some(25), 24, Some("冬")),
];

/// (暦, 年, 年の日数, 月 0・1・8・9・11・12 の日数)。
type LengthRow = (&'static str, i128, i128, [i128; 6]);

const LENGTH_TABLE: &[LengthRow] = &[
    ("plain360", -401, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360", -4, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360", -1, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360", 0, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360", 1, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360", 3, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360", 4, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360", 99, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360", 100, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360", 1581, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360", 1582, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360", 1583, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360", 1999, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360", 2000, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360", 2001, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360", 2100, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360", 2400, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360Unsorted", -401, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360Unsorted", -4, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360Unsorted", -1, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360Unsorted", 0, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360Unsorted", 1, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360Unsorted", 3, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360Unsorted", 4, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360Unsorted", 99, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360Unsorted", 100, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360Unsorted", 1581, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360Unsorted", 1582, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360Unsorted", 1583, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360Unsorted", 1999, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360Unsorted", 2000, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360Unsorted", 2001, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360Unsorted", 2100, 360, [30, 30, 30, 30, 30, 0]),
    ("plain360Unsorted", 2400, 360, [30, 30, 30, 30, 30, 0]),
    ("gregorian2000", -401, 365, [31, 28, 30, 31, 31, 0]),
    ("gregorian2000", -4, 366, [31, 29, 30, 31, 31, 0]),
    ("gregorian2000", -1, 365, [31, 28, 30, 31, 31, 0]),
    ("gregorian2000", 0, 366, [31, 29, 30, 31, 31, 0]),
    ("gregorian2000", 1, 365, [31, 28, 30, 31, 31, 0]),
    ("gregorian2000", 3, 365, [31, 28, 30, 31, 31, 0]),
    ("gregorian2000", 4, 366, [31, 29, 30, 31, 31, 0]),
    ("gregorian2000", 99, 365, [31, 28, 30, 31, 31, 0]),
    ("gregorian2000", 100, 365, [31, 28, 30, 31, 31, 0]),
    ("gregorian2000", 1581, 365, [31, 28, 30, 31, 31, 0]),
    ("gregorian2000", 1582, 365, [31, 28, 30, 31, 31, 0]),
    ("gregorian2000", 1583, 365, [31, 28, 30, 31, 31, 0]),
    ("gregorian2000", 1999, 365, [31, 28, 30, 31, 31, 0]),
    ("gregorian2000", 2000, 366, [31, 29, 30, 31, 31, 0]),
    ("gregorian2000", 2001, 365, [31, 28, 30, 31, 31, 0]),
    ("gregorian2000", 2100, 365, [31, 28, 30, 31, 31, 0]),
    ("gregorian2000", 2400, 366, [31, 29, 30, 31, 31, 0]),
    ("leapDecember", -401, 360, [30, 30, 30, 30, 30, 0]),
    ("leapDecember", -4, 361, [30, 30, 30, 30, 31, 0]),
    ("leapDecember", -1, 360, [30, 30, 30, 30, 30, 0]),
    ("leapDecember", 0, 361, [30, 30, 30, 30, 31, 0]),
    ("leapDecember", 1, 360, [30, 30, 30, 30, 30, 0]),
    ("leapDecember", 3, 360, [30, 30, 30, 30, 30, 0]),
    ("leapDecember", 4, 361, [30, 30, 30, 30, 31, 0]),
    ("leapDecember", 99, 360, [30, 30, 30, 30, 30, 0]),
    ("leapDecember", 100, 360, [30, 30, 30, 30, 30, 0]),
    ("leapDecember", 1581, 360, [30, 30, 30, 30, 30, 0]),
    ("leapDecember", 1582, 360, [30, 30, 30, 30, 30, 0]),
    ("leapDecember", 1583, 360, [30, 30, 30, 30, 30, 0]),
    ("leapDecember", 1999, 360, [30, 30, 30, 30, 30, 0]),
    ("leapDecember", 2000, 361, [30, 30, 30, 30, 31, 0]),
    ("leapDecember", 2001, 360, [30, 30, 30, 30, 30, 0]),
    ("leapDecember", 2100, 360, [30, 30, 30, 30, 30, 0]),
    ("leapDecember", 2400, 361, [30, 30, 30, 30, 31, 0]),
    ("yearOnly100", -401, 100, [0, 0, 0, 0, 0, 0]),
    ("yearOnly100", -4, 100, [0, 0, 0, 0, 0, 0]),
    ("yearOnly100", -1, 100, [0, 0, 0, 0, 0, 0]),
    ("yearOnly100", 0, 100, [0, 0, 0, 0, 0, 0]),
    ("yearOnly100", 1, 100, [0, 0, 0, 0, 0, 0]),
    ("yearOnly100", 3, 100, [0, 0, 0, 0, 0, 0]),
    ("yearOnly100", 4, 100, [0, 0, 0, 0, 0, 0]),
    ("yearOnly100", 99, 100, [0, 0, 0, 0, 0, 0]),
    ("yearOnly100", 100, 100, [0, 0, 0, 0, 0, 0]),
    ("yearOnly100", 1581, 100, [0, 0, 0, 0, 0, 0]),
    ("yearOnly100", 1582, 100, [0, 0, 0, 0, 0, 0]),
    ("yearOnly100", 1583, 100, [0, 0, 0, 0, 0, 0]),
    ("yearOnly100", 1999, 100, [0, 0, 0, 0, 0, 0]),
    ("yearOnly100", 2000, 100, [0, 0, 0, 0, 0, 0]),
    ("yearOnly100", 2001, 100, [0, 0, 0, 0, 0, 0]),
    ("yearOnly100", 2100, 100, [0, 0, 0, 0, 0, 0]),
    ("yearOnly100", 2400, 100, [0, 0, 0, 0, 0, 0]),
    ("singleSeason360", -401, 360, [0, 0, 0, 0, 0, 0]),
    ("singleSeason360", -4, 360, [0, 0, 0, 0, 0, 0]),
    ("singleSeason360", -1, 360, [0, 0, 0, 0, 0, 0]),
    ("singleSeason360", 0, 360, [0, 0, 0, 0, 0, 0]),
    ("singleSeason360", 1, 360, [0, 0, 0, 0, 0, 0]),
    ("singleSeason360", 3, 360, [0, 0, 0, 0, 0, 0]),
    ("singleSeason360", 4, 360, [0, 0, 0, 0, 0, 0]),
    ("singleSeason360", 99, 360, [0, 0, 0, 0, 0, 0]),
    ("singleSeason360", 100, 360, [0, 0, 0, 0, 0, 0]),
    ("singleSeason360", 1581, 360, [0, 0, 0, 0, 0, 0]),
    ("singleSeason360", 1582, 360, [0, 0, 0, 0, 0, 0]),
    ("singleSeason360", 1583, 360, [0, 0, 0, 0, 0, 0]),
    ("singleSeason360", 1999, 360, [0, 0, 0, 0, 0, 0]),
    ("singleSeason360", 2000, 360, [0, 0, 0, 0, 0, 0]),
    ("singleSeason360", 2001, 360, [0, 0, 0, 0, 0, 0]),
    ("singleSeason360", 2100, 360, [0, 0, 0, 0, 0, 0]),
    ("singleSeason360", 2400, 360, [0, 0, 0, 0, 0, 0]),
    ("noYear", -401, 0, [0, 0, 0, 0, 0, 0]),
    ("noYear", -4, 0, [0, 0, 0, 0, 0, 0]),
    ("noYear", -1, 0, [0, 0, 0, 0, 0, 0]),
    ("noYear", 0, 0, [0, 0, 0, 0, 0, 0]),
    ("noYear", 1, 0, [0, 0, 0, 0, 0, 0]),
    ("noYear", 3, 0, [0, 0, 0, 0, 0, 0]),
    ("noYear", 4, 0, [0, 0, 0, 0, 0, 0]),
    ("noYear", 99, 0, [0, 0, 0, 0, 0, 0]),
    ("noYear", 100, 0, [0, 0, 0, 0, 0, 0]),
    ("noYear", 1581, 0, [0, 0, 0, 0, 0, 0]),
    ("noYear", 1582, 0, [0, 0, 0, 0, 0, 0]),
    ("noYear", 1583, 0, [0, 0, 0, 0, 0, 0]),
    ("noYear", 1999, 0, [0, 0, 0, 0, 0, 0]),
    ("noYear", 2000, 0, [0, 0, 0, 0, 0, 0]),
    ("noYear", 2001, 0, [0, 0, 0, 0, 0, 0]),
    ("noYear", 2100, 0, [0, 0, 0, 0, 0, 0]),
    ("noYear", 2400, 0, [0, 0, 0, 0, 0, 0]),
    ("reform1582", -401, 365, [31, 28, 30, 31, 31, 0]),
    ("reform1582", -4, 366, [31, 29, 30, 31, 31, 0]),
    ("reform1582", -1, 365, [31, 28, 30, 31, 31, 0]),
    ("reform1582", 0, 366, [31, 29, 30, 31, 31, 0]),
    ("reform1582", 1, 365, [31, 28, 30, 31, 31, 0]),
    ("reform1582", 3, 365, [31, 28, 30, 31, 31, 0]),
    ("reform1582", 4, 366, [31, 29, 30, 31, 31, 0]),
    ("reform1582", 99, 365, [31, 28, 30, 31, 31, 0]),
    ("reform1582", 100, 366, [31, 29, 30, 31, 31, 0]),
    ("reform1582", 1581, 365, [31, 28, 30, 31, 31, 0]),
    ("reform1582", 1582, 355, [31, 28, 30, 21, 31, 0]),
    ("reform1582", 1583, 365, [31, 28, 30, 31, 31, 0]),
    ("reform1582", 1999, 365, [31, 28, 30, 31, 31, 0]),
    ("reform1582", 2000, 366, [31, 29, 30, 31, 31, 0]),
    ("reform1582", 2001, 365, [31, 28, 30, 31, 31, 0]),
    ("reform1582", 2100, 365, [31, 28, 30, 31, 31, 0]),
    ("reform1582", 2400, 366, [31, 29, 30, 31, 31, 0]),
];

#[test]
fn day_number_to_date_and_season_match_the_typescript_table() {
    let cals = calendars();
    for &(name, day, year, month, dom, doy, season) in DAY_TABLE {
        let c = &cals[name];
        let got = day_number_to_date(day, c);
        let label = format!("{name} day {day}");
        assert_eq!(got.year, year, "{label} year");
        assert_eq!(got.month_index, month, "{label} month");
        assert_eq!(got.day_of_month, dom, "{label} day of month");
        assert_eq!(got.day_of_year, doy, "{label} day of year");
        assert_eq!(season_of(day, c), season, "{label} season");
    }
}

#[test]
fn year_and_month_lengths_match_the_typescript_table() {
    let cals = calendars();
    for &(name, year, in_year, months) in LENGTH_TABLE {
        let c = &cals[name];
        assert_eq!(days_in_year(year, c), in_year, "{name} {year} days");
        for (m, want) in [0, 1, 8, 9, 11, 12].into_iter().zip(months) {
            assert_eq!(month_length(year, m, c), want, "{name} {year} month {m}");
        }
    }
}

#[test]
fn day_date_day_round_trips_over_a_wide_range_for_every_calendar() {
    for (name, c) in &calendars() {
        if name == "noYear" {
            continue; // 1 年の日数が 0 の暦は、日から年を決められない（別の試験）。
        }
        let has_months = c.months.as_ref().is_some_and(|m| !m.is_empty());
        // 起点の前後の広い範囲。密に数える範囲と、遠い範囲の間引き。
        let near = (-200_000..=200_000).step_by(1);
        let far = (-30_000_000..=30_000_000).step_by(100_003);
        for day in near.chain(far) {
            let d = day_number_to_date(day, c);
            let back = if has_months {
                date_to_day_number(d.year, d.month_index, d.day_of_month, c)
            } else {
                assert_eq!(d.month_index, None, "{name} {day}");
                date_to_day_number(d.year, None, Some(d.day_of_year + 1), c)
            };
            assert_eq!(back, day, "{name} day {day} -> {d:?}");
            assert!(d.day_of_year >= 0, "{name} {day}");
            assert!(
                d.day_of_year < days_in_year(d.year, c),
                "{name} {day} {d:?}"
            );
        }
    }
}

#[test]
fn year_boundaries_are_consecutive_and_sum_to_the_day_count() {
    for (name, c) in &calendars() {
        if name == "noYear" {
            continue;
        }
        // 年の初日（日番号）は、前の年の日数だけ進む。
        for year in -450..450 {
            let a = date_to_day_number(year, None, None, c);
            let b = date_to_day_number(year + 1, None, None, c);
            assert_eq!(b - a, days_in_year(year, c), "{name} {year}");
            let d = day_number_to_date(a, c);
            assert_eq!((d.year, d.day_of_year), (year, 0), "{name} {year}");
        }
    }
}

#[test]
fn gregorian_leap_year_adds_one_day_to_the_leap_month() {
    let cals = calendars();
    let g = &cals["gregorian2000"];
    assert_eq!(days_in_year(2000, g), 366);
    assert_eq!(days_in_year(1900, g), 365);
    assert_eq!(days_in_year(2004, g), 366);
    assert_eq!(days_in_year(2001, g), 365);
    assert_eq!(month_length(2000, 1, g), 29);
    assert_eq!(month_length(1900, 1, g), 28);
    assert_eq!(month_length(-4, 1, g), 29);
    assert_eq!(month_length(-1, 1, g), 28);
    // 2000 年 3 月 1 日は、通日 60（うるう年）。
    assert_eq!(date_to_day_number(2000, Some(2), Some(1), g), 60);
    assert_eq!(date_to_day_number(2001, Some(2), Some(1), g), 366 + 59);
    let l = &cals["leapDecember"];
    assert_eq!(month_length(0, 11, l), 31);
    assert_eq!(month_length(1, 11, l), 30);
    assert_eq!(month_length(0, 1, l), 30);
}

#[test]
fn reform_switch_skips_labels_but_not_day_numbers() {
    let cals = calendars();
    let r = &cals["reform1582"];
    // 1582-10-04（ユリウス暦）の翌日は 1582-10-15（グレゴリオ暦）。日番号は連続する。
    let oct4 = date_to_day_number(1582, Some(9), Some(4), r);
    let oct15 = date_to_day_number(1582, Some(9), Some(15), r);
    assert_eq!(oct15, oct4 + 1);
    let next = day_number_to_date(oct4 + 1, r);
    assert_eq!(
        (next.year, next.month_index, next.day_of_month),
        (1582, Some(9), Some(15))
    );
    // 切替の月は 10 日短く、切替の年は 355 日。
    assert_eq!(month_length(1582, 9, r), 21);
    assert_eq!(month_length(1582, 8, r), 30);
    assert_eq!(days_in_year(1582, r), 355);
    assert_eq!(days_in_year(1581, r), 365);
    assert_eq!(days_in_year(1583, r), 365);
    // 切替の前はユリウス閏（1500 年はうるう年）、後はグレゴリオ閏（1700 年は平年）。
    assert_eq!(month_length(1500, 1, r), 29);
    assert_eq!(month_length(1700, 1, r), 28);
    assert_eq!(month_length(1600, 1, r), 29);
    // 日番号 0 = 開始年の 1 月 1 日。
    assert_eq!(date_to_day_number(1582, Some(0), Some(1), r), 0);
}

#[test]
fn reform_day_date_conversion_is_consistent_around_the_cutover() {
    let cals = calendars();
    let r = &cals["reform1582"];
    let reform = r.reform.as_ref().expect("reform");
    for day in -2000..2000 {
        let d = reform_day_to_date(day, 1582, reform);
        assert_eq!(
            reform_date_to_day(d.year, d.month_index, d.day_of_month, 1582, reform),
            day
        );
    }
    // 切替の前後の日付は、間の 10 日がラベルに現れない。
    let skipped: Vec<i128> = (-2000..2000)
        .map(|day| reform_day_to_date(day, 1582, reform))
        .filter(|d| d.year == 1582 && d.month_index == 9)
        .map(|d| d.day_of_month)
        .collect();
    assert!(skipped.iter().all(|d| !(5..=14).contains(d)));
    assert_eq!(skipped.len(), 21);
}

#[test]
fn jdn_conversions_match_known_dates() {
    // 2000-01-01（グレゴリオ暦）の JDN は 2451545。
    assert_eq!(gregorian_to_jdn(2000, 1, 1), 2_451_545);
    assert_eq!(jdn_to_gregorian(2_451_545).year, 2000);
    // 1582-10-04（ユリウス暦）と 1582-10-15（グレゴリオ暦）は連続する日。
    assert_eq!(
        julian_to_jdn(1582, 10, 4) + 1,
        gregorian_to_jdn(1582, 10, 15)
    );
    let j = jdn_to_julian(julian_to_jdn(-100, 2, 29));
    assert_eq!((j.year, j.month, j.day), (-100, 2, 29));
    // 負の JDN でも床で一貫する。
    let g = jdn_to_gregorian(gregorian_to_jdn(-4000, 3, 7));
    assert_eq!((g.year, g.month, g.day), (-4000, 3, 7));
}

#[test]
fn a_year_without_length_has_no_months_and_stays_on_the_start_year() {
    let cals = calendars();
    let n = &cals["noYear"];
    for day in [-5, 0, 1, 1000] {
        let d = day_number_to_date(day, n);
        assert_eq!(
            (d.year, d.month_index, d.day_of_month, d.day_of_year),
            (0, None, None, 0),
            "day {day}"
        );
    }
    assert_eq!(season_of(10, n), None);
    assert_eq!(calendar_days_per_year(n), 0);
    assert_eq!(date_to_day_number(7, None, None, n), 0);
    // 負の日数でも同じ（防御の分岐）。
    let neg = cal(
        r#"{"daysPerYear":-3,"seasonBoundaries":[{"name":"a","startDayOfYear":10}],"startYear":7,"months":null}"#,
    );
    let d = day_number_to_date(400, &neg);
    assert_eq!((d.year, d.month_index, d.day_of_year), (7, None, 0));
    assert_eq!(date_to_day_number(9, Some(3), Some(5), &neg), -2);
    assert_eq!(season_of(5, &neg), None);
    assert_eq!(calendar_days_per_year(&neg), -3);
}

#[test]
fn empty_months_mean_no_month_concept() {
    let c = cal(
        r#"{"daysPerYear":360,"seasonBoundaries":[{"name":"a","startDayOfYear":10}],"startYear":0,"months":[]}"#,
    );
    let d = day_number_to_date(400, &c);
    assert_eq!(
        (d.year, d.month_index, d.day_of_month, d.day_of_year),
        (1, None, None, 40)
    );
    assert_eq!(date_to_day_number(1, Some(3), Some(5), &c), 364);
    assert_eq!(month_length(0, 0, &c), 0);
    assert_eq!(season_of(5, &c), Some("a"));
    assert_eq!(season_of(20, &c), Some("a"));
}

#[test]
fn a_leap_month_out_of_range_lands_on_the_last_month_by_the_defensive_branch() {
    let m = twelve_months(30);
    let c = cal(&format!(
        r#"{{"daysPerYear":360,"seasonBoundaries":[],"startYear":0,"months":{m},"leap":{{"kind":"gregorian","monthIndex":12}}}}"#
    ));
    // 年の日数にだけ 1 日が足され、どの月にも足されない。
    assert_eq!(days_in_year(0, &c), 361);
    assert_eq!(month_length(0, 11, &c), 30);
    assert_eq!(month_length(0, 12, &c), 0);
    let d = day_number_to_date(360, &c);
    assert_eq!(
        (d.year, d.month_index, d.day_of_month, d.day_of_year),
        (0, Some(11), Some(30), 360)
    );
    let next = day_number_to_date(361, &c);
    assert_eq!(
        (
            next.year,
            next.month_index,
            next.day_of_month,
            next.day_of_year
        ),
        (1, Some(0), Some(1), 0)
    );
    // 範囲の内なら、その月に足される。
    let c = cal(&format!(
        r#"{{"daysPerYear":360,"seasonBoundaries":[],"startYear":0,"months":{m},"leap":{{"kind":"gregorian","monthIndex":11}}}}"#
    ));
    let d = day_number_to_date(360, &c);
    assert_eq!((d.month_index, d.day_of_month), (Some(11), Some(31)));
    assert_eq!(month_length(0, 11, &c), 31);
    assert_eq!(month_length(1, 11, &c), 30);
}

#[test]
fn month_and_day_are_clamped_when_converting_a_date_to_a_day() {
    let m = twelve_months(30);
    let c = cal(&format!(
        r#"{{"daysPerYear":360,"seasonBoundaries":[],"startYear":5,"months":{m}}}"#
    ));
    assert_eq!(date_to_day_number(7, Some(99), Some(99), &c), 1079);
    assert_eq!(date_to_day_number(7, Some(-4), Some(0), &c), 720);
    assert_eq!(date_to_day_number(7, None, None, &c), 720);
    assert_eq!(date_to_day_number(7, None, Some(10), &c), 729);
    assert_eq!(date_to_day_number(7, Some(2), None, &c), 780);
}

#[test]
fn before_the_start_year_days_and_years_go_backwards() {
    let cals = calendars();
    let p = &cals["plain360"];
    let d = day_number_to_date(-1, p);
    assert_eq!(
        (d.year, d.month_index, d.day_of_month, d.day_of_year),
        (-1, Some(11), Some(30), 359)
    );
    let g = &cals["gregorian2000"];
    let d = day_number_to_date(-1, g);
    assert_eq!(
        (d.year, d.month_index, d.day_of_month, d.day_of_year),
        (1999, Some(11), Some(31), 364)
    );
    // 1996 年（うるう年）の末日。
    let last_1996 = date_to_day_number(1997, None, None, g) - 1;
    let d = day_number_to_date(last_1996, g);
    assert_eq!(
        (d.year, d.month_index, d.day_of_month, d.day_of_year),
        (1996, Some(11), Some(31), 365)
    );
}

#[test]
fn a_one_day_year_with_leap_rule_finds_the_year_without_walking() {
    // 1 年が 1 日で、うるう年がある暦：年の始まりを 1 年ずつ数えると遅い。結果は画面の側と同じ。
    let c = cal(
        r#"{"daysPerYear":1,"seasonBoundaries":[],"startYear":0,"leap":{"kind":"gregorian","monthIndex":0}}"#,
    );
    assert_eq!(day_number_to_date(100_000, &c).year, 80_482);
    assert_eq!(day_number_to_date(-100_000, &c).year, -80_483);
    assert_eq!(days_in_year(4, &c), 2);
    assert_eq!(days_in_year(100, &c), 1);
    let far = day_number_to_date(5_000_000_000_000, &c);
    assert_eq!(
        date_to_day_number(far.year, None, Some(far.day_of_year + 1), &c),
        5_000_000_000_000
    );
}

#[test]
fn season_boundaries_are_sorted_and_wrap_around_the_year_start() {
    let m = twelve_months(30);
    let c = cal(&format!(
        r#"{{"daysPerYear":360,"seasonBoundaries":[{{"name":"x","startDayOfYear":200}},{{"name":"y","startDayOfYear":100}}],"startYear":0,"months":{m},"weekdayNames":["a","b","c"],"weekdayStartIndex":2}}"#
    ));
    assert_eq!(season_of(50, &c), Some("x"));
    assert_eq!(season_of(100, &c), Some("y"));
    assert_eq!(season_of(250, &c), Some("x"));
    assert_eq!(season_of(-1, &c), Some("x"));
    assert_eq!(weekday_of(0, &c), Some(2));
    assert_eq!(weekday_of(-1, &c), Some(1));
    assert_eq!(weekday_of(-4, &c), Some(1));
    let none = cal(r#"{"daysPerYear":360,"seasonBoundaries":[]}"#);
    assert_eq!(season_of(10, &none), None);
    assert_eq!(weekday_of(10, &none), None);
}

#[test]
fn unknown_leap_kind_and_null_fields_read_as_the_defaults() {
    let c = cal(
        r#"{"daysPerYear":365,"seasonBoundaries":[],"startYear":null,"months":null,"leap":{"kind":"lunar"},"reform":null}"#,
    );
    assert_eq!(c.leap, Some(LeapRule::Other));
    assert_eq!(days_in_year(4, &c), 365);
    assert_eq!(c.start_year, None);
    assert_eq!(day_number_to_date(365, &c).year, 1);
    let c = cal(r#"{"daysPerYear":365,"leap":{"kind":"none"}}"#);
    assert_eq!(c.leap, Some(LeapRule::None));
    assert!(c.season_boundaries.is_empty());
    // 月の日数は切り捨てて、1 未満は 1 にそろえる。
    let c = cal(
        r#"{"daysPerYear":0,"months":[{"name":"a","days":29.7},{"name":"b","days":0},{"name":"c","days":-3},{"name":"d","days":null}]}"#,
    );
    assert_eq!(calendar_days_per_year(&c), 29 + 1 + 1 + 1);
}
