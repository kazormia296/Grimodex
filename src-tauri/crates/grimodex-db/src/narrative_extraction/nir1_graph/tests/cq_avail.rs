//! CQ-AVAIL baseline harness: a novel-shaped project (scenes in chapters, five
//! main and fifteen minor characters, one approved Codex review per Scene) and
//! the per-seed records / steps / result a seed-local query gets on it.

use super::*;
use crate::narrative_extraction::nir1_capacity::project_read_probe;
use crate::narrative_extraction::nir1_entity_relation::Nir1ProjectReads;
use crate::narrative_extraction::scene_scope::{
    read_narrative_scene_scope, update_narrative_scene_scope, NarrativeSceneScopeUpdatePayload,
    NarrativeSceneScopeUpdateV1,
};
use grimodex_core::narrative_scene_scope::{
    NarrativeSceneMaterialConstraintV1, NarrativeSceneQueryIdentityV1,
    NarrativeScopeCompatibilityMarkerV1, NarrativeScopeConstraintV1, NarrativeScopePrincipalV1,
};
use std::collections::{BTreeMap, BTreeSet};

/// Steps large enough that the cap never binds.
const UNCAPPED_SQL_STEPS: u64 = 100_000_000;

/// Generous on purpose: the shapes must not depend on the 100 ms production
/// lease, which is tested on its own.
const DEADLINE: Duration = Duration::from_secs(30);
/// The number of shapes in `cq_opt::shapes()`. Fixed so that dropping one fails
/// the comparison test instead of shrinking it.
const SHAPES_COUNT: usize = 15;

/// How the review Scene of each approved Codex review is chosen.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ReviewMode {
    /// One review per Scene, under that Scene.
    Scene,
    /// One review per Scene, every review under the first Scene.
    Fixed,
}

impl ReviewMode {
    fn label(self) -> &'static str {
        match self {
            Self::Scene => "scene",
            Self::Fixed => "fixed",
        }
    }
}

/// The cast and summary length of a novel-shaped project. `DEFAULT` is the
/// CQ-AVAIL original (five main and fifteen minor characters, short summaries);
/// the larger casts and 2,000-character summaries are proposal/7's unmeasured
/// combination (CQ-LIM-2 B5).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct NovelShape {
    mains: usize,
    minors: usize,
    /// Characters of each Entity's summary; 0 keeps the original short ones.
    summary_chars: usize,
}

impl NovelShape {
    const DEFAULT: Self = Self {
        mains: 5,
        minors: 15,
        summary_chars: 0,
    };

    /// An Entity's summary: `base` as it was, grown to `summary_chars`.
    fn summary(self, base: &str) -> String {
        if self.summary_chars <= base.chars().count() {
            return base.to_owned();
        }
        let filler = "彼女は静かに窓の外を見つめ、過去の約束と未来への不安を胸に抱きながら、物語の行方を思い描いていた。";
        let mut text = base.to_owned();
        while text.chars().count() < self.summary_chars {
            text.push_str(filler);
        }
        text.chars().take(self.summary_chars).collect()
    }
}

/// Characters appearing in Scene `index` (deterministic, protagonist-centric).
fn scene_cast(index: usize) -> Vec<String> {
    scene_cast_for(index, NovelShape::DEFAULT)
}

fn scene_cast_for(index: usize, shape: NovelShape) -> Vec<String> {
    let NovelShape { mains, minors, .. } = shape;
    let mut cast = Vec::new();
    if index % 5 != 4 {
        cast.push("m1".to_owned());
    }
    if index.is_multiple_of(2) {
        cast.push("m2".to_owned());
    }
    if matches!(index % 5, 1 | 3) {
        cast.push("m3".to_owned());
    }
    if matches!(index % 10, 2 | 5 | 8) {
        cast.push("m4".to_owned());
    }
    if matches!(index % 10, 4 | 9) {
        cast.push("m5".to_owned());
    }
    for extra in 6..=mains {
        if (index + extra).is_multiple_of(4) {
            cast.push(format!("m{extra}"));
        }
    }
    cast.push(format!("c{:02}", index % minors + 1));
    if (mains, minors) != (5, 15) {
        cast.push(format!("c{:02}", (index * 7 + 3) % minors + 1));
        cast.dedup();
    }
    cast
}

/// Seven main-main Relations, one for each main past the fifth, and one main for
/// each minor character.
fn novel_relations_for(shape: NovelShape) -> Vec<(String, String, String)> {
    let NovelShape { mains, minors, .. } = shape;
    let mut relations = Vec::new();
    for (from, to) in [
        ("m1", "m2"),
        ("m1", "m3"),
        ("m1", "m4"),
        ("m1", "m5"),
        ("m2", "m3"),
        ("m2", "m4"),
        ("m3", "m5"),
    ] {
        relations.push((format!("r-{from}-{to}"), from.to_owned(), to.to_owned()));
    }
    for extra in 6..=mains {
        let from = format!("m{extra}");
        let to = format!("m{}", extra - 1);
        relations.push((format!("r-{from}-{to}"), from, to));
    }
    for minor in 1..=minors {
        let main = format!("m{}", (minor - 1) * mains / minors + 1);
        let minor = format!("c{minor:02}");
        relations.push((format!("r-{main}-{minor}"), main, minor));
    }
    relations
}

fn explicit_scope(db: &crate::Database, scene_id: &str, ordinal: usize) -> Result<()> {
    let exact = |reference: &str| NarrativeScopeConstraintV1::Exact {
        reference: reference.into(),
    };
    let current =
        db.with_read_transaction(|conn| read_narrative_scene_scope(conn, PROJECT, scene_id))?;
    update_narrative_scene_scope(
        db,
        NarrativeSceneScopeUpdatePayload {
            project_id: PROJECT.into(),
            scene_id: scene_id.into(),
            request_id: format!("cq-avail-scope-request-{ordinal}"),
            session_id: "cq-avail-scope-session".into(),
            event_uid: format!("cq-avail-scope-event-{ordinal}"),
            base_version: current.binding.version,
            updated_at: format!("2026-09-18T00:{:02}:{:02}.000Z", ordinal / 60, ordinal % 60),
            scope: NarrativeSceneScopeUpdateV1 {
                schema_version: 1,
                compatibility_marker: NarrativeScopeCompatibilityMarkerV1::Explicit,
                query_identity: NarrativeSceneQueryIdentityV1 {
                    timeline: exact("timeline:main"),
                    worldline: exact("worldline:prime"),
                    narrative_layer: exact("layer:manuscript"),
                },
                material_constraint: NarrativeSceneMaterialConstraintV1 {
                    timeline: exact("timeline:main"),
                    worldline: exact("worldline:prime"),
                    narrative_layer: exact("layer:manuscript"),
                },
                knowledge_holder: NarrativeScopePrincipalV1::Reader {},
                audience: NarrativeScopePrincipalV1::Reader {},
            },
        },
    )?;
    Ok(())
}

fn drain_freshness(db: &crate::Database) -> Result<()> {
    use crate::narrative_extraction::incremental_freshness::IncrementalFreshnessCycleOutcome;
    for _ in 0..500 {
        match run_incremental_freshness_cycle(db)? {
            IncrementalFreshnessCycleOutcome::Processed(_) => {}
            IncrementalFreshnessCycleOutcome::Idle => return Ok(()),
            IncrementalFreshnessCycleOutcome::Held(_) => anyhow::bail!("Freshness held"),
        }
    }
    anyhow::bail!("Freshness Feed did not drain")
}

/// One approved Codex review: the Revision it made and the Scene it was made
/// under.
#[derive(Clone, Debug)]
struct Review {
    revision_id: String,
    scene_id: String,
}

struct Novel {
    fixture: Fixture,
    /// Reviews each character appears in.
    appearances: BTreeMap<String, usize>,
    reviews: Vec<Review>,
}

impl Novel {
    fn review_scene(&self, revision_id: &str) -> &str {
        &self
            .reviews
            .iter()
            .find(|review| review.revision_id == revision_id)
            .expect("a Revision of the novel")
            .scene_id
    }
}

/// A novel-shaped project: `chapters` folders holding `scenes` Scenes placed
/// before the query Scene `nir1`, 5 main and 15 minor characters, 22
/// Relations, and one approved Codex review (the prepare IPC path) per Scene.
/// Returns the fixture, the number of reviews each character appears in and
/// every review.
fn novel_fixture(scenes: usize, chapters: usize, mode: ReviewMode) -> Result<Novel> {
    novel_fixture_shaped(scenes, chapters, mode, NovelShape::DEFAULT)
}

fn novel_fixture_shaped(
    scenes: usize,
    chapters: usize,
    mode: ReviewMode,
    shape: NovelShape,
) -> Result<Novel> {
    use crate::narrative_extraction::nir1_entity_relation::prepare_nir1_entity_relation_revision;
    use crate::narrative_extraction::Nir1EntityRelationRevisionPrepareRequest;
    let directory = TestDirectory(
        std::env::temp_dir().join(format!("nir1-cq-avail-novel-{}", uuid::Uuid::new_v4())),
    );
    std::fs::create_dir_all(&directory.0)?;
    let db = crate::Database::new(&directory.0.join("grimodex.db"))?;
    db.migrate()?;
    seed_run_and_catalog(&db)?;
    prepare_a3_scope_fixture(&db)?;
    let per_chapter = scenes.div_ceil(chapters);
    let mut scene_ids = Vec::new();
    db.with_conn(|conn| {
        for chapter in 0..chapters {
            let chapter_id = format!("ch{chapter:02}");
            conn.execute(
                "INSERT INTO tree_nodes (id, project_id, node_type, title, content, sort_order)
                 VALUES (?1, 'default-project', 'folder', ?1, '{}', ?2)",
                params![chapter_id, format!("a0c{chapter:02}")],
            )?;
            for local in 0..per_chapter {
                let index = chapter * per_chapter + local;
                if index >= scenes {
                    break;
                }
                let scene_id = format!("s{index:03}");
                conn.execute(
                    "INSERT INTO tree_nodes
                        (id, project_id, parent_id, node_type, title, content, sort_order)
                     VALUES (?1, 'default-project', ?2, 'scene', ?1, '{}', ?3)",
                    params![scene_id, chapter_id, format!("s{local:03}")],
                )?;
                crate::narrative_extraction::ensure_scene_scope_binding_in_tx(
                    conn,
                    PROJECT,
                    &scene_id,
                    "2026-09-17T00:00:00.000Z",
                    crate::narrative_extraction::SceneScopeInit::UnknownRepairOrRestore,
                )?;
                scene_ids.push(scene_id);
            }
        }
        for main in 1..=shape.mains {
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name, summary, updated_at)
                 VALUES (?1, 'default-project', 'character', ?2, ?3, '2026-09-12T00:00:00Z')",
                params![
                    format!("m{main}"),
                    format!("主要人物{main}"),
                    shape.summary(&format!("主要人物{main}の要約。物語の中心にいる。"))
                ],
            )?;
        }
        for minor in 1..=shape.minors {
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name, summary, updated_at)
                 VALUES (?1, 'default-project', 'character', ?2, ?3, '2026-09-12T00:00:00Z')",
                params![
                    format!("c{minor:02}"),
                    format!("脇役{minor:02}"),
                    shape.summary(&format!("脇役{minor:02}の要約。"))
                ],
            )?;
        }
        for isolated in ["x1", "x2"] {
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name, summary, updated_at)
                 VALUES (?1, 'default-project', 'character', ?1, ?1, '2026-09-12T00:00:00Z')",
                [isolated],
            )?;
        }
        conn.execute(
            "INSERT INTO codex_relations
                (id, project_id, from_codex_id, to_codex_id, relation_type,
                 directionality, version, updated_at)
             VALUES ('r-x1-x2', 'default-project', 'x1', 'x2', 'knows', 'symmetric', 1,
                     '2026-09-12T00:00:00Z')",
            [],
        )?;
        for (edge, from, to) in novel_relations_for(shape) {
            conn.execute(
                "INSERT INTO codex_relations
                    (id, project_id, from_codex_id, to_codex_id, relation_type,
                     directionality, version, updated_at)
                 VALUES (?1, 'default-project', ?2, ?3, 'knows', 'symmetric', 1,
                         '2026-09-12T00:00:00Z')",
                params![edge, from, to],
            )?;
        }
        Ok(())
    })?;
    for (ordinal, scene_id) in scene_ids.iter().enumerate() {
        explicit_scope(&db, scene_id, ordinal)?;
    }
    drain_freshness(&db)?;
    let relations = novel_relations_for(shape);
    let mut appearances = BTreeMap::new();
    let mut made = Vec::new();
    let mut first_revision = String::new();
    // (review Scene, entity ids, relation ids)
    let mut reviews: Vec<(String, Vec<String>, Vec<String>)> = Vec::new();
    for (index, scene_id) in scene_ids.iter().enumerate() {
        let cast = scene_cast_for(index, shape);
        let relation_ids = relations
            .iter()
            .filter(|(_, from, to)| cast.contains(from) && cast.contains(to))
            .map(|(edge, _, _)| edge.clone())
            .collect::<Vec<_>>();
        let scene = match mode {
            ReviewMode::Scene => scene_id.clone(),
            ReviewMode::Fixed => scene_ids[0].clone(),
        };
        reviews.push((scene, cast, relation_ids));
    }
    reviews.push((
        scene_ids[0].clone(),
        vec!["x1".to_owned()],
        vec!["r-x1-x2".to_owned()],
    ));
    for (index, (scene_id, entity_ids, relation_ids)) in reviews.into_iter().enumerate() {
        let mut members = entity_ids.clone();
        let isolated = ("r-x1-x2".to_owned(), "x1".to_owned(), "x2".to_owned());
        for (edge, from, to) in relations.iter().chain(std::iter::once(&isolated)) {
            if relation_ids.contains(edge) {
                members.push(from.clone());
                members.push(to.clone());
            }
        }
        members.sort();
        members.dedup();
        for member in &members {
            *appearances.entry(member.clone()).or_insert(0usize) += 1;
        }
        let review_scene = scene_id.clone();
        let prepared = prepare_nir1_entity_relation_revision(
            &db,
            Nir1EntityRelationRevisionPrepareRequest {
                project_id: PROJECT.into(),
                scene_id,
                proposal_key: Some(format!("codex-ui:selection:cq-avail-{index:03}")),
                entity_ids,
                relation_ids,
            },
        )?;
        let run_id = prepared["runId"].as_str().unwrap().to_owned();
        let revision = prepared["result"]["revisionId"]
            .as_str()
            .unwrap()
            .to_owned();
        approve_typed_revision(
            &db,
            &run_id,
            &serde_json::json!({
                "proposalId": prepared["result"]["proposalId"],
                "revisionId": revision,
            }),
        )?;
        made.push(Review {
            revision_id: revision.clone(),
            scene_id: review_scene,
        });
        if first_revision.is_empty() {
            first_revision = revision;
        }
    }
    drain_freshness(&db)?;
    let authority = WorkspaceAuthority::from_database_for_test(db, directory.0.clone())?;
    publish_graph_index(&authority)?;
    Ok(Novel {
        fixture: Fixture {
            authority,
            lifecycle: WorkspaceLifecycleCore::new(),
            revision: first_revision,
            _directory: directory,
        },
        appearances,
        reviews: made,
    })
}

/// What one query on the novel project needs, with every limit lifted: the
/// replay of the query's traversal and its per-Revision A2 / A3 work on one
/// read snapshot, counting every SQLite VM step. Measurement only.
#[derive(Debug, Default)]
struct Replay {
    revisions: usize,
    eligible: usize,
    unavailable: BTreeMap<String, usize>,
    candidate_rows: usize,
    a2_rows: usize,
    /// The project-level reads A3 shares, admitted once.
    shared_rows: usize,
    shared_bytes: usize,
    /// The A3 rows that belong to a Revision, summed over the Revisions.
    a3_rows: usize,
    steps: u64,
    entities: usize,
    edges: usize,
}

impl Replay {
    fn records(&self) -> usize {
        self.candidate_rows + self.a2_rows + self.shared_rows + self.a3_rows
    }
}

