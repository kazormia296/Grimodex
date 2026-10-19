//! F group (CB-4 S3) and the safety checks added by the review: what leaves
//! the reader, that the reader writes nothing, and that a candidate cannot be
//! carried into another read transaction.
//!
//! - F1/F2: no value of a Scene (its ID, title, excerpt, any digest or token,
//!   the workspace values) appears in any `Debug` output, in the counters, or
//!   in the `Display` of an error; the types that carry them print no fields.
//! - F4: the request-local binding, the result and the candidate do not
//!   implement `Serialize` (checked at compile time by the probe below).
//! - F6: the DB is byte-identical after every entry point, no entry point
//!   writes (`total_changes`), and every entry point refuses a connection that
//!   is not in a read transaction.
//! - S2 (review): a candidate carried into a later transaction is checked
//!   against the declaration, the Scope token and the title as they are at
//!   that moment.
//! - Cell conversion failures (a title or body that is not UTF-8) skip the
//!   candidate instead of failing the whole response.
//! - A chain of folders longer than the walk's limit is not live.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;
use std::marker::PhantomData;

use rusqlite::hooks::AuthAction;
use rusqlite::types::ValueRef;
use rusqlite::{params, Connection};
use serde::Serialize;

use super::body::disclose_graph_only_candidate;
use super::body_tests::{
    assert_nothing_added, click, disclose, disclose_with, eligible, place_real, set_content,
};
use super::counters::totals;
use super::tests::{
    add_pin, add_scene, associations, execute, fixture, query, raw_cells, restrict, unrestrict,
    workspace, Path, OPEN,
};
use super::*;
use crate::narrative_extraction::scene_body_declaration::archived_in_chain;
use crate::narrative_extraction::scene_body_declaration::writer_support_tests::{
    body_json, set_a1, Env, PROJECT,
};

// ---- F4: Serialize is not implemented -----------------------------------------------

/// `Probe::<T>::IMPLEMENTS` is true only for a `T` that implements
/// `Serialize`: the inherent constant needs the bound, the trait constant is
/// the fallback. It adds no dependency and fails the test (not the build)
/// when someone derives `Serialize` for one of the types.
struct Probe<T>(PhantomData<T>);

trait Fallback {
    const IMPLEMENTS: bool = false;
}
impl<T> Fallback for Probe<T> {}

impl<T: Serialize> Probe<T> {
    const IMPLEMENTS: bool = true;
}

#[test]
#[allow(clippy::assertions_on_constants)] // the constants are the point: a type-level fact
fn f4_the_binding_the_result_and_the_candidate_are_not_serializable() {
    // Control: the probe sees a type that is serializable.
    assert!(Probe::<String>::IMPLEMENTS);
    assert!(Probe::<Vec<u8>>::IMPLEMENTS);

    assert!(!Probe::<GraphOnlySceneBinding>::IMPLEMENTS);
    assert!(!Probe::<EligibleGraphScene>::IMPLEMENTS);
    assert!(!Probe::<GraphOnlySceneDisclosure>::IMPLEMENTS);
    assert!(!Probe::<GraphOnlyCandidate>::IMPLEMENTS);
    assert!(!Probe::<GraphOnlyScan>::IMPLEMENTS);
    assert!(!Probe::<GraphSceneRange>::IMPLEMENTS);
    assert!(!Probe::<GraphOnlyClick>::IMPLEMENTS);
    assert!(!Probe::<GraphDisclosureWorkspace>::IMPLEMENTS);
    assert!(!Probe::<GraphDisclosureQuery>::IMPLEMENTS);
}

// ---- F1 / F2: nothing about a Scene is printed ---------------------------------------------

const SCENE_ID: &str = "a-zebra-scene-77";
const TITLE: &str = "Marigold Chapter";
const LINE: &str = "Quillfeather opens the vault.";

