use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use grimodex_db::narrative_extraction::ValidationTerminationReason as Reason;
use grimodex_semantic::runtime::ChatIrUnavailable;
use serde_json::json;

use crate::chat_ir::basis::{basis_for, derive};
use crate::chat_ir::item::{
    canonical_json, project_summary, rounded_score, select_items, Candidate, SUMMARY_MAX_CHARS,
};
use crate::chat_ir::ledger::{Ledger, LedgerFull};
use crate::chat_ir::permit::PermitPool;
use crate::chat_ir::request::{query_is_valid, Request};
use crate::chat_ir::status::{
    from_error, from_termination, from_unavailable, ChatIrStatus, STRING_CODES,
};
use crate::chat_ir::tail::{run_tail, TailEnd, TailFlush, TailTiming};
use crate::related_scenes::ranking_policy;

// ---- S1A-9: the query bound -------------------------------------------------

#[test]
fn query_bound_counts_utf16_code_units() {
    assert!(query_is_valid(&"a".repeat(500)));
    assert!(!query_is_valid(&"a".repeat(501)));
    // 250 surrogate pairs are 500 units; 251 are 502.
    assert!(query_is_valid(&"\u{1F600}".repeat(250)));
    assert!(!query_is_valid(&"\u{1F600}".repeat(251)));
    // 500 three-byte characters are 500 units and 1,500 bytes: the derived
    // byte bound is reached without being a separate check.
    let three_byte = "あ".repeat(500);
    assert_eq!(three_byte.len(), 1500);
    assert!(query_is_valid(&three_byte));
    assert!(!query_is_valid(&"あ".repeat(501)));
    // Counting characters would let 251 surrogate pairs (502 units) through.
    assert!("\u{1F600}".repeat(251).chars().count() < 500);
}

#[test]
fn empty_and_blank_queries_are_refused() {
    for query in ["", " ", "\n\t  ", "\u{3000}"] {
        assert!(!query_is_valid(query), "{query:?}");
    }
    assert!(query_is_valid("a"));
}

#[test]
fn request_rejects_unknown_and_missing_keys() {
    let ok = json!({"query":"q","projectId":"p","expectedWorkspacePath":"/w","currentSceneId":"s"});
    assert!(serde_json::from_value::<Request>(ok.clone()).is_ok());
    let mut extra = ok.clone();
    extra["extra"] = json!(1);
    assert!(serde_json::from_value::<Request>(extra).is_err());
    let mut missing = ok.clone();
    missing.as_object_mut().unwrap().remove("currentSceneId");
    assert!(serde_json::from_value::<Request>(missing).is_err());
    let mut wrong = ok;
    wrong["query"] = json!(1);
    assert!(serde_json::from_value::<Request>(wrong).is_err());
}

// ---- S1A-10 / S1A-22: the basis ---------------------------------------------

#[test]
fn only_ja_and_en_exactly_are_supported() {
    for language in ["", "JA", "fr", "en-US", "EN", "zh", " ja"] {
        assert!(basis_for(language).unwrap().is_none(), "{language:?}");
    }
    assert_eq!(
        basis_for("ja").unwrap().unwrap().spec.dir_name,
        "ruri-v3-30m"
    );
    assert_eq!(
        basis_for("en").unwrap().unwrap().spec.dir_name,
        "bge-small-en-v15"
    );
}

#[test]
fn basis_floor_and_cap_are_the_ranking_policys() {
    for language in ["ja", "en"] {
        let basis = basis_for(language).unwrap().unwrap();
        assert_eq!(
            (basis.floor, basis.cap),
            ranking_policy::for_language(language).unwrap()
        );
    }
    // And the values themselves: a drift of the policy file is noticed here.
    assert_eq!(
        basis_for("ja")
            .map(|b| b.map(|b| (b.floor, b.cap)))
            .unwrap(),
        Some((0.813, 8))
    );
    assert_eq!(
        basis_for("en")
            .map(|b| b.map(|b| (b.floor, b.cap)))
            .unwrap(),
        Some((0.660, 8))
    );
    // Where the policy refuses, chat does too (no spec fallback).
    for language in ["", "JA", "fr", "en-US"] {
        assert!(ranking_policy::for_language(language).is_err());
        assert!(basis_for(language).unwrap().is_none());
    }
}