fn replay(fixture: &Fixture, seed: &str, query_scene: &str) -> Result<Replay> {
    let conn = rusqlite::Connection::open_with_flags(
        fixture._directory.0.join("grimodex.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let _: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master", [], |row| row.get(0))?;
    let steps = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let counter = Arc::clone(&steps);
    conn.execute_batch("BEGIN DEFERRED")?;
    let _: i64 = conn.query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))?;
    crate::set_sqlite_progress_handler(
        &conn,
        1,
        Some(move || {
            counter.fetch_add(1, Ordering::Relaxed);
            false
        }),
    )?;
    // Like the C-query itself, the replay runs inside the pinned read snapshot,
    // where table presence is answered from the schema cache.
    let result = crate::nir1_pinned_snapshot::with_pinned_snapshot(&conn, || -> Result<Replay> {
        let mut out = Replay::default();
        let mut frontier = std::collections::VecDeque::from([(seed.to_owned(), 0u8)]);
        let mut hops = BTreeMap::from([(seed.to_owned(), 0u8)]);
        let mut revisions: HashMap<String, Option<Vec<GraphEdgeInput>>> = HashMap::new();
        let mut edges = std::collections::BTreeSet::new();
        let mut shared: Option<Nir1ProjectReads> = None;
        while let Some((entity, hop)) = frontier.pop_front() {
            if hop >= MAX_GRAPH_HOPS {
                continue;
            }
            let mut statement = conn.prepare(
                "SELECT consumer_kind, consumer_key FROM narrative_dependency_edges
                  WHERE project_id=?1 AND source_object_identity=?2 ORDER BY rowid",
            )?;
            let rows = statement
                .query_map(params![PROJECT, format!("codex:{entity}")], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(statement);
            out.candidate_rows += rows.len();
            let candidates = rows
                .into_iter()
                .filter(|(kind, _)| kind == "proposal-revision")
                .map(|(_, key)| key)
                .collect::<std::collections::BTreeSet<_>>();
            for revision in candidates {
                if !revisions.contains_key(&revision) {
                    out.revisions += 1;
                    let mut qualified = None;
                    if let Some(a2) = super::super::input::preflight_revision(
                        &conn,
                        PROJECT,
                        &revision,
                        usize::MAX / 4,
                        usize::MAX / 4,
                    )? {
                        out.a2_rows += a2.rows;
                        if shared.is_none() {
                            let admission = super::super::input::preflight_project_reads(
                                &conn,
                                PROJECT,
                                query_scene,
                                usize::MAX / 4,
                                usize::MAX / 4,
                            )?;
                            out.shared_rows = admission.rows;
                            out.shared_bytes = admission.bytes;
                            shared = Some(Nir1ProjectReads::load(&conn, PROJECT, query_scene)?);
                        }
                        let a3 = super::super::input::preflight_disclosure_revision(
                            &conn,
                            PROJECT,
                            &revision,
                            a2.payload_bytes,
                            out.shared_bytes,
                            usize::MAX / 4,
                            usize::MAX / 4,
                        )?;
                        out.a3_rows += a3.rows;
                        match evaluate_nir1_entity_relation_disclosure_for_graph(
                            &conn,
                            PROJECT,
                            &revision,
                            query_scene,
                            shared.as_ref(),
                        )? {
                            Nir1EntityRelationDisclosureRead::Eligible(disclosure) => {
                                out.eligible += 1;
                                qualified = Some(disclosure.revision.bundle.relations.clone());
                            }
                            Nir1EntityRelationDisclosureRead::Unavailable { reason } => {
                                *out.unavailable.entry(reason).or_insert(0) += 1;
                            }
                        }
                    }
                    revisions.insert(revision.clone(), qualified);
                }
                if let Some(Some(relations)) = revisions.get(&revision) {
                    for relation in relations {
                        let incident = relation.from_entity_id == entity
                            || (relation.directionality == "symmetric"
                                && relation.to_entity_id == entity);
                        if !incident {
                            continue;
                        }
                        edges.insert((revision.clone(), relation.edge_id.clone()));
                        let target = if relation.from_entity_id == entity {
                            &relation.to_entity_id
                        } else {
                            &relation.from_entity_id
                        };
                        if !hops.contains_key(target) {
                            hops.insert(target.clone(), hop + 1);
                            frontier.push_back((target.clone(), hop + 1));
                        }
                    }
                }
            }
        }
        out.entities = hops.len();
        out.edges = edges.len();
        Ok(out)
    });
    let mut out = result?;
    out.steps = steps.load(Ordering::Relaxed);
    conn.execute_batch("ROLLBACK")?;
    Ok(out)
}

/// The worker lane of one query: the production step budget and the fixed
/// records/bytes limits, under the generous test deadline.
fn production_result(fixture: &Fixture, seed: &str) -> Result<(String, Option<String>)> {
    fixture.authority.db().with_conn(|conn| {
        conn.execute_batch("PRAGMA query_only=OFF")?;
        Ok(())
    })?;
    let mut reader = fixture.worker_reader()?;
    let response = reader.query_for_worker_with_maintenance_deadline(
        &Nir1GraphRequest {
            project_id: PROJECT.into(),
            query_scene_id: "nir1".into(),
            seed_entity_id: seed.into(),
        },
        DEADLINE,
    )?;
    Ok((response.status.to_owned(), response.reason))
}

/// The worker lane with no step cap, for the steps the query itself is charged.
fn uncapped_steps(fixture: &Fixture, seed: &str) -> Result<(String, Option<String>, u64)> {
    fixture.authority.db().with_conn(|conn| {
        conn.execute_batch("PRAGMA query_only=OFF")?;
        Ok(())
    })?;
    let mut reader = fixture.worker_reader()?;
    LAST_QUERY_SQL_STEPS.take();
    let authority = Arc::clone(&reader.authority);
    let response = authority.db().with_conn(|conn| {
        reader.query_with_deadline_observed(
            conn,
            &Nir1GraphRequest {
                project_id: PROJECT.into(),
                query_scene_id: "nir1".into(),
                seed_entity_id: seed.into(),
            },
            DEADLINE,
            UNCAPPED_SQL_STEPS,
            None,
            QueryPath::Worker,
        )
    })?;
    let steps = LAST_QUERY_SQL_STEPS.take().unwrap_or(0);
    Ok((response.status.to_owned(), response.reason, steps))
}

#[test]
#[ignore = "CQ-AVAIL measurement only: records, steps and result per seed on a novel-shaped project"]
fn measure_novel_project_availability() -> Result<()> {
    let shapes: Vec<(usize, ReviewMode)> = std::env::var("CQ_AVAIL_SHAPES")
        .unwrap_or_else(|_| "10:scene,10:fixed,50:scene".to_owned())
        .split(',')
        .filter_map(|part| {
            let (scenes, mode) = part.split_once(':')?;
            let mode = match mode {
                "scene" => ReviewMode::Scene,
                "fixed" => ReviewMode::Fixed,
                _ => return None,
            };
            Some((scenes.parse().ok()?, mode))
        })
        .collect();
    for (scenes, mode) in shapes {
        let Novel {
            fixture,
            appearances,
            ..
        } = novel_fixture(scenes, 5, mode)?;
        let (tree_nodes, bindings, revisions): (i64, i64, i64) =
            fixture.authority.with_read_transaction(|conn| {
                Ok((
                    conn.query_row(
                        "SELECT COUNT(*) FROM tree_nodes WHERE project_id=?1",
                        [PROJECT],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM narrative_scene_scope_bindings WHERE project_id=?1",
                        [PROJECT],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM narrative_proposal_revisions",
                        [],
                        |row| row.get(0),
                    )?,
                ))
            })?;
        eprintln!(
            "CQ-AVAIL shape scenes={scenes} mode={} tree_nodes={tree_nodes} bindings={bindings} revisions={revisions} appearances={appearances:?}",
            mode.label()
        );
        for seed in ["m1", "m2", "m3", "m5", "c01"] {
            let replayed = replay(&fixture, seed, "nir1")?;
            let (status, reason) = production_result(&fixture, seed)?;
            let (open_status, open_reason, open_steps) = uncapped_steps(&fixture, seed)?;
            eprintln!(
                "CQ-AVAIL row scenes={scenes} mode={} seed={seed} revisions={} eligible={} candidate_rows={} a2_rows={} shared_rows={} a3_rows={} records={} replay_steps={} entities={} edges={} unavailable={:?} | production={status}/{reason:?} | uncapped_steps={open_steps}/{open_status}/{open_reason:?}",
                mode.label(),
                replayed.revisions,
                replayed.eligible,
                replayed.candidate_rows,
                replayed.a2_rows,
                replayed.shared_rows,
                replayed.a3_rows,
                replayed.records(),
                replayed.steps,
                replayed.entities,
                replayed.edges,
                replayed.unavailable,
            );
        }
    }
    Ok(())
}

// --- R2: one person reviewed under several Scenes ---------------------------

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Lane {
    /// The ordinary reader's own read-only connection.
    Reader,
    /// The worker's reader over the authority connection, under the
    /// maintenance owner, with the production step budget.
    Worker,
}

fn request_for(seed: &str, query_scene: &str) -> Nir1GraphRequest {
    Nir1GraphRequest {
        project_id: PROJECT.into(),
        query_scene_id: query_scene.into(),
        seed_entity_id: seed.into(),
    }
}

/// The typed response of one query on a freshly registered reader of `lane`.
fn run_query(
    fixture: &Fixture,
    lane: Lane,
    request: &Nir1GraphRequest,
) -> Result<Nir1GraphResponse> {
    match lane {
        Lane::Reader => {
            fixture
                .registered_reader()?
                .query_with_deadline(request, DEADLINE, QUERY_SQL_STEPS)
        }
        Lane::Worker => {
            // An earlier worker reader left the shared authority connection
            // `query_only`, which also refuses the temp-table setup.
            fixture.authority.db().with_conn(|conn| {
                conn.execute_batch("PRAGMA query_only=OFF")?;
                Ok(())
            })?;
            fixture
                .worker_reader()?
                .query_for_worker_with_maintenance_deadline(request, DEADLINE)
        }
    }
}

/// The response the parent builds from the worker's frame: encode, validate,
/// project. An unavailable response keeps its reason through the allowlist.
fn through_the_frame(response: &Nir1GraphResponse) -> Result<serde_json::Value> {
    use super::super::worker_projection::Nir1GraphProjection;
    let frame = super::super::worker_frame::encode(response)?;
    let view = super::super::worker_frame::validate(&frame)?;
    if response.status == "available" {
        let projection = Nir1GraphProjection::from_frame(&view, Duration::ZERO)?;
        Ok(serde_json::to_value(projection.into_response())?)
    } else {
        let reason = view
            .unavailable_reason()
            .ok_or_else(|| anyhow::anyhow!("the frame lost the unavailable reason"))?;
        Ok(serde_json::to_value(unavailable_response(
            &Nir1GraphRequest {
                project_id: view.project().to_owned(),
                query_scene_id: view.query_scene().to_owned(),
                seed_entity_id: String::new(),
            },
            &reason.to_string(),
        ))?)
    }
}

fn exact_scene(scene: &str) -> ScopeValue {
    ScopeValue::Exact {
        value: format!("scene:{scene}"),
    }
}

/// What the Scene-by-Scene review of a novel must give: every Entity is one
/// node whatever number of Revisions carried it, and each binding keeps the
/// Scope of the review that made its Revision.
fn assert_scopes_follow_the_reviews(novel: &Novel, graph: &Nir1QualifiedGraph) {
    for node in &graph.nodes {
        assert!(!node.bindings.is_empty());
        assert_eq!(node.bindings.len(), node.binding_scopes.len());
        assert_eq!(node.entity.scope, *node.binding_scopes[0]);
        let mut revisions = BTreeSet::new();
        for (binding, scope) in node.bindings.iter().zip(&node.binding_scopes) {
            assert!(
                revisions.insert(binding.revision_id.clone()),
                "one binding per Revision"
            );
            assert_eq!(
                scope.reading,
                exact_scene(novel.review_scene(&binding.revision_id)),
                "{}: the Scope is the review's",
                node.entity.entity_id
            );
        }
    }
    for edge in &graph.edges {
        let scene = novel.review_scene(&edge.binding.revision_id);
        assert_eq!(edge.from.scope.reading, exact_scene(scene));
        assert_eq!(edge.to.scope.reading, exact_scene(scene));
    }
}

// Reviewing Scene by Scene gives the same person a different Scope in every
// Revision. That is not a contradiction: the person is one node and keeps
// every Revision's Scope (post-B 6.3: exact binding, no name-matching merge).
#[test]
fn scene_by_scene_reviews_leave_every_seed_available_with_a_scope_per_binding() -> Result<()> {
    let novel = novel_fixture(10, 5, ReviewMode::Scene)?;
    for seed in ["m1", "m2", "m3", "m5", "c01"] {
        let request = request_for(seed, "nir1");
        let reader = run_query(&novel.fixture, Lane::Reader, &request)?;
        let worker = run_query(&novel.fixture, Lane::Worker, &request)?;
        for (lane, response) in [(Lane::Reader, &reader), (Lane::Worker, &worker)] {
            assert_eq!(
                response.status, "available",
                "{seed}/{lane:?}: {:?}",
                response.reason
            );
            let graph = response.graph.as_ref().expect("an available Graph");
            assert_scopes_follow_the_reviews(&novel, graph);
            let seed_node = graph
                .nodes
                .iter()
                .find(|node| node.entity.entity_id == seed)
                .expect("the seed is a node");
            assert_eq!(seed_node.hop, 0);
            // Every review the person appears in made one binding of the seed
            // node, under that review's Scene.
            assert_eq!(seed_node.bindings.len(), novel.appearances[seed], "{seed}");
            let scenes = seed_node
                .binding_scopes
                .iter()
                .map(|scope| serde_json::to_string(&scope.reading))
                .collect::<std::result::Result<BTreeSet<_>, _>>()?;
            assert_eq!(
                scenes.len(),
                novel.appearances[seed],
                "{seed}: one distinct Scope per review"
            );
        }
        // The ordinary reader and the worker's reader give the same Graph, and
        // the worker's frame carries it unchanged to the parent.
        assert_eq!(
            serde_json::to_value(&reader)?,
            serde_json::to_value(&worker)?,
            "{seed}"
        );
        assert_eq!(
            through_the_frame(&worker)?,
            serde_json::to_value(&worker)?,
            "{seed}: the frame lost or changed a node Scope"
        );
    }
    Ok(())
}

// Reviewing every Scene under the first Scene gives one Scope everywhere; the
// nodes then keep that Scope once per binding and nothing else changes.
#[test]
fn reviews_under_one_scene_keep_one_scope_in_every_binding() -> Result<()> {
    let novel = novel_fixture(10, 5, ReviewMode::Fixed)?;
    let response = run_query(&novel.fixture, Lane::Worker, &request_for("m5", "nir1"))?;
    assert_eq!(response.status, "available", "{:?}", response.reason);
    let graph = response.graph.as_ref().unwrap();
    assert_scopes_follow_the_reviews(&novel, graph);
    for node in &graph.nodes {
        assert!(node
            .binding_scopes
            .iter()
            .all(|scope| **scope == *node.binding_scopes[0]));
    }
    Ok(())
}

/// The number in a novel Scene id `sNNN`.
fn scene_number(scene_id: &str) -> usize {
    scene_id
        .strip_prefix('s')
        .and_then(|number| number.parse().ok())
        .expect("a Scene of the novel")
}

