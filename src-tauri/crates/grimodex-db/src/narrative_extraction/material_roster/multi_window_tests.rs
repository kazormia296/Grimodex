//! Replay of a Run with three or more windows, and the Run-level reuse that
//! lets many Roots of one Run share what their windows prove (MW/1).
//!
//! The synthetic Runs seal their own requests with the Native recipe, so they
//! prove the structure (every window and receipt is bound, nothing is
//! dropped, nothing is remembered wrongly). The recipe's agreement with the
//! TypeScript builders is proven by the production goldens, the two-window
//! cold fixture and the evaluation database, not here.
//!
//! On the cache's "can never be matched to a different Run state" (see
//! `replay::Fingerprint`): the fingerprint holds the digests of the snapshot,
//! plan and observation artifacts and, per observation receipt, only its
//! execution id and `stageExecutionReceiptDigest`. The sentence is therefore a
//! consequence of one premise: that receipt digest seals the receipt's whole
//! content, `contextSetDigest` and `finalRequestDigest` included. The premise
//! holds in production because a stored receipt is recomputed and compared
//! with its digest when it is hydrated (`stage_provenance::validate_receipt`,
//! `TERMINAL_RECEIPT_DOMAIN`). These tests do NOT exercise that seal: a
//! synthetic receipt's fields are edited freely, so a test that edits a field
//! without its digest builds a receipt a stored one could not be.
use super::super::stage_provenance::VerifiedV2ContextArtifact;
use super::replay::{self, AcceptedArtifact, Outcome, RunReplay};
use super::{prompt, segments};
use anyhow::Result;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::rc::Rc;

const OBS_TASK: &str = "task-observe";
const OBS_ATTEMPT: &str = "attempt-observe";
const SYN_TASK: &str = "task-synthesize";
const SYN_ATTEMPT: &str = "attempt-synthesize";
const SYN_ARTIFACT: &str = "artifact-synthesis";
const SYN_DIGEST: &str = "sha256:synthesis";

fn golden() -> Value {
    serde_json::from_str(include_str!("production-two-window-golden.json"))
        .expect("production golden")
}

fn contract_of(stage: &str) -> String {
    let g = golden();
    g["receipts"]
        .as_array()
        .expect("receipts")
        .iter()
        .find(|r| r["stageExecution"]["stageId"] == stage)
        .expect("stage receipt")["componentContractDigest"]
        .as_str()
        .expect("digest")
        .to_owned()
}

struct Doc {
    text: String,
    /// (start, end) of each sentence-like catalog entry
    sentences: Vec<(usize, usize)>,
}

fn sentence_doc(first: usize, sentences: usize) -> Doc {
    let parts: Vec<String> = (0..sentences)
        .map(|i| format!("The party {} reached gate {}.", first + i, first + i))
        .collect();
    let mut sentence_ranges = vec![];
    let mut at = 0;
    for part in &parts {
        sentence_ranges.push((at, at + part.len()));
        at += part.len() + 1;
    }
    Doc {
        text: parts.join(" "),
        sentences: sentence_ranges,
    }
}

/// One window: the document it reads and the range it owns.
struct Win {
    doc: usize,
    range: (usize, usize),
}

/// One Run, ready to replay. Every field a Root read needs is a plain value,
/// so a test can corrupt exactly one of them.
#[derive(Clone)]
struct Run {
    snapshot: Value,
    plan: Value,
    raw: Value,
    clusters: Value,
    outputs: Vec<Value>,
    receipts: Vec<Value>,
    cluster_refs: Vec<String>,
    cluster_observations: Vec<Vec<String>>,
    declared: Vec<String>,
}

fn catalog_digest(catalog: &Value) -> String {
    let mut input = catalog.clone();
    input.as_object_mut().expect("catalog").remove("digest");
    grimodex_core::canonical_json_digest(&input).expect("catalog digest")
}

/// `clusters[i]` lists the (window index, sentence index) observations that
/// cluster i folds together. The observation cites that sentence.
fn build_run(docs: &[Doc], wins: &[Win], clusters: &[Vec<(usize, usize)>]) -> Run {
    let documents: Vec<Value> = docs
        .iter()
        .enumerate()
        .map(|(i, d)| {
            json!({"ref": format!("D{i}"), "sourceKey": format!("project:scene:n{i}"),
            "canonical": {"text": d.text}, "artifactDigest": format!("sha256:doc{i}"),
            "origin": {"kind": "project-node", "nodeId": format!("n{i}"), "sourceVersion": 0,
                "sourceUpdatedAt": "2026-01-01T00:00:00Z"}})
        })
        .collect();
    let mut entries = vec![];
    for (i, d) in docs.iter().enumerate() {
        for (k, (a, b)) in d.sentences.iter().enumerate() {
            entries.push(
                json!({"sourceRef": format!("E{i}-{k}"), "documentRef": format!("D{i}"),
                "canonicalRange": {"start": a, "end": b}, "quote": &d.text[*a..*b]}),
            );
        }
    }
    let mut catalog = json!({"version": 1, "segmentationVersion": "sentence-like-v1",
        "snapshotDigest": "sha256:snapshot", "snapshotArtifactDigest": "sha256:snapshot-artifact",
        "entries": entries});
    let digest = catalog_digest(&catalog);
    catalog["digest"] = json!(digest);
    let views: Vec<Value> = wins
        .iter()
        .enumerate()
        .map(|(w, win)| {
            json!({"ref": format!("S{w}"), "documentRef": format!("D{}", win.doc),
            "documentRange": {"start": win.range.0, "end": win.range.1},
            "text": &docs[win.doc].text[win.range.0..win.range.1]})
        })
        .collect();
    let snapshot = json!({
        "snapshot": {"digest": "sha256:snapshot", "artifactDigest": "sha256:snapshot-artifact",
            "documents": documents},
        "sourceViews": views,
        "evidence": {"catalog": catalog}});
    let plan = json!({"windows": wins.iter().enumerate().map(|(w, win)| json!({
        "windowId": format!("window-{:03}", w + 1), "documentRef": format!("D{}", win.doc),
        "sourceRef": format!("S{w}")})).collect::<Vec<_>>()});
    // One observation per (window, sentence) a cluster folds together.
    let mut raw_observations: Vec<Value> = vec![];
    let mut cluster_observations: Vec<Vec<String>> = vec![];
    for (c, members) in clusters.iter().enumerate() {
        let mut ids = vec![];
        for (n, (w, k)) in members.iter().enumerate() {
            let doc = wins[*w].doc;
            let (a, b) = docs[doc].sentences[*k];
            let id = format!("window-{:03}:obs-c{c}-{n}", w + 1);
            raw_observations.push(json!({"localId": id,
                "evidence": [{"sourceRef": format!("E{doc}-{k}"), "quote": &docs[doc].text[a..b]}],
                "payload": {"actuality": "actual", "predicate": format!("Event {c}.{n} happened.")}}));
            ids.push(id);
        }
        cluster_observations.push(ids);
    }
    let cluster_refs: Vec<String> = (0..clusters.len())
        .map(|c| format!("cluster-{:04}", c + 1))
        .collect();
    let run = Run {
        snapshot,
        plan,
        raw: json!({"observations": raw_observations}),
        clusters: json!({"clusters": cluster_refs.iter().zip(&cluster_observations)
            .map(|(r, ids)| json!({"clusterRef": r, "observationRefs": ids})).collect::<Vec<_>>()}),
        outputs: vec![],
        receipts: vec![],
        cluster_refs,
        cluster_observations,
        declared: (0..docs.len())
            .map(|i| format!("project:scene:n{i}"))
            .collect(),
    };
    seal(run)
}

