//! C and D groups (CB-4 S2): the body step, the result, and the click
//! revalidation.
//!
//! Declarations here carry the digests of the body as it is read (made like the
//! production writer's, but placed with the `#[cfg(test)]` setter so a body the
//! writer would refuse, for example one with a beat POV, can be declared), or
//! come from the production writer itself.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use rusqlite::params;
use uuid::Uuid;

use grimodex_core::narrative_scene_body_declaration::{
    NarrativeSceneBodyDeclarationBindingV1, NarrativeSceneBodyDeclarationV1,
    NarrativeSceneBodySourceV1,
};

use super::body::{body_reads, reset_body_reads};
use super::counters::local_counts;
use super::tests::{
    add_pin, association, associations, context, counts, execute, fixture, query, raw_cells,
    restrict, unrestrict, workspace, Path, OPEN,
};
use super::*;
use crate::narrative_extraction::retrieval_admission::{
    read_retrieval_scene_source, read_retrieval_scene_source_bounded, RetrievalSceneSourceRead,
};
use crate::narrative_extraction::scene_body_declaration::test_support::{
    set_scene_body_declaration_for_test, TEST_DECLARED_AT,
};
use crate::narrative_extraction::scene_body_declaration::writer_support_tests::{
    body_json, declare, request_for, set_a1, Env, PROJECT,
};
use crate::narrative_extraction::scene_body_declaration::{
    quarantine_scene_body_declaration_workspace_for_test, scene_body_declaration_veto,
    scene_body_title_digest, VetoLimits, SCENE_BODY_READ_MAX_BYTES,
};
use crate::narrative_extraction::task_leases::with_immediate_transaction;

// ---- fixture ----------------------------------------------------------------

fn set_content(env: &Env, scene: &str, content: &str) {
    env.with_conn(|conn| {
        conn.execute(
            "UPDATE tree_nodes SET content = ?2 WHERE id = ?1",
            params![scene, content],
        )?;
        Ok(())
    });
}

