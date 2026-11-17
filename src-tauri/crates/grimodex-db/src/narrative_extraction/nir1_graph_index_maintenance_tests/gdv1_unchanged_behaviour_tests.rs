//! GDV/1 (contract revision 6, section 8): what GDV/1 must NOT change.
//!
//! This file uses only APIs that exist before GDV/1, so the very same file runs
//! on the build before GDV/1 (`origin/master` at the branch point) and on this
//! branch. `EXPECTED` was captured by running `observe_unchanged_forms` on the
//! base build and pasted here; the test passes on both builds. Only counts,
//! variant names and error-code prefixes are compared (ids and digests are not
//! deterministic across runs).

use super::*;
use crate::narrative_extraction::maintenance_runtime::MaintenanceProjectDiscovery;
use crate::narrative_extraction::restore_rebuild as rr;
use crate::narrative_extraction::source_revision::ForegroundValidationControl;

fn digest_of(fill: char) -> String {
    format!("sha256:{}", fill.to_string().repeat(64))
}

fn prefix(text: &str) -> String {
    text.chars().take(70).collect()
}

fn verify_work(fixture: &Fixture) -> Result<MaintenanceCycleRequest> {
    let epoch = fixture.current_epoch()?;
    Ok(MaintenanceCycleRequest {
        work: vec![MaintenanceWorkRequest {
            project_id: PROJECT.into(),
            run_kind: AutomaticRunKind::Verify,
            work_key: format!("dependency-verify:{epoch}"),
            semantic_epoch_id: Some(epoch),
            reasons: vec!["workspace-opened".into()],
        }],
        wake_project_ids: Vec::new(),
        delivery_sequence: None,
        delivery_fingerprint: None,
        workspace_binding: None,
    })
}

/// A compact, deterministic line for the project: how main's discovery, a
/// controlled Verify cycle, the Finding table and the Verify report look.
fn observe(fixture: &Fixture) -> Result<String> {
    let discovery = {
        let recorder = Recorder::default();
        match main_wake_cycle_with_discovery(fixture, None, "workspace-opened", &recorder) {
            Ok((MaintenanceProjectDiscovery::Work(work), _)) => format!("work:{:?}", work.run_kind),
            Ok((other, _)) => format!("{other:?}"),
            Err(error) => format!("ERR {}", prefix(&format!("{error:#}"))),
        }
    };
    let recorder = Recorder::default();
    let cycle = match run_cycle_on(
        fixture.db(),
        Some(fixture.runtime()),
        &verify_work(fixture)?,
        None,
        &recorder,
    ) {
        Ok(result) => format!("{:?}", result.status),
        Err(error) => format!("ERR {}", prefix(&format!("{error:#}"))),
    };
    let findings = finding_keys(fixture.db())?.len();
    let report = fixture.db().with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT outcome_summary_json FROM narrative_extraction_runs
                  WHERE project_id=?1 AND run_kind='dependency-verify' AND status='completed'
                  ORDER BY rowid DESC LIMIT 1",
                [PROJECT],
                |row| row.get::<_, String>(0),
            )
            .optional()?)
    })?;
    let report = match report {
        Some(summary) => {
            let value: serde_json::Value = serde_json::from_str(&summary)?;
            let r = &value["report"];
            let len = |key: &str| r[key].as_array().map(Vec::len).unwrap_or(0);
            format!(
                "unresolvable={} missingSource={} staleDeps={} rebuildRequired={} semanticIndexDigestComplete={}",
                len("edgeIdsWithUnresolvableConsumerScope"),
                len("edgeIdsWithMissingSource"),
                len("consumerKeysWithStaleDependencySetDigest"),
                r["rebuildRequired"],
                r["semanticIndexDependencySetDigest"]["completed"],
            )
        }
        None => "no completed Verify".to_string(),
    };
    Ok(format!(
        "discovery={discovery} cycle={cycle} findings={findings} report[{report}]"
    ))
}

