use super::*;
use crate::narrative_extraction::incremental_freshness::run_incremental_freshness_cycle;
use crate::narrative_extraction::nir1_entity_relation::create_nir1_entity_relation_revision;
use crate::narrative_extraction::nir1_entity_relation::tests::{
    approve_typed_revision, create_typed_run, prepare_a3_scope_fixture, request_for_run,
    seed_run_and_catalog,
};
#[cfg(feature = "native-current-human-capture")]
use crate::narrative_extraction::{
    read_retrieval_scene_source, RetrievalSceneSourceBinding, RetrievalSceneSourceRead,
};
use crate::test_support::current_schema_memory;
#[cfg(feature = "native-current-human-capture")]
use anyhow::Context;
use rusqlite::params;

pub(in crate::narrative_extraction) const RAW_SOURCE_PROJECT: &str = "default-project";
pub(in crate::narrative_extraction) const RAW_SOURCE_SCENE: &str = "a3-future";

fn fixture(db: &Database) -> Result<Vec<String>> {
    fixture_with_query_source(db, None)
}

fn fixture_with_query_source(db: &Database, source_storage: Option<&str>) -> Result<Vec<String>> {
    fixture_with_query_source_and_decision_note(db, source_storage, None)
}

fn fixture_with_query_source_and_decision_note(
    db: &Database,
    source_storage: Option<&str>,
    decision_note: Option<&str>,
) -> Result<Vec<String>> {
    seed_run_and_catalog(db)?;
    prepare_a3_scope_fixture(db)?;
    if let Some(storage) = source_storage {
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tree_nodes
                    SET content=?1, version=version+1,
                        updated_at='2026-09-23T12:10:00.000Z'
                  WHERE project_id=?2 AND id=?3 AND node_type='scene'",
                params![storage, RAW_SOURCE_PROJECT, RAW_SOURCE_SCENE],
            )?;
            Ok(())
        })?;
    }
    run_incremental_freshness_cycle(db)?;
    let mut revisions = Vec::new();
    for index in 0..2 {
        let run_id = format!("pooled-run-{index}");
        create_typed_run(db, &run_id)?;
        let created = create_nir1_entity_relation_revision(
            db,
            request_for_run(db, &run_id, &format!("pooled-proposal-{index}")),
        )?;
        if index == 0 && decision_note.is_some() {
            crate::narrative_extraction::narrative_extraction_append_human_decision(
                db,
                crate::narrative_extraction::AppendDecisionPayload {
                    run_id,
                    project_id: RAW_SOURCE_PROJECT.into(),
                    proposal_id: created["proposalId"]
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!("fixture proposal ID missing"))?
                        .to_owned(),
                    revision_id: created["revisionId"]
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!("fixture revision ID missing"))?
                        .to_owned(),
                    decision: "approved".into(),
                    decision_json: Some(json!({"reviewerNote": decision_note})),
                    created_by: Some("renderer-reviewer".into()),
                },
            )?;
        } else {
            approve_typed_revision(db, &run_id, &created)?;
        }
        revisions.push(
            created["revisionId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("fixture revision ID missing"))?
                .to_owned(),
        );
    }
    Ok(revisions)
}

fn raw() -> Vec<NativeNir1RawContextItem> {
    vec![NativeNir1RawContextItem {
        id: "pooled-raw".into(),
        text: "Raw context".into(),
        tokens: 1,
    }]
}

#[cfg(feature = "native-current-human-capture")]
fn seed_source(db: &Database, storage: &str) -> Result<()> {
    fixture(db)?;
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes
                SET content=?1, version=version+1,
                    updated_at='2026-09-23T12:00:00.000Z'
              WHERE project_id=?2 AND id=?3 AND node_type='scene'",
            params![storage, RAW_SOURCE_PROJECT, RAW_SOURCE_SCENE],
        )?;
        Ok(())
    })
}

#[cfg(feature = "native-current-human-capture")]
fn source_binding(db: &Database) -> Result<RetrievalSceneSourceBinding> {
    db.with_read_transaction(|conn| {
        let source = match read_retrieval_scene_source(conn, RAW_SOURCE_PROJECT, RAW_SOURCE_SCENE)?
        {
            RetrievalSceneSourceRead::Available(source) => source,
            RetrievalSceneSourceRead::Unavailable { reason } => {
                anyhow::bail!("source fixture unavailable: {reason:?}")
            }
        };
        Ok(source.query_source)
    })
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn source_raw_adapter_reads_exact_source_body_and_derives_tokens() -> Result<()> {
    let db = current_schema_memory()?;
    let storage = json!({
        "type": "doc",
        "content": [{
            "type": "paragraph",
            "content": [{"type": "text", "text": "Source-backed body"}]
        }]
    })
    .to_string();
    seed_source(&db, &storage)?;
    let binding = source_binding(&db)?;
    let (item, used_bytes) = db.with_read_transaction(|conn| {
        let mut input_budget = NativePackingInputBudget::default();
        let item = read_nir1_source_raw_context_item(
            conn,
            NativeNir1RawSourceRef {
                project_id: RAW_SOURCE_PROJECT,
                scene_id: RAW_SOURCE_SCENE,
                binding: &binding,
            },
            &mut input_budget,
            &mut || Ok(()),
        )?;
        Ok((item, input_budget.used_bytes))
    })?;
    assert_eq!(item.id, binding.source_key);
    assert_eq!(item.text, "Source-backed body");
    assert_eq!(item.tokens, estimate_nir1_context_tokens(&item.text));
    assert_eq!(used_bytes, item.id.len() + item.text.len());
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn source_raw_adapter_rejects_a_stale_source_binding() -> Result<()> {
    let db = current_schema_memory()?;
    let initial_storage = json!({
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "before"}]}]
    })
    .to_string();
    seed_source(&db, &initial_storage)?;
    let binding = source_binding(&db)?;
    let changed_storage = json!({
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "after"}]}]
    })
    .to_string();
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes
                SET content=?1, version=version+1,
                    updated_at='2026-09-23T12:01:00.000Z'
              WHERE project_id=?2 AND id=?3 AND node_type='scene'",
            params![changed_storage, RAW_SOURCE_PROJECT, RAW_SOURCE_SCENE],
        )?;
        Ok(())
    })?;

    let error = db
        .with_read_transaction(|conn| {
            read_nir1_source_raw_context_item(
                conn,
                NativeNir1RawSourceRef {
                    project_id: RAW_SOURCE_PROJECT,
                    scene_id: RAW_SOURCE_SCENE,
                    binding: &binding,
                },
                &mut NativePackingInputBudget::default(),
                &mut || Ok(()),
            )
        })
        .err()
        .ok_or_else(|| anyhow::anyhow!("stale Source binding unexpectedly qualified"))?;
    assert_eq!(error.to_string(), "NIR1_NATIVE_RAW_SOURCE_STALE");
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn source_raw_adapter_rejects_archived_source_with_unchanged_binding() -> Result<()> {
    let db = current_schema_memory()?;
    let storage = json!({
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "archived body"}]}]
    })
    .to_string();
    seed_source(&db, &storage)?;
    let binding = source_binding(&db)?;

    // Change only archive state so the captured Source identity remains exact.
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes SET archived_at='2026-09-23T12:03:00.000Z'
              WHERE project_id=?1 AND id=?2 AND node_type='scene'",
            params![RAW_SOURCE_PROJECT, RAW_SOURCE_SCENE],
        )?;
        Ok(())
    })?;

    let archived_binding = db.with_read_transaction(|conn| {
        let source = match read_retrieval_scene_source(conn, RAW_SOURCE_PROJECT, RAW_SOURCE_SCENE)?
        {
            RetrievalSceneSourceRead::Available(source) => source,
            RetrievalSceneSourceRead::Unavailable { reason } => {
                anyhow::bail!("archived Source unexpectedly unavailable: {reason:?}")
            }
        };
        ensure!(source.archived, "archive state was not observed");
        Ok(source.query_source)
    })?;
    assert_eq!(archived_binding, binding);

    let (error, used_bytes) = db.with_read_transaction(|conn| {
        let mut input_budget = NativePackingInputBudget::default();
        let error = read_nir1_source_raw_context_item(
            conn,
            NativeNir1RawSourceRef {
                project_id: RAW_SOURCE_PROJECT,
                scene_id: RAW_SOURCE_SCENE,
                binding: &binding,
            },
            &mut input_budget,
            &mut || Ok(()),
        )
        .err()
        .ok_or_else(|| anyhow::anyhow!("archived Source unexpectedly qualified"))?;
        Ok((error, input_budget.used_bytes))
    })?;
    assert_eq!(error.to_string(), "NIR1_NATIVE_RAW_SOURCE_ARCHIVED");
    assert_eq!(used_bytes, 0, "archived body must not enter the Raw budget");
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn source_raw_adapter_rejects_oversized_storage_before_source_materialization() -> Result<()> {
    let db = current_schema_memory()?;
    let initial_storage = json!({
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "small"}]}]
    })
    .to_string();
    seed_source(&db, &initial_storage)?;
    let binding = source_binding(&db)?;
    let oversized_text = "x".repeat(MAX_PACKING_INPUT_BYTES + 1);
    let oversized_storage = json!({
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": oversized_text}]}]
    })
    .to_string();
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes
                SET content=?1, version=version+1,
                    updated_at='2026-09-23T12:02:00.000Z'
              WHERE project_id=?2 AND id=?3 AND node_type='scene'",
            params![oversized_storage, RAW_SOURCE_PROJECT, RAW_SOURCE_SCENE],
        )?;
        Ok(())
    })?;

    let (error, checkpoints, used_bytes) = db.with_read_transaction(|conn| {
        let mut checkpoints = 0;
        let mut input_budget = NativePackingInputBudget::default();
        let error = read_nir1_source_raw_context_item(
            conn,
            NativeNir1RawSourceRef {
                project_id: RAW_SOURCE_PROJECT,
                scene_id: RAW_SOURCE_SCENE,
                binding: &binding,
            },
            &mut input_budget,
            &mut || {
                checkpoints += 1;
                Ok(())
            },
        )
        .err()
        .ok_or_else(|| anyhow::anyhow!("oversized Source unexpectedly qualified"))?;
        Ok((error, checkpoints, input_budget.used_bytes))
    })?;
    assert!(error
        .to_string()
        .contains("NIR1_RETRIEVAL_SCENE_SOURCE_INPUT_LIMIT"));
    assert_eq!(
        checkpoints, 1,
        "scalar preflight must precede Source materialization"
    );
    assert_eq!(
        used_bytes, 0,
        "failed Raw input must not charge the candidate budget"
    );
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn source_raw_adapter_rejects_invalid_json_without_legacy_raw_fallback() -> Result<()> {
    let db = current_schema_memory()?;
    let initial_storage = json!({
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "valid"}]}]
    })
    .to_string();
    seed_source(&db, &initial_storage)?;
    let binding = source_binding(&db)?;
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes
                SET content=?1, version=version+1,
                    updated_at='2026-09-23T12:03:00.000Z'
              WHERE project_id=?2 AND id=?3 AND node_type='scene'",
            params!["[", RAW_SOURCE_PROJECT, RAW_SOURCE_SCENE],
        )?;
        Ok(())
    })?;

    let mut input_budget = NativePackingInputBudget::default();
    let error = db
        .with_read_transaction(|conn| {
            read_nir1_source_raw_context_item(
                conn,
                NativeNir1RawSourceRef {
                    project_id: RAW_SOURCE_PROJECT,
                    scene_id: RAW_SOURCE_SCENE,
                    binding: &binding,
                },
                &mut input_budget,
                &mut || Ok(()),
            )
        })
        .err()
        .ok_or_else(|| anyhow::anyhow!("invalid JSON unexpectedly qualified as Raw"))?;
    assert!(error
        .to_string()
        .contains("NEX_CANONICAL_TEXT_INVALID_JSON"));
    assert_eq!(input_budget.used_bytes, 0);
    Ok(())
}

fn request<'a>(
    revision_ids: &'a [String],
    raw_items: &'a [NativeNir1RawContextItem],
    budget_tokens: usize,
) -> NativeNir1PooledPackingRequest<'a> {
    NativeNir1PooledPackingRequest {
        project_id: "default-project",
        revision_ids,
        query_scene_id: "a3-future",
        budget_tokens,
        purpose: PackingPurpose::Writing,
        raw_items,
        #[cfg(feature = "native-current-human-capture")]
        graph: None,
    }
}

#[cfg(feature = "native-current-human-capture")]
fn source_request<'a>(
    revision_ids: &'a [String],
    budget_tokens: usize,
) -> NativeNir1SourcePooledPackingRequest<'a> {
    NativeNir1SourcePooledPackingRequest {
        project_id: RAW_SOURCE_PROJECT,
        revision_ids,
        query_scene_id: RAW_SOURCE_SCENE,
        budget_tokens,
        purpose: PackingPurpose::Writing,
        graph: None,
    }
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn source_pooled_helper_uses_one_wal_snapshot_and_charges_raw_once() -> Result<()> {
    let path = std::env::temp_dir().join(format!(
        "grimodex-nir1-source-pooled-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let template = current_schema_memory()?;
    let db = Database::new(&path)?;
    {
        let source = template.lock()?;
        let mut destination = db.lock()?;
        let backup = rusqlite::backup::Backup::new(&source, &mut destination)?;
        ensure!(matches!(
            backup.step(-1)?,
            rusqlite::backup::StepResult::Done
        ));
    }
    let source_body = "東京😀".repeat(160);
    assert!(source_body.encode_utf16().count() > 500);
    let initial_storage = json!({
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": source_body.clone()}]}]
    })
    .to_string();
    let revisions = fixture_with_query_source(&db, Some(&initial_storage))?;
    let repeated_revision_ids = vec![
        revisions[0].clone(),
        revisions[1].clone(),
        revisions[0].clone(),
    ];
    let binding = source_binding(&db)?;
    let source_ref = NativeNir1RawSourceRef {
        project_id: RAW_SOURCE_PROJECT,
        scene_id: RAW_SOURCE_SCENE,
        binding: &binding,
    };

    // Control result: the same canonical Source Raw passed once to the existing
    // pooled helper. The composed path below must produce the same envelope.
    let (source_raw, raw_bytes) = db.with_read_transaction(|conn| {
        let mut budget = NativePackingInputBudget::default();
        let raw = read_nir1_source_raw_context_item(conn, source_ref, &mut budget, &mut || Ok(()))?;
        Ok((raw, budget.used_bytes))
    })?;
    assert_eq!(source_raw.text, source_body);
    assert!(source_raw.text.encode_utf16().count() > 500);
    assert_eq!(
        raw_bytes,
        binding.source_key.len() + source_body.len(),
        "the Raw budget must include the complete UTF-8 body"
    );
    let (control, control_bytes) = db.with_read_transaction(|conn| {
        let mut budget = NativePackingInputBudget::default();
        let packed = read_and_pack_native_a2_context_in_tx(
            conn,
            request(
                &repeated_revision_ids,
                std::slice::from_ref(&source_raw),
                100_000,
            ),
            &mut budget,
            &mut |_| Ok(()),
            &mut || Ok(()),
        )?;
        Ok((packed, budget.used_bytes))
    })?;

    let writer = Database::new(&path)?;
    let changed_storage = json!({
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "snapshot source after write"}]}]
    })
    .to_string();
    let mut retained_bindings = 0;
    let mut source_updated_between_revisions = false;
    let (pooled, pooled_bytes) = db.with_read_transaction(|conn| {
        let mut budget = NativePackingInputBudget::default();
        let pooled = read_and_pack_native_a2_context_with_source_raw_in_tx(
            conn,
            source_request(&repeated_revision_ids, 100_000),
            source_ref,
            &mut budget,
            &mut |bytes| {
                retained_bindings += 1;
                if retained_bindings == 1 {
                    writer.with_conn(|writer| {
                        writer.execute(
                            "UPDATE tree_nodes
                                SET content=?1, version=version+1,
                                    updated_at='2026-09-23T12:11:00.000Z'
                              WHERE project_id=?2 AND id=?3 AND node_type='scene'",
                            params![changed_storage, RAW_SOURCE_PROJECT, RAW_SOURCE_SCENE],
                        )?;
                        writer.execute(
                            "UPDATE codex_entries SET summary='Changed Source',
                                 updated_at='2026-09-23T12:11:00Z'
                              WHERE id='nir1-alice'",
                            [],
                        )?;
                        Ok(())
                    })?;
                    source_updated_between_revisions = true;
                }
                ensure!(bytes > 0, "authority reservation should be nonempty");
                Ok(())
            },
            &mut || Ok(()),
        )?;
        Ok((pooled, budget.used_bytes))
    })?;
    ensure!(
        source_updated_between_revisions && retained_bindings == revisions.len(),
        "WAL Source update did not occur between Revision reads"
    );
    assert_eq!(
        pooled_bytes, control_bytes,
        "Source Raw must be charged exactly once"
    );
    assert_eq!(pooled.packed, control.packed);
    assert_eq!(pooled.selected_items, control.selected_items);
    assert_eq!(pooled.bindings, control.bindings);
    assert_eq!(pooled.bindings.len(), 2);
    assert_eq!(pooled.selected_items.len(), 31);
    assert!(pooled.packed.used_tokens <= 100_000);
    assert_eq!(
        pooled.raw_source_binding,
        Some(NativeNir1RawSourceBinding {
            project_id: RAW_SOURCE_PROJECT.into(),
            scene_id: RAW_SOURCE_SCENE.into(),
            binding: binding.clone(),
        })
    );
    assert!(pooled.selected_items.iter().any(|selected| matches!(
        selected.item(),
        ContextItemKind::Raw { id, text, .. }
            if id == &binding.source_key && text == &source_body
    )));

    let (stale_error, stale_bytes) = db.with_read_transaction(|conn| {
        let mut budget = NativePackingInputBudget::default();
        let error = read_and_pack_native_a2_context_with_source_raw_in_tx(
            conn,
            source_request(&repeated_revision_ids, 100_000),
            source_ref,
            &mut budget,
            &mut |_| Ok(()),
            &mut || Ok(()),
        )
        .err()
        .ok_or_else(|| anyhow::anyhow!("stale Source binding unexpectedly qualified"))?;
        Ok((error, budget.used_bytes))
    })?;
    assert_eq!(stale_error.to_string(), "NIR1_NATIVE_RAW_SOURCE_STALE");
    assert_eq!(stale_bytes, 0);
    drop(writer);
    drop(db);
    std::fs::remove_file(path)?;
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn source_pooled_helper_rejects_archived_source_with_unchanged_binding() -> Result<()> {
    let db = current_schema_memory()?;
    let revisions = fixture(&db)?;
    let storage = json!({
        "type": "doc",
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "archived query body"}]}]
    })
    .to_string();
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes
                SET content=?1, version=version+1,
                    updated_at='2026-09-23T12:12:00.000Z'
              WHERE project_id=?2 AND id=?3 AND node_type='scene'",
            params![storage, RAW_SOURCE_PROJECT, RAW_SOURCE_SCENE],
        )?;
        Ok(())
    })?;
    let binding = source_binding(&db)?;
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes SET archived_at='2026-09-23T12:12:00.000Z'
              WHERE project_id=?1 AND id=?2 AND node_type='scene'",
            params![RAW_SOURCE_PROJECT, RAW_SOURCE_SCENE],
        )?;
        Ok(())
    })?;
    let archived_binding = source_binding(&db)?;
    assert_eq!(archived_binding, binding);

    let (error, used_bytes) = db.with_read_transaction(|conn| {
        let mut budget = NativePackingInputBudget::default();
        let error = read_and_pack_native_a2_context_with_source_raw_in_tx(
            conn,
            source_request(&revisions, 100_000),
            NativeNir1RawSourceRef {
                project_id: RAW_SOURCE_PROJECT,
                scene_id: RAW_SOURCE_SCENE,
                binding: &binding,
            },
            &mut budget,
            &mut |_| Ok(()),
            &mut || Ok(()),
        )
        .err()
        .ok_or_else(|| anyhow::anyhow!("archived Source unexpectedly qualified"))?;
        Ok((error, budget.used_bytes))
    })?;
    assert_eq!(error.to_string(), "NIR1_NATIVE_RAW_SOURCE_ARCHIVED");
    assert_eq!(used_bytes, 0);
    Ok(())
}

