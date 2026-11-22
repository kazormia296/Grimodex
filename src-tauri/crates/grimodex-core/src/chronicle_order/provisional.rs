//! 日時の無い出来事に入れる、仮の日時の決め方（CED/1 の I2、判断の記録 DR-CED-8・12）。
//! 画面の側 `chronicleProvisionalDate.ts` の写し。
//!
//! 「最も後の日」は、保存された日付そのものから決める（月・季節・年の幅の終わりは使わない）。
//!  - 日時のある出来事の、開始の日と、終わりの日（終わりの粒度が `none` でないもの）。
//!  - 保管済みでない場面の作中日付。
//!
//! 日時の無い出来事を、その翌日から 1 日ずつ置く。置く順は、裏の並び → 作った日時 → id。
//! 出来事にも場面にも日付が無ければ、暦の起点の日（日数 0）から。
//!
//! 日時の無い出来事（仮の日時を入れる対象）は、開始の日が無い出来事である。開始の日があって
//! 粒度が `none` の出来事は、I3 が粒度を直す対象なので、仮の日時は入れない。粒度が知らない
//! 文字列で、開始の日がある出来事も対象にせず（I4）、その日だけを「最も後の日」に数える。
//!
//! 日は、画面の側と同じく浮動小数（`f64`）で持つ（保存される日は整数）。

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

use super::instant::{compare_epoch_milliseconds, instant_epoch_milliseconds};
use super::order::cmp_ids;
use super::span::has_date_parts;

/// 仮の日時を決めるのに要る出来事の欄。粒度は、知らない文字列も受ける。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleProvisionalEventRow {
    /// 出来事の id。
    pub id: String,
    /// 裏の並び。
    pub ordinal: String,
    /// 作った日時（文字列。時刻として比べる）。
    pub created_at: String,
    /// 開始の日。
    #[serde(default)]
    pub start_time: Option<f64>,
    /// 終わりの日。
    #[serde(default)]
    pub end_time: Option<f64>,
    /// 開始の粒度。
    pub start_granularity: String,
    /// 終わりの粒度。
    pub end_granularity: String,
}

/// 保管済みでない場面の作中日付（日時の有無の判定に要る欄だけ）。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleProvisionalSceneDate {
    /// 開始の日。
    #[serde(default)]
    pub start_time: Option<f64>,
    /// 開始の粒度。
    pub start_granularity: String,
}

/// 仮の日時を入れる出来事と、入れる日（日数）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleProvisionalDate {
    /// 出来事の id。
    pub id: String,
    /// 入れる日（日数）。
    pub start_time: f64,
}

fn is_day(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite())
}

/// 日時の無い出来事（仮の日時を入れる対象）か。開始の日が無い出来事。
/// 終わりだけが残っている出来事も、対象（終わりは I3 が消す）。
fn needs_provisional_date(row: &ChronicleProvisionalEventRow) -> bool {
    is_day(row.start_time).is_none()
}

/// 「最も後の日」の翌日（日数）。日付が 1 つも無ければ 0（暦の起点の日）。
/// 日は切り捨てる（保存される日は整数）。
pub fn provisional_base_day(
    events: &[ChronicleProvisionalEventRow],
    live_scene_dates: &[ChronicleProvisionalSceneDate],
) -> f64 {
    let mut latest = f64::NEG_INFINITY;
    let mut take = |day: f64| {
        let d = day.floor();
        if d > latest {
            latest = d;
        }
    };
    for e in events {
        let Some(start) = is_day(e.start_time) else {
            continue;
        };
        take(start);
        if let Some(end) = is_day(e.end_time) {
            if has_date_parts(Some(end), &e.end_granularity) {
                take(end);
            }
        }
    }
    for s in live_scene_dates {
        if has_date_parts(s.start_time, &s.start_granularity) {
            if let Some(day) = s.start_time {
                take(day);
            }
        }
    }
    if latest.is_finite() {
        latest + 1.0
    } else {
        0.0
    }
}

/// 日時の無い出来事の id と、入れる日（日数）の対応を、置く順に返す（I2）。
/// 置く順は、裏の並び → 作った日時 → id（DR-CED-12）。
pub fn provisional_event_dates(
    events: &[ChronicleProvisionalEventRow],
    live_scene_dates: &[ChronicleProvisionalSceneDate],
) -> Vec<ChronicleProvisionalDate> {
    let base = provisional_base_day(events, live_scene_dates);
    // 作った日時は、1 件 1 回だけ読む。
    let mut targets: Vec<(&ChronicleProvisionalEventRow, Option<i64>)> = events
        .iter()
        .filter(|e| needs_provisional_date(e))
        .map(|e| (e, instant_epoch_milliseconds(&e.created_at)))
        .collect();
    targets.sort_by(|(a, created_a), (b, created_b)| -> Ordering {
        a.ordinal
            .cmp(&b.ordinal)
            .then_with(|| compare_epoch_milliseconds(*created_a, *created_b))
            .then_with(|| cmp_ids(&a.id, &b.id))
    });
    targets
        .into_iter()
        .enumerate()
        .map(|(index, (e, _))| ChronicleProvisionalDate {
            id: e.id.clone(),
            start_time: base + index as f64,
        })
        .collect()
}