#[test]
fn first_read_derivation_statuses() {
    assert_eq!(
        derive(None, None).unwrap().unwrap_err(),
        ChatIrStatus::ProjectUnavailable
    );
    for language in ["fr", "en-US", ""] {
        assert_eq!(
            derive(Some(language), None).unwrap().unwrap_err(),
            ChatIrStatus::Unsupported
        );
    }
    assert_eq!(derive(Some("ja"), None).unwrap().unwrap().language, "ja");
}

#[test]
fn later_reads_refuse_a_changed_project() {
    let first = basis_for("ja").unwrap().unwrap();
    // The same language passes.
    assert_eq!(
        derive(Some("ja"), Some(&first)).unwrap().unwrap().language,
        "ja"
    );
    // Another supported language, an unsupported one and a missing row are all
    // "the project changed", never a silent switch of model or floor.
    for language in [Some("en"), Some("fr"), Some(""), None] {
        assert_eq!(
            derive(language, Some(&first)).unwrap().unwrap_err(),
            ChatIrStatus::ProjectChanged,
            "{language:?}"
        );
    }
}

// ---- S1A-11: the closed status ----------------------------------------------

#[test]
fn status_names_are_distinct_and_successes_are_two() {
    let names: std::collections::HashSet<_> = ChatIrStatus::ALL
        .iter()
        .map(|status| status.as_str())
        .collect();
    assert_eq!(names.len(), ChatIrStatus::ALL.len());
    let successes: Vec<_> = ChatIrStatus::ALL
        .iter()
        .filter(|status| status.is_success())
        .map(|status| status.as_str())
        .collect();
    assert_eq!(successes, ["available", "none-above-threshold"]);
}

#[test]
fn shared_crate_outcomes_map_exhaustively() {
    assert_eq!(
        from_unavailable(ChatIrUnavailable::EmbedderCold),
        ChatIrStatus::EmbedderCold
    );
    assert_eq!(
        from_unavailable(ChatIrUnavailable::ConnectionBusy),
        ChatIrStatus::ConnectionBusy
    );
    assert_eq!(
        from_unavailable(ChatIrUnavailable::Timeout),
        ChatIrStatus::Timeout
    );
    assert_eq!(
        from_unavailable(ChatIrUnavailable::InferenceFailed),
        ChatIrStatus::InferenceFailed
    );
}

#[test]
fn typed_terminations_do_not_become_internal() {
    assert_eq!(from_termination(Reason::TimedOut), ChatIrStatus::Timeout);
    for reason in [
        Reason::Cancelled,
        Reason::Closed,
        Reason::ContextUnavailable,
    ] {
        assert_eq!(from_termination(reason), ChatIrStatus::WorkspaceUnavailable);
    }
    assert_eq!(
        from_termination(Reason::WorkspaceGenerationChanged),
        ChatIrStatus::WorkspaceChanged
    );
    for reason in [
        Reason::ForegroundPreempted,
        Reason::CleanupFailed,
        Reason::CapacityExceeded,
    ] {
        assert_eq!(from_termination(reason), ChatIrStatus::Internal);
    }
}

