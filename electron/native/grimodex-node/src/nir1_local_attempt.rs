//! Internal NIR-1 local attempt coordinator (DI-1c S3). It joins the Native
//! pieces that exist separately:
//!
//! 1. the owner's `capture` (profile permit, session slot, Ready binding),
//! 2. the Native selection prepare (the trusted Native chooses the Revisions;
//!    the Scene incarnation, the Scope binding and the restore epoch are read
//!    in the same snapshot as the D-final inputs),
//! 3. the handoff, assembled into a `FinalDispatchRequest` that binds the
//!    scope, material and D1 digests, the credential-free endpoint identity
//!    digest, the purpose and a lifetime (never an absolute time),
//! 4. the owner's `create`, which re-reads the capture, the Scope binding and
//!    the restore epoch and decides the times from Native's clock,
//! 5. a re-observation of the adopted inputs with the private witness, and of
//!    the workspace, the profile and route, and shutdown,
//! 6. the owner's `claim_for_transport`, which re-reads the capture, the Scope
//!    binding and the restore epoch once more.
//!
//! Any difference found after `create` and before the claim abandons the
//! attempt (a transport-less terminal, nothing sent). The coordinator is a
//! `pub(crate)` Native-internal function with no IPC, preload or N-API entry
//! and no transport; the caller is a test or the DD-1a entry
//! (`nir1_local_entry`). It reads no AI use policy: the DD-1a entry checks it
//! between `Nir1LocalAttempt::capture` and `run` (DR-DD1A-5).

#![cfg_attr(not(test), allow(dead_code))]

use std::sync::Arc;

use anyhow::{ensure, Context, Result};
use grimodex_core::canonical_json_digest;
use grimodex_db::narrative_extraction::{NativeNir1AuthorityBinding, NativeNir1GraphBinding};
use grimodex_db::nir1_generation::history_context::HistoryContextSlot;
use grimodex_db::nir1_generation::{
    d1_selection_digest, AttemptSceneBinding, Nir1ExpectedScope, ReadBudget,
    NIR1_ATTEMPT_MAX_LIFETIME_MS,
};
use serde_json::{json, Value};

use crate::nir1_generation::FinalDispatchRequest;
use crate::nir1_generation_owner::{
    Nir1GenerationOwner, Nir1GenerationRefusal, Nir1Settlement, Nir1TransportDecision,
    Nir1TransportOwner,
};
#[cfg(test)]
use crate::nir1_prepared_request::prepare_selected_local_chat_request_with_graph;
use crate::nir1_prepared_request::{
    parse_loopback_chat_completions_endpoint, prepare_selected_local_chat_request,
    reobserve_prepared_for_dispatch, LocalGenerationIntent, LoopbackChatEndpoint,
    NativeAcceptedChatSubmission, PrivateDTransportHandoff, UnsupportedInputIntent,
};
use crate::profile_egress::CallerIdentity;
use crate::state::AppState;

/// How long a created attempt may wait for its claim (DR-DI1C-4).
///
/// The stages between the create and the claim are each bounded: the
/// re-observation of the adopted inputs runs under one participant read budget
/// (`PREPARATION_SQL_TIMEOUT`, 20 s) plus the file reads of the route and
/// short mutexes, and the claim is one admission writer (mutex 100 ms, busy
/// 100 ms, operation 250 ms) followed by a start decision that reads no
/// database. Their worst-case sum is about 21 s; 60 s leaves about three times
/// that for scheduling. It is well under the 300 s cap that the store applies
/// (`NIR1_ATTEMPT_MAX_LIFETIME_MS`), and the claim refuses an attempt at
/// `now >= expires_at_ms` (DT-2), so a request that waited longer is not sent.
pub(crate) const NIR1_LOCAL_ATTEMPT_LIFETIME_MS: i64 = 60_000;

const _: () = assert!(
    NIR1_LOCAL_ATTEMPT_LIFETIME_MS > 0
        && NIR1_LOCAL_ATTEMPT_LIFETIME_MS <= NIR1_ATTEMPT_MAX_LIFETIME_MS
);