fn graph_shape(name: &str, sql: &str) -> Result<String> {
    let fixture = Fixture::published()?;
    if !sql.is_empty() {
        fixture.db().with_conn(|conn| {
            conn.execute_batch(sql)?;
            Ok(())
        })?;
    }
    Ok(format!("{name}: {}", observe(&fixture)?))
}

/// The readers of the latest completed Verify: Repair's seal, the C2Z Verify
/// gate and the foreground Verify's completion.
fn readers(fixture: &Fixture) -> Result<String> {
    use crate::narrative_extraction::maintenance_runtime as mr;
    let verify = fixture.db().with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT id, semantic_epoch_id FROM narrative_extraction_runs
                  WHERE project_id=?1 AND run_kind='dependency-verify' AND status='completed'
                  ORDER BY rowid DESC LIMIT 1",
                [PROJECT],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?)
    })?;
    let seal = match &verify {
        Some((run_id, epoch)) => fixture
            .db()
            .with_conn_mut(|conn| {
                crate::narrative_extraction::repair::seal_repair_plan(conn, PROJECT, run_id, epoch)
            })
            .map(|plan| format!("Ok(changes={})", plan.change_count()))
            .unwrap_or_else(|error| format!("ERR {}", prefix(&format!("{error:#}")))),
        None => "no Verify".to_string(),
    };
    let readiness = fixture.db().with_conn_mut(|conn| {
        crate::narrative_extraction::inspect_project_cutover_readiness(conn, PROJECT)
    })?;
    let gate = format!(
        "verify={:?}/{}/clean={} ready={}",
        readiness.verify.state,
        prefix(&readiness.verify.reasons.join(",")),
        readiness.verify.report_clean,
        readiness.ready
    );
    let epoch = fixture.current_epoch()?;
    let marker = mr::NarrativeSystemWorkMarker {
        trigger: "workspace-opened".to_string(),
        canonical_work_key: mr::canonical_work_key_for_epoch(
            PROJECT,
            AutomaticRunKind::Verify,
            &format!("dependency-verify:{epoch}"),
            Some(&epoch),
        )?,
        authority_id: "authority:gdv1-unchanged".to_string(),
        generation: 1,
        product_journey_barrier_id: "barrier-gdv1-unchanged".to_string(),
        correlation: "correlation-gdv1-unchanged".to_string(),
    };
    let foreground = match mr::with_system_work_marker(Some(marker.clone()), || {
        rr::run_dependency_verify_for_project(fixture.db(), PROJECT)
    }) {
        Err(error) => format!("run ERR {}", prefix(&format!("{error:#}"))),
        Ok(outcome) => {
            let barrier = mr::ForegroundSystemWorkRun {
                run_id: outcome.run_id,
                project_id: PROJECT.to_string(),
                marker,
            };
            match mr::complete_foreground_system_work_run(fixture.db(), &barrier) {
                Ok(()) => "released".to_string(),
                Err(error) => format!("release ERR {}", prefix(&format!("{error:#}"))),
            }
        }
    };
    Ok(format!("seal={seal} gate[{gate}] foreground={foreground}"))
}