#[test]
fn errors_map_by_type_then_by_code() {
    let typed = grimodex_db::narrative_extraction::validation_terminated(Reason::TimedOut, "x");
    assert_eq!(from_error(&typed), ChatIrStatus::Timeout);
    // A typed marker survives added context.
    let context = typed.context("while reading");
    assert_eq!(from_error(&context), ChatIrStatus::Timeout);
    assert_eq!(
        from_error(&anyhow::anyhow!("SEMANTIC_QUERY_STALE")),
        ChatIrStatus::WorkspaceChanged
    );
    assert_eq!(
        from_error(&anyhow::anyhow!(
            "IPC_DERIVED_CANCELLED: semantic background indexing was cancelled"
        )),
        ChatIrStatus::WorkspaceChanged
    );
    assert_eq!(
        from_error(&anyhow::anyhow!("SEMANTIC_QUERY_MODEL_MISMATCH")),
        ChatIrStatus::IndexUnavailable
    );
    assert_eq!(
        from_error(&anyhow::anyhow!("SEMANTIC_QUERY_MODEL_CHANGED")),
        ChatIrStatus::Internal
    );
    assert_eq!(
        from_error(&anyhow::anyhow!("database is locked")),
        ChatIrStatus::Internal
    );
}

/// The table's strings are the shared crate's. They are looked up in its
/// source, so a renamed code is noticed here (a `ChatIrQuery`, which would let
/// the runtime produce `SEMANTIC_QUERY_STALE` itself, cannot be built without a
/// model).
#[test]
fn string_codes_are_in_the_shared_crates_source() {
    let runtime =
        include_str!("../../../../../../src-tauri/crates/grimodex-semantic/src/runtime.rs");
    let chat_ir =
        include_str!("../../../../../../src-tauri/crates/grimodex-semantic/src/runtime_chat_ir.rs");
    let audited = include_str!(
        "../../../../../../src-tauri/crates/grimodex-semantic/src/runtime_audited_query.rs"
    );
    for (code, _) in STRING_CODES {
        let found = [runtime, chat_ir, audited]
            .iter()
            .any(|source| source.contains(code));
        assert!(found, "{code} is not in the shared crate any more");
    }
}

// ---- S1A-17: canonical form and digest --------------------------------------

#[test]
fn canonical_sorts_keys_and_writes_integers_as_integers() {
    let a = json!({"b": 1.0, "a": [2, {"d": 1, "c": "x"}], "s": "é\n\"", "z": 0.8131});
    assert_eq!(
        canonical_json(&a),
        r#"{"a":[2,{"c":"x","d":1}],"b":1,"s":"é\n\"","z":0.8131}"#
    );
    let reordered = json!({"z": 0.8131, "s": "é\n\"", "b": 1, "a": [2, {"c": "x", "d": 1}]});
    assert_eq!(canonical_json(&a), canonical_json(&reordered));
}

#[test]
fn score_is_rounded_to_four_decimals_for_the_output_only() {
    assert_eq!(rounded_score(0.813_049_9), 0.813);
    assert_eq!(rounded_score(0.813_06), 0.8131);
    assert_eq!(rounded_score(1.0), 1.0);
    // The rounded value survives a text round trip, which a widened f32 does not
    // need to (it has the extra digits of the f32).
    let rounded = rounded_score(0.722_992_96);
    let text = serde_json::to_string(&rounded).unwrap();
    assert_eq!(text, "0.723");
    assert_eq!(serde_json::from_str::<f64>(&text).unwrap(), rounded);
}

// ---- S1A-15 (copy of the selection), S1A-16, S1A-24 -------------------------

fn candidate<'a>(
    score: f32,
    scene: &'a str,
    revision: &'a str,
    evidence: &'a str,
    statement: &'a str,
) -> Candidate<'a> {
    Candidate {
        score,
        scene_id: scene,
        revision_id: revision,
        evidence_id: evidence,
        statement,
        quote: format!("quote of {scene}"),
    }
}

const STATEMENT: &str = r#"{"summary":"a summary","actuality":"real","attribution":"narrator","narrativeFrame":"main"}"#;

fn titles(scene: &str) -> anyhow::Result<Option<String>> {
    Ok(Some(format!("title of {scene}")))
}