/// Caps on the references (input rows plus qualification rows) of one
/// attempt, applied by the store when it validates the create and when it
/// reads the rows back (DR-DI1C-4). The D-final item cap is
/// `MAX_PACKING_ITEMS` (512) inputs; each Revision input carries a handful of
/// qualification rows (Scope axes and material Scenes, Decision, Freshness,
/// Index, D1). 16 references per input slot, at 1 KiB each, is the generous
/// ceiling: a request over it is refused at the create (`NIR1_GENERATION_REF_LIMIT`,
/// nothing committed) and never truncated.
pub(crate) const NIR1_LOCAL_ATTEMPT_READ_BUDGET: ReadBudget = ReadBudget {
    max_references: grimodex_db::narrative_extraction::NATIVE_ATTEMPT_MAX_REFERENCES,
    max_reference_bytes: grimodex_db::narrative_extraction::NATIVE_ATTEMPT_MAX_REFERENCE_BYTES,
};

/// A refusal before any attempt row exists, or one that leaves the owner's
/// own unresolved state (`Owner(Nir1GenerationRefusal::Unresolved)`).
#[derive(Debug)]
#[non_exhaustive]
pub(crate) enum Nir1LocalAttemptRefusal {
    /// The unsupported-input intent or Main's key verdict refused, or the
    /// Native preparation failed (a closed `NIR1_*` code in the error).
    Prepare(anyhow::Error),
    /// The handoff could not be assembled into a final request.
    Assembly(anyhow::Error),
    /// The owner refused the capture or the create.
    Owner(Nir1GenerationRefusal),
}

impl Nir1LocalAttemptRefusal {
    /// A closed, text-free description for a caller's log or typed error:
    /// the `NIR1_*` code of a preparation or assembly failure, or the
    /// owner's refusal kind.
    pub(crate) fn reason(&self) -> String {
        match self {
            Self::Prepare(error) | Self::Assembly(error) => error.to_string(),
            Self::Owner(refusal) => format!("{refusal:?}"),
        }
    }
}

/// What a coordinator run ended with. Only `Start` carries a send authority,
/// and only once.
pub(crate) enum Nir1LocalAttemptOutcome {
    /// The attempt is claimed and the start decision passed.
    Start(Nir1TransportOwner),
    /// The claim or the start decision stopped; the owner settled it.
    NotStarted(Nir1Settlement),
    /// The re-observation before the claim found a difference. The attempt was
    /// abandoned (a transport-less terminal) and nothing was claimed.
    Abandoned {
        reason: String,
        settlement: Nir1Settlement,
    },
}

/// Synchronization points for tests only (the `Nir1OwnerProbePoint` way).
#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Nir1LocalAttemptProbe {
    /// The request is prepared and assembled; the create has not started.
    AfterPrepare,
    /// The attempt is durable; the re-observation and the claim have not
    /// started.
    AfterCreate,
    /// The re-observation passed; the claim has not started.
    BeforeClaim,
}

/// `Send`, so an attempt with a probe can run on the DD-1a starter thread.
#[cfg(test)]
type Probe = Box<dyn FnMut(Nir1LocalAttemptProbe) + Send>;

/// One accepted submission with its owner captured and nothing prepared yet.
/// A caller (DD-1) may check the AI use policy between `capture` and `run`;
/// dropping this releases the session slot and writes no attempt.
pub(crate) struct Nir1LocalAttempt {
    state: Arc<AppState>,
    caller: CallerIdentity,
    submission: NativeAcceptedChatSubmission,
    query_scene_id: String,
    unsupported_inputs: UnsupportedInputIntent,
    generation: LocalGenerationIntent,
    owner: Nir1GenerationOwner,
    #[cfg(test)]
    probe: Option<Probe>,
    /// A worker's Graph as text-free candidates. Only a test supplies one until
    /// the request step of D-final exists.
    #[cfg(test)]
    graph: Option<grimodex_db::narrative_extraction::Nir1GraphCandidates>,
}

impl Nir1LocalAttempt {
    /// Refuse unsupported inputs and a key verdict before any workspace or
    /// storage access, then pin the owner (the profile permit and the session
    /// slot).
    pub(crate) fn capture(
        state: Arc<AppState>,
        caller: CallerIdentity,
        submission: &NativeAcceptedChatSubmission,
        query_scene_id: &str,
        unsupported_inputs: UnsupportedInputIntent,
        generation: LocalGenerationIntent,
    ) -> Result<Self, Nir1LocalAttemptRefusal> {
        unsupported_inputs
            .validate()
            .map_err(Nir1LocalAttemptRefusal::Prepare)?;
        generation
            .ensure_no_key()
            .map_err(Nir1LocalAttemptRefusal::Prepare)?;
        let owner = Nir1GenerationOwner::capture(Arc::clone(&state), caller.clone(), submission)
            .map_err(Nir1LocalAttemptRefusal::Owner)?;
        Ok(Self {
            state,
            caller,
            submission: submission.clone(),
            query_scene_id: query_scene_id.to_owned(),
            unsupported_inputs,
            generation,
            owner,
            #[cfg(test)]
            probe: None,
            #[cfg(test)]
            graph: None,
        })
    }

