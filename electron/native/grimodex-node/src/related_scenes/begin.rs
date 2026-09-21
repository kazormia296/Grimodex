use super::*;

fn raw_wire_value<T: serde::Serialize>(value: &T) -> Result<Value> {
    // Raw serializes f32 directly to JSON. json!(hits) widens it to f64
    // first, changing the JS score at gate/tie boundaries.
    Ok(serde_json::from_str(&serde_json::to_string(value)?)?)
}

pub(crate) async fn begin(state: Arc<AppState>, dto: BeginRequest) -> Result<Value> {
    let accepted_at = Instant::now();
    ensure!(
        !dto.owner_key.trim().is_empty()
            && !dto.project_id.trim().is_empty()
            && !dto.current_scene_id.trim().is_empty()
            && !dto.query.trim().is_empty()
            && dto.query.encode_utf16().count() <= 500,
        "RELATED_SCENES_INVALID_REQUEST"
    );
    // Keep a lifecycle participant for the registry entry and every detached
    // scoring/build task. The short-lived pin below only validates the launch
    // binding; the participant is the long-lived ownership proof.
    let participant = state
        .ws
        .lifecycle_core()
        .begin_workspace_participant()
        .map_err(|error| anyhow!(error.to_string()))?;
    // Pin before entering the blocking queue, as in the existing Raw command.
    let request = crate::pin_scoped_semantic_request(&state, &dto.expected_workspace_path)
        .map_err(|_| anyhow!("RELATED_SCENES_WORKSPACE_CHANGED"))?;
    let spawn = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        begin_blocking(state, request, participant, dto, spawn, accepted_at)
    })
    .await?
}