/// Seal every request of the Run with the Native recipe.
fn seal(mut run: Run) -> Run {
    let observation_contract = contract_of(prompt::OBSERVATION);
    let synthesis_contract = contract_of(prompt::SYNTHESIS);
    let windows = run.plan["windows"].as_array().expect("windows").clone();
    let mut receipts = vec![];
    for (w, window) in windows.iter().enumerate() {
        let mut receipt = json!({
            "stageExecution": {"projectId": "p", "runId": "run-1", "taskId": OBS_TASK,
                "attemptId": OBS_ATTEMPT, "stageId": prompt::OBSERVATION,
                "stageExecutionId": format!("exec-observe-{w}"), "parentStageExecutionId": null},
            "contextSetVersion": "chronicle.context-set/1",
            "componentContractDigest": observation_contract,
            "terminalStatus": "succeeded", "parseStatus": "parsed",
            "stageExecutionReceiptDigest": format!("sha256:receipt-observe-{w}")});
        let (digests, _) = segments::observation(&run.snapshot, window, &receipt).expect("seal");
        receipt["contextSetDigest"] = json!(digests.context_set_digest);
        receipt["finalRequestDigest"] = json!(digests.final_request_digest);
        receipts.push(receipt);
    }
    let all = run.raw["observations"]
        .as_array()
        .expect("observations")
        .clone();
    let mut outputs = vec![];
    for (c, cluster) in run.cluster_refs.iter().enumerate() {
        let members: Vec<Value> = all
            .iter()
            .filter(|o| {
                run.cluster_observations[c]
                    .iter()
                    .any(|id| o["localId"] == *id)
            })
            .cloned()
            .collect();
        let execution = format!("exec-synthesize-{c}");
        let digests = prompt::synthesis(cluster, &synthesis_contract, &members).expect("seal");
        receipts.push(json!({
            "stageExecution": {"projectId": "p", "runId": "run-1", "taskId": SYN_TASK,
                "attemptId": SYN_ATTEMPT, "stageId": prompt::SYNTHESIS,
                "stageExecutionId": execution, "parentStageExecutionId": null},
            "contextSetVersion": "chronicle.context-set/1",
            "componentContractDigest": synthesis_contract,
            "contextSetDigest": digests.context_set_digest,
            "finalRequestDigest": digests.final_request_digest,
            "terminalStatus": "succeeded", "parseStatus": "parsed",
            "stageExecutionReceiptDigest": format!("sha256:receipt-synthesize-{c}")}));
        outputs.push(json!({"clusterRef": cluster, "disposition": "root-success",
            "rootStageExecutionId": execution, "terminalStageExecutionId": execution,
            "rawObservations": {"observations": members}}));
    }
    run.outputs = outputs;
    run.receipts = receipts;
    run
}

fn artifact(
    id: &str,
    digest: &str,
    task: &str,
    attempt: &str,
    payload: Value,
) -> Rc<AcceptedArtifact> {
    Rc::new(AcceptedArtifact {
        id: id.to_owned(),
        digest: digest.to_owned(),
        task_id: task.to_owned(),
        attempt_id: attempt.to_owned(),
        payload,
    })
}

type Loaded = HashMap<(&'static str, &'static str), Rc<AcceptedArtifact>>;

fn loaded(run: &Run) -> Loaded {
    // The digest labels name the payloads: a test that changes a payload that
    // a cache could have kept also changes its label, as a real digest would.
    let label = |name: &str, payload: &Value| {
        format!(
            "sha256:{name}-{}",
            grimodex_core::canonical_json_digest(payload).expect("label")
        )
    };
    let mut map: Loaded = HashMap::new();
    map.insert(
        ("source.snapshot@1", "source.snapshot@1"),
        artifact(
            "snap",
            &label("snapshot", &run.snapshot),
            "t-snap",
            "a-snap",
            run.snapshot.clone(),
        ),
    );
    map.insert(
        ("source.window-plan@1", "source.window-plan@1"),
        artifact(
            "plan",
            &label("plan", &run.plan),
            "t-plan",
            "a-plan",
            run.plan.clone(),
        ),
    );
    map.insert(
        ("chronicle.observe-events@1", "chronicle.raw-observations@1"),
        artifact(
            "raw",
            &label("raw", &run.raw),
            OBS_TASK,
            OBS_ATTEMPT,
            run.raw.clone(),
        ),
    );
    map.insert(
        (
            "chronicle.merge-local-observations@1",
            "chronicle.merged-observations@1",
        ),
        artifact(
            "merged",
            &label("merged", &run.raw),
            "t-merge",
            "a-merge",
            run.raw.clone(),
        ),
    );
    map.insert(
        (
            "chronicle.cluster-event-observations@1",
            "chronicle.event-clusters@1",
        ),
        artifact(
            "clusters",
            &label("clusters", &run.clusters),
            "t-cluster",
            "a-cluster",
            run.clusters.clone(),
        ),
    );
    let outputs = json!({"outputs": run.outputs});
    map.insert(
        (
            "chronicle.synthesize-event@1",
            "chronicle.stage-synthesis-outputs@1",
        ),
        artifact(SYN_ARTIFACT, SYN_DIGEST, SYN_TASK, SYN_ATTEMPT, outputs),
    );
    map
}

fn envelope(run: &Run, cluster: usize) -> Value {
    let mut contexts = vec![format!("event-cluster:{}", run.cluster_refs[cluster])];
    contexts.extend(
        run.cluster_observations[cluster]
            .iter()
            .map(|id| format!("event-observation:{id}")),
    );
    json!({
        "revisionBasis": {"contextSet": contexts.iter().map(|c| json!({"contextId": c})).collect::<Vec<_>>()},
        "effectiveMaterialBasis": {
            "dependencySet": run.declared.iter().map(|key| json!({
                "inputRef": key, "role": "direct-evidence", "contextIds": contexts,
                "selector": {"kind": "whole-source"}})).collect::<Vec<_>>(),
            "sourceBasis": run.declared.iter().map(|key| json!({
                "sourceKind": "scene-body", "sourceKey": key,
                "revisionToken": "v0@2026-01-01T00:00:00Z"})).collect::<Vec<_>>()}})
}