    pub(crate) fn owner(&self) -> &Nir1GenerationOwner {
        &self.owner
    }

    #[cfg(test)]
    pub(crate) fn with_probe(
        mut self,
        probe: impl FnMut(Nir1LocalAttemptProbe) + Send + 'static,
    ) -> Self {
        self.probe = Some(Box::new(probe));
        self
    }

    #[cfg(test)]
    pub(crate) fn with_graph_candidates(
        mut self,
        graph: grimodex_db::narrative_extraction::Nir1GraphCandidates,
    ) -> Self {
        self.graph = Some(graph);
        self
    }

    /// Prepare, assemble, create, re-observe and claim. Every call holds one
    /// bounded operation at a time; no lease or lock spans two of them.
    pub(crate) fn run(self) -> Result<Nir1LocalAttemptOutcome, Nir1LocalAttemptRefusal> {
        self.run_for_dispatch().map(|(outcome, _)| outcome)
    }

    /// [`Self::run`], also returning the transport target of the route the
    /// request was prepared from (DD-1a). The target comes from the same
    /// route value as the attempt's endpoint identity, so a transport given
    /// it sends to the endpoint the attempt bound; `None` when the route's
    /// URL no longer parses as a loopback endpoint (the caller then settles
    /// the transport without sending).
    pub(crate) fn run_for_dispatch(
        self,
    ) -> Result<(Nir1LocalAttemptOutcome, Option<LoopbackChatEndpoint>), Nir1LocalAttemptRefusal>
    {
        let Self {
            state,
            caller,
            submission,
            query_scene_id,
            unsupported_inputs,
            generation,
            owner,
            #[cfg(test)]
            mut probe,
            #[cfg(test)]
            graph,
        } = self;
        #[cfg(not(test))]
        let selected = prepare_selected_local_chat_request(
            Arc::clone(&state),
            caller,
            &query_scene_id,
            &submission,
            unsupported_inputs,
            generation,
        )
        .map_err(Nir1LocalAttemptRefusal::Prepare)?;
        // A test that supplies candidates replaces the request step; without
        // them the coordinator makes the product's own request for the Graph.
        #[cfg(test)]
        let selected = match graph.as_ref() {
            Some(graph) => prepare_selected_local_chat_request_with_graph(
                Arc::clone(&state),
                caller,
                &query_scene_id,
                &submission,
                unsupported_inputs,
                generation,
                Some(graph),
            ),
            None => prepare_selected_local_chat_request(
                Arc::clone(&state),
                caller,
                &query_scene_id,
                &submission,
                unsupported_inputs,
                generation,
            ),
        }
        .map_err(Nir1LocalAttemptRefusal::Prepare)?;
        let (request, scene, expected_scope, witness) = selected.into_parts();
        let handoff = request.into_d_transport_handoff();
        let route = handoff.route().clone();
        let target = parse_loopback_chat_completions_endpoint(&route.endpoint_base_url).ok();
        let route_revocation_generation = handoff.request_metadata().route_revocation_generation;
        let final_request =
            build_final_dispatch_request(&submission, &handoff, scene, expected_scope)
                .map_err(Nir1LocalAttemptRefusal::Assembly)?;
        drop(handoff);
        #[cfg(test)]
        if let Some(probe) = probe.as_mut() {
            probe(Nir1LocalAttemptProbe::AfterPrepare);
        }
        let prepared = owner
            .create(final_request)
            .map_err(Nir1LocalAttemptRefusal::Owner)?;
        #[cfg(test)]
        if let Some(probe) = probe.as_mut() {
            probe(Nir1LocalAttemptProbe::AfterCreate);
        }
        // The last check before the claim, with no lease and no lock held. A
        // difference means the request that was prepared is not the current
        // one: it is abandoned, never sent.
        if let Err(error) = reobserve_prepared_for_dispatch(
            &state,
            &submission,
            &route,
            route_revocation_generation,
            &witness,
            prepared.attempt_id(),
        ) {
            let settlement = prepared.abandon();
            return Ok((
                Nir1LocalAttemptOutcome::Abandoned {
                    reason: error.to_string(),
                    settlement,
                },
                target,
            ));
        }
        // The witness holds prompt text; it ends here, before the claim.
        drop(witness);
        #[cfg(test)]
        if let Some(probe) = probe.as_mut() {
            probe(Nir1LocalAttemptProbe::BeforeClaim);
        }
        let outcome = match prepared.claim_for_transport() {
            Nir1TransportDecision::Start(transport) => Nir1LocalAttemptOutcome::Start(transport),
            Nir1TransportDecision::NotStarted(settlement) => {
                Nir1LocalAttemptOutcome::NotStarted(settlement)
            }
        };
        Ok((outcome, target))
    }
}