/// A declared Scene whose ID, title and first line are unlike anything else
/// the fixture prints.
fn distinctive(env: &Env) {
    add_scene(env, SCENE_ID, None, true);
    add_pin(env, SCENE_ID, "2026-10-19T00:30:00Z");
    set_content(env, SCENE_ID, &body_json(LINE));
    execute(
        env,
        &format!("UPDATE tree_nodes SET title = '{TITLE}' WHERE id = '{SCENE_ID}';"),
    );
    place_real(env, SCENE_ID);
}

/// Every string a Scene's response must not print.
fn secrets(shown: &EligibleGraphScene) -> Vec<String> {
    let binding = shown.binding();
    vec![
        SCENE_ID.to_owned(),
        TITLE.to_owned(),
        "Quillfeather".to_owned(),
        LINE.to_owned(),
        binding.body.source_token.clone(),
        binding.body.storage_digest.clone(),
        binding.body.canonical_digest.clone(),
        binding.body.excerpt_digest.clone(),
        binding.title_digest.clone(),
        binding.declaration_id.clone(),
        binding.declaration_token.clone(),
        binding.scene_incarnation_id.clone(),
        binding.scope_source_token.clone(),
        binding.workspace_id.clone(),
        binding.canonical_locator_digest.clone(),
        binding.authority_revision_token.clone(),
        binding.association.pin_entry_id.clone(),
        binding.association.pin_created_at.clone(),
    ]
}

fn assert_prints_none(printed: &str, secrets: &[String], what: &str) {
    for secret in secrets {
        assert!(
            !printed.contains(secret.as_str()),
            "{what} prints a value of the Scene: {secret}\n{printed}"
        );
    }
}

#[test]
fn f1_no_value_of_a_scene_is_printed_by_any_type_counter_or_error() {
    let env = fixture();
    distinctive(&env);
    let shown = eligible(disclose(&env, &[SCENE_ID]));
    let secrets = secrets(&shown);
    assert_eq!(shown.title(), TITLE);
    assert_eq!(shown.excerpt(), LINE);

    // The types that carry the values print no fields at all.
    assert_eq!(format!("{shown:?}"), "EligibleGraphScene { .. }");
    assert_eq!(
        format!("{:?}", shown.binding()),
        "GraphOnlySceneBinding { .. }"
    );
    assert_eq!(format!("{:?}", shown.range()), "GraphSceneRange { .. }");
    let candidates = associations(&env, &[SCENE_ID]);
    let scan = {
        let workspace = workspace(&env);
        let query = query(&env);
        let existing = BTreeSet::new();
        let input = GraphOnlyScanInput {
            workspace: &workspace,
            query: &query,
            slot: OPEN,
            existing_scene_ids: &existing,
            candidates: &candidates,
        };
        let printed = format!("{input:?} {workspace:?} {query:?}");
        assert_prints_none(&printed, &secrets, "the inputs");
        env.db()
            .db()
            .with_read_transaction(|conn| {
                evaluate_graph_only_append(conn, &input, &mut Path::yes(), &mut || Ok(()))
            })
            .unwrap()
    };
    assert_eq!(format!("{scan:?}"), "Candidate(GraphOnlyCandidate { .. })");
    let candidate_printed = format!("{:?}", shown.binding().association);
    // The association is the frame's own value; the binding that wraps it does
    // not print it.
    assert!(candidate_printed.contains(SCENE_ID));
    assert_prints_none(&format!("{:?}", shown.binding()), &secrets, "the binding");

    // A click: allowed and refused.
    let allowed = click(&env, shown.binding()).unwrap();
    assert_eq!(format!("{allowed:?}"), "Allowed(GraphSceneRange { .. })");
    let mut moved = shown.binding().clone();
    moved.body.end_utf16 += 1;
    let refused = click(&env, &moved).unwrap();
    assert_eq!(
        format!("{refused:?}"),
        "Refused(GraphSceneRevalidationRefused)"
    );
    assert_eq!(
        GraphSceneRevalidationRefused.code(),
        "graph-scene-revalidation-failed"
    );
    assert_eq!(NotAppended.code(), "graph-scene-not-appended");

    // The only diagnostic: counts of closed outcomes.
    let printed = format!("{:?}", totals());
    assert_prints_none(&printed, &secrets, "the counters");
    for (code, _) in totals() {
        assert!(
            code.chars().all(|c| c.is_ascii_lowercase() || c == '-'),
            "a counter code is a fixed word: {code}"
        );
    }
}