// A query made in the middle of the novel reaches only the reviews made under
// Scenes before its own. A person reviewed on both sides of the query Scene
// keeps the bindings of the earlier Revisions, each with the Scope of its
// review, and nothing of the later ones: no binding, no Scope, no edge. The
// Revisions the A3 check leaves unavailable (a review under the query Scene
// itself or after it) add nothing to a node.
#[test]
fn a_query_in_the_middle_of_the_novel_binds_only_the_reviews_before_its_scene() -> Result<()> {
    const QUERY: usize = 5;
    let novel = novel_fixture(10, 5, ReviewMode::Scene)?;
    let query_scene = format!("s{QUERY:03}");
    let mut on_both_sides = 0;
    // m1..m5 are reviewed before and after s005 (m5 under s004 and s009);
    // c01 only under s000; c06 only under s005, the query Scene itself.
    for seed in ["m1", "m2", "m3", "m4", "m5", "c01", "c06"] {
        let before = (0..QUERY)
            .filter(|index| scene_cast(*index).iter().any(|member| member == seed))
            .map(|index| format!("s{index:03}"))
            .collect::<BTreeSet<_>>();
        let request = request_for(seed, &query_scene);
        let reader = run_query(&novel.fixture, Lane::Reader, &request)?;
        let worker = run_query(&novel.fixture, Lane::Worker, &request)?;
        for (lane, response) in [(Lane::Reader, &reader), (Lane::Worker, &worker)] {
            assert_eq!(
                response.status, "available",
                "{seed}/{lane:?}: {:?}",
                response.reason
            );
            let graph = response.graph.as_ref().expect("an available Graph");
            // Every binding's Scope is its own review's (so a Scope of a later
            // review would show as a binding of that review) ...
            assert_scopes_follow_the_reviews(&novel, graph);
            // ... and no binding, in a node or an edge, is of a review made
            // under the query Scene or after it.
            for node in &graph.nodes {
                for binding in &node.bindings {
                    let review = novel.review_scene(&binding.revision_id);
                    assert!(
                        scene_number(review) < QUERY,
                        "{seed}/{lane:?}: {} is bound by a review under {review}",
                        node.entity.entity_id
                    );
                }
            }
            for edge in &graph.edges {
                let review = novel.review_scene(&edge.binding.revision_id);
                assert!(
                    scene_number(review) < QUERY,
                    "{seed}/{lane:?}: {} is bound by a review under {review}",
                    edge.relation.edge_id
                );
            }
            // The seed is bound by exactly the earlier reviews it is in.
            let seed_scenes = graph
                .nodes
                .iter()
                .find(|node| node.entity.entity_id == seed)
                .map(|node| {
                    node.bindings
                        .iter()
                        .map(|binding| novel.review_scene(&binding.revision_id).to_owned())
                        .collect::<BTreeSet<_>>()
                })
                .unwrap_or_default();
            assert_eq!(seed_scenes, before, "{seed}/{lane:?}");
            assert_eq!(graph.nodes.is_empty(), before.is_empty(), "{seed}/{lane:?}");
        }
        assert_eq!(
            serde_json::to_value(&reader)?,
            serde_json::to_value(&worker)?,
            "{seed}"
        );
        assert_eq!(
            through_the_frame(&worker)?,
            serde_json::to_value(&worker)?,
            "{seed}: the frame lost or changed a binding or a Scope"
        );
        // Asked after the whole novel, the same person has the later reviews
        // too: the exclusion above is the query Scene's, not the person's.
        if !before.is_empty() && novel.appearances[seed] > before.len() {
            on_both_sides += 1;
        }
    }
    assert_eq!(on_both_sides, 5);
    Ok(())
}

// A genuine contradiction is still refused: two qualified Revisions that
// disagree about the Entity itself (here, which part of its Codex text is the
// Evidence), not about the Scope. The worker names the reason.
#[test]
fn qualified_revisions_that_disagree_on_an_entity_refuse_the_whole_graph() -> Result<()> {
    let fixture = Fixture::new()?;
    let db = fixture.authority.db();
    let mut payload = request(db);
    payload.proposal_key = "nir1:review:evidence-variant".into();
    for entity in &mut payload.bundle.entities {
        entity.scope.reading = exact_scene("a3-source");
        entity.scope.phase = "draft".into();
    }
    // Alice's Codex text is "Alice"; "Ali" is another exact anchor in it.
    let alice = payload
        .bundle
        .entities
        .iter_mut()
        .find(|entity| entity.entity_id == "nir1-alice")
        .expect("the fixture Revision holds Alice");
    alice.evidence[0].quote = "Ali".into();
    alice.evidence[0].end_utf16 = alice.evidence[0].start_utf16 + 3;
    crate::narrative_extraction::nir1_entity_relation::tests::rebind_scope_tokens(db, &mut payload)?;
    let created = create_nir1_entity_relation_revision(db, payload)?;
    approve_typed_revision(db, "nir1-run", &created)?;
    publish_graph_index(&fixture.authority)?;

    let request = request_for("nir1-alice", "nir1");
    let reader = run_query(&fixture, Lane::Reader, &request)?;
    assert_eq!(reader.status, "unavailable");
    assert!(reader.graph.is_none());
    assert_eq!(
        reader.reason.as_deref(),
        Some("query-budget-or-validation-failed")
    );
    let worker = run_query(&fixture, Lane::Worker, &request)?;
    assert_eq!(worker.status, "unavailable");
    assert!(worker.graph.is_none());
    let reason = worker.reason.as_deref().expect("a typed reason");
    assert_eq!(
        reason,
        "query-worker-work-endpoint-version-conflict-pre-cleanup-work-failed-endpoint-version-conflict"
    );
    // The parent classifies it: not a limit, not an invalidation.
    assert_eq!(
        UnavailableReason::parse(reason).map(UnavailableReason::category),
        Some(super::super::worker_frame::UnavailableCategory::Failed)
    );
    // The reason crosses the frame unchanged.
    assert_eq!(through_the_frame(&worker)?["reason"].as_str(), Some(reason));
    Ok(())
}

fn node_entity(id: &str) -> EntityInput {
    EntityInput {
        entity_id: id.into(),
        entity_type: "character".into(),
        label: format!("Label {id}"),
        source_token: format!("codex:{id}@2026-10-14T00:00:00Z"),
        scope: ScopeBinding {
            reading: exact_scene("first"),
            story: ScopeValue::Any {
                purpose: Some("story".into()),
            },
            auto: ScopeValue::Unresolved,
            phase: "draft".into(),
            reveal: "reader".into(),
            pov: None,
            authority_revision: "sha256:00".into(),
        },
        evidence: vec![EvidenceInput {
            evidence_id: format!("{id}:evidence"),
            source_ref: format!("codex:{id}"),
            quote: "Alice".into(),
            start_utf16: 0,
            end_utf16: 5,
        }],
    }
}

fn node_binding(revision: &str) -> Arc<Nir1GraphMaterialBinding> {
    Arc::new(Nir1GraphMaterialBinding {
        revision_id: revision.into(),
        decision_id: format!("{revision}:decision"),
        decision_token: format!("{revision}:decision-token"),
        freshness_token: format!("{revision}:freshness"),
        scope_authority_revision: "sha256:00".into(),
        query_scene_source_token: "v1@2026-10-14T00:00:00Z".into(),
        query_scene_scope_token: "sha256:11".into(),
        query_scene_incarnation_id: "incarnation".into(),
        reveal_state_token: format!("{revision}:reveal"),
    })
}

// The node's identity is every field of the Entity but its Scope. Each field
// that is not the Scope refuses the Graph with the conflict marker; the Scope
// is kept per binding, and a Revision seen again adds nothing.
#[test]
fn a_node_is_identified_by_every_entity_field_except_the_scope() -> Result<()> {
    let first = Arc::new(node_entity("alice"));
    let mut nodes = BTreeMap::new();
    let mut usage = QueryUsage::default();
    add_node(
        &mut nodes,
        &mut usage,
        Arc::clone(&first),
        0,
        node_binding("r1"),
    )?;
    assert_eq!(nodes["alice"].bindings.len(), 1);
    assert_eq!(*nodes["alice"].binding_scopes[0], first.scope);

    // The same Revision again (an edge endpoint) adds neither binding nor Scope.
    let retained = usage.retained_bytes;
    add_node(
        &mut nodes,
        &mut usage,
        Arc::clone(&first),
        0,
        node_binding("r1"),
    )?;
    assert_eq!(nodes["alice"].bindings.len(), 1);
    assert_eq!(usage.retained_bytes, retained);

    // Another Revision scoped the same person differently: one node, two
    // bindings, each with its own Scope, and the Scope is charged.
    let mut elsewhere = node_entity("alice");
    elsewhere.scope.reading = exact_scene("second");
    elsewhere.scope.phase = "another-phase".into();
    elsewhere.scope.pov = Some("pov".into());
    let elsewhere = Arc::new(elsewhere);
    add_node(
        &mut nodes,
        &mut usage,
        Arc::clone(&elsewhere),
        0,
        node_binding("r2"),
    )?;
    assert_eq!(nodes.len(), 1);
    let node = &nodes["alice"];
    assert_eq!(
        node.bindings
            .iter()
            .map(|binding| binding.revision_id.as_str())
            .collect::<Vec<_>>(),
        ["r1", "r2"]
    );
    assert_eq!(*node.binding_scopes[0], first.scope);
    assert_eq!(*node.binding_scopes[1], elsewhere.scope);
    // The node's own Entity stays the first Revision's version.
    assert_eq!(*node.entity, *first);
    assert_eq!(
        usage.retained_bytes,
        retained + binding_scope_retained_bytes(&elsewhere.scope)?
    );

    // Every other field is part of the identity.
    type Change = Box<dyn Fn(&mut EntityInput)>;
    let changes: Vec<(&str, Change)> = vec![
        (
            "type",
            Box::new(|entity| entity.entity_type = "place".into()),
        ),
        ("label", Box::new(|entity| entity.label = "Renamed".into())),
        (
            "source token",
            Box::new(|entity| entity.source_token = "codex:alice@2026-10-15".into()),
        ),
        (
            "evidence id",
            Box::new(|entity| entity.evidence[0].evidence_id = "other".into()),
        ),
        (
            "evidence source",
            Box::new(|entity| entity.evidence[0].source_ref = "codex:other".into()),
        ),
        (
            "evidence quote",
            Box::new(|entity| entity.evidence[0].quote = "Alic".into()),
        ),
        (
            "evidence start",
            Box::new(|entity| entity.evidence[0].start_utf16 = 1),
        ),
        (
            "evidence end",
            Box::new(|entity| entity.evidence[0].end_utf16 = 4),
        ),
        (
            "an extra evidence",
            Box::new(|entity| {
                let extra = entity.evidence[0].clone();
                entity.evidence.push(extra);
            }),
        ),
        ("no evidence", Box::new(|entity| entity.evidence.clear())),
    ];
    for (what, change) in changes {
        let mut contradicting = node_entity("alice");
        change(&mut contradicting);
        // Even with a different Scope on top of it.
        contradicting.scope.reading = exact_scene("third");
        let error = add_node(
            &mut nodes,
            &mut usage,
            Arc::new(contradicting),
            0,
            node_binding("r3"),
        )
        .expect_err(what);
        assert_eq!(error.to_string(), VERSION_CONFLICT_MARKER, "{what}");
    }
    // A refusal leaves the node as it was.
    assert_eq!(nodes["alice"].bindings.len(), 2);
    assert_eq!(nodes["alice"].binding_scopes.len(), 2);
    Ok(())
}

// --- X2: the worker's frame and the in-process reader agree -----------------

// Every response of every CQ-OPT shape, on both lanes and every request, goes
// through the frame the worker writes and comes out as the response it began
// as: the Graph (empty ones too), every node Scope, the typed reasons.
#[test]
fn every_response_survives_the_worker_frame_unchanged() -> Result<()> {
    use super::cq_opt::{request_variants, shapes};
    let mut empty_graphs = 0;
    let mut reasons = BTreeSet::new();
    for shape in shapes() {
        let fixture = (shape.build)()?;
        for lane in [Lane::Reader, Lane::Worker] {
            for (name, request) in request_variants() {
                if name != "seed" && !shape.all_requests {
                    continue;
                }
                let what = format!("{}/{name}/{lane:?}", shape.label);
                let response = run_query(&fixture, lane, &request)?;
                let projected = if response.status == "available" {
                    through_the_frame(&response)?
                } else {
                    // The ordinary reader's generic reason is not a frame
                    // reason; only the worker's typed ones cross.
                    if lane == Lane::Reader {
                        continue;
                    }
                    reasons.extend(response.reason.clone());
                    through_the_frame(&response)?
                };
                assert_eq!(projected, serde_json::to_value(&response)?, "{what}");
                if response.status == "available"
                    && response
                        .graph
                        .as_ref()
                        .is_some_and(|graph| graph.nodes.is_empty())
                {
                    empty_graphs += 1;
                }
            }
        }
    }
    assert!(
        empty_graphs >= 4,
        "the shapes include empty Graphs ({empty_graphs})"
    );
    assert!(reasons.iter().any(|reason| reason.contains("edge-limit")));
    assert!(reasons.iter().any(|reason| reason.contains("node-limit")));
    Ok(())
}

// A seed with no qualified Revision is an available, empty Graph on the
// in-process reader, and now on the worker's frame too (it used to fail to
// encode, and the worker exited 1).
#[test]
fn a_seed_with_no_qualified_revision_is_an_empty_graph_on_every_path() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.authority.db().with_conn(|conn| {
        conn.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, summary, updated_at)
             VALUES ('nir1-loner', 'default-project', 'character', 'Loner', 'Loner',
                     '2026-09-12T00:00:00Z')",
            [],
        )?;
        Ok(())
    })?;
    // The Entity exists and no Revision names it; the query Scene precedes the
    // Entities' own Scope, so the seed Revision does not qualify for `a3-source`.
    for (seed, scene) in [("nir1-loner", "nir1"), ("nir1-alice", "a3-source")] {
        let request = request_for(seed, scene);
        let reader = run_query(&fixture, Lane::Reader, &request)?;
        let worker = run_query(&fixture, Lane::Worker, &request)?;
        for (lane, response) in [(Lane::Reader, &reader), (Lane::Worker, &worker)] {
            assert_eq!(
                response.status, "available",
                "{seed}/{lane:?}: {:?}",
                response.reason
            );
            let graph = response.graph.as_ref().expect("an available Graph");
            assert!(
                graph.nodes.is_empty() && graph.edges.is_empty() && graph.scenes.is_empty(),
                "{seed}/{lane:?}"
            );
            assert_eq!(graph.scene_total, 0);
            assert!(response.scope_revision.is_none());
            // What the worker binary writes for this response.
            assert_eq!(
                through_the_frame(response)?,
                serde_json::to_value(response)?,
                "{seed}/{lane:?}"
            );
        }
        assert_eq!(
            serde_json::to_value(&reader)?,
            serde_json::to_value(&worker)?,
            "{seed}: both paths give the same empty Graph"
        );
    }
    Ok(())
}

// --- R1: the project-level reads are made, and charged, once per query ------

/// Run `operation` with every Revision of a query reading the project-level
/// state itself, the way `evaluate_nir1_entity_relation_disclosure` does. The
/// admission is unchanged: this is the oracle for the response.
fn with_unshared_reads<T>(operation: impl FnOnce() -> T) -> T {
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            UNSHARED_PROJECT_READS.set(self.0);
        }
    }
    let _restore = Restore(UNSHARED_PROJECT_READS.replace(true));
    operation()
}

/// The serialized response and the SQL steps its query was charged.
fn run_measured(
    fixture: &Fixture,
    lane: Lane,
    request: &Nir1GraphRequest,
) -> Result<(String, u64)> {
    LAST_QUERY_SQL_STEPS.take();
    let response = run_query(fixture, lane, request)?;
    let steps = LAST_QUERY_SQL_STEPS
        .take()
        .ok_or_else(|| anyhow::anyhow!("the query did not record its SQL steps"))?;
    Ok((serde_json::to_string(&response)?, steps))
}

// Sharing the reads changes how often they are made, not what a Revision's
// check finds: every shape, both lanes, every request, byte for byte the same
// response as when each Revision reads the project-level state itself.
#[test]
fn shared_reads_return_the_response_of_reading_per_revision_on_every_shape() -> Result<()> {
    use super::cq_opt::{request_variants, shapes};
    let mut compared = 0;
    // A shape dropped from shapes() must not shrink the comparison unnoticed:
    // the derived count below follows shapes(), so the count of shapes is fixed
    // here as well.
    assert_eq!(shapes().len(), SHAPES_COUNT, "the shape list changed");
    // Every shape on both lanes: the plain seed query, and every request
    // variant for the shapes that fix those too.
    let expected: usize = shapes()
        .iter()
        .map(|shape| if shape.all_requests { request_variants().len() } else { 1 })
        .sum::<usize>()
        * 2;
    for shape in shapes() {
        let fixture = (shape.build)()?;
        for lane in [Lane::Reader, Lane::Worker] {
            for (name, request) in request_variants() {
                if name != "seed" && !shape.all_requests {
                    continue;
                }
                let what = format!("{}/{name}/{lane:?}", shape.label);
                let own = with_unshared_reads(|| run_measured(&fixture, lane, &request))?;
                let shared = run_measured(&fixture, lane, &request)?;
                assert_eq!(shared.0, own.0, "{what}: the response changed");
                assert!(shared.1 <= own.1, "{what}: {} -> {} steps", own.1, shared.1);
                compared += 1;
            }
        }
    }
    assert_eq!(compared, expected);
    Ok(())
}

