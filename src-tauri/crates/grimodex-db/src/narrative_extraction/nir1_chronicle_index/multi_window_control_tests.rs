//! MW/1 (DR-MW-8): proposals the query Scene may not read, mixed into a
//! three-window workspace, never change what the others return. The real
//! prepare, publish and qualify path runs twice, on the cold workspace and on a
//! copy where proposals are made unavailable with the production writers.
//!
//! What is compared is what the Native side hands to scoring: the qualified
//! documents (id, order, stored vector, statement) and each evidence handle's
//! Scene, id and excerpt. The cosine score, the rank and the fusion slot are
//! computed from exactly these by the semantic runtime and the ranking policy
//! of `grimodex-node` (a real embedding model), so they are not computed here.
use serde_json::{json, Value};

use super::{test_support::Fixture, *};
use crate::narrative_extraction::{
    narrative_extraction_append_human_decision,
    narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization_auto,
    run_incremental_freshness_cycle, AppendDecisionPayload, CreateHumanDerivedRevisionRequest,
    IncrementalFreshnessCycleOutcome, NarrativeAdapterIdentity,
};

/// What one qualified document is: its proposal, the stored vector, the
/// statement and every evidence handle's Scene, id and excerpt, in order.
type Row = (String, Vec<u8>, String, Vec<(String, String, String)>);

fn revision(f: &Fixture, shape: &str, title: &str) -> String {
    f.manifest["runs"][shape]["proposals"]
        .as_array()
        .expect("proposals")
        .iter()
        .find(|p| p["title"] == title)
        .expect("proposal")["revisionId"]
        .as_str()
        .expect("current child")
        .to_owned()
}

fn child(f: &Fixture, parent: &str, edit: impl FnOnce(&mut Value)) -> String {
    let (proposal, digest, payload): (String, String, String) =
        f.db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT proposal_id, reconciliation_envelope_digest, payload_json
                   FROM narrative_proposal_revisions WHERE id=?1",
                [parent],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?)
        })
        .expect("parent");
    let mut payload: Value = serde_json::from_str(&payload).expect("payload");
    edit(&mut payload);
    let saved =
        narrative_extraction_create_human_derived_revision_with_c2b_projection_materialization_auto(
            &f.db,
            f.project(),
            CreateHumanDerivedRevisionRequest {
                proposal_id: proposal,
                expected_current_revision_id: parent.to_owned(),
                parent_revision_id: parent.to_owned(),
                expected_parent_envelope_digest: digest,
                proposal_payload: payload,
                adapter: NarrativeAdapterIdentity {
                    id: "chronicle.scene-event".to_owned(),
                    version: "1".to_owned(),
                },
                surface_id: "chronicle-review".to_owned(),
            },
        )
        .expect("production child creation");
    saved["revisionId"].as_str().expect("child").to_owned()
}

fn approve(f: &Fixture, run: &str, revision: &str) {
    let proposal: String =
        f.db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT proposal_id FROM narrative_proposal_revisions WHERE id=?1",
                [revision],
                |r| r.get(0),
            )?)
        })
        .expect("proposal");
    narrative_extraction_append_human_decision(
        &f.db,
        AppendDecisionPayload {
            run_id: run.to_owned(),
            project_id: f.project().to_owned(),
            proposal_id: proposal,
            revision_id: revision.to_owned(),
            decision: "approved".to_owned(),
            decision_json: Some(json!({"probableDuplicateChoice":"create-as-new"})),
            created_by: Some("nir1-control-test".to_owned()),
        },
    )
    .expect("production Human decision");
}

fn drain(f: &Fixture) {
    for _ in 0..8 {
        match run_incremental_freshness_cycle(&f.db).expect("Freshness cycle") {
            IncrementalFreshnessCycleOutcome::Processed(_) => {}
            IncrementalFreshnessCycleOutcome::Idle => return,
            IncrementalFreshnessCycleOutcome::Held(_) => panic!("fixture cannot be held"),
        }
    }
    panic!("Feed did not drain");
}

/// The one path a query takes: prepare the whole pool, publish it, qualify it
/// for `scene`. The proposals the query Scene may read, in qualified order.
fn qualified(f: &Fixture, scenes: &[&str]) -> Vec<Vec<Row>> {
    f.runtime.bind_embedding_generation(1).expect("generation");
    let (plan, docs) = f.prepare();
    assert!(matches!(
        publish_chronicle_index_build(&f.db, &f.runtime, plan, f.outcomes(docs)).expect("publish"),
        NirIndexPublishRead::Published { .. }
    ));
    f.db.with_read_transaction(|conn| {
        let mut out = vec![];
        for scene in scenes {
            let NirQualifiedRead::Qualified(batch) =
                qualify_chronicle_index_query(conn, &f.runtime, f.project(), scene)?
            else {
                panic!("the index must qualify for {scene}")
            };
            out.push(
                batch
                    .documents()
                    .iter()
                    .map(|document| {
                        (
                            document.revision_id().to_owned(),
                            document.embedding().to_vec(),
                            document.document().serialized_statement.clone(),
                            document
                                .evidence_handles()
                                .iter()
                                .map(|e| {
                                    (
                                        e.scene_id().to_owned(),
                                        e.evidence_id().to_owned(),
                                        e.excerpt(),
                                    )
                                })
                                .collect(),
                        )
                    })
                    .collect(),
            );
        }
        Ok(out)
    })
    .expect("qualified read")
}