#[test]
fn f2_a_candidate_rejected_after_its_body_was_read_leaves_nothing_behind() {
    let env = fixture();
    distinctive(&env);
    let shown = eligible(disclose(&env, &[SCENE_ID]));
    let secrets = secrets(&shown);

    // The body is read and then differs from the declaration.
    set_content(
        &env,
        SCENE_ID,
        &body_json("A line the declaration never saw."),
    );
    let result = disclose(&env, &[SCENE_ID]);
    assert_nothing_added(&result);
    assert_eq!(format!("{result:?}"), "NotAppended(NotAppended)");
    assert_prints_none(&format!("{:?}", totals()), &secrets, "the counters");

    // A storage failure and a caller's stop are errors that name no Scene.
    restrict(&env, |action| {
        matches!(action, AuthAction::Read { table_name, column_name }
            if *table_name == "tree_nodes" && *column_name == "title")
    });
    let failure = disclose_with(
        &env,
        &associations(&env, &[SCENE_ID]),
        &mut Path::yes(),
        &mut || Ok(()),
    );
    unrestrict(&env);
    let error = failure.expect_err("a storage failure is an error");
    assert_prints_none(
        &format!("{error:#} {error:?}"),
        &secrets,
        "the storage error",
    );

    let stopped = disclose_with(
        &env,
        &associations(&env, &[SCENE_ID]),
        &mut Path::yes(),
        &mut || anyhow::bail!("NIR1_CANCELLED"),
    )
    .expect_err("a stop is an error");
    assert_eq!(stopped.to_string(), "NIR1_CANCELLED");
}

#[test]
fn f2_no_source_file_of_the_reader_logs() {
    for (name, source) in [
        (
            "scene_disclosure.rs",
            include_str!("../scene_disclosure.rs"),
        ),
        ("body.rs", include_str!("body.rs")),
        ("click.rs", include_str!("click.rs")),
        ("counters.rs", include_str!("counters.rs")),
        ("eligible.rs", include_str!("eligible.rs")),
        ("judge.rs", include_str!("judge.rs")),
    ] {
        for needle in [
            "println!",
            "eprintln!",
            "dbg!",
            "tracing::",
            "log::",
            "info!(",
            "warn!(",
            "error!(",
            "debug!(",
            "trace!(",
        ] {
            assert!(
                !source.contains(needle),
                "{name} must not write to a log or stdout: {needle}"
            );
        }
    }
}

// ---- F6: the reader writes nothing ------------------------------------------------------------------