/// `capture` and `run` in one call. Test only: a product caller (DD-1) must
/// check the AI use policy between `capture` and `run`, and this function
/// leaves no place for that check, so it does not exist outside tests.
#[cfg(test)]
pub(crate) fn start_local_attempt(
    state: Arc<AppState>,
    caller: CallerIdentity,
    submission: &NativeAcceptedChatSubmission,
    query_scene_id: &str,
    unsupported_inputs: UnsupportedInputIntent,
    generation: LocalGenerationIntent,
) -> Result<Nir1LocalAttemptOutcome, Nir1LocalAttemptRefusal> {
    Nir1LocalAttempt::capture(
        state,
        caller,
        submission,
        query_scene_id,
        unsupported_inputs,
        generation,
    )?
    .run()
}

/// Assemble the final request from the handoff (DR-DI1C-6). The owner
/// compares its own route revision, project, session and Scene with the
/// request at the create. Every digest is a
/// domain-separated canonical JSON digest of digests, tokens and closed enums;
/// no body text, raw URL, endpoint id, label or key enters one.
pub(crate) fn build_final_dispatch_request(
    submission: &NativeAcceptedChatSubmission,
    handoff: &PrivateDTransportHandoff,
    scene: AttemptSceneBinding,
    expected_scope: Nir1ExpectedScope,
) -> Result<FinalDispatchRequest> {
    let route = handoff.route();
    let provider = match serde_json::to_value(&route.provider)? {
        Value::String(provider) => provider,
        _ => anyhow::bail!("NIR1_LOCAL_ATTEMPT_PROVIDER_INVALID"),
    };
    let d1_digest = d1_selection_digest(handoff.d1_selection(), handoff.input_references())?;
    // The comparison marker equals the D1 selection digest that the history
    // slot records (K4/3 section 5); it is not an authorization.
    if let HistoryContextSlot::Context(context) = &handoff.history_draft().slot {
        ensure!(
            context.d1.selection_digest.as_str() == d1_digest,
            "NIR1_LOCAL_ATTEMPT_D1_DIGEST_MISMATCH"
        );
    }
    let scope_digest = scope_digest(
        &scene,
        &expected_scope,
        handoff.authority_bindings(),
        handoff.graph_binding(),
    )?;
    let material_digest = material_digest(&scene, handoff)?;
    Ok(FinalDispatchRequest {
        project_id: submission.project_id().to_owned(),
        chat_session_id: submission.chat_session_id().to_owned(),
        scene,
        route_revision: route.route_revision.clone(),
        purpose: handoff.purpose().clone(),
        scope_digest,
        material_digest,
        d1_digest,
        provider,
        model: route.model.clone(),
        api: route.api.to_owned(),
        endpoint_identity: route.endpoint_identity_digest.clone(),
        payload: serde_json::from_str(handoff.canonical_payload())
            .context("NIR1_LOCAL_ATTEMPT_PAYLOAD_INVALID")?,
        inputs: handoff.input_references().to_vec(),
        qualifications: handoff.qualifications().to_vec(),
        history: handoff.history_draft().clone(),
        lifetime_ms: NIR1_LOCAL_ATTEMPT_LIFETIME_MS,
        expected_scope,
        budget: NIR1_LOCAL_ATTEMPT_READ_BUDGET,
    })
}