#[test]
fn selection_ranks_filters_dedupes_and_caps() {
    let candidates = vec![
        candidate(0.90, "sB", "r1", "e1", STATEMENT),
        candidate(0.95, "sA", "r2", "e1", STATEMENT),
        candidate(0.90, "sA", "r3", "e1", STATEMENT), // second of scene sA
        candidate(0.50, "sC", "r4", "e1", STATEMENT), // below the floor
        candidate(0.85, "sD", "r5", "e1", STATEMENT),
    ];
    let items = select_items(candidates.clone(), 0.8, 8, 7, titles).unwrap();
    let scenes: Vec<_> = items.iter().map(|item| item.scene_id.as_str()).collect();
    assert_eq!(scenes, ["sA", "sB", "sD"]);
    assert_eq!(items[0].revision_id, "r2");
    assert!(items.iter().all(|item| item.generation == 7));
    // The cap stops the list.
    let capped = select_items(candidates, 0.8, 2, 7, titles).unwrap();
    assert_eq!(capped.len(), 2);
}

#[test]
fn ties_break_by_scene_then_revision_then_evidence() {
    let candidates = vec![
        candidate(0.9, "s2", "r1", "e1", STATEMENT),
        candidate(0.9, "s1", "r2", "e2", STATEMENT),
        candidate(0.9, "s1", "r2", "e1", STATEMENT),
        candidate(0.9, "s1", "r1", "e9", STATEMENT),
    ];
    // Scene s1 comes first and its smallest revision/evidence wins; s2 follows.
    let items = select_items(candidates, 0.8, 8, 1, titles).unwrap();
    assert_eq!(
        items
            .iter()
            .map(|i| (i.scene_id.as_str(), i.revision_id.as_str()))
            .collect::<Vec<_>>(),
        [("s1", "r1"), ("s2", "r1")]
    );
}

#[test]
fn floor_is_decided_on_the_unrounded_score_and_an_equal_score_passes() {
    // 0.81299 rounds to 0.813 but is below the floor 0.813.
    let below = vec![candidate(0.812_99, "s1", "r", "e", STATEMENT)];
    assert!(select_items(below, 0.813, 8, 1, titles).unwrap().is_empty());
    let on = vec![candidate(0.813_f32, "s1", "r", "e", STATEMENT)];
    let floor = f64::from(0.813_f32);
    assert_eq!(select_items(on, floor, 8, 1, titles).unwrap().len(), 1);
}

#[test]
fn a_scene_without_a_title_is_skipped_and_does_not_take_the_scenes_place() {
    let candidates = vec![
        candidate(0.95, "gone", "r1", "e", STATEMENT),
        candidate(0.90, "kept", "r2", "e", STATEMENT),
    ];
    let items = select_items(candidates, 0.8, 8, 1, |scene| {
        Ok((scene != "gone").then(|| scene.to_string()))
    })
    .unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].scene_id, "kept");
}

#[test]
fn a_non_finite_score_is_an_error() {
    for score in [f32::NAN, f32::INFINITY] {
        let candidates = vec![candidate(score, "s1", "r", "e", STATEMENT)];
        assert!(select_items(candidates, 0.8, 8, 1, titles).is_err());
    }
}

#[test]
fn the_projection_is_an_allowlist_of_the_summary_and_the_quote() {
    let items = select_items(
        vec![candidate(0.9, "s1", "r", "e", STATEMENT)],
        0.8,
        8,
        3,
        titles,
    )
    .unwrap();
    let object = items[0].value.as_object().unwrap();
    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "$grimodexIr",
            "origin",
            "quotes",
            "review",
            "revisionId",
            "sceneId",
            "sceneTitle",
            "score",
            "summary"
        ]
    );
    let text = items[0].value.to_string();
    for property in [
        "actuality",
        "attribution",
        "narrativeFrame",
        "real",
        "narrator",
        "main",
    ] {
        assert!(!text.contains(property), "{property} leaked into the item");
    }
}