#[test]
fn pooled_revision_dedup_preserves_single_wrapper_and_one_token_budget() -> Result<()> {
    let db = current_schema_memory()?;
    let revisions = fixture(&db)?;
    let raw = raw();
    let single = read_and_pack_native_a2_context(
        &db,
        NativeNir1PackingRequest {
            project_id: "default-project".into(),
            revision_id: revisions[0].clone(),
            query_scene_id: "a3-future".into(),
            budget_tokens: 100_000,
            purpose: PackingPurpose::Writing,
            atomic_group: "ignored-caller-label".into(),
            raw_items: raw.clone(),
        },
    )?;
    let duplicate_ids = vec![revisions[0].clone(); 3];
    let duplicate = db.with_read_transaction(|conn| {
        read_and_pack_native_a2_context_in_tx(
            conn,
            request(&duplicate_ids, &raw, 100_000),
            &mut NativePackingInputBudget::default(),
            &mut |_| Ok(()),
            &mut || Ok(()),
        )
    })?;
    assert_eq!(duplicate.packed, *single.packed());
    assert_eq!(duplicate.selected_items, single.selected_items());
    assert_eq!(duplicate.bindings, vec![single.binding().clone()]);

    let total_budget = single.used_tokens;
    let pooled = db.with_read_transaction(|conn| {
        read_and_pack_native_a2_context_in_tx(
            conn,
            request(&revisions, &raw, total_budget),
            &mut NativePackingInputBudget::default(),
            &mut |_| Ok(()),
            &mut || Ok(()),
        )
    })?;
    assert_eq!(pooled.bindings.len(), 2);
    assert_eq!(pooled.packed.selected_ids, single.selected_ids);
    assert_eq!(pooled.packed.used_tokens, total_budget);
    assert_eq!(pooled.packed.omitted_ids.len(), 15);
    assert_eq!(pooled.selected_items.len(), 16);
    Ok(())
}

#[test]
fn pooled_candidate_bytes_and_items_share_the_existing_envelope() -> Result<()> {
    let db = current_schema_memory()?;
    let revisions = fixture(&db)?;
    let raw = raw();
    let mut measured = NativePackingInputBudget::default();
    db.with_read_transaction(|conn| {
        read_and_pack_native_a2_context_in_tx(
            conn,
            request(&revisions[..1], &raw, 100_000),
            &mut measured,
            &mut |_| Ok(()),
            &mut || Ok(()),
        )?;
        Ok(())
    })?;
    let typed_bytes = measured.used_bytes - raw[0].id.len() - raw[0].text.len();
    let padded_raw = vec![NativeNir1RawContextItem {
        id: raw[0].id.clone(),
        text: "r".repeat(MAX_PACKING_INPUT_BYTES - typed_bytes - raw[0].id.len()),
        tokens: 1,
    }];
    db.with_read_transaction(|conn| {
        let mut shared = NativePackingInputBudget::default();
        read_and_pack_native_a2_context_in_tx(
            conn,
            request(&revisions[..1], &padded_raw, 100_000),
            &mut shared,
            &mut |_| Ok(()),
            &mut || Ok(()),
        )?;
        assert_eq!(shared.used_bytes, MAX_PACKING_INPUT_BYTES);
        let error = read_and_pack_native_a2_context_in_tx(
            conn,
            request(&revisions, &padded_raw, 100_000),
            &mut NativePackingInputBudget::default(),
            &mut |_| Ok(()),
            &mut || Ok(()),
        )
        .err()
        .ok_or_else(|| anyhow::anyhow!("pooled byte envelope unexpectedly reset"))?;
        assert!(error.to_string().contains("MAX_PACKING_INPUT_BYTES"));
        Ok(())
    })?;

    let many_raw = (0..(MAX_PACKING_ITEMS - 15))
        .map(|index| NativeNir1RawContextItem {
            id: format!("raw-{index}"),
            text: "r".into(),
            tokens: 1,
        })
        .collect::<Vec<_>>();
    db.with_read_transaction(|conn| {
        let boundary = read_and_pack_native_a2_context_in_tx(
            conn,
            request(&revisions[..1], &many_raw, 100_000),
            &mut NativePackingInputBudget::default(),
            &mut |_| Ok(()),
            &mut || Ok(()),
        )?;
        assert_eq!(boundary.selected_items.len(), MAX_PACKING_ITEMS);
        let error = read_and_pack_native_a2_context_in_tx(
            conn,
            request(&revisions, &many_raw, 100_000),
            &mut NativePackingInputBudget::default(),
            &mut |_| Ok(()),
            &mut || Ok(()),
        )
        .err()
        .ok_or_else(|| anyhow::anyhow!("pooled item envelope unexpectedly reset"))?;
        assert!(error.to_string().contains("MAX_PACKING_ITEMS"));
        Ok(())
    })
}

#[test]
fn pooled_retained_authority_uses_one_caller_reservation_without_duplicate_charges() -> Result<()> {
    let db = current_schema_memory()?;
    let revisions = fixture(&db)?;
    let raw = raw();
    db.with_read_transaction(|conn| {
        let duplicate_ids = [revisions[0].clone(), revisions[0].clone()];
        let mut reservations = Vec::new();
        read_and_pack_native_a2_context_in_tx(
            conn,
            request(&duplicate_ids, &raw, 100_000),
            &mut NativePackingInputBudget::default(),
            &mut |total| {
                reservations.push(total);
                Ok(())
            },
            &mut || Ok(()),
        )?;
        assert_eq!(reservations.len(), 1);
        let first_size = reservations[0];
        let mut shared = NativePackingInputBudget::default();
        let error = read_and_pack_native_a2_context_in_tx(
            conn,
            request(&revisions, &raw, 100_000),
            &mut shared,
            &mut |total| {
                ensure!(
                    total <= first_size,
                    "test-retained-authority-budget-exhausted"
                );
                Ok(())
            },
            &mut || Ok(()),
        )
        .err()
        .ok_or_else(|| anyhow::anyhow!("authority budget reset between Revisions"))?;
        assert_eq!(
            error.to_string(),
            "test-retained-authority-budget-exhausted"
        );
        assert_eq!(shared.retained_binding_bytes, first_size);
        Ok(())
    })
}

#[test]
fn pooled_read_control_is_cumulative_and_failure_keeps_the_outer_owner() -> Result<()> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    let db = current_schema_memory()?;
    let revisions = fixture(&db)?;
    let raw = raw();
    db.with_read_transaction(|conn| {
        let progress = Arc::new(AtomicUsize::new(0));
        let observer = Arc::clone(&progress);
        crate::narrative_extraction::nir1_capacity::set_progress_owner(
            conn,
            1,
            Some(move || {
                observer.fetch_add(1, Ordering::Relaxed);
                false
            }),
        )?;
        let mut single_checkpoints = 0;
        read_and_pack_native_a2_context_in_tx(
            conn,
            request(&revisions[..1], &raw, 100_000),
            &mut NativePackingInputBudget::default(),
            &mut |_| Ok(()),
            &mut || {
                single_checkpoints += 1;
                Ok(())
            },
        )?;
        assert!(progress.load(Ordering::Relaxed) > 0);
        let mut pooled_checkpoints = 0;
        let error = read_and_pack_native_a2_context_in_tx(
            conn,
            request(&revisions, &raw, 100_000),
            &mut NativePackingInputBudget::default(),
            &mut |_| Ok(()),
            &mut || {
                pooled_checkpoints += 1;
                ensure!(
                    pooled_checkpoints <= single_checkpoints,
                    "test-read-budget-exhausted"
                );
                Ok(())
            },
        )
        .err()
        .ok_or_else(|| anyhow::anyhow!("caller read budget unexpectedly reset"))?;
        assert_eq!(error.to_string(), "test-read-budget-exhausted");
        assert!(!conn.is_autocommit());
        let previous = progress.load(Ordering::Relaxed);
        let _: i64 = conn.query_row("SELECT COUNT(*) FROM codex_entries", [], |row| row.get(0))?;
        assert!(progress.load(Ordering::Relaxed) > previous);
        crate::narrative_extraction::nir1_capacity::set_progress_owner(
            conn,
            0,
            None::<fn() -> bool>,
        )?;
        Ok(())
    })
}