/// The Scope the request was prepared under: the target Scene incarnation and
/// its Scope binding and restore epoch as read in the snapshot, and the Scope
/// identity of every adopted Revision's authority. A request with Graph-derived
/// inputs also binds B's seal and the (Revision, edge) of each Graph group
/// (DI-1a, DR-DI1A-9); a request without one has no such key, so its digest is
/// the one it had before the Graph existed.
pub(crate) fn scope_digest(
    scene: &AttemptSceneBinding,
    expected: &Nir1ExpectedScope,
    bindings: &[NativeNir1AuthorityBinding],
    graph: Option<&NativeNir1GraphBinding>,
) -> Result<String> {
    let revisions = bindings
        .iter()
        .map(|binding| {
            let scope = binding.scope();
            Ok(json!({
                "revisionId": binding.revision_id(),
                "querySceneId": scope.query_scene_id(),
                "querySceneIncarnationId": scope.query_scene_incarnation_id(),
                "querySceneSourceToken": scope.query_scene_source_token(),
                "querySceneScopeToken": scope.query_scene_scope_token(),
                "scopeAuthorityRevision": scope.scope_authority_revision(),
                "effectiveAxis": scope.effective_axis(),
                "axisFallbackReason": scope.axis_fallback_reason(),
                "revealStateToken": scope.reveal_state_token(),
                "typedScopeBindings": serde_json::to_value(scope.typed_scope_bindings())?,
                "materialScenes": scope
                    .material_scene_proofs()
                    .iter()
                    .map(|proof| json!({
                        "sceneId": proof.scene_id,
                        "sceneIncarnationId": proof.scene_incarnation_id,
                        "sceneScopeToken": proof.scene_scope_token,
                    }))
                    .collect::<Vec<_>>(),
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    let mut value = json!({
        "domain": "nir1-final-scope@1",
        "targetScene": {
            "sceneId": scene.scene_id,
            "sceneIncarnationId": scene.scene_incarnation_id,
            "sourceToken": scene.source_token,
        },
        "scopeBinding": expected.scope_binding.as_ref().map(|state| json!({
            "tokenDigest": state.token_digest.as_str(),
            "version": state.version,
        })),
        "restoreEpoch": expected.restore_epoch.as_ref().map(|state| json!({
            "idDigest": state.id_digest.as_str(),
            "number": state.number,
        })),
        "revisions": revisions,
    });
    if let Some(graph) = graph {
        let seal = graph.seal();
        value["graph"] = json!({
            "seal": {
                "indexKey": seal.index_key,
                "generation": seal.generation,
                "sourceDigest": seal.source_digest,
                "dependencySetDigest": seal.dependency_set_digest,
                "semanticEpochId": seal.semantic_epoch_id,
            },
            "groups": graph
                .inputs()
                .iter()
                .map(|input| json!({
                    "revisionId": input.revision_id(),
                    "edgeId": input.edge_id(),
                }))
                .collect::<Vec<_>>(),
        });
    }
    Ok(canonical_json_digest(&value)?)
}

/// The material the request carries: the input and qualification rows (as the
/// storage digest), every adopted Revision's bundle, material basis, Decision
/// and Freshness tokens, and the Raw Source binding. Graph-derived inputs add
/// the Index reference (identity and version) of each group; a request
/// without one has no such key.
pub(crate) fn material_digest(
    scene: &AttemptSceneBinding,
    handoff: &PrivateDTransportHandoff,
) -> Result<String> {
    let source = handoff.bound_source().binding();
    let revisions = handoff
        .authority_bindings()
        .iter()
        .map(|binding| {
            json!({
                "revisionId": binding.revision_id(),
                "bundleDigest": binding.bundle_digest(),
                "materialBasisDigest": binding.material_basis_digest(),
                "decisionToken": binding.decision_token(),
                "freshnessToken": binding.freshness_token(),
            })
        })
        .collect::<Vec<_>>();
    let mut value = json!({
        "domain": "nir1-final-material@1",
        "inputDigest": handoff.input_digest(),
        "sceneBodyDigest": scene.body_digest,
        "raw": {
            "projectId": handoff.bound_source().project_id(),
            "sceneId": handoff.bound_source().scene_id(),
            "sourceKey": source.source_key,
            "revisionToken": source.revision_token,
            "sourceVersion": source.source_version,
            "normalizerVersion": source.normalizer_version,
            "canonicalTextDigest": source.canonical_text_digest,
            "storageDigest": source.storage_digest,
            "canonicalUtf16Length": source.canonical_utf16_length,
        },
        "revisions": revisions,
    });
    if let Some(graph) = handoff.graph_binding() {
        value["graph"] = json!({
            "indexRefs": graph
                .inputs()
                .iter()
                .map(|input| json!({
                    "groupId": input.group_id(),
                    "indexIdentity": input.index_identity(),
                    "indexVersion": input.index_version(),
                }))
                .collect::<Vec<_>>(),
        });
    }
    Ok(canonical_json_digest(&value)?)
}

#[cfg(test)]
#[path = "nir1_local_attempt_tests.rs"]
pub(crate) mod tests;