// The same on the novel project, where the Revisions disagree about the
// Scope of the people they share and the Scene scopes come from the
// authority's own read.
#[test]
fn shared_reads_return_the_response_of_reading_per_revision_on_a_novel() -> Result<()> {
    for mode in [ReviewMode::Scene, ReviewMode::Fixed] {
        let novel = novel_fixture(10, 5, mode)?;
        for seed in ["m1", "m2", "m3", "m5", "c01"] {
            let request = request_for(seed, "nir1");
            for lane in [Lane::Reader, Lane::Worker] {
                let what = format!("{}/{seed}/{lane:?}", mode.label());
                let own = with_unshared_reads(|| run_measured(&novel.fixture, lane, &request))?;
                let shared = run_measured(&novel.fixture, lane, &request)?;
                assert_eq!(shared.0, own.0, "{what}");
                assert!(shared.1 < own.1, "{what}: {} -> {} steps", own.1, shared.1);
            }
        }
    }
    Ok(())
}

/// The reads one query makes of each project-level kind, and how many
/// Revisions it evaluated.
fn project_reads_of(
    fixture: &Fixture,
    seed: &str,
    unshared: bool,
) -> Result<(
    usize,
    std::collections::BTreeMap<project_read_probe::Read, usize>,
)> {
    let request = request_for(seed, "nir1");
    // Registration reads the project too (once per edge it validates); only
    // the query itself is counted.
    fixture.authority.db().with_conn(|conn| {
        conn.execute_batch("PRAGMA query_only=OFF")?;
        Ok(())
    })?;
    let mut reader = fixture.worker_reader()?;
    let (response, counts) = project_read_probe::recording(|| {
        if unshared {
            with_unshared_reads(|| {
                reader.query_for_worker_with_maintenance_deadline(&request, DEADLINE)
            })
        } else {
            reader.query_for_worker_with_maintenance_deadline(&request, DEADLINE)
        }
    });
    let response = response?;
    assert_eq!(
        response.status, "available",
        "{seed}: {:?}",
        response.reason
    );
    let revisions = response
        .graph
        .as_ref()
        .expect("an available Graph")
        .nodes
        .iter()
        .flat_map(|node| {
            node.bindings
                .iter()
                .map(|binding| binding.revision_id.clone())
        })
        .collect::<BTreeSet<_>>()
        .len();
    Ok((revisions, counts))
}

// Each project-level read is made once however many Revisions the query
// evaluates, and the registry, the one read whose charge multiplier is a count
// of statements, is charged as many times as it is made
// (`SHARED_REGISTRY_READS`). This counts statements, not rows: the rows a
// statement returns are checked against the charge by
// `a_revision_costs_its_own_rows_and_none_of_the_shared_ones`, and the
// principal Codex rows the Scene-scope extension joins are not charged at all
// (a remaining constraint of the accounting, recorded in the ledger). The
// control is the same query with every Revision reading for itself.
#[test]
fn project_level_reads_are_made_once_and_charged_as_made() -> Result<()> {
    use project_read_probe::Read;
    let novel = novel_fixture(10, 5, ReviewMode::Scene)?;
    // m5 meets 2 Revisions, m1 meets 8.
    let (few, few_reads) = project_reads_of(&novel.fixture, "m5", false)?;
    let (many, many_reads) = project_reads_of(&novel.fixture, "m1", false)?;
    assert!(
        few >= 2 && many >= 8 && many > few,
        "{few} and {many} Revisions"
    );
    let once: BTreeMap<Read, usize> = BTreeMap::from([
        (Read::AuthorityTree, 1),
        (Read::ScopeExtension, 1),
        (Read::RegistryFull, 1),
        (Read::RegistryRow, 1),
        (Read::CurrentEpoch, 1),
        (Read::QueryScene, 1),
        (Read::QueryViewpoint, 1),
    ]);
    assert_eq!(few_reads, once);
    assert_eq!(many_reads, once);
    // The registry is the one read whose charge multiplier is a count of reads:
    // the extension reads it in two statements, and each is charged.
    assert_eq!(
        many_reads[&Read::RegistryFull] + many_reads[&Read::RegistryRow],
        super::super::input::SHARED_REGISTRY_READS
    );

    // The control: reading per Revision repeats every one of them.
    let (many_own, own_reads) = project_reads_of(&novel.fixture, "m1", true)?;
    assert_eq!(many_own, many);
    for read in [
        Read::AuthorityTree,
        Read::ScopeExtension,
        Read::QueryScene,
        Read::QueryViewpoint,
    ] {
        assert!(own_reads[&read] >= many, "{read:?} {}", own_reads[&read]);
    }
    assert!(own_reads[&Read::CurrentEpoch] >= 3 * many);
    assert!(own_reads[&Read::SceneScope] >= 2 * many);
    assert!(
        !own_reads.contains_key(&Read::SceneScope) || !many_reads.contains_key(&Read::SceneScope)
    );
    Ok(())
}

// DR-CQA-6: the shared binding charge is one row per binding because one
// statement loads each binding row (the old 2 counted A3's second load of the
// Scope authority, which is long gone), and that statement no longer joins
// `tree_nodes` (`scene_scope_ownership_tests` checks the statement itself). Whatever else touches the binding table in a query is
// a different read with its own charge: the COUNT and the byte sum that are
// the preflight, and a pinned Scene's two token columns in the Scene join. The
// binding's `version` is named by the extension's statement and, since DR-CQA-8,
// by the preflight's byte sum (the extension returns it), so it counts the
// loads: 2 is one load per query, however many Revisions the query evaluates
// (a second load would make it 3). Counted by what SQLite is asked to
// authorize when each statement is prepared.
#[test]
fn a_query_loads_the_scene_bindings_in_one_statement() -> Result<()> {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use std::sync::{Arc, Mutex};
    let novel = novel_fixture(10, 5, ReviewMode::Scene)?;
    // m1 meets 8 Revisions.
    let request = request_for("m1", "nir1");
    novel.fixture.authority.db().with_conn(|conn| {
        conn.execute_batch("PRAGMA query_only=OFF")?;
        Ok(())
    })?;
    let mut reader = novel.fixture.worker_reader()?;
    let reads = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
    let sink = Arc::clone(&reads);
    novel.fixture.authority.db().with_conn(|conn| {
        conn.authorizer(Some(move |context: AuthContext<'_>| {
            if let AuthAction::Read {
                table_name,
                column_name,
            } = context.action
            {
                sink.lock()
                    .unwrap()
                    .push((table_name.to_owned(), column_name.to_owned()));
            }
            Authorization::Allow
        }))?;
        Ok(())
    })?;
    let response = reader.query_for_worker_with_maintenance_deadline(&request, DEADLINE);
    novel.fixture.authority.db().with_conn(|conn| {
        conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)?;
        Ok(())
    })?;
    let response = response?;
    assert_eq!(response.status, "available", "{:?}", response.reason);
    let reads = reads.lock().unwrap();
    let of = |table: &str, column: &str| {
        reads
            .iter()
            .filter(|(t, c)| t == table && c == column)
            .count()
    };
    // The whole set of reads of the binding table in this query, by column and
    // by the number of statements prepared that name it (a column a statement
    // names twice counts twice). Three statements name the payload columns:
    // the preflight's byte sum (DR-CQA-8: the extension's ten columns and its
    // two joins, so the principal columns and `project_id` as the extension
    // names them), the extension's, and the principals' Codex row count
    // (DR-CQA-7: the extension's two joins, so the two principal columns twice
    // more each and `project_id` three times). A new statement
    // on the table, or a second load, changes this and fails here. The Scene
    // join's two token columns (`scene_incarnation_id`, `source_token` of a
    // pinned Scene) are not in it: this query pins no Scene, and that read has
    // its own charge in `SceneJoinBudget`.
    let on_bindings = reads
        .iter()
        .filter(|(table, _)| table == "narrative_scene_scope_bindings")
        .fold(BTreeMap::<&str, usize>::new(), |mut counts, (_, column)| {
            *counts.entry(column.as_str()).or_default() += 1;
            counts
        });
    assert_eq!(
        on_bindings,
        BTreeMap::from([
            ("audience_json", 8),
            ("compatibility_marker", 2),
            ("knowledge_holder_json", 8),
            ("material_constraint_json", 2),
            ("project_id", 10),
            ("query_identity_json", 2),
            ("scene_id", 3),
            ("scene_incarnation_id", 2),
            ("source_token", 2),
            ("updated_at", 2),
            ("version", 2),
        ])
    );
    assert_eq!(of("narrative_scene_scope_bindings", "version"), 2);
    Ok(())
}

/// Approved Revisions of alice and bob in the seed Scene's own Scope: the
/// seed Revision and `total - 1` more, plus `decoys` reverse-index rows on the
/// seed that name no Revision.
fn budget_fixture(total: usize, decoys: usize) -> Result<Fixture> {
    let fixture = Fixture::new()?;
    let db = fixture.authority.db();
    for serial in 1..total {
        let mut payload = request(db);
        payload.proposal_key = format!("nir1:review:candidate-{serial:04}");
        for entity in &mut payload.bundle.entities {
            entity.scope.reading = exact_scene("a3-source");
            entity.scope.phase = "draft".into();
        }
        crate::narrative_extraction::nir1_entity_relation::tests::rebind_scope_tokens(db, &mut payload)?;
        let created = create_nir1_entity_relation_revision(db, payload)?;
        approve_typed_revision(db, "nir1-run", &created)?;
    }
    if total > 1 {
        publish_graph_index(&fixture.authority)?;
    }
    if decoys > 0 {
        fixture.add_decoys(decoys, "codex:nir1-alice")?;
    }
    Ok(fixture)
}

/// The rows the seed query on `fixture` should be charged, from counts of the
/// stored rows alone (arithmetic, not the product's charge, which
/// `admitted_rows` observes): the reverse-index rows it pages through for
/// alice and bob, each Revision's Entities, Relations and Evidence, its
/// Decision and the Codex rows its Entities name, and, once, the project-level
/// rows the Revisions share (the tree once, the Scene bindings once, the Codex
/// rows their principals name once each, the
/// registry for each of the two reads that make it, the project and the query
/// Scene twice each, its POV and the Epoch).
fn rows_charged_by_the_seed_query(fixture: &Fixture) -> Result<(usize, usize)> {
    fixture.authority.with_read_transaction(|conn| {
        let count = |sql: &str, parameters: &[&dyn rusqlite::ToSql]| -> Result<usize> {
            Ok(usize::try_from(conn.query_row(sql, parameters, |row| row.get::<_, i64>(0))?)?)
        };
        let mut candidates = 0;
        for entity in ["nir1-alice", "nir1-bob"] {
            candidates += count(
                "SELECT COUNT(*) FROM narrative_dependency_edges
                  WHERE project_id=?1 AND source_object_identity=?2",
                &[&PROJECT, &format!("codex:{entity}")],
            )?;
        }
        let mut revisions = 0;
        let mut ids = conn.prepare(
            "SELECT consumer_key FROM narrative_dependency_edges
              WHERE project_id=?1 AND source_object_identity='codex:nir1-alice'
                AND consumer_kind='proposal-revision'",
        )?;
        for revision in ids
            .query_map([PROJECT], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?
        {
            let entities = count(
                "SELECT json_array_length(payload_json,'$.bundle.entities')
                   FROM narrative_proposal_revisions WHERE id=?1",
                &[&revision],
            )?;
            let relations = count(
                "SELECT json_array_length(payload_json,'$.bundle.relations')
                   FROM narrative_proposal_revisions WHERE id=?1",
                &[&revision],
            )?;
            let evidence = count(
                "SELECT COALESCE(SUM(json_array_length(json_extract(entity.value,'$.evidence'))),0)
                   FROM narrative_proposal_revisions r,
                        json_each(json_extract(r.payload_json,'$.bundle.entities')) entity
                  WHERE r.id=?1",
                &[&revision],
            )?;
            let decisions = count(
                "SELECT COUNT(*) FROM narrative_proposal_decisions WHERE revision_id=?1",
                &[&revision],
            )?;
            // The Codex rows the Revision's Entities name (one each here).
            revisions += (entities + relations + evidence) + decisions + entities;
        }
        let tree = count("SELECT COUNT(*) FROM tree_nodes WHERE project_id=?1", &[&PROJECT])?;
        let bindings = count(
            "SELECT COUNT(*) FROM narrative_scene_scope_bindings WHERE project_id=?1",
            &[&PROJECT],
        )?;
        let registry = count(
            "SELECT 1 + json_array_length(timeline_refs_json) + json_array_length(worldline_refs_json)
                    + json_array_length(narrative_layer_refs_json)
               FROM narrative_scope_registries WHERE project_id=?1",
            &[&PROJECT],
        )?;
        let epoch = count(
            "SELECT COUNT(*) FROM (SELECT id FROM narrative_semantic_epochs
                                    WHERE project_id=?1 ORDER BY epoch_number DESC LIMIT 1)",
            &[&PROJECT],
        )?;
        // The Codex rows a binding's holder or audience names, counted from
        // the stored principals (a second way of counting, not the charge's
        // statement): a character of the project, once for each of the two.
        let principals = count(
            "SELECT (SELECT COUNT(*) FROM narrative_scene_scope_bindings b
                       JOIN codex_entries c ON c.project_id=b.project_id AND c.type='character'
                        AND c.id=json_extract(b.knowledge_holder_json,'$.ref')
                      WHERE b.project_id=?1)
                  + (SELECT COUNT(*) FROM narrative_scene_scope_bindings b
                       JOIN codex_entries c ON c.project_id=b.project_id AND c.type='character'
                        AND c.id=json_extract(b.audience_json,'$.ref')
                      WHERE b.project_id=?1)",
            &[&PROJECT],
        )?;
        // project 2 and query Scene 2 (each is read twice in a query: by the
        // authority's load and the Scene's source, and by the Scene's source
        // and its viewpoint), its POV 0 (the fixture's Scene has none)
        let shared = tree + bindings + principals + 2 * registry + 2 + 2 + epoch;
        Ok((candidates + revisions + shared, shared))
    })
}

// The record budget is read/admission 2,048 (proposal/7; one Revision's own 512
// is the writer's and A2's bound, not this one), counted over everything the
// query reads: the rows of the candidates it pages through, of each Revision,
// and the project-level rows of the Revisions once. Exactly 2,048 is admitted
// and 2,049 refuses the whole Graph, wherever the extra row comes from. The
// two are separate tests: the limit's refusal does not stand in for its
// admission.
//
// The worker's reader only: it is the production configuration, whose fixed
// arena replaces the ordinary reader's transient reserve (8 x the raw bytes +
// 4 KiB per row), and that estimate alone is over the 6,291,456 B ledger before
// 2,048 rows, so the ordinary reader refuses for it first. The ordinary reader
// is not a product path.
const BUDGET_REVISIONS: usize = 10;

fn record_budget_query(decoys_over: usize) -> Result<(usize, Nir1GraphResponse)> {
    let (base, shared) = rows_charged_by_the_seed_query(&budget_fixture(BUDGET_REVISIONS, 0)?)?;
    assert!(
        base + 300 < MAX_GRAPH_QUERY_RECORDS,
        "{base} rows to start from"
    );
    let decoys = MAX_GRAPH_QUERY_RECORDS - base + decoys_over;
    let fixture = budget_fixture(BUDGET_REVISIONS, decoys)?;
    let (rows, shared_rows) = rows_charged_by_the_seed_query(&fixture)?;
    assert_eq!(
        rows,
        MAX_GRAPH_QUERY_RECORDS + decoys_over,
        "the fixture is at the boundary"
    );
    assert_eq!(shared_rows, shared);
    let response = run_query(&fixture, Lane::Worker, &request_for("nir1-alice", "nir1"))?;
    Ok((rows, response))
}

#[test]
fn query_records_at_2048_is_available() -> Result<()> {
    let (rows, response) = record_budget_query(0)?;
    assert_eq!(
        response.status, "available",
        "{rows} rows: {:?}",
        response.reason
    );
    let graph = response.graph.as_ref().expect("an available Graph");
    assert_eq!(
        (graph.nodes.len(), graph.edges.len()),
        (2, BUDGET_REVISIONS)
    );
    Ok(())
}