fn root(run: &Run, cluster: usize) -> VerifiedV2ContextArtifact {
    VerifiedV2ContextArtifact {
        source_key: format!("artifact:{SYN_ARTIFACT}"),
        revision_token: SYN_DIGEST.to_owned(),
        cluster_ref: run.cluster_refs[cluster].clone(),
        observation_refs: run.cluster_observations[cluster].clone(),
    }
}

fn replay_with(run: &Run, cache: &mut RunReplay, cluster: usize) -> Result<Outcome> {
    replay_loaded(run, &loaded(run), cache, cluster)
}

fn replay_loaded(
    run: &Run,
    map: &Loaded,
    cache: &mut RunReplay,
    cluster: usize,
) -> Result<Outcome> {
    let windows = run.plan["windows"].as_array().map_or(0, Vec::len);
    replay::resolve_cached(
        cache,
        &mut |task, kind| {
            map.iter()
                .find(|((t, k), _)| *t == task && *k == kind)
                .map(|(_, value)| Rc::clone(value))
                .ok_or_else(|| anyhow::anyhow!("accepted-artifact-roster-invalid"))
        },
        &root(run, cluster),
        &json!({"windowCount": windows}),
        &run.receipts,
        &envelope(run, cluster),
    )
}

/// Everything a Root read publishes, as one comparable value.
fn describe(result: &Result<Outcome>) -> String {
    match result {
        Ok(Outcome::Complete(materials, proofs)) => format!(
            "complete {} {}",
            serde_json::to_string(materials).expect("materials"),
            serde_json::to_string(proofs).expect("proofs")
        ),
        Ok(Outcome::Unsupported(code)) => format!("unsupported {code}"),
        Err(error) => format!("error {error}"),
    }
}

fn cold(run: &Run, cluster: usize) -> String {
    describe(&replay_with(run, &mut RunReplay::default(), cluster))
}

fn complete(result: Result<Outcome>) -> (Vec<segments::Material>, Vec<prompt::RequestProof>) {
    match result {
        Ok(Outcome::Complete(materials, proofs)) => (materials, proofs),
        Ok(Outcome::Unsupported(code)) => panic!("unsupported {code}"),
        Err(error) => panic!("replay failed: {error}"),
    }
}

/// n windows over one document, two clusters: the first folds the first and
/// the last window together, the second reads a middle window.
fn long_scene(n: usize) -> Run {
    let doc = sentence_doc(0, n);
    let wins: Vec<Win> = (0..n)
        .map(|i| {
            let start = doc.sentences[i].0;
            let end = if i + 1 == n {
                doc.text.len()
            } else {
                doc.sentences[i].1 + 1
            };
            Win {
                doc: 0,
                range: (start, end),
            }
        })
        .collect();
    build_run(
        &[doc],
        &wins,
        &[vec![(0, 0), (n - 1, n - 1)], vec![(n / 2, n / 2)]],
    )
}

/// Three scenes, one window each; the first cluster folds two scenes.
fn folder_of_scenes() -> Run {
    let docs: Vec<Doc> = (0..3).map(|i| sentence_doc(i * 10, 1)).collect();
    let wins: Vec<Win> = docs
        .iter()
        .enumerate()
        .map(|(i, d)| Win {
            doc: i,
            range: (0, d.text.len()),
        })
        .collect();
    build_run(&docs, &wins, &[vec![(0, 0), (1, 0)], vec![(2, 0)]])
}

fn window_ids(materials: &[segments::Material]) -> BTreeSet<String> {
    materials.iter().map(|m| m.context_id.clone()).collect()
}

#[test]
fn three_windows_of_one_scene_replay_with_every_window_and_its_context() {
    let run = long_scene(3);
    let (materials, proofs) = complete(replay_with(&run, &mut RunReplay::default(), 0));
    // The cluster reads windows 1 and 3. Window 2 was model-visible too and
    // stays in the material, with its span and its trailing context.
    assert_eq!(window_ids(&materials).len(), 3);
    let middle: Vec<_> = materials
        .iter()
        .filter(|m| m.context_id == "observation-citation-window:window-002")
        .collect();
    assert_eq!(middle.iter().filter(|m| m.kind == "span").count(), 1);
    assert_eq!(middle.iter().filter(|m| m.kind == "context").count(), 1);
    assert_eq!(materials.iter().filter(|m| m.kind == "span").count(), 3);
    assert_eq!(
        proofs.len(),
        4,
        "three observation requests and the synthesis"
    );
    // The windows tile the document: no gap, no overlap, in plan order.
    let mut at = 0;
    for m in &materials {
        assert_eq!(m.canonical_range["start"], at);
        at = m.canonical_range["end"].as_u64().expect("end") as usize;
    }
    assert_eq!(
        at,
        run.snapshot["snapshot"]["documents"][0]["canonical"]["text"]
            .as_str()
            .expect("text")
            .len()
    );
}

#[test]
fn three_scenes_with_one_window_each_replay() {
    let run = folder_of_scenes();
    for cluster in 0..2 {
        let (materials, proofs) = complete(replay_with(&run, &mut RunReplay::default(), cluster));
        assert_eq!(window_ids(&materials).len(), 3);
        assert_eq!(
            materials
                .iter()
                .map(|m| m.source_key.clone())
                .collect::<BTreeSet<_>>()
                .len(),
            3
        );
        assert_eq!(proofs.len(), 4);
    }
}

#[test]
fn many_windows_replay_without_a_limit_on_their_number() {
    for n in [8, 16, 32] {
        let run = long_scene(n);
        let (materials, proofs) = complete(replay_with(&run, &mut RunReplay::default(), 0));
        assert_eq!(window_ids(&materials).len(), n);
        assert_eq!(proofs.len(), n + 1);
    }
}

/// Why a Run stopped. A replay that stops for the wrong reason would pass a
/// bare `is_err()`, so every refusal below names its reason.
fn refusal(run: &Run) -> String {
    match replay_with(run, &mut RunReplay::default(), 0) {
        Err(error) => error.to_string(),
        other => panic!("must be refused: {}", describe(&other)),
    }
}