fn begin_blocking(
    state: Arc<AppState>,
    request: SemanticRequest,
    participant: grimodex_db::workspace_lifecycle::WorkspaceParticipant,
    dto: BeginRequest,
    spawn: tokio::runtime::Handle,
    accepted_at: Instant,
) -> Result<Value> {
    ensure!(
        current_request(&state, &request)?,
        "RELATED_SCENES_WORKSPACE_CHANGED"
    );
    let db = request.database();
    let mut lifecycle_control =
        build::RelatedScenesBuildControl::new(&state, &request, &participant);
    let (source, snapshot, original) = db.with_read_transaction(|conn| {
        let RetrievalSceneSourceRead::Available(source) =
            read_retrieval_scene_source(conn, &dto.project_id, &dto.current_scene_id)?
        else {
            return Err(anyhow!("RELATED_SCENES_QUERY_SOURCE_UNAVAILABLE"));
        };
        let source = RelatedScenesSourceContext::capture(source, &dto.query)?;
        let status = index::read_chronicle_query_status_with_control(
            conn,
            db.nir_chronicle_index_runtime(),
            &dto.project_id,
            &dto.current_scene_id,
            &mut lifecycle_control,
        )?;
        let (snapshot, original) = match status {
            index::NirQueryStatusRead::Available {
                index_usable,
                snapshot,
                ..
            } => (
                SnapshotEligibility {
                    original_snapshot_usable: index_usable,
                    supported_profile: true,
                },
                snapshot,
            ),
            index::NirQueryStatusRead::Unavailable { .. } => (
                SnapshotEligibility {
                    original_snapshot_usable: false,
                    supported_profile: false,
                },
                None,
            ),
        };
        Ok((Arc::new(source), snapshot, original))
    })?;
    let first_snapshot_elapsed_ms = accepted_at.elapsed().as_secs_f64() * 1000.0;
    let query_binding = format!("related-scenes-query:{}", uuid::Uuid::new_v4());
    let mut ir = unavailable(if snapshot.supported_profile {
        "index-unavailable"
    } else {
        "unsupported-query"
    });
    // Expired entries are invalidated before allocation, so pruning cannot
    // silently eat the final UI withdrawal signal.
    let expired = lock(&state.related_scenes.registry)?.entries();
    for (ticket, lease) in expired {
        if !lease.is_live(Instant::now()) {
            invalidate(&state, &ticket, &lease)?;
        }
    }
    let ticket = if snapshot.original_snapshot_usable && snapshot.supported_profile {
        let operation = Operation {
            request: request.clone(),
            participant: participant.clone(),
            source: source.clone(),
            query_binding: query_binding.clone(),
            original: original.ok_or_else(|| anyhow!("RELATED_SCENES_SNAPSHOT_UNAVAILABLE"))?,
            result: Mutex::new(OperationResult::default()),
            completed: Notify::new(),
        };
        let ticket = lock(&state.related_scenes.registry)?.insert(
            &dto.owner_key,
            snapshot,
            operation,
            Instant::now(),
        );
        ir = match &ticket {
            Some(ticket) => json!({"status":"pending","operationTicket":ticket}),
            None => unavailable("capacity"),
        };
        ticket
    } else {
        None
    };
    // Exactly one audited query embedding serves both consumers. Raw uses the
    // same limit, scope and description mode as the previous entry point.
    let outcome = (|| -> Result<Value> {
        let query = Arc::new(state.semantic.prepare_related_scene_query(
            &request,
            &dto.project_id,
            source.query(),
            RAW_LIMIT,
        )?);
        if let Some(ticket) = &ticket {
            if let Some(lease) = state.related_scenes.owned(&dto.owner_key, ticket)? {
                lock(&lease.data.result)?.query = Some(query.clone());
                let ir_state = state.clone();
                let ir_ticket = ticket.clone();
                let ir_query = query.clone();
                spawn.spawn_blocking(move || {
                    let result = scoring::run(&ir_state, &lease, &ir_query);
                    match result {
                        Ok(result) => {
                            if let Ok(mut slot) = lock(&lease.data.result) {
                                *slot = result;
                            }
                        }
                        Err(_) => {
                            if let Ok(mut slot) = lock(&lease.data.result) {
                                slot.response = Some(unavailable("failed"));
                            }
                        }
                    }
                    if !lease.is_live(Instant::now()) {
                        let _ = invalidate(&ir_state, &ir_ticket, &lease);
                    }
                    lease.data.completed.notify_waiters();
                });
            }
        }
        let hits = state
            .semantic
            .semantic_search_with_query(&query, RAW_LIMIT, None, None)?;
        ensure!(
            current_request(&state, &request)?,
            "RELATED_SCENES_WORKSPACE_CHANGED"
        );
        let source_current = db.with_read_transaction(|conn| {
            let RetrievalSceneSourceRead::Available(current) =
                read_retrieval_scene_source(conn, &dto.project_id, &dto.current_scene_id)?
            else {
                return Ok(false);
            };
            Ok(source.matches(&current))
        })?;
        ensure!(source_current, "RELATED_SCENES_QUERY_SOURCE_CHANGED");
        Ok(
            json!({"status":"raw-ready","denseHits":raw_wire_value(&hits)?,"snapshot":{
            "queryBinding":query_binding,"originalSnapshotUsable":snapshot.original_snapshot_usable,
            "supportedProfile":snapshot.supported_profile},"ir":ir,
            "timing":{"clock":"native-monotonic","firstSnapshotElapsedMs":first_snapshot_elapsed_ms,
                "rawReadyElapsedMs":accepted_at.elapsed().as_secs_f64()*1000.0}}),
        )
    })();
    if outcome.is_err() {
        if let Some(ticket) = &ticket {
            release(&state, &dto.owner_key, ticket)?;
        }
    }
    if snapshot.supported_profile && current_request(&state, &request)? {
        build::schedule(state.clone(), request, participant, dto.project_id)?;
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn raw_scores_preserve_the_original_direct_f32_json_transport() {
        #[derive(serde::Serialize)]
        struct Hit {
            score: f32,
        }
        let hits = vec![
            Hit {
                score: 0.722_992_96,
            },
            Hit { score: 0.638_797_2 },
            Hit {
                score: 0.849_999_96,
            },
        ];
        let original = serde_json::to_string(&hits).expect("existing Raw transport");
        assert_eq!(
            raw_wire_value(&hits)
                .expect("hybrid Raw transport")
                .to_string(),
            original
        );
        assert_ne!(
            json!(hits).to_string(),
            original,
            "widening to f64 changes the wire score"
        );
    }
}
