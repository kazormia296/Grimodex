//! 場面の「作中の現在地」を、日時で決める（CED/1 の C3・C3a・C4、判断の記録 DR-CED-7・14）。
//! 画面の側 `chronicleAnchorByDate.ts` の写し。
//!
//! 現在地の決め方（C4）：
//!  1. 場面に作中日付があれば、その日付（`scene`）。
//!  2. 無ければ、その場面に結び付いた「材料にできる出来事」のうち、K1 で最も後のもの（`stamped`）。
//!  3. それも無ければ、読む順で手前の、現在地を持つ最も近い場面から借りる（`proxy`）。
//!     候補は「作中日付のある場面か、材料にできる出来事が結び付いた場面」に絞ってから選ぶ。
//!     後ろの場面からは借りない。今の場面が読む順に無ければ借りない。
//!  4. どれも無ければ決まらない（`none`）。
//!
//! 材料にできる出来事（C3）は、日時があり、確度が `unknown` でない出来事。
//! C3a：渡された出来事が全部 `unknown`（日時の無い出来事は `unknown` として扱う）で、
//! 作中日付のある場面（保管済みを除く）も無いときに限り、確度が `unknown` の出来事も材料にする。
//! 日時の無い出来事は、C3a でも材料にならない。
//!
//! 呼び出す側の責任：秘密の印の判定を先に掛けた出来事を渡す。保管済みの場面は
//! `scene_chronicle`・`scene_events` から除いて渡す。
//! 裏の並びの欄（画面の側の `ordinal`）は返さない（DR-CED-14）。

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};

use super::order::{compare_by_span, ChronicleOrderRow};
use super::span::{
    event_span, has_date_parts, ChronicleAnchorSource, ChronicleAnchorSpanInput, ChronicleSpan,
};
use crate::chronicle_calendar::ChronicleCalendar;

/// 日時の確度。JSON は `exact`／`approx`／`unknown`。
///
/// 場面の確度（`chronicle_precision`）は DB に CHECK が無く、画面の側は知らない文字列も
/// そのまま通して現在地に返す。同じに、知らない文字列は [`Self::Other`] で受けて、そのまま返す
/// （入力の全体の読み取りを失敗させない）。`unknown` でない確度は、材料にできる（C3）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChroniclePrecision {
    /// 確か。
    Exact,
    /// おおよそ。
    Approx,
    /// 不明。
    Unknown,
    /// 知らない文字列（画面の側と同じく、`unknown` 以外として扱う）。
    Other(String),
}

impl ChroniclePrecision {
    /// JSON の文字列。
    pub fn as_str(&self) -> &str {
        match self {
            Self::Exact => "exact",
            Self::Approx => "approx",
            Self::Unknown => "unknown",
            Self::Other(other) => other,
        }
    }
}

impl From<String> for ChroniclePrecision {
    fn from(value: String) -> Self {
        match value.as_str() {
            "exact" => Self::Exact,
            "approx" => Self::Approx,
            "unknown" => Self::Unknown,
            _ => Self::Other(value),
        }
    }
}

impl Serialize for ChroniclePrecision {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ChroniclePrecision {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer).map(Self::from)
    }
}

/// 現在地を決めるのに要る出来事の欄（並びに要る欄と、確度）。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleAnchorEventRow {
    /// 並びに要る欄（id・裏の並び・日時）。
    #[serde(flatten)]
    pub order: ChronicleOrderRow,
    /// 確度。
    pub precision: ChroniclePrecision,
}

/// 場面と出来事の結び付き。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneEventLink {
    /// 場面の id。
    pub scene_id: String,
    /// 出来事の id。
    pub event_id: String,
}

/// 場面自身の作中日付。
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneChronicleDate {
    /// 開始の日。
    #[serde(default)]
    pub start_time: Option<f64>,
    /// 開始の分。
    #[serde(default)]
    pub start_minute: Option<f64>,
    /// 粒度。知らない文字列は、日付が無いものとして扱う（DR-CED-3）。
    pub start_granularity: String,
    /// 確度。
    pub precision: ChroniclePrecision,
}

impl SceneChronicleDate {
    /// 場面が作中日付を持つか。
    fn has_date(&self) -> bool {
        has_date_parts(self.start_time, &self.start_granularity)
    }
}