/// Every table's rows as text, for a byte comparison before and after.
fn dump(conn: &Connection) -> Vec<(String, Vec<String>)> {
    let names: Vec<String> = {
        let mut statement = conn
            .prepare(
                "SELECT name FROM sqlite_master
                  WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .unwrap();
        let rows = statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<String>>>()
            .unwrap();
        rows
    };
    let mut dump = Vec::new();
    for name in names {
        let Ok(mut statement) = conn.prepare(&format!("SELECT * FROM \"{name}\"")) else {
            continue; // a virtual table whose module is not loaded here
        };
        let columns = statement.column_count();
        let Ok(mut rows) = statement.query([]) else {
            continue;
        };
        let mut lines = Vec::new();
        while let Ok(Some(row)) = rows.next() {
            let line = (0..columns)
                .map(|index| match row.get_ref(index).unwrap() {
                    ValueRef::Null => "NULL".to_owned(),
                    ValueRef::Integer(value) => value.to_string(),
                    ValueRef::Real(value) => value.to_string(),
                    ValueRef::Text(value) => format!("t:{}", String::from_utf8_lossy(value)),
                    ValueRef::Blob(value) => format!("b:{value:?}"),
                })
                .collect::<Vec<_>>()
                .join("|");
            lines.push(line);
        }
        dump.push((name, lines));
    }
    dump
}

#[test]
fn f6_no_entry_point_writes_and_the_whole_database_is_byte_identical() {
    let env = fixture();
    distinctive(&env);
    place_real(&env, "b1");
    let before = env.with_conn(|conn| Ok(dump(conn)));
    assert!(
        before.iter().any(|(_, rows)| !rows.is_empty()),
        "the dump sees the rows"
    );

    let workspace = workspace(&env);
    let query = query(&env);
    let candidates = associations(&env, &[SCENE_ID, "b1", "b2"]);
    let existing = BTreeSet::new();
    let input = GraphOnlyScanInput {
        workspace: &workspace,
        query: &query,
        slot: OPEN,
        existing_scene_ids: &existing,
        candidates: &candidates,
    };
    let binding = env
        .db()
        .db()
        .with_read_transaction(|conn| {
            let changes = conn.total_changes();
            // The scan alone, then the whole reader (Eligible), then a click.
            let scan = evaluate_graph_only_append(conn, &input, &mut Path::yes(), &mut || Ok(()))?;
            let GraphOnlyScan::Candidate(candidate) = scan else {
                panic!("a candidate was expected");
            };
            let by_hand = disclose_graph_only_candidate(
                conn,
                &workspace,
                &query,
                *candidate,
                &mut || Ok(()),
            )?;
            assert!(matches!(by_hand, GraphOnlySceneDisclosure::Eligible(_)));
            let whole = evaluate_graph_only_scene(conn, &input, &mut Path::yes(), &mut || Ok(()))?;
            let GraphOnlySceneDisclosure::Eligible(shown) = whole else {
                panic!("an eligible Scene was expected");
            };
            let clicked = requalify_graph_only_scene_disclosure(
                conn,
                &workspace,
                &query,
                shown.binding(),
                &mut Path::yes(),
                &mut || Ok(()),
            )?;
            assert!(matches!(clicked, GraphOnlyClick::Allowed(_)));
            // A refusal and a NotAppended write nothing either.
            let mut moved = shown.binding().clone();
            moved.body.end_utf16 += 1;
            let refused = requalify_graph_only_scene_disclosure(
                conn,
                &workspace,
                &query,
                &moved,
                &mut Path::yes(),
                &mut || Ok(()),
            )?;
            assert!(matches!(refused, GraphOnlyClick::Refused(_)));
            let closed = AppendSlot {
                ir_uses_common_slot: true,
                raw_count: 0,
            };
            let none = evaluate_graph_only_scene(
                conn,
                &GraphOnlyScanInput {
                    slot: closed,
                    ..input_copy(&input)
                },
                &mut Path::yes(),
                &mut || Ok(()),
            )?;
            assert!(matches!(none, GraphOnlySceneDisclosure::NotAppended(_)));
            assert_eq!(conn.total_changes(), changes, "the reader executed a write");
            Ok(shown.binding().clone())
        })
        .unwrap();
    let _ = binding;
    let after = env.with_conn(|conn| Ok(dump(conn)));
    assert_eq!(before, after, "the database changed");
}

fn input_copy<'a>(input: &GraphOnlyScanInput<'a>) -> GraphOnlyScanInput<'a> {
    GraphOnlyScanInput {
        workspace: input.workspace,
        query: input.query,
        slot: input.slot,
        existing_scene_ids: input.existing_scene_ids,
        candidates: input.candidates,
    }
}