pub(super) fn observe_unchanged_forms() -> Result<Vec<String>> {
    let (k, p) = (INDEX_KEY, PROJECT);
    let g = format!("project_id='{p}' AND consumer_kind='semantic-index' AND consumer_key='{k}'");
    let meta = format!("project_id='{p}' AND index_key='{k}'");
    let first_codex_edge = format!(
        "(SELECT id FROM narrative_dependency_edges WHERE {g} AND source_object_identity LIKE 'codex:%' ORDER BY id LIMIT 1)"
    );
    let first_edge =
        format!("(SELECT id FROM narrative_dependency_edges WHERE {g} ORDER BY id LIMIT 1)");
    let shapes: Vec<(&str, String)> = vec![
        // Incoherent bindings (the reader's `Reserved`).
        ("incoherent 06 no Freshness row", format!("DELETE FROM narrative_consumer_freshness WHERE {g}")),
        ("incoherent 07 dirty, Freshness digest mismatch", format!("UPDATE narrative_semantic_index_metadata SET dirty_cache_flag=1 WHERE {meta}; UPDATE narrative_consumer_freshness SET dependency_set_digest='{}' WHERE {g}", digest_of('0'))),
        ("incoherent 08 Freshness digest mismatch", format!("UPDATE narrative_consumer_freshness SET dependency_set_digest='{}' WHERE {g}", digest_of('0'))),
        ("incoherent 09 generation differs from the D1 head", format!("UPDATE narrative_semantic_index_metadata SET generation=generation+1 WHERE {meta}")),
        ("incoherent 10 producer mismatch", format!("UPDATE narrative_semantic_index_metadata SET producer_id='someone-else' WHERE {meta}")),
        ("incoherent 11 D1 entries removed", format!("PRAGMA foreign_keys=OFF; DELETE FROM narrative_dependency_declaration_entries WHERE declaration_set_id IN (SELECT active_declaration_set_id FROM narrative_dependency_declaration_heads WHERE {g})")),
        ("incoherent 12 metadata only", format!("PRAGMA foreign_keys=OFF; DELETE FROM narrative_dependency_declaration_heads WHERE {g}; DELETE FROM narrative_dependency_edges WHERE {g}; DELETE FROM narrative_consumer_freshness WHERE {g}")),
        ("incoherent 13 edges only", format!("PRAGMA foreign_keys=OFF; DELETE FROM narrative_semantic_index_metadata WHERE {meta}")),
        ("incoherent 14 one V1 Edge removed", format!("DELETE FROM narrative_dependency_edges WHERE id={first_codex_edge}")),
        ("incoherent 15 read set not canonical", format!("UPDATE narrative_dependency_edges SET read_set_json='[\"b\",\"a\"]' WHERE id={first_codex_edge}")),
        ("incoherent 16 eligibility token mismatch", format!("UPDATE narrative_dependency_edges SET read_set_json='[\"{}\"]' WHERE {g} AND source_object_identity LIKE 'project:%'", digest_of('1'))),
        ("incoherent 19 source_digest differs", format!("UPDATE narrative_semantic_index_metadata SET source_digest='{}' WHERE {meta}", digest_of('2'))),
        ("incoherent 20 D1 head points at no set", format!("PRAGMA foreign_keys=OFF; UPDATE narrative_dependency_declaration_heads SET active_declaration_set_id='gdv1-missing-set' WHERE {g}")),
        // Current by the structure, false by full validation: manual, as before.
        ("current-false 17 Edge State stale", format!("UPDATE narrative_dependency_edge_states SET evidence_freshness='stale' WHERE edge_id={first_edge}")),
        ("current-false 18 Edge State of another epoch", format!("PRAGMA foreign_keys=OFF; UPDATE narrative_dependency_edge_states SET evaluated_at_epoch_id='other-epoch' WHERE edge_id={first_edge}")),
        (
            "current 21 a raw proposal row added, binding not dirty (the eligibility is unchanged in effect)",
            "INSERT INTO narrative_proposals
                (id, proposal_set_id, proposal_key, kind, status, payload_json, current_revision_id, created_at, updated_at)
             SELECT 'gdv1-drift-candidate', proposal_set_id, 'gdv1-drift-candidate', kind, 'unreviewed', '{}', current_revision_id,
                    '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z'
               FROM narrative_proposals LIMIT 1"
                .to_string(),
        ),
    ];
    let coordinates =
        crate::narrative_extraction::maintenance_contracts::current_maintenance_coordinates()?;
    let mut lines = vec![format!(
        "coordinates: graph={} rule={} producer={} rebuild={} verify={}",
        coordinates.graph_contract_digest,
        coordinates.rule_registry_digest,
        coordinates.producer_generation_set_digest,
        rr::REBUILD_CONTRACT_VERSION,
        rr::VERIFY_CONTRACT_VERSION,
    )];
    for (name, sql) in &shapes {
        lines.push(graph_shape(name, sql)?);
    }
    // A current binding, a binding-less project: the current-time behaviour.
    lines.push(graph_shape("current (no change)", "")?);
    let none = Fixture::new()?;
    drain_durable_chain(&none)?;
    lines.push(format!("no binding: {}", observe(&none)?));

    // The readers of a current binding, an incoherent one and no binding.
    lines.push(format!("readers current: {}", readers(&Fixture::published()?)?));
    {
        let incoherent = Fixture::published()?;
        incoherent.db().with_conn(|conn| {
            conn.execute_batch(&format!(
                "UPDATE narrative_dependency_edges SET read_set_json='[\"b\",\"a\"]' WHERE id={first_codex_edge}"
            ))?;
            Ok(())
        })?;
        lines.push(format!("readers incoherent 15: {}", readers(&incoherent)?));
    }
    lines.push(format!("readers no binding: {}", readers(&none)?));
    let current = Fixture::published()?;
    let current_uncontrolled = current
        .db()
        .with_conn_mut(|conn| rr::durable_graph_state_digest(conn, PROJECT))
        .map(|_| "Ok".to_string())
        .unwrap_or_else(|error| prefix(&format!("ERR {error:#}")));
    let current_foreground = current.db().with_conn_mut(|conn| {
        let mut tx = crate::scoped_tx::ScopedTransaction::begin(conn)?;
        let mut control = ForegroundValidationControl;
        Ok(rr::durable_graph_state_digest_with_control(&mut tx, PROJECT, &mut control).is_ok())
    })?;
    lines.push(format!(
        "current digest: uncontrolled={current_uncontrolled} foreground_ok={current_foreground}"
    ));
    // S-5: the Rebuild V2 shadow of a current Graph (it needs the foreground
    // control to resolve the eligibility): the summary values.
    let shadow = current.db().with_conn_mut(|conn| {
        let mut tx = crate::scoped_tx::ScopedTransaction::begin(conn)?;
        let mut control = ForegroundValidationControl;
        let summary = rr::verify_v2_shadow_for_rebuild_in_tx_with_control(
            &mut tx,
            PROJECT,
            "gdv1-unchanged",
            &mut control,
        );
        tx.rollback()?;
        summary
    })?;
    lines.push(format!(
        "v2 shadow current: active_heads={} declarations={} evaluated={} diagnostic_codes={:?}",
        shadow.active_head_count,
        shadow.declaration_count,
        shadow.evaluated_declaration_count,
        shadow
            .diagnostics
            .iter()
            .map(|line| line.split(':').next().unwrap_or_default().to_string())
            .collect::<Vec<_>>()
    ));
    Ok(lines)
}