#[test]
fn a_long_summary_is_cut_and_marked() {
    let long = "あ".repeat(SUMMARY_MAX_CHARS + 5);
    let statement = json!({"summary": long, "actuality": "x"}).to_string();
    let cut = project_summary(&statement).unwrap();
    assert_eq!(cut.chars().count(), SUMMARY_MAX_CHARS + 1);
    assert!(cut.ends_with('…'));
    let exact = json!({"summary": "あ".repeat(SUMMARY_MAX_CHARS)}).to_string();
    assert_eq!(
        project_summary(&exact).unwrap().chars().count(),
        SUMMARY_MAX_CHARS
    );
    assert!(project_summary("not json").is_err());
    assert!(project_summary(r#"{"actuality":"x"}"#).is_err());
}

#[test]
fn item_digest_is_the_canonical_digest_of_its_value() {
    let items = select_items(
        vec![candidate(0.9, "s1", "r", "e", STATEMENT)],
        0.8,
        8,
        3,
        titles,
    )
    .unwrap();
    let item = &items[0];
    let canonical = canonical_json(&item.value);
    assert_eq!(item.byte_length, canonical.len());
    assert_eq!(
        item.digest,
        grimodex_semantic::audit::sha256_hex(canonical.as_bytes())
    );
    // A different key order of the same object has the same digest.
    let mut reversed = serde_json::Map::new();
    for (key, value) in item.value.as_object().unwrap().iter().rev() {
        reversed.insert(key.clone(), value.clone());
    }
    assert_eq!(
        canonical_json(&serde_json::Value::Object(reversed)),
        canonical
    );
}

// ---- S1A-18: the ledger ------------------------------------------------------

fn items(count: usize, prefix: &str) -> Vec<crate::chat_ir::item::IrItem> {
    let statements: Vec<String> = (0..count).map(|_| STATEMENT.to_string()).collect();
    let scenes: Vec<String> = (0..count)
        .map(|index| format!("{prefix}-scene-{index}"))
        .collect();
    let candidates: Vec<_> = (0..count)
        .map(|index| candidate(0.9, &scenes[index], "r", "e", &statements[index]))
        .collect();
    select_items(candidates, 0.8, 1000, 1, titles).unwrap()
}

#[test]
fn ledger_counts_a_digest_once() {
    let mut ledger = Ledger::new(10);
    let batch = items(3, "a");
    ledger.issue(1, &batch).unwrap();
    ledger.issue(1, &batch).unwrap();
    assert_eq!(ledger.len(), 3);
    // The same item twice in one call is one place too.
    let doubled: Vec<_> = batch.iter().chain(batch.iter()).cloned().collect();
    ledger.issue(1, &doubled).unwrap();
    assert_eq!(ledger.len(), 3);
}

#[test]
fn ledger_refuses_a_whole_call_and_never_pushes_anything_out() {
    let mut ledger = Ledger::new(4);
    let first = items(3, "a");
    ledger.issue(1, &first).unwrap();
    // 3 + 2 > 4: nothing of the second call is taken, not even the first of its
    // two items.
    let second = items(2, "b");
    assert_eq!(ledger.issue(1, &second), Err(LedgerFull));
    assert_eq!(ledger.len(), 3);
    for item in &first {
        assert!(
            ledger.get(1, &item.digest).is_some(),
            "an issued entry was pushed out"
        );
    }
    for item in &second {
        assert!(ledger.get(1, &item.digest).is_none());
    }
    // One more still fits, then the ledger is full.
    ledger.issue(1, &items(1, "c")).unwrap();
    assert_eq!(ledger.issue(1, &items(1, "d")), Err(LedgerFull));
    // A full ledger still accepts an item it already holds.
    ledger.issue(1, &first[..1]).unwrap();
}

#[test]
fn ledger_is_dropped_when_the_database_identity_changes() {
    let mut ledger = Ledger::new(4);
    let batch = items(2, "a");
    ledger.issue(1, &batch).unwrap();
    assert!(ledger.get(1, &batch[0].digest).is_some());
    // Another identity does not see them, and issuing for it starts empty.
    assert!(ledger.get(2, &batch[0].digest).is_none());
    assert_eq!(ledger.len(), 0);
    ledger.issue(2, &items(4, "b")).unwrap();
    assert!(ledger.get(1, &batch[0].digest).is_none());
}

#[test]
fn ledger_check_and_insert_are_atomic_under_concurrent_calls() {
    let ledger = Arc::new(Mutex::new(Ledger::new(50)));
    let accepted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    std::thread::scope(|scope| {
        for thread in 0..8 {
            let ledger = Arc::clone(&ledger);
            let accepted = Arc::clone(&accepted);
            scope.spawn(move || {
                for call in 0..20 {
                    let batch = items(3, &format!("t{thread}-c{call}"));
                    if ledger.lock().unwrap().issue(1, &batch).is_ok() {
                        accepted.fetch_add(3, std::sync::atomic::Ordering::SeqCst);
                    }
                }
            });
        }
    });
    let held = ledger.lock().unwrap().len();
    assert!(held <= 50, "the capacity was exceeded: {held}");
    assert_eq!(held, accepted.load(std::sync::atomic::Ordering::SeqCst));
}

// ---- S1A-4: the permit pool ---------------------------------------------------

#[test]
fn permits_never_exceed_the_limit_and_never_wait() {
    let pool = PermitPool::new(2);
    let a = pool.try_acquire().expect("first");
    let b = pool.try_acquire().expect("second");
    let started = Instant::now();
    assert!(pool.try_acquire().is_none());
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "try_acquire waited"
    );
    assert_eq!(pool.in_flight(), 2);
    drop(a);
    assert_eq!(pool.in_flight(), 1);
    let c = pool.try_acquire().expect("freed place");
    drop((b, c));
    assert_eq!(pool.in_flight(), 0);
}

#[test]
fn permits_hold_the_limit_under_concurrent_acquisition() {
    let pool = PermitPool::new(2);
    let peak = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    std::thread::scope(|scope| {
        for _ in 0..16 {
            let pool = Arc::clone(&pool);
            let peak = Arc::clone(&peak);
            scope.spawn(move || {
                for _ in 0..200 {
                    if let Some(permit) = pool.try_acquire() {
                        peak.fetch_max(pool.in_flight(), std::sync::atomic::Ordering::SeqCst);
                        drop(permit);
                    }
                }
            });
        }
    });
    assert!(peak.load(std::sync::atomic::Ordering::SeqCst) <= 2);
    assert_eq!(pool.in_flight(), 0);
}

// ---- S1A-12: the tail loop ----------------------------------------------------

struct Pending {
    /// How long one `flush_until` takes when it does not succeed.
    busy_for: Duration,
    succeed_on_call: Option<usize>,
    error_on_call: bool,
    calls: usize,
    done: bool,
}

impl Pending {
    fn new(busy_for: Duration, succeed_on_call: Option<usize>) -> Self {
        Self {
            busy_for,
            succeed_on_call,
            error_on_call: false,
            calls: 0,
            done: false,
        }
    }
}

impl TailFlush for Pending {
    fn is_empty(&self) -> bool {
        self.done
    }
    fn flush_until(&mut self, deadline: Instant) -> anyhow::Result<bool> {
        self.calls += 1;
        if self.error_on_call {
            anyhow::bail!("append failed");
        }
        std::thread::sleep(
            self.busy_for
                .min(deadline.saturating_duration_since(Instant::now())),
        );
        if self.succeed_on_call == Some(self.calls) {
            self.done = true;
            return Ok(true);
        }
        Ok(false)
    }
}

fn timing(budget_ms: u64, slice_ms: u64, close_ms: u64) -> TailTiming {
    TailTiming {
        budget: Duration::from_millis(budget_ms),
        slice: Duration::from_millis(slice_ms),
        close_flush: Duration::from_millis(close_ms),
    }
}

#[test]
fn tail_ends_when_the_records_are_written() {
    let mut pending = Pending::new(Duration::from_millis(5), Some(3));
    assert_eq!(
        run_tail(&mut pending, &timing(2000, 20, 50), || false),
        TailEnd::Flushed
    );
    assert_eq!(pending.calls, 3);
    // Nothing pending to begin with ends at once.
    let mut empty = Pending::new(Duration::ZERO, Some(1));
    empty.done = true;
    assert_eq!(
        run_tail(&mut empty, &timing(2000, 20, 50), || false),
        TailEnd::Flushed
    );
    assert_eq!(empty.calls, 0);
}

#[test]
fn tail_slices_so_the_stop_request_is_seen_between_attempts() {
    // One attempt would sleep for the whole budget (10 s); slices of 30 ms see
    // the stop request within about one slice plus the last attempt.
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let setter = Arc::clone(&stop);
    let started = Instant::now();
    let handle = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(80));
        setter.store(true, std::sync::atomic::Ordering::SeqCst);
    });
    let mut pending = Pending::new(Duration::from_secs(10), None);
    let end = run_tail(&mut pending, &timing(10_000, 30, 40), || {
        stop.load(std::sync::atomic::Ordering::SeqCst)
    });
    handle.join().unwrap();
    assert_eq!(end, TailEnd::Stopped { flushed: false });
    assert!(
        started.elapsed() < Duration::from_secs(5), // the one attempt alone would be 10 s
        "the tail outlived the stop request by {:?}",
        started.elapsed()
    );
}

