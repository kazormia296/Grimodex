//! 年表の出来事を日時で比べるための関数（CED/1、判断の記録 DR-CED-1〜14）。
//!
//! 画面の側（`electron/shared/readDomain/features/chronicle/` の `chronicleSpan.ts` ほか）の
//! 実装と、試験用の例（`chronicle_order_vectors.json`）を正とし、同じ入力に同じ結果を返す。
//! 試験用の例は、画面の側と Native が同じ file を読む。
//!
//! - [`span`]：出来事・場面の作中日付・現在地の日時の幅（分の区間）。
//! - [`order`]：出来事の並び（K1）と、現在地との前後の判定（K2・K2a）。
//! - [`anchor`]：場面の現在地を日時で決める（C3・C3a・C4）。
//! - [`provisional`]：日時の無い出来事に入れる仮の日時（I2）。
//! - [`instant`]：時点の文字列（作った日時）の読み方と比較（DR-CED-12）。

pub mod anchor;
pub mod instant;
pub mod order;
pub mod provisional;
pub mod span;

pub use span::{
    anchor_span, chronicle_date_span, event_span, has_chronicle_date, ChronicleAnchorSource,
    ChronicleAnchorSpanInput, ChronicleDateInput, ChronicleEventSpanRow, ChronicleSpan,
    MINUTES_PER_DAY,
};

pub use anchor::{
    reading_order_from_list, resolve_chronicle_anchor_by_date, resolve_scene_anchor_by_date,
    ChronicleAnchor, ChronicleAnchorContext, ChronicleAnchorEventRow, ChronicleAnchorResolution,
    ChroniclePrecision, SceneChronicleDate, SceneEventLink,
};
pub use instant::{compare_created_at, compare_epoch_milliseconds, instant_epoch_milliseconds};
pub use order::{
    classify_event_relation, cmp_ids, compare_chronicle_events, relation_of_spans,
    sort_chronicle_events, ChronicleOrderRow, ChronicleRelation,
};
pub use provisional::{
    provisional_base_day, provisional_event_dates, ChronicleProvisionalDate,
    ChronicleProvisionalEventRow, ChronicleProvisionalSceneDate,
};

#[cfg(test)]
mod order_tests;
#[cfg(test)]
mod span_tests;