#[test]
fn a_missing_duplicated_changed_or_foreign_window_request_never_replays() {
    let base = long_scene(3);
    let mut variants: Vec<(&str, Run, &str)> = vec![];
    let mut missing = base.clone();
    missing.receipts.remove(1);
    variants.push((
        "a window request is missing",
        missing,
        "observation-request-roster-invalid",
    ));
    let mut duplicated = base.clone();
    duplicated.receipts[2] = duplicated.receipts[1].clone();
    variants.push((
        "one request answers two windows",
        duplicated,
        "observation-window-request-binding-invalid",
    ));
    let mut changed = base.clone();
    changed.receipts[1]["finalRequestDigest"] = json!("sha256:changed");
    variants.push((
        "a request digest was changed",
        changed,
        "request-digest-mismatch",
    ));
    let mut foreign = base.clone();
    foreign.receipts[2]["stageExecution"]["runId"] = json!("run-2");
    variants.push((
        "a request of another Run",
        foreign,
        "request-digest-mismatch",
    ));
    let mut other_task = base.clone();
    other_task.receipts[0]["stageExecution"]["taskId"] = json!("task-other");
    variants.push((
        "a request of another Task",
        other_task,
        "observation-request-roster-invalid",
    ));
    let mut extra = base.clone();
    let mut again = extra.receipts[0].clone();
    again["stageExecution"]["stageExecutionId"] = json!("exec-observe-extra");
    extra.receipts.insert(1, again);
    variants.push((
        "a fourth request for three windows",
        extra,
        "observation-request-roster-invalid",
    ));
    let mut text = base.clone();
    text.snapshot["sourceViews"][1]["text"] = json!("changed words that are no longer the scene");
    variants.push((
        "a window text that is not the scene's",
        text,
        "source-view-text-mismatch",
    ));
    for (name, run, reason) in variants {
        assert_eq!(refusal(&run), reason, "{name}");
    }
}

/// The count of receipts stays the count of windows, so the roster check
/// passes and only the narrowing by context-set digest can refuse the Run.
#[test]
fn a_receipt_that_keeps_the_count_but_not_the_window_it_names_never_replays() {
    let base = long_scene(3);
    let context = |run: &Run, i: usize| run.receipts[i]["contextSetDigest"].clone();
    assert_eq!(
        base.receipts
            .iter()
            .filter(|r| r["stageExecution"]["stageId"] == prompt::OBSERVATION)
            .count(),
        3
    );
    // (a) No receipt carries window 2's context-set digest: nothing matches it.
    let mut none = base.clone();
    none.receipts[1]["contextSetDigest"] = json!(context(&base, 1)
        .as_str()
        .expect("digest")
        .replace("sha256:", "sha256:0"));
    assert_eq!(refusal(&none), "observation-window-request-binding-invalid");
    // (c) A receipt carries a context-set digest that no window has.
    let mut foreign = base.clone();
    foreign.receipts[2]["contextSetDigest"] = json!("sha256:no-window-has-this");
    assert_eq!(
        refusal(&foreign),
        "observation-window-request-binding-invalid"
    );
    // Two receipts name window 2: window 3 is left with none, and the receipt
    // that really answers window 3 is rebuilt against window 2 first.
    let mut twice = base.clone();
    twice.receipts[2]["contextSetDigest"] = context(&base, 1);
    assert_eq!(refusal(&twice), "request-digest-mismatch");
    // Windows 2 and 3 swapped their context-set digests only.
    let mut swapped = base.clone();
    swapped.receipts[1]["contextSetDigest"] = context(&base, 2);
    swapped.receipts[2]["contextSetDigest"] = context(&base, 1);
    assert_eq!(refusal(&swapped), "request-digest-mismatch");
    // The untouched Run still replays: the refusals come from the change.
    assert!(cold(&base, 0).starts_with("complete"));
}

/// A Run whose declaration names only some of its documents. The documents
/// left out have windows too; they are read and bound, but are not material.
fn partly_declared() -> Run {
    let docs: Vec<Doc> = (0..3).map(|i| sentence_doc(i * 10, 1)).collect();
    let wins: Vec<Win> = docs
        .iter()
        .enumerate()
        .map(|(i, d)| Win {
            doc: i,
            range: (0, d.text.len()),
        })
        .collect();
    let mut run = build_run(&docs, &wins, &[vec![(0, 0), (1, 0)]]);
    run.declared = vec!["project:scene:n0".to_owned(), "project:scene:n1".to_owned()];
    run
}

#[test]
fn a_window_outside_the_declaration_is_not_material_but_is_still_proven() {
    let run = partly_declared();
    let (materials, proofs) = complete(replay_with(&run, &mut RunReplay::default(), 0));
    assert_eq!(
        materials
            .iter()
            .map(|m| m.source_key.clone())
            .collect::<BTreeSet<_>>(),
        BTreeSet::from(["project:scene:n0".to_owned(), "project:scene:n1".to_owned()]),
        "the undeclared scene is not material"
    );
    assert_eq!(window_ids(&materials).len(), 2);
    assert_eq!(proofs.len(), 3, "two declared windows and the synthesis");
    // Its receipt is checked all the same: the Run is the unit that was sealed.
    let mut digest = run.clone();
    digest.receipts[2]["finalRequestDigest"] = json!("sha256:changed");
    assert_eq!(refusal(&digest), "request-digest-mismatch");
    let mut context = run.clone();
    context.receipts[2]["contextSetDigest"] = json!("sha256:no-window-has-this");
    assert_eq!(
        refusal(&context),
        "observation-window-request-binding-invalid"
    );
    let mut text = run.clone();
    text.snapshot["sourceViews"][2]["text"] = json!("not the scene's words");
    assert_eq!(refusal(&text), "source-view-text-mismatch");
    let mut missing = run.clone();
    missing.receipts.remove(2);
    assert_eq!(refusal(&missing), "observation-request-roster-invalid");
}

#[test]
fn a_repaired_run_is_unsupported_at_every_window_count() {
    for n in [1, 2, 3, 8] {
        let mut run = long_scene(n);
        let mut repair = run.receipts[0].clone();
        repair["stageExecution"]["stageId"] = json!("narrative_structured_repair");
        repair["stageExecution"]["stageExecutionId"] = json!("exec-repair");
        run.receipts.push(repair);
        assert_eq!(
            describe(&replay_with(&run, &mut RunReplay::default(), 0)),
            "unsupported citation-repair-recipe-not-implemented",
            "{n} windows"
        );
    }
}

#[test]
fn a_run_without_windows_is_still_unsupported() {
    let mut run = long_scene(3);
    run.plan = json!({"windows": []});
    run.receipts
        .retain(|r| r["stageExecution"]["stageId"] != prompt::OBSERVATION);
    assert_eq!(
        describe(&replay_with(&run, &mut RunReplay::default(), 0)),
        "unsupported multi-window-recipe-not-implemented"
    );
}

/// The same Run, resealed so that the merge stage's output differs from the
/// raw observations (a non-identity merge): the artifact's label follows its
/// payload, as a real digest would.
fn with_nonidentity_merge(run: &Run) -> Loaded {
    let mut map = loaded(run);
    let mut payload = run.raw.clone();
    let observations = payload["observations"]
        .as_array_mut()
        .expect("observations");
    assert!(observations.len() >= 2, "a merge that can drop one");
    observations.pop();
    assert_ne!(payload, run.raw);
    let label = format!(
        "sha256:merged-{}",
        grimodex_core::canonical_json_digest(&payload).expect("label")
    );
    map.insert(
        (
            "chronicle.merge-local-observations@1",
            "chronicle.merged-observations@1",
        ),
        artifact("merged", &label, "t-merge", "a-merge", payload),
    );
    map
}

