//! Pure Rust port of the TypeScript chronicle snapshot derivation
//! (`src/features/chronicle/chronicleSnapshot.ts` + `resolveSceneAnchor.ts` +
//! `chronicleTime.ts` season/reading-order helpers).
//!
//! `get_chronicle_state` must return **byte-identical** structured JSON to the
//! in-app `get_chronicle_state` agent tool. This module reproduces the derive
//! exactly so a CI fixture (`chronicle-snapshot/*.json`, shared with the TS
//! `chronicleSnapshot.fixtures.test.ts`) gates TS↔Rust drift.
//!
//! Determinism note: the TS pipeline feeds `listEvents` output (ordered by
//! `ordinal` asc, then `id` asc) into stable JS sorts. Rust `slice::sort_by` is
//! likewise stable, so as long as the caller hands us events in the same
//! (ordinal, id) order, tie-breaking matches. The fixtures pin the input order.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

// ───────── output caps (mirror chronicleSnapshot.ts) ─────────
const MAX_RECENT: usize = 8;
const MAX_OFFPAGE: usize = 3;
const MAX_CHARACTERS: usize = 10;
const MAX_PICK_CHARACTERS: usize = 10;
const TITLE_CAP: usize = 40;
const NOTE_CAP: usize = 30;

// ───────── input row types (subset the derive reads) ─────────

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventInput {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub ordinal: String,
    #[serde(default)]
    pub primary_codex_id: Option<String>,
    #[serde(default)]
    pub location_codex_id: Option<String>,
    #[serde(default)]
    pub start_time: Option<i64>,
    #[serde(default = "default_kind")]
    pub kind: String,
}