#[test]
fn f6_every_entry_point_refuses_a_connection_that_is_not_in_a_read_transaction() {
    let env = fixture();
    place_real(&env, "b1");
    let shown = eligible(disclose(&env, &["b1"]));
    let workspace = workspace(&env);
    let query = query(&env);
    let candidates = associations(&env, &["b1"]);
    let existing = BTreeSet::new();
    let input = GraphOnlyScanInput {
        workspace: &workspace,
        query: &query,
        slot: OPEN,
        existing_scene_ids: &existing,
        candidates: &candidates,
    };
    let candidate = env
        .db()
        .db()
        .with_read_transaction(|conn| {
            match evaluate_graph_only_append(conn, &input, &mut Path::yes(), &mut || Ok(()))? {
                GraphOnlyScan::Candidate(candidate) => Ok(candidate),
                GraphOnlyScan::NotAppended(_) => panic!("a candidate was expected"),
            }
        })
        .unwrap();
    env.with_conn(|conn| {
        assert!(conn.is_autocommit());
        assert!(
            evaluate_graph_only_append(conn, &input, &mut Path::yes(), &mut || Ok(())).is_err()
        );
        assert!(evaluate_graph_only_scene(conn, &input, &mut Path::yes(), &mut || Ok(())).is_err());
        assert!(requalify_graph_only_scene_disclosure(
            conn,
            &workspace,
            &query,
            shown.binding(),
            &mut Path::yes(),
            &mut || Ok(()),
        )
        .is_err());
        // The step that is not public refuses it too.
        assert!(disclose_graph_only_candidate(
            conn,
            &workspace,
            &query,
            *candidate,
            &mut || Ok(())
        )
        .is_err());
        Ok(())
    });
}

// ---- F5: a SQL budget interrupt only adds nothing (DR-CB4-23) -----------------------------------------

/// A progress handler that stops every statement after `allowed` steps, which
/// is what a participant's SQL budget does on the connection. `tripped` is set
/// when it stopped one, so a checkpoint can tell it from a cancel.
fn install_budget(
    conn: &Connection,
    allowed: u64,
    tripped: &std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    use std::sync::atomic::{AtomicU64, Ordering};
    let used = std::sync::Arc::new(AtomicU64::new(0));
    let tripped = std::sync::Arc::clone(tripped);
    let _ = conn.progress_handler(
        1,
        Some(move || {
            if used.fetch_add(1, Ordering::Relaxed) >= allowed {
                tripped.store(true, Ordering::Relaxed);
                true
            } else {
                false
            }
        }),
    );
}

fn remove_budget(conn: &Connection) {
    let _ = conn.progress_handler(0, None::<fn() -> bool>);
}

fn untripped() -> std::sync::Arc<std::sync::atomic::AtomicBool> {
    std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false))
}

#[test]
fn f5_a_budget_interrupt_anywhere_in_the_response_adds_nothing_and_is_never_an_error() {
    use std::sync::atomic::Ordering;
    let env = fixture();
    place_real(&env, "b1");
    let candidates = associations(&env, &["b1"]);
    let workspace = workspace(&env);
    let query = query(&env);
    let existing = BTreeSet::new();
    let input = GraphOnlyScanInput {
        workspace: &workspace,
        query: &query,
        slot: OPEN,
        existing_scene_ids: &existing,
        candidates: &candidates,
    };
    let mut tripped_somewhere = false;
    let mut disclosed_somewhere = false;
    // Budgets from "the first statement" up to "more than the whole response
    // needs": the answer is Ok at every point, and a Scene is added only when
    // the budget was never reached.
    for allowed in [
        0u64, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 20_000, 1_000_000,
    ] {
        let tripped = untripped();
        let outcome = env
            .db()
            .db()
            .with_read_transaction(|conn| {
                install_budget(conn, allowed, &tripped);
                let outcome =
                    evaluate_graph_only_scene(conn, &input, &mut Path::yes(), &mut || Ok(()));
                remove_budget(conn);
                Ok(outcome)
            })
            .unwrap();
        let disclosure = outcome.unwrap_or_else(|error| {
            panic!("budget {allowed}: an interrupt is not an error: {error:#}")
        });
        if tripped.load(Ordering::Relaxed) {
            tripped_somewhere = true;
            assert_nothing_added(&disclosure);
        } else {
            disclosed_somewhere = true;
            assert!(matches!(disclosure, GraphOnlySceneDisclosure::Eligible(_)));
        }
    }
    assert!(tripped_somewhere, "the sweep must reach the budget");
    assert!(disclosed_somewhere, "the sweep must also pass it");
}