#[test]
fn pooled_revisions_keep_one_wal_snapshot_and_require_later_currentness() -> Result<()> {
    let path = std::env::temp_dir().join(format!(
        "grimodex-nir1-pooled-snapshot-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let template = current_schema_memory()?;
    let db = Database::new(&path)?;
    {
        let source = template.lock()?;
        let mut destination = db.lock()?;
        let backup = rusqlite::backup::Backup::new(&source, &mut destination)?;
        ensure!(matches!(
            backup.step(-1)?,
            rusqlite::backup::StepResult::Done
        ));
    }
    let revisions = fixture(&db)?;
    let raw = raw();
    let writer = Database::new(&path)?;
    let mut checkpoints = 0;
    let pooled = db.with_read_transaction(|conn| {
        read_and_pack_native_a2_context_in_tx(
            conn,
            request(&revisions, &raw, 100_000),
            &mut NativePackingInputBudget::default(),
            &mut |_| Ok(()),
            &mut || {
                checkpoints += 1;
                // The third checkpoint follows the first exact A2/A3 read.
                // Commit from a distinct WAL connection before reading Revision 2.
                if checkpoints == 3 {
                    writer.with_conn(|writer| {
                        writer.execute(
                            "UPDATE codex_entries SET summary='Changed Source',
                                 updated_at='2026-09-22T18:00:00Z' WHERE id='nir1-alice'",
                            [],
                        )?;
                        Ok(())
                    })?;
                }
                Ok(())
            },
        )
    })?;
    assert_eq!(pooled.bindings.len(), 2);
    assert!(pooled
        .bindings
        .iter()
        .all(|binding| { binding.revision().bundle.entities[0].evidence[0].quote == "Alice" }));
    assert_eq!(pooled.selected_items.len(), 31);
    let error = db
        .with_read_transaction(|conn| {
            read_and_pack_native_a2_context_in_tx(
                conn,
                request(&revisions, &raw, 100_000),
                &mut NativePackingInputBudget::default(),
                &mut |_| Ok(()),
                &mut || Ok(()),
            )
        })
        .err()
        .ok_or_else(|| anyhow::anyhow!("new transaction accepted the stale Source"))?;
    assert!(error.to_string().contains("NIR1_NATIVE_A2_UNAVAILABLE"));
    drop(writer);
    drop(db);
    std::fs::remove_file(path)?;
    Ok(())
}

#[test]
fn pooled_qualification_never_projects_private_decision_annotations() -> Result<()> {
    let db = current_schema_memory()?;
    seed_run_and_catalog(&db)?;
    prepare_a3_scope_fixture(&db)?;
    run_incremental_freshness_cycle(&db)?;
    let created = create_nir1_entity_relation_revision(
        &db,
        request_for_run(&db, "nir1-run", "pooled-canary"),
    )?;
    let revision_id = created["revisionId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("canary revision missing"))?
        .to_owned();
    let proposal_id = created["proposalId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("canary proposal missing"))?
        .to_owned();
    const CANARY: &str = "D1_PRIVATE_DECISION_CANARY_MUST_NOT_REACH_MODEL";
    let large_private_note = CANARY.repeat(1_000);
    crate::narrative_extraction::narrative_extraction_append_human_decision(
        &db,
        crate::narrative_extraction::AppendDecisionPayload {
            run_id: "nir1-run".into(),
            project_id: "default-project".into(),
            proposal_id,
            revision_id: revision_id.clone(),
            decision: "approved".into(),
            decision_json: Some(json!({ "reviewerNote": large_private_note })),
            created_by: Some("renderer-reviewer".into()),
        },
    )?;
    let raw = raw();
    let mut retained_bytes = 0;
    let pooled = db.with_read_transaction(|conn| {
        read_and_pack_native_a2_context_in_tx(
            conn,
            request(&[revision_id], &raw, 100_000),
            &mut NativePackingInputBudget::default(),
            &mut |total| {
                retained_bytes = total;
                Ok(())
            },
            &mut || Ok(()),
        )
    })?;
    assert!(pooled.bindings[0]
        .decision()
        .decision_json()
        .contains(CANARY));
    assert!(retained_bytes > large_private_note.len() * 2);
    assert!(pooled.selected_items.iter().all(|selected| {
        match selected.item() {
            ContextItemKind::Raw { text, .. } | ContextItemKind::AcceptedIr { text, .. } => {
                !text.contains(CANARY)
            }
            _ => false,
        }
    }));
    Ok(())
}

/// X1-3 test 17. A Revision binds its anchor's Scene Scope projection (and no
/// project Scope token), so moving or saving another Scene does not stop a new
/// request from qualifying it, and the sealed basis a request qualifies carries
/// the projection Source and no `project-scope-authority` Source.
#[test]
fn x13_new_request_qualifies_after_other_scene_save() -> Result<()> {
    use crate::narrative_extraction::scope_storage_authority_tests::{patch, save_body};
    let db = current_schema_memory()?;
    seed_run_and_catalog(&db)?;
    prepare_a3_scope_fixture(&db)?;
    run_incremental_freshness_cycle(&db)?;
    let created =
        create_nir1_entity_relation_revision(&db, request_for_run(&db, "nir1-run", "x13-qualify"))?;
    approve_typed_revision(&db, "nir1-run", &created)?;
    let revision_id = created["revisionId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("revision missing"))?
        .to_owned();
    let pack = |db: &Database| {
        let raw = raw();
        let ids = [revision_id.clone()];
        db.with_read_transaction(|conn| {
            read_and_pack_native_a2_context_in_tx(
                conn,
                request(&ids, &raw, 100_000),
                &mut NativePackingInputBudget::default(),
                &mut |_| Ok(()),
                &mut || Ok(()),
            )
        })
    };
    let before = pack(&db)?;
    assert_eq!(before.bindings.len(), 1, "the Revision qualifies");
    let basis = &before.bindings[0].revision().material_basis.source_basis;
    assert!(basis
        .iter()
        .any(|source| source.source_kind == "scene-scope-projection-v1"
            && source.source_key == "project:scene-scope-projection:nir1"));
    assert!(basis
        .iter()
        .all(|source| source.source_kind != "project-scope-authority"));

    // Another Scene is saved and moved: the project token moves, the anchor's
    // projection does not.
    save_body(&db, "a3-source", "other", "2026-10-18T02:00:00.000Z")?;
    patch(
        &db,
        "a3-source",
        "other-move",
        "sortOrder",
        serde_json::json!("a5"),
        true,
        "2026-10-18T02:00:01.000Z",
    )?;
    while matches!(
        run_incremental_freshness_cycle(&db)?,
        crate::narrative_extraction::incremental_freshness::IncrementalFreshnessCycleOutcome::Processed(_)
    ) {}
    let after = pack(&db)?;
    assert_eq!(after.bindings.len(), 1, "a new request still qualifies it");
    assert_eq!(
        after.bindings[0].revision().material_basis.source_basis,
        before.bindings[0].revision().material_basis.source_basis,
    );
    Ok(())
}

#[test]
fn pooled_helper_refuses_autocommit_before_reading_material() -> Result<()> {
    let db = current_schema_memory()?;
    db.with_conn(|conn| {
        let error = read_and_pack_native_a2_context_in_tx(
            conn,
            request(&["unread-revision".into()], &raw(), 100_000),
            &mut NativePackingInputBudget::default(),
            &mut |_| Ok(()),
            &mut || anyhow::bail!("autocommit must fail before caller work"),
        )
        .err()
        .ok_or_else(|| anyhow::anyhow!("autocommit unexpectedly accepted"))?;
        assert_eq!(
            error.to_string(),
            "NIR1_NATIVE_PACKING_REQUIRES_READ_TRANSACTION"
        );
        Ok(())
    })
}

#[test]
fn pooled_unqualified_revision_input_is_bounded_before_read_control() -> Result<()> {
    let db = current_schema_memory()?;
    db.with_read_transaction(|conn| {
        for (ids, expected) in [
            (
                vec!["not-a-revision".into(); MAX_PACKING_ITEMS + 1],
                "MAX_PACKING_ITEMS",
            ),
            (
                vec![" ".repeat(MAX_PACKING_INPUT_BYTES + 1)],
                "MAX_PACKING_INPUT_BYTES",
            ),
        ] {
            let error = read_and_pack_native_a2_context_in_tx(
                conn,
                request(&ids, &raw(), 100_000),
                &mut NativePackingInputBudget::default(),
                &mut |_| anyhow::bail!("oversized input must not reserve authority"),
                &mut || anyhow::bail!("oversized input must not enter read control"),
            )
            .err()
            .ok_or_else(|| anyhow::anyhow!("unqualified input envelope unexpectedly accepted"))?;
            assert!(error.to_string().contains(expected), "{error}");
        }
        Ok(())
    })
}

#[cfg(feature = "native-current-human-capture")]
pub(in crate::narrative_extraction) struct PreparedWorkspace {
    state: crate::state::WorkspaceState,
    path: std::path::PathBuf,
}

#[cfg(feature = "native-current-human-capture")]
impl PreparedWorkspace {
    pub(in crate::narrative_extraction) fn new(db: Database) -> Result<Self> {
        Self::with_identity(
            db,
            Some(
                crate::nir1_generation::history_context::DurableWorkspaceIdentity::from_parts(
                    "prepared-test-workspace",
                    "/prepared/test/canonical/root",
                )?,
            ),
        )
    }

    fn without_identity(db: Database) -> Result<Self> {
        Self::with_identity(db, None)
    }

    fn with_identity(
        db: Database,
        identity: Option<crate::nir1_generation::history_context::DurableWorkspaceIdentity>,
    ) -> Result<Self> {
        use crate::state::{ActiveWorkspace, WorkspaceAuthority};
        use crate::workspace_lifecycle::LiveBinding;
        use std::sync::Mutex;

        let path = std::env::temp_dir().join(format!(
            "grimodex-nir1-prepared-db-test-{}",
            uuid::Uuid::new_v4()
        ));
        let authority = WorkspaceAuthority::from_database_for_test(db, path.clone())?;
        let authority_instance = authority.identity();
        let state = crate::state::WorkspaceState {
            inner: Mutex::new(Some(ActiveWorkspace::new(authority))),
            safe_mode: crate::recovery::SafeModeState::default(),
            switching: crate::WorkspaceLifecycleCompatibilityView::new(false),
            open_lock: Mutex::new(Default::default()),
        };
        state.lifecycle_core().set_ready(
            LiveBinding::new(
                path.to_string_lossy(),
                format!("prepared-test:{authority_instance}"),
                authority_instance,
                0,
            )
            .with_durable_workspace_identity(identity),
        )?;
        Ok(Self { state, path })
    }

    pub(in crate::narrative_extraction) fn snapshot(
        &self,
    ) -> Result<crate::state::ActiveWorkspaceSnapshot> {
        Ok(crate::state::active_workspace_snapshot(&self.state)?)
    }
}

#[cfg(feature = "native-current-human-capture")]
impl Drop for PreparedWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

#[cfg(feature = "native-current-human-capture")]
pub(in crate::narrative_extraction) fn prepared_sql_budget() -> crate::ParticipantSqlOperationBudget
{
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    crate::ParticipantSqlOperationBudget::new(
        Arc::new(AtomicBool::new(false)),
        Instant::now() + Duration::from_secs(20),
        Duration::from_millis(100),
    )
}

#[cfg(feature = "native-current-human-capture")]
fn add_prepared_human_message(
    workspace: &crate::state::ActiveWorkspaceSnapshot,
    user_message: &str,
) -> Result<crate::nir1_generation::AcceptedChatInputCapture> {
    use crate::nir1_generation::{
        accept_current_human_chat_input, ChatInputCaptureOwner, NewChatInputSubmission,
    };

    const SESSION: &str = "nir1-prepared-db-session";
    const MESSAGE: &str = "nir1-prepared-db-human";
    workspace.db().db().with_conn(|conn| {
        conn.execute(
            "INSERT INTO chat_sessions(id,project_id,node_id)
             VALUES (?1,'default-project',?2)",
            params![SESSION, RAW_SOURCE_SCENE],
        )?;
        Ok(())
    })?;
    let locator = workspace.path().to_string_lossy().into_owned();
    let authority = workspace.db().identity();
    let owner = ChatInputCaptureOwner::new(
        "nir1-prepared-db-profile".into(),
        "nir1-prepared-db-caller".into(),
        1,
        1,
        locator.clone(),
        "nir1-db-caller-session".into(),
        format!("prepared-test:{authority}"),
        locator,
        authority,
        0,
        0,
    )?;
    let submission = NewChatInputSubmission::new(
        "nir1-prepared-db-submission".into(),
        MESSAGE.into(),
        SESSION.into(),
        RAW_SOURCE_SCENE.into(),
        user_message.into(),
        "2026-09-26T10:00:00.000Z".into(),
    )?;
    Ok(accept_current_human_chat_input(
        workspace,
        &owner,
        &submission,
        prepared_sql_budget(),
    )?)
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn prepared_projection_uses_captured_human_current_raw_and_typed_approved_revisions() -> Result<()>
{
    use crate::narrative_extraction::{
        read_and_pack_native_nir1_prepared_inputs, revalidate_native_nir1_prepared_inputs,
    };
    use crate::nir1_generation::{InputRole, InputTarget, QualificationKind};

    const CANARY: &str = "PREPARED_DB_PRIVATE_DECISION_CANARY";
    let db = current_schema_memory()?;
    let source_body = "Current Source body — keep it intact.";
    let storage = json!({
        "type": "doc",
        "content": [{"type":"paragraph","content":[{"type":"text","text":source_body}]}]
    })
    .to_string();
    let revisions = fixture_with_query_source_and_decision_note(&db, Some(&storage), Some(CANARY))?;
    let workspace = PreparedWorkspace::new(db)?;
    let snapshot = workspace.snapshot()?;
    let message_version_id =
        add_prepared_human_message(&snapshot, "Captured human request for the current scene.")?;
    let projection = read_and_pack_native_nir1_prepared_inputs(
        &snapshot,
        PackingPurpose::Writing,
        crate::nir1_generation::history_context::HistorySendClassification::LocalOnly,
        "nir1-prepared-db-session",
        &message_version_id,
        RAW_SOURCE_SCENE,
        &revisions,
        prepared_sql_budget(),
        |_| Ok(100_000),
    )?;

    assert_eq!(projection.query_scene_id(), RAW_SOURCE_SCENE);
    assert_eq!(
        projection.user_message(),
        "Captured human request for the current scene."
    );
    let references = projection.input_references();
    assert_eq!(references[0].role, InputRole::User);
    assert!(matches!(
        &references[0].target,
        InputTarget::Message { version_id, parent_attempt_id: None }
            if version_id.as_str() == message_version_id.message_version_id()
    ));
    let raw_reference_ordinal = references
        .iter()
        .position(|reference| matches!(&reference.target, InputTarget::RawSource { .. }))
        .context("current Source input reference missing")?;
    assert!(projection.context_items().iter().any(|item| {
        item.input_ordinal() == raw_reference_ordinal && item.text() == source_body
    }));
    for item in projection.context_items() {
        let reference = references
            .get(item.input_ordinal())
            .context("context input ordinal is out of range")?;
        assert!(matches!(
            &reference.target,
            InputTarget::RawSource { .. } | InputTarget::AcceptedRevision { .. }
        ));
    }
    assert!(references.iter().any(|reference| match &reference.target {
        InputTarget::AcceptedRevision { revision_id, .. } => revisions.contains(revision_id),
        _ => false,
    }));
    for kind in [
        QualificationKind::Source,
        QualificationKind::Revision,
        QualificationKind::Decision,
        QualificationKind::Freshness,
        QualificationKind::Scope,
    ] {
        assert!(projection
            .qualifications()
            .iter()
            .any(|item| item.kind == kind));
    }
    assert!(projection
        .context_items()
        .iter()
        .all(|item| !item.text().contains(CANARY)));
    revalidate_native_nir1_prepared_inputs(
        &snapshot,
        "nir1-prepared-db-session",
        &projection,
        prepared_sql_budget(),
    )?;

    snapshot.db().db().with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes SET content=?1, version=version+1,
                    updated_at='2026-09-24T12:00:00.000Z'
              WHERE project_id=?2 AND id=?3 AND node_type='scene'",
            params![
                json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Changed Source body."}]}]}).to_string(),
                RAW_SOURCE_PROJECT,
                RAW_SOURCE_SCENE
            ],
        )?;
        Ok(())
    })?;
    let stale = revalidate_native_nir1_prepared_inputs(
        &snapshot,
        "nir1-prepared-db-session",
        &projection,
        prepared_sql_budget(),
    )
    .err()
    .context("fresh transaction accepted stale Source")?;
    assert_eq!(stale.to_string(), "NIR1_NATIVE_RAW_SOURCE_STALE");
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn prepared_projection_revalidates_large_captured_human_after_single_charge() -> Result<()> {
    use crate::narrative_extraction::{
        read_and_pack_native_nir1_prepared_inputs, revalidate_native_nir1_prepared_inputs,
    };
    use crate::nir1_generation::{InputTarget, QualificationKind};

    const HUMAN_BODY_BYTES: usize = 1_100_000;
    let db = current_schema_memory()?;
    let storage = json!({
        "type": "doc",
        "content": [{"type":"paragraph","content":[{"type":"text","text":"Small current Source."}]}]
    })
    .to_string();
    let revisions = fixture_with_query_source(&db, Some(&storage))?;
    let workspace = PreparedWorkspace::new(db)?;
    let snapshot = workspace.snapshot()?;
    let human_message = "x".repeat(HUMAN_BODY_BYTES);
    assert!(human_message.len() > estimate_nir1_context_tokens(&human_message));
    let capture = add_prepared_human_message(&snapshot, &human_message)?;
    let projection = read_and_pack_native_nir1_prepared_inputs(
        &snapshot,
        PackingPurpose::Writing,
        crate::nir1_generation::history_context::HistorySendClassification::LocalOnly,
        "nir1-prepared-db-session",
        &capture,
        RAW_SOURCE_SCENE,
        &revisions[..1],
        prepared_sql_budget(),
        |_| Ok(100_000),
    )?;

    assert_eq!(projection.user_message().len(), HUMAN_BODY_BYTES);
    assert!(projection.context_items().iter().any(|item| {
        item.text() == "Small current Source."
            && matches!(
                &projection.input_references()[item.input_ordinal()].target,
                InputTarget::RawSource { .. }
            )
    }));
    assert!(projection
        .input_references()
        .iter()
        .any(|reference| matches!(&reference.target, InputTarget::AcceptedRevision { .. })));
    assert!(projection
        .qualifications()
        .iter()
        .any(|item| item.kind == QualificationKind::Source));
    assert!(projection
        .qualifications()
        .iter()
        .any(|item| item.kind == QualificationKind::Revision));

    revalidate_native_nir1_prepared_inputs(
        &snapshot,
        "nir1-prepared-db-session",
        &projection,
        prepared_sql_budget(),
    )?;
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn prepared_projection_rejects_human_over_one_copy_input_byte_limit() -> Result<()> {
    use crate::narrative_extraction::read_and_pack_native_nir1_prepared_inputs;

    let db = current_schema_memory()?;
    let storage = json!({
        "type": "doc",
        "content": [{"type":"paragraph","content":[{"type":"text","text":"Small current Source."}]}]
    })
    .to_string();
    let revisions = fixture_with_query_source(&db, Some(&storage))?;
    let workspace = PreparedWorkspace::new(db)?;
    let snapshot = workspace.snapshot()?;
    let capture = add_prepared_human_message(&snapshot, &"x".repeat(MAX_PACKING_INPUT_BYTES))?;
    let error = read_and_pack_native_nir1_prepared_inputs(
        &snapshot,
        PackingPurpose::Writing,
        crate::nir1_generation::history_context::HistorySendClassification::LocalOnly,
        "nir1-prepared-db-session",
        &capture,
        RAW_SOURCE_SCENE,
        &revisions[..1],
        prepared_sql_budget(),
        |_| Ok(100_000),
    )
    .err()
    .ok_or_else(|| anyhow::anyhow!("one-copy MAX_PACKING_INPUT_BYTES limit was relaxed"))?;
    assert!(error.to_string().contains("MAX_PACKING_INPUT_BYTES"));
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn prepared_projection_rejects_empty_context_budget_before_selecting_material() -> Result<()> {
    use crate::narrative_extraction::read_and_pack_native_nir1_prepared_inputs;

    let db = current_schema_memory()?;
    let storage = json!({
        "type": "doc",
        "content": [{"type":"paragraph","content":[{"type":"text","text":"Budget fixture source."}]}]
    })
    .to_string();
    let revisions = fixture_with_query_source(&db, Some(&storage))?;
    let workspace = PreparedWorkspace::new(db)?;
    let snapshot = workspace.snapshot()?;
    let message_version_id =
        add_prepared_human_message(&snapshot, "Captured human request for the current scene.")?;
    let error = read_and_pack_native_nir1_prepared_inputs(
        &snapshot,
        PackingPurpose::Writing,
        crate::nir1_generation::history_context::HistorySendClassification::LocalOnly,
        "nir1-prepared-db-session",
        &message_version_id,
        RAW_SOURCE_SCENE,
        &revisions,
        prepared_sql_budget(),
        |_| Ok(0),
    )
    .err()
    .context("zero context budget unexpectedly selected inputs")?;
    assert_eq!(
        error.to_string(),
        "NIR1_NATIVE_PREPARED_CONTEXT_BUDGET_EMPTY"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// DF+-a: the D-final output follows the completeness rule (K4/3 section 3)
// ---------------------------------------------------------------------------

#[cfg(feature = "native-current-human-capture")]
pub(in crate::narrative_extraction) struct DfFinalFixture {
    pub(in crate::narrative_extraction) _workspace: PreparedWorkspace,
    pub(in crate::narrative_extraction) snapshot: crate::state::ActiveWorkspaceSnapshot,
    pub(in crate::narrative_extraction) revisions: Vec<String>,
    pub(in crate::narrative_extraction) capture: crate::nir1_generation::AcceptedChatInputCapture,
}

#[cfg(feature = "native-current-human-capture")]
impl DfFinalFixture {
    pub(in crate::narrative_extraction) fn new() -> Result<Self> {
        let db = current_schema_memory()?;
        let storage = json!({
            "type": "doc",
            "content": [{"type":"paragraph","content":[{"type":"text","text":"Current Source body."}]}]
        })
        .to_string();
        let revisions = fixture_with_query_source(&db, Some(&storage))?;
        let workspace = PreparedWorkspace::new(db)?;
        let snapshot = workspace.snapshot()?;
        let capture =
            add_prepared_human_message(&snapshot, "Captured human request for the current scene.")?;
        Ok(Self {
            _workspace: workspace,
            snapshot,
            revisions,
            capture,
        })
    }

    /// The public D-final projection.
    pub(in crate::narrative_extraction) fn project(&self) -> Result<NativeNir1PreparedInputs> {
        crate::narrative_extraction::read_and_pack_native_nir1_prepared_inputs(
            &self.snapshot,
            PackingPurpose::Writing,
            crate::nir1_generation::history_context::HistorySendClassification::LocalOnly,
            "nir1-prepared-db-session",
            &self.capture,
            RAW_SOURCE_SCENE,
            &self.revisions,
            prepared_sql_budget(),
            |_| Ok(100_000),
        )
    }

    /// The same read as `read_and_pack_native_nir1_prepared_inputs`, with a
    /// hook on the packed bindings (to model a Revision-side inconsistency
    /// that the A2 reader would otherwise catch first).
    pub(super) fn project_with_bindings(
        &self,
        mutate: impl FnOnce(&mut Vec<NativeNir1AuthorityBinding>),
    ) -> Result<NativeNir1PreparedInputs> {
        let mut mutate = Some(mutate);
        let mut input_budget = NativePackingInputBudget::default();
        self.snapshot
            .db()
            .with_participant_read_transaction_bounded(
                self.snapshot.participant(),
                prepared_sql_budget(),
                |conn| {
                    let (version, message) = read_current_chat_input_capture_in_tx(
                        conn,
                        &self.capture,
                        self.capture.owner(),
                        |version_id_bytes, body_bytes| {
                            input_budget.reserve_lengths(version_id_bytes, body_bytes, 0)
                        },
                    )?;
                    let project_id = version.project_id.clone();
                    let mut reserve = |_bytes| Ok(());
                    let mut pooled = read_and_pack_native_a2_context_with_current_source_in_tx(
                        conn,
                        NativeNir1SourcePooledPackingRequest {
                            project_id: &project_id,
                            revision_ids: &self.revisions,
                            query_scene_id: RAW_SOURCE_SCENE,
                            budget_tokens: 100_000,
                            purpose: PackingPurpose::Writing,
                            graph: None,
                        },
                        &mut input_budget,
                        &mut reserve,
                        &mut || Ok(()),
                    )?;
                    (mutate.take().expect("single use"))(&mut pooled.bindings);
                    let history_context = build_history_context_stage(
                        conn,
                        &project_id,
                        RAW_SOURCE_SCENE,
                        self.snapshot.durable_workspace_identity(),
                        crate::nir1_generation::history_context::HistorySendClassification::LocalOnly,
                    )?;
                    build_native_nir1_prepared_inputs(
                        self.capture.clone(),
                        project_id,
                        RAW_SOURCE_SCENE.to_owned(),
                        version,
                        message,
                        pooled,
                        history_context,
                        &mut || Ok(()),
                    )
                },
            )
    }
}

#[cfg(feature = "native-current-human-capture")]
fn rows_of(
    qualifications: &[QualificationReference],
    ordinal: usize,
) -> Vec<&QualificationReference> {
    qualifications
        .iter()
        .filter(|row| row.input_ordinal == ordinal)
        .collect()
}

#[cfg(feature = "native-current-human-capture")]
fn revision_ordinals(projection: &NativeNir1PreparedInputs) -> Vec<(usize, String)> {
    projection
        .input_references()
        .iter()
        .enumerate()
        .filter_map(|(ordinal, input)| match &input.target {
            InputTarget::AcceptedRevision { revision_id, .. } => {
                Some((ordinal, revision_id.clone()))
            }
            _ => None,
        })
        .collect()
}

#[cfg(feature = "native-current-human-capture")]
fn binding_for<'a>(
    projection: &'a NativeNir1PreparedInputs,
    revision_id: &str,
) -> &'a NativeNir1AuthorityBinding {
    projection
        .authority_bindings()
        .iter()
        .find(|binding| binding.revision_id() == revision_id)
        .expect("binding of the adopted Revision")
}

/// Distinct source keys of the sealed material basis.
#[cfg(feature = "native-current-human-capture")]
fn basis_source_keys(binding: &NativeNir1AuthorityBinding) -> Vec<(String, String)> {
    let basis = &binding.revision().material_basis;
    let mut keys: Vec<(String, String)> = basis
        .source_basis
        .iter()
        .map(|source| (source.source_key.clone(), source.revision_token.clone()))
        .chain(
            basis
                .evidence_set
                .iter()
                .map(|evidence| (evidence.source_key.clone(), evidence.revision_token.clone())),
        )
        .collect();
    keys.sort();
    keys.dedup();
    keys
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn df_final_output_satisfies_completeness_rule() -> Result<()> {
    use crate::nir1_generation::CompletenessReason;

    let fixture = DfFinalFixture::new()?;
    let projection = fixture.project()?;
    // Human, Raw and the two fixture Revisions.
    assert_eq!(projection.input_references().len(), 4);
    assert!(projection.excluded_revisions().is_empty());
    // The producer's rows lack only the D1 selection, which the render adds.
    let violation = projection
        .check_completeness(projection.qualifications())
        .expect_err("D1 is added after the render");
    assert_eq!(violation.kind, Some(QualificationKind::D1));
    assert_eq!(violation.reason, CompletenessReason::MissingKind);
    let finalized = projection.finalize_qualifications(100_000)?;
    projection
        .check_completeness(&finalized.qualifications)
        .map_err(|violation| anyhow::anyhow!("{violation}"))?;
    // One D1 selection reference for every input but the current Human.
    let d1_rows = finalized
        .qualifications
        .iter()
        .filter(|row| row.kind == QualificationKind::D1 && row.identity().is_some())
        .count();
    assert_eq!(d1_rows, projection.input_references().len() - 1);
    // S6 measured 0 (Human), 1 (Raw) and 16 (each Revision) rows; the rule
    // adds Human 8 (Source, 2 Scope, 5 N/A), Raw 8 (Source, 2 Scope, 4 N/A,
    // D1) and, per Revision, the Index N/A and D1: 11 + 2E + Rel + 2.
    assert_eq!(rows_of(&finalized.qualifications, 0).len(), 8);
    assert_eq!(rows_of(&finalized.qualifications, 1).len(), 8);
    for (ordinal, revision_id) in revision_ordinals(&projection) {
        let binding = binding_for(&projection, &revision_id);
        let bundle = &binding.revision().bundle;
        let (entities, relations) = (bundle.entities.len(), bundle.relations.len());
        assert_eq!(
            rows_of(&finalized.qualifications, ordinal).len(),
            11 + 2 * entities + relations + 2,
            "Revision {revision_id} (E={entities}, Rel={relations})"
        );
    }
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn df_final_human_has_source_scope_and_five_typed_na() -> Result<()> {
    use crate::nir1_generation::{NotApplicableReason as Na, ScopeRole};

    let fixture = DfFinalFixture::new()?;
    let projection = fixture.project()?;
    assert_eq!(
        projection.input_references()[0].input_use,
        InputUse::CurrentTurn
    );
    let human = rows_of(projection.qualifications(), 0);
    let version = projection.user_message_version();
    let source = human
        .iter()
        .filter(|row| row.kind == QualificationKind::Source)
        .collect::<Vec<_>>();
    assert_eq!(source.len(), 1);
    assert_eq!(source[0].identity(), Some(version.id.as_str()));
    assert_eq!(source[0].version(), Some(version.body_digest.as_str()));
    let scene_scope = projection.authority_bindings()[0].scope();
    let scope = human
        .iter()
        .filter(|row| row.kind == QualificationKind::Scope)
        .map(|row| {
            (
                row.scope_role(),
                row.identity().map(str::to_owned),
                row.version().map(str::to_owned),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        scope,
        vec![
            (
                Some(ScopeRole::QuerySceneScope),
                Some(format!("scene:{RAW_SOURCE_SCENE}")),
                Some(scene_scope.query_scene_scope_token().to_owned())
            ),
            (
                Some(ScopeRole::QuerySceneIncarnation),
                Some(format!("scene-incarnation:{RAW_SOURCE_SCENE}")),
                Some(scene_scope.query_scene_incarnation_id().to_owned())
            ),
        ]
    );
    let mut na = human
        .iter()
        .filter_map(|row| row.not_applicable_reason().map(|reason| (row.kind, reason)))
        .collect::<Vec<_>>();
    na.sort();
    let mut expected = vec![
        (QualificationKind::Revision, Na::NotARevision),
        (QualificationKind::Decision, Na::HumanAuthored),
        (QualificationKind::Freshness, Na::ImmutableMessageVersion),
        (QualificationKind::Index, Na::NotIndexDerived),
        (QualificationKind::D1, Na::FixedUserSlot),
    ];
    expected.sort();
    assert_eq!(na, expected);
    assert_eq!(human.len(), 8);

    // The target Scene body (Raw): Source and Scope, four typed N/A (the D1
    // selection follows the render).
    let raw = rows_of(projection.qualifications(), 1);
    let raw_binding = projection.raw_source_binding().binding();
    assert!(raw.iter().any(|row| row.kind == QualificationKind::Source
        && row.identity() == Some(raw_binding.source_key.as_str())
        && row.version() == Some(raw_binding.revision_token.as_str())));
    assert_eq!(
        raw_binding.source_key,
        format!("project:scene:{RAW_SOURCE_SCENE}")
    );
    let mut raw_na = raw
        .iter()
        .filter_map(|row| row.not_applicable_reason().map(|reason| (row.kind, reason)))
        .collect::<Vec<_>>();
    raw_na.sort();
    let mut raw_expected = vec![
        (QualificationKind::Revision, Na::NotARevision),
        (QualificationKind::Decision, Na::ManuscriptSource),
        (
            QualificationKind::Freshness,
            Na::TargetSceneBodyNotADependency,
        ),
        (QualificationKind::Index, Na::NotIndexDerived),
    ];
    raw_expected.sort();
    assert_eq!(raw_na, raw_expected);
    assert_eq!(
        raw.iter()
            .filter(|row| row.kind == QualificationKind::Scope)
            .count(),
        2
    );
    assert_eq!(
        projection.input_references()[1].input_use,
        InputUse::SelectedMaterial
    );
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn df_final_revision_keeps_all_sources_and_scopes() -> Result<()> {
    let fixture = DfFinalFixture::new()?;
    let projection = fixture.project()?;
    let finalized = projection.finalize_qualifications(100_000)?;
    let revisions = revision_ordinals(&projection);
    assert_eq!(revisions.len(), 2);
    for (ordinal, revision_id) in revisions {
        let binding = binding_for(&projection, &revision_id);
        let rows = rows_of(&finalized.qualifications, ordinal);
        // Every distinct Source of the material basis and Evidence stays.
        let mut sources = rows
            .iter()
            .filter(|row| row.kind == QualificationKind::Source)
            .map(|row| {
                (
                    row.identity().expect("present").to_owned(),
                    row.version().expect("present").to_owned(),
                )
            })
            .collect::<Vec<_>>();
        sources.sort();
        let expected_sources = basis_source_keys(binding);
        assert!(
            expected_sources.len() > 1,
            "the fixture must have several Sources"
        );
        assert_eq!(sources, expected_sources);
        // All Scope references: six singletons, one typed scope per Entity and
        // one proof per material Scene proof; none collapsed.
        let scope = binding.scope();
        let scope_count = rows
            .iter()
            .filter(|row| row.kind == QualificationKind::Scope)
            .count();
        assert_eq!(
            scope_count,
            6 + scope.typed_scope_bindings().len() + scope.material_scene_proofs().len()
        );
        assert!(scope.typed_scope_bindings().len() > 1);
        // The other kinds: one reference each, the Index as a typed N/A.
        for (kind, count) in [
            (QualificationKind::Revision, 1usize),
            (QualificationKind::Decision, 1),
            (QualificationKind::Freshness, 1),
            (QualificationKind::D1, 1),
        ] {
            assert_eq!(
                rows.iter()
                    .filter(|row| row.kind == kind && row.identity().is_some())
                    .count(),
                count,
                "{kind:?}"
            );
        }
        assert!(rows.iter().any(|row| row.kind == QualificationKind::Index
            && row.not_applicable_reason()
                == Some(crate::nir1_generation::NotApplicableReason::NotIndexDerived)));
    }
    // Collapsing a Revision's Sources to one reference is incomplete.
    let (ordinal, _) = revision_ordinals(&projection)[0].clone();
    let mut collapsed = finalized.qualifications.clone();
    let mut kept_one = false;
    collapsed.retain(|row| {
        if row.input_ordinal == ordinal && row.kind == QualificationKind::Source {
            let keep = !kept_one;
            kept_one = true;
            keep
        } else {
            true
        }
    });
    let violation = projection
        .check_completeness(&collapsed)
        .expect_err("a collapsed Source set is incomplete");
    assert_eq!(
        violation.reason,
        crate::nir1_generation::CompletenessReason::ExpectedTargetMissing
    );
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn df_final_scope_refs_carry_closed_role() -> Result<()> {
    use crate::nir1_generation::{classify_reference, parse_scope_identity, ReferenceClass};
    use std::collections::BTreeSet;

    let fixture = DfFinalFixture::new()?;
    let projection = fixture.project()?;
    for (ordinal, _) in revision_ordinals(&projection) {
        let mut roles = BTreeSet::new();
        for row in rows_of(projection.qualifications(), ordinal) {
            if row.kind != QualificationKind::Scope {
                assert_eq!(row.scope_role(), None, "a role only on Scope references");
                continue;
            }
            let role = row.scope_role().context("a Scope reference has a role")?;
            roles.insert(role);
            // The identity follows the role's grammar, not the other way round.
            assert!(
                parse_scope_identity(role, row.identity().context("present")?).is_some(),
                "{role:?} {:?}",
                row.identity()
            );
            assert!(classify_reference(QualificationKind::Scope, Some(role)).is_some());
        }
        let expected: BTreeSet<ScopeRole> = [
            ScopeRole::ProjectAuthority,
            ScopeRole::QuerySceneScope,
            ScopeRole::QuerySceneSource,
            ScopeRole::QuerySceneIncarnation,
            ScopeRole::RevealState,
            ScopeRole::ScopeAxis,
            ScopeRole::TypedScope,
        ]
        .into_iter()
        .chain(
            (!projection.authority_bindings()[0]
                .scope()
                .material_scene_proofs()
                .is_empty())
            .then_some(ScopeRole::MaterialSceneProof),
        )
        .collect();
        assert_eq!(roles, expected);
    }
    // The classification of Section 13: dependency, request context, turn context.
    assert_eq!(
        classify_reference(QualificationKind::Scope, Some(ScopeRole::TypedScope)),
        Some(ReferenceClass::Dependency)
    );
    assert_eq!(
        classify_reference(QualificationKind::Scope, Some(ScopeRole::ProjectAuthority)),
        Some(ReferenceClass::RequestContext)
    );
    assert_eq!(
        classify_reference(QualificationKind::Scope, Some(ScopeRole::ScopeAxis)),
        Some(ReferenceClass::TurnContext)
    );
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn material_basis_conflict_between_source_basis_and_evidence_set_is_excluded() -> Result<()> {
    // The conflict is built across the two lists: an evidence_set entry holds a
    // source_basis key with a different token (K4/3 section 3 rule 2).
    let fixture = DfFinalFixture::new()?;
    let target = fixture.revisions[1].clone();
    let projection = fixture.project_with_bindings(|bindings| {
        let binding = bindings
            .iter_mut()
            .find(|binding| binding.revision_id() == target)
            .expect("fixture Revision binding");
        let basis = binding.revision.material_basis.source_basis[0].clone();
        let evidence = binding
            .revision
            .material_basis
            .evidence_set
            .first_mut()
            .expect("an evidence entry");
        evidence.source_key = basis.source_key.clone();
        evidence.revision_token = format!("{}-other", basis.revision_token);
    })?;
    assert_eq!(projection.excluded_revisions().len(), 1);
    assert_eq!(projection.excluded_revisions()[0].revision_id(), target);
    assert_eq!(
        projection.excluded_revisions()[0].reason(),
        NativeNir1RevisionExclusionReason::MaterialBasisSourceTokenConflict
    );
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn revision_with_inconsistent_material_basis_is_excluded_only_that_revision() -> Result<()> {
    let fixture = DfFinalFixture::new()?;
    let baseline = fixture.project()?;
    let target = fixture.revisions[1].clone();
    let kept = fixture.revisions[0].clone();
    let projection = fixture.project_with_bindings(|bindings| {
        let binding = bindings
            .iter_mut()
            .find(|binding| binding.revision_id() == target)
            .expect("fixture Revision binding");
        let first = binding.revision.material_basis.source_basis[0].clone();
        let mut conflicting = first.clone();
        conflicting.revision_token = format!("{}-other", first.revision_token);
        binding
            .revision
            .material_basis
            .source_basis
            .push(conflicting);
    })?;
    assert_eq!(projection.excluded_revisions().len(), 1);
    let excluded = &projection.excluded_revisions()[0];
    assert_eq!(excluded.revision_id(), target);
    assert_eq!(
        excluded.reason(),
        NativeNir1RevisionExclusionReason::MaterialBasisSourceTokenConflict
    );
    assert_eq!(
        excluded.reason().code(),
        "material-basis-source-token-conflict"
    );
    // Only that Revision is gone: Human, Raw and the other Revision stay, with
    // the same attempt context (Scene, Human version, Raw binding).
    assert_eq!(projection.input_references().len(), 3);
    assert_eq!(
        revision_ordinals(&projection)
            .into_iter()
            .map(|(_, id)| id)
            .collect::<Vec<_>>(),
        vec![kept.clone()]
    );
    assert_eq!(projection.authority_bindings().len(), 1);
    assert_eq!(projection.authority_bindings()[0].revision_id(), kept);
    assert_eq!(projection.query_scene_id(), baseline.query_scene_id());
    assert_eq!(
        projection.user_message_version(),
        baseline.user_message_version()
    );
    assert_eq!(
        projection.raw_source_binding(),
        baseline.raw_source_binding()
    );
    assert!(projection
        .context_items()
        .iter()
        .all(|item| item.input_ordinal() < projection.input_references().len()));
    assert!(projection.qualifications().iter().all(|row| {
        row.input_ordinal < 3
            && !(row.identity() == Some(target.as_str())
                && matches!(
                    row.kind,
                    QualificationKind::Revision | QualificationKind::Freshness
                ))
    }));
    // The remaining output is complete.
    let finalized = projection.finalize_qualifications(100_000)?;
    projection
        .check_completeness(&finalized.qualifications)
        .map_err(|violation| anyhow::anyhow!("{violation}"))?;
    // The kept Revision's rows are exactly what the full projection gave it.
    let baseline_ordinal = revision_ordinals(&baseline)
        .into_iter()
        .find(|(_, id)| *id == kept)
        .context("baseline ordinal")?
        .0;
    let kept_ordinal = revision_ordinals(&projection)[0].0;
    let strip = |rows: Vec<&QualificationReference>| {
        rows.into_iter()
            .map(|row| {
                (
                    row.kind,
                    row.scope_role(),
                    row.identity().map(str::to_owned),
                    row.version().map(str::to_owned),
                )
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(
        strip(rows_of(projection.qualifications(), kept_ordinal)),
        strip(rows_of(baseline.qualifications(), baseline_ordinal))
    );

    // The same key with the same token (the usual overlap) is one Source and
    // is not an inconsistency.
    let overlapping = fixture.project_with_bindings(|bindings| {
        let basis = &mut bindings[0].revision.material_basis;
        let first = basis.source_basis[0].clone();
        basis.source_basis.push(first);
    })?;
    assert!(overlapping.excluded_revisions().is_empty());
    assert_eq!(overlapping.input_references().len(), 4);

    // When every Revision is inconsistent, the request has no Revision left
    // and is refused instead of sending the Raw alone.
    let error = fixture
        .project_with_bindings(|bindings| {
            for binding in bindings.iter_mut() {
                let first = binding.revision.material_basis.source_basis[0].clone();
                let mut conflicting = first.clone();
                conflicting.revision_token = format!("{}-other", first.revision_token);
                binding
                    .revision
                    .material_basis
                    .source_basis
                    .push(conflicting);
            }
        })
        .err()
        .context("a request without any Revision was prepared")?;
    assert_eq!(
        error.to_string(),
        "NIR1_NATIVE_PREPARED_REQUIRED_CONTEXT_MISSING"
    );
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn df_final_incomplete_output_is_detected() -> Result<()> {
    use crate::nir1_generation::{CompletenessReason as Reason, NotApplicableReason as Na};

    let fixture = DfFinalFixture::new()?;
    let projection = fixture.project()?;
    let complete = projection.finalize_qualifications(100_000)?.qualifications;
    let (revision_ordinal, _) = revision_ordinals(&projection)[0].clone();
    let detect = |qualifications: &[QualificationReference]| {
        projection
            .check_completeness(qualifications)
            .expect_err("a broken D-final output must be detected")
    };

    // A reference dropped from a kind that has several.
    let mut dropped = complete.clone();
    let position = dropped
        .iter()
        .position(|row| {
            row.input_ordinal == revision_ordinal && row.scope_role() == Some(ScopeRole::TypedScope)
        })
        .context("typed scope row")?;
    dropped.remove(position);
    assert_eq!(detect(&dropped).reason, Reason::ExpectedTargetMissing);

    // A kind with neither a reference nor an N/A (the Human's Freshness).
    let mut missing = complete.clone();
    missing.retain(|row| !(row.input_ordinal == 0 && row.kind == QualificationKind::Freshness));
    let violation = detect(&missing);
    assert_eq!(
        (violation.input_ordinal, violation.kind, violation.reason),
        (
            Some(0),
            Some(QualificationKind::Freshness),
            Reason::MissingKind
        )
    );

    // The same target twice with two versions.
    let mut duplicated = complete.clone();
    let mut other_version = duplicated
        .iter()
        .find(|row| row.input_ordinal == revision_ordinal && row.kind == QualificationKind::Source)
        .cloned()
        .context("source row")?;
    if let crate::nir1_generation::QualificationBody::Present { version, .. } =
        &mut other_version.body
    {
        version.push_str("-stale");
    }
    duplicated.push(other_version);
    assert_eq!(detect(&duplicated).reason, Reason::DuplicateTarget);

    // A forged N/A: the Raw's Freshness reason follows its source key.
    let mut forged = complete.clone();
    for row in &mut forged {
        if row.input_ordinal == 1 && row.kind == QualificationKind::Freshness {
            *row = QualificationReference::not_applicable(
                1,
                QualificationKind::Freshness,
                Na::ExactSourceToken,
            );
        }
    }
    assert_eq!(detect(&forged).reason, Reason::NotApplicableReasonMismatch);

    // A reference added next to the Revision's Index N/A.
    let mut both = complete.clone();
    both.push(QualificationReference::present(
        revision_ordinal,
        QualificationKind::Index,
        "index",
        "1",
    ));
    assert_eq!(detect(&both).reason, Reason::ReferenceAndNotApplicable);

    // A second N/A for the same kind.
    let mut twice = complete.clone();
    twice.push(QualificationReference::not_applicable(
        revision_ordinal,
        QualificationKind::Index,
        Na::NotIndexDerived,
    ));
    assert_eq!(detect(&twice).reason, Reason::DuplicateNotApplicable);

    // The finalizer refuses to hand out such an output.
    let mut broken = fixture.project()?;
    broken
        .qualifications
        .retain(|row| !(row.input_ordinal == 0 && row.kind == QualificationKind::Source));
    let error = broken
        .finalize_qualifications(100_000)
        .err()
        .context("finalizer accepted an incomplete output")?;
    assert!(
        error
            .to_string()
            .starts_with("NIR1_NATIVE_PREPARED_QUALIFICATION_INCOMPLETE"),
        "{error}"
    );
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn d1_selection_follows_stored_rows_and_usage() -> Result<()> {
    use crate::nir1_generation::d1_selection_digest;

    let fixture = DfFinalFixture::new()?;
    let projection = fixture.project()?;
    let finalized = projection.finalize_qualifications(100_000)?;
    let params = &finalized.d1_selection;
    assert_eq!(
        params.estimator_version,
        grimodex_core::narrative_nir1::NIR1_CONTEXT_TOKEN_ESTIMATOR_VERSION
    );
    assert_eq!(params.selector_budget_tokens, 100_000);
    let used: usize = projection
        .context_items()
        .iter()
        .map(|item| estimate_nir1_context_tokens(item.text()))
        .sum();
    assert_eq!(params.used_tokens, used as u64);
    assert_eq!(params.used_tokens + params.remaining_tokens, 100_000);
    assert_eq!(
        d1_selection_digest(params, projection.input_references())?,
        finalized.d1_selection_digest
    );
    for row in finalized
        .qualifications
        .iter()
        .filter(|row| row.kind == QualificationKind::D1 && row.identity().is_some())
    {
        assert_eq!(row.version(), Some(finalized.d1_selection_digest.as_str()));
    }
    // A smaller budget changes the digest; a budget below the usage is refused.
    let tighter = projection.finalize_qualifications(used + 7)?;
    assert_ne!(tighter.d1_selection_digest, finalized.d1_selection_digest);
    let error = projection
        .finalize_qualifications(used - 1)
        .err()
        .context("usage above the selector budget was accepted")?;
    assert_eq!(
        error.to_string(),
        "NIR1_NATIVE_PREPARED_D1_USAGE_EXCEEDS_BUDGET"
    );
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn builder_records_the_context_in_the_d_final_snapshot_and_completes_it_after_the_render(
) -> Result<()> {
    use crate::nir1_generation::history_context::{
        HistoryAxis, HistoryContextSlot, HistoryDigest, HistoryDigestDomain, HistoryInt,
    };

    let fixture = DfFinalFixture::new()?;
    let projection = fixture.project()?;
    let finalized = projection.finalize_qualifications(100_000)?;
    let draft = projection.history_draft(&finalized);
    let HistoryContextSlot::Context(context) = &draft.slot else {
        panic!(
            "a complete D-final output records a context: {:?}",
            draft.slot
        );
    };
    // The identity is the one the Ready binding of the workspace carries.
    assert_eq!(
        draft.durable_workspace_identity.as_ref(),
        fixture.snapshot.durable_workspace_identity()
    );
    assert!(draft.durable_workspace_identity.is_some());
    // The target's Scope token and version are the ones D-final's own
    // Revision bindings read from the same snapshot.
    let scope = projection.authority_bindings()[0].scope();
    assert_eq!(
        context.target.binding_token_digest,
        HistoryDigest::of(
            HistoryDigestDomain::ScopeBindingToken,
            scope.query_scene_scope_token()
        )?
    );
    let stored_scope = fixture.snapshot.db().with_read_transaction(|conn| {
        crate::narrative_extraction::read_narrative_scene_scope(
            conn,
            RAW_SOURCE_PROJECT,
            RAW_SOURCE_SCENE,
        )
    })?;
    assert_eq!(
        context.target.version,
        HistoryInt::from_i64(stored_scope.binding.version)?
    );
    // The effective axis D-final's A3 resolved is the one the context records.
    let HistoryAxis::Present(auto) = &context.axes.auto else {
        panic!("auto is resolvable in this fixture");
    };
    assert_eq!(
        match auto.axis {
            crate::nir1_generation::history_context::HistoryEffectiveAxis::Reading => "reading",
            crate::nir1_generation::history_context::HistoryEffectiveAxis::Story => "story",
        },
        scope.effective_axis()
    );
    // `eligibleUntilMs` is the writer's, not the builder's.
    assert_eq!(context.eligible_until_ms.get(), 0);
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn builder_d1_fields_recompute_the_selection_digest() -> Result<()> {
    use crate::nir1_generation::d1_selection_digest;
    use crate::nir1_generation::history_context::{HistoryContextSlot, HistoryEstimatorVersion};

    let fixture = DfFinalFixture::new()?;
    let projection = fixture.project()?;
    let finalized = projection.finalize_qualifications(100_000)?;
    let draft = projection.history_draft(&finalized);
    let HistoryContextSlot::Context(context) = draft.slot else {
        panic!("a complete D-final output records a context");
    };
    // The context's D1 fields and the stored input rows alone recompute the
    // digest that every D1 selection reference carries (DFA-1/2's hand-off).
    let parameters = D1SelectionParameters {
        estimator_version: context.d1.estimator_version.as_wire().to_owned(),
        selector_budget_tokens: context.d1.selector_budget_tokens.get(),
        used_tokens: context.d1.used_tokens.get(),
        remaining_tokens: context.d1.remaining_tokens.get(),
    };
    let recomputed = d1_selection_digest(&parameters, projection.input_references())?;
    assert_eq!(recomputed, finalized.d1_selection_digest);
    assert_eq!(context.d1.selection_digest.as_str(), recomputed);
    assert_eq!(
        context.d1.estimator_version,
        HistoryEstimatorVersion::Nir1ContextEstimatorV1
    );
    for row in finalized
        .qualifications
        .iter()
        .filter(|row| row.kind == QualificationKind::D1 && row.identity().is_some())
    {
        assert_eq!(row.version(), Some(recomputed.as_str()));
    }
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn builder_detects_rule_3_violations_as_d_final_incomplete() -> Result<()> {
    use crate::nir1_generation::history_context::{HistoryContextSlot, HistoryUnavailableReason};
    use crate::nir1_generation::{check_attempt_completeness, CompletenessContext};

    let fixture = DfFinalFixture::new()?;
    let projection = fixture.project()?;
    let mut finalized = projection.finalize_qualifications(100_000)?;
    let (revision_ordinal, _) = revision_ordinals(&projection)[0].clone();
    // Reduce the Revision's Source refs (its material basis and Evidence) to
    // one: every kind keeps a reference, so the structural checker passes,
    // but the set no longer equals the one the current state derives.
    let mut kept = false;
    finalized.qualifications.retain(|row| {
        if row.input_ordinal == revision_ordinal && row.kind == QualificationKind::Source {
            return !std::mem::replace(&mut kept, true);
        }
        true
    });
    check_attempt_completeness(
        projection.input_references(),
        &finalized.qualifications,
        &CompletenessContext {
            target_scene_id: RAW_SOURCE_SCENE,
            expected_targets: None,
        },
    )
    .map_err(|violation| anyhow::anyhow!("the structural check must pass: {violation}"))?;
    assert!(projection
        .check_completeness(&finalized.qualifications)
        .is_err());
    // The finalizer is not bypassed in production; this is the second line of
    // defense for a final output built another way.
    let draft = projection.history_draft(&finalized);
    assert_eq!(
        draft.slot,
        HistoryContextSlot::Unavailable(HistoryUnavailableReason::DFinalIncomplete)
    );
    assert_eq!(
        draft.durable_workspace_identity.as_ref(),
        fixture.snapshot.durable_workspace_identity()
    );
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn prepared_inputs_without_a_durable_identity_record_the_closed_reason() -> Result<()> {
    use crate::nir1_generation::history_context::{HistoryContextSlot, HistoryUnavailableReason};

    let db = current_schema_memory()?;
    let storage = json!({
        "type": "doc",
        "content": [{"type":"paragraph","content":[{"type":"text","text":"Current Source body."}]}]
    })
    .to_string();
    let revisions = fixture_with_query_source(&db, Some(&storage))?;
    let workspace = PreparedWorkspace::without_identity(db)?;
    let snapshot = workspace.snapshot()?;
    assert!(snapshot.durable_workspace_identity().is_none());
    let capture =
        add_prepared_human_message(&snapshot, "Captured human request for the current scene.")?;
    let projection = read_and_pack_native_nir1_prepared_inputs(
        &snapshot,
        PackingPurpose::Writing,
        crate::nir1_generation::history_context::HistorySendClassification::LocalOnly,
        "nir1-prepared-db-session",
        &capture,
        RAW_SOURCE_SCENE,
        &revisions,
        prepared_sql_budget(),
        |_| Ok(100_000),
    )?;
    let draft = projection.history_draft(&projection.finalize_qualifications(100_000)?);
    assert_eq!(
        draft.slot,
        HistoryContextSlot::Unavailable(HistoryUnavailableReason::WorkspaceIdentityUnavailable)
    );
    assert_eq!(draft.durable_workspace_identity, None);
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn revalidation_still_rejects_stale_identity_with_new_ref_shape() -> Result<()> {
    use crate::narrative_extraction::revalidate_native_nir1_prepared_inputs;

    let fixture = DfFinalFixture::new()?;
    let projection = fixture.project()?;
    revalidate_native_nir1_prepared_inputs(
        &fixture.snapshot,
        "nir1-prepared-db-session",
        &projection,
        prepared_sql_budget(),
    )?;
    // The Decision a Revision reference names changed after preparation: the
    // new reference rows (with typed N/A and roles) do not make the check weaker.
    fixture.snapshot.db().db().with_conn(|conn| {
        let changed = conn.execute(
            "UPDATE narrative_proposal_decisions SET decision_json=?1 WHERE revision_id=?2",
            params![
                json!({"reviewerNote":"changed after preparation"}).to_string(),
                fixture.revisions[0]
            ],
        )?;
        ensure!(changed == 1, "Decision row missing");
        Ok(())
    })?;
    let error = revalidate_native_nir1_prepared_inputs(
        &fixture.snapshot,
        "nir1-prepared-db-session",
        &projection,
        prepared_sql_budget(),
    )
    .err()
    .context("a changed Decision was accepted")?;
    assert_eq!(error.to_string(), "NIR1_NATIVE_PREPARED_REVISION_STALE");
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn resource_estimate_for_102_revisions() -> Result<()> {
    // Per Revision the producer writes 11 + 2E + Rel references (E Entities,
    // Rel Relations; S6-1), and the completeness rule adds the Index N/A and
    // the D1 selection: 13 + 2E + Rel. The current Human adds 8 and the Raw 8.
    // Packing admits at most 512 items, 5 per Entity or Relation and 1 for the
    // Raw, so 102 Revisions carry one Entity each (E = 1, Rel = 0).
    const MAX_REVISIONS: usize = 102;
    const HUMAN_AND_RAW_ROWS: usize = 16;
    fn per_revision(entities: usize, relations: usize) -> usize {
        13 + 2 * entities + relations
    }
    let fixture = DfFinalFixture::new()?;
    let projection = fixture.project()?;
    let finalized = projection.finalize_qualifications(100_000)?;
    let row_bytes =
        |row: &QualificationReference| -> Result<usize> { Ok(serde_json::to_string(row)?.len()) };
    let mut measured_revision_rows = 0usize;
    let mut measured_revision_bytes = 0usize;
    for (ordinal, revision_id) in revision_ordinals(&projection) {
        let bundle = &binding_for(&projection, &revision_id).revision().bundle;
        let rows = rows_of(&finalized.qualifications, ordinal);
        assert_eq!(
            rows.len(),
            per_revision(bundle.entities.len(), bundle.relations.len()),
            "the per-Revision formula holds on the real fixture"
        );
        measured_revision_rows += rows.len();
        for row in rows {
            measured_revision_bytes += row_bytes(row)?;
        }
    }
    let human_raw_bytes = [0usize, 1]
        .into_iter()
        .flat_map(|ordinal| rows_of(&finalized.qualifications, ordinal))
        .map(row_bytes)
        .sum::<Result<usize>>()?;
    assert_eq!(
        rows_of(&finalized.qualifications, 0).len() + rows_of(&finalized.qualifications, 1).len(),
        HUMAN_AND_RAW_ROWS
    );
    // The maximum request: 102 Revisions of one Entity each.
    let rows_102 = HUMAN_AND_RAW_ROWS + MAX_REVISIONS * per_revision(1, 0);
    assert_eq!(rows_102, 1546, "S6-1 estimated about 1,544");
    // Bytes at the measured average row size of the real fixture. S6-1
    // estimated about 200 KB from version 1 rows (about 150 bytes each);
    // version 2 rows carry `referenceVersion` and `state` (about 200 bytes
    // each), so the measure is larger. No production limit exists yet (the
    // per-turn budget is chosen from the HC-1a measurement under K1b), so this
    // pins the measured size instead of changing any limit.
    let average = measured_revision_bytes as f64 / measured_revision_rows as f64;
    let bytes_102 = human_raw_bytes as f64 + average * (MAX_REVISIONS * per_revision(1, 0)) as f64;
    assert!(
        (150.0..260.0).contains(&average) && bytes_102 < 330_000.0,
        "estimated {bytes_102:.0} bytes for {rows_102} rows, average row {average:.1} bytes"
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// DI-1c S2: the Native selection of Revisions (R-1, A-8 to A-8d)
// ---------------------------------------------------------------------------

#[cfg(feature = "native-current-human-capture")]
const NATIVE_SESSION: &str = "nir1-prepared-db-session";

#[cfg(feature = "native-current-human-capture")]
impl DfFinalFixture {
    /// The Native selection: no Revision ID from the caller.
    pub(super) fn select(&self) -> Result<NativeNir1SelectedInputs> {
        self.select_with(|_| Ok(100_000))
    }

    fn select_with(
        &self,
        budget: impl FnOnce(&str) -> Result<usize>,
    ) -> Result<NativeNir1SelectedInputs> {
        crate::narrative_extraction::read_and_pack_native_nir1_selected_inputs(
            &self.snapshot,
            PackingPurpose::Writing,
            crate::nir1_generation::history_context::HistorySendClassification::LocalOnly,
            NATIVE_SESSION,
            &self.capture,
            RAW_SOURCE_SCENE,
            prepared_sql_budget(),
            budget,
        )
    }

    pub(super) fn sql(&self, statement: &str, parameters: impl rusqlite::Params) -> Result<()> {
        self.snapshot.db().db().with_conn(|conn| {
            conn.execute(statement, parameters)?;
            Ok(())
        })
    }

    pub(super) fn sorted_revisions(&self) -> Vec<String> {
        let mut revisions = self.revisions.clone();
        revisions.sort();
        revisions
    }
}

#[cfg(feature = "native-current-human-capture")]
fn adopted_revision_ids(selected: &NativeNir1SelectedInputs) -> Vec<String> {
    revision_ordinals(selected.prepared())
        .into_iter()
        .map(|(_, revision_id)| revision_id)
        .collect()
}

#[cfg(feature = "native-current-human-capture")]
fn excluded_pairs(selected: &NativeNir1SelectedInputs) -> Vec<(String, &'static str)> {
    selected
        .prepared()
        .excluded_revisions()
        .iter()
        .map(|excluded| (excluded.revision_id().to_owned(), excluded.reason().code()))
        .collect()
}

#[cfg(feature = "native-current-human-capture")]
fn selection_error(result: Result<NativeNir1SelectedInputs>) -> String {
    match result {
        Ok(_) => panic!("the Native selection must fail"),
        Err(error) => error.to_string(),
    }
}

/// Nothing about a left-out Revision is in the request: not its input row, not
/// a qualification row, not a context item, not the history slot.
#[cfg(feature = "native-current-human-capture")]
fn assert_revision_absent_from_request(
    selected: &NativeNir1SelectedInputs,
    revision_id: &str,
) -> Result<()> {
    let prepared = selected.prepared();
    assert!(!format!("{:?}", prepared.input_references()).contains(revision_id));
    assert!(!format!("{:?}", prepared.qualifications()).contains(revision_id));
    assert!(prepared
        .authority_bindings()
        .iter()
        .all(|binding| binding.revision_id() != revision_id));
    let finalized = prepared.finalize_qualifications(100_000)?;
    assert!(!format!("{:?}", finalized.qualifications).contains(revision_id));
    assert!(!format!("{:?}", prepared.history_draft(&finalized)).contains(revision_id));
    // Every context item points at a kept input row.
    let references = prepared.input_references();
    for item in prepared.context_items() {
        assert!(item.input_ordinal() < references.len());
    }
    prepared
        .check_completeness(&finalized.qualifications)
        .map_err(|violation| anyhow::anyhow!("completeness: {violation}"))?;
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn native_selection_adopts_every_current_approved_revision_in_id_order() -> Result<()> {
    let fixture = DfFinalFixture::new()?;
    let selected = fixture.select()?;
    assert_eq!(adopted_revision_ids(&selected), fixture.sorted_revisions());
    assert!(selected.prepared().excluded_revisions().is_empty());
    assert_eq!(selected.prepared().query_scene_id(), RAW_SOURCE_SCENE);
    // The caller's list is not involved: the same Revisions, in the same
    // order, as the caller-list entry gives for the sorted list.
    let by_list = crate::narrative_extraction::read_and_pack_native_nir1_prepared_inputs(
        &fixture.snapshot,
        PackingPurpose::Writing,
        crate::nir1_generation::history_context::HistorySendClassification::LocalOnly,
        NATIVE_SESSION,
        &fixture.capture,
        RAW_SOURCE_SCENE,
        &fixture.sorted_revisions(),
        prepared_sql_budget(),
        |_| Ok(100_000),
    )?;
    assert_eq!(
        selected.prepared().input_references(),
        by_list.input_references()
    );
    assert_eq!(
        selected.prepared().qualifications(),
        by_list.qualifications()
    );
    let texts = |inputs: &NativeNir1PreparedInputs| {
        inputs
            .context_items()
            .iter()
            .map(|item| (item.input_ordinal(), item.text().to_owned()))
            .collect::<Vec<_>>()
    };
    assert_eq!(texts(selected.prepared()), texts(&by_list));
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn native_selection_returns_the_scene_binding_and_expected_scope_of_the_snapshot() -> Result<()> {
    use crate::nir1_generation::{read_attempt_scene_binding_in_tx, read_expected_scope_in_tx};

    let fixture = DfFinalFixture::new()?;
    let selected = fixture.select()?;
    let (binding, expected) = fixture
        .snapshot
        .db()
        .with_participant_read_transaction_bounded(
            fixture.snapshot.participant(),
            prepared_sql_budget(),
            |conn| {
                Ok((
                    read_attempt_scene_binding_in_tx(conn, RAW_SOURCE_PROJECT, RAW_SOURCE_SCENE)?,
                    read_expected_scope_in_tx(conn, RAW_SOURCE_PROJECT, RAW_SOURCE_SCENE)?,
                ))
            },
        )?;
    assert_eq!(selected.scene_binding(), &binding);
    assert_eq!(selected.expected_scope(), &expected);
    assert_eq!(selected.scene_binding().scene_id, RAW_SOURCE_SCENE);
    // The Scope token the Human and the Raw carry is the one the expectation
    // holds, and the history slot (when recorded) records the same digests.
    assert!(expected.scope_binding.is_some());
    assert!(expected.restore_epoch.is_some());
    // The snapshot's Raw binding and the Scene binding describe one Scene row.
    assert_eq!(
        selected.scene_binding().source_token,
        selected
            .prepared()
            .raw_source_binding()
            .binding()
            .revision_token
    );
    Ok(())
}

#[cfg(feature = "native-current-human-capture")]
#[test]
fn native_selection_reads_the_expectations_when_the_history_slot_is_unavailable() -> Result<()> {
    use crate::nir1_generation::history_context::{HistoryContextSlot, HistoryUnavailableReason};

    // No durable workspace identity: the history stage reads nothing, but the
    // Scope token and the restore epoch are still read (R-5, A-5).
    let db = current_schema_memory()?;
    let storage = json!({
        "type": "doc",
        "content": [{"type":"paragraph","content":[{"type":"text","text":"Current Source body."}]}]
    })
    .to_string();
    fixture_with_query_source(&db, Some(&storage))?;
    let workspace = PreparedWorkspace::without_identity(db)?;
    let snapshot = workspace.snapshot()?;
    let capture = add_prepared_human_message(&snapshot, "Captured human request.")?;
    let selected = crate::narrative_extraction::read_and_pack_native_nir1_selected_inputs(
        &snapshot,
        PackingPurpose::Writing,
        crate::nir1_generation::history_context::HistorySendClassification::LocalOnly,
        NATIVE_SESSION,
        &capture,
        RAW_SOURCE_SCENE,
        prepared_sql_budget(),
        |_| Ok(100_000),
    )?;
    let draft = selected
        .prepared()
        .history_draft(&selected.prepared().finalize_qualifications(100_000)?);
    assert_eq!(
        draft.slot,
        HistoryContextSlot::Unavailable(HistoryUnavailableReason::WorkspaceIdentityUnavailable)
    );
    assert!(selected.expected_scope().scope_binding.is_some());
    assert!(selected.expected_scope().restore_epoch.is_some());
    assert_eq!(selected.scene_binding().scene_id, RAW_SOURCE_SCENE);
    Ok(())
}

/// A-8: an unavailable Revision is left out alone, for each way the fixture
/// can make exactly one of the two Revisions unavailable.
#[cfg(feature = "native-current-human-capture")]
#[test]
fn native_selection_leaves_out_only_the_unavailable_revision() -> Result<()> {
    type Break = fn(&DfFinalFixture, &str) -> Result<()>;
    let cases: [(&str, Break); 4] = [
        ("revision-payload-invalid", |fixture, revision_id| {
            fixture.sql(
                "UPDATE narrative_proposal_revisions SET payload_json='{' WHERE id=?1",
                params![revision_id],
            )
        }),
        ("revision-envelope-invalid", |fixture, revision_id| {
            fixture.snapshot.db().db().with_conn(|conn| {
                conn.execute_batch(
                    "DROP TRIGGER IF EXISTS narrative_revision_envelope_immutable_update",
                )?;
                conn.execute(
                    "UPDATE narrative_proposal_revisions
                        SET reconciliation_envelope_json='{' WHERE id=?1",
                    params![revision_id],
                )?;
                Ok(())
            })
        }),
        ("revision-not-human-approved", |fixture, revision_id| {
            fixture.sql(
                "UPDATE narrative_proposal_decisions
                    SET actor_kind='automated', actor_id='electron:automated-review',
                        authority_scope='automated'
                  WHERE revision_id=?1",
                params![revision_id],
            )
        }),
        ("revision-decision-ambiguous", |fixture, revision_id| {
            fixture.sql(
                "INSERT INTO narrative_proposal_decisions
                    (id, proposal_id, revision_id, decision, decision_json, created_at,
                     created_by, actor_kind, actor_id, authority_scope, override_field_paths_json)
                 SELECT 'ambiguous-' || id, proposal_id, revision_id, 'approved', '{}',
                        created_at, 'automation', 'automated', 'electron:automated-review',
                        'automated', '[]'
                   FROM narrative_proposal_decisions WHERE revision_id=?1",
                params![revision_id],
            )
        }),
    ];
    for (reason, break_revision) in cases {
        let fixture = DfFinalFixture::new()?;
        let sorted = fixture.sorted_revisions();
        let (kept, left_out) = (&sorted[0], &sorted[1]);
        break_revision(&fixture, left_out)?;
        let selected = fixture.select()?;
        assert_eq!(
            adopted_revision_ids(&selected),
            vec![kept.clone()],
            "{reason}"
        );
        assert_eq!(
            excluded_pairs(&selected),
            vec![(left_out.clone(), reason)],
            "{reason}"
        );
        assert_revision_absent_from_request(&selected, left_out)?;
        // The Human, the Raw and the attempt context are those of the full
        // request.
        assert_eq!(
            selected.prepared().input_references()[0].role,
            InputRole::User
        );
        assert!(selected
            .prepared()
            .input_references()
            .iter()
            .any(|reference| matches!(&reference.target, InputTarget::RawSource { .. })));
        // The caller-list entry meets the same Revision and rejects the
        // whole request (the DP-H rejection variant; A-8c).
        let rejected = crate::narrative_extraction::read_and_pack_native_nir1_prepared_inputs(
            &fixture.snapshot,
            PackingPurpose::Writing,
            crate::nir1_generation::history_context::HistorySendClassification::LocalOnly,
            NATIVE_SESSION,
            &fixture.capture,
            RAW_SOURCE_SCENE,
            &sorted,
            prepared_sql_budget(),
            |_| Ok(100_000),
        )
        .err()
        .context("the caller list must reject")?;
        assert_eq!(
            rejected.to_string(),
            format!("NIR1_NATIVE_A2_UNAVAILABLE:{reason}"),
            "{reason}"
        );
    }
    Ok(())
}

/// A-8: the A3 reasons also leave a candidate out; the reason is reported by
/// the pooled read, which is where the policy applies.
#[cfg(feature = "native-current-human-capture")]
#[test]
fn native_selection_excludes_candidates_that_a3_reports_unavailable() -> Result<()> {
    let fixture = DfFinalFixture::new()?;
    // A secret Foreshadow linked to Alice whose payoff is not confirmed: every
    // Revision of the fixture holds Alice, so A3 reports a reveal denial for
    // both.
    fixture.sql(
        "INSERT INTO foreshadows
            (id, project_id, title, payoff_confirmed, abandoned, secret,
             payoff_scene_id, created_at, updated_at)
         VALUES ('native-reveal', 'default-project', 'Reveal', 0, 0, 1, NULL, 0, 0)",
        [],
    )?;
    fixture.sql(
        "INSERT INTO foreshadow_codex_links (foreshadow_id, codex_entry_id)
         VALUES ('native-reveal', 'nir1-alice')",
        [],
    )?;
    let candidates = fixture.sorted_revisions();
    let excluded = fixture
        .snapshot
        .db()
        .with_participant_read_transaction_bounded(
            fixture.snapshot.participant(),
            prepared_sql_budget(),
            |conn| {
                let pooled = read_and_pack_native_a2_context_with_current_source_and_policy_in_tx(
                    conn,
                    NativeNir1SourcePooledPackingRequest {
                        project_id: RAW_SOURCE_PROJECT,
                        revision_ids: &candidates,
                        query_scene_id: RAW_SOURCE_SCENE,
                        budget_tokens: 100_000,
                        purpose: PackingPurpose::Writing,
                        graph: None,
                    },
                    RevisionUnavailablePolicy::Exclude,
                    &mut NativePackingInputBudget::default(),
                    &mut |_| Ok(()),
                    &mut || Ok(()),
                )?;
                assert!(pooled.bindings.is_empty());
                assert!(pooled
                    .selected_items
                    .iter()
                    .all(|item| matches!(item.item(), ContextItemKind::Raw { .. })));
                Ok(pooled
                    .excluded
                    .iter()
                    .map(|excluded| (excluded.revision_id().to_owned(), excluded.reason().code()))
                    .collect::<Vec<_>>())
            },
        )?;
    assert_eq!(
        excluded,
        candidates
            .iter()
            .map(|revision_id| (revision_id.clone(), "a3-reveal-unavailable"))
            .collect::<Vec<_>>()
    );
    // A-8b: with nothing left, the required-context rule rejects the request.
    assert_eq!(
        selection_error(fixture.select()),
        "NIR1_NATIVE_PREPARED_REQUIRED_CONTEXT_MISSING"
    );
    Ok(())
}

/// A real, approved Revision added to the fixture after it was built. The
/// caller may change the request first (a different bundle, Scope or run).
#[cfg(feature = "native-current-human-capture")]
fn add_real_revision(
    fixture: &DfFinalFixture,
    name: &str,
    customize: impl FnOnce(
        &Database,
        &mut crate::narrative_extraction::nir1_entity_relation::Nir1EntityRelationRevisionRequest,
    ) -> Result<()>,
) -> Result<String> {
    let db = fixture.snapshot.db().db();
    let run_id = format!("extra-run-{name}");
    create_typed_run(db, &run_id)?;
    let mut request = request_for_run(db, &run_id, &format!("extra-proposal-{name}"));
    customize(db, &mut request)?;
    let created = create_nir1_entity_relation_revision(db, request)?;
    approve_typed_revision(db, &run_id, &created)?;
    Ok(created["revisionId"]
        .as_str()
        .context("extra Revision ID missing")?
        .to_owned())
}

/// A-8: the other families of A2/A3 reasons also leave out only the candidates
/// they hit (source change, Freshness, restore invalidation, Scope future).
/// Each case breaks some candidates and keeps the others, and the excluded
/// ones appear with their closed reason and nowhere else in the request.
#[cfg(feature = "native-current-human-capture")]
#[test]
fn native_selection_leaves_out_only_the_candidates_each_reason_family_hits() -> Result<()> {
    use crate::narrative_extraction::nir1_entity_relation::tests::rebind_scope_tokens;
    use grimodex_core::narrative_nir1::ScopeValue;

    // Freshness: the canonical Freshness row of one Revision is gone.
    let fixture = DfFinalFixture::new()?;
    let sorted = fixture.sorted_revisions();
    fixture.sql(
        "DELETE FROM narrative_consumer_freshness
          WHERE project_id='default-project' AND consumer_kind='proposal-revision'
            AND consumer_key=?1",
        params![sorted[1]],
    )?;
    let selected = fixture.select()?;
    assert_eq!(adopted_revision_ids(&selected), vec![sorted[0].clone()]);
    assert_eq!(
        excluded_pairs(&selected),
        vec![(sorted[1].clone(), "canonical-freshness-unavailable")]
    );
    assert_revision_absent_from_request(&selected, &sorted[1])?;

    // Restore: the epoch is rotated, so the two Revisions of the old epoch are
    // invalidated for good, and a Revision prepared and approved in the new
    // epoch stays.
    let fixture = DfFinalFixture::new()?;
    let sorted = fixture.sorted_revisions();
    fixture.snapshot.db().db().with_conn(|conn| {
        crate::narrative_extraction::semantic_epoch::create_epoch_in_tx(
            conn,
            "default-project",
            "restore",
            Some("restore-event-native-selection"),
        )
    })?;
    let after_restore = add_real_revision(&fixture, "after-restore", |_, _| Ok(()))?;
    let selected = fixture.select()?;
    assert_eq!(adopted_revision_ids(&selected), vec![after_restore.clone()]);
    let mut left_out = excluded_pairs(&selected);
    left_out.sort();
    assert_eq!(
        left_out,
        vec![
            (sorted[0].clone(), "revision-restore-invalidated"),
            (sorted[1].clone(), "revision-restore-invalidated"),
        ]
    );
    for revision_id in &sorted {
        assert_revision_absent_from_request(&selected, revision_id)?;
    }

    // Source change: a third Revision holds only Bob; Alice changes after all
    // three were approved, so the two Revisions that hold Alice are left out
    // and the one that does not stays.
    let fixture = DfFinalFixture::new()?;
    let sorted = fixture.sorted_revisions();
    let bob_only = add_real_revision(&fixture, "bob-only", |_, request| {
        request
            .bundle
            .entities
            .retain(|entity| entity.entity_id == "nir1-bob");
        request.bundle.relations.clear();
        Ok(())
    })?;
    fixture.sql(
        "UPDATE codex_entries SET summary='Alicia'
          WHERE id='nir1-alice' AND project_id='default-project'",
        [],
    )?;
    let selected = fixture.select()?;
    assert_eq!(adopted_revision_ids(&selected), vec![bob_only.clone()]);
    let mut left_out = excluded_pairs(&selected);
    left_out.sort();
    assert_eq!(
        left_out,
        vec![
            (sorted[0].clone(), "source-revision-changed"),
            (sorted[1].clone(), "source-revision-changed"),
        ]
    );
    for revision_id in &sorted {
        assert_revision_absent_from_request(&selected, revision_id)?;
    }

    // Scope future: a third Revision names a Scene whose story time is after
    // the query Scene's. The other two have no story constraint.
    let _relaxed =
        crate::narrative_extraction::nir1_entity_relation::tests_scope_shape::RelaxedScopeShape::hold();
    let fixture = DfFinalFixture::new()?;
    let sorted = fixture.sorted_revisions();
    fixture.sql(
        "UPDATE tree_nodes
            SET story_time_order = CASE id WHEN 'a3-source' THEN 'z0' ELSE 'a0' END
          WHERE project_id='default-project' AND id IN ('a3-source', 'a3-future')",
        [],
    )?;
    run_incremental_freshness_cycle(fixture.snapshot.db().db())?;
    let future = add_real_revision(&fixture, "story-future", |db, request| {
        for entity in &mut request.bundle.entities {
            entity.scope.reading = ScopeValue::Exact {
                value: "scene:a3-source".into(),
            };
            entity.scope.story = ScopeValue::Exact {
                value: "story:a3-source".into(),
            };
        }
        rebind_scope_tokens(db, request)
    })?;
    let selected = fixture.select()?;
    assert_eq!(adopted_revision_ids(&selected), sorted);
    assert_eq!(
        excluded_pairs(&selected),
        vec![(future.clone(), "a3-story-scope-future")]
    );
    assert_revision_absent_from_request(&selected, &future)?;
    Ok(())
}

/// The effective bound of a Native selection is the projected item count of
/// the adopted Revisions (`MAX_PACKING_ITEMS`), not the candidate count.
/// Candidates that A2/A3 leave out cost nothing; adopted ones are never
/// trimmed: once they do not fit, the whole request fails (not a partial
/// request), and the failure is the packing error, not an exclusion.
/// DI-1b / HC-1 decide how a project with that many eligible Revisions is
/// served.
#[cfg(feature = "native-current-human-capture")]
#[test]
fn native_selection_item_cap_fails_the_whole_request_and_never_trims_eligible_revisions(
) -> Result<()> {
    let fixture = DfFinalFixture::new()?;
    // One real Revision holds two Entities and one Relation: three groups of
    // five items each. Find how many Revisions fit next to the Raw items.
    let mut fitting = fixture.revisions.len();
    loop {
        let name = format!("fill-{fitting}");
        add_real_revision(&fixture, &name, |_, _| Ok(()))?;
        fitting += 1;
        match fixture.select() {
            Ok(selected) => {
                assert_eq!(adopted_revision_ids(&selected).len(), fitting);
                assert!(selected.prepared().excluded_revisions().is_empty());
            }
            Err(error) => {
                let message = error.to_string();
                assert!(
                    message.contains("projected item count")
                        && message
                            .ends_with(&format!("exceeds MAX_PACKING_ITEMS {MAX_PACKING_ITEMS}")),
                    "{message}"
                );
                fitting -= 1;
                break;
            }
        }
        assert!(fitting < MAX_PACKING_ITEMS, "the cap must be reached");
    }
    // 34 Revisions are 510 items; the Raw items bring it to the cap.
    assert_eq!(fitting, 34);
    // The count is the one the cap implies: three groups of five items each.
    assert!(fitting * 15 < MAX_PACKING_ITEMS && (fitting + 1) * 15 + 1 >= MAX_PACKING_ITEMS);
    // The Revision that did not fit is still there as a candidate; the request
    // fails as a whole each time, never with fewer Revisions.
    assert!(fixture.select().is_err());

    // Ineligible candidates do not use the cap: break one Revision and the
    // request returns to `fitting` adopted Revisions with exactly that one left
    // out.
    let all = {
        let mut ids = Vec::new();
        fixture.snapshot.db().db().with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT current_revision_id FROM narrative_proposals
                      ORDER BY current_revision_id ASC",
            )?;
            for row in statement.query_map([], |row| row.get::<_, String>(0))? {
                ids.push(row?);
            }
            Ok(())
        })?;
        ids
    };
    assert_eq!(all.len(), fitting + 1);
    let broken = all.last().cloned().context("a candidate")?;
    fixture.sql(
        "UPDATE narrative_proposal_revisions SET payload_json='{' WHERE id=?1",
        params![broken],
    )?;
    let selected = fixture.select()?;
    assert_eq!(adopted_revision_ids(&selected).len(), fitting);
    assert_eq!(
        excluded_pairs(&selected),
        vec![(broken.clone(), "revision-payload-invalid")]
    );
    Ok(())
}

/// A-8b: when no accepted IR remains the request is rejected as before, and
/// the failures that are not an `Unavailable` reason are not exclusions.
#[cfg(feature = "native-current-human-capture")]
#[test]
fn native_selection_without_any_accepted_revision_is_rejected() -> Result<()> {
    // Every candidate unavailable.
    let fixture = DfFinalFixture::new()?;
    fixture.sql(
        "UPDATE narrative_proposal_revisions SET payload_json='{'",
        [],
    )?;
    assert_eq!(
        selection_error(fixture.select()),
        "NIR1_NATIVE_PREPARED_REQUIRED_CONTEXT_MISSING"
    );
    // No candidate at all: no Revision is approved.
    let fixture = DfFinalFixture::new()?;
    fixture.sql("UPDATE narrative_proposals SET status='unreviewed'", [])?;
    assert_eq!(
        selection_error(fixture.select()),
        "NIR1_NATIVE_PREPARED_REQUIRED_CONTEXT_MISSING"
    );
    // The empty-budget and Human errors keep their codes.
    let fixture = DfFinalFixture::new()?;
    assert_eq!(
        selection_error(fixture.select_with(|_| Ok(0))),
        "NIR1_NATIVE_PREPARED_CONTEXT_BUDGET_EMPTY"
    );
    Ok(())
}

/// A candidate that is not approved is not a candidate: it is not excluded and
/// it costs no A2 read.
#[cfg(feature = "native-current-human-capture")]
#[test]
fn native_selection_does_not_count_an_unapproved_revision_as_excluded() -> Result<()> {
    let fixture = DfFinalFixture::new()?;
    let sorted = fixture.sorted_revisions();
    fixture.sql(
        "UPDATE narrative_proposals SET status='unreviewed' WHERE current_revision_id=?1",
        params![sorted[1]],
    )?;
    let selected = fixture.select()?;
    assert_eq!(adopted_revision_ids(&selected), vec![sorted[0].clone()]);
    assert!(selected.prepared().excluded_revisions().is_empty());
    assert_revision_absent_from_request(&selected, &sorted[1])
}

/// A cancel or a budget stop after a candidate was left out still fails the
/// whole request, and a SQL error is not an exclusion.
#[cfg(feature = "native-current-human-capture")]
#[test]
fn native_selection_stops_as_a_whole_on_cancel_budget_and_sql_errors() -> Result<()> {
    let fixture = DfFinalFixture::new()?;
    let sorted = fixture.sorted_revisions();
    fixture.sql(
        "UPDATE narrative_proposal_revisions SET payload_json='{' WHERE id=?1",
        params![sorted[0]],
    )?;
    let stop = std::sync::atomic::AtomicBool::new(false);
    let mut checkpoints = 0usize;
    let error = fixture
        .snapshot
        .db()
        .with_participant_read_transaction_bounded(
            fixture.snapshot.participant(),
            prepared_sql_budget(),
            |conn| {
                read_and_pack_native_a2_context_with_current_source_and_policy_in_tx(
                    conn,
                    NativeNir1SourcePooledPackingRequest {
                        project_id: RAW_SOURCE_PROJECT,
                        revision_ids: &sorted,
                        query_scene_id: RAW_SOURCE_SCENE,
                        budget_tokens: 100_000,
                        purpose: PackingPurpose::Writing,
                        graph: None,
                    },
                    RevisionUnavailablePolicy::Exclude,
                    &mut NativePackingInputBudget::default(),
                    &mut |_| Ok(()),
                    &mut || {
                        checkpoints += 1;
                        // The candidate loop checks once per candidate and once
                        // after the A2 read; stop on the second candidate.
                        if checkpoints >= 6 {
                            stop.store(true, std::sync::atomic::Ordering::SeqCst);
                        }
                        ensure!(
                            !stop.load(std::sync::atomic::Ordering::SeqCst),
                            "NIR1_TEST_CANCELLED"
                        );
                        Ok(())
                    },
                )
            },
        )
        .err()
        .context("a stop after an exclusion must fail the request")?;
    assert!(error.to_string().contains("NIR1_TEST_CANCELLED"));
    // The retained-binding budget is a whole-request limit, not an exclusion.
    let error = fixture
        .snapshot
        .db()
        .with_participant_read_transaction_bounded(
            fixture.snapshot.participant(),
            prepared_sql_budget(),
            |conn| {
                read_and_pack_native_a2_context_with_current_source_and_policy_in_tx(
                    conn,
                    NativeNir1SourcePooledPackingRequest {
                        project_id: RAW_SOURCE_PROJECT,
                        revision_ids: &sorted,
                        query_scene_id: RAW_SOURCE_SCENE,
                        budget_tokens: 100_000,
                        purpose: PackingPurpose::Writing,
                        graph: None,
                    },
                    RevisionUnavailablePolicy::Exclude,
                    &mut NativePackingInputBudget::default(),
                    &mut |_| anyhow::bail!("NIR1_TEST_RETAINED_LIMIT"),
                    &mut || Ok(()),
                )
            },
        )
        .err()
        .context("a retained-binding limit must fail the request")?;
    assert!(error.to_string().contains("NIR1_TEST_RETAINED_LIMIT"));
    // A missing table is a SQL error (not an Unavailable reason).
    fixture.sql("DROP TABLE narrative_proposal_decisions", [])?;
    let error = selection_error(fixture.select());
    assert!(
        !error.contains("REQUIRED_CONTEXT_MISSING"),
        "a SQL error is not an exclusion: {error}"
    );
    Ok(())
}

/// The reasons the A2 reader and the A3 check can report, and what the Native
/// selection does with each (the table in the DI-1c decisions).
#[cfg(feature = "native-current-human-capture")]
#[test]
fn exclusion_reasons_are_closed_and_cover_every_a2_a3_reason() {
    let all = NativeNir1RevisionExclusionReason::ALL;
    let codes = all
        .iter()
        .map(|reason| reason.code())
        .collect::<HashSet<_>>();
    assert_eq!(codes.len(), all.len(), "codes are distinct");
    for reason in all {
        let mapped = NativeNir1RevisionExclusionReason::from_a2_a3_code(reason.code());
        if reason == NativeNir1RevisionExclusionReason::MaterialBasisSourceTokenConflict {
            // Decided from an accepted Revision, never an A2/A3 reason.
            assert_eq!(mapped, None);
        } else {
            assert_eq!(mapped, Some(reason));
        }
    }
    for request_level in REQUEST_LEVEL_UNAVAILABLE_REASONS {
        assert_eq!(
            NativeNir1RevisionExclusionReason::from_a2_a3_code(request_level),
            None
        );
    }
    assert_eq!(
        NativeNir1RevisionExclusionReason::from_a2_a3_code("a3-not-a-reason"),
        None
    );
    assert_eq!(NativeNir1RevisionExclusionReason::from_a2_a3_code(""), None);

    // Every reason string the A2/A3 production code can report is classified:
    // a variant, a request-level reason, or one of the strings that are not
    // `Unavailable` reasons.
    const NOT_UNAVAILABLE_REASONS: [&str; 1] = [
        // `bail!` of the Entity lookup: a SQL-class error, not a reason.
        "a3-entity-unavailable",
    ];
    let a2_a3 = include_str!("nir1_entity_relation.rs");
    let production = a2_a3
        .split("#[cfg(test)]\npub(super) mod tests")
        .next()
        .expect("production part");
    let query_reads = include_str!("nir1_entity_relation/project_reads.rs");
    let mut seen = HashSet::new();
    for source in [production, query_reads] {
        for literal in source.split('"').skip(1).step_by(2) {
            let looks_like_reason = literal.starts_with("a3-")
                || literal.starts_with("revision-")
                || literal == "source-revision-changed"
                || literal == "canonical-freshness-unavailable";
            if !looks_like_reason
                || !literal
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            {
                continue;
            }
            seen.insert(literal.to_owned());
            assert!(
                codes.contains(literal)
                    || REQUEST_LEVEL_UNAVAILABLE_REASONS.contains(&literal)
                    || NOT_UNAVAILABLE_REASONS.contains(&literal),
                "the A2/A3 reason {literal:?} has no Native selection class"
            );
        }
    }
    // The scan saw the reasons it is meant to guard.
    for expected in ["a3-reveal-unavailable", "revision-payload-invalid"] {
        assert!(seen.contains(expected), "{expected}");
    }
    for request_level in REQUEST_LEVEL_UNAVAILABLE_REASONS {
        assert!(seen.contains(request_level), "{request_level}");
    }
}

/// Fake approved candidates, to reach the candidate limit without building
/// hundreds of real Revisions. Each one is a current Revision ID with no
/// Revision row: A2 reports it unavailable (`revision-not-found`).
#[cfg(feature = "native-current-human-capture")]
fn add_fake_candidates(fixture: &DfFinalFixture, count: usize) -> Result<()> {
    let template = fixture.revisions[0].clone();
    fixture.snapshot.db().db().with_conn(|conn| {
        for index in 0..count {
            conn.execute(
                "INSERT INTO narrative_proposals
                    (id, proposal_set_id, proposal_key, kind, status, payload_json,
                     current_revision_id, created_at, updated_at)
                 SELECT ?2, proposal_set_id, ?3, kind, 'approved', '{}', ?4,
                        created_at, updated_at
                   FROM narrative_proposals WHERE current_revision_id=?1",
                params![
                    template,
                    format!("fake-proposal-{index:04}"),
                    format!("fake-key-{index:04}"),
                    format!("fake-revision-{index:04}"),
                ],
            )?;
        }
        Ok(())
    })
}

/// A-8d: the candidate list is bounded as N and N+1.
#[cfg(feature = "native-current-human-capture")]
#[test]
fn native_selection_bounds_the_candidate_list_as_n_and_n_plus_one() -> Result<()> {
    // Exactly the limit: 2 real + 510 fake candidates. The fake ones are
    // candidates that A2 reports unavailable, so they are excluded, in ID
    // order, and the real ones are adopted.
    let fixture = DfFinalFixture::new()?;
    add_fake_candidates(&fixture, MAX_PACKING_ITEMS - 2)?;
    let selected = fixture.select()?;
    assert_eq!(adopted_revision_ids(&selected).len(), 2);
    let excluded = excluded_pairs(&selected);
    assert_eq!(excluded.len(), MAX_PACKING_ITEMS - 2);
    assert!(excluded
        .iter()
        .all(|(_, reason)| *reason == "revision-not-found"));
    let ids = excluded
        .iter()
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    let mut sorted = ids.clone();
    sorted.sort();
    assert_eq!(ids, sorted, "exclusions follow the candidate order");
    // One more candidate is the proof that the set exceeds the limit: typed
    // refusal, never a silent cut.
    let fixture = DfFinalFixture::new()?;
    add_fake_candidates(&fixture, MAX_PACKING_ITEMS - 1)?;
    assert_eq!(
        selection_error(fixture.select()),
        format!("NIR1_NATIVE_PREPARED_REVISION_CANDIDATES_LIMIT {MAX_PACKING_ITEMS}")
    );
    Ok(())
}

/// A-8d: the order is the Revision ID order, whatever the insertion order.
#[cfg(feature = "native-current-human-capture")]
#[test]
fn native_selection_lists_candidates_in_revision_id_order() -> Result<()> {
    let fixture = DfFinalFixture::new()?;
    add_fake_candidates(&fixture, 3)?;
    let selected = fixture.select()?;
    let mut all = fixture.sorted_revisions();
    all.extend((0..3).map(|index| format!("fake-revision-{index:04}")));
    all.sort();
    // Adopted + excluded make the full candidate list, each in ID order.
    let mut merged = adopted_revision_ids(&selected);
    merged.extend(excluded_pairs(&selected).into_iter().map(|(id, _)| id));
    merged.sort();
    assert_eq!(merged, all);
    let adopted = adopted_revision_ids(&selected);
    let mut sorted = adopted.clone();
    sorted.sort();
    assert_eq!(adopted, sorted);
    Ok(())
}

/// A-8d: the candidates are listed inside the snapshot. A commit from another
/// connection after the snapshot is pinned changes neither the list nor the
/// evaluation of this request.
#[cfg(feature = "native-current-human-capture")]
#[test]
fn native_selection_lists_candidates_inside_the_pinned_snapshot() -> Result<()> {
    let path = std::env::temp_dir().join(format!(
        "grimodex-nir1-native-select-{}.sqlite",
        uuid::Uuid::new_v4()
    ));
    let template = current_schema_memory()?;
    let db = Database::new(&path)?;
    {
        let source = template.lock()?;
        let mut destination = db.lock()?;
        let backup = rusqlite::backup::Backup::new(&source, &mut destination)?;
        ensure!(matches!(
            backup.step(-1)?,
            rusqlite::backup::StepResult::Done
        ));
    }
    let storage = json!({
        "type": "doc",
        "content": [{"type":"paragraph","content":[{"type":"text","text":"Current Source body."}]}]
    })
    .to_string();
    let revisions = fixture_with_query_source(&db, Some(&storage))?;
    let writer = Database::new(&path)?;
    let workspace = PreparedWorkspace::new(db)?;
    let snapshot = workspace.snapshot()?;
    let capture = add_prepared_human_message(&snapshot, "Captured human request.")?;
    let fixture = DfFinalFixture {
        _workspace: workspace,
        snapshot,
        revisions: revisions.clone(),
        capture,
    };
    let sorted = fixture.sorted_revisions();
    // The budget callback runs after the Human is read, so the snapshot is
    // pinned, and before the candidates are listed.
    let selected = fixture.select_with(|_| {
        writer.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_proposals SET status='unreviewed'
                  WHERE current_revision_id=?1",
                params![sorted[1]],
            )?;
            Ok(())
        })?;
        Ok(100_000)
    })?;
    assert_eq!(adopted_revision_ids(&selected), sorted);
    assert!(selected.prepared().excluded_revisions().is_empty());
    // A new request sees the commit.
    let later = fixture.select()?;
    assert_eq!(adopted_revision_ids(&later), vec![sorted[0].clone()]);
    drop(writer);
    drop(fixture);
    let _ = std::fs::remove_file(path);
    Ok(())
}

// ---------------------------------------------------------------------------
// DI-1a S1: Graph candidates requalified in the D-final snapshot
// ---------------------------------------------------------------------------

#[cfg(feature = "native-current-human-capture")]
pub(in crate::narrative_extraction) mod di1a_graph {
    use super::*;
    use crate::narrative_extraction::nir1_entity_relation_index::INDEX_KEY;
    use crate::narrative_extraction::nir1_graph::worker_projection::Nir1GraphProjection;
    use crate::narrative_extraction::nir1_graph::{
        Nir1GraphEdge, Nir1GraphMaterialBinding, Nir1GraphNode, Nir1GraphSceneAssociation,
        Nir1QualifiedGraph,
    };
    use crate::narrative_extraction::{
        Nir1GraphCandidateBinding, Nir1GraphCandidateEdge, Nir1GraphCandidates,
        Nir1GraphDropReason, Nir1GraphExclusionReason,
    };
    use grimodex_core::narrative_nir1::{
        EntityInput, EvidenceInput, GraphEdgeInput, ScopeValue, MAX_GRAPH_EDGES,
    };
    use rusqlite::OptionalExtension;
    use std::sync::Arc;

    const GENERATION: i64 = 7;
    /// A Graph group's ID is three bytes longer than its accepted IR group's,
    /// charged once as the part ID and once as the group ID, for five parts.
    const GRAPH_GROUP_EXTRA_BYTES: usize = 30;
    const SEED: &str = "nir1-alice";

    /// B's seal rows, as the Graph reader's `read_seal` joins them.
    fn write_seal(db: &Database, generation: i64, dirty: bool) -> Result<()> {
        db.with_conn(|conn| {
            let epoch: Option<String> = conn
                .query_row(
                    "SELECT id FROM narrative_semantic_epochs
                      WHERE project_id=?1 ORDER BY epoch_number DESC LIMIT 1",
                    params![RAW_SOURCE_PROJECT],
                    |row| row.get(0),
                )
                .optional()?;
            let epoch = match epoch {
                Some(epoch) => epoch,
                None => {
                    conn.execute(
                        "INSERT INTO narrative_semantic_epochs
                            (id, project_id, epoch_number, reason, created_at)
                         VALUES ('di1a-epoch', ?1, 0, 'initial', '2026-10-19T00:00:00Z')",
                        params![RAW_SOURCE_PROJECT],
                    )?;
                    "di1a-epoch".to_owned()
                }
            };
            conn.execute(
                "INSERT OR REPLACE INTO narrative_semantic_index_metadata
                    (project_id, index_key, generation, built_at, source_digest,
                     dependency_set_digest, dirty_cache_flag)
                 VALUES (?1, ?2, ?3, '2026-10-19T00:00:00Z', 'sha256:di1a-source',
                         'sha256:di1a-dependency', ?4)",
                params![RAW_SOURCE_PROJECT, INDEX_KEY, generation, i64::from(dirty)],
            )?;
            conn.execute(
                "INSERT OR REPLACE INTO narrative_consumer_freshness
                    (project_id, consumer_kind, consumer_key, evidence_freshness,
                     build_action, semantic_epoch_id, updated_at)
                 VALUES (?1, 'semantic-index', ?2, 'fresh', 'none', ?3, '2026-10-19T00:00:00Z')",
                params![RAW_SOURCE_PROJECT, INDEX_KEY, epoch],
            )?;
            Ok(())
        })
    }

    pub(in crate::narrative_extraction) fn run_pool(
        db: &Database,
        revisions: &[String],
        graph: Option<&Nir1GraphCandidates>,
        budget_tokens: usize,
        preset_used_bytes: usize,
    ) -> Result<(NativeNir1PooledPackedContext, usize)> {
        let raw = raw();
        db.with_read_transaction(|conn| {
            let mut budget = NativePackingInputBudget {
                used_bytes: preset_used_bytes,
                ..Default::default()
            };
            let pooled = read_and_pack_native_a2_context_in_tx_with_raw_charge(
                conn,
                NativeNir1PooledPackingRequest {
                    graph,
                    ..request(revisions, &raw, budget_tokens)
                },
                &mut budget,
                RawBudgetCharge::Charge,
                RevisionUnavailablePolicy::Exclude,
                &mut |_| Ok(()),
                &mut || Ok(()),
            )?;
            Ok((pooled, budget.used_bytes))
        })
    }

    /// What the Graph reader would have recorded for the relations of these
    /// bindings: every relation, each Revision at the given hop.
    fn candidates_from(
        bindings: &[NativeNir1AuthorityBinding],
        hops: &[u8],
    ) -> Result<Nir1GraphCandidates> {
        let mut edges = Vec::new();
        for (binding, hop) in bindings.iter().zip(hops) {
            let scope = binding.scope();
            for relation in &binding.revision().bundle.relations {
                edges.push(Nir1GraphCandidateEdge {
                    edge_id: relation.edge_id.clone(),
                    hop: *hop,
                    binding: Nir1GraphCandidateBinding {
                        revision_id: binding.revision_id().to_owned(),
                        decision_id: binding.decision().id().to_owned(),
                        decision_token: binding.decision_token().to_owned(),
                        freshness_token: binding.freshness_token().to_owned(),
                        scope_authority_revision: scope.scope_authority_revision().to_owned(),
                        query_scene_source_token: scope.query_scene_source_token().to_owned(),
                        query_scene_scope_token: scope.query_scene_scope_token().to_owned(),
                        query_scene_incarnation_id: scope.query_scene_incarnation_id().to_owned(),
                        reveal_state_token: scope.reveal_state_token().to_owned(),
                    },
                });
            }
        }
        Nir1GraphCandidates::new(
            RAW_SOURCE_PROJECT.into(),
            RAW_SOURCE_SCENE.into(),
            SEED.into(),
            GENERATION,
            Some(bindings[0].scope().scope_authority_revision().to_owned()),
            edges,
        )
    }

    #[derive(Clone)]
    struct Shape {
        project: String,
        scene: String,
        seed: String,
        generation: i64,
        scope_revision: Option<String>,
        edges: Vec<Nir1GraphCandidateEdge>,
    }

    impl Shape {
        fn of(candidates: &Nir1GraphCandidates) -> Self {
            Self {
                project: candidates.project_id().to_owned(),
                scene: candidates.query_scene_id().to_owned(),
                seed: candidates.seed_entity_id().to_owned(),
                generation: candidates.generation(),
                scope_revision: candidates.scope_revision().map(str::to_owned),
                edges: candidates.edges().to_vec(),
            }
        }

        fn build(self) -> Result<Nir1GraphCandidates> {
            Nir1GraphCandidates::new(
                self.project,
                self.scene,
                self.seed,
                self.generation,
                self.scope_revision,
                self.edges,
            )
        }
    }

    fn item_tokens(item: &ContextItemKind) -> usize {
        match item {
            ContextItemKind::Raw { tokens, .. }
            | ContextItemKind::AcceptedIr { tokens, .. }
            | ContextItemKind::GraphEvidence { tokens, .. }
            | ContextItemKind::AuthorDeclared { tokens, .. }
            | ContextItemKind::UnreviewedForReview { tokens, .. } => *tokens,
        }
    }

    fn item_group(item: &ContextItemKind) -> Option<&str> {
        match item {
            ContextItemKind::Raw { .. } => None,
            ContextItemKind::AcceptedIr { atomic_group, .. }
            | ContextItemKind::GraphEvidence { atomic_group, .. }
            | ContextItemKind::AuthorDeclared { atomic_group, .. }
            | ContextItemKind::UnreviewedForReview { atomic_group, .. } => Some(atomic_group),
        }
    }

    fn kind_of(item: &ContextItemKind) -> &'static str {
        match item {
            ContextItemKind::Raw { .. } => "raw",
            ContextItemKind::AcceptedIr { .. } => "accepted-ir",
            ContextItemKind::GraphEvidence { .. } => "graph-evidence",
            ContextItemKind::AuthorDeclared { .. } => "author-declared",
            ContextItemKind::UnreviewedForReview { .. } => "unreviewed",
        }
    }

    fn group_tokens(pooled: &NativeNir1PooledPackedContext, group: &str) -> usize {
        pooled
            .selected_items
            .iter()
            .filter(|selected| item_group(selected.item()) == Some(group))
            .map(|selected| item_tokens(selected.item()))
            .sum()
    }

    fn selected_groups(pooled: &NativeNir1PooledPackedContext) -> Vec<(&'static str, String)> {
        let mut groups = Vec::<(&'static str, String)>::new();
        for selected in &pooled.selected_items {
            let Some(group) = item_group(selected.item()) else {
                continue;
            };
            if groups.last().map(|(_, last)| last.as_str()) != Some(group) {
                groups.push((kind_of(selected.item()), group.to_owned()));
            }
        }
        groups
    }

    fn graph_group_id(revision_id: &str, edge_id: &str) -> String {
        format!("nir1:graph-evidence:{revision_id}:relation:{edge_id}")
    }

    fn ir_group_id(revision_id: &str, edge_id: &str) -> String {
        format!("nir1:accepted-ir:{revision_id}:relation:{edge_id}")
    }

    pub(in crate::narrative_extraction) struct Scenario {
        pub(in crate::narrative_extraction) db: Database,
        pub(in crate::narrative_extraction) revisions: Vec<String>,
        control: NativeNir1PooledPackedContext,
        control_bytes: usize,
        pub(in crate::narrative_extraction) candidates: Nir1GraphCandidates,
        edge_ids: Vec<String>,
    }

    pub(in crate::narrative_extraction) fn scenario() -> Result<Scenario> {
        let db = current_schema_memory()?;
        let revisions = fixture(&db)?;
        write_seal(&db, GENERATION, false)?;
        let (control, control_bytes) = run_pool(&db, &revisions, None, 100_000, 0)?;
        let candidates = candidates_from(&control.bindings, &[0, 0])?;
        let edge_ids = candidates
            .edges()
            .iter()
            .map(|edge| edge.edge_id.clone())
            .collect();
        Ok(Scenario {
            db,
            revisions,
            control,
            control_bytes,
            candidates,
            edge_ids,
        })
    }

    fn assert_pool_unchanged(
        scenario: &Scenario,
        pooled: &NativeNir1PooledPackedContext,
        bytes: usize,
    ) {
        assert_eq!(pooled.packed, scenario.control.packed);
        assert_eq!(pooled.selected_items, scenario.control.selected_items);
        assert_eq!(bytes, scenario.control_bytes);
    }

    /// A-1: the Graph group's text is the snapshot Revision's text.
    #[test]
    fn graph_groups_take_the_place_of_their_accepted_ir_groups_with_the_snapshot_text() -> Result<()>
    {
        let s = scenario()?;
        let (pooled, bytes) = run_pool(&s.db, &s.revisions, Some(&s.candidates), 100_000, 0)?;
        let outcome = pooled.graph.as_ref().expect("a Graph outcome");
        assert_eq!(outcome.dropped_reason(), None);
        assert!(outcome.excluded().is_empty());
        assert_eq!(outcome.limited_count(), 0);
        assert_eq!(outcome.seal().map(|seal| seal.generation), Some(GENERATION));
        assert_eq!(outcome.groups().len(), 2);
        // The relation is sent once: the item count does not grow, and the
        // accepted IR group of a Graph relation is not in the pool.
        assert_eq!(pooled.selected_items.len(), s.control.selected_items.len());
        for group in outcome.groups() {
            assert_eq!(
                group.group_id(),
                graph_group_id(group.revision_id(), group.edge_id())
            );
            let ir_group = ir_group_id(group.revision_id(), group.edge_id());
            assert!(
                pooled
                    .selected_items
                    .iter()
                    .all(|selected| item_group(selected.item()) != Some(ir_group.as_str())),
                "{ir_group} must be replaced"
            );
            // Same five parts, same bytes and tokens as the IR group.
            for selected in pooled
                .selected_items
                .iter()
                .filter(|selected| item_group(selected.item()) == Some(group.group_id()))
            {
                let ContextItemKind::GraphEvidence {
                    id, text, tokens, ..
                } = selected.item()
                else {
                    panic!("a Graph group holds GraphEvidence items")
                };
                let part = id.rsplit(':').next().unwrap();
                let control_id = format!("{ir_group}:{part}");
                let control = s
                    .control
                    .selected_items
                    .iter()
                    .find_map(|item| match item.item() {
                        ContextItemKind::AcceptedIr {
                            id, text, tokens, ..
                        } if id == &control_id => Some((text, tokens)),
                        _ => None,
                    })
                    .expect("the control holds the IR part");
                assert_eq!((text, tokens), control, "{id}");
                assert_eq!(
                    selected.owner_revision_id.as_deref(),
                    Some(group.revision_id())
                );
                assert!(selected.candidate_binding().is_some());
            }
            assert_eq!(
                pooled
                    .selected_items
                    .iter()
                    .filter(|selected| item_group(selected.item()) == Some(group.group_id()))
                    .count(),
                5
            );
        }
        // Raw, then the Graph groups, then the accepted IR groups.
        let kinds = pooled
            .selected_items
            .iter()
            .map(|selected| kind_of(selected.item()))
            .collect::<Vec<_>>();
        assert_eq!(kinds[0], "raw");
        assert!(kinds[1..11].iter().all(|kind| *kind == "graph-evidence"));
        assert!(kinds[11..].iter().all(|kind| *kind == "accepted-ir"));
        // One shared envelope: the Graph group only adds the longer group ID.
        assert_eq!(
            bytes,
            s.control_bytes + 2 * GRAPH_GROUP_EXTRA_BYTES,
            "the Graph groups are charged to the same input envelope"
        );
        // The authority bindings are those of the snapshot's A2/A3 results.
        assert_eq!(pooled.bindings, s.control.bindings);
        Ok(())
    }

    /// A-1 (token and ID forgery): the Revision of a forged candidate has no
    /// Graph group; the others and the IR groups stay.
    #[test]
    fn a_forged_binding_token_or_id_removes_only_that_revisions_group() -> Result<()> {
        let s = scenario()?;
        type Forge = fn(&mut Nir1GraphCandidateBinding);
        let forgeries: [(&str, Forge); 8] = [
            ("decision_id", |b| b.decision_id.push('x')),
            ("decision_token", |b| b.decision_token.push('x')),
            ("freshness_token", |b| b.freshness_token.push('x')),
            ("scope_authority_revision", |b| {
                b.scope_authority_revision.push('x')
            }),
            ("query_scene_source_token", |b| {
                b.query_scene_source_token.push('x')
            }),
            ("query_scene_scope_token", |b| {
                b.query_scene_scope_token.push('x')
            }),
            ("query_scene_incarnation_id", |b| {
                b.query_scene_incarnation_id.push('x')
            }),
            ("reveal_state_token", |b| b.reveal_state_token.push('x')),
        ];
        for (field, forge) in forgeries {
            let mut shape = Shape::of(&s.candidates);
            let target = s.revisions[0].clone();
            for edge in shape.edges.iter_mut().filter(|e| e.revision_id() == target) {
                forge(&mut edge.binding);
            }
            let (pooled, _) = run_pool(&s.db, &s.revisions, Some(&shape.build()?), 100_000, 0)?;
            let outcome = pooled.graph.as_ref().unwrap();
            assert_eq!(outcome.dropped_reason(), None, "{field}");
            assert_eq!(
                outcome
                    .excluded()
                    .iter()
                    .map(|e| (e.revision_id().to_owned(), e.reason()))
                    .collect::<Vec<_>>(),
                vec![(target.clone(), Nir1GraphExclusionReason::BindingMismatch)],
                "{field}"
            );
            assert_eq!(outcome.groups().len(), 1, "{field}");
            assert_eq!(outcome.groups()[0].revision_id(), s.revisions[1], "{field}");
            // The forged Revision keeps its accepted IR group.
            assert!(
                pooled.selected_items.iter().any(|selected| {
                    item_group(selected.item())
                        == Some(ir_group_id(&target, &s.edge_ids[0]).as_str())
                }),
                "{field}"
            );
            assert_eq!(pooled.selected_items.len(), s.control.selected_items.len());
        }

        // A Revision ID that does not exist, an edge ID the Revision does not
        // have, and a Revision of another project are not groups.
        let mut shape = Shape::of(&s.candidates);
        let mut ghost = shape.edges[0].clone();
        ghost.binding.revision_id = "no-such-revision".into();
        shape.edges.push(ghost);
        let mut wrong_edge = shape.edges[1].clone();
        wrong_edge.edge_id = "no-such-edge".into();
        shape.edges[1] = wrong_edge;
        let (pooled, _) = run_pool(&s.db, &s.revisions, Some(&shape.build()?), 100_000, 0)?;
        let outcome = pooled.graph.as_ref().unwrap();
        assert_eq!(
            outcome
                .excluded()
                .iter()
                .map(|e| (e.revision_id().to_owned(), e.reason()))
                .collect::<Vec<_>>(),
            vec![
                (
                    s.revisions[1].clone(),
                    Nir1GraphExclusionReason::EdgeUnknown
                ),
                (
                    "no-such-revision".to_owned(),
                    Nir1GraphExclusionReason::RevisionNotSelected
                ),
            ]
        );
        assert_eq!(outcome.groups().len(), 1);
        assert_eq!(outcome.groups()[0].revision_id(), s.revisions[0]);
        Ok(())
    }

    /// A-1 (seal, query and project): a Graph for another generation, another
    /// Scene or another project, or without a current seal, is dropped whole.
    #[test]
    fn a_graph_for_another_seal_scene_or_project_is_dropped_whole() -> Result<()> {
        let s = scenario()?;
        let drop_cases: Vec<(&str, Nir1GraphCandidates, Nir1GraphDropReason)> = vec![
            (
                "generation",
                Shape {
                    generation: GENERATION + 1,
                    ..Shape::of(&s.candidates)
                }
                .build()?,
                Nir1GraphDropReason::SealMismatch,
            ),
            (
                "scene",
                Shape {
                    scene: "another-scene".into(),
                    ..Shape::of(&s.candidates)
                }
                .build()?,
                Nir1GraphDropReason::ProjectOrSceneMismatch,
            ),
            (
                "project",
                Shape {
                    project: "another-project".into(),
                    ..Shape::of(&s.candidates)
                }
                .build()?,
                Nir1GraphDropReason::ProjectOrSceneMismatch,
            ),
        ];
        for (name, candidates, reason) in drop_cases {
            let (pooled, bytes) = run_pool(&s.db, &s.revisions, Some(&candidates), 100_000, 0)?;
            let outcome = pooled.graph.as_ref().unwrap();
            assert_eq!(outcome.dropped_reason(), Some(reason), "{name}");
            assert!(outcome.groups().is_empty(), "{name}");
            assert_pool_unchanged(&s, &pooled, bytes);
        }
        // The scope revision the frame recorded is checked against the
        // snapshot's: a wrong one removes every Revision.
        let wrong_scope = Shape {
            scope_revision: Some("another-scope-revision".into()),
            ..Shape::of(&s.candidates)
        }
        .build()?;
        let (pooled, bytes) = run_pool(&s.db, &s.revisions, Some(&wrong_scope), 100_000, 0)?;
        let outcome = pooled.graph.as_ref().unwrap();
        assert_eq!(outcome.dropped_reason(), None);
        assert_eq!(outcome.excluded().len(), 2);
        assert!(outcome
            .excluded()
            .iter()
            .all(|e| e.reason() == Nir1GraphExclusionReason::BindingMismatch));
        assert_pool_unchanged(&s, &pooled, bytes);

        // B is dirty (a writer changed a bound row): no Graph.
        write_seal(&s.db, GENERATION, true)?;
        let (pooled, bytes) = run_pool(&s.db, &s.revisions, Some(&s.candidates), 100_000, 0)?;
        assert_eq!(
            pooled.graph.as_ref().unwrap().dropped_reason(),
            Some(Nir1GraphDropReason::SealUnavailable)
        );
        assert_pool_unchanged(&s, &pooled, bytes);
        // B was never sealed.
        s.db.with_conn(|conn| {
            conn.execute("DELETE FROM narrative_semantic_index_metadata", [])?;
            Ok(())
        })?;
        let (pooled, bytes) = run_pool(&s.db, &s.revisions, Some(&s.candidates), 100_000, 0)?;
        assert_eq!(
            pooled.graph.as_ref().unwrap().dropped_reason(),
            Some(Nir1GraphDropReason::SealUnavailable)
        );
        assert_pool_unchanged(&s, &pooled, bytes);
        Ok(())
    }

    /// A-2: one budget, Graph before accepted IR, atomic groups, one envelope.
    #[test]
    fn graph_and_accepted_ir_groups_share_one_budget_and_the_graph_ranks_first() -> Result<()> {
        let s = scenario()?;
        let (full, _) = run_pool(&s.db, &s.revisions, Some(&s.candidates), 100_000, 0)?;
        let outcome = full.graph.as_ref().unwrap();
        let g0 = outcome.groups()[0].group_id().to_owned();
        let g1 = outcome.groups()[1].group_id().to_owned();
        let first_ir = full
            .selected_items
            .iter()
            .find_map(|selected| match selected.item() {
                ContextItemKind::AcceptedIr { atomic_group, .. } => Some(atomic_group.clone()),
                _ => None,
            })
            .unwrap();
        let (tokens_g0, tokens_g1, tokens_ir) = (
            group_tokens(&full, &g0),
            group_tokens(&full, &g1),
            group_tokens(&full, &first_ir),
        );
        ensure!(
            tokens_g1 > tokens_ir && tokens_g0 > tokens_ir,
            "a relation group is larger than an Entity group"
        );
        // Room for the first Graph group and the first accepted IR group only.
        let (pooled, _) = run_pool(
            &s.db,
            &s.revisions,
            Some(&s.candidates),
            1 + tokens_g0 + tokens_ir,
            0,
        )?;
        assert_eq!(pooled.packed.remaining_tokens, 0);
        let groups = selected_groups(&pooled);
        assert_eq!(
            groups,
            vec![
                ("graph-evidence", g0.clone()),
                ("accepted-ir", first_ir.clone())
            ]
        );
        // The Graph group is whole (all five parts) or absent.
        assert_eq!(
            pooled
                .selected_items
                .iter()
                .filter(|selected| item_group(selected.item()) == Some(g0.as_str()))
                .count(),
            5
        );
        // The same budget without the Graph does not select a relation group
        // ahead of the Entity groups: the Graph changed the rank, nothing else.
        let (control, _) = run_pool(&s.db, &s.revisions, None, 1 + tokens_g0 + tokens_ir, 0)?;
        assert!(selected_groups(&control)
            .iter()
            .all(|(kind, _)| *kind == "accepted-ir"));
        Ok(())
    }

    /// A-14: on a budget so small that the Graph group would take the room of
    /// the only accepted IR group, the request continues with the IR group.
    #[test]
    fn a_graph_group_never_crowds_out_the_required_accepted_ir() -> Result<()> {
        let s = scenario()?;
        let (full, _) = run_pool(&s.db, &s.revisions, Some(&s.candidates), 100_000, 0)?;
        let g0 = full.graph.as_ref().unwrap().groups()[0]
            .group_id()
            .to_owned();
        let tokens_g0 = group_tokens(&full, &g0);
        let budget = 1 + tokens_g0;
        let (control, control_bytes) = run_pool(&s.db, &s.revisions, None, budget, 0)?;
        ensure!(
            control
                .selected_items
                .iter()
                .any(|selected| matches!(selected.item(), ContextItemKind::AcceptedIr { .. })),
            "the control request holds accepted IR"
        );
        let (pooled, bytes) = run_pool(&s.db, &s.revisions, Some(&s.candidates), budget, 0)?;
        let outcome = pooled.graph.as_ref().unwrap();
        assert_eq!(
            outcome.dropped_reason(),
            Some(Nir1GraphDropReason::WouldRemoveRequiredAcceptedIr)
        );
        assert!(outcome.groups().is_empty());
        assert_eq!(pooled.packed, control.packed);
        assert_eq!(pooled.selected_items, control.selected_items);
        assert_eq!(bytes, control_bytes);
        Ok(())
    }

    /// A-2: when the shared 2 MiB envelope cannot hold the Graph groups, they
    /// are not added, the request continues, and no accepted IR group is lost.
    #[test]
    fn graph_groups_that_do_not_fit_the_input_envelope_are_not_added() -> Result<()> {
        let s = scenario()?;
        let headroom = |bytes: usize| MAX_PACKING_INPUT_BYTES - s.control_bytes - bytes;
        // Room for none of the two Graph groups.
        let (pooled, bytes) = run_pool(
            &s.db,
            &s.revisions,
            Some(&s.candidates),
            100_000,
            headroom(GRAPH_GROUP_EXTRA_BYTES - 1),
        )?;
        let outcome = pooled.graph.as_ref().unwrap();
        assert_eq!(outcome.dropped_reason(), None);
        assert!(outcome.groups().is_empty());
        assert_eq!(outcome.limited_count(), 2);
        assert_eq!(pooled.selected_items, s.control.selected_items);
        assert_eq!(
            bytes,
            s.control_bytes + headroom(GRAPH_GROUP_EXTRA_BYTES - 1)
        );
        // Room for the first only: a prefix in Graph order, never half a group.
        let (pooled, _) = run_pool(
            &s.db,
            &s.revisions,
            Some(&s.candidates),
            100_000,
            headroom(GRAPH_GROUP_EXTRA_BYTES),
        )?;
        let outcome = pooled.graph.as_ref().unwrap();
        assert_eq!(outcome.groups().len(), 1);
        assert_eq!(outcome.limited_count(), 1);
        assert_eq!(pooled.selected_items.len(), s.control.selected_items.len());
        let first = outcome.groups()[0].clone();
        assert_eq!(
            pooled
                .selected_items
                .iter()
                .filter(|selected| item_group(selected.item()) == Some(first.group_id()))
                .count(),
            5
        );
        // The other relation keeps its accepted IR group.
        let second = &s.candidates.edges()[1];
        assert!(pooled.selected_items.iter().any(|selected| {
            item_group(selected.item())
                == Some(ir_group_id(second.revision_id(), &second.edge_id).as_str())
        }));
        Ok(())
    }

    /// A-2: the Graph order is the hop, then the Graph's own traversal order.
    #[test]
    fn graph_groups_are_ordered_by_hop_then_traversal() -> Result<()> {
        let s = scenario()?;
        let farther_first = candidates_from(&s.control.bindings, &[1, 0])?;
        let (pooled, _) = run_pool(&s.db, &s.revisions, Some(&farther_first), 100_000, 0)?;
        let outcome = pooled.graph.as_ref().unwrap();
        assert_eq!(
            outcome
                .groups()
                .iter()
                .map(|group| group.revision_id().to_owned())
                .collect::<Vec<_>>(),
            vec![s.revisions[1].clone(), s.revisions[0].clone()]
        );
        let same_hop = candidates_from(&s.control.bindings, &[1, 1])?;
        let (pooled, _) = run_pool(&s.db, &s.revisions, Some(&same_hop), 100_000, 0)?;
        assert_eq!(
            pooled
                .graph
                .as_ref()
                .unwrap()
                .groups()
                .iter()
                .map(|group| group.revision_id().to_owned())
                .collect::<Vec<_>>(),
            s.revisions
        );
        Ok(())
    }

    /// A-9 (db side): A2 and A3 decide per Revision in the same snapshot.
    #[test]
    fn a2_a3_unavailable_and_unselected_revisions_lose_only_their_graph_group() -> Result<()> {
        // A2: the second Revision's payload is broken after the Graph answered.
        let s = scenario()?;
        s.db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_proposal_revisions SET payload_json='{' WHERE id=?1",
                params![s.revisions[1]],
            )?;
            Ok(())
        })?;
        let (pooled, _) = run_pool(&s.db, &s.revisions, Some(&s.candidates), 100_000, 0)?;
        let outcome = pooled.graph.as_ref().unwrap();
        assert_eq!(
            outcome
                .excluded()
                .iter()
                .map(|e| (e.revision_id().to_owned(), e.reason().code()))
                .collect::<Vec<_>>(),
            vec![(
                s.revisions[1].clone(),
                "revision-unavailable:revision-payload-invalid".to_owned()
            )]
        );
        assert_eq!(outcome.groups().len(), 1);
        assert_eq!(outcome.groups()[0].revision_id(), s.revisions[0]);
        // The request continues with the Revision A2 accepts; the broken
        // Revision has no item at all, accepted IR or Graph.
        assert!(pooled
            .selected_items
            .iter()
            .all(|selected| selected.owner_revision_id.as_deref() != Some(&s.revisions[1])));
        assert_eq!(pooled.excluded.len(), 1);

        // Not listed by the Native selection: the Graph names it, the pooled
        // read did not list it.
        let s = scenario()?;
        let listed = vec![s.revisions[0].clone()];
        let (pooled, _) = run_pool(&s.db, &listed, Some(&s.candidates), 100_000, 0)?;
        let outcome = pooled.graph.as_ref().unwrap();
        assert_eq!(
            outcome
                .excluded()
                .iter()
                .map(|e| (e.revision_id().to_owned(), e.reason()))
                .collect::<Vec<_>>(),
            vec![(
                s.revisions[1].clone(),
                Nir1GraphExclusionReason::RevisionNotSelected
            )]
        );
        assert_eq!(outcome.groups().len(), 1);

        // A3: a secret Foreshadow whose payoff is not confirmed denies Alice's
        // reveal; every Revision of the fixture holds Alice.
        let s = scenario()?;
        s.db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO foreshadows
                    (id, project_id, title, payoff_confirmed, abandoned, secret,
                     payoff_scene_id, created_at, updated_at)
                 VALUES ('di1a-reveal', 'default-project', 'Reveal', 0, 0, 1, NULL, 0, 0)",
                [],
            )?;
            conn.execute(
                "INSERT INTO foreshadow_codex_links (foreshadow_id, codex_entry_id)
                 VALUES ('di1a-reveal', 'nir1-alice')",
                [],
            )?;
            Ok(())
        })?;
        let (pooled, _) = run_pool(&s.db, &s.revisions, Some(&s.candidates), 100_000, 0)?;
        let outcome = pooled.graph.as_ref().unwrap();
        assert!(outcome.groups().is_empty());
        assert_eq!(
            outcome
                .excluded()
                .iter()
                .map(|e| e.reason().code())
                .collect::<Vec<_>>(),
            vec!["revision-unavailable:a3-reveal-unavailable"; 2]
        );
        // Nothing but the Raw remains, as before the Graph: the request meets
        // the required-context rule later, exactly as without the Graph.
        assert!(pooled
            .selected_items
            .iter()
            .all(|selected| matches!(selected.item(), ContextItemKind::Raw { .. })));
        Ok(())
    }

    /// A-9: every closed A2 reason leaves exactly one Revision's group out.
    #[test]
    fn every_closed_a2_reason_maps_to_a_closed_graph_exclusion() -> Result<()> {
        type Break = fn(&Database, &str) -> Result<()>;
        let cases: [(&str, Break); 3] = [
            ("revision-payload-invalid", |db, revision_id| {
                db.with_conn(|conn| {
                    conn.execute(
                        "UPDATE narrative_proposal_revisions SET payload_json='{' WHERE id=?1",
                        params![revision_id],
                    )?;
                    Ok(())
                })
            }),
            ("revision-not-human-approved", |db, revision_id| {
                db.with_conn(|conn| {
                    conn.execute(
                        "UPDATE narrative_proposal_decisions
                            SET actor_kind='automated', actor_id='electron:automated-review',
                                authority_scope='automated'
                          WHERE revision_id=?1",
                        params![revision_id],
                    )?;
                    Ok(())
                })
            }),
            ("revision-decision-ambiguous", |db, revision_id| {
                db.with_conn(|conn| {
                    conn.execute(
                        "INSERT INTO narrative_proposal_decisions
                            (id, proposal_id, revision_id, decision, decision_json, created_at,
                             created_by, actor_kind, actor_id, authority_scope,
                             override_field_paths_json)
                         SELECT 'ambiguous-' || id, proposal_id, revision_id, 'approved', '{}',
                                created_at, 'automation', 'automated',
                                'electron:automated-review', 'automated', '[]'
                           FROM narrative_proposal_decisions WHERE revision_id=?1",
                        params![revision_id],
                    )?;
                    Ok(())
                })
            }),
        ];
        for (reason, break_revision) in cases {
            let s = scenario()?;
            break_revision(&s.db, &s.revisions[0])?;
            let (pooled, _) = run_pool(&s.db, &s.revisions, Some(&s.candidates), 100_000, 0)?;
            let outcome = pooled.graph.as_ref().unwrap();
            assert_eq!(
                outcome
                    .excluded()
                    .iter()
                    .map(|e| (e.revision_id().to_owned(), e.reason().code()))
                    .collect::<Vec<_>>(),
                vec![(
                    s.revisions[0].clone(),
                    format!("revision-unavailable:{reason}")
                )],
                "{reason}"
            );
            assert_eq!(outcome.groups().len(), 1, "{reason}");
            assert_eq!(
                outcome.groups()[0].revision_id(),
                s.revisions[1],
                "{reason}"
            );
        }
        Ok(())
    }

    fn synthetic_scope() -> grimodex_core::narrative_nir1::ScopeBinding {
        grimodex_core::narrative_nir1::ScopeBinding {
            reading: ScopeValue::LegacyAbsent,
            story: ScopeValue::LegacyAbsent,
            auto: ScopeValue::LegacyAbsent,
            phase: "draft".into(),
            reveal: "none".into(),
            pov: None,
            authority_revision: "authority".into(),
        }
    }

    fn synthetic_entity(id: &str) -> Arc<EntityInput> {
        Arc::new(EntityInput {
            entity_id: id.into(),
            entity_type: "character".into(),
            label: format!("LABEL-SENTINEL-{id}"),
            source_token: format!("codex:{id}@1"),
            scope: synthetic_scope(),
            evidence: vec![EvidenceInput {
                evidence_id: format!("evidence-{id}"),
                source_ref: format!("codex:{id}"),
                quote: format!("QUOTE-SENTINEL-{id}"),
                start_utf16: 0,
                end_utf16: 4,
            }],
        })
    }

    fn synthetic_binding(revision: &str) -> Arc<Nir1GraphMaterialBinding> {
        Arc::new(Nir1GraphMaterialBinding {
            revision_id: revision.into(),
            decision_id: format!("{revision}-decision"),
            decision_token: format!("{revision}-decision-token"),
            freshness_token: format!("{revision}-freshness-token"),
            scope_authority_revision: "authority".into(),
            query_scene_source_token: "v1@now".into(),
            query_scene_scope_token: "scope-token".into(),
            query_scene_incarnation_id: "incarnation".into(),
            reveal_state_token: "reveal-token".into(),
        })
    }

    fn synthetic_projection() -> Nir1GraphProjection {
        let binding = synthetic_binding("revision-a");
        let entities = ["e-seed", "e-one", "e-two"].map(synthetic_entity);
        let nodes = [(0usize, 0u8), (1, 1), (2, 1)]
            .into_iter()
            .map(|(index, hop)| Nir1GraphNode {
                entity: Arc::clone(&entities[index]),
                hop,
                bindings: vec![Arc::clone(&binding)],
                binding_scopes: vec![Arc::new(synthetic_scope())],
            })
            .collect();
        let edge = |id: &str, from: usize, to: usize| Nir1GraphEdge {
            relation: Arc::new(GraphEdgeInput {
                edge_id: id.into(),
                from_entity_id: entities[from].entity_id.clone(),
                to_entity_id: entities[to].entity_id.clone(),
                relation_type: "TYPE-SENTINEL".into(),
                directionality: "directed".into(),
                source_token: "relation-source".into(),
                evidence_ids: vec![format!("evidence-{}", entities[from].entity_id)],
            }),
            from: Arc::clone(&entities[from]),
            to: Arc::clone(&entities[to]),
            binding: Arc::clone(&binding),
        };
        Nir1GraphProjection {
            project_id: "project-x".into(),
            query_scene_id: "scene-x".into(),
            scope_revision: Some("authority".into()),
            graph: Nir1QualifiedGraph {
                seed_entity_id: "e-seed".into(),
                generation: GENERATION,
                nodes,
                edges: vec![edge("edge-1", 0, 1), edge("edge-2", 1, 2)],
                scene_total: 1,
                scenes: vec![Nir1GraphSceneAssociation {
                    scene_id: "SCENE-SENTINEL".into(),
                    scene_incarnation_id: Some("INCARNATION-SENTINEL".into()),
                    scene_source_token: "SOURCE-SENTINEL".into(),
                    scene_scope_token: Some("SCOPE-SENTINEL".into()),
                    pin_rowid: 424_242,
                    pin_entry_id: "PIN-ENTRY-SENTINEL".into(),
                    pin_created_at: "PIN-CREATED-SENTINEL".into(),
                    path_hop: 1,
                    path_edge_indices: vec![0],
                }],
            },
            elapsed: std::time::Duration::from_millis(1),
        }
    }

    /// A-1 and A-13: the candidate is built from IDs and tokens only. Neither
    /// the worker's text nor a Scene association (K2/4 Mandatory defense 2)
    /// can reach the request.
    #[test]
    fn a_candidate_keeps_identifiers_and_tokens_and_no_text_or_scene_association() -> Result<()> {
        let projection = synthetic_projection();
        let candidates = Nir1GraphCandidates::from_projection(&projection)?;
        assert_eq!(candidates.project_id(), "project-x");
        assert_eq!(candidates.query_scene_id(), "scene-x");
        assert_eq!(candidates.seed_entity_id(), "e-seed");
        assert_eq!(candidates.generation(), GENERATION);
        assert_eq!(candidates.scope_revision(), Some("authority"));
        // The hop of an edge is the nearer endpoint's: edge-2 joins two Entities
        // one hop from the seed.
        assert_eq!(
            candidates
                .edges()
                .iter()
                .map(|edge| (edge.edge_id.as_str(), edge.hop, edge.revision_id()))
                .collect::<Vec<_>>(),
            vec![("edge-1", 0, "revision-a"), ("edge-2", 1, "revision-a")]
        );
        let debug = format!("{candidates:?}");
        for text in [
            "LABEL-SENTINEL",
            "QUOTE-SENTINEL",
            "TYPE-SENTINEL",
            "SCENE-SENTINEL",
            "INCARNATION-SENTINEL",
            "SOURCE-SENTINEL",
            "SCOPE-SENTINEL",
            "PIN-ENTRY-SENTINEL",
            "PIN-CREATED-SENTINEL",
            "424242",
        ] {
            assert!(!debug.contains(text), "the candidate holds {text}");
        }
        // The same holds for a pool outcome.
        let s = scenario()?;
        let (pooled, _) = run_pool(&s.db, &s.revisions, Some(&s.candidates), 100_000, 0)?;
        let rendered = format!("{:?}", pooled.graph);
        for text in ["SENTINEL", "Alice", "Bob"] {
            assert!(!rendered.contains(text), "the outcome holds {text}");
        }
        // The edge bound of the Graph holds at the candidate too.
        let edge = candidates.edges()[0].clone();
        assert!(Nir1GraphCandidates::new(
            "p".into(),
            "s".into(),
            "e".into(),
            1,
            None,
            vec![edge; MAX_GRAPH_EDGES + 1],
        )
        .is_err());
        Ok(())
    }

    /// A graph for an endpoint that is not a node cannot be projected.
    #[test]
    fn a_projection_with_an_unknown_endpoint_is_refused() {
        let mut projection = synthetic_projection();
        projection.graph.nodes.pop();
        projection.graph.nodes.pop();
        assert_eq!(
            Nir1GraphCandidates::from_projection(&projection)
                .unwrap_err()
                .to_string(),
            "NIR1_GRAPH_CANDIDATE_ENDPOINT_MISSING"
        );
    }

    /// A caller-supplied Revision list never carries a Graph.
    #[test]
    fn a_caller_revision_list_ignores_the_graph() -> Result<()> {
        let s = scenario()?;
        let raw = raw();
        let (pooled, bytes) = s.db.with_read_transaction(|conn| {
            let mut budget = NativePackingInputBudget::default();
            let pooled = read_and_pack_native_a2_context_in_tx_with_raw_charge(
                conn,
                NativeNir1PooledPackingRequest {
                    graph: Some(&s.candidates),
                    ..request(&s.revisions, &raw, 100_000)
                },
                &mut budget,
                RawBudgetCharge::Charge,
                RevisionUnavailablePolicy::Reject,
                &mut |_| Ok(()),
                &mut || Ok(()),
            )?;
            Ok((pooled, budget.used_bytes))
        })?;
        assert_eq!(
            pooled.graph.as_ref().unwrap().dropped_reason(),
            Some(Nir1GraphDropReason::NotNativeSelection)
        );
        assert_pool_unchanged(&s, &pooled, bytes);
        Ok(())
    }
}
