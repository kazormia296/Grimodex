//! CQ-OPT (3-A, T and J): the Graph C-query validates the same Revision-wide
//! authorities with far fewer SQLite VM steps.
//!
//! T answers table-presence checks from the connection's schema cache inside
//! the C-query's pinned snapshot (`nir1_pinned_snapshot`); J joins the
//! Revision's payload to `codex_relations` by primary key (`input.rs`). The
//! tests fix that the response is unchanged across shapes, that T reaches the
//! C-query's read transaction and nothing else, and that the cost no longer
//! follows the project's unrelated Relations.

use super::super::input::with_legacy_relation_bytes;
use super::*;
use crate::narrative_extraction::declaration_storage::read_active_dependency_declaration_set_in_tx;
use crate::narrative_extraction::scene_scope::read_narrative_scene_scope;
use crate::narrative_extraction::{
    narrative_extraction_append_human_decision, AppendDecisionPayload,
};
use crate::nir1_pinned_snapshot::{self, with_pinned_snapshot};
use grimodex_core::narrative_nir1::{EntityRelationBundle, EvidenceInput};
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use std::path::Path;
use std::sync::atomic::AtomicUsize;

/// Steps large enough that the cap never binds: a refusal under it can only
/// come from a semantic limit. The production budget is `QUERY_SQL_STEPS`.
const UNCAPPED_SQL_STEPS: u64 = 100_000_000;

/// Generous on purpose: the shapes must not depend on the 100 ms production
/// lease, which is tested on its own.
const DEADLINE: Duration = Duration::from_secs(30);

const SEED: &str = "nir1-alice";

/// The ordinary reader's refusal reason for any limit.
const READER_LIMIT_REASON: &str = "query-budget-or-validation-failed";

/// Extra Codex objects and directed Relations added to the seed Revision. The
/// seed's alice, bob and `nir1-edge` are always present.
#[derive(Default)]
struct Plan {
    entities: Vec<String>,
    relations: Vec<(String, String, String)>,
}

/// `extra` more Relations from alice to bob, each a distinct edge.
fn parallel_plan(extra: usize) -> Plan {
    Plan {
        entities: Vec::new(),
        relations: (0..extra)
            .map(|index| {
                (
                    format!("nir1-par-{index:03}"),
                    "nir1-alice".to_owned(),
                    "nir1-bob".to_owned(),
                )
            })
            .collect(),
    }
}

/// A fan of `count` Entities around alice.
fn star_plan(count: usize) -> Plan {
    Plan {
        entities: (0..count)
            .map(|index| format!("nir1-n{index:02}"))
            .collect(),
        relations: (0..count)
            .map(|index| {
                (
                    format!("nir1-edge-n{index:02}"),
                    "nir1-alice".to_owned(),
                    format!("nir1-n{index:02}"),
                )
            })
            .collect(),
    }
}

/// Same scope edits as the seed Revision, so every Entity is A3-eligible for
/// the `nir1` query scene.
fn seed_scope_edits(bundle: &mut EntityRelationBundle) {
    for entity in &mut bundle.entities {
        entity.scope.reading = ScopeValue::Exact {
            value: "scene:a3-source".into(),
        };
        entity.scope.phase = "draft".into();
    }
}

/// The Evidence identifier used for an Entity, e.g. `nir1-alice` ->
/// `nir1-evidence-alice`, matching the seed Revision.
fn evidence_id_for(entity: &str) -> String {
    format!("nir1-evidence-{}", entity.trim_start_matches("nir1-"))
}

fn publish_graph_index(authority: &WorkspaceAuthority) -> Result<()> {
    let runtime = authority.nir_chronicle_index_runtime();
    let snapshot = authority
        .with_read_transaction(|conn| prepare_graph_index_build(conn, runtime, PROJECT))?;
    authority.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        publish_nir1_entity_relation_index_in_tx(&tx, runtime, snapshot)?;
        tx.commit()?;
        Ok(())
    })
}