/// 現在地を決める入力。
#[derive(Debug, Clone, Copy)]
pub struct ChronicleAnchorContext<'a> {
    /// 場面と出来事の結び付き。
    pub scene_events: &'a [SceneEventLink],
    /// 出来事。
    pub events: &'a [ChronicleAnchorEventRow],
    /// 場面 id → 読む順の番号（小さいほど手前）。
    ///
    /// 番号は場面ごとに一意であること（[`reading_order_from_list`] で作れば一意）。
    /// 同じ番号の場面が複数あると、借りる場面の同点は、画面の側が `Map` の挿入順、
    /// こちらは「結び付きに最初に現れた順 → 場面 id の順」で決まり、結果が違いうる。
    /// 裏の並びと id の比較も、画面の側はコードユニット順、こちらはバイト順なので、
    /// ASCII 以外（fractional index・UUID の想定の外）では順が逆になりうる。
    pub reading_order: &'a HashMap<String, i64>,
    /// 場面 id → 場面自身の作中日付。保管済みの場面は除いて渡す。
    pub scene_chronicle: Option<&'a BTreeMap<String, SceneChronicleDate>>,
    /// 暦。`None` なら、月・季節・年は保存された日の 1 日の幅になる。
    pub calendar: Option<&'a ChronicleCalendar>,
    /// 作中日付のある、保管済みでない場面があるか（C3a の判定）。
    /// `None` なら、`scene_chronicle` に日付のある場面があるかで決める。
    pub has_dated_live_scene: Option<bool>,
}

/// 読む順の並び（添字が番号）から、場面 id → 番号の対応を作る。
/// 同じ id が複数あれば、後ろの番号を採る（画面の側の `Map` と同じ）。
pub fn reading_order_from_list<S: AsRef<str>>(scene_ids: &[S]) -> HashMap<String, i64> {
    scene_ids
        .iter()
        .enumerate()
        .map(|(index, id)| (id.as_ref().to_owned(), index as i64))
        .collect()
}

/// 現在地。裏の並びの欄は持たない。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleAnchor {
    /// 出どころ。
    pub source: ChronicleAnchorSource,
    /// 開始の日。
    pub start_time: Option<f64>,
    /// 開始の分。
    pub start_minute: Option<f64>,
    /// 開始の粒度。`none` のときは `"none"`。
    pub start_granularity: String,
    /// 確度。`none` のときは `None`。
    pub precision: Option<ChroniclePrecision>,
    /// `source` が `proxy` のとき、借りた場面の id。
    pub proxy_scene_id: Option<String>,
}

impl ChronicleAnchor {
    /// 決まらない現在地。
    fn none() -> Self {
        Self {
            source: ChronicleAnchorSource::None,
            start_time: None,
            start_minute: None,
            start_granularity: "none".to_owned(),
            precision: None,
            proxy_scene_id: None,
        }
    }

    /// 幅を出すための入力にする。
    pub fn span_input(&self) -> ChronicleAnchorSpanInput {
        ChronicleAnchorSpanInput {
            source: self.source,
            start_time: self.start_time,
            start_minute: self.start_minute,
            start_granularity: self.start_granularity.clone(),
        }
    }
}

/// 現在地と、それを決めた出来事の id（`scene`・`none` では `None`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleAnchorResolution {
    /// 現在地。
    pub anchor: ChronicleAnchor,
    /// 現在地を決めた出来事の id。
    pub event_id: Option<String>,
}

/// K1 で最も後の出来事（同点は 裏の並び → id の大きい方。比べるたびに幅を出し直さない）。
fn latest_event<'a>(
    events: &[&'a ChronicleAnchorEventRow],
    calendar: Option<&ChronicleCalendar>,
) -> &'a ChronicleAnchorEventRow {
    let mut best = events[0];
    let mut best_span: Option<ChronicleSpan> = event_span(&best.order.span, calendar);
    for &candidate in &events[1..] {
        let span = event_span(&candidate.order.span, calendar);
        if compare_by_span(&candidate.order, span, &best.order, best_span).is_gt() {
            best = candidate;
            best_span = span;
        }
    }
    best
}