#[test]
fn query_records_at_2049_refuses_the_whole_graph() -> Result<()> {
    let (rows, response) = record_budget_query(1)?;
    assert_eq!(
        response.status, "unavailable",
        "{rows} rows: {:?}",
        response.reason
    );
    assert!(response.graph.is_none());
    assert!(
        response.reason.as_deref().is_some_and(|reason| {
            reason.starts_with("query-worker-work-") && reason.contains("record-limit")
        }),
        "{:?}",
        response.reason
    );
    Ok(())
}

/// The rows the seed query on `fixture` admitted, as the query counted them
/// (`QueryUsage::rows`): the product's own charge.
fn admitted_rows(fixture: &Fixture, lane: Lane) -> Result<usize> {
    LAST_QUERY_ROWS.take();
    let response = run_query(fixture, lane, &request_for("nir1-alice", "nir1"))?;
    assert_eq!(
        response.status, "available",
        "{lane:?}: {:?}",
        response.reason
    );
    LAST_QUERY_ROWS
        .take()
        .ok_or_else(|| anyhow::anyhow!("the query did not record the rows it admitted"))
}

// Ten Revisions evaluated together are charged once for the project-level rows
// they share, not ten times: one more Revision costs its own rows and nothing
// of the project's. Observed on the query itself: the rows it admitted, with 2,
// 6 and 10 Revisions, are the stored rows the Revisions and the shared set add
// up to, and what separates two sizes is the added Revisions' own rows.
#[test]
fn a_revision_costs_its_own_rows_and_none_of_the_shared_ones() -> Result<()> {
    // Per added Revision: 2 reverse-index rows (alice, bob), A2 5, A3 3.
    const OWN_ROWS: usize = 2 + 5 + 3;
    let mut shared_rows = None;
    let mut previous: Option<(usize, usize)> = None;
    for total in [2usize, 6, 10] {
        let fixture = budget_fixture(total, 0)?;
        let (stored, shared) = rows_charged_by_the_seed_query(&fixture)?;
        assert_eq!(*shared_rows.get_or_insert(shared), shared);
        for lane in [Lane::Reader, Lane::Worker] {
            assert_eq!(
                admitted_rows(&fixture, lane)?,
                stored,
                "{lane:?}: {total} Revisions"
            );
        }
        if let Some((fewer, rows)) = previous {
            assert_eq!(
                stored - rows,
                (total - fewer) * OWN_ROWS,
                "{fewer} -> {total} Revisions"
            );
        }
        previous = Some((total, stored));
    }
    assert!(shared_rows.is_some_and(|shared| shared > 0));
    Ok(())
}

// The scope binding of a Scene as the authority's own read validated it is
// the binding a single-Scene read returns, and a Scene whose row fails a
// check fails in both.
#[test]
fn shared_scene_bindings_are_the_ones_single_scene_reads_return() -> Result<()> {
    let novel = novel_fixture(10, 5, ReviewMode::Scene)?;
    let authority = &novel.fixture.authority;
    authority.with_conn(|conn| {
        // A missing row, a row whose token does not match its state and a row
        // naming a character the project does not have.
        conn.execute(
            "DELETE FROM narrative_scene_scope_bindings WHERE scene_id='s003'",
            [],
        )?;
        conn.execute(
            "UPDATE narrative_scene_scope_bindings SET source_token=?1 WHERE scene_id='s004'",
            [format!("sha256:{}", "0".repeat(64))],
        )?;
        conn.execute(
            "UPDATE narrative_scene_scope_bindings
                SET knowledge_holder_json='{\"kind\":\"character\",\"ref\":\"nobody\"}'
              WHERE scene_id='s005'",
            [],
        )?;
        Ok(())
    })?;
    authority.with_read_transaction(|conn| {
        let shared = Nir1ProjectReads::load(conn, PROJECT, "nir1")?;
        let mut compared = Vec::new();
        let mut ids = conn.prepare("SELECT id FROM tree_nodes WHERE project_id=?1")?;
        let mut scenes = ids
            .query_map([PROJECT], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        scenes.push("not-a-node".into());
        for scene in scenes {
            let single = read_narrative_scene_scope(conn, PROJECT, &scene);
            let shared = shared.scene_binding_for_test(&scene);
            match (single, shared) {
                (Ok(single), Ok(shared)) => {
                    assert_eq!(
                        serde_json::to_value(&single.binding)?,
                        serde_json::to_value(&shared)?,
                        "{scene}"
                    );
                    compared.push((scene, true));
                }
                (Err(_), Err(_)) => compared.push((scene, false)),
                (single, shared) => panic!(
                    "{scene}: single-Scene read ok={}, shared ok={}",
                    single.is_ok(),
                    shared.is_ok()
                ),
            }
        }
        // The tampered Scenes, folders and the unknown id fail; the rest read.
        for failing in ["s003", "s004", "s005", "ch00", "not-a-node"] {
            assert!(compared.contains(&(failing.to_owned(), false)), "{failing}");
        }
        for reading in ["s000", "s001", "s002", "s006", "nir1", "a3-source"] {
            assert!(compared.contains(&(reading.to_owned(), true)), "{reading}");
        }
        Ok(())
    })
}

// A live Scope authority that cannot be loaded leaves every Revision
// unavailable as `source-revision-changed`, whether the project-level reads
// were made once or by each Revision. (Registration refuses such a workspace,
// so the A3 evaluation is where this is checked.)
#[test]
fn a_broken_scope_authority_leaves_every_revision_unavailable_shared_or_not() -> Result<()> {
    let fixture = budget_fixture(3, 0)?;
    fixture.authority.with_conn(|conn| {
        // Two live siblings with one persisted sort order: the tree is invalid.
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content, sort_order)
             VALUES ('twin', 'default-project', 'scene', 'Twin', '{}', 'a1')",
            [],
        )?;
        Ok(())
    })?;
    fixture.authority.with_read_transaction(|conn| {
        let shared = Nir1ProjectReads::load(conn, PROJECT, "nir1")?;
        assert!(shared.scene_binding_for_test("nir1").is_err());
        let mut revisions = conn.prepare(
            "SELECT consumer_key FROM narrative_dependency_edges
              WHERE project_id=?1 AND consumer_kind='proposal-revision'
                AND source_object_identity='codex:nir1-alice'",
        )?;
        let revisions = revisions
            .query_map([PROJECT], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert_eq!(revisions.len(), 3);
        for revision in revisions {
            let own = evaluate_nir1_entity_relation_disclosure(conn, PROJECT, &revision, "nir1")?;
            let shared = evaluate_nir1_entity_relation_disclosure_for_graph(
                conn,
                PROJECT,
                &revision,
                "nir1",
                Some(&shared),
            )?;
            match (own, shared) {
                (
                    Nir1EntityRelationDisclosureRead::Unavailable { reason: own },
                    Nir1EntityRelationDisclosureRead::Unavailable { reason: shared },
                ) => {
                    assert_eq!(own, "source-revision-changed");
                    assert_eq!(shared, own);
                }
                other => panic!("an invalid tree qualified a Revision: {other:?}"),
            }
        }
        Ok(())
    })
}

// The same project through the real worker child (its fixed allocator, its own
// connection to the workspace file and the production 100 ms lease): a person
// reviewed Scene by Scene is available there too, and the Graph is the one
// the ordinary reader gives. Seeds: the protagonist (a binding per review it
// appears in), a minor character, and a main character whose Graph is its own
// node only.
#[test]
#[ignore = "requires a built normal worker binary (NIR1_C_QUERY_WORKER_BIN); builds its own project"]
fn native_worker_answers_a_project_reviewed_scene_by_scene() -> Result<()> {
    use super::super::c_query_worker::{CQueryRetirement, CQueryWorkerOwner};
    let novel = novel_fixture(10, 5, ReviewMode::Scene)?;
    let authority = Arc::clone(&novel.fixture.authority);
    let worker_path = PathBuf::from(
        std::env::var_os("NIR1_C_QUERY_WORKER_BIN")
            .ok_or_else(|| anyhow::anyhow!("NIR1_C_QUERY_WORKER_BIN missing"))?,
    );
    let mut expected = Vec::new();
    for seed in ["m1", "c01", "m5"] {
        let response = run_query(&novel.fixture, Lane::Reader, &request_for(seed, "nir1"))?;
        assert_eq!(
            response.status, "available",
            "{seed}: {:?}",
            response.reason
        );
        expected.push((seed, serde_json::to_value(&response)?));
    }

    let native_state = WorkspaceState {
        inner: Mutex::new(Some(ActiveWorkspace::new(Arc::clone(&authority)))),
        safe_mode: crate::recovery::SafeModeState::default(),
        switching: WorkspaceLifecycleCompatibilityView::new(false),
        open_lock: Mutex::new(Default::default()),
    };
    let binding = LiveBinding::new(
        authority.path().to_string_lossy(),
        format!("test-workspace:{}", authority.identity()),
        authority.identity(),
        0,
    )
    .with_main_database_file_identity(authority.main_database_file_identity()?);
    native_state.switching.core().set_ready(binding)?;

    for (seed, expected) in expected {
        let mut owner = CQueryWorkerOwner::new(
            active_workspace_snapshot(&native_state)?,
            worker_path.clone(),
        );
        owner.prepare(PROJECT)?;
        let started = Instant::now();
        let projection =
            owner.query_projected(&request_for(seed, "nir1"), &AtomicBool::new(false))?;
        let call = started.elapsed();
        assert_eq!(owner.retirement(), CQueryRetirement::Retired, "{seed}");
        authority
            .claim_c_query_child()
            .ok_or_else(|| anyhow::anyhow!("{seed}: the retired child kept its claim"))?
            .release();
        drop(owner);
        let admission = projection.elapsed;
        let graph = &projection.graph;
        eprintln!(
            "Native novel project: seed={seed}; call={call:?}; admission={admission:?}; nodes={}; edges={}; bindings={}; scenes={}",
            graph.nodes.len(),
            graph.edges.len(),
            graph.nodes.iter().map(|node| node.bindings.len()).sum::<usize>(),
            graph.scenes.len(),
        );
        assert!(
            admission <= QUERY_DEADLINE,
            "{seed}: the worker lease exceeded the deadline"
        );
        assert_scopes_follow_the_reviews(&novel, graph);
        assert_eq!(
            serde_json::to_value(projection.into_response())?,
            expected,
            "{seed}: the real worker's Graph is not the ordinary reader's"
        );
    }
    assert_eq!(
        native_state
            .switching
            .core()
            .workspace_participant_count()?,
        0
    );
    Ok(())
}

// A node reserves both of its binding Vecs at the query's record limit when it
// is created, so that no later push can grow them. With the limit at 2,048 and
// 50 nodes that is 2,048 x 16 B x 50 = 1,638,400 B up front, 26% of the
// 6,291,456 B ledger, which is unchanged. A node past what the ledger holds is
// refused with the retained-limit marker, not allowed to push the peak over.
#[test]
fn query_retained_reservation_at_2048_stays_within_the_peak_ledger() -> Result<()> {
    let per_node = MAX_GRAPH_QUERY_RECORDS
        * (std::mem::size_of::<Arc<Nir1GraphMaterialBinding>>()
            + std::mem::size_of::<Arc<ScopeBinding>>());
    assert_eq!(per_node, 32_768);
    let worst = MAX_GRAPH_NODES * per_node;
    assert_eq!(worst, 1_638_400);
    assert_eq!(MAX_GRAPH_INPUT_BYTES, 6_291_456);
    assert!(worst * 100 / MAX_GRAPH_INPUT_BYTES <= 26);

    // Fifty nodes, each created with its reservation, fit the ledger.
    let mut nodes = BTreeMap::new();
    let mut usage = QueryUsage::default();
    for index in 0..MAX_GRAPH_NODES {
        add_node(
            &mut nodes,
            &mut usage,
            Arc::new(node_entity(&format!("entity-{index:02}"))),
            1,
            node_binding("r1"),
        )?;
    }
    assert_eq!(nodes.len(), MAX_GRAPH_NODES);
    assert!(usage.retained_bytes >= worst, "{}", usage.retained_bytes);
    assert!(usage.retained_bytes <= MAX_GRAPH_INPUT_BYTES);

    // One byte short of the ledger for the next node: refused, nothing added.
    let mut nodes = BTreeMap::new();
    let mut usage = QueryUsage::default();
    usage.admit_retained(MAX_GRAPH_INPUT_BYTES - per_node)?;
    let error = add_node(
        &mut nodes,
        &mut usage,
        Arc::new(node_entity("entity-over")),
        1,
        node_binding("r1"),
    )
    .expect_err("the reservation does not fit the ledger");
    assert!(
        error.to_string().contains("NIR1_GRAPH_RETAINED_LIMIT"),
        "{error:#}"
    );
    assert!(nodes.is_empty());
    Ok(())
}

// ---------------------------------------------------------------------------
// CQ-LIM-2 (proposal/7): the peak and the frame of the largest casts, and the
// worker's registration of projects with many Revisions.
// ---------------------------------------------------------------------------

// B5: a large cast (8 main and 40 minor, or 12 main and 80 minor characters)
// with 2,000-character summaries over 50 Scenes, the combination proposal/7 did
// not measure. The peak ledger (6,291,456 B, unchanged) may stop a query before
// the counts do; the frame limit (3 MiB) may stop one after. Either is the typed
// refusal of the whole Graph, never a partial one or a crash; a query that is
// answered returns a frame inside the limit. What each seed got is printed for
// the record (DR-CQL-10); time is not a verdict (the lease is long).
#[test]
fn query_large_cast_with_2000_char_summaries_stays_within_peak_and_frame() -> Result<()> {
    use super::super::worker_frame;
    for (mains, minors) in [(8, 40), (12, 80)] {
        let shape = NovelShape {
            mains,
            minors,
            summary_chars: 2000,
        };
        let novel = novel_fixture_shaped(50, 5, ReviewMode::Scene, shape)?;
        let mut reader = novel.fixture.worker_reader()?;
        let mut answered = 0usize;
        for seed in ["m1", "m2", "c01", "m5"] {
            let response = reader.query_for_worker_with_maintenance_deadline(
                &request_for(seed, "nir1"),
                LARGE_N_LEASE,
            )?;
            match response.status {
                "available" => {
                    let frame = worker_frame::encode(&response)?;
                    let graph = response.graph.as_ref().unwrap();
                    eprintln!(
                        "cast {mains}+{minors}, 2000 chars, 50 Scenes, seed {seed}: available, \
                         {} nodes, {} edges, {} bindings, frame {} of {} B",
                        graph.nodes.len(),
                        graph.edges.len(),
                        graph
                            .nodes
                            .iter()
                            .map(|node| node.bindings.len())
                            .sum::<usize>(),
                        frame.len(),
                        worker_frame::FRAME_BYTES,
                    );
                    assert!(frame.len() <= worker_frame::FRAME_BYTES);
                    answered += 1;
                }
                _ => {
                    assert_refused_without_graph(&response);
                    let reason = response.reason.as_deref().unwrap_or_default();
                    eprintln!(
                        "cast {mains}+{minors}, 2000 chars, 50 Scenes, seed {seed}: refused ({reason})"
                    );
                    assert!(
                        !reason.contains("deadline"),
                        "the refusal is a deadline artifact: {reason}"
                    );
                }
            }
        }
        // A seed with a Graph of its own node only is always answered.
        assert!(answered >= 1, "cast {mains}+{minors}: no seed was answered");
    }
    Ok(())
}

// The goal of the proposal/7 limits: on a project of 50 Scenes with one review
// per Scene, every seed a writer reaches for (the main characters m1 to m5 and
// a minor one, c01) is answered, not refused, on the default cast (5 + 15) and
// on both large casts (8 + 40, 12 + 80). The summaries keep their original short
// length: the 2,000-character combination is the looser test above, where the
// peak ledger may refuse. A change that raises the cost of A2 or A3 or of the
// retained estimate until a main character is refused again fails here.
fn assert_fifty_scene_seeds_are_available(mains: usize, minors: usize) -> Result<()> {
    let shape = NovelShape {
        mains,
        minors,
        summary_chars: 0,
    };
    let novel = novel_fixture_shaped(50, 5, ReviewMode::Scene, shape)?;
    let mut reader = novel.fixture.worker_reader()?;
    for seed in ["m1", "m2", "m3", "m4", "m5", "c01"] {
        let response = reader.query_for_worker_with_maintenance_deadline(
            &request_for(seed, "nir1"),
            LARGE_N_LEASE,
        )?;
        assert_eq!(
            response.status, "available",
            "cast {mains}+{minors}, 50 Scenes, seed {seed}: {:?}",
            response.reason
        );
        let graph = response.graph.as_ref().expect("an available Graph");
        assert!(!graph.nodes.is_empty());
    }
    Ok(())
}