impl Fixture {
    /// The seed Revision plus the objects in `plan`, all in one approved typed
    /// Revision published once.
    fn with_plan(plan: &Plan) -> Result<Self> {
        let directory = TestDirectory(
            std::env::temp_dir().join(format!("nir1-c-graph-{}", uuid::Uuid::new_v4())),
        );
        std::fs::create_dir_all(&directory.0)?;
        let db = crate::Database::new(&directory.0.join("grimodex.db"))?;
        db.migrate()?;
        seed_run_and_catalog(&db)?;
        prepare_a3_scope_fixture(&db)?;
        db.with_conn(|conn| {
            for entity in &plan.entities {
                conn.execute(
                    "INSERT INTO codex_entries (id, project_id, type, name, summary, updated_at)
                     VALUES (?1, 'default-project', 'character', ?1, ?1, '2026-09-12T00:00:00Z')",
                    [entity],
                )?;
            }
            for (edge, from, to) in &plan.relations {
                conn.execute(
                    "INSERT INTO codex_relations
                        (id, project_id, from_codex_id, to_codex_id, relation_type,
                         directionality, version, updated_at)
                     VALUES (?1, 'default-project', ?2, ?3, 'knows', 'directed', 1,
                             '2026-09-12T00:00:00Z')",
                    params![edge, from, to],
                )?;
            }
            Ok(())
        })?;
        run_incremental_freshness_cycle(&db)?;
        let mut typed = request(&db);
        seed_scope_edits(&mut typed.bundle);
        let template = typed.bundle.entities[0].clone();
        for entity in &plan.entities {
            typed.bundle.entities.push(EntityInput {
                entity_id: entity.clone(),
                entity_type: template.entity_type.clone(),
                label: entity.clone(),
                source_token: format!("codex:{entity}@2026-09-12T00:00:00Z"),
                scope: template.scope.clone(),
                evidence: vec![EvidenceInput {
                    evidence_id: evidence_id_for(entity),
                    source_ref: format!("codex:{entity}"),
                    start_utf16: 0,
                    end_utf16: entity.encode_utf16().count(),
                    quote: entity.clone(),
                }],
            });
        }
        for (edge, from, to) in &plan.relations {
            typed.bundle.relations.push(GraphEdgeInput {
                edge_id: edge.clone(),
                from_entity_id: from.clone(),
                to_entity_id: to.clone(),
                relation_type: "knows".into(),
                directionality: "directed".into(),
                source_token: format!("v1@2026-09-12T00:00:00Z:relation:{edge}"),
                evidence_ids: vec![evidence_id_for(from), evidence_id_for(to)],
            });
        }
        let created = create_nir1_entity_relation_revision(&db, typed)?;
        approve_typed_revision(&db, "nir1-run", &created)?;
        let authority = WorkspaceAuthority::from_database_for_test(db, directory.0.clone())?;
        publish_graph_index(&authority)?;
        Ok(Self {
            authority,
            lifecycle: WorkspaceLifecycleCore::new(),
            revision: created["revisionId"].as_str().unwrap().to_owned(),
            _directory: directory,
        })
    }

    /// One more typed Revision for the seed Entities, decided as `decision`
    /// (None leaves it pending). The index must be republished afterwards.
    fn add_candidate(&self, serial: usize, decision: Option<&str>) -> Result<String> {
        let db = self.authority.db();
        let mut payload = request(db);
        payload.proposal_key = format!("nir1:review:candidate-{serial:04}");
        seed_scope_edits(&mut payload.bundle);
        let created = create_nir1_entity_relation_revision(db, payload)?;
        let revision = created["revisionId"].as_str().unwrap().to_owned();
        if let Some(decision) = decision {
            narrative_extraction_append_human_decision(
                db,
                AppendDecisionPayload {
                    run_id: "nir1-run".into(),
                    project_id: PROJECT.into(),
                    proposal_id: created["proposalId"].as_str().unwrap().into(),
                    revision_id: revision.clone(),
                    decision: decision.into(),
                    decision_json: None,
                    created_by: Some("renderer-reviewer".into()),
                },
            )?;
        }
        Ok(revision)
    }

    fn republish(&self) -> Result<()> {
        publish_graph_index(&self.authority)
    }