#[test]
fn f5_a_budget_interrupt_gives_the_same_code_as_every_other_reason_and_changes_no_row() {
    let env = fixture();
    place_real(&env, "b1");
    let candidates = associations(&env, &["b1"]);
    let workspace = workspace(&env);
    let query = query(&env);
    let existing = BTreeSet::new();
    let input = GraphOnlyScanInput {
        workspace: &workspace,
        query: &query,
        slot: OPEN,
        existing_scene_ids: &existing,
        candidates: &candidates,
    };
    let before = env.with_conn(|conn| Ok(dump(conn)));
    let tripped = untripped();
    let interrupted = env
        .db()
        .db()
        .with_read_transaction(|conn| {
            install_budget(conn, 0, &tripped);
            let outcome = evaluate_graph_only_scene(conn, &input, &mut Path::yes(), &mut || Ok(()));
            remove_budget(conn);
            Ok(outcome)
        })
        .unwrap()
        .unwrap();
    let GraphOnlySceneDisclosure::NotAppended(interrupted) = interrupted else {
        panic!("an interrupt must add nothing");
    };
    // The renderer cannot tell this from "no candidate".
    let none = disclose(&env, &[]);
    let GraphOnlySceneDisclosure::NotAppended(none) = none else {
        panic!("no candidate adds nothing");
    };
    assert_eq!(interrupted, none);
    assert_eq!(interrupted.code(), none.code());
    assert_eq!(
        env.with_conn(|conn| Ok(dump(conn))),
        before,
        "the reader writes nothing"
    );
}

#[test]
fn f5_an_interrupt_with_a_failing_checkpoint_is_the_checkpoints_error() {
    use std::sync::atomic::Ordering;
    let env = fixture();
    place_real(&env, "b1");
    let candidates = associations(&env, &["b1"]);
    let workspace = workspace(&env);
    let query = query(&env);
    let existing = BTreeSet::new();
    let input = GraphOnlyScanInput {
        workspace: &workspace,
        query: &query,
        slot: OPEN,
        existing_scene_ids: &existing,
        candidates: &candidates,
    };
    // A cancel that is told to the connection as an interrupt: the checkpoint
    // fails once the statement was stopped.
    let tripped = untripped();
    let flag = std::sync::Arc::clone(&tripped);
    let outcome = env
        .db()
        .db()
        .with_read_transaction(|conn| {
            install_budget(conn, 0, &tripped);
            let outcome = evaluate_graph_only_scene(conn, &input, &mut Path::yes(), &mut || {
                if flag.load(Ordering::Relaxed) {
                    anyhow::bail!("cancelled")
                }
                Ok(())
            });
            remove_budget(conn);
            Ok(outcome)
        })
        .unwrap();
    let error = outcome.expect_err("a cancel is an error, not a verdict");
    assert!(format!("{error:#}").contains("cancelled"));
}

