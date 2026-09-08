use super::*;
use grimodex_semantic::runtime::SemanticEmbeddingIdentity;

pub(super) fn run(
    state: &AppState,
    lease: &Lease,
    query: &Arc<AuditedSemanticQuery>,
) -> Result<OperationResult> {
    ensure!(
        lease.is_live(Instant::now()) && current_request(state, &lease.data.request)?,
        "RELATED_SCENES_INVALIDATED"
    );
    let op = &lease.data;
    let db = op.request.database();
    let batch = db.with_read_transaction(|conn| {
        index::qualify_chronicle_index_snapshot(
            conn,
            db.nir_chronicle_index_runtime(),
            &op.original,
        )
    })?;
    let index::NirQualifiedRead::Qualified(batch) = batch else {
        return Err(anyhow!("RELATED_SCENES_INDEX_UNAVAILABLE"));
    };
    let batch = Arc::new(batch);
    let scores = if let Some(model) = batch.model_identity() {
        let identity = SemanticEmbeddingIdentity {
            model_id: model.model_id.clone(),
            artifact_sha256: model.artifact_sha256.clone(),
            tokenizer_sha256: model.tokenizer_sha256.clone(),
            embedding_dim: model.embedding_dim,
            chunker_version: model.chunker_version.clone(),
        };
        let vectors = batch
            .documents()
            .iter()
            .map(|doc| doc.embedding())
            .collect::<Vec<_>>();
        state
            .semantic
            .score_accepted_documents(query, &identity, &vectors)?
    } else {
        ensure!(
            batch.documents().is_empty(),
            "RELATED_SCENES_INDEX_MODEL_UNAVAILABLE"
        );
        Vec::new()
    };
    let mut navigation = HashMap::new();
    let mut ranked = Vec::new();
    for (document_index, (document, score)) in batch.documents().iter().zip(scores).enumerate() {
        ensure!(score.is_finite(), "RELATED_SCENES_SCORE_INVALID");
        for (evidence_index, _) in document.evidence_handles().iter().enumerate() {
            ranked.push((score, document_index, evidence_index));
        }
    }
    // All documents were admitted before scoring. Rank the complete admitted
    // pool before loading display-only titles/JSON and minting navigation IDs.
    ranked.sort_by(|a, b| {
        let ad = &batch.documents()[a.1];
        let bd = &batch.documents()[b.1];
        let ae = &ad.evidence_handles()[a.2];
        let be = &bd.evidence_handles()[b.2];
        b.0.total_cmp(&a.0)
            .then(ae.scene_id().cmp(be.scene_id()))
            .then(ad.revision_id().cmp(bd.revision_id()))
            .then(ae.evidence_id().cmp(be.evidence_id()))
    });
    let mut scenes = Vec::new();
    db.with_read_transaction(|conn| {
        let language: String = conn.query_row(
            "SELECT language FROM projects WHERE id=?1",
            [op.source.project_id()],
            |row| row.get(0),
        )?;
        // Approved A5 candidate 2; Raw retains its independently frozen gates.
        let (floor, cap) = ranking_policy::for_language(&language)?;
        let mut seen = HashSet::new();
        for (score, document_index, evidence_index) in ranked {
            if f64::from(score) < floor {
                continue;
            }
            let document = &batch.documents()[document_index];
            let evidence = &document.evidence_handles()[evidence_index];
            if !seen.insert(evidence.scene_id()) {
                continue;
            }
            let interpretation: Value =
                serde_json::from_str(&document.document().serialized_statement)?;
            let title: String = conn.query_row(
                "SELECT title FROM tree_nodes WHERE id=?1 AND project_id=?2 AND archived_at IS NULL",
                [evidence.scene_id(), op.source.project_id()],
                |row| row.get(0),
            )?;
            let identity = format!("related-scenes-evidence:{}", uuid::Uuid::new_v4());
            let row = json!({
                "sceneId": evidence.scene_id(), "sceneTitle": title, "irCosine": score,
                "interpretation": interpretation,
                "validatedEvidence": {"excerpt": evidence.excerpt(), "navigationIdentity": identity},
                "review": "human-approved", "freshness": "fresh"
            });
            scenes.push(row);
            navigation.insert(identity, evidence.clone());
            if scenes.len() == cap {
                break;
            }
        }
        ensure!(
            index::validate_chronicle_query_snapshot(
                conn, db.nir_chronicle_index_runtime(), &batch
            )?,
            "RELATED_SCENES_INVALIDATED"
        );
        Ok(())
    })?;
    state.semantic.validate_audited_query_current(query)?;
    ensure!(
        lease.is_live(Instant::now()) && current_request(state, &op.request)?,
        "RELATED_SCENES_INVALIDATED"
    );
    Ok(OperationResult {
        batch: Some(batch),
        query: Some(query.clone()),
        navigation,
        response: Some(
            json!({"status":"available","queryBinding":op.query_binding,"scenes":scenes}),
        ),
    })
}
