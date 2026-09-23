use super::*;
use crate::narrative_extraction::incremental_freshness::run_incremental_freshness_cycle;
use crate::narrative_extraction::nir1_entity_relation::create_nir1_entity_relation_revision;
use crate::narrative_extraction::nir1_entity_relation::tests::{
    approve_typed_revision, create_typed_run, prepare_a3_scope_fixture, request_for_run,
    seed_run_and_catalog,
};
use crate::narrative_extraction::{
    read_retrieval_scene_source, RetrievalSceneSourceBinding, RetrievalSceneSourceRead,
};
use crate::test_support::current_schema_memory;
use rusqlite::params;

const RAW_SOURCE_PROJECT: &str = "default-project";
const RAW_SOURCE_SCENE: &str = "a3-future";

fn fixture(db: &Database) -> Result<Vec<String>> {
    fixture_with_query_source(db, None)
}

fn fixture_with_query_source(db: &Database, source_storage: Option<&str>) -> Result<Vec<String>> {
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
        approve_typed_revision(db, &run_id, &created)?;
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
    }
}

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
    }
}

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
            request(&revisions, std::slice::from_ref(&source_raw), 100_000),
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
    let (pooled, pooled_bytes) = db.with_read_transaction(|conn| {
        let source = match read_retrieval_scene_source_bounded(
            conn,
            RAW_SOURCE_PROJECT,
            RAW_SOURCE_SCENE,
            MAX_PACKING_INPUT_BYTES,
            MAX_PACKING_INPUT_BYTES,
            &mut || Ok(()),
            &mut |_| Ok(()),
        )? {
            RetrievalSceneSourceRead::Available(source) => source,
            RetrievalSceneSourceRead::Unavailable { .. } => {
                anyhow::bail!("query Source unavailable before snapshot pin")
            }
        };
        ensure!(
            source.canonical_source_text == source_body,
            "canonical query Source body was truncated or changed"
        );
        ensure!(
            source.canonical_source_text.encode_utf16().count() > 500,
            "canonical query Source body must exceed 500 UTF-16 units"
        );
        ensure!(
            source.query_source == binding,
            "snapshot pin changed Source binding"
        );

        // Pin the caller-owned transaction with the exact query Source reader,
        // then commit both Source and A2-input changes from a distinct WAL
        // connection before composing the pooled read on this same transaction.
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

        let mut budget = NativePackingInputBudget::default();
        let pooled = read_and_pack_native_a2_context_with_source_raw_in_tx(
            conn,
            source_request(&revisions, 100_000),
            source_ref,
            &mut budget,
            &mut |_| Ok(()),
            &mut || Ok(()),
        )?;
        Ok((pooled, budget.used_bytes))
    })?;

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
            source_request(&revisions, 100_000),
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