const EXPECTED: &[&str] = &[
    "coordinates: graph=sha256:ca80ae1b48b2d02568f0e8f5b3c7c6ccef87d358b57d2d1892fa4210d072202e rule=sha256:5d096d7627174d7637107143c90fa05809dbbc0a8bc55172f7333aa7cc854f2a producer=sha256:c6e94c7cfdb62870e6dd874f66d3eaae57d9181bb6e5540c8065dea9a8f88a44 rebuild=1 verify=9",
    "incoherent 06 no Freshness row: discovery=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi cycle=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi findings=0 report[unresolvable=4 missingSource=0 staleDeps=0 rebuildRequired=false semanticIndexDigestComplete=false]",
    "incoherent 07 dirty, Freshness digest mismatch: discovery=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi cycle=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi findings=0 report[unresolvable=4 missingSource=0 staleDeps=0 rebuildRequired=false semanticIndexDigestComplete=false]",
    "incoherent 08 Freshness digest mismatch: discovery=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi cycle=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi findings=0 report[unresolvable=4 missingSource=0 staleDeps=0 rebuildRequired=false semanticIndexDigestComplete=false]",
    "incoherent 09 generation differs from the D1 head: discovery=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi cycle=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi findings=0 report[unresolvable=4 missingSource=0 staleDeps=0 rebuildRequired=false semanticIndexDigestComplete=false]",
    "incoherent 10 producer mismatch: discovery=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi cycle=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi findings=0 report[unresolvable=4 missingSource=0 staleDeps=0 rebuildRequired=false semanticIndexDigestComplete=false]",
    "incoherent 11 D1 entries removed: discovery=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi cycle=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi findings=0 report[unresolvable=4 missingSource=0 staleDeps=0 rebuildRequired=false semanticIndexDigestComplete=false]",
    "incoherent 12 metadata only: discovery=work:Verify cycle=Accepted findings=0 report[unresolvable=0 missingSource=0 staleDeps=0 rebuildRequired=false semanticIndexDigestComplete=false]",
    "incoherent 13 edges only: discovery=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi cycle=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi findings=0 report[unresolvable=4 missingSource=0 staleDeps=0 rebuildRequired=false semanticIndexDigestComplete=false]",
    "incoherent 14 one V1 Edge removed: discovery=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi cycle=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi findings=0 report[unresolvable=3 missingSource=0 staleDeps=0 rebuildRequired=false semanticIndexDigestComplete=false]",
    "incoherent 15 read set not canonical: discovery=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi cycle=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi findings=0 report[unresolvable=4 missingSource=0 staleDeps=0 rebuildRequired=false semanticIndexDigestComplete=false]",
    "incoherent 16 eligibility token mismatch: discovery=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi cycle=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi findings=0 report[unresolvable=4 missingSource=0 staleDeps=0 rebuildRequired=false semanticIndexDigestComplete=false]",
    "incoherent 19 source_digest differs: discovery=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi cycle=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi findings=0 report[unresolvable=4 missingSource=0 staleDeps=0 rebuildRequired=false semanticIndexDigestComplete=false]",
    "incoherent 20 D1 head points at no set: discovery=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi cycle=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi findings=0 report[unresolvable=4 missingSource=0 staleDeps=0 rebuildRequired=false semanticIndexDigestComplete=false]",
    "current-false 17 Edge State stale: discovery=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi cycle=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi findings=0 report[unresolvable=4 missingSource=0 staleDeps=0 rebuildRequired=false semanticIndexDigestComplete=false]",
    "current-false 18 Edge State of another epoch: discovery=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi cycle=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi findings=0 report[unresolvable=4 missingSource=0 staleDeps=0 rebuildRequired=false semanticIndexDigestComplete=false]",
    "current 21 a raw proposal row added, binding not dirty (the eligibility is unchanged in effect): discovery=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi cycle=Accepted findings=0 report[unresolvable=0 missingSource=0 staleDeps=0 rebuildRequired=false semanticIndexDigestComplete=true]",
    "current (no change): discovery=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi cycle=Accepted findings=0 report[unresolvable=0 missingSource=0 staleDeps=0 rebuildRequired=false semanticIndexDigestComplete=true]",
    "no binding: discovery=Idle cycle=Accepted findings=0 report[unresolvable=0 missingSource=0 staleDeps=0 rebuildRequired=false semanticIndexDigestComplete=true]",
    "readers current: seal=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi gate[verify=Blocked/verify-graph-state-invalid: NEX_VALIDATION_TERMINATED:context-unavaila/clean=false ready=false] foreground=run ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi",
    "readers incoherent 15: seal=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi gate[verify=Blocked/verify-graph-state-invalid: NEX_VALIDATION_TERMINATED:context-unavaila/clean=false ready=false] foreground=run ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eligibi",
    "readers no binding: seal=Ok(changes=0) gate[verify=Passed//clean=true ready=false] foreground=released",
    "current digest: uncontrolled=ERR NEX_VALIDATION_TERMINATED:context-unavailable: Entity/Relation eli foreground_ok=true",
    "v2 shadow current: active_heads=2 declarations=11 evaluated=10 diagnostic_codes=[\"NEX_V2_SHADOW_REBUILD_SELECTOR_UNKNOWN\"]",
];

/// GDV/1 changes nothing for incoherent bindings, for bindings that are current
/// by the structure but false by full validation, for a current binding and for
/// a project with no binding; the contract coordinates are unchanged.
#[test]
fn behaviour_that_gdv1_does_not_touch_is_unchanged() -> Result<()> {
    let _serial = serial();
    let lines = observe_unchanged_forms()?;
    for line in &lines {
        eprintln!("GDV1_UNCHANGED {line}");
    }
    assert_eq!(lines, EXPECTED);
    Ok(())
}