const NONIDENTITY: &str = "unsupported nonidentity-merge-recipe-not-implemented";

/// A merge that is not the identity is not replayed at any window count, cold
/// or through the Run-level cache the roster reads share (`RunReplay`, the cache
/// `RunProofMemo` holds): a warm cache never turns it into material, whatever
/// it has read before, and a refused read leaves nothing behind for a good Root.
#[test]
fn a_nonidentity_merge_is_unsupported_cold_and_through_a_shared_cache() {
    for run in [
        long_scene(3),
        long_scene(8),
        long_scene(16),
        folder_of_scenes(),
    ] {
        let clusters = run.cluster_refs.len();
        assert!(clusters >= 2);
        let bad = with_nonidentity_merge(&run);
        let good = loaded(&run);
        let expected: Vec<String> = (0..clusters).map(|c| cold(&run, c)).collect();
        assert!(expected.iter().all(|e| e.starts_with("complete")));
        for c in 0..clusters {
            // Cold.
            assert_eq!(
                describe(&replay_loaded(&run, &bad, &mut RunReplay::default(), c)),
                NONIDENTITY,
                "cold, Root {c}"
            );
        }
        for order in [[0, 1], [1, 0]] {
            // A cache warmed by the Run's identity-merge reads first.
            let mut warm = RunReplay::default();
            for c in order {
                assert_eq!(
                    describe(&replay_loaded(&run, &good, &mut warm, c)),
                    expected[c]
                );
            }
            for c in order {
                for _ in 0..2 {
                    assert_eq!(
                        describe(&replay_loaded(&run, &bad, &mut warm, c)),
                        NONIDENTITY,
                        "warm cache, Root {c}"
                    );
                }
            }
            // A cache warmed by a refused read, and one that went on to a good
            // Root afterwards.
            let mut shared = RunReplay::default();
            for c in order {
                assert_eq!(
                    describe(&replay_loaded(&run, &bad, &mut shared, c)),
                    NONIDENTITY
                );
            }
            for c in order {
                assert_eq!(
                    describe(&replay_loaded(&run, &good, &mut shared, c)),
                    expected[c],
                    "the refusal is not remembered"
                );
            }
        }
    }
}

#[test]
fn a_shared_run_cache_gives_every_root_the_cold_result() {
    for run in [
        long_scene(1),
        long_scene(2),
        long_scene(3),
        long_scene(16),
        folder_of_scenes(),
    ] {
        let clusters = run.cluster_refs.len();
        let expected: Vec<String> = (0..clusters).map(|c| cold(&run, c)).collect();
        for order in [[0, 1], [1, 0]] {
            let mut shared = RunReplay::default();
            for c in order {
                // Twice: the second read of a Root is a pure reuse.
                for _ in 0..2 {
                    assert_eq!(describe(&replay_with(&run, &mut shared, c)), expected[c]);
                }
            }
        }
    }
}

#[test]
fn a_failed_window_is_not_remembered() {
    let good = long_scene(4);
    let mut shared = RunReplay::default();
    // Window 3's request no longer matches its receipt: the Root fails, but
    // windows 1 and 2 were proven and the failure itself is kept nowhere.
    let mut broken = good.clone();
    broken.receipts[2]["finalRequestDigest"] = json!("sha256:changed");
    let error = replay_with(&broken, &mut shared, 0)
        .err()
        .expect("must fail");
    assert_eq!(error.to_string(), "request-digest-mismatch");
    // Same cache, same labels for everything the cache saw: only the broken
    // receipt is repaired. The next read must succeed and equal a cold read.
    assert_eq!(
        describe(&replay_with(&good, &mut shared, 0)),
        cold(&good, 0)
    );
    assert!(cold(&good, 0).starts_with("complete"));
    // A snapshot whose catalog quote disagrees with its text fails at every
    // read, never once.
    let mut text = good.clone();
    text.snapshot["evidence"]["catalog"]["entries"][1]["quote"] = json!("not the sentence");
    let digest = catalog_digest(&text.snapshot["evidence"]["catalog"]);
    text.snapshot["evidence"]["catalog"]["digest"] = json!(digest);
    let mut fresh = RunReplay::default();
    for _ in 0..2 {
        assert!(replay_with(&text, &mut fresh, 0).is_err());
    }
}

#[test]
fn a_cache_built_for_other_inputs_is_dropped() {
    let good = long_scene(3);
    let mut shared = RunReplay::default();
    assert!(describe(&replay_with(&good, &mut shared, 0)).starts_with("complete"));
    // Another Run state under the same cache (another snapshot payload, so
    // another digest): nothing proven for `good` may carry over.
    let mut other = good.clone();
    other.snapshot["sourceViews"][0]["text"] = json!("The party 0 reached gate 9.");
    assert!(replay_with(&other, &mut shared, 0).is_err());
}

/// The goldens are Runs the normal planner, production extraction path and
/// review UI persisted, with receipts sealed by the TypeScript builders (the
/// TS test of the same goldens rebuilds every request digest independently).
/// Here the Native replay must accept every Root of them.
#[test]
fn the_production_goldens_read_the_same_through_a_shared_cache() {
    for (file, windows) in [
        (include_str!("production-two-window-golden.json"), 2),
        (include_str!("production-multi-window-long-golden.json"), 3),
        (
            include_str!("production-multi-window-folder-golden.json"),
            3,
        ),
    ] {
        let g: Value = serde_json::from_str(file).expect("production golden");
        golden_reads_the_same_through_a_shared_cache(&g, windows);
    }
}

