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
/// rows the Revisions share (the tree and the Scene bindings twice, the
/// registry for each of the two reads that make it, the project, the query
/// Scene, its POV and the Epoch).
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
        // project 1, query Scene 1, its POV 0 (the fixture's Scene has none)
        let shared = 2 * tree + 2 * bindings + 2 * registry + 1 + 1 + epoch;
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
            )?;
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
