//! S1-A2 (chat IR, c1): the per-proposal admission record of one qualified
//! query (`NirQualifiedBatch::proposal_admission`), the reverse lookup that
//! turns candidate Chronicle event ids into IR-excluded ones
//! (`read_chronicle_excluded_event_ids`), and the pin that recording the
//! verdicts leaves the Related Scenes `documents()` as they were.
//!
//! Two fixtures. The reviewed-child cold workspace has two proposals, both
//! sourced from S1 and read from S2 (so S1 is the "same Scene" case and a
//! candidate without an embedding can be made with the token-limit shape). The
//! three-window cold workspace has four proposals sourced from different
//! Scenes, so one query Scene splits them into admitted and not admitted.
use serde_json::Value;

use super::{
    multi_window_control_tests::{child, revision},
    test_support::Fixture,
    *,
};

/// Publish the whole current pool. `skip` names a revision that is published
/// without an embedding (the token-limit shape, `SkippedTokenLimit`).
fn publish_with_skip(f: &Fixture, skip: Option<&str>) {
    f.runtime.bind_embedding_generation(1).expect("generation");
    let (plan, docs) = f.prepare();
    let outcomes = docs
        .into_iter()
        .map(|doc| {
            let skipped = skip.is_some_and(|revision| revision == doc.revision_id);
            f.outcome(doc, skipped)
        })
        .collect();
    assert!(matches!(
        publish_chronicle_index_build(&f.db, &f.runtime, plan, outcomes).expect("publish"),
        NirIndexPublishRead::Published { .. }
    ));
}

fn qualified(f: &Fixture, scene: &str) -> NirQualifiedBatch {
    let read =
        f.db.with_conn_mut(|conn| {
            let mut tx = crate::scoped_tx::ScopedTransaction::begin(conn)?;
            qualify_chronicle_index_query(&mut tx, &f.runtime, f.project(), scene)
        })
        .expect("query snapshot");
    let NirQualifiedRead::Qualified(batch) = read else {
        panic!("usable query for {scene}");
    };
    batch
}

/// (revision id, evidence handle count, embedding bytes), in the batch's order.
fn shape(batch: &NirQualifiedBatch) -> Vec<(String, usize, usize)> {
    batch
        .documents()
        .iter()
        .map(|d| {
            (
                d.revision_id().to_owned(),
                d.evidence_handles().len(),
                d.embedding().len(),
            )
        })
        .collect()
}

fn proposal_of(f: &Fixture, revision: &str) -> String {
    f.db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT proposal_id FROM narrative_proposal_revisions WHERE id=?1",
            [revision],
            |r| r.get(0),
        )?)
    })
    .expect("proposal of the revision")
}

/// The `eventId` the proposal's CURRENT revision names.
fn event_of(f: &Fixture, proposal: &str) -> String {
    f.db.with_conn(|conn| {
        let payload: String = conn.query_row(
            "SELECT r.payload_json FROM narrative_proposals p
               JOIN narrative_proposal_revisions r ON r.id = p.current_revision_id
              WHERE p.id=?1",
            [proposal],
            |r| r.get(0),
        )?;
        let payload: Value = serde_json::from_str(&payload)?;
        Ok(payload["eventId"].as_str().expect("eventId").to_owned())
    })
    .expect("event id of the proposal")
}

fn excluded(f: &Fixture, batch: &NirQualifiedBatch, candidates: &[String]) -> Vec<String> {
    f.db.with_read_transaction(|conn| read_chronicle_excluded_event_ids(conn, batch, candidates))
        .expect("excluded event read")
}

fn ids(values: &[&String]) -> Vec<String> {
    values.iter().map(|v| (*v).clone()).collect()
}