#[test]
fn query_fifty_scene_protagonists_are_available_on_the_default_cast() -> Result<()> {
    assert_fifty_scene_seeds_are_available(5, 15)
}

#[test]
fn query_fifty_scene_protagonists_are_available_on_the_8_plus_40_cast() -> Result<()> {
    assert_fifty_scene_seeds_are_available(8, 40)
}

#[test]
fn query_fifty_scene_protagonists_are_available_on_the_12_plus_80_cast() -> Result<()> {
    assert_fifty_scene_seeds_are_available(12, 80)
}

/// A project of `revisions` approved Codex reviews of the same twelve
/// Entities, one per Scene (R2-4's shape: the product's `prepare` path, Japanese
/// summaries of about `total_summary_bytes` across the Entities).
fn same_entity_product_fixture(revisions: usize, total_summary_bytes: usize) -> Result<Fixture> {
    same_entity_product_fixture_with_scenes(revisions, total_summary_bytes, 0)
}

/// [`same_entity_product_fixture`] with `extra_scenes` more bare Scenes
/// (a short id, content `{}`, one Scope binding each) under the same folder.
fn same_entity_product_fixture_with_scenes(
    revisions: usize,
    total_summary_bytes: usize,
    extra_scenes: usize,
) -> Result<Fixture> {
    same_entity_product_fixture_with_shaped_scenes(
        revisions,
        total_summary_bytes,
        extra_scenes,
        SceneShape::default(),
    )
}

/// What the extra Scenes of a product fixture look like around them: the bare
/// shape (every Scene under one folder, readers as principals) is the
/// smallest project a Scene count can describe; a real manuscript has folders
/// and notes in its tree, and binds characters as a Scene's holder and
/// audience (DR-CQA-7).
#[derive(Clone, Copy, Default)]
struct SceneShape {
    /// A folder for every ten extra Scenes (the Scenes under it) and a note
    /// under the folder for each extra Scene: the tree has about 2.1 nodes per
    /// Scene.
    folders_and_notes: bool,
    /// Every extra Scene's knowledge holder and audience are characters of the
    /// project: two Codex rows per binding for the extension to read (the
    /// worst case of the principal rows the shared-read charge counts).
    character_principals: bool,
    /// The ids of the extra Scenes, and of the folders and notes around them,
    /// are UUIDs (36 bytes), as the product mints them; the sort keys are
    /// short, as the product's are. The other shapes keep a short id.
    uuid_ids: bool,
}

impl SceneShape {
    /// The id of the `kind` (0 folder, 1 Scene, 2 note) numbered `number`.
    fn id(self, kind: u8, number: usize, short: String) -> String {
        if self.uuid_ids {
            uuid::Uuid::from_u128((u128::from(kind) << 96) | (number as u128 + 1)).to_string()
        } else {
            short
        }
    }

    /// The sort key of an id: the id itself in the short shapes.
    fn sort_key(self, kind: u8, number: usize, id: &str) -> String {
        if self.uuid_ids {
            format!("a{kind}s{number:05}")
        } else {
            id.to_owned()
        }
    }
}

/// [`same_entity_product_fixture_with_scenes`] with the extra Scenes in a
/// [`SceneShape`].
fn same_entity_product_fixture_with_shaped_scenes(
    revisions: usize,
    total_summary_bytes: usize,
    extra_scenes: usize,
    shape: SceneShape,
) -> Result<Fixture> {
    use crate::narrative_extraction::nir1_entity_relation::prepare_nir1_entity_relation_revision;
    use crate::narrative_extraction::Nir1EntityRelationRevisionPrepareRequest;
    let entity_count = 12usize;
    let per_entity_chars = (total_summary_bytes / entity_count / 3).max(1);
    let directory = TestDirectory(
        std::env::temp_dir().join(format!("nir1-cq-lim-product-{}", uuid::Uuid::new_v4())),
    );
    std::fs::create_dir_all(&directory.0)?;
    let db = crate::Database::new(&directory.0.join("grimodex.db"))?;
    db.migrate()?;
    seed_run_and_catalog(&db)?;
    prepare_a3_scope_fixture(&db)?;
    let scene_ids: Vec<String> = (0..revisions).map(|n| format!("s{n:03}")).collect();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content, sort_order)
             VALUES ('ch00', 'default-project', 'folder', 'ch00', '{}', 'a0c00')",
            [],
        )?;
        for scene_id in &scene_ids {
            conn.execute(
                "INSERT INTO tree_nodes
                    (id, project_id, parent_id, node_type, title, content, sort_order)
                 VALUES (?1, 'default-project', 'ch00', 'scene', ?1, '{}', ?1)",
                [scene_id],
            )?;
            crate::narrative_extraction::ensure_scene_scope_binding_in_tx(
                conn,
                PROJECT,
                scene_id,
                "2026-09-17T00:00:00.000Z",
                crate::narrative_extraction::SceneScopeInit::UnknownRepairOrRestore,
            )?;
        }
        let mut parent = String::from("ch00");
        for extra in 0..extra_scenes {
            if shape.folders_and_notes && extra % 10 == 0 {
                parent = shape.id(0, extra, format!("f{extra:05}"));
                conn.execute(
                    "INSERT INTO tree_nodes (id, project_id, node_type, title, content, sort_order)
                     VALUES (?1, 'default-project', 'folder', ?1, '{}', ?2)",
                    params![parent, format!("a1c{extra:05}")],
                )?;
            }
            let scene_id = shape.id(1, extra, format!("x{extra:05}"));
            conn.execute(
                "INSERT INTO tree_nodes
                    (id, project_id, parent_id, node_type, title, content, sort_order)
                 VALUES (?1, 'default-project', ?2, 'scene', ?1, '{}', ?3)",
                params![scene_id, parent, shape.sort_key(1, extra, &scene_id)],
            )?;
            if shape.folders_and_notes {
                let note_id = shape.id(2, extra, format!("n{extra:05}"));
                conn.execute(
                    "INSERT INTO tree_nodes
                        (id, project_id, parent_id, node_type, title, content, sort_order)
                     VALUES (?1, 'default-project', ?2, 'note', ?1, '{}', ?3)",
                    params![note_id, parent, format!("z{extra:05}")],
                )?;
            }
            crate::narrative_extraction::ensure_scene_scope_binding_in_tx(
                conn,
                PROJECT,
                &scene_id,
                "2026-09-17T00:00:00.000Z",
                crate::narrative_extraction::SceneScopeInit::UnknownRepairOrRestore,
            )?;
            if shape.character_principals {
                let read = read_narrative_scene_scope(conn, PROJECT, &scene_id)?;
                let mut binding = read.binding;
                binding.knowledge_holder = NarrativeScopePrincipalV1::Character {
                    reference: format!("v{:02}", extra % entity_count),
                };
                binding.audience = NarrativeScopePrincipalV1::Character {
                    reference: format!("v{:02}", (extra + 1) % entity_count),
                };
                binding.source_token =
                    grimodex_core::narrative_scene_scope::source_token(&read.registry, &binding)?;
                conn.execute(
                    "UPDATE narrative_scene_scope_bindings
                        SET knowledge_holder_json=?1, audience_json=?2, source_token=?3
                      WHERE project_id=?4 AND scene_id=?5",
                    params![
                        serde_json::to_string(&binding.knowledge_holder)?,
                        serde_json::to_string(&binding.audience)?,
                        binding.source_token,
                        PROJECT,
                        scene_id
                    ],
                )?;
            }
        }
        let body: String = "物語".repeat(per_entity_chars / 2 + 1);
        for index in 0..entity_count {
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name, summary, updated_at)
                 VALUES (?1, 'default-project', 'character', ?2, ?3, '2026-09-12T00:00:00Z')",
                params![
                    format!("v{index:02}"),
                    format!("人物{index:02}"),
                    format!("{index:02}{body}")
                ],
            )?;
        }
        for index in 1..entity_count {
            conn.execute(
                "INSERT INTO codex_relations
                    (id, project_id, from_codex_id, to_codex_id, relation_type,
                     directionality, version, updated_at)
                 VALUES (?1, 'default-project', 'v00', ?2, 'knows', 'symmetric', 1,
                         '2026-09-12T00:00:00Z')",
                params![format!("rv-{index:02}"), format!("v{index:02}")],
            )?;
        }
        Ok(())
    })?;
    let mut first_revision = String::new();
    for (ordinal, scene_id) in scene_ids.iter().enumerate() {
        explicit_scope(&db, scene_id, ordinal)?;
        drain_freshness(&db)?;
        let prepared = prepare_nir1_entity_relation_revision(
            &db,
            Nir1EntityRelationRevisionPrepareRequest {
                project_id: PROJECT.into(),
                scene_id: scene_id.clone(),
                proposal_key: Some(format!("codex-ui:selection:cq-lim-product-{ordinal}")),
                entity_ids: (0..entity_count)
                    .map(|index| format!("v{index:02}"))
                    .collect(),
                relation_ids: (1..entity_count)
                    .map(|index| format!("rv-{index:02}"))
                    .collect(),
            },
        )?;
        let run_id = prepared["runId"].as_str().unwrap().to_owned();
        let revision = prepared["result"]["revisionId"]
            .as_str()
            .unwrap()
            .to_owned();
        approve_typed_revision(
            &db,
            &run_id,
            &serde_json::json!({
                "proposalId": prepared["result"]["proposalId"],
                "revisionId": revision,
            }),
        )?;
        if first_revision.is_empty() {
            first_revision = revision;
        }
    }
    drain_freshness(&db)?;
    let authority = WorkspaceAuthority::from_database_for_test(db, directory.0.clone())?;
    publish_graph_index(&authority)?;
    Ok(Fixture {
        authority,
        lifecycle: WorkspaceLifecycleCore::new(),
        revision: first_revision,
        _directory: directory,
    })
}

// The floor of a one-Revision project: the number of bound Scenes at which no
// seed gets a Graph, on the worker's configuration run in process (the
// admission it measures is the code the worker runs). What the shared reads
// charge, once per query (DR-CQA-6 and DR-CQA-7): one row per tree node (every
// node, folders and notes too: the authority reads them all), one per binding,
// one per Codex row a binding's holder or audience makes the extension read, two
// per registry reference, two each for the project row and the query Scene's
// row (the query reads each twice) and the Epoch; the Revision's 37 + 13 rows and the
// candidate rows after its first Revision come on top. At N Scenes the project
// is available; at N + 1 the candidate page no longer fits and the Graph is
// refused, whole, with `candidate-record-limit`.
//
// | shape | before DR-CQA-6 | DR-CQA-6 | now |
// |---|---:|---:|---:|
// | bare (a tree of Scenes, readers) | 489 | 652 | BARE_FLOOR_SCENES |
// | folders and notes | 316 | 377 | FOLDERS_AND_NOTES_FLOOR_SCENES |
// | every principal a character | 489 | 652 | CHARACTER_PRINCIPALS_FLOOR_SCENES |
const BARE_FLOOR_SCENES: usize = 978;
const FOLDERS_AND_NOTES_FLOOR_SCENES: usize = 632;
const CHARACTER_PRINCIPALS_FLOOR_SCENES: usize = 491;

fn floor_query(shape: SceneShape, total_scenes: usize) -> Result<Nir1GraphResponse> {
    floor_query_of(1, shape, total_scenes)
}

/// The Scenes a product fixture has bound before the extra ones: three of its
/// own and one for each Revision.
const fn fixture_scenes(revisions: usize) -> usize {
    3 + revisions
}

/// [`floor_query`] on a project of `revisions` approved Revisions (each of the
/// 300 kB summaries the floors use), `total_scenes` bound Scenes in all.
fn floor_query_of(
    revisions: usize,
    shape: SceneShape,
    total_scenes: usize,
) -> Result<Nir1GraphResponse> {
    let fixture = same_entity_product_fixture_with_shaped_scenes(
        revisions,
        300_000,
        total_scenes - fixture_scenes(revisions),
        shape,
    )?;
    let (scenes, nodes, principal_rows) = fixture.authority.with_conn(|conn| {
        let count =
            |sql: &str| -> Result<i64> { Ok(conn.query_row(sql, [PROJECT], |row| row.get(0))?) };
        Ok((
            count("SELECT COUNT(*) FROM narrative_scene_scope_bindings WHERE project_id=?1")?,
            count("SELECT COUNT(*) FROM tree_nodes WHERE project_id=?1")?,
            count(crate::narrative_extraction::scene_scope::SCOPE_EXTENSION_PRINCIPAL_ROWS_SQL)?,
        ))
    })?;
    assert_eq!(usize::try_from(scenes)?, total_scenes);
    // The shape is what it says: a shape that silently became bare would pass
    // as a different floor.
    let extra = i64::try_from(total_scenes - fixture_scenes(revisions))?;
    assert_eq!(
        principal_rows,
        if shape.character_principals {
            2 * extra
        } else {
            0
        },
        "principal rows"
    );
    if shape.folders_and_notes {
        // a note for each extra Scene, besides the Scenes themselves
        assert!(
            nodes >= scenes + extra,
            "{nodes} tree nodes for {scenes} Scenes"
        );
    }
    let mut reader = fixture.worker_reader()?;
    reader.query_for_worker_with_maintenance_deadline(&request_for("v00", "nir1"), LARGE_N_LEASE)
}

fn shape_from_env() -> SceneShape {
    let shape = std::env::var("CQ_FLOOR_SHAPE").unwrap_or_default();
    SceneShape {
        folders_and_notes: shape.contains("folders"),
        character_principals: shape.contains("characters"),
        uuid_ids: shape.contains("uuid"),
    }
}