/// 現在地と、それを決めた出来事の id を返す（C4）。
pub fn resolve_chronicle_anchor_by_date(
    scene_id: &str,
    ctx: &ChronicleAnchorContext<'_>,
) -> ChronicleAnchorResolution {
    let calendar = ctx.calendar;
    // 画面の側の `Map` と同じに、同じ id の出来事は後ろのものを採る。
    let mut event_by_id: HashMap<&str, &ChronicleAnchorEventRow> = HashMap::new();
    for e in ctx.events {
        event_by_id.insert(e.order.id.as_str(), e);
    }

    // C3a：出来事が全部「不明」（日時の無い出来事も「不明」として扱う）で、
    // 作中日付のある場面も無いとき。
    let dated_live_scene = ctx.has_dated_live_scene.unwrap_or_else(|| {
        ctx.scene_chronicle
            .is_some_and(|map| map.values().any(SceneChronicleDate::has_date))
    });
    let all_unknown = ctx
        .events
        .iter()
        .all(|e| !event_has_date(e) || e.precision == ChroniclePrecision::Unknown);
    let unknown_is_material = all_unknown && !dated_live_scene;

    let is_material = |e: &ChronicleAnchorEventRow| -> bool {
        event_has_date(e) && (e.precision != ChroniclePrecision::Unknown || unknown_is_material)
    };

    // 場面 id → 結び付いた、材料にできる出来事（events に実在するものだけ。孤児の結び付きは無視）。
    // 場面は、最初に現れた順を覚える（候補の同点の決め方に使う）。
    let mut scene_order: Vec<&str> = Vec::new();
    let mut material_by_scene: HashMap<&str, Vec<&ChronicleAnchorEventRow>> = HashMap::new();
    for link in ctx.scene_events {
        let Some(&event) = event_by_id.get(link.event_id.as_str()) else {
            continue;
        };
        if !is_material(event) {
            continue;
        }
        let scene = link.scene_id.as_str();
        material_by_scene
            .entry(scene)
            .or_insert_with(|| {
                scene_order.push(scene);
                Vec::new()
            })
            .push(event);
    }

    // 場面の直接の現在地（作中日付 → 材料にできる出来事）。無ければ `None`。
    let direct_anchor = |sid: &str| -> Option<ChronicleAnchorResolution> {
        if let Some(sc) = ctx.scene_chronicle.and_then(|map| map.get(sid)) {
            if sc.has_date() {
                return Some(ChronicleAnchorResolution {
                    anchor: ChronicleAnchor {
                        source: ChronicleAnchorSource::Scene,
                        start_time: sc.start_time,
                        start_minute: sc.start_minute,
                        start_granularity: sc.start_granularity.clone(),
                        precision: Some(sc.precision.clone()),
                        proxy_scene_id: None,
                    },
                    event_id: None,
                });
            }
        }
        let own = material_by_scene.get(sid)?;
        if own.is_empty() {
            return None;
        }
        let e = latest_event(own, calendar);
        Some(ChronicleAnchorResolution {
            anchor: ChronicleAnchor {
                source: ChronicleAnchorSource::Stamped,
                start_time: e.order.span.start_time,
                start_minute: e.order.span.start_minute,
                start_granularity: e.order.span.start_granularity.clone(),
                precision: Some(e.precision.clone()),
                proxy_scene_id: None,
            },
            event_id: Some(e.order.id.clone()),
        })
    };

    // 1・2. 今の場面の直接の現在地。
    if let Some(direct) = direct_anchor(scene_id) {
        return direct;
    }

    // 3. 借りる：読む順で手前の、現在地を持つ最も近い場面。
    if let Some(&current_index) = ctx.reading_order.get(scene_id) {
        let mut candidates: Vec<&str> = scene_order.clone();
        if let Some(map) = ctx.scene_chronicle {
            for (sid, sc) in map {
                if sc.has_date() && !candidates.contains(&sid.as_str()) {
                    candidates.push(sid.as_str());
                }
            }
        }
        let mut best_scene: Option<&str> = None;
        let mut best_index = -1i64;
        for candidate in candidates {
            let Some(&index) = ctx.reading_order.get(candidate) else {
                continue;
            };
            if index < current_index && index > best_index {
                best_index = index;
                best_scene = Some(candidate);
            }
        }
        if let Some(borrowed_scene) = best_scene {
            if let Some(mut direct) = direct_anchor(borrowed_scene) {
                direct.anchor.source = ChronicleAnchorSource::Proxy;
                direct.anchor.proxy_scene_id = Some(borrowed_scene.to_owned());
                return direct;
            }
        }
    }

    // 4. 決まらない。
    ChronicleAnchorResolution {
        anchor: ChronicleAnchor::none(),
        event_id: None,
    }
}

/// 現在地だけを返す。
pub fn resolve_scene_anchor_by_date(
    scene_id: &str,
    ctx: &ChronicleAnchorContext<'_>,
) -> ChronicleAnchor {
    resolve_chronicle_anchor_by_date(scene_id, ctx).anchor
}

fn event_has_date(e: &ChronicleAnchorEventRow) -> bool {
    has_date_parts(e.order.span.start_time, &e.order.span.start_granularity)
}