/// R3. Recording the verdicts is not a behaviour change of `documents()`: ids,
/// order, evidence counts and stored vectors are the ones observed on the
/// unchanged tree (`7e7b6c43`) for the same fixture. A candidate without an
/// embedding stays out of `documents()` even though its admission is judged.
#[test]
fn the_admission_record_leaves_related_scenes_documents_unchanged() {
    let f = Fixture::new();
    let [first, second] = <[String; 2]>::try_from(
        f.manifest["revisionIds"]
            .as_array()
            .expect("revisionIds")
            .iter()
            .map(|v| v.as_str().expect("revision").to_owned())
            .collect::<Vec<_>>(),
    )
    .expect("two current children");
    assert_eq!(first, "d4a1ae2f-830d-440f-a1d8-de8854b1dc6b");
    assert_eq!(second, "3facfee3-8df0-4378-850c-2324291ca5f9");
    publish_with_skip(&f, None);
    let (s1, s2) = (
        f.manifest["s1"].as_str().expect("S1").to_owned(),
        f.manifest["s2"].as_str().expect("S2").to_owned(),
    );
    assert_eq!(
        shape(&qualified(&f, &s2)),
        vec![(first.clone(), 1, 8), (second.clone(), 1, 8)]
    );
    assert!(qualified(&f, &s1).documents().is_empty());

    let g = Fixture::new();
    publish_with_skip(&g, Some(&first));
    assert_eq!(
        shape(&qualified(&g, &s2)),
        vec![(second, 1, 8)],
        "a candidate without an embedding never enters documents()"
    );
}

/// R2. The verdict is the admission rule's, judged for every candidate and
/// keyed by proposal.
#[test]
fn a_qualified_query_records_each_proposals_admission_verdict() {
    let f = Fixture::new();
    let (s1, s2) = (
        f.manifest["s1"].as_str().expect("S1").to_owned(),
        f.manifest["s2"].as_str().expect("S2").to_owned(),
    );
    let revisions: Vec<String> = f.manifest["revisionIds"]
        .as_array()
        .expect("revisionIds")
        .iter()
        .map(|v| v.as_str().expect("revision").to_owned())
        .collect();
    let proposals: Vec<String> = revisions.iter().map(|r| proposal_of(&f, r)).collect();
    // The second proposal's document has no embedding.
    publish_with_skip(&f, Some(&revisions[1]));

    let later = qualified(&f, &s2);
    assert_eq!(later.documents().len(), 1);
    for proposal in &proposals {
        assert_eq!(
            later.proposal_admission(proposal),
            NirProposalAdmission::Admitted,
            "S2 reads S1's material; a missing embedding is not an exclusion"
        );
    }
    let same = qualified(&f, &s1);
    assert!(same.documents().is_empty());
    for proposal in &proposals {
        assert_eq!(
            same.proposal_admission(proposal),
            NirProposalAdmission::NotAdmitted,
            "the Scene the material comes from cannot read it, with or without a vector"
        );
    }
    assert_eq!(
        same.proposal_admission("not-a-proposal"),
        NirProposalAdmission::NotIndexed
    );
}

/// R2 (mixed). Different sources split one query: the earlier long scene is
/// readable from the folder's first Scene, the folder's own material is not,
/// and a source LATER than the query (not the same Scene) is not admitted
/// either. The folded two-Scene Event is never in the proof (one exact Scope
/// Scene cannot hold it), so no verdict is known for it: `NotIndexed`.
#[test]
fn one_query_splits_proposals_into_admitted_and_not_admitted() {
    let f = Fixture::multi_window();
    publish_with_skip(&f, None);
    let long_a = proposal_of(&f, &revision(&f, "long", "Harbour bell at dusk"));
    let long_b = proposal_of(&f, &revision(&f, "long", "Ledger seals at the gate"));
    let three_a = proposal_of(&f, &revision(&f, "three", "Writ delivered to the quay"));
    let folded = proposal_of(&f, &revision(&f, "three", "Signal fire on the quay"));
    let scenes = &f.manifest["scenes"];
    let (before, inside, after) = (
        scenes["before"].as_str().expect("before").to_owned(),
        scenes["three"][0].as_str().expect("inside").to_owned(),
        scenes["after"].as_str().expect("after").to_owned(),
    );
    let verdicts = |scene: &str| {
        let batch = qualified(&f, scene);
        [&long_a, &long_b, &three_a, &folded].map(|p| batch.proposal_admission(p))
    };
    use NirProposalAdmission::{Admitted as A, NotAdmitted as N, NotIndexed as X};
    assert_eq!(verdicts(&before), [N, N, N, X], "everything is later");
    assert_eq!(verdicts(&inside), [A, A, N, X], "the folder's own material");
    assert_eq!(verdicts(&after), [A, A, A, X], "everything else is earlier");
}