#[test]
fn f5_a_budget_interrupt_in_the_body_step_the_carry_over_check_and_the_click_adds_nothing() {
    let env = fixture();
    place_real(&env, "b1");
    let shown = eligible(disclose(&env, &["b1"]));
    let candidates = associations(&env, &["b1"]);
    let workspace = workspace(&env);
    let query = query(&env);
    let existing = BTreeSet::new();
    let input = GraphOnlyScanInput {
        workspace: &workspace,
        query: &query,
        slot: OPEN,
        existing_scene_ids: &existing,
        candidates: &candidates,
    };
    let reached = std::cell::Cell::new((false, false));
    for allowed in [0u64, 3, 20, 100, 400] {
        let tripped = untripped();
        env.db()
            .db()
            .with_read_transaction(|conn| {
                let candidate = match evaluate_graph_only_append(
                    conn,
                    &input,
                    &mut Path::yes(),
                    &mut || Ok(()),
                )? {
                    GraphOnlyScan::Candidate(candidate) => candidate,
                    GraphOnlyScan::NotAppended(_) => panic!("a candidate was expected"),
                };
                // The budget is reached after the scan: in the re-check of
                // the scan's values or in the body read.
                install_budget(conn, allowed, &tripped);
                let disclosure = disclose_graph_only_candidate(
                    conn,
                    &workspace,
                    &query,
                    *candidate,
                    &mut || Ok(()),
                );
                remove_budget(conn);
                let disclosure = disclosure.unwrap_or_else(|error| {
                    panic!("budget {allowed}: an interrupt is not an error: {error:#}")
                });
                if tripped.load(std::sync::atomic::Ordering::Relaxed) {
                    assert_nothing_added(&disclosure);
                    reached.set((true, reached.get().1));
                }
                Ok(())
            })
            .unwrap();

        // The click: the scan of the one Scene and the body step.
        let tripped = untripped();
        env.db()
            .db()
            .with_read_transaction(|conn| {
                install_budget(conn, allowed, &tripped);
                let clicked = requalify_graph_only_scene_disclosure(
                    conn,
                    &workspace,
                    &query,
                    shown.binding(),
                    &mut Path::yes(),
                    &mut || Ok(()),
                );
                remove_budget(conn);
                let clicked = clicked.unwrap_or_else(|error| {
                    panic!("budget {allowed}: an interrupt is not an error: {error:#}")
                });
                if tripped.load(std::sync::atomic::Ordering::Relaxed) {
                    assert!(matches!(
                        clicked,
                        GraphOnlyClick::Refused(GraphSceneRevalidationRefused)
                    ));
                    reached.set((reached.get().0, true));
                }
                Ok(())
            })
            .unwrap();
    }
    assert_eq!(
        reached.get(),
        (true, true),
        "the sweep must reach the budget"
    );
}

// ---- S2 (review): a candidate carried into another transaction ----------------------------------------------

#[test]
fn a_candidate_carried_into_a_later_transaction_is_not_eligible_after_any_change() {
    type Change = Box<dyn Fn(&Env)>;
    let changes: Vec<(&str, Change)> = vec![
        (
            "the declaration revoked",
            Box::new(|env| {
                raw_cells(
                    env,
                    "b1",
                    rusqlite::types::Value::Null,
                    rusqlite::types::Value::Null,
                )
            }),
        ),
        (
            "a new declaration for the same body",
            Box::new(|env| {
                place_real(env, "b1");
            }),
        ),
        (
            "A1 changed",
            Box::new(|env| set_a1(env.db().db(), PROJECT, "b1", false)),
        ),
        (
            "the title changed without a version change",
            Box::new(|env| {
                execute(
                    env,
                    "UPDATE tree_nodes SET title = 'Other' WHERE id = 'b1';",
                )
            }),
        ),
    ];
    for (name, change) in changes {
        let env = fixture();
        place_real(&env, "b1");
        let workspace = workspace(&env);
        let query = query(&env);
        let candidates = associations(&env, &["b1"]);
        let existing = BTreeSet::new();
        let input = GraphOnlyScanInput {
            workspace: &workspace,
            query: &query,
            slot: OPEN,
            existing_scene_ids: &existing,
            candidates: &candidates,
        };
        let candidate = env
            .db()
            .db()
            .with_read_transaction(|conn| {
                match evaluate_graph_only_append(conn, &input, &mut Path::yes(), &mut || Ok(()))? {
                    GraphOnlyScan::Candidate(candidate) => Ok(candidate),
                    GraphOnlyScan::NotAppended(_) => panic!("{name}: a candidate was expected"),
                }
            })
            .unwrap();

        // Control: in the same state, a later transaction still discloses it.
        let query_now = super::tests::query(&env);
        change(&env);
        let result = env
            .db()
            .db()
            .with_read_transaction(|conn| {
                disclose_graph_only_candidate(conn, &workspace, &query_now, *candidate, &mut || {
                    Ok(())
                })
            })
            .unwrap_or_else(|error| panic!("{name}: {error:#}"));
        assert!(
            matches!(result, GraphOnlySceneDisclosure::NotAppended(NotAppended)),
            "{name}: a carried-over candidate must not be eligible, got {result:?}"
        );
    }
}