#[test]
#[ignore = "DR-CQA-6/7/8 measurement: bisects the floor of the project (CQ_FLOOR_LO, CQ_FLOOR_HI, CQ_FLOOR_REVISIONS, CQ_FLOOR_SHAPE=folders+characters+uuid, CQ_FLOOR_LEGACY=1 for the bytes before DR-CQA-8)"]
fn measure_the_floor() -> Result<()> {
    let env = |name: &str, default: usize| {
        std::env::var(name)
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(default)
    };
    let shape = shape_from_env();
    let revisions = env("CQ_FLOOR_REVISIONS", 1);
    let legacy = env("CQ_FLOOR_LEGACY", 0) == 1;
    let query = |total: usize| -> Result<Nir1GraphResponse> {
        if legacy {
            super::input::with_legacy_shared_bytes(|| floor_query_of(revisions, shape, total))
        } else {
            floor_query_of(revisions, shape, total)
        }
    };
    let (mut lo, mut hi) = (env("CQ_FLOOR_LO", 400), env("CQ_FLOOR_HI", 1200));
    assert_eq!(query(lo)?.status, "available");
    assert_eq!(query(hi)?.status, "unavailable");
    while hi - lo > 1 {
        let mid = (lo + hi) / 2;
        let response = query(mid)?;
        eprintln!("FLOOR {mid}: {} {:?}", response.status, response.reason);
        if response.status == "available" {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    eprintln!("FLOOR largest available = {lo}");
    let over = query(lo + 1)?;
    eprintln!("FLOOR refused at {}: {:?}", lo + 1, over.reason);
    Ok(())
}

/// What the shared reads charge in bytes for a project of `CQ_FLOOR_SCENES`
/// bound Scenes in `CQ_FLOOR_SHAPE`, after DR-CQA-8 and before it, and what
/// the charge is per Scene (the slope of the wall the charge makes).
#[test]
#[ignore = "DR-CQA-8 measurement: prints the shared bytes of a project (CQ_FLOOR_SCENES, CQ_FLOOR_REVISIONS, CQ_FLOOR_SHAPE)"]
fn measure_the_shared_bytes() -> Result<()> {
    let env = |name: &str, default: usize| {
        std::env::var(name)
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(default)
    };
    let shape = shape_from_env();
    let revisions = env("CQ_FLOOR_REVISIONS", 1);
    let scenes = env("CQ_FLOOR_SCENES", 400);
    let fixture = same_entity_product_fixture_with_shaped_scenes(
        revisions,
        300_000,
        scenes - fixture_scenes(revisions),
        shape,
    )?;
    let charged = |legacy: bool| -> Result<(usize, usize)> {
        fixture.authority.with_conn(|conn| {
            let run = || {
                super::input::preflight_project_reads(
                    conn,
                    PROJECT,
                    "nir1",
                    MAX_GRAPH_QUERY_RECORDS,
                    MAX_GRAPH_INPUT_BYTES,
                )
            };
            let admission = if legacy {
                super::input::with_legacy_shared_bytes(run)
            } else {
                run()
            }?;
            Ok((admission.rows, admission.bytes))
        })
    };
    let (rows, now) = charged(false)?;
    let (_, before) = charged(true)?;
    eprintln!(
        "SHARED scenes={scenes} revisions={revisions} rows={rows} bytes_now={now} \
         bytes_before={before} per_scene_now={:.1} per_scene_before={:.1}",
        now as f64 / scenes as f64,
        before as f64 / scenes as f64
    );
    Ok(())
}

/// DR-CQA-7, observed on the query itself: what the shared reads charge for
/// the same Scenes in other shapes. A tree node is one row (a folder and a note
/// per Scene add their rows, once), and the two principals of a binding that
/// name characters of the project add one row each (the Codex rows the
/// extension's joins read). The rows are counted by the query's own admission
/// (`QueryUsage::rows`), not by a helper.
#[test]
fn the_tree_and_the_principals_codex_rows_are_charged_once_each() -> Result<()> {
    const EXTRA: usize = 20;
    let rows = |shape: SceneShape| -> Result<usize> {
        let fixture = same_entity_product_fixture_with_shaped_scenes(1, 300_000, EXTRA, shape)?;
        LAST_QUERY_ROWS.take();
        let response = fixture
            .worker_reader()?
            .query_for_worker_with_maintenance_deadline(
                &request_for("v00", "nir1"),
                LARGE_N_LEASE,
            )?;
        assert_eq!(response.status, "available", "{:?}", response.reason);
        LAST_QUERY_ROWS
            .take()
            .ok_or_else(|| anyhow::anyhow!("the query did not record the rows it admitted"))
    };
    let bare = rows(SceneShape::default())?;
    let characters = rows(SceneShape {
        character_principals: true,
        ..SceneShape::default()
    })?;
    // two principals for each of the extra Scenes' bindings, and no other change
    assert_eq!(characters - bare, 2 * EXTRA);
    let folders = rows(SceneShape {
        folders_and_notes: true,
        ..SceneShape::default()
    })?;
    // a note for each extra Scene and a folder for every ten of them, one row
    // each (the tree was charged twice before DR-CQA-7)
    assert_eq!(folders - bare, EXTRA + EXTRA / 10);
    Ok(())
}

/// DR-CQA-7 measurement: the SQL VM steps the principals' Codex row count adds
/// at the floor of the bare project, next to the statements already in the
/// preflight (counted by a progress handler called once per VM instruction).
#[test]
#[ignore = "DR-CQA-7 measurement: prints the VM steps of the principal rows statement"]
fn measure_the_principal_rows_statement_steps() -> Result<()> {
    for (label, shape) in [
        ("bare", SceneShape::default()),
        (
            "characters",
            SceneShape {
                character_principals: true,
                ..SceneShape::default()
            },
        ),
    ] {
        let floor = if shape.character_principals {
            CHARACTER_PRINCIPALS_FLOOR_SCENES
        } else {
            BARE_FLOOR_SCENES
        };
        let fixture = same_entity_product_fixture_with_shaped_scenes(1, 300_000, floor - 4, shape)?;
        fixture.authority.with_conn(|conn| {
            let steps = |sql: &str| -> Result<(u64, i64)> {
                let counter = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
                let seen = std::sync::Arc::clone(&counter);
                conn.progress_handler(
                    1,
                    Some(move || {
                        seen.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        false
                    }),
                )?;
                let value = conn.query_row(sql, [PROJECT], |row| row.get::<_, i64>(0));
                conn.progress_handler(1, None::<fn() -> bool>)?;
                Ok((counter.load(std::sync::atomic::Ordering::Relaxed), value?))
            };
            let (p_steps, p) =
                steps(crate::narrative_extraction::scene_scope::SCOPE_EXTENSION_PRINCIPAL_ROWS_SQL)?;
            let (b_steps, b) =
                steps("SELECT COUNT(*) FROM narrative_scene_scope_bindings WHERE project_id=?1")?;
            let (t_steps, t) = steps("SELECT COUNT(*) FROM tree_nodes WHERE project_id=?1")?;
            eprintln!(
                "STEPS {label}: scenes {floor}: principal rows statement {p_steps} steps (P={p}); binding COUNT {b_steps} steps ({b}); tree COUNT {t_steps} steps ({t}); QUERY_SQL_STEPS {QUERY_SQL_STEPS}"
            );
            Ok(())
        })?;
    }
    Ok(())
}

/// N is available and N + 1 is refused for exactly the candidate page's
/// records, whole (no partial Graph).
fn assert_floor(shape: SceneShape, floor: usize) -> Result<()> {
    let at = floor_query(shape, floor)?;
    assert_eq!(at.status, "available", "{floor}: {:?}", at.reason);
    let over = floor_query(shape, floor + 1)?;
    assert_eq!(
        over.status,
        "unavailable",
        "{}: {:?}",
        floor + 1,
        over.reason
    );
    assert!(over.graph.is_none());
    assert_eq!(
        over.reason.as_deref(),
        Some(
            "query-worker-work-candidate-record-limit-pre-cleanup-work-failed-candidate-record-limit"
        ),
        "refused for the candidate page's records, not for the shared reads' (disclosure-record-limit)"
    );
    Ok(())
}

#[test]
fn the_floor_of_a_bare_one_revision_project_is_n_available_and_n_plus_1_refused() -> Result<()> {
    assert_floor(SceneShape::default(), BARE_FLOOR_SCENES)
}

#[test]
fn the_floor_with_folders_and_notes_is_n_available_and_n_plus_1_refused() -> Result<()> {
    assert_floor(
        SceneShape {
            folders_and_notes: true,
            ..SceneShape::default()
        },
        FOLDERS_AND_NOTES_FLOOR_SCENES,
    )
}

#[test]
fn the_floor_with_character_principals_is_n_available_and_n_plus_1_refused() -> Result<()> {
    assert_floor(
        SceneShape {
            character_principals: true,
            ..SceneShape::default()
        },
        CHARACTER_PRINCIPALS_FLOOR_SCENES,
    )
}

// The floor of four Revisions (p4:300000: four approved Revisions of 300 kB
// summaries, each Scene's Revision on its own Scene). The rows are not what
// stops it (they would, at about 850 Scenes); the peak ledger is: the A2
// inputs of the four Revisions take most of its 6,291,456 bytes and the shared
// reads' bytes, one charge for each Scene, take the rest. So the wall follows
// the bytes the shared reads charge (DR-CQA-8): 352 when they were counted as
// before (the tree and the bindings twice, columns the reads do not return),
// 733 now. At N + 1 the refusal is the ledger's, which the worker's frame
// reports as `other` (the same reason as before DR-CQA-8: the ledger has no
// reason of its own). This runs in-process with a 10 s lease
// (`LARGE_N_LEASE`), so it decides the ledger's wall only; the production
// lease is 100 ms, and the wall it sets in practice (716 to 726 Scenes, a
// measurement of the real worker) is a separate one that this test does not
// see.
const FOUR_REVISIONS_FLOOR_BEFORE_DR_CQA_8: usize = 352;
const FOUR_REVISIONS_FLOOR_SCENES: usize = 733;
const PEAK_LEDGER_REFUSAL: &str = "query-worker-work-other-pre-cleanup-work-failed-other";

fn assert_four_revisions_floor(floor: usize, legacy: bool) -> Result<()> {
    let query = |scenes: usize| -> Result<Nir1GraphResponse> {
        if legacy {
            super::input::with_legacy_shared_bytes(|| {
                floor_query_of(4, SceneShape::default(), scenes)
            })
        } else {
            floor_query_of(4, SceneShape::default(), scenes)
        }
    };
    let at = query(floor)?;
    assert_eq!(at.status, "available", "{floor}: {:?}", at.reason);
    let over = query(floor + 1)?;
    assert_eq!(over.status, "unavailable", "{}: {:?}", floor + 1, over.reason);
    assert!(over.graph.is_none());
    assert_eq!(over.reason.as_deref(), Some(PEAK_LEDGER_REFUSAL));
    Ok(())
}

#[test]
fn the_floor_of_four_revisions_is_n_available_and_n_plus_1_refused() -> Result<()> {
    assert_four_revisions_floor(FOUR_REVISIONS_FLOOR_SCENES, false)
}

#[test]
fn the_floor_of_four_revisions_with_the_bytes_counted_as_before_is_352() -> Result<()> {
    assert_four_revisions_floor(FOUR_REVISIONS_FLOOR_BEFORE_DR_CQA_8, true)
}

// B3 (in-process): projects with several product-shaped Revisions register on
// the worker's configuration, whether the twelve Entities are the same in every
// Revision or differ from Scene to Scene (the novel project's cast). Every
// Revision is inside the registration's limit, so the registration admits them
// all and a query that reaches them is answered or refused by its own limits.
#[test]
fn worker_registers_projects_of_several_product_shaped_revisions() -> Result<()> {
    let same = same_entity_product_fixture(4, 300_000)?;
    let mut reader = same.worker_reader()?;
    let response = worker_query_large(&mut reader, "v00")?;
    assert_eq!(response.status, "available", "{:?}", response.reason);
    let varying = novel_fixture(30, 5, ReviewMode::Scene)?;
    let mut reader = varying.fixture.worker_reader()?;
    for seed in ["m1", "c01", "m5"] {
        let response = reader.query_for_worker_with_maintenance_deadline(
            &request_for(seed, "nir1"),
            LARGE_N_LEASE,
        )?;
        assert_eq!(
            response.status, "available",
            "{seed}: {:?}",
            response.reason
        );
    }
    Ok(())
}

// B3 (real worker): the same projects reach READY on the real worker's Q 16 MiB,
// the product-shaped Revisions of 948,772 B (four of them), of the limit's
// 2,094,880 B (two of them), and the 30 Scenes whose casts differ. The query
// that follows is the 100 ms production lease and a large project's protagonist
// can miss it, so the verdict here is the registration (READY) and a seed whose
// Graph is its own pair; what the protagonist query got is printed.
#[test]
#[ignore = "requires a built normal worker binary (NIR1_C_QUERY_WORKER_BIN); builds its own projects"]
fn native_worker_registers_multiple_product_shaped_revisions() -> Result<()> {
    let projects: Vec<(&str, Fixture, &str)> = vec![
        (
            "4 same-Entity reviews of 948,772 B",
            same_entity_product_fixture(4, 300_000)?,
            "v00",
        ),
        (
            "2 same-Entity reviews of 2,094,880 B",
            same_entity_product_fixture(2, 682_000)?,
            "v00",
        ),
        (
            "30 Scenes with differing casts",
            novel_fixture(30, 5, ReviewMode::Scene)?.fixture,
            "x1",
        ),
    ];
    for (label, fixture, seed) in &projects {
        with_real_worker(fixture, |owner| {
            owner.prepare(PROJECT)?;
            let request = request_for(seed, "nir1");
            match owner.query_once(&request) {
                Ok(lease) => {
                    let frame = lease.frame()?;
                    let graph = frame
                        .graph()
                        .map(|graph| (graph.node_count(), graph.edge_count()));
                    eprintln!("{label}: READY; seed {seed} answered {graph:?}");
                    drop(lease);
                }
                Err(error) => eprintln!("{label}: READY; seed {seed} refused: {error:#}"),
            }
            Ok(())
        })?;
    }
    Ok(())
}

// DI-1a (DR-DI1A-5b): what D-final's wait for a READY costs. A rebuild after a
// capture's commit is a new worker child's `prepare` (S0 stamp, spawn,
// registration) followed by one query; this prints each repetition's two
// durations for a typical project and for projects near the practical
// capacity, so the budget W of the wait is chosen from measurements. It
// asserts nothing about time: W is a decision, the numbers are its evidence.
// Run it with a built normal worker (NIR1_C_QUERY_WORKER_BIN).
#[test]
#[ignore = "requires a built normal worker binary (NIR1_C_QUERY_WORKER_BIN); prints timings; builds its own projects"]
fn native_worker_rebuild_cost_for_the_d_final_wait() -> Result<()> {
    const REPETITIONS: usize = 10;
    let projects: Vec<(&str, Fixture, &str)> = vec![
        (
            "novel 10 scenes",
            novel_fixture(10, 5, ReviewMode::Scene)?.fixture,
            "m1",
        ),
        (
            "2 same-Entity reviews of 2,094,880 B",
            same_entity_product_fixture(2, 682_000)?,
            "v00",
        ),
        (
            "30 scenes with differing casts",
            novel_fixture(30, 5, ReviewMode::Scene)?.fixture,
            "x1",
        ),
    ];
    for (label, fixture, seed) in &projects {
        let mut prepares = Vec::new();
        let mut queries = Vec::new();
        for _ in 0..REPETITIONS {
            with_real_worker(fixture, |owner| {
                let started = Instant::now();
                owner.prepare(PROJECT)?;
                prepares.push(started.elapsed());
                let started = Instant::now();
                let outcome =
                    owner.query_projected(&request_for(seed, "nir1"), &AtomicBool::new(false));
                queries.push(started.elapsed());
                if let Err(error) = outcome {
                    eprintln!("{label}: the query was refused: {error:#}");
                }
                let _ = owner.retirement();
                Ok(())
            })?;
        }
        prepares.sort();
        queries.sort();
        let ms = |durations: &[Duration]| {
            durations
                .iter()
                .map(|duration| format!("{:.1}", duration.as_secs_f64() * 1000.0))
                .collect::<Vec<_>>()
                .join(",")
        };
        eprintln!(
            "W-measurement project=\"{label}\" n={REPETITIONS} prepare_ms=[{}] query_ms=[{}]",
            ms(&prepares),
            ms(&queries)
        );
    }
    Ok(())
}

// DR-CQA-8: what the shared reads charge in bytes is what the query's reads
// return, once for each time a statement runs. Two checks that do not use the
// preflight's SQL:
//
// - the charge equals the length of every value a read returns, summed here
//   in Rust over the statements the query makes (the registry's two, the
//   Scene source's and the POV's two, the principals' Codex rows decided by the
//   binding's own JSON), on a project with folders, notes, UUID ids,
//   character principals and a POV;
// - the columns that one `Nir1ProjectReads::load` makes SQLite authorize are
//   pinned, so a read this charge does not know (a column added, a statement
//   run twice) changes the pin and fails here.

/// The length of every value `sql` returns: text and blob by byte length, an
/// integer by its text, NULL as 0.
fn returned_bytes(
    conn: &rusqlite::Connection,
    sql: &str,
    parameters: &[&dyn rusqlite::ToSql],
) -> Result<usize> {
    use rusqlite::types::Value;
    let mut statement = conn.prepare(sql)?;
    let columns = statement.column_count();
    let mut rows = statement.query(parameters)?;
    let mut total = 0usize;
    while let Some(row) = rows.next()? {
        for column in 0..columns {
            total += match row.get::<_, Value>(column)? {
                Value::Null => 0,
                Value::Integer(value) => value.to_string().len(),
                Value::Real(value) => value.to_string().len(),
                Value::Text(value) => value.len(),
                Value::Blob(value) => value.len(),
            };
        }
    }
    Ok(total)
}

/// The bytes the shared reads of one query return, summed statement by
/// statement as the code makes them.
fn shared_bytes_returned(conn: &rusqlite::Connection, scene: &str) -> Result<usize> {
    let project: &dyn rusqlite::ToSql = &PROJECT;
    let scene_id: &dyn rusqlite::ToSql = &scene;
    let mut total = 0usize;
    // the authority's tree
    total += returned_bytes(
        conn,
        "SELECT id, parent_id, node_type, sort_order, story_time_order, archived_at
           FROM tree_nodes WHERE project_id = ?1",
        &[project],
    )?;
    // the registry: the whole row, then its version row
    total += returned_bytes(
        conn,
        "SELECT registry_version, timeline_refs_json, worldline_refs_json,
                narrative_layer_refs_json, version, source_token
           FROM narrative_scope_registries WHERE project_id = ?1",
        &[project],
    )?;
    total += returned_bytes(
        conn,
        "SELECT version, source_token, updated_at
           FROM narrative_scope_registries WHERE project_id = ?1",
        &[project],
    )?;
    // the Scene bindings, and the Codex row each character principal names
    total += returned_bytes(
        conn,
        "SELECT scene_id, scene_incarnation_id, compatibility_marker, query_identity_json,
                material_constraint_json, knowledge_holder_json, version, audience_json,
                source_token, updated_at
           FROM narrative_scene_scope_bindings WHERE project_id = ?1",
        &[project],
    )?;
    let mut principals = conn.prepare(
        "SELECT knowledge_holder_json, audience_json
           FROM narrative_scene_scope_bindings WHERE project_id = ?1",
    )?;
    let pairs = principals
        .query_map([PROJECT], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (holder, audience) in pairs {
        for principal in [holder, audience] {
            // The product's join does not look at `kind`: it names a Codex row by
            // the principal's `$.ref` and the row's own `type = 'character'`
            // (`scope_extension_principal_joins!`). So do not filter on `kind`
            // here; a ref that names no character row returns nothing below.
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&principal) else {
                continue;
            };
            let Some(reference) = value.get("ref").and_then(|reference| reference.as_str()) else {
                continue;
            };
            let reference = reference.to_owned();
            total += returned_bytes(
                conn,
                "SELECT id FROM codex_entries
                  WHERE id = ?1 AND project_id = ?2 AND type = 'character'",
                &[&reference, project],
            )?;
        }
    }
    // the project's phase mode, the query Scene's source and its POV
    total += returned_bytes(
        conn,
        "SELECT phase_resolution_mode FROM projects WHERE id = ?1",
        &[project],
    )?;
    total += returned_bytes(
        conn,
        "SELECT version, updated_at, content, archived_at FROM tree_nodes
          WHERE project_id = ?1 AND id = ?2 AND node_type = 'scene'",
        &[project, scene_id],
    )?;
    total += returned_bytes(
        conn,
        "SELECT pov_character_id FROM tree_nodes
          WHERE project_id = ?1 AND id = ?2 AND node_type = 'scene'",
        &[project, scene_id],
    )?;
    let pov: Option<String> = conn.query_row(
        "SELECT pov_character_id FROM tree_nodes WHERE project_id = ?1 AND id = ?2",
        params![PROJECT, scene],
        |row| row.get(0),
    )?;
    if let Some(pov) = pov {
        total += returned_bytes(
            conn,
            "SELECT type FROM codex_entries
              WHERE id = ?1 AND project_id = ?2 AND context_mode NOT IN ('hidden', 'suppress')",
            &[&pov, project],
        )?;
    }
    // the latest Epoch
    total += returned_bytes(
        conn,
        "SELECT id, epoch_number, reason, created_at FROM narrative_semantic_epochs
          WHERE project_id = ?1 ORDER BY epoch_number DESC LIMIT 1",
        &[project],
    )?;
    Ok(total)
}

#[test]
fn shared_bytes_equal_what_the_reads_return_on_a_product_project() -> Result<()> {
    let shape = SceneShape {
        folders_and_notes: true,
        character_principals: true,
        uuid_ids: true,
    };
    let fixture = same_entity_product_fixture_with_shaped_scenes(1, 300_000, 25, shape)?;
    let original = fixture.authority.with_conn(|conn| {
        conn.execute_batch("PRAGMA query_only=OFF")?;
        // a POV for the query Scene, and a long saved content
        conn.execute(
            "UPDATE tree_nodes SET pov_character_id='v00', content=?1 WHERE id='nir1'",
            [format!("{{}}{}", " ".repeat(5_000))],
        )?;
        // `archived_at` is a column the tree's read and the query Scene's read
        // both return: archive the query Scene, and add an archived note. The
        // query Scene's archive and the binding below are for the charge
        // only; both are restored before the load is observed, which stops at
        // an archived query Scene and at a malformed binding.
        conn.execute(
            "UPDATE tree_nodes SET archived_at='2026-01-01T00:00:00.000Z' WHERE id='nir1'",
            [],
        )?;
        conn.execute(
            "INSERT INTO tree_nodes
                (id, project_id, parent_id, node_type, title, content, sort_order, archived_at)
             SELECT 'archived-note', ?1, parent_id, 'note', 'Old note', '{}', 'zzzzzz',
                    '2026-02-02T00:00:00.000Z'
               FROM tree_nodes WHERE project_id=?1 AND node_type='note' LIMIT 1",
            [PROJECT],
        )?;
        // The product's join does not read a principal's `kind`, only its `ref`
        // and the Codex row's `type`: one audience of another kind that names a
        // character is a row the oracle must count too.
        let original: String = conn.query_row(
            "SELECT audience_json FROM narrative_scene_scope_bindings
              WHERE rowid=(SELECT MIN(rowid) FROM narrative_scene_scope_bindings WHERE project_id=?1)",
            [PROJECT],
            |row| row.get(0),
        )?;
        let changed = conn.execute(
            "UPDATE narrative_scene_scope_bindings SET audience_json='{\"kind\":\"reader\",\"ref\":\"v00\"}'
              WHERE rowid=(SELECT MIN(rowid) FROM narrative_scene_scope_bindings WHERE project_id=?1)",
            [PROJECT],
        )?;
        assert_eq!(changed, 1);
        Ok(original)
    })?;
    let (charged, before, expected) = fixture.authority.with_read_transaction(|conn| {
        let charged = super::input::preflight_project_reads(
            conn,
            PROJECT,
            "nir1",
            MAX_GRAPH_QUERY_RECORDS,
            MAX_GRAPH_INPUT_BYTES,
        )?
        .bytes;
        let before = super::input::with_legacy_shared_bytes(|| {
            super::input::preflight_project_reads(
                conn,
                PROJECT,
                "nir1",
                MAX_GRAPH_QUERY_RECORDS,
                MAX_GRAPH_INPUT_BYTES,
            )
        })?
        .bytes;
        let expected = shared_bytes_returned(conn, "nir1")?;
        Ok((charged, before, expected))
    })?;
    fixture.authority.with_conn(|conn| {
        conn.execute_batch("PRAGMA query_only=OFF")?;
        conn.execute("UPDATE tree_nodes SET archived_at=NULL WHERE id='nir1'", [])?;
        conn.execute(
            "UPDATE narrative_scene_scope_bindings SET audience_json=?2
              WHERE rowid=(SELECT MIN(rowid) FROM narrative_scene_scope_bindings WHERE project_id=?1)",
            params![PROJECT, original],
        )?;
        Ok(())
    })?;
    let columns = fixture
        .authority
        .with_read_transaction(|conn| columns_read_by_one_load(conn))?;
    assert_eq!(charged, expected);
    // the old count read the tree twice and every binding twice
    assert!(before > charged, "{before} before, {charged} now");
    // Every column one load names, by the number of statements naming it. The
    // columns the byte charge counts (once for each statement that returns
    // them) are the returned ones: the tree's six (`id`, `parent_id`,
    // `node_type`, `sort_order`, `story_time_order`, `archived_at`), the
    // registry's, the bindings', `version`, `updated_at`, `content`,
    // `archived_at` and `pov_character_id` of the query Scene, the project's
    // `phase_resolution_mode`, the POV's Codex `type`, the principals' Codex
    // `id`, the Epoch's four. The rest are predicates (`project_id`, `id` and
    // `node_type` of a lookup, the join's `type`, `context_mode`, `ORDER BY
    // epoch_number`), which no statement of the preflight counts. `version` of a
    // binding is named once: the extension loads the bindings once.
    let columns: Vec<(&str, &str, usize)> = columns
        .iter()
        .map(|((table, column), count)| (table.as_str(), column.as_str(), *count))
        .collect();
    assert_eq!(
        columns,
        vec![
            ("codex_entries", "context_mode", 1),
            ("codex_entries", "id", 5),
            ("codex_entries", "project_id", 3),
            ("codex_entries", "type", 3),
            ("narrative_scene_scope_bindings", "audience_json", 3),
            ("narrative_scene_scope_bindings", "compatibility_marker", 1),
            ("narrative_scene_scope_bindings", "knowledge_holder_json", 3),
            ("narrative_scene_scope_bindings", "material_constraint_json", 1),
            ("narrative_scene_scope_bindings", "project_id", 3),
            ("narrative_scene_scope_bindings", "query_identity_json", 1),
            ("narrative_scene_scope_bindings", "scene_id", 2),
            ("narrative_scene_scope_bindings", "scene_incarnation_id", 1),
            ("narrative_scene_scope_bindings", "source_token", 1),
            ("narrative_scene_scope_bindings", "updated_at", 1),
            ("narrative_scene_scope_bindings", "version", 1),
            ("narrative_scope_registries", "narrative_layer_refs_json", 1),
            ("narrative_scope_registries", "project_id", 2),
            ("narrative_scope_registries", "registry_version", 1),
            ("narrative_scope_registries", "source_token", 2),
            ("narrative_scope_registries", "timeline_refs_json", 1),
            ("narrative_scope_registries", "updated_at", 1),
            ("narrative_scope_registries", "version", 2),
            ("narrative_scope_registries", "worldline_refs_json", 1),
            ("narrative_semantic_epochs", "created_at", 1),
            ("narrative_semantic_epochs", "epoch_number", 2),
            ("narrative_semantic_epochs", "id", 1),
            ("narrative_semantic_epochs", "project_id", 1),
            ("narrative_semantic_epochs", "reason", 1),
            ("projects", "id", 3),
            ("projects", "phase_resolution_mode", 1),
            ("tree_nodes", "archived_at", 2),
            ("tree_nodes", "content", 1),
            ("tree_nodes", "id", 4),
            ("tree_nodes", "node_type", 3),
            ("tree_nodes", "parent_id", 1),
            ("tree_nodes", "pov_character_id", 1),
            ("tree_nodes", "project_id", 3),
            ("tree_nodes", "sort_order", 1),
            ("tree_nodes", "story_time_order", 1),
            ("tree_nodes", "updated_at", 1),
            ("tree_nodes", "version", 1),
        ]
    );
    Ok(())
}

/// The (table, column) pairs `Nir1ProjectReads::load` makes SQLite authorize,
/// each with the number of times (one for each statement preparing it).
fn columns_read_by_one_load(
    conn: &rusqlite::Connection,
) -> Result<BTreeMap<(String, String), usize>> {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use std::sync::{Arc, Mutex};
    let reads = Arc::new(Mutex::new(BTreeMap::<(String, String), usize>::new()));
    let sink = Arc::clone(&reads);
    conn.authorizer(Some(move |context: AuthContext<'_>| {
        if let AuthAction::Read {
            table_name,
            column_name,
        } = context.action
        {
            if table_name != "sqlite_master" && table_name != "sqlite_schema" {
                *sink
                    .lock()
                    .unwrap()
                    .entry((table_name.to_owned(), column_name.to_owned()))
                    .or_default() += 1;
            }
        }
        Authorization::Allow
    }))?;
    let loaded = Nir1ProjectReads::load(conn, PROJECT, "nir1");
    conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)?;
    loaded?;
    let reads = reads.lock().unwrap().clone();
    Ok(reads)
}