/// R4. The reverse lookup, end to end: candidate event ids -> proposals ->
/// the proof's verdict.
#[test]
fn candidate_events_are_excluded_by_their_proposals_verdict() {
    let f = Fixture::multi_window();
    publish_with_skip(&f, None);
    let long_a = proposal_of(&f, &revision(&f, "long", "Harbour bell at dusk"));
    let three_a = proposal_of(&f, &revision(&f, "three", "Writ delivered to the quay"));
    // Never in the proof (see the test above): d-i leaves its event alone.
    let folded = proposal_of(&f, &revision(&f, "three", "Signal fire on the quay"));
    let (e_long, e_a, e_b) = (
        event_of(&f, &long_a),
        event_of(&f, &three_a),
        event_of(&f, &folded),
    );
    assert_eq!(
        [&e_long, &e_a, &e_b]
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        3
    );
    let inside = f.manifest["scenes"]["three"][0].as_str().expect("inside");
    let after = f.manifest["scenes"]["after"].as_str().expect("after");
    let unknown = "event-of-nobody".to_owned();

    // From the folder's first Scene the folder's own event is excluded: once,
    // wherever it sits in the caller's order. The readable event, the event of
    // a proposal outside the proof (d-i) and a stranger are not excluded.
    let batch = qualified(&f, inside);
    let candidates = vec![
        e_a.clone(),
        e_long.clone(),
        unknown.clone(),
        e_b.clone(),
        e_a.clone(),
    ];
    assert_eq!(excluded(&f, &batch, &candidates), ids(&[&e_a]));
    // The result is a subset of the candidates, in the caller's order.
    assert!(excluded(&f, &batch, &ids(&[&e_long, &e_b, &unknown])).is_empty());
    // Earlier than all material: every event of the proof is excluded.
    let before = f.manifest["scenes"]["before"].as_str().expect("before");
    let batch = qualified(&f, before);
    assert_eq!(
        excluded(&f, &batch, &ids(&[&e_b, &e_a, &unknown, &e_long])),
        ids(&[&e_a, &e_long])
    );
    // From after everything nothing the proof holds is excluded.
    let batch = qualified(&f, after);
    assert!(excluded(&f, &batch, &ids(&[&e_long, &e_a, &e_b])).is_empty());

    // No candidates: nothing is read, not even a table (this connection has
    // none, and is not in a transaction).
    let bare = rusqlite::Connection::open_in_memory().expect("bare connection");
    assert!(read_chronicle_excluded_event_ids(&bare, &batch, &[])
        .expect("empty input")
        .is_empty());
    // A non-empty input does read, and needs the caller's transaction.
    assert!(read_chronicle_excluded_event_ids(&bare, &batch, &ids(&[&e_a])).is_err());
}

/// R4 (d-i). A proposal that is not in the proof is NOT excluded: the IR rule
/// only excludes what its own admission judged.
#[test]
fn a_proposal_outside_the_proof_is_not_excluded() {
    let f = Fixture::new();
    let revisions: Vec<String> = f.manifest["revisionIds"]
        .as_array()
        .expect("revisionIds")
        .iter()
        .map(|v| v.as_str().expect("revision").to_owned())
        .collect();
    let (held, kept) = (
        proposal_of(&f, &revisions[0]),
        proposal_of(&f, &revisions[1]),
    );
    let (e_held, e_kept) = (event_of(&f, &held), event_of(&f, &kept));
    // Withdrawn before the build: not approved, so never in the proof.
    f.hold(&revisions[0]);
    publish_with_skip(&f, None);
    // S1 is the Scene both proposals come from: it reads neither.
    let batch = qualified(&f, f.manifest["s1"].as_str().expect("S1"));
    assert_eq!(
        batch.proposal_admission(&held),
        NirProposalAdmission::NotIndexed
    );
    assert_eq!(
        batch.proposal_admission(&kept),
        NirProposalAdmission::NotAdmitted
    );
    assert_eq!(
        excluded(&f, &batch, &ids(&[&e_held, &e_kept])),
        ids(&[&e_kept])
    );
}

