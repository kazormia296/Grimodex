//! Replay of a Run with three or more windows, and the Run-level reuse that
//! lets many Roots of one Run share what their windows prove (MW/1).
//!
//! The synthetic Runs seal their own requests with the Native recipe, so they
//! prove the structure (every window and receipt is bound, nothing is
//! dropped, nothing is remembered wrongly). The recipe's agreement with the
//! TypeScript builders is proven by the production goldens, the two-window
//! cold fixture and the evaluation database, not here.
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

#[test]
fn a_missing_duplicated_changed_or_foreign_window_request_never_replays() {
    let base = long_scene(3);
    let mut variants: Vec<(&str, Run)> = vec![];
    let mut missing = base.clone();
    missing.receipts.remove(1);
    variants.push(("a window request is missing", missing));
    let mut duplicated = base.clone();
    duplicated.receipts[2] = duplicated.receipts[1].clone();
    variants.push(("one request answers two windows", duplicated));
    let mut changed = base.clone();
    changed.receipts[1]["finalRequestDigest"] = json!("sha256:changed");
    variants.push(("a request digest was changed", changed));
    let mut foreign = base.clone();
    foreign.receipts[2]["stageExecution"]["runId"] = json!("run-2");
    variants.push(("a request of another Run", foreign));
    let mut other_task = base.clone();
    other_task.receipts[0]["stageExecution"]["taskId"] = json!("task-other");
    variants.push(("a request of another Task", other_task));
    let mut extra = base.clone();
    let mut again = extra.receipts[0].clone();
    again["stageExecution"]["stageExecutionId"] = json!("exec-observe-extra");
    extra.receipts.insert(1, again);
    variants.push(("a fourth request for three windows", extra));
    let mut text = base.clone();
    text.snapshot["sourceViews"][1]["text"] = json!("changed words that are no longer the scene");
    variants.push(("a window text that is not the scene's", text));
    for (name, run) in variants {
        let result = replay_with(&run, &mut RunReplay::default(), 0);
        assert!(result.is_err(), "{name}: {}", describe(&result));
    }
    let mut digest = base.clone();
    digest.receipts[1]["finalRequestDigest"] = json!("sha256:changed");
    let error = replay_with(&digest, &mut RunReplay::default(), 0)
        .err()
        .expect("must fail");
    assert_eq!(error.to_string(), "request-digest-mismatch");
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

#[test]
fn the_two_window_production_golden_reads_the_same_through_a_shared_cache() {
    let g = golden();
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
            &json!({"windowCount": 2}),
            &receipts,
            &g["rootEnvelope"],
        )
    };
    let mut shared = RunReplay::default();
    for cluster in ["cluster-0001", "cluster-0002", "cluster-0001"] {
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