/// Set the query Scene's saved content so that the shared reads charge exactly
/// `target` bytes (the content is the one column the test grows).
fn set_shared_bytes_to(fixture: &Fixture, target: usize) -> Result<()> {
    fixture.authority.with_conn(|conn| {
        conn.execute_batch("PRAGMA query_only=OFF")?;
        let current: usize = conn.query_row(
            "SELECT octet_length(content) FROM tree_nodes WHERE id='nir1'",
            [],
            |row| row.get::<_, i64>(0),
        )? as usize;
        let base = super::input::preflight_project_reads(
            conn,
            PROJECT,
            "nir1",
            MAX_GRAPH_QUERY_RECORDS,
            MAX_GRAPH_INPUT_BYTES,
        )?
        .bytes;
        let length = target - (base - current);
        conn.execute(
            "UPDATE tree_nodes SET content=?1 WHERE id='nir1'",
            [format!("{{}}{}", " ".repeat(length - 2))],
        )?;
        let now = super::input::preflight_project_reads(
            conn,
            PROJECT,
            "nir1",
            MAX_GRAPH_QUERY_RECORDS,
            MAX_GRAPH_INPUT_BYTES,
        );
        match now {
            Ok(admission) => assert_eq!(admission.bytes, target),
            Err(error) => assert!(target > 2 * 1024 * 1024, "{error}"),
        }
        Ok(())
    })
}

// The shared reads' bytes are the last typed stop when the rows are few and
// the bytes are many (a long Scene, long JSON): the preflight's 2 MiB. Under it
// the query is answered; over it, the whole Graph is refused (no partial Graph)
// with the preflight's own refusal. The Revision's own bytes come out of what
// the shared reads leave of the same 2 MiB, so the answered side stops short
// of it.
#[test]
fn shared_bytes_over_the_preflight_refuse_the_whole_graph() -> Result<()> {
    let fixture = same_entity_product_fixture_with_scenes(1, 300_000, 20)?;
    let answer = |target: usize| -> Result<Nir1GraphResponse> {
        set_shared_bytes_to(&fixture, target)?;
        fixture
            .worker_reader()?
            .query_for_worker_with_maintenance_deadline(&request_for("v00", "nir1"), LARGE_N_LEASE)
    };
    let below = answer(1024 * 1024)?;
    assert_eq!(below.status, "available", "{:?}", below.reason);
    let over = answer(2 * 1024 * 1024 + 1)?;
    assert_eq!(over.status, "unavailable");
    assert!(over.graph.is_none());
    // the refusal is the preflight's (`NIR1_GRAPH_DISCLOSURE_INPUT_LIMIT`), which
    // the worker's frame reports as `other`, like the peak ledger's
    assert_eq!(over.reason.as_deref(), Some(PEAK_LEDGER_REFUSAL));
    Ok(())
}

/// DR-CQA-8: the SQLite VM instructions the shared reads' preflight runs for a
/// project, with the bytes counted now and as before (a progress handler called
/// once per VM instruction). The binding's byte sum now joins the Codex rows of
/// the principals, as the extension's read does.
#[test]
#[ignore = "DR-CQA-8 measurement: prints the VM steps of the shared preflight (CQ_FLOOR_SCENES, CQ_FLOOR_REVISIONS, CQ_FLOOR_SHAPE)"]
fn measure_the_shared_preflight_steps() -> Result<()> {
    let env = |name: &str, default: usize| {
        std::env::var(name)
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(default)
    };
    let shape = shape_from_env();
    let revisions = env("CQ_FLOOR_REVISIONS", 1);
    let scenes = env("CQ_FLOOR_SCENES", 978);
    let fixture = same_entity_product_fixture_with_shaped_scenes(
        revisions,
        300_000,
        scenes - fixture_scenes(revisions),
        shape,
    )?;
    fixture.authority.with_conn(|conn| {
        let steps = |legacy: bool| -> Result<(u64, usize)> {
            let counter = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
            let seen = std::sync::Arc::clone(&counter);
            conn.progress_handler(
                1,
                Some(move || {
                    seen.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    false
                }),
            )?;
            let run = || {
                super::input::preflight_project_reads(
                    conn,
                    PROJECT,
                    "nir1",
                    MAX_GRAPH_QUERY_RECORDS,
                    MAX_GRAPH_INPUT_BYTES,
                )
            };
            let admission = if legacy {
                super::input::with_legacy_shared_bytes(run)
            } else {
                run()
            };
            conn.progress_handler(1, None::<fn() -> bool>)?;
            Ok((counter.load(std::sync::atomic::Ordering::Relaxed), admission?.bytes))
        };
        let (now, now_bytes) = steps(false)?;
        let (before, before_bytes) = steps(true)?;
        eprintln!(
            "STEPS scenes={scenes} revisions={revisions}: shared preflight {now} steps \
             (bytes {now_bytes}) now, {before} before (bytes {before_bytes}); \
             QUERY_SQL_STEPS {QUERY_SQL_STEPS}"
        );
        Ok(())
    })?;
    // the whole query, with the steps cap lifted, as the worker runs it
    let (status, reason, total) = uncapped_steps(&fixture, "v00")?;
    eprintln!(
        "STEPS whole query at {scenes} Scenes: {total} VM steps ({status} {reason:?}); QUERY_SQL_STEPS {QUERY_SQL_STEPS}"
    );
    Ok(())
}