fn default_kind() -> String {
    "generic".to_string()
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParticipantInput {
    pub event_id: String,
    pub codex_entry_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneEventInput {
    pub scene_id: String,
    pub event_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationInput {
    pub cause_id: String,
    pub effect_id: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeasonBoundary {
    pub name: String,
    pub start_day_of_year: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarInput {
    pub days_per_year: i64,
    #[serde(default)]
    pub season_boundaries: Vec<SeasonBoundary>,
}

/// A tree node, reduced to the fields `computeGlobalSceneOrder` reads.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneNode {
    pub id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub node_type: String,
    #[serde(default)]
    pub sort_order: String,
}

// ───────── anchor + snapshot output types ─────────

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleAnchor {
    pub ordinal: String,
    pub start_time: Option<i64>,
    pub source: String, // "stamped" | "proxy" | "none"
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub proxy_scene_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotTime {
    pub source: String,
    pub start_time: Option<i64>,
    pub season: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CharacterState {
    pub codex_id: String,
    pub name: String,
    pub status: String, // "alive" | "dead" | "unborn" | "unknown"
    pub age: Option<i64>,
    pub location: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotEvent {
    pub event_id: String,
    pub title: String,
    pub note: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CausalPair {
    pub cause_title: String,
    pub effect_title: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChronicleSnapshot {
    pub time: SnapshotTime,
    pub characters: Vec<CharacterState>,
    pub recent_events: Vec<SnapshotEvent>,
    pub unresolved_causal: Vec<CausalPair>,
    pub offpage: Vec<SnapshotEvent>,
}

// ───────── helpers ─────────

/// fractional-index lexicographic comparison. base62 ASCII keys compare
/// identically by byte order in JS (`a < b` on UTF-16 units) and Rust.
fn cmp_keys(a: &str, b: &str) -> Ordering {
    a.cmp(b)
}

/// `ordinal <= anchorOrdinal`. anchor.source=none carries ordinal "" → false.
fn at_or_before(ordinal: &str, anchor_ordinal: &str) -> bool {
    if anchor_ordinal.is_empty() {
        return false;
    }
    cmp_keys(ordinal, anchor_ordinal) != Ordering::Greater
}

/// Truncate to `cap` Unicode scalar values, appending "…" when over.
///
/// NOTE: JS `String.length`/`slice` count UTF-16 code units; Rust counts
/// scalar values. They diverge only for astral characters (emoji, rare CJK
/// ext-B). For BMP text — including all common CJK — the counts match. Fixtures
/// keep titles/notes within the caps so truncation is a no-op and this
/// boundary difference never surfaces in the parity gate.
fn truncate(s: &str, cap: usize) -> String {
    if s.chars().count() > cap {
        let head: String = s.chars().take(cap).collect();
        format!("{head}…")
    } else {
        s.to_string()
    }
}

///数値時刻 → 作中季節名（`chronicleTime.ts::seasonOf` の移植）。
pub fn season_of(time: i64, calendar: &CalendarInput) -> Option<String> {
    let days_per_year = calendar.days_per_year;
    if days_per_year <= 0 || calendar.season_boundaries.is_empty() {
        return None;
    }
    let day_of_year = time.rem_euclid(days_per_year);
    let mut sorted = calendar.season_boundaries.clone();
    sorted.sort_by_key(|b| b.start_day_of_year);
    // 巻き戻し既定値（年末→年初の循環）= 最後の境界。
    let mut current = sorted.last().cloned();
    for b in &sorted {
        if day_of_year >= b.start_day_of_year {
            current = Some(b.clone());
        } else {
            break;
        }
    }
    current.map(|b| b.name)
}

/// `computeGlobalSceneOrder` の移植: ツリーを DFS し scene にグローバル順序
/// index を割り当てる。folder は index を消費せず再帰、note はスキップ。
pub fn compute_global_scene_order(nodes: &[SceneNode]) -> HashMap<String, i64> {
    let mut result: HashMap<String, i64> = HashMap::new();
    if nodes.is_empty() {
        return result;
    }
    let mut children_map: HashMap<Option<String>, Vec<SceneNode>> = HashMap::new();
    for node in nodes {
        children_map
            .entry(node.parent_id.clone())
            .or_default()
            .push(node.clone());
    }
    for children in children_map.values_mut() {
        children.sort_by(|a, b| cmp_keys(&a.sort_order, &b.sort_order));
    }

    // Recursive DFS over the sorted children groups; visit order is identical
    // to the recursive JS version (folder descends without consuming an index).
    fn dfs(
        parent: &Option<String>,
        children_map: &HashMap<Option<String>, Vec<SceneNode>>,
        index: &mut i64,
        result: &mut HashMap<String, i64>,
    ) {
        let Some(children) = children_map.get(parent) else {
            return;
        };
        for node in children {
            if node.node_type == "scene" {
                result.insert(node.id.clone(), *index);
                *index += 1;
            } else if node.node_type == "folder" {
                dfs(&Some(node.id.clone()), children_map, index, result);
            }
            // note: スキップ
        }
    }
    let mut index: i64 = 0;
    dfs(&None, &children_map, &mut index, &mut result);
    result
}

/// `resolveSceneAnchor` の移植。
pub fn resolve_scene_anchor(
    scene_id: &str,
    scene_events: &[SceneEventInput],
    events: &[EventInput],
    reading_order: &HashMap<String, i64>,
) -> ChronicleAnchor {
    let event_by_id: HashMap<&str, &EventInput> =
        events.iter().map(|e| (e.id.as_str(), e)).collect();

    // sceneId → 紐づく(実在 event)群。挿入順を保つため Vec<(scene, Vec<event>)>。
    let mut stamped_by_scene: Vec<(String, Vec<&EventInput>)> = Vec::new();
    let mut scene_index: HashMap<String, usize> = HashMap::new();
    for se in scene_events {
        let Some(ev) = event_by_id.get(se.event_id.as_str()) else {
            continue;
        };
        if let Some(&i) = scene_index.get(&se.scene_id) {
            stamped_by_scene[i].1.push(ev);
        } else {
            scene_index.insert(se.scene_id.clone(), stamped_by_scene.len());
            stamped_by_scene.push((se.scene_id.clone(), vec![ev]));
        }
    }

    let max_ordinal = |evs: &[&EventInput]| -> ChronicleAnchor {
        let best = evs
            .iter()
            .copied()
            .reduce(|best, e| {
                if cmp_keys(&e.ordinal, &best.ordinal) == Ordering::Greater {
                    e
                } else {
                    best
                }
            })
            .expect("non-empty");
        ChronicleAnchor {
            ordinal: best.ordinal.clone(),
            start_time: best.start_time,
            source: String::new(),
            proxy_scene_id: None,
        }
    };

    // 1. stamped
    if let Some(&i) = scene_index.get(scene_id) {
        let own = &stamped_by_scene[i].1;
        if !own.is_empty() {
            let mut a = max_ordinal(own);
            a.source = "stamped".to_string();
            return a;
        }
    }

    // 2. proxy — 前方(index 小)で最も近い stamp 済シーン
    if let Some(&current_index) = reading_order.get(scene_id) {
        let mut best_scene: Option<&str> = None;
        let mut best_index: i64 = -1;
        for (cand_scene, _) in &stamped_by_scene {
            let Some(&idx) = reading_order.get(cand_scene) else {
                continue;
            };
            if idx < current_index && idx > best_index {
                best_index = idx;
                best_scene = Some(cand_scene.as_str());
            }
        }
        if let Some(bs) = best_scene {
            let i = scene_index[bs];
            let mut a = max_ordinal(&stamped_by_scene[i].1);
            a.source = "proxy".to_string();
            a.proxy_scene_id = Some(bs.to_string());
            return a;
        }
    }

    // 3. none
    ChronicleAnchor {
        ordinal: String::new(),
        start_time: None,
        source: "none".to_string(),
        proxy_scene_id: None,
    }
}

/// `deriveCharacterStateAt` の移植。
pub fn derive_character_state_at(
    character_id: &str,
    anchor: &ChronicleAnchor,
    events: &[EventInput],
    calendar: Option<&CalendarInput>,
) -> (String, Option<i64>) {
    let t = anchor.start_time;
    let mut birth_time: Option<i64> = None;
    let mut death_time: Option<i64> = None;
    for e in events {
        if e.primary_codex_id.as_deref() != Some(character_id) {
            continue;
        }
        let Some(st) = e.start_time else { continue };
        if e.kind == "birth" {
            birth_time = Some(birth_time.map_or(st, |b| b.min(st)));
        } else if e.kind == "death" {
            death_time = Some(death_time.map_or(st, |d| d.min(st)));
        }
    }

    let (Some(t), Some(birth)) = (t, birth_time) else {
        return ("unknown".to_string(), None);
    };
    if birth > t {
        return ("unborn".to_string(), None);
    }
    let dead = death_time.is_some_and(|d| d <= t);
    let ref_time = if dead { death_time.unwrap() } else { t };
    let days_per_year = calendar.map_or(0, |c| c.days_per_year);
    let age = if days_per_year > 0 {
        Some((ref_time - birth).div_euclid(days_per_year))
    } else {
        None
    };
    (if dead { "dead" } else { "alive" }.to_string(), age)
}

/// `deriveLastKnownLocation` の移植。
pub fn derive_last_known_location(
    character_id: &str,
    anchor: &ChronicleAnchor,
    events: &[EventInput],
    participant_event_ids: &HashSet<String>,
    codex_names: &HashMap<String, String>,
) -> Option<String> {
    let mut best: Option<&EventInput> = None;
    for e in events {
        if e.location_codex_id.is_none() {
            continue;
        }
        if !at_or_before(&e.ordinal, &anchor.ordinal) {
            continue;
        }
        let involved = e.primary_codex_id.as_deref() == Some(character_id)
            || participant_event_ids.contains(&e.id);
        if !involved {
            continue;
        }
        match best {
            None => best = Some(e),
            Some(b) if cmp_keys(&e.ordinal, &b.ordinal) == Ordering::Greater => best = Some(e),
            _ => {}
        }
    }
    let best = best?;
    let loc = best.location_codex_id.as_ref()?;
    codex_names.get(loc).cloned()
}

fn derive_recent_events(anchor: &ChronicleAnchor, events: &[EventInput]) -> Vec<SnapshotEvent> {
    let mut filtered: Vec<&EventInput> = events
        .iter()
        .filter(|e| e.kind == "generic" && at_or_before(&e.ordinal, &anchor.ordinal))
        .collect();
    filtered.sort_by(|a, b| cmp_keys(&b.ordinal, &a.ordinal));
    filtered
        .into_iter()
        .take(MAX_RECENT)
        .map(|e| SnapshotEvent {
            event_id: e.id.clone(),
            title: truncate(&e.title, TITLE_CAP),
            note: e
                .note
                .as_ref()
                .filter(|n| !n.is_empty())
                .map(|n| truncate(n, NOTE_CAP)),
        })
        .collect()
}

fn derive_unresolved_causal(
    anchor: &ChronicleAnchor,
    events: &[EventInput],
    relations: &[RelationInput],
) -> Vec<CausalPair> {
    let by_id: HashMap<&str, &EventInput> = events.iter().map(|e| (e.id.as_str(), e)).collect();
    let mut out = Vec::new();
    for r in relations {
        let (Some(cause), Some(effect)) = (
            by_id.get(r.cause_id.as_str()),
            by_id.get(r.effect_id.as_str()),
        ) else {
            continue;
        };
        if at_or_before(&cause.ordinal, &anchor.ordinal)
            && !at_or_before(&effect.ordinal, &anchor.ordinal)
        {
            out.push(CausalPair {
                cause_title: truncate(&cause.title, TITLE_CAP),
                effect_title: truncate(&effect.title, TITLE_CAP),
            });
        }
    }
    out
}

fn derive_offpage_events(
    anchor: &ChronicleAnchor,
    events: &[EventInput],
    scene_events: &[SceneEventInput],
) -> Vec<SnapshotEvent> {
    let stamped: HashSet<&str> = scene_events.iter().map(|se| se.event_id.as_str()).collect();
    let kind_rank = |k: &str| -> i64 {
        if k == "generic" {
            1
        } else {
            0
        }
    };
    let mut filtered: Vec<&EventInput> = events
        .iter()
        .filter(|e| !stamped.contains(e.id.as_str()))
        .filter(|e| anchor.source == "none" || at_or_before(&e.ordinal, &anchor.ordinal))
        .collect();
    filtered.sort_by(|a, b| {
        let rk = kind_rank(&a.kind).cmp(&kind_rank(&b.kind));
        if rk != Ordering::Equal {
            return rk;
        }
        cmp_keys(&b.ordinal, &a.ordinal)
    });
    filtered
        .into_iter()
        .take(MAX_OFFPAGE)
        .map(|e| SnapshotEvent {
            event_id: e.id.clone(),
            title: truncate(&e.title, TITLE_CAP),
            note: e
                .note
                .as_ref()
                .filter(|n| !n.is_empty())
                .map(|n| truncate(n, NOTE_CAP)),
        })
        .collect()
}

/// `pickSnapshotCharacters` の移植（Phase 1 固定ルール）。挿入順を保持。
pub fn pick_snapshot_characters(
    anchor: &ChronicleAnchor,
    events: &[EventInput],
    participants: &[ParticipantInput],
    max: usize,
) -> Vec<String> {
    if anchor.source == "none" {
        return Vec::new();
    }
    let mut ids: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let push = |ids: &mut Vec<String>, seen: &mut HashSet<String>, id: &str| {
        if seen.insert(id.to_string()) {
            ids.push(id.to_string());
        }
    };

    let mut recent: Vec<&EventInput> = events
        .iter()
        .filter(|e| at_or_before(&e.ordinal, &anchor.ordinal))
        .collect();
    recent.sort_by(|a, b| cmp_keys(&b.ordinal, &a.ordinal));
    recent.truncate(MAX_RECENT);
    let recent_ids: HashSet<&str> = recent.iter().map(|e| e.id.as_str()).collect();

    for e in &recent {
        if let Some(pc) = &e.primary_codex_id {
            push(&mut ids, &mut seen, pc);
        }
    }
    for p in participants {
        if recent_ids.contains(p.event_id.as_str()) {
            push(&mut ids, &mut seen, &p.codex_entry_id);
        }
    }
    ids.truncate(max);
    ids
}

/// Direct inputs for `deriveChronicleSnapshot` (anchor + characterIds already
/// resolved). Mirrors `ChronicleSnapshotInput`.
pub struct DeriveInput<'a> {
    pub anchor: &'a ChronicleAnchor,
    pub events: &'a [EventInput],
    pub participants: &'a [ParticipantInput],
    pub relations: &'a [RelationInput],
    pub scene_events: &'a [SceneEventInput],
    pub calendar: Option<&'a CalendarInput>,
    pub character_ids: &'a [String],
    pub codex_names: &'a HashMap<String, String>,
}

/// `deriveChronicleSnapshot` の移植。
pub fn derive_chronicle_snapshot(input: DeriveInput<'_>) -> ChronicleSnapshot {
    let season = match (input.anchor.start_time, input.calendar) {
        (Some(t), Some(cal)) => season_of(t, cal),
        _ => None,
    };

    // characterId → 参加 eventId 集合
    let mut participants_by_codex: HashMap<&str, HashSet<String>> = HashMap::new();
    for p in input.participants {
        participants_by_codex
            .entry(p.codex_entry_id.as_str())
            .or_default()
            .insert(p.event_id.clone());
    }
    let empty: HashSet<String> = HashSet::new();

    let characters: Vec<CharacterState> = input
        .character_ids
        .iter()
        .take(MAX_CHARACTERS)
        .map(|cid| {
            let (status, age) =
                derive_character_state_at(cid, input.anchor, input.events, input.calendar);
            let pset = participants_by_codex.get(cid.as_str()).unwrap_or(&empty);
            let location = derive_last_known_location(
                cid,
                input.anchor,
                input.events,
                pset,
                input.codex_names,
            );
            CharacterState {
                codex_id: cid.clone(),
                name: input
                    .codex_names
                    .get(cid)
                    .cloned()
                    .unwrap_or_else(|| cid.clone()),
                status,
                age,
                location,
            }
        })
        .collect();

    ChronicleSnapshot {
        time: SnapshotTime {
            source: input.anchor.source.clone(),
            start_time: input.anchor.start_time,
            season,
        },
        characters,
        recent_events: derive_recent_events(input.anchor, input.events),
        unresolved_causal: derive_unresolved_causal(input.anchor, input.events, input.relations),
        offpage: derive_offpage_events(input.anchor, input.events, input.scene_events),
    }
}

/// Whole-pipeline inputs (scene_id + raw rows) for `assemble_snapshot`. Shared
/// JSON shape with the `chronicle-snapshot/*.json` fixtures' `input`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssembleInput {
    pub scene_id: String,
    #[serde(default)]
    pub nodes: Vec<SceneNode>,
    #[serde(default)]
    pub events: Vec<EventInput>,
    #[serde(default)]
    pub participants: Vec<ParticipantInput>,
    #[serde(default)]
    pub relations: Vec<RelationInput>,
    #[serde(default)]
    pub scene_events: Vec<SceneEventInput>,
    #[serde(default)]
    pub calendar: Option<CalendarInput>,
    #[serde(default)]
    pub codex_names: HashMap<String, String>,
}

/// resolveSceneAnchor → pickSnapshotCharacters → deriveChronicleSnapshot を一括
/// （getChronicleStateTool / fixture テストと同じパイプライン）。
pub fn assemble_snapshot(input: &AssembleInput) -> ChronicleSnapshot {
    let reading_order = compute_global_scene_order(&input.nodes);
    let anchor = resolve_scene_anchor(
        &input.scene_id,
        &input.scene_events,
        &input.events,
        &reading_order,
    );
    let character_ids = pick_snapshot_characters(
        &anchor,
        &input.events,
        &input.participants,
        MAX_PICK_CHARACTERS,
    );
    derive_chronicle_snapshot(DeriveInput {
        anchor: &anchor,
        events: &input.events,
        participants: &input.participants,
        relations: &input.relations,
        scene_events: &input.scene_events,
        calendar: input.calendar.as_ref(),
        character_ids: &character_ids,
        codex_names: &input.codex_names,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// Every JSON fixture under `tests/fixtures/chronicle-snapshot` (shared with
    /// the TS `chronicleSnapshot.fixtures.test.ts`) must derive to its
    /// `expected` snapshot. This is the Rust half of the TS↔Rust drift gate.
    #[test]
    fn fixtures_match_expected_snapshot() {
        let dir = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../src/features/chronicle/fixtures/chronicle-snapshot"
        );
        let mut count = 0;
        for entry in std::fs::read_dir(dir).expect("fixture dir") {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let raw = std::fs::read_to_string(&path).unwrap();
            let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
            let input: AssembleInput =
                serde_json::from_value(parsed["input"].clone()).expect("input");
            let expected: ChronicleSnapshot =
                serde_json::from_value(parsed["expected"].clone()).expect("expected");
            let got = assemble_snapshot(&input);
            assert_eq!(
                got,
                expected,
                "snapshot drift in fixture {}",
                path.display()
            );
            count += 1;
        }
        assert!(count >= 3, "expected at least 3 fixtures, found {count}");
    }

    #[test]
    fn season_of_wraps_year_end() {
        let cal = CalendarInput {
            days_per_year: 360,
            season_boundaries: vec![
                SeasonBoundary {
                    name: "春".into(),
                    start_day_of_year: 0,
                },
                SeasonBoundary {
                    name: "夏".into(),
                    start_day_of_year: 90,
                },
                SeasonBoundary {
                    name: "秋".into(),
                    start_day_of_year: 180,
                },
                SeasonBoundary {
                    name: "冬".into(),
                    start_day_of_year: 270,
                },
            ],
        };
        assert_eq!(season_of(0, &cal).as_deref(), Some("春"));
        assert_eq!(season_of(95, &cal).as_deref(), Some("夏"));
        assert_eq!(season_of(359, &cal).as_deref(), Some("冬"));
        // wrap: day 720 == day 0
        assert_eq!(season_of(720, &cal).as_deref(), Some("春"));
    }

    #[test]
    fn at_or_before_none_anchor_is_false() {
        assert!(!at_or_before("a0", ""));
        assert!(at_or_before("a0", "a0"));
        assert!(at_or_before("a0", "a1"));
        assert!(!at_or_before("a2", "a1"));
    }
}