fn only(rows: &[Row], keep: &[&String]) -> Vec<Row> {
    rows.iter()
        .filter(|row| keep.contains(&&row.0))
        .cloned()
        .collect()
}

/// How a proposal is made unavailable to the query Scene with the production
/// writers: an approved child that is secret, or a non-secret child nobody approved.
#[derive(Clone, Copy)]
enum Unavailable {
    SecretApproved,
    Unapproved,
}

/// The cold workspace with `proposals` made unavailable.
fn mixed(proposals: &[(&String, Unavailable)]) -> (Fixture, Vec<String>) {
    let f = Fixture::multi_window();
    let mut replacements = vec![];
    for (parent, how) in proposals {
        let run = if ["Writ delivered to the quay", "Signal fire on the quay"]
            .iter()
            .any(|t| &revision(&f, "three", t) == *parent)
        {
            "three"
        } else {
            "long"
        };
        let run_id = f.manifest["runs"][run]["runId"]
            .as_str()
            .expect("run")
            .to_owned();
        let secret = child(&f, parent, |payload| {
            assert_eq!(payload["disclosure"]["secret"], false);
            payload["disclosure"]["secret"] = json!(true);
        });
        match how {
            Unavailable::SecretApproved => {
                approve(&f, &run_id, &secret);
                replacements.push(secret);
            }
            Unavailable::Unapproved => {
                let plain = child(&f, &secret, |payload| {
                    payload["disclosure"]["secret"] = json!(false);
                });
                replacements.push(plain);
            }
        }
    }
    drain(&f);
    (f, replacements)
}

#[test]
fn proposals_the_query_may_not_read_do_not_change_what_the_others_return() {
    let control = Fixture::multi_window();
    let long_a = revision(&control, "long", "Harbour bell at dusk");
    let long_b = revision(&control, "long", "Ledger seals at the gate");
    let three_a = revision(&control, "three", "Writ delivered to the quay");
    // The folder Run's other proposal folds the evidence of two Scenes into one
    // Event: one exact Scope Scene cannot hold it, so the control never returns
    // it. It is only asserted absent; making it unavailable would check nothing.
    let three_b = revision(&control, "three", "Signal fire on the quay");
    let after = control.manifest["scenes"]["after"].as_str().expect("after");
    let inside = control.manifest["scenes"]["three"][0]
        .as_str()
        .expect("first Scene of the folder");

    // Control: the cold workspace, as extracted and approved.
    let [all, from_inside] =
        <[Vec<Row>; 2]>::try_from(qualified(&control, &[after, inside])).expect("two queries");
    assert_eq!(
        all.iter().map(|r| r.0.as_str()).collect::<Vec<_>>(),
        vec![long_a.as_str(), three_a.as_str(), long_b.as_str()],
        "every other proposal is readable after the folders"
    );
    assert!(all.iter().all(|row| !row.3.is_empty() && row.0 != three_b));
    assert_eq!(
        from_inside,
        only(&all, &[&long_a, &long_b]),
        "the folder's own Scene reads only the earlier material"
    );
    assert_eq!(from_inside.len(), 2);

    // Mixed 1: two proposals the control returns become unavailable, one a
    // secret approved child and the other an unapproved child.
    let (one, replaced) = mixed(&[
        (&three_a, Unavailable::SecretApproved),
        (&long_a, Unavailable::Unapproved),
    ]);
    let result = qualified(&one, &[after]).remove(0);
    assert!(
        result
            .iter()
            .all(|row| ![&three_a, &long_a].contains(&&row.0) && !replaced.contains(&row.0)),
        "an unavailable proposal is never returned"
    );
    assert_eq!(
        result,
        only(&all, &[&long_b]),
        "the ids, the order, the vectors, the statements and the evidence of the others"
    );

    // Mixed 2: one of the long scene's proposals becomes unapproved.
    let (two, replaced) = mixed(&[(&long_b, Unavailable::Unapproved)]);
    let result = qualified(&two, &[after]).remove(0);
    assert!(result
        .iter()
        .all(|row| row.0 != long_b && !replaced.contains(&row.0)));
    assert_eq!(result, only(&all, &[&long_a, &three_a]));
}