/// Declares the Scene's body as it is read now: real digests, the Ready
/// workspace's values, and `tamper` applied to the binding before it is placed.
/// Fails when the body cannot be read within the limits.
fn try_place_real(
    env: &Env,
    scene: &str,
    tamper: impl Fn(&mut NarrativeSceneBodyDeclarationBindingV1),
) -> anyhow::Result<NarrativeSceneBodyDeclarationV1> {
    let workspace = GraphDisclosureWorkspace::from_snapshot(&env.snapshot());
    let parts = workspace.parts().expect("workspace values");
    env.with_conn(|conn| {
        Ok(with_immediate_transaction(conn, |tx| {
            let RetrievalSceneSourceRead::Available(source) = read_retrieval_scene_source_bounded(
                tx,
                PROJECT,
                scene,
                SCENE_BODY_READ_MAX_BYTES,
                SCENE_BODY_READ_MAX_BYTES,
                &mut || Ok(()),
                &mut |_| Ok(()),
            )?
            else {
                anyhow::bail!("body is not available");
            };
            let (incarnation, scope_token): (String, String) = tx.query_row(
                "SELECT scene_incarnation_id, source_token FROM narrative_scene_scope_bindings
                  WHERE project_id = ?1 AND scene_id = ?2",
                params![PROJECT, scene],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let title: String = tx.query_row(
                "SELECT title FROM tree_nodes WHERE id = ?1",
                [scene],
                |row| row.get(0),
            )?;
            let mut binding = NarrativeSceneBodyDeclarationBindingV1 {
                project_id: PROJECT.to_owned(),
                scene_id: scene.to_owned(),
                scene_incarnation_id: incarnation,
                scope_source_token: scope_token,
                body_source: NarrativeSceneBodySourceV1 {
                    source_identity: source.query_source.source_key.clone(),
                    source_token: source.query_source.revision_token.clone(),
                    storage_digest: source.query_source.storage_digest.clone(),
                    canonical_digest: source.query_source.canonical_text_digest.clone(),
                    normalizer_version: source.query_source.normalizer_version.to_owned(),
                    utf16_length: u64::try_from(source.query_source.canonical_utf16_length)?,
                },
                title_digest: scene_body_title_digest(&title)?,
                workspace_id: parts.workspace_id.clone(),
                canonical_locator_digest: parts.canonical_locator_digest.clone(),
            };
            tamper(&mut binding);
            let declaration = NarrativeSceneBodyDeclarationV1::new(
                Uuid::new_v4().to_string(),
                TEST_DECLARED_AT,
                binding,
            )?;
            set_scene_body_declaration_for_test(tx, &declaration)?;
            Ok(declaration)
        }))
    })
}

fn place_real(env: &Env, scene: &str) -> NarrativeSceneBodyDeclarationV1 {
    try_place_real(env, scene, |_| {}).expect("a readable body")
}

fn disclose_with(
    env: &Env,
    candidates: &[Nir1GraphSceneAssociation],
    path: &mut Path,
    check: &mut dyn FnMut() -> Result<()>,
) -> Result<GraphOnlySceneDisclosure> {
    let workspace = workspace(env);
    let query = query(env);
    let existing = BTreeSet::new();
    let input = GraphOnlyScanInput {
        workspace: &workspace,
        query: &query,
        slot: OPEN,
        existing_scene_ids: &existing,
        candidates,
    };
    env.db()
        .db()
        .with_read_transaction(|conn| evaluate_graph_only_scene(conn, &input, path, check))
}

fn disclose(env: &Env, scenes: &[&str]) -> GraphOnlySceneDisclosure {
    let candidates = associations(env, scenes);
    disclose_with(env, &candidates, &mut Path::yes(), &mut || Ok(())).unwrap()
}

fn eligible(disclosure: GraphOnlySceneDisclosure) -> EligibleGraphScene {
    match disclosure {
        GraphOnlySceneDisclosure::Eligible(scene) => *scene,
        GraphOnlySceneDisclosure::NotAppended(_) => panic!("an eligible Scene was expected"),
    }
}

fn assert_nothing_added(disclosure: &GraphOnlySceneDisclosure) {
    assert!(
        matches!(
            disclosure,
            GraphOnlySceneDisclosure::NotAppended(NotAppended)
        ),
        "no Scene should be added, got {disclosure:?}"
    );
}

fn click(env: &Env, binding: &GraphOnlySceneBinding) -> Result<GraphOnlyClick> {
    click_with(env, binding, &mut Path::yes())
}

fn click_with(
    env: &Env,
    binding: &GraphOnlySceneBinding,
    path: &mut Path,
) -> Result<GraphOnlyClick> {
    let workspace = workspace(env);
    let query = query(env);
    env.db().db().with_read_transaction(|conn| {
        requalify_graph_only_scene_disclosure(conn, &workspace, &query, binding, path, &mut || {
            Ok(())
        })
    })
}

fn assert_refused(env: &Env, binding: &GraphOnlySceneBinding, what: &str) {
    let result = click(env, binding).unwrap_or_else(|error| panic!("{what}: {error:#}"));
    assert!(
        matches!(
            result,
            GraphOnlyClick::Refused(GraphSceneRevalidationRefused)
        ),
        "{what}: the click must be refused, got {result:?}"
    );
}

fn utf16_slice(text: &str, range: GraphSceneRange) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    String::from_utf16(&units[range.start_utf16..range.end_utf16]).unwrap()
}

fn paragraphs(texts: &[&str]) -> String {
    let content: Vec<_> = texts
        .iter()
        .map(|text| {
            if text.is_empty() {
                serde_json::json!({ "type": "paragraph" })
            } else {
                serde_json::json!({
                    "type": "paragraph",
                    "content": [{ "type": "text", "text": text }],
                })
            }
        })
        .collect();
    serde_json::json!({ "type": "doc", "content": content }).to_string()
}

/// Counts the statements that mention `tree_nodes.content`.
fn count_body_statements(env: &Env) -> Arc<AtomicUsize> {
    let counter = Arc::new(AtomicUsize::new(0));
    let seen = Arc::clone(&counter);
    restrict(env, move |action| {
        if matches!(action, rusqlite::hooks::AuthAction::Read { table_name, column_name }
            if *table_name == "tree_nodes" && *column_name == "content")
        {
            seen.fetch_add(1, Ordering::SeqCst);
        }
        false
    });
    counter
}

// ---- C1: the positive result -------------------------------------------------