/// Make `proposal`'s current revision a new one whose payload names
/// `event_id` (raw writes: the writers refuse an edited `eventId`, and the
/// lookup reads whatever the current revision's payload says).
fn repoint_current_revision(f: &Fixture, proposal: &str, event_id: &str) {
    f.db.with_conn(|conn| {
        let (current, payload): (String, String) = conn.query_row(
            "SELECT r.id, r.payload_json FROM narrative_proposals p
               JOIN narrative_proposal_revisions r ON r.id = p.current_revision_id
              WHERE p.id=?1",
            [proposal],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let mut payload: Value = serde_json::from_str(&payload)?;
        payload["eventId"] = Value::String(event_id.to_owned());
        let id = format!("repointed-{proposal}");
        // Everything but the payload and the number is the current row's.
        conn.execute(
            "INSERT INTO narrative_proposal_revisions
               (id, proposal_id, revision_number, payload_json, plan_fragment_json,
                plan_fragment_digest, origin_kind, reconciliation_envelope_json,
                reconciliation_envelope_digest, created_at, created_by)
             SELECT ?1, proposal_id, revision_number + 1000, ?2, plan_fragment_json,
                    plan_fragment_digest, origin_kind, reconciliation_envelope_json,
                    reconciliation_envelope_digest, created_at, created_by
               FROM narrative_proposal_revisions WHERE id = ?3",
            rusqlite::params![id, payload.to_string(), current],
        )?;
        conn.execute(
            "UPDATE narrative_proposals SET current_revision_id=?1 WHERE id=?2",
            rusqlite::params![id, proposal],
        )?;
        Ok(())
    })
    .expect("repoint the current revision");
}

/// R4 (proof wins). The verdict belongs to the proposal the proof judged. A
/// current revision that moved after the build neither hides the proposal
/// (`NotIndexed`) nor lets a stricter verdict be lost when one event id is
/// named by two proposals (the strict one wins).
#[test]
fn the_lookup_classifies_by_proposal_when_the_current_revision_moves() {
    let f = Fixture::multi_window();
    publish_with_skip(&f, None);
    let long_a = proposal_of(&f, &revision(&f, "long", "Harbour bell at dusk"));
    let three_a_rev = revision(&f, "three", "Writ delivered to the quay");
    let three_a = proposal_of(&f, &three_a_rev);
    let (e_long, e_a) = (event_of(&f, &long_a), event_of(&f, &three_a));
    let inside = f.manifest["scenes"]["three"][0].as_str().expect("inside");
    let batch = qualified(&f, inside);
    assert_eq!(
        batch.proposal_admission(&three_a),
        NirProposalAdmission::NotAdmitted
    );

    // The proof's proposal gets a newer current revision (same event id).
    let moved = child(&f, &three_a_rev, |_| {});
    assert_ne!(moved, three_a_rev);
    assert_eq!(event_of(&f, &three_a), e_a);
    assert_eq!(
        excluded(&f, &batch, &ids(&[&e_a, &e_long])),
        ids(&[&e_a]),
        "classified by the proof's verdict for the proposal, not by revision id"
    );

    // The readable proposal now names the not-admitted proposal's event too:
    // one event id, two proposals, one of them not admitted.
    repoint_current_revision(&f, &long_a, &e_a);
    assert_eq!(event_of(&f, &long_a), e_a);
    assert_eq!(
        batch.proposal_admission(&long_a),
        NirProposalAdmission::Admitted
    );
    assert_eq!(excluded(&f, &batch, &ids(&[&e_a])), ids(&[&e_a]));
    // The id it used to name is nobody's current event now.
    assert!(excluded(&f, &batch, &ids(&[&e_long])).is_empty());
}

/// R4 (project). The lookup reads the batch's project only: an event id that
/// a proposal of another project names matches nothing, even if that proposal
/// is in the proof.
#[test]
fn candidate_events_of_another_project_do_not_match() {
    let f = Fixture::new();
    publish_with_skip(&f, None);
    let revisions: Vec<String> = f.manifest["revisionIds"]
        .as_array()
        .expect("revisionIds")
        .iter()
        .map(|v| v.as_str().expect("revision").to_owned())
        .collect();
    let events: Vec<String> = revisions
        .iter()
        .map(|r| event_of(&f, &proposal_of(&f, r)))
        .collect();
    // S1 is the Scene both proposals come from: it reads neither.
    let batch = qualified(&f, f.manifest["s1"].as_str().expect("S1"));
    assert_eq!(excluded(&f, &batch, &events), events);

    // The same proposals, now owned by another project.
    f.db.with_conn(|conn| {
        conn.execute("INSERT INTO projects (id) VALUES ('another-project')", [])?;
        conn.execute(
            "UPDATE narrative_proposal_sets SET project_id = 'another-project'",
            [],
        )?;
        Ok(())
    })
    .expect("move the proposals to another project");
    assert!(
        excluded(&f, &batch, &events).is_empty(),
        "another project's events are not this project's"
    );
}