    /// Project Relations between two Entities no Revision names, numbered
    /// `from..to`. They are workspace growth the seed query must not pay for.
    fn add_unrelated_relations(&self, from: usize, to: usize) -> Result<()> {
        self.authority.with_conn(|conn| {
            let tx = conn.unchecked_transaction()?;
            for entity in ["nir1-unrelated-from", "nir1-unrelated-to"] {
                tx.execute(
                    "INSERT OR IGNORE INTO codex_entries (id, project_id, type, name, summary, updated_at)
                     VALUES (?1, 'default-project', 'character', ?1, ?1, '2026-09-12T00:00:00Z')",
                    [entity],
                )?;
            }
            for index in from..to {
                tx.execute(
                    "INSERT INTO codex_relations
                        (id, project_id, from_codex_id, to_codex_id, relation_type,
                         directionality, version, updated_at)
                     VALUES (?1, 'default-project', 'nir1-unrelated-from', 'nir1-unrelated-to',
                             'knows', 'directed', 1, '2026-09-12T00:00:00Z')",
                    [format!("nir1-unrelated-{index:05}")],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
    }
}

/// The seed Revision and `total - 1` more approved ones over the same Entities.
fn revisions_fixture(total: usize) -> Result<Fixture> {
    let fixture = Fixture::new()?;
    for serial in 1..total {
        fixture.add_candidate(serial, Some("approved"))?;
    }
    if total > 1 {
        fixture.republish()?;
    }
    Ok(fixture)
}

/// The seed Revision, one rejected and one pending candidate: the two
/// ineligible Revisions are read and admitted but contribute nothing.
fn mixed_decisions_fixture() -> Result<Fixture> {
    let fixture = Fixture::new()?;
    fixture.add_candidate(1, Some("approved"))?;
    fixture.add_candidate(2, Some("rejected"))?;
    fixture.add_candidate(3, None)?;
    fixture.republish()?;
    Ok(fixture)
}

/// `total` Relations from alice to bob in the seed Revision.
fn relations_fixture(total: usize) -> Result<Fixture> {
    Fixture::with_plan(&parallel_plan(total - 1))
}

/// The seed Revision with Scene pins, so the response carries Scenes.
fn pinned_scenes_fixture() -> Result<Fixture> {
    let scenes = ["pinned-b", "pinned-a", "seed-pin"].map(String::from);
    let fixture = Fixture::with_scenes(&scenes)?;
    fixture.add_pins(&[
        ("pinned-b", "nir1-bob"),
        ("pinned-a", "nir1-bob"),
        ("seed-pin", "nir1-alice"),
    ])?;
    Ok(fixture)
}

/// What the plain seed query returns for a shape.
#[derive(Clone, Copy, Debug)]
pub(super) enum Expect {
    /// An available Graph.
    Graph {
        nodes: usize,
        edges: usize,
        scenes: usize,
    },
    /// Refused by a semantic limit under either budget. The ordinary reader
    /// gives its generic reason; the worker names the limit.
    Limit { worker_reason: &'static str },
}

pub(super) struct Shape {
    /// Names the files of the before/after recorder.
    pub(super) label: &'static str,
    pub(super) build: fn() -> Result<Fixture>,
    pub(super) expect: Expect,
    /// Also fix the other requests (another end of the edge and the
    /// unavailable reasons), not only the plain seed query.
    pub(super) all_requests: bool,
}

/// The shapes the response and the steps are fixed for: the seed Revision
/// alone, 3 and 5 Revisions, 10, 70 and 144 Relations, and the boundaries
/// whose refusal reason must not move.
pub(super) fn shapes() -> Vec<Shape> {
    let graph = |nodes, edges| Expect::Graph {
        nodes,
        edges,
        scenes: 0,
    };
    // The worker names the semantic limit it met (CQ-AVAIL typed them; they
    // used to be `other`).
    let edge_limit = Expect::Limit {
        worker_reason: "query-worker-work-edge-limit-pre-cleanup-work-failed-edge-limit",
    };
    let node_limit = Expect::Limit {
        worker_reason: "query-worker-work-node-limit-pre-cleanup-work-failed-node-limit",
    };
    vec![
        Shape {
            label: "seed",
            build: Fixture::new,
            expect: graph(2, 1),
            all_requests: true,
        },
        Shape {
            label: "revisions-3",
            build: || revisions_fixture(3),
            expect: graph(2, 3),
            all_requests: false,
        },
        Shape {
            label: "revisions-5",
            build: || revisions_fixture(5),
            expect: graph(2, 5),
            all_requests: false,
        },
        Shape {
            label: "revisions-mixed",
            build: mixed_decisions_fixture,
            expect: graph(2, 2),
            all_requests: true,
        },
        Shape {
            label: "relations-10",
            build: || relations_fixture(10),
            expect: graph(2, 10),
            all_requests: false,
        },
        Shape {
            label: "relations-70",
            build: || relations_fixture(70),
            expect: graph(2, 70),
            all_requests: false,
        },
        Shape {
            label: "relations-144",
            build: || relations_fixture(144),
            expect: graph(2, 144),
            all_requests: false,
        },
        Shape {
            label: "star-10",
            build: || Fixture::with_plan(&star_plan(10)),
            expect: graph(12, 11),
            all_requests: false,
        },
        Shape {
            label: "pins",
            build: pinned_scenes_fixture,
            expect: Expect::Graph {
                nodes: 2,
                edges: 1,
                scenes: 2,
            },
            all_requests: false,
        },
        // One past the edge and Entity limits: refused whatever the step
        // budget. (Ten approved Revisions of the same Entities used to be past
        // the record limit too, and are an available Graph now: the
        // project-level reads are admitted once, so a Revision costs its own
        // rows.)
        Shape {
            label: "relations-145",
            build: || relations_fixture(145),
            expect: edge_limit,
            all_requests: false,
        },
        Shape {
            label: "star-11",
            build: || Fixture::with_plan(&star_plan(11)),
            expect: node_limit,
            all_requests: false,
        },
        Shape {
            label: "revisions-10",
            build: || revisions_fixture(10),
            expect: graph(2, 10),
            all_requests: false,
        },
    ]
}

/// Requests besides the plain seed query: another end of the directed edge, and
/// the answers the Graph gives inside the pinned snapshot when nothing is
/// eligible or the seed is unknown.
pub(super) fn request_variants() -> Vec<(&'static str, Nir1GraphRequest)> {
    let request = |seed: &str, scene: &str| Nir1GraphRequest {
        project_id: PROJECT.into(),
        query_scene_id: scene.into(),
        seed_entity_id: seed.into(),
    };
    vec![
        ("seed", request(SEED, "nir1")),
        ("other-end", request("nir1-bob", "nir1")),
        ("missing-seed", request("nir1-missing", "nir1")),
        // The Scope reads at the Entities' own Scene and at an unknown Scene
        // leave nothing eligible.
        ("same-scene", request(SEED, "a3-source")),
        ("missing-scene", request(SEED, "no-such-scene")),
        ("later-scene", request(SEED, "a3-future")),
    ]
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Lane {
    /// The ordinary reader's own read-only connection.
    Reader,
    /// The worker's reader over the authority connection, under the
    /// maintenance owner.
    Worker,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Cap {
    /// The production budget, `QUERY_SQL_STEPS`.
    Production,
    Uncapped,
}

/// One query's serialized response and the SQL steps its budget was charged.
#[derive(Debug)]
struct Measured {
    json: String,
    steps: u64,
}

/// Run `request` on a freshly registered reader of `lane`.
fn measure(
    fixture: &Fixture,
    lane: Lane,
    cap: Cap,
    request: &Nir1GraphRequest,
) -> Result<Measured> {
    let sql_steps = match cap {
        Cap::Production => QUERY_SQL_STEPS,
        Cap::Uncapped => UNCAPPED_SQL_STEPS,
    };
    LAST_QUERY_SQL_STEPS.take();
    let response = match lane {
        Lane::Reader => fixture
            .registered_reader()?
            .query_with_deadline(request, DEADLINE, sql_steps)?,
        Lane::Worker => {
            // An earlier worker reader left the shared authority connection
            // `query_only`, which also refuses the temp-table setup below.
            fixture.authority.db().with_conn(|conn| {
                conn.execute_batch("PRAGMA query_only=OFF")?;
                Ok(())
            })?;
            let mut reader = fixture.worker_reader()?;
            match cap {
                Cap::Production => {
                    reader.query_for_worker_with_maintenance_deadline(request, DEADLINE)?
                }
                Cap::Uncapped => {
                    let authority = Arc::clone(&reader.authority);
                    authority.db().with_conn(|conn| {
                        reader.query_with_deadline_observed(
                            conn,
                            request,
                            DEADLINE,
                            sql_steps,
                            None,
                            QueryPath::Worker,
                        )
                    })?
                }
            }
        }
    };
    let steps = LAST_QUERY_SQL_STEPS
        .take()
        .ok_or_else(|| anyhow::anyhow!("the query did not record its SQL steps"))?;
    Ok(Measured {
        json: serde_json::to_string(&response)?,
        steps,
    })
}

struct Summary {
    status: String,
    reason: Option<String>,
    nodes: usize,
    edges: usize,
    scenes: usize,
}

fn summarize(json: &str) -> Result<Summary> {
    let value: serde_json::Value = serde_json::from_str(json)?;
    let count = |key: &str| value["graph"][key].as_array().map_or(0, std::vec::Vec::len);
    Ok(Summary {
        status: value["status"].as_str().unwrap_or_default().to_owned(),
        reason: value["reason"].as_str().map(str::to_owned),
        nodes: count("nodes"),
        edges: count("edges"),
        scenes: value["graph"]["sceneTotal"].as_u64().unwrap_or(0) as usize,
    })
}

fn assert_expected(what: &str, lane: Lane, summary: &Summary, expect: Expect) {
    match expect {
        Expect::Graph {
            nodes,
            edges,
            scenes,
        } => {
            assert_eq!(summary.status, "available", "{what}: {:?}", summary.reason);
            assert_eq!(
                (summary.nodes, summary.edges, summary.scenes),
                (nodes, edges, scenes),
                "{what}"
            );
        }
        Expect::Limit { worker_reason } => {
            assert_eq!(summary.status, "unavailable", "{what}");
            let reason = match lane {
                Lane::Reader => READER_LIMIT_REASON,
                Lane::Worker => worker_reason,
            };
            assert_eq!(summary.reason.as_deref(), Some(reason), "{what}");
        }
    }
}

/// What each non-seed request returns, given what the plain seed query does.
fn variant_expect(name: &str, seed: Expect) -> Expect {
    let Expect::Graph { edges, .. } = seed else {
        return seed;
    };
    match name {
        "seed" | "later-scene" => seed,
        "other-end" => Expect::Graph {
            nodes: 1,
            edges: 0,
            scenes: 0,
        },
        "same-scene" | "missing-scene" => Expect::Graph {
            nodes: 0,
            edges: 0,
            scenes: 0,
        },
        _ => panic!("{name} is not an available Graph (edges {edges})"),
    }
}

/// Run `operation` as the C-query ran before CQ-OPT: every table-presence check
/// answered by SQL (T) and the Relation byte count joined from the project's
/// Relations outward (J).
fn before_cq_opt<T>(operation: impl FnOnce() -> T) -> T {
    nir1_pinned_snapshot::with_sql_checks(|| with_legacy_relation_bytes(operation))
}

// The response is fixed: Graph, path, Evidence, Scenes and the reason of every
// refusal are the bytes the C-query returned before CQ-OPT. "Before" runs the
// same code with both optimizations put back (`before_cq_opt`) and the step
// budget lifted, because it needed more steps than `QUERY_SQL_STEPS` for some
// of these shapes (3 Revisions already took 100,534 steps).
#[test]
fn optimized_query_returns_the_legacy_response_on_every_shape() -> Result<()> {
    for shape in shapes() {
        let fixture = (shape.build)()?;
        for lane in [Lane::Reader, Lane::Worker] {
            for (name, request) in request_variants() {
                if name != "seed" && !shape.all_requests {
                    continue;
                }
                let what = format!("{}/{name}/{lane:?}", shape.label);
                let legacy = before_cq_opt(|| measure(&fixture, lane, Cap::Uncapped, &request))?;
                let current = measure(&fixture, lane, Cap::Production, &request)?;
                assert_eq!(current.json, legacy.json, "{what}: the response changed");
                let summary = summarize(&current.json)?;
                match name {
                    "seed" => assert_expected(&what, lane, &summary, shape.expect),
                    "missing-seed" => {
                        assert_eq!(summary.status, "unavailable", "{what}");
                        assert_eq!(summary.reason.as_deref(), Some("seed-not-found"), "{what}");
                    }
                    _ => assert_expected(&what, lane, &summary, variant_expect(name, shape.expect)),
                }
                assert!(
                    current.steps <= QUERY_SQL_STEPS,
                    "{what}: {} steps exceed the budget",
                    current.steps
                );
                // A query that evaluates Revisions spends fewer steps; one that
                // stops at the seed lookup spends the same. The absolute levels
                // are fixed by the step test below.
                if legacy.steps > 1_000 {
                    assert!(
                        current.steps < legacy.steps,
                        "{what}: {} -> {}",
                        legacy.steps,
                        current.steps
                    );
                } else {
                    assert_eq!(current.steps, legacy.steps, "{what}");
                }
            }
        }
    }
    Ok(())
}

// The absolute levels, from the same fixtures at 8ff9d559 (before CQ-OPT):
// seed 33,781, 3 Revisions 100,534, 5 Revisions 167,281, 10 Relations 37,573,
// 70 Relations 95,953, 144 Relations 247,280, a 12-Entity star 45,771. With
// CQ-OPT they measure 5,406, 15,409, 25,406, 8,370, 28,107, 52,453 and 16,399.
// The ceilings sit about 15% above these (14.9% to 16.5%): the seed shape
// catches a presence check that loses its shortcut (about 2,200 steps), and a
// drift of up to 15% passes. The linearity checks below fix the slopes more
// tightly.
const STEP_CEILINGS: [(&str, u64); 7] = [
    ("seed", 6_300),
    ("revisions-3", 17_800),
    ("revisions-5", 29_200),
    ("relations-10", 9_700),
    ("relations-70", 32_400),
    ("relations-144", 60_400),
    ("star-10", 19_000),
];

/// `a` and `b` agree within `percent` percent.
fn assert_proportional(what: &str, a: u64, b: u64, percent: u64) {
    assert!(
        a * 100 <= b * (100 + percent) && b * 100 <= a * (100 + percent),
        "{what}: {a} vs {b}"
    );
}

// The legacy lane puts J back as well as T. J's cost follows the project's
// Relations that no Revision names and T's does not, so 600 more of them move
// only the lane that has both put back. Without this the response test above
// could run J on both sides and still pass.
#[test]
fn the_legacy_lane_puts_back_j_as_well_as_t() -> Result<()> {
    let fixture = relations_fixture(10)?;
    let request = graph_request(SEED);
    let lanes = |fixture: &Fixture| -> Result<(u64, u64)> {
        let t_only = nir1_pinned_snapshot::with_sql_checks(|| {
            measure(fixture, Lane::Reader, Cap::Uncapped, &request)
        })?;
        let legacy = before_cq_opt(|| measure(fixture, Lane::Reader, Cap::Uncapped, &request))?;
        assert_eq!(t_only.json, legacy.json, "J does not change the response");
        Ok((t_only.steps, legacy.steps))
    };
    let (t_only, legacy) = lanes(&fixture)?;
    fixture.add_unrelated_relations(0, 600)?;
    let (t_only_grown, legacy_grown) = lanes(&fixture)?;
    assert_eq!(
        t_only_grown, t_only,
        "J is the current statement in this lane"
    );
    assert!(
        legacy_grown > legacy + 30_000,
        "J is the statement before CQ-OPT in this lane: {legacy} -> {legacy_grown}"
    );
    Ok(())
}

// The 100,000-step budget is unchanged. The query now spends a small fraction
// of it, and what it spends follows the Revisions and the Relations it
// evaluates one for one: no table-presence walk per Revision, no product of the
// project's and the Revision's Relation counts.
#[test]
fn query_steps_stay_far_below_the_budget_and_grow_linearly() -> Result<()> {
    assert_eq!(QUERY_SQL_STEPS, 100_000);
    let request = graph_request(SEED);
    let mut steps = std::collections::BTreeMap::new();
    for shape in shapes() {
        let Some((_, ceiling)) = STEP_CEILINGS
            .iter()
            .find(|(label, _)| *label == shape.label)
        else {
            continue;
        };
        let measured = measure(&(shape.build)()?, Lane::Reader, Cap::Production, &request)?;
        assert!(
            measured.steps <= *ceiling,
            "{}: {} steps over the {ceiling} ceiling",
            shape.label,
            measured.steps
        );
        steps.insert(shape.label, measured.steps);
    }
    assert_eq!(steps.len(), STEP_CEILINGS.len());
    // Two more Revisions cost the same whether they are the 2nd and 3rd or
    // the 4th and 5th.
    assert_proportional(
        "Revisions",
        steps["revisions-3"] - steps["seed"],
        steps["revisions-5"] - steps["revisions-3"],
        2,
    );
    // The cost of one more Relation is the same across 10, 70 and 144.
    assert_proportional(
        "Relations",
        (steps["relations-70"] - steps["relations-10"]) * (144 - 70),
        (steps["relations-144"] - steps["relations-70"]) * (70 - 10),
        2,
    );
    Ok(())
}

/// Reads of the schema table the Graph query must not make, and the callers
/// outside it keep making.
fn schema_reads(conn: &Connection) -> Result<Arc<AtomicUsize>> {
    let reads = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&reads);
    conn.authorizer(Some(move |context: AuthContext<'_>| {
        if let AuthAction::Read { table_name, .. } = context.action {
            if ["sqlite_master", "sqlite_schema"]
                .iter()
                .any(|schema| table_name.eq_ignore_ascii_case(schema))
            {
                counter.fetch_add(1, Ordering::Relaxed);
            }
        }
        Authorization::Allow
    }))?;
    Ok(reads)
}

/// What the three presence-check sites read for the seed Revision.
type SiteReads = (
    crate::narrative_extraction::scene_scope::NarrativeSceneScopeReadV1,
    crate::narrative_extraction::declaration_storage::ActiveDependencyDeclarationSetRead,
    Option<i64>,
);

fn read_sites(conn: &Connection, revision: &str) -> Result<SiteReads> {
    Ok((
        read_narrative_scene_scope(conn, PROJECT, "nir1")?,
        read_active_dependency_declaration_set_in_tx(conn, PROJECT, "proposal-revision", revision)?,
        crate::Database::read_c2zc_cutover_marker(conn)?,
    ))
}

// T reaches the C-query's read transaction and nothing else: a query reads no
// sqlite_master, the same connection reads it again as soon as the query is
// over, and a caller outside the pinned snapshot is unchanged. (The Chronicle
// index publication, which observes its stop through these steps, is fixed by
// its own test, `nir1_participant_sql_publication_installs_only_after_clean_success`.)
#[test]
fn table_presence_is_answered_from_the_schema_cache_only_inside_the_c_query() -> Result<()> {
    let fixture = Fixture::new()?;
    let request = graph_request(SEED);

    // The ordinary reader's own connection.
    let mut reader = fixture.registered_reader()?;
    let ReaderConnection::Owned(conn) = &reader.connection else {
        panic!("an ordinary reader owns its connection");
    };
    let reads = schema_reads(conn)?;
    reads.store(0, Ordering::Relaxed);
    let response = reader.query_with_deadline(&request, DEADLINE, QUERY_SQL_STEPS)?;
    assert_eq!(response.status, "available", "{:?}", response.reason);
    assert_eq!(
        reads.load(Ordering::Relaxed),
        0,
        "the C-query must not read sqlite_master"
    );
    // The control: with the checks answered by SQL, the same query reads it.
    nir1_pinned_snapshot::with_sql_checks(|| {
        reader.query_with_deadline(&request, DEADLINE, UNCAPPED_SQL_STEPS)
    })?;
    assert!(
        reads.load(Ordering::Relaxed) >= 13,
        "13 presence checks per Revision: {}",
        reads.load(Ordering::Relaxed)
    );
    // Back outside the query, the same connection keeps its SQL checks.
    reads.store(0, Ordering::Relaxed);
    let ReaderConnection::Owned(conn) = &reader.connection else {
        panic!("the query returns the connection");
    };
    read_sites(conn, &fixture.revision)?;
    assert!(reads.load(Ordering::Relaxed) > 0);

    // The worker's reader over the authority connection, under the
    // maintenance owner.
    let mut worker = fixture.worker_reader()?;
    let reads = fixture.authority.db().with_conn(schema_reads)?;
    reads.store(0, Ordering::Relaxed);
    let response = worker.query_for_worker_with_maintenance_deadline(&request, DEADLINE)?;
    assert_eq!(response.status, "available", "{:?}", response.reason);
    assert_eq!(reads.load(Ordering::Relaxed), 0);
    fixture.authority.db().with_conn(|conn| {
        read_sites(conn, &fixture.revision)?;
        Ok(())
    })?;
    assert!(reads.load(Ordering::Relaxed) > 0);
    Ok(())
}

/// VM steps `operation` spends on `conn`, counted per instruction like the
/// Graph budget.
fn count_steps<T>(conn: &Connection, operation: impl FnOnce() -> T) -> Result<(T, u64)> {
    let steps = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let counter = Arc::clone(&steps);
    crate::set_sqlite_progress_handler(
        conn,
        1,
        Some(move || {
            counter.fetch_add(1, Ordering::Relaxed);
            false
        }),
    )?;
    let value = operation();
    crate::set_sqlite_progress_handler(conn, 0, None::<fn() -> bool>)?;
    Ok((value, steps.load(Ordering::Relaxed)))
}

// Each of the three presence-check sites takes the shortcut inside a pinned
// snapshot and answers exactly what its SQL check answers. Outside it nothing
// changed: the callers spend the steps they spent before CQ-OPT.
#[test]
fn every_presence_check_site_shortcuts_in_a_pinned_snapshot_and_answers_alike() -> Result<()> {
    let fixture = Fixture::new()?;
    fixture.authority.with_read_transaction(|conn| {
        let reads = schema_reads(conn)?;
        // An ordinary table-reading statement first, as the C-query's seal read
        // is before it opens the scope.
        conn.query_row("SELECT count(*) FROM codex_entries", [], |row| {
            row.get::<_, i64>(0)
        })?;
        let revision = &fixture.revision;

        let (sql, outside_steps) = count_steps(conn, || read_sites(conn, revision))?;
        let sql = sql?;
        let sql_reads = reads.swap(0, Ordering::Relaxed);
        assert!(
            sql_reads >= 5,
            "scene scope 2 + declaration set 3 + marker 1: {sql_reads}"
        );
        let (_, legacy_steps) = count_steps(conn, || {
            nir1_pinned_snapshot::with_sql_checks(|| read_sites(conn, revision))
        })?;
        assert_eq!(
            outside_steps, legacy_steps,
            "outside the pinned snapshot the sites spend what they spent before"
        );
        reads.store(0, Ordering::Relaxed);

        let (pinned, pinned_steps) = count_steps(conn, || {
            with_pinned_snapshot(conn, || read_sites(conn, revision))
        })?;
        let pinned = pinned?;
        assert_eq!(reads.load(Ordering::Relaxed), 0);
        assert!(
            pinned_steps * 4 < outside_steps,
            "{outside_steps} -> {pinned_steps}"
        );
        assert!(matches!(
            sql.1,
            crate::narrative_extraction::declaration_storage::ActiveDependencyDeclarationSetRead::Active(_)
        ));
        assert_eq!(
            serde_json::to_value(&pinned.0)?,
            serde_json::to_value(&sql.0)?
        );
        assert_eq!(pinned.1, sql.1);
        assert_eq!(pinned.2, sql.2);
        assert!(sql.2.is_some(), "the C2-ZC marker is recorded");
        Ok(())
    })
}

/// VM steps of the seed Revision's A3 evaluation, in one read transaction.
fn seed_evaluation_steps(fixture: &Fixture, pinned: bool) -> Result<u64> {
    fixture.authority.with_read_transaction(|conn| {
        conn.query_row("SELECT count(*) FROM codex_entries", [], |row| {
            row.get::<_, i64>(0)
        })?;
        let evaluate =
            || evaluate_nir1_entity_relation_disclosure(conn, PROJECT, &fixture.revision, "nir1");
        let (read, steps) = count_steps(conn, || {
            if pinned {
                with_pinned_snapshot(conn, evaluate)
            } else {
                evaluate()
            }
        })?;
        assert!(
            matches!(read?, Nir1EntityRelationDisclosureRead::Eligible(_)),
            "the seed Revision is eligible"
        );
        Ok(steps)
    })
}

// CQ-2 at the layer T changes: the seed Revision's A3 evaluation reads its
// own rows only, so unrelated Revisions (0, 600, 6,000; decided, so their
// Decisions are in the Decision index too) add no steps, and the pinned
// snapshot spends a small fraction of what the SQL checks spent.
#[test]
fn unrelated_payload_revisions_do_not_change_seed_evaluation_steps() -> Result<()> {
    let fixture = Fixture::new()?;
    let mut pinned = Vec::new();
    let mut sql = Vec::new();
    let mut added = 0;
    for target in [0usize, 600, 6_000] {
        fixture.add_unrelated_payload_revisions(added, target - added, true)?;
        added = target;
        pinned.push(seed_evaluation_steps(&fixture, true)?);
        sql.push(seed_evaluation_steps(&fixture, false)?);
    }
    for (what, steps) in [("pinned", &pinned), ("SQL", &sql)] {
        let [none, some, many] = steps.as_slice() else {
            unreachable!("three measurements");
        };
        assert!(*none > 0, "{what}");
        assert_eq!(
            some, many,
            "{what}: 600 -> 6,000 unrelated Revisions add steps"
        );
        // The B-tree end of the Decision index: at most one step per seek.
        assert!(
            (*none..=*none + 2).contains(some),
            "{what}: {none} -> {some}"
        );
    }
    assert!(
        pinned[2] * 2 < sql[2],
        "pinned {} vs SQL {}",
        pinned[2],
        sql[2]
    );
    Ok(())
}

// CQ-2 for J: Relations of the project that no Revision names (0, 600, 6,000)
// add no steps to the seed query. Before CQ-OPT the relation byte count
// followed their product with the Revision's 10 Relations.
#[test]
fn unrelated_project_relations_do_not_change_the_seed_query_steps() -> Result<()> {
    let fixture = relations_fixture(10)?;
    let request = graph_request(SEED);
    let mut steps = Vec::new();
    let mut added = 0;
    for target in [0usize, 600, 6_000] {
        fixture.add_unrelated_relations(added, target)?;
        added = target;
        let measured = measure(&fixture, Lane::Reader, Cap::Production, &request)?;
        let summary = summarize(&measured.json)?;
        assert_eq!(
            summary.status, "available",
            "{target}: {:?}",
            summary.reason
        );
        assert_eq!((summary.nodes, summary.edges), (2, 10), "{target}");
        steps.push(measured.steps);
    }
    assert_eq!(steps[0], steps[1], "{steps:?}");
    assert_eq!(steps[1], steps[2], "{steps:?}");
    Ok(())
}

/// Copy the fixture's database so another build can answer on the same rows.
fn save_fixture(fixture: &Fixture, file: &Path) -> Result<()> {
    fixture.authority.with_conn(|conn| {
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
        Ok(())
    })?;
    std::fs::copy(fixture.authority.path().join("grimodex.db"), file)?;
    Ok(())
}

/// A published fixture rebuilt from a copy made by [`save_fixture`]: the same
/// Revision, Decision and Scene rows, identifiers and timestamps.
fn replay_fixture(file: &Path) -> Result<Fixture> {
    let directory =
        TestDirectory(std::env::temp_dir().join(format!("nir1-c-graph-{}", uuid::Uuid::new_v4())));
    std::fs::create_dir_all(&directory.0)?;
    std::fs::copy(file, directory.0.join("grimodex.db"))?;
    let db = crate::Database::new(&directory.0.join("grimodex.db"))?;
    let authority = WorkspaceAuthority::from_database_for_test(db, directory.0.clone())?;
    Ok(Fixture {
        authority,
        lifecycle: WorkspaceLifecycleCore::new(),
        revision: String::new(),
        _directory: directory,
    })
}

// Every Revision, Decision and token in a response derives from random
// identifiers and the clock, so two builds of a fixture never answer alike.
// CQOPT_FIXTURE_DIR makes the recorder answer on the same rows from any build:
// the first run saves each shape's database there, a later run replays it.
#[test]
#[ignore = "CQ-OPT before/after recorder: writes one file per shape, request and lane into CQOPT_DUMP_DIR"]
fn record_shape_responses() -> Result<()> {
    use std::io::Write as _;
    let dir = PathBuf::from(
        std::env::var_os("CQOPT_DUMP_DIR")
            .ok_or_else(|| anyhow::anyhow!("CQOPT_DUMP_DIR is required"))?,
    );
    let saved = std::env::var_os("CQOPT_FIXTURE_DIR").map(PathBuf::from);
    std::fs::create_dir_all(&dir)?;
    if let Some(saved) = &saved {
        std::fs::create_dir_all(saved)?;
    }
    let mut steps_file = std::fs::File::create(dir.join("steps.tsv"))?;
    for shape in shapes() {
        let fixture = match saved
            .as_ref()
            .map(|saved| saved.join(format!("{}.db", shape.label)))
        {
            Some(file) if file.exists() => replay_fixture(&file)?,
            Some(file) => {
                let fixture = (shape.build)()?;
                save_fixture(&fixture, &file)?;
                fixture
            }
            None => (shape.build)()?,
        };
        for lane in [Lane::Reader, Lane::Worker] {
            for (name, request) in request_variants() {
                if name != "seed" && !shape.all_requests {
                    continue;
                }
                let measured = measure(&fixture, lane, Cap::Uncapped, &request)?;
                let stem = format!("{}.{name}.{lane:?}", shape.label);
                std::fs::write(dir.join(format!("{stem}.json")), &measured.json)?;
                writeln!(steps_file, "{stem}\t{}", measured.steps)?;
            }
        }
    }
    Ok(())
}

// CQ-AVAIL recorder (ignored): writes every shape's response, per lane and
// request, to the directory named by `CQ_AVAIL_DUMP_DIR`, so a run before a
// change and a run after it can be compared byte for byte.
#[test]
#[ignore = "CQ-AVAIL recorder: set CQ_AVAIL_DUMP_DIR"]
fn dump_every_shape_response() -> Result<()> {
    let directory = std::path::PathBuf::from(
        std::env::var_os("CQ_AVAIL_DUMP_DIR")
            .ok_or_else(|| anyhow::anyhow!("CQ_AVAIL_DUMP_DIR missing"))?,
    );
    std::fs::create_dir_all(&directory)?;
    for shape in shapes() {
        let fixture = (shape.build)()?;
        for lane in [Lane::Reader, Lane::Worker] {
            for (name, request) in request_variants() {
                if name != "seed" && !shape.all_requests {
                    continue;
                }
                let measured = measure(&fixture, lane, Cap::Production, &request)?;
                let file = directory.join(format!("{}.{lane:?}.{name}.json", shape.label));
                std::fs::write(
                    &file,
                    format!("{}\nsteps={}\n", measured.json, measured.steps),
                )?;
            }
        }
    }
    Ok(())
}