fn golden_reads_the_same_through_a_shared_cache(g: &Value, window_count: usize) {
    assert_eq!(
        g["plan"]["windows"].as_array().expect("windows").len(),
        window_count
    );
    let receipts: Vec<Value> = g["receipts"].as_array().expect("receipts").clone();
    let outputs: Vec<Value> = g["outputs"].as_array().expect("outputs").clone();
    let observations: Vec<Value> = outputs
        .iter()
        .flat_map(|o| {
            o["rawObservations"]["observations"]
                .as_array()
                .expect("observations")
                .clone()
        })
        .collect();
    let raw = json!({"observations": observations});
    let clusters = json!({"clusters": outputs.iter().map(|o| json!({
        "clusterRef": o["clusterRef"],
        "observationRefs": o["rawObservations"]["observations"].as_array().expect("observations")
            .iter().map(|x| x["localId"].clone()).collect::<Vec<_>>()})).collect::<Vec<_>>()});
    let observe = receipts
        .iter()
        .find(|r| r["stageExecution"]["stageId"] == prompt::OBSERVATION)
        .expect("observe");
    let synthesize = receipts
        .iter()
        .find(|r| r["stageExecution"]["stageId"] == prompt::SYNTHESIS)
        .expect("synthesize");
    let (obs_task, obs_attempt) = (
        observe["stageExecution"]["taskId"]
            .as_str()
            .expect("task")
            .to_owned(),
        observe["stageExecution"]["attemptId"]
            .as_str()
            .expect("attempt")
            .to_owned(),
    );
    let (syn_task, syn_attempt) = (
        synthesize["stageExecution"]["taskId"]
            .as_str()
            .expect("task")
            .to_owned(),
        synthesize["stageExecution"]["attemptId"]
            .as_str()
            .expect("attempt")
            .to_owned(),
    );
    let mut map: Loaded = HashMap::new();
    map.insert(
        ("source.snapshot@1", "source.snapshot@1"),
        artifact("snap", "sha256:g-snap", "t", "a", g["snapshot"].clone()),
    );
    map.insert(
        ("source.window-plan@1", "source.window-plan@1"),
        artifact("plan", "sha256:g-plan", "t", "a", g["plan"].clone()),
    );
    map.insert(
        ("chronicle.observe-events@1", "chronicle.raw-observations@1"),
        artifact("raw", "sha256:g-raw", &obs_task, &obs_attempt, raw.clone()),
    );
    map.insert(
        (
            "chronicle.merge-local-observations@1",
            "chronicle.merged-observations@1",
        ),
        artifact("merged", "sha256:g-merged", "t", "a", raw),
    );
    map.insert(
        (
            "chronicle.cluster-event-observations@1",
            "chronicle.event-clusters@1",
        ),
        artifact("clusters", "sha256:g-clusters", "t", "a", clusters),
    );
    map.insert(
        (
            "chronicle.synthesize-event@1",
            "chronicle.stage-synthesis-outputs@1",
        ),
        artifact(
            SYN_ARTIFACT,
            SYN_DIGEST,
            &syn_task,
            &syn_attempt,
            json!({"outputs": outputs}),
        ),
    );
    let read = |cache: &mut RunReplay, cluster_ref: &str| {
        let output = outputs
            .iter()
            .find(|o| o["clusterRef"] == cluster_ref)
            .expect("output");
        let refs: Vec<String> = output["rawObservations"]["observations"]
            .as_array()
            .expect("observations")
            .iter()
            .map(|o| o["localId"].as_str().expect("id").to_owned())
            .collect();
        replay::resolve_cached(
            cache,
            &mut |task, kind| {
                map.iter()
                    .find(|((t, k), _)| *t == task && *k == kind)
                    .map(|(_, v)| Rc::clone(v))
                    .ok_or_else(|| anyhow::anyhow!("accepted-artifact-roster-invalid"))
            },
            &VerifiedV2ContextArtifact {
                source_key: format!("artifact:{SYN_ARTIFACT}"),
                revision_token: SYN_DIGEST.to_owned(),
                cluster_ref: cluster_ref.to_owned(),
                observation_refs: refs,
            },
            &json!({"windowCount": window_count}),
            &receipts,
            &g["rootEnvelope"],
        )
    };
    let mut shared = RunReplay::default();
    let refs: Vec<String> = outputs
        .iter()
        .map(|o| o["clusterRef"].as_str().expect("cluster").to_owned())
        .collect();
    let order = [refs[0].clone(), refs[1].clone(), refs[0].clone()];
    for cluster in &order {
        let warm = describe(&read(&mut shared, cluster));
        let cold = describe(&read(&mut RunReplay::default(), cluster));
        assert!(cold.starts_with("complete"), "{cluster}: {cold}");
        assert_eq!(warm, cold);
    }
}

#[test]
fn recipe_names_keep_one_and_two_windows_and_share_one_name_beyond() {
    use super::recipe_name;
    assert_eq!(
        recipe_name(Some(1)),
        "citation-id-v2/observation-v5/synthesis-v2/single-window/identity-merge/no-repair@1"
    );
    assert_eq!(
        recipe_name(Some(2)),
        "citation-id-v2/observation-v5/synthesis-v2/two-window/identity-merge/no-repair@1"
    );
    for count in [3, 4, 8, 32, 1000] {
        assert_eq!(
            recipe_name(Some(count)),
            "citation-id-v2/observation-v5/synthesis-v2/multi-window/identity-merge/no-repair@1"
        );
    }
}

/// n windows over one scene, `roots` clusters that each read one window.
fn scaling_run(n: usize, roots: usize) -> Run {
    let doc = sentence_doc(0, n);
    let wins: Vec<Win> = (0..n)
        .map(|i| {
            let end = if i + 1 == n {
                doc.text.len()
            } else {
                doc.sentences[i].1 + 1
            };
            Win {
                doc: 0,
                range: (doc.sentences[i].0, end),
            }
        })
        .collect();
    let clusters: Vec<Vec<(usize, usize)>> = (0..roots).map(|r| vec![(r % n, r % n)]).collect();
    build_run(&[doc], &wins, &clusters)
}

/// Timing, not a check: `cargo test -p grimodex-db --lib --release scaling -- --ignored --nocapture`.
#[test]
#[ignore = "timing probe; prints numbers, asserts only that the reads agree"]
fn scaling_of_a_root_read_with_and_without_the_run_cache() {
    for n in [3usize, 8, 16, 32] {
        let roots = 24;
        let run = scaling_run(n, roots);
        let map = loaded(&run);
        let start = std::time::Instant::now();
        let fresh: Vec<String> = (0..roots)
            .map(|c| describe(&replay_loaded(&run, &map, &mut RunReplay::default(), c)))
            .collect();
        let fresh_ms = start.elapsed().as_secs_f64() * 1000.0;
        let start = std::time::Instant::now();
        let mut shared = RunReplay::default();
        let warm: Vec<String> = (0..roots)
            .map(|c| describe(&replay_loaded(&run, &map, &mut shared, c)))
            .collect();
        let shared_ms = start.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(fresh, warm);
        println!(
            "windows {n:>2} roots {roots}: every Root cold {fresh_ms:>8.1} ms ({:.2} per Root), shared Run cache {shared_ms:>8.1} ms ({:.2} per Root)",
            fresh_ms / roots as f64,
            shared_ms / roots as f64
        );
    }
}

/// One document of `windows * per_window` sentences read by `windows` windows,
/// and `roots` clusters, each reading one sentence (every fifth folds the
/// sentences of two windows together).
fn held_run(windows: usize, per_window: usize, roots: usize) -> Run {
    let doc = sentence_doc(0, windows * per_window);
    let wins: Vec<Win> = (0..windows)
        .map(|w| Win {
            doc: 0,
            range: (
                doc.sentences[w * per_window].0,
                if w + 1 == windows {
                    doc.text.len()
                } else {
                    doc.sentences[(w + 1) * per_window].0
                },
            ),
        })
        .collect();
    let clusters: Vec<Vec<(usize, usize)>> = (0..roots)
        .map(|r| {
            let w = r % windows;
            let mut members = vec![(w, w * per_window + r % per_window)];
            if r % 5 == 4 && windows > 1 {
                let v = (w + 1) % windows;
                members.push((v, v * per_window));
            }
            members
        })
        .collect();
    build_run(&[doc], &wins, &clusters)
}