#[test]
fn c1_a_declared_scene_is_eligible_with_its_title_excerpt_and_range() {
    let env = fixture();
    place_real(&env, "b1");
    reset_body_reads();
    let scene = eligible(disclose(&env, &["b1"]));
    assert_eq!(scene.scene_id(), "b1");
    assert_eq!(scene.title(), "Title of b1");
    assert_eq!(scene.excerpt(), "Body.");
    assert_eq!(scene.range().start_utf16, 0);
    assert_eq!(scene.range().end_utf16, 5);
    assert_eq!(body_reads(), ["b1"]);
    assert_eq!(
        counts(),
        [("adopted", 1), ("disclosed", 1)],
        "only closed counts"
    );
}

#[test]
fn c1_the_range_points_into_the_canonical_text_after_blank_lines_and_surrogates() {
    let env = fixture();
    let body = paragraphs(&["", "   ", "\u{1F338}a Mira 日本語", "second line"]);
    set_content(&env, "b1", &body);
    place_real(&env, "b1");
    let scene = eligible(disclose(&env, &["b1"]));
    assert_eq!(scene.excerpt(), "\u{1F338}a Mira 日本語");
    let canonical = env.with_conn(|conn| {
        conn.query_row(
            "SELECT content FROM tree_nodes WHERE id = 'b1'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(Into::into)
    });
    let canonical = crate::narrative_extraction::change_feed::scene_canonical_text(&canonical);
    let range = scene.range();
    assert!(range.start_utf16 > 0, "blank lines come first");
    assert_eq!(utf16_slice(&canonical, range), scene.excerpt());
    // The surrogate pair is two UTF-16 units: the range is wider than the
    // number of characters.
    assert_eq!(
        range.end_utf16 - range.start_utf16,
        scene.excerpt().encode_utf16().count()
    );
    assert!(range.end_utf16 - range.start_utf16 > scene.excerpt().chars().count());
}

#[test]
fn c1_a_single_short_line_with_a_surrogate_pair_is_three_units() {
    let env = fixture();
    set_content(&env, "b1", &body_json("\u{1F338}a"));
    place_real(&env, "b1");
    let scene = eligible(disclose(&env, &["b1"]));
    assert_eq!((scene.range().start_utf16, scene.range().end_utf16), (0, 3));
}

// ---- C2: the same workspace opened again -----------------------------------------

#[test]
fn c2_a_workspace_that_is_closed_and_opened_again_keeps_its_declaration() {
    let mut env = fixture();
    place_real(&env, "b1");
    assert!(matches!(
        disclose(&env, &["b1"]),
        GraphOnlySceneDisclosure::Eligible(_)
    ));
    env.reopen();
    let scene = eligible(disclose(&env, &["b1"]));
    assert_eq!(scene.excerpt(), "Body.");
}

// ---- C3: one body at most --------------------------------------------------------

#[test]
fn c3_only_the_adopted_candidates_body_is_read() {
    let env = fixture();
    // b1 has no declaration; b2 and b3 are declared.
    place_real(&env, "b2");
    place_real(&env, "b3");
    reset_body_reads();
    let scene = eligible(disclose(&env, &["b1", "b2", "b3"]));
    assert_eq!(scene.scene_id(), "b2");
    assert_eq!(body_reads(), ["b2"], "neither b1 nor b3 was read");
}

#[test]
fn c3_a_candidate_rejected_by_its_body_stops_the_query() {
    let env = fixture();
    place_real(&env, "b1");
    place_real(&env, "b2");
    reset_body_reads();
    // b1's body changes without any token moving: the digest differs.
    set_content(&env, "b1", &body_json("Another body."));
    let result = disclose(&env, &["b1", "b2"]);
    assert_nothing_added(&result);
    assert_eq!(body_reads(), ["b1"], "b2's body is not read");
}

// ---- C4: the body step's refusals -------------------------------------------------

#[test]
fn c4_a_declaration_that_differs_from_the_body_read_is_not_appended() {
    type Tamper = Box<dyn Fn(&mut NarrativeSceneBodyDeclarationBindingV1)>;
    let cases: Vec<(&str, Tamper)> = vec![
        (
            "storage digest",
            Box::new(|binding| binding.body_source.storage_digest = test_digest('1')),
        ),
        (
            "canonical digest",
            Box::new(|binding| binding.body_source.canonical_digest = test_digest('2')),
        ),
        (
            "normalizer version",
            Box::new(|binding| {
                binding.body_source.normalizer_version = "gdx-canonical-text/0".to_owned()
            }),
        ),
        (
            "utf16 length",
            Box::new(|binding| binding.body_source.utf16_length += 1),
        ),
    ];
    for (name, tamper) in cases {
        let env = fixture();
        try_place_real(&env, "b1", tamper).unwrap();
        reset_body_reads();
        let result = disclose(&env, &["b1"]);
        assert_nothing_added(&result);
        assert_eq!(body_reads(), ["b1"], "{name}: the body was read once");
    }
}

fn test_digest(seed: char) -> String {
    format!("sha256:{}", seed.to_string().repeat(64))
}

#[test]
fn c4_a_beat_pov_in_the_saved_body_vetoes() {
    let env = fixture();
    let body = serde_json::json!({
        "type": "doc",
        "content": [
            { "type": "paragraph", "content": [{ "type": "text", "text": "Opening." }] },
            { "type": "sceneBeat", "attrs": { "pov": "c1" },
              "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Beat." }] }] },
        ],
    })
    .to_string();
    set_content(&env, "b1", &body);
    place_real(&env, "b1");
    let result = disclose(&env, &["b1"]);
    assert_nothing_added(&result);
    let totals: BTreeMap<_, _> = counts().into_iter().collect();
    assert_eq!(totals.get("veto"), Some(&1), "{totals:?}");
    // A beat without a POV is fine.
    let env = fixture();
    let body = serde_json::json!({
        "type": "doc",
        "content": [
            { "type": "sceneBeat", "attrs": { "pov": "" },
              "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Beat." }] }] },
        ],
    })
    .to_string();
    set_content(&env, "b1", &body);
    place_real(&env, "b1");
    assert!(matches!(
        disclose(&env, &["b1"]),
        GraphOnlySceneDisclosure::Eligible(_)
    ));
}

