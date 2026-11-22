//! 年表の出来事の並び（CED/1 の K1）と、現在地との前後の判定（K2・K2a、DR-CED-5・6）。
//! 画面の側 `chronicleOrder.ts` の写し。
//!
//! 裏の並び（ordinal）は、同じ日時の出来事の間の順にだけ使う。前後は日時の幅で決める。
//! 「今の場面」の印は、この module では扱わない。純粋な関数だけ。

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

use super::span::{
    anchor_span, event_span, ChronicleAnchorSource, ChronicleAnchorSpanInput,
    ChronicleEventSpanRow, ChronicleSpan,
};
use crate::chronicle_calendar::ChronicleCalendar;

/// 現在地から見た出来事の位置。JSON は `before`／`concurrent`／`after`／`unknown`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChronicleRelation {
    /// これまで。
    Before,
    /// 同時進行。
    Concurrent,
    /// これから。
    After,
    /// 不明（日時が無い、または現在地が決まらない）。
    Unknown,
}

/// 並べる・判定するのに要る欄（幅の欄に、id と裏の並びを足したもの）。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleOrderRow {
    /// 出来事の id。
    pub id: String,
    /// 裏の並び（fractional index。文字列の順）。
    pub ordinal: String,
    /// 日時の欄。
    #[serde(flatten)]
    pub span: ChronicleEventSpanRow,
}

impl AsRef<ChronicleOrderRow> for ChronicleOrderRow {
    fn as_ref(&self) -> &ChronicleOrderRow {
        self
    }
}

/// 文字列を、バイト順で比べる（id は ASCII の前提。画面の側のコードユニット順と一致する）。
/// id の同点の決め方の正本。
pub fn cmp_ids(a: &str, b: &str) -> Ordering {
    a.cmp(b)
}

/// 幅の始まりが同じとき（または幅が無いとき）の、裏の並び → id の同点の決め方。
fn tie_break(a: &ChronicleOrderRow, b: &ChronicleOrderRow) -> Ordering {
    a.ordinal
        .cmp(&b.ordinal)
        .then_with(|| cmp_ids(&a.id, &b.id))
}

/// 幅を出した後の比較（K1）。日時の無い出来事（`None`）は、全部の後ろ。
pub(crate) fn compare_by_span(
    a: &ChronicleOrderRow,
    span_a: Option<ChronicleSpan>,
    b: &ChronicleOrderRow,
    span_b: Option<ChronicleSpan>,
) -> Ordering {
    match (span_a, span_b) {
        (Some(x), Some(y)) => x.start.cmp(&y.start).then_with(|| tie_break(a, b)),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => tie_break(a, b),
    }
}

/// 2 つの出来事の比較（K1）。幅の始まり → 裏の並び → id。
///
/// 日時の無い出来事は、日時のある出来事の全部の後ろで、その中は 裏の並び → id。
/// 月・季節・年だけの出来事は、保存された日ではなく、その幅の始まりで並ぶ。
pub fn compare_chronicle_events(
    a: &ChronicleOrderRow,
    b: &ChronicleOrderRow,
    calendar: Option<&ChronicleCalendar>,
) -> Ordering {
    compare_by_span(
        a,
        event_span(&a.span, calendar),
        b,
        event_span(&b.span, calendar),
    )
}

/// K1 で並べた新しい並びを返す（幅は 1 件 1 回だけ出す。同点は元の順を保つ）。
pub fn sort_chronicle_events<T: AsRef<ChronicleOrderRow>>(
    events: Vec<T>,
    calendar: Option<&ChronicleCalendar>,
) -> Vec<T> {
    let mut keyed: Vec<(T, Option<ChronicleSpan>)> = events
        .into_iter()
        .map(|event| {
            let span = event_span(&event.as_ref().span, calendar);
            (event, span)
        })
        .collect();
    keyed.sort_by(|(a, span_a), (b, span_b)| {
        compare_by_span(a.as_ref(), *span_a, b.as_ref(), *span_b)
    });
    keyed.into_iter().map(|(event, _)| event).collect()
}

/// 幅どうしの前後（K2）。どちらかが `None`（日時が無い）なら `Unknown`。
///
/// 出来事の幅の全部が現在地より前なら `Before`、全部が後なら `After`、重なれば `Concurrent`。
/// 幅は終わりを含まないので、接する（出来事の終わり＝現在地の始まり、または逆）は重ならない
/// （DR-CED-6）。現在地が、手前の場面から借りたもの（`borrowed`）のときは、同時かどうかを
/// 決められないので、重なる出来事は `Before`（K2a）。
pub fn relation_of_spans(
    event: Option<ChronicleSpan>,
    anchor: Option<ChronicleSpan>,
    borrowed: bool,
) -> ChronicleRelation {
    let (Some(event), Some(anchor)) = (event, anchor) else {
        return ChronicleRelation::Unknown;
    };
    if event.end <= anchor.start {
        ChronicleRelation::Before
    } else if event.start >= anchor.end {
        ChronicleRelation::After
    } else if borrowed {
        ChronicleRelation::Before
    } else {
        ChronicleRelation::Concurrent
    }
}

/// 出来事と現在地から、「これまで／同時進行／これから／不明」を返す（K2・K2a）。
/// 現在地が決まらない（`source` が `none`）か、出来事に日時が無ければ `Unknown`。
pub fn classify_event_relation(
    event: &ChronicleEventSpanRow,
    anchor: &ChronicleAnchorSpanInput,
    calendar: Option<&ChronicleCalendar>,
) -> ChronicleRelation {
    relation_of_spans(
        event_span(event, calendar),
        anchor_span(anchor, calendar),
        anchor.source == ChronicleAnchorSource::Proxy,
    )
}