fn anon_kb() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|text| {
            text.lines()
                .find(|line| line.starts_with("RssAnon:"))
                .and_then(|line| line.split_whitespace().nth(1)?.parse().ok())
        })
        .unwrap_or(0)
}

/// What a Prepare holds for its candidates while it walks the roster, before
/// the release (every Root's replay: `before`) and after it (the material
/// source keys only: `after`). Memory, not a check:
/// `MW_HELD_WINDOWS=32 MW_HELD_ROOTS=416 MW_HELD_MODE=after cargo test -p grimodex-db --lib --release held_memory -- --ignored --nocapture --exact narrative_extraction::material_membership_root::multi_window_tests::held_memory_of_a_prepare_before_and_after_the_release`.
#[test]
#[ignore = "memory probe; needs MW_HELD_WINDOWS, MW_HELD_ROOTS and MW_HELD_MODE"]
fn held_memory_of_a_prepare_before_and_after_the_release() {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    let var = |name: &str| std::env::var(name).ok();
    let (Some(windows), Some(roots), Some(mode)) = (
        var("MW_HELD_WINDOWS").and_then(|v| v.parse::<usize>().ok()),
        var("MW_HELD_ROOTS").and_then(|v| v.parse::<usize>().ok()),
        var("MW_HELD_MODE"),
    ) else {
        return;
    };
    let release = mode == "after";
    let run = held_run(windows, 64, roots);
    let map = loaded(&run);
    let base = anon_kb();
    let peak = std::sync::Arc::new(AtomicU64::new(0));
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let sampler = {
        let (peak, stop) = (peak.clone(), stop.clone());
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                peak.fetch_max(anon_kb(), Ordering::Relaxed);
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
        })
    };
    let start = std::time::Instant::now();
    let mut shared = RunReplay::default();
    let mut held_outcomes = vec![];
    let mut held_keys: Vec<Vec<String>> = vec![];
    let mut materials = 0;
    for c in 0..roots {
        let (materials_of, proofs) = complete(replay_loaded(&run, &map, &mut shared, c));
        materials = materials_of.len();
        if release {
            held_keys.push(materials_of.iter().map(|m| m.source_key.clone()).collect());
        } else {
            held_outcomes.push((materials_of, proofs));
        }
    }
    let ms = start.elapsed().as_secs_f64() * 1000.0;
    drop(shared);
    let at_end = anon_kb();
    stop.store(true, Ordering::Relaxed);
    sampler.join().expect("sampler");
    println!(
        "{}",
        json!({"mode": mode, "windows": windows, "roots": roots, "materialsPerRoot": materials,
            "replayMs": ms, "anonBaseKb": base, "anonPeakAboveBaseKb": peak.load(Ordering::Relaxed).saturating_sub(base),
            "anonAtEndAboveBaseKb": at_end.saturating_sub(base),
            "held": held_outcomes.len() + held_keys.len()})
    );
}

/// Timing and equivalence on a PRIVATE COPY of a database. Set MW_TIMING_DB
/// and MW_TIMING_PROJECT. Prints counts, ids' prefixes and times only.
#[test]
#[ignore = "needs a private database copy in MW_TIMING_DB and its project in MW_TIMING_PROJECT"]
fn memo_and_plain_reads_agree_on_a_private_database_copy() {
    use super::RunProofMemo;
    use crate::narrative_extraction::material_membership::{
        read_revision_material_membership, read_revision_material_membership_with_memo,
    };
    let (Ok(path), Ok(project)) = (
        std::env::var("MW_TIMING_DB"),
        std::env::var("MW_TIMING_PROJECT"),
    ) else {
        return;
    };
    let min_windows: u64 = std::env::var("MW_TIMING_MIN_WINDOWS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1);
    let conn =
        rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("open the private copy read-only");
    let tx = conn.unchecked_transaction().expect("read transaction");
    let rows: Vec<(String, String, u64)> = tx
        .prepare(
            "SELECT p.current_revision_id, s.run_id, json_extract(run.coverage_json,'$.windowCount')
             FROM narrative_proposals p
             JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
             JOIN narrative_extraction_runs run ON run.id = s.run_id AND run.project_id = s.project_id
             WHERE s.project_id = ?1 AND p.current_revision_id IS NOT NULL
             ORDER BY s.run_id, p.id",
        )
        .expect("prepare")
        .query_map([&project], |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, Option<i64>>(2)?.unwrap_or(0) as u64)))
        .expect("query")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("rows");
    let rows: Vec<_> = rows.into_iter().filter(|r| r.2 >= min_windows).collect();
    let mut plain_ms = 0.0;
    let mut memo_ms = 0.0;
    let mut by_status: HashMap<String, usize> = HashMap::new();
    let mut memo = RunProofMemo::default();
    let mut last_run = String::new();
    for (revision, run, _) in &rows {
        if *run != last_run {
            memo = RunProofMemo::default();
            last_run = run.clone();
        }
        let start = std::time::Instant::now();
        let plain = read_revision_material_membership(&tx, &project, revision).expect("plain read");
        plain_ms += start.elapsed().as_secs_f64() * 1000.0;
        let start = std::time::Instant::now();
        let shared =
            read_revision_material_membership_with_memo(&tx, &project, revision, &mut memo)
                .expect("memo read");
        memo_ms += start.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(
            format!("{plain:?}"),
            format!("{shared:?}"),
            "revision {} of run {}",
            &revision[..8],
            &run[..8]
        );
        let status = match &plain {
            crate::narrative_extraction::MaterialMembershipRead::Complete(_) => {
                "complete".to_owned()
            }
            crate::narrative_extraction::MaterialMembershipRead::Unavailable { status, .. } => {
                format!("{status:?}")
            }
        };
        *by_status.entry(status).or_default() += 1;
    }
    println!(
        "roots {} (windows >= {min_windows}): every Root with its own memo {plain_ms:.0} ms, one memo per Run {memo_ms:.0} ms; statuses {by_status:?}",
        rows.len()
    );
}

/// DMS/1: the lower bound through a real database. The cold database of the
/// declared-scope fixture (made by the normal path with the narrowing product)
/// holds the tide proposal, whose synthesis request read scenes 2 and 3 and
/// whose event cites scene 2. The root Envelope is rewritten on a private copy
/// the way a builder that narrowed the record would have made it: a scene's
/// declaration is removed from the source basis and the dependency set and the
/// material digests are sealed again, so the Envelope digest and its internal
/// bindings agree with the narrowed content. The material replay
/// (`read_root_material_with_memo`, which the eligibility read calls for the
/// root of every revision) is then read on the copy. Only the Envelope is
/// rewritten: the normalized rows of a stored revision are not, so this does
/// not reach the human lineage check that compares them to the Envelope.
mod declared_scope_database {
    use super::super::{read_root_material_with_memo, RosterStatus, RunProofMemo};
    use flate2::read::GzDecoder;
    use rusqlite::{params, Connection};
    use serde_json::{json, Value};
    use std::collections::BTreeSet;
    use std::io::Read;