#[test]
fn c4_an_empty_body_or_one_that_is_not_json_is_not_appended() {
    let env = fixture();
    set_content(&env, "b1", &paragraphs(&["", "  "]));
    place_real(&env, "b1");
    assert_nothing_added(&disclose(&env, &["b1"]));

    let env = fixture();
    place_real(&env, "b1");
    set_content(&env, "b1", "this is not json");
    assert_nothing_added(&disclose(&env, &["b1"]));
    let totals: BTreeMap<_, _> = counts().into_iter().collect();
    assert_eq!(totals.get("body-unreadable"), Some(&1), "{totals:?}");
}

/// The number of authorizer reads of `tree_nodes.content` that `run` causes.
fn body_statements_of(env: &Env, run: impl FnOnce()) -> usize {
    let statements = count_body_statements(env);
    run();
    unrestrict(env);
    statements.load(Ordering::SeqCst)
}

fn direct_bounded_read(env: &Env, scene: &str) {
    env.db()
        .db()
        .with_read_transaction(|conn| {
            let _ = read_retrieval_scene_source_bounded(
                conn,
                PROJECT,
                scene,
                SCENE_BODY_READ_MAX_BYTES,
                SCENE_BODY_READ_MAX_BYTES,
                &mut || Ok(()),
                &mut |_| Ok(()),
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn c4_a_body_above_the_read_limit_is_rejected_before_it_is_materialized() {
    let env = fixture();
    place_real(&env, "b1");
    // Above SCENE_BODY_READ_MAX_BYTES: the shared reader stops after its length
    // probe, and the reader adds no statement of its own that mentions the body.
    set_content(&env, "b1", &"x".repeat(SCENE_BODY_READ_MAX_BYTES + 1));
    let probe_only = body_statements_of(&env, || direct_bounded_read(&env, "b1"));
    assert!(probe_only >= 1);
    // Building the query context reads the query Scene's own source.
    let context_cost = body_statements_of(&env, || drop(query(&env)));
    let mut result = None;
    let through_reader = body_statements_of(&env, || result = Some(disclose(&env, &["b1"])));
    assert_nothing_added(&result.unwrap());
    assert_eq!(
        through_reader - context_cost,
        probe_only,
        "no select of the body was made"
    );
    let totals: BTreeMap<_, _> = counts().into_iter().collect();
    assert_eq!(totals.get("resource-limit"), Some(&1), "{totals:?}");
}

#[test]
fn c4_a_body_above_the_canonical_parse_limit_is_not_appended() {
    let env = fixture();
    place_real(&env, "b1");
    // Below the storage limit, above the shared canonical parse limit (32 KiB).
    set_content(&env, "b1", &body_json(&"a".repeat(40_000)));
    assert_nothing_added(&disclose(&env, &["b1"]));
    let totals: BTreeMap<_, _> = counts().into_iter().collect();
    assert_eq!(totals.get("resource-limit"), Some(&1), "{totals:?}");
}

#[test]
fn c4_the_body_is_read_once_by_the_shared_reader_and_once_by_the_veto() {
    let env = fixture();
    place_real(&env, "b1");
    let reader = body_statements_of(&env, || direct_bounded_read(&env, "b1"));
    let veto = body_statements_of(&env, || {
        env.db()
            .db()
            .with_read_transaction(|conn| {
                scene_body_declaration_veto(conn, PROJECT, "b1", VetoLimits::DEFAULT).map(|_| ())
            })
            .unwrap();
    });
    let context_cost = body_statements_of(&env, || drop(query(&env)));
    let mut result = None;
    let whole = body_statements_of(&env, || result = Some(disclose(&env, &["b1"])));
    assert!(matches!(
        result.unwrap(),
        GraphOnlySceneDisclosure::Eligible(_)
    ));
    // The writer's veto has a fixed signature, so it reads the same Scene's
    // saved body once more; nothing else mentions the body.
    assert_eq!(whole - context_cost, reader + veto);
}

// ---- C5: the title and the sizes -----------------------------------------------------

#[test]
fn c5_the_title_is_the_declared_one_and_a_changed_title_is_not_appended() {
    let env = fixture();
    place_real(&env, "b1");
    execute(
        &env,
        "UPDATE tree_nodes SET title = 'Changed' WHERE id = 'b1';",
    );
    assert_nothing_added(&disclose(&env, &["b1"]));
}

// ---- C6: the writer and the reader read one text ---------------------------------------

#[test]
fn c6_the_excerpt_comes_from_the_text_the_writer_and_the_preview_read() {
    let env = fixture();
    set_content(&env, "b1", &paragraphs(&["", "First line", "Second line"]));
    let declared = declare(&env, request_for(&env, PROJECT, "b1")).expect("production declaration");
    let _ = declared;
    let scene = eligible(disclose(&env, &["b1"]));
    assert_eq!(scene.excerpt(), "First line");

    // The bounded read (the writer's and the reader's) and the unbounded read
    // give byte-identical canonical text, and the declaration holds its digest.
    env.with_conn(|conn| {
        with_immediate_transaction(conn, |tx| {
            let RetrievalSceneSourceRead::Available(bounded) = read_retrieval_scene_source_bounded(
                tx,
                PROJECT,
                "b1",
                SCENE_BODY_READ_MAX_BYTES,
                SCENE_BODY_READ_MAX_BYTES,
                &mut || Ok(()),
                &mut |_| Ok(()),
            )?
            else {
                panic!("bounded read");
            };
            let RetrievalSceneSourceRead::Available(unbounded) =
                read_retrieval_scene_source(tx, PROJECT, "b1")?
            else {
                panic!("unbounded read");
            };
            assert_eq!(
                bounded.canonical_source_text,
                unbounded.canonical_source_text
            );
            assert_eq!(
                bounded.query_source.canonical_text_digest,
                scene.binding().body.canonical_digest
            );
            let first = bounded
                .canonical_source_text
                .lines()
                .find(|line| !line.trim().is_empty())
                .unwrap();
            assert_eq!(first, scene.excerpt());
            Ok(())
        })
    });
}

// ---- D1: the click ----------------------------------------------------------------------

#[test]
fn d1_an_unchanged_scene_is_allowed_at_the_same_range() {
    let env = fixture();
    place_real(&env, "b1");
    let scene = eligible(disclose(&env, &["b1"]));
    let GraphOnlyClick::Allowed(range) = click(&env, scene.binding()).unwrap() else {
        panic!("the click should be allowed");
    };
    assert_eq!(range, scene.range());
    // The click can be made again and gives the same answer; a change of
    // another Scene does not matter.
    execute(
        &env,
        "UPDATE tree_nodes SET title = 'Other', version = version + 1 WHERE id = 'b2';",
    );
    assert!(matches!(
        click(&env, scene.binding()).unwrap(),
        GraphOnlyClick::Allowed(_)
    ));
}

#[test]
fn d1_a_click_needs_a_read_transaction() {
    let env = fixture();
    place_real(&env, "b1");
    let scene = eligible(disclose(&env, &["b1"]));
    let workspace = workspace(&env);
    let query = query(&env);
    let result = env.with_conn(|conn| {
        Ok(requalify_graph_only_scene_disclosure(
            conn,
            &workspace,
            &query,
            scene.binding(),
            &mut Path::yes(),
            &mut || Ok(()),
        ))
    });
    assert!(result.is_err());
}

// ---- D2: a change between the response and the click ---------------------------------------

#[test]
fn d2_a_change_after_the_response_refuses_the_click_and_putting_it_back_does_not_help() {
    type Change = Box<dyn Fn(&Env)>;
    const LATER: &str = "2026-10-19T09:00:00.000Z";
    let bump = |extra: &str| {
        format!(
            "UPDATE tree_nodes SET {extra} version = version + 1, updated_at = '{LATER}' WHERE id = 'b1';"
        )
    };
    let changes: Vec<(&str, Change)> = vec![
        (
            "the same body saved again",
            Box::new(move |env| execute(env, &bump(""))),
        ),
        (
            "a new title",
            Box::new(move |env| execute(env, &bump("title = 'Changed',"))),
        ),
        (
            "a new title and back to the old one",
            Box::new(move |env| {
                execute(
                    env,
                    &format!(
                        "UPDATE tree_nodes SET title = 'B', version = version + 1, updated_at = '{LATER}' WHERE id = 'b1';
                         UPDATE tree_nodes SET title = 'Title of b1', version = version + 1, updated_at = '2026-10-19T09:00:01.000Z' WHERE id = 'b1';"
                    ),
                )
            }),
        ),
        (
            "a new body",
            Box::new(|env| {
                execute(
                    env,
                    "UPDATE tree_nodes SET content = '{\"type\":\"doc\",\"content\":[]}', version = version + 1 WHERE id = 'b1';",
                )
            }),
        ),
        (
            "A1 changed",
            Box::new(|env| set_a1(env.db().db(), PROJECT, "b1", false)),
        ),
        (
            "the Scene archived",
            Box::new(|env| {
                execute(
                    env,
                    "UPDATE tree_nodes SET archived_at = '2026-10-19 00:00:00' WHERE id = 'b1';",
                )
            }),
        ),
        (
            "the Scene under an archived folder",
            Box::new(|env| {
                execute(
                    env,
                    "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, content, archived_at)
                       VALUES ('fold', 'p1', NULL, 'folder', 'Folder', 'z', '{}', '2026-10-19 00:00:00');
                     UPDATE tree_nodes SET parent_id = 'fold' WHERE id = 'b1';",
                )
            }),
        ),
        (
            "the Scene deleted",
            Box::new(|env| {
                execute(
                    env,
                    "DELETE FROM scene_codex_pins WHERE scene_id = 'b1';
                     DELETE FROM tree_nodes WHERE id = 'b1';",
                )
            }),
        ),
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
            "the same declaration made again",
            Box::new(|env| {
                place_real(env, "b1");
            }),
        ),
        (
            "a secret record added",
            Box::new(|env| {
                execute(
                    env,
                    "UPDATE tree_nodes SET pov_character_id = 'c1' WHERE id = 'b1';",
                )
            }),
        ),
        (
            "the pin moved",
            Box::new(|env| {
                execute(
                    env,
                    "DELETE FROM scene_codex_pins WHERE scene_id = 'b1';
                     INSERT INTO scene_codex_pins (scene_id, entry_id, created_at)
                       VALUES ('b1', 'c1', '2026-10-19T05:00:00Z');",
                )
            }),
        ),
        (
            "the workspace quarantined",
            Box::new(|env| quarantine_scene_body_declaration_workspace_for_test(&env.snapshot())),
        ),
    ];
    for (name, change) in changes {
        let env = fixture();
        place_real(&env, "b1");
        let scene = eligible(disclose(&env, &["b1"]));
        assert!(
            matches!(
                click(&env, scene.binding()).unwrap(),
                GraphOnlyClick::Allowed(_)
            ),
            "{name}: allowed before the change"
        );
        change(&env);
        assert_refused(&env, scene.binding(), name);
        // The old binding sent again does not rescue it.
        assert_refused(&env, scene.binding(), name);
    }
}

#[test]
fn d2_a_binding_for_another_workspace_or_query_is_refused() {
    let env = fixture();
    place_real(&env, "b1");
    let scene = eligible(disclose(&env, &["b1"]));
    type Tamper = Box<dyn Fn(&mut GraphOnlySceneBinding)>;
    let cases: Vec<(&str, Tamper)> = vec![
        (
            "workspace id",
            Box::new(|binding| binding.workspace_id = "another".into()),
        ),
        (
            "locator digest",
            Box::new(|binding| binding.canonical_locator_digest = test_digest('7')),
        ),
        (
            "query Scene",
            Box::new(|binding| binding.query_scene_id = "b2".into()),
        ),
        (
            "authority revision",
            Box::new(|binding| binding.authority_revision_token = "old".into()),
        ),
        (
            "excerpt digest",
            Box::new(|binding| binding.body.excerpt_digest = test_digest('8')),
        ),
        ("range", Box::new(|binding| binding.body.end_utf16 += 1)),
        (
            "declaration id",
            Box::new(|binding| binding.declaration_id = Uuid::new_v4().to_string()),
        ),
    ];
    for (name, tamper) in cases {
        let mut binding = scene.binding().clone();
        tamper(&mut binding);
        assert_refused(&env, &binding, name);
    }
}

#[test]
fn d2_the_path_is_asked_again_at_the_click() {
    let env = fixture();
    place_real(&env, "b1");
    let scene = eligible(disclose(&env, &["b1"]));
    let mut path = Path::yes();
    assert!(matches!(
        click_with(&env, scene.binding(), &mut path).unwrap(),
        GraphOnlyClick::Allowed(_)
    ));
    assert_eq!(path.calls, ["b1"]);
    let mut refusing = Path::yes().answering("b1", super::tests::Answer::No);
    assert!(matches!(
        click_with(&env, scene.binding(), &mut refusing).unwrap(),
        GraphOnlyClick::Refused(_)
    ));
}

// ---- D3: the refusal is one closed value -------------------------------------------------------

#[test]
fn d3_every_refusal_is_the_same_value_and_names_nothing() {
    let env = fixture();
    place_real(&env, "b1");
    let scene = eligible(disclose(&env, &["b1"]));
    let mut other = scene.binding().clone();
    other.body.end_utf16 += 1;
    let mut seen = Vec::new();
    seen.push(click(&env, &other).unwrap());
    execute(&env, "DELETE FROM scene_codex_pins WHERE scene_id = 'b1';");
    seen.push(click(&env, scene.binding()).unwrap());
    for refusal in &seen {
        let GraphOnlyClick::Refused(refusal) = refusal else {
            panic!("refused expected");
        };
        assert_eq!(refusal.code(), "graph-scene-revalidation-failed");
        assert_eq!(format!("{refusal:?}"), "GraphSceneRevalidationRefused");
    }
    assert_ne!(
        GraphSceneRevalidationRefused.code(),
        NotAppended.code(),
        "the click is a different path from the response"
    );
}

// ---- D4: the click stands alone -------------------------------------------------------------------

#[test]
fn d4_a_click_does_not_read_the_change_feed() {
    let env = fixture();
    place_real(&env, "b1");
    let scene = eligible(disclose(&env, &["b1"]));
    restrict(&env, |action| {
        matches!(action, rusqlite::hooks::AuthAction::Read { table_name, .. }
            if table_name.contains("change") || table_name.contains("feed"))
    });
    let result = click(&env, scene.binding());
    unrestrict(&env);
    assert!(matches!(result.unwrap(), GraphOnlyClick::Allowed(_)));
}

// ---- cancel and deadline -----------------------------------------------------------------------------

#[test]
fn a_checkpoint_that_fails_anywhere_is_an_error_and_makes_no_partial_result() {
    let env = fixture();
    place_real(&env, "b1");
    let candidates = associations(&env, &["b1"]);
    let mut stopped_at = 0;
    for stop_on in 1..200 {
        let mut calls = 0;
        let mut check = || {
            calls += 1;
            if calls == stop_on {
                anyhow::bail!("cancelled by the caller")
            }
            Ok(())
        };
        let result = disclose_with(&env, &candidates, &mut Path::yes(), &mut check);
        match result {
            Err(error) => {
                assert!(format!("{error:#}").contains("cancelled by the caller"));
                stopped_at = stop_on;
            }
            Ok(disclosure) => {
                assert!(matches!(disclosure, GraphOnlySceneDisclosure::Eligible(_)));
                break;
            }
        }
    }
    assert!(stopped_at > 10, "the body step has checkpoints of its own");
    let totals: BTreeMap<_, _> = local_counts().into_iter().collect();
    assert_eq!(
        totals.get("disclosed"),
        Some(&1),
        "only the run that was not stopped disclosed"
    );
}

#[test]
fn a_click_whose_checkpoint_fails_is_an_error() {
    let env = fixture();
    place_real(&env, "b1");
    let scene = eligible(disclose(&env, &["b1"]));
    let workspace = workspace(&env);
    let query = query(&env);
    for stop_on in [1, 5, 12] {
        let mut calls = 0;
        let result = env.db().db().with_read_transaction(|conn| {
            requalify_graph_only_scene_disclosure(
                conn,
                &workspace,
                &query,
                scene.binding(),
                &mut Path::yes(),
                &mut || {
                    calls += 1;
                    if calls == stop_on {
                        anyhow::bail!("deadline")
                    }
                    Ok(())
                },
            )
        });
        assert!(result.is_err(), "stop on checkpoint {stop_on}");
    }
}

// ---- K1b measurement (DR-CB4-14) ------------------------------------------------------------------

/// Not part of the normal run: `cargo test --release ... measure_ -- --ignored
/// --nocapture`. Eight candidates; the first seven pass everything except the
/// veto (a Scene POV, found late), the eighth is declared with the largest body
/// the limits admit. Prints how long the whole response and the click take.
#[test]
#[ignore = "K1b measurement; run in release with --ignored --nocapture"]
fn measure_graph_only_scene_timings() {
    use std::time::Instant;
    let env = fixture();
    let mut scenes = vec!["b1", "b2", "b3"];
    for index in 4..=8 {
        let id: &'static str = Box::leak(format!("b{index}").into_boxed_str());
        super::tests::add_scene(&env, id, None, true);
        add_pin(&env, id, &format!("2026-10-19T00:01:0{index}Z"));
        scenes.push(id);
    }
    let long = |paragraphs: usize| {
        crate::narrative_extraction::scene_body_declaration::writer_support_tests::long_body(
            paragraphs, 170,
        )
    };
    let target = "b8";
    let (mut low, mut high) = (1usize, 400usize);
    while low < high {
        let middle = (low + high).div_ceil(2);
        set_content(&env, target, &long(middle));
        if try_place_real(&env, target, |_| {}).is_ok() {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    set_content(&env, target, &long(low));
    place_real(&env, target);
    let bytes = long(low).len();
    for scene in &scenes[..7] {
        place_real(&env, scene);
        execute(
            &env,
            &format!("UPDATE tree_nodes SET pov_character_id = 'c1' WHERE id = '{scene}';"),
        );
    }
    let candidates = associations(&env, &scenes);
    let mut samples = Vec::new();
    let mut click_samples = Vec::new();
    for _ in 0..20 {
        let started = Instant::now();
        let result = disclose_with(&env, &candidates, &mut Path::yes(), &mut || Ok(())).unwrap();
        samples.push(started.elapsed());
        let scene = eligible(result);
        let started = Instant::now();
        assert!(matches!(
            click(&env, scene.binding()).unwrap(),
            GraphOnlyClick::Allowed(_)
        ));
        click_samples.push(started.elapsed());
    }
    samples.sort();
    click_samples.sort();
    println!(
        "body {bytes} bytes ({low} paragraphs), 8 candidates: response median {:?}, max {:?}; click median {:?}, max {:?} (includes building the query context)",
        samples[samples.len() / 2],
        samples[samples.len() - 1],
        click_samples[click_samples.len() / 2],
        click_samples[click_samples.len() - 1],
    );
}

#[test]
fn the_other_helpers_still_agree() {
    // `association` and `context` are used by the measurement below; keep the
    // imports honest when it is not built.
    let env = fixture();
    let _ = (association(&env, "b1"), context(&env));
    let _ = add_pin;
}