#[test]
fn tail_makes_one_last_attempt_after_the_stop_request() {
    // The stop is already requested: one attempt of the close flush, which
    // succeeds on the first call.
    let mut pending = Pending::new(Duration::ZERO, Some(1));
    assert_eq!(
        run_tail(&mut pending, &timing(10_000, 30, 40), || true),
        TailEnd::Stopped { flushed: true }
    );
    assert_eq!(pending.calls, 1);
}

#[test]
fn tail_last_attempt_never_outlives_the_budget() {
    // DR-CHATIR-S1-28: the stop is requested just before the budget runs out and
    // the close flush (2 s) is much longer than what is left; the last attempt is
    // cut at the tail's deadline (200 ms), not at stop + close_flush.
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let setter = Arc::clone(&stop);
    let started = Instant::now();
    let handle = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(170));
        setter.store(true, std::sync::atomic::Ordering::SeqCst);
    });
    let mut pending = Pending::new(Duration::from_secs(10), None);
    let end = run_tail(&mut pending, &timing(200, 30, 2_000), || {
        stop.load(std::sync::atomic::Ordering::SeqCst)
    });
    handle.join().unwrap();
    let elapsed = started.elapsed();
    assert!(
        matches!(end, TailEnd::Stopped { flushed: false } | TailEnd::Expired),
        "{end:?}"
    );
    // stop + close_flush would be about 2.2 s.
    assert!(elapsed < Duration::from_millis(1_000), "{elapsed:?}");
}