    struct Copy {
        path: std::path::PathBuf,
        project: String,
        root: String,
        scenes: Vec<String>,
    }

    impl Copy {
        fn new() -> Self {
            let manifest: Value = serde_json::from_str(include_str!(
                "../../../tests/support/nir1-declared-scope-cold.json"
            ))
            .expect("manifest");
            let mut bytes = Vec::new();
            GzDecoder::new(
                &include_bytes!("../../../tests/support/nir1-declared-scope-cold.db.gz")[..],
            )
            .read_to_end(&mut bytes)
            .expect("cold database");
            let path = std::env::temp_dir().join(format!(
                "grimodex-dms-lower-bound-{}.db",
                uuid::Uuid::new_v4()
            ));
            std::fs::write(&path, bytes).expect("private copy");
            let tide = manifest["runs"]["split"]["proposals"]
                .as_array()
                .expect("proposals")
                .iter()
                .find(|p| p["title"] == "Tide chart pinned to the post")
                .expect("tide")
                .clone();
            Self {
                path,
                project: manifest["projectId"].as_str().expect("project").to_owned(),
                root: tide["rootRevisionId"].as_str().expect("root").to_owned(),
                scenes: manifest["scenes"]["split"]
                    .as_array()
                    .expect("split scenes")
                    .iter()
                    .map(|s| format!("project:scene:{}", s.as_str().expect("scene")))
                    .collect(),
            }
        }

        /// Seal the root Envelope again, without `dropped` when given.
        fn rewrite_root(&self, dropped: Option<&str>) {
            let conn = Connection::open(&self.path).expect("private copy");
            conn.execute_batch(
                "DROP TRIGGER narrative_revision_envelope_immutable_update;
                 DROP TRIGGER narrative_proposal_revisions_v2_immutable_update_guard;",
            )
            .expect("remove the guards only on the private copy");
            let raw: String = conn
                .query_row(
                    "SELECT reconciliation_envelope_json FROM narrative_proposal_revisions WHERE id = ?1",
                    [&self.root],
                    |row| row.get(0),
                )
                .expect("root Envelope");
            let mut envelope: Value = serde_json::from_str(&raw).expect("Envelope JSON");
            if let Some(key) = dropped {
                let material = &mut envelope["effectiveMaterialBasis"];
                for field in ["sourceBasis", "dependencySet"] {
                    material[field]
                        .as_array_mut()
                        .expect("array")
                        .retain(|row| row["sourceKey"] != key && row["inputRef"] != key);
                }
                material["dependencySetDigest"] = json!(grimodex_core::canonical_json_digest(
                    &material["dependencySet"]
                )
                .expect("dependencySet digest"));
                material["materialBasisDigest"] =
                    json!(grimodex_core::canonical_json_digest(&json!({
                        "sourceBasis": material["sourceBasis"],
                        "evidenceSet": material["evidenceSet"],
                        "dependencySet": material["dependencySet"],
                    }))
                    .expect("materialBasis digest"));
            }
            conn.execute(
                "UPDATE narrative_proposal_revisions SET reconciliation_envelope_json = ?2,
                    reconciliation_envelope_digest = ?3 WHERE id = ?1",
                params![
                    self.root,
                    grimodex_core::canonical_json_string(&envelope).expect("canonical Envelope"),
                    grimodex_core::canonical_json_digest(&envelope).expect("Envelope digest")
                ],
            )
            .expect("seal the private copy");
        }

        fn replay(&self) -> (RosterStatus, Vec<String>, BTreeSet<String>) {
            let conn =
                Connection::open_with_flags(&self.path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .expect("read the private copy");
            let tx = conn.unchecked_transaction().expect("read transaction");
            let read = read_root_material_with_memo(
                &tx,
                &self.project,
                &self.root,
                &mut RunProofMemo::default(),
            )
            .expect("root material read");
            let windows = read
                .materials
                .iter()
                .filter_map(|m| {
                    m.context_id
                        .strip_prefix("observation-citation-window:")
                        .map(str::to_owned)
                })
                .collect();
            let codes = read.issues.iter().map(|i| i.code.to_owned()).collect();
            (read.status, codes, windows)
        }
    }

    impl Drop for Copy {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
            for suffix in ["-wal", "-shm"] {
                let mut path = self.path.as_os_str().to_os_string();
                path.push(suffix);
                let _ = std::fs::remove_file(std::path::PathBuf::from(path));
            }
        }
    }

    #[test]
    fn a_consistently_narrowed_root_is_stopped_by_the_lower_bound_and_the_control_replays() {
        let both = BTreeSet::from(["window-002".to_owned(), "window-003".to_owned()]);
        // The control: the same rewrite with nothing dropped. The record the
        // normal path made, sealed again, replays completely with the windows of
        // scenes 2 and 3 (the request read both, the event cites scene 2).
        let control = Copy::new();
        control.rewrite_root(None);
        let (status, codes, windows) = control.replay();
        assert_eq!(status, RosterStatus::Complete, "control: {codes:?}");
        assert_eq!(windows, both);
        // Scene 1 is not declared by this record (the request never read it):
        // dropping it changes nothing, so the rewrite itself does not stop a replay.
        let unread = Copy::new();
        let scene1 = unread.scenes[0].clone();
        unread.rewrite_root(Some(&scene1));
        let (status, codes, windows) = unread.replay();
        assert_eq!(status, RosterStatus::Complete, "scene 1 dropped: {codes:?}");
        assert_eq!(windows, both);
        // Scene 3, which the request read (the planned Observation the event does
        // not cite), dropped from the declaration: refused by the lower bound in
        // the replay. Every replay failure is reported under this one code; which
        // check refused is shown by the unit test on the recorded golden
        // (`selected-request-source-undeclared`), and the control above shows
        // nothing else in the rewrite stops it.
        let narrowed = Copy::new();
        let scene3 = narrowed.scenes[2].clone();
        narrowed.rewrite_root(Some(&scene3));
        let (status, codes, windows) = narrowed.replay();
        assert_eq!(status, RosterStatus::Inconsistent);
        assert_eq!(codes, vec!["recipe-input-binding-invalid".to_owned()]);
        assert!(windows.is_empty(), "no material is published");
        // Scene 2, the cited scene, dropped: the Envelope's own binding refuses it
        // earlier (evidence must be declared), so that is not the lower bound.
        let evidence = Copy::new();
        let scene2 = evidence.scenes[1].clone();
        evidence.rewrite_root(Some(&scene2));
        let (status, codes, _) = evidence.replay();
        assert_eq!(status, RosterStatus::Inconsistent);
        assert_eq!(codes, vec!["envelope-binding-invalid".to_owned()]);
    }
}