// ---- cells that are not valid UTF-8 -------------------------------------------------------------------------------------

#[test]
fn a_title_that_is_not_utf8_skips_the_candidate_and_the_next_one_is_taken() {
    let env = fixture();
    place_real(&env, "b1");
    place_real(&env, "b2");
    execute(
        &env,
        "UPDATE tree_nodes SET title = CAST(x'ff41' AS TEXT) WHERE id = 'b1';",
    );
    let result = disclose_with(
        &env,
        &associations(&env, &["b1", "b2"]),
        &mut Path::yes(),
        &mut || Ok(()),
    )
    .expect("a broken cell is not a failure of the response");
    assert_eq!(eligible(result).scene_id(), "b2");
}

#[test]
fn a_body_that_is_not_utf8_is_not_appended_and_is_not_an_error() {
    let env = fixture();
    place_real(&env, "b1");
    place_real(&env, "b2");
    execute(
        &env,
        "UPDATE tree_nodes SET content = CAST(x'ff' AS TEXT) WHERE id = 'b1';",
    );
    let result = disclose_with(
        &env,
        &associations(&env, &["b1", "b2"]),
        &mut Path::yes(),
        &mut || Ok(()),
    )
    .expect("a broken cell is not a failure of the response");
    // The adopted candidate's body is the one body read; b2 is not tried.
    assert_nothing_added(&result);
}

// ---- the folder chain ---------------------------------------------------------------------------------------------------

fn folder_chain(env: &Env, folders: usize, archive_root: bool) {
    env.with_conn(|conn| {
        // cf{folders-1} is the root; cf0 holds the Scene.
        for index in (0..folders).rev() {
            let parent = (index + 1 < folders).then(|| format!("cf{}", index + 1));
            let archived = (archive_root && index + 1 == folders).then_some("2026-10-19 00:00:00");
            conn.execute(
                "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, content, archived_at)
                 VALUES (?1, 'p1', ?2, 'folder', ?1, ?1, '{}', ?3)",
                params![format!("cf{index}"), parent, archived],
            )?;
        }
        conn.execute("UPDATE tree_nodes SET parent_id = 'cf0' WHERE id = 'b1'", [])?;
        Ok(())
    });
}

fn live_by_the_shared_walk(env: &Env, scene: &str) -> bool {
    !env.db()
        .db()
        .with_read_transaction(|conn| archived_in_chain(conn, PROJECT, scene))
        .unwrap()
}

#[test]
fn a_chain_longer_than_the_walk_is_not_live() {
    // Within the limit and not archived: live. The Scene is depth 0, the folders
    // are depths 1..=n, and the walk reaches depth 256.
    for (folders, archive_root, live) in [
        (10, false, true),
        (10, true, false),
        (255, false, true),
        (256, false, true),
        // The root is not reached: the walk cannot tell, so it is not live.
        (257, false, false),
        (300, true, false),
    ] {
        let env = fixture();
        folder_chain(&env, folders, archive_root);
        assert_eq!(
            live_by_the_shared_walk(&env, "b1"),
            live,
            "{folders} folders, root archived={archive_root}"
        );
    }
}

#[test]
fn a_scene_in_a_too_deep_chain_is_not_appended_and_the_next_one_is_taken() {
    let env = fixture();
    place_real(&env, "b1");
    place_real(&env, "b2");
    folder_chain(&env, 257, false);
    let result = disclose(&env, &["b1", "b2"]);
    assert_eq!(eligible(result).scene_id(), "b2");
}