#[test]
fn tail_makes_no_last_attempt_once_the_budget_is_spent() {
    // A zero budget: the deadline has passed when the stop is read, so the close
    // flush does not start at all.
    let mut pending = Pending::new(Duration::ZERO, Some(1));
    assert_eq!(
        run_tail(&mut pending, &timing(0, 30, 2_000), || true),
        TailEnd::Stopped { flushed: false }
    );
    assert_eq!(pending.calls, 0);
}

#[test]
fn tail_ends_at_its_budget() {
    let started = Instant::now();
    let mut pending = Pending::new(Duration::from_millis(20), None);
    assert_eq!(
        run_tail(&mut pending, &timing(200, 50, 50), || false),
        TailEnd::Expired
    );
    let elapsed = started.elapsed();
    assert!(elapsed >= Duration::from_millis(200), "{elapsed:?}");
    assert!(elapsed < Duration::from_secs(5), "{elapsed:?}");
}

#[test]
fn tail_gives_up_after_repeated_append_errors() {
    let mut pending = Pending::new(Duration::ZERO, None);
    pending.error_on_call = true;
    assert_eq!(
        run_tail(&mut pending, &timing(5_000, 10, 10), || false),
        TailEnd::Failed
    );
    assert_eq!(pending.calls, 5);
}
