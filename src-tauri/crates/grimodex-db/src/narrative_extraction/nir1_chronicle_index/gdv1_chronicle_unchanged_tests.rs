//! GDV/1 (contract revision 6, section 8): a project that has only a Chronicle
//! binding is not changed by the Graph's recognized-not-current handling. The
//! parity test uses APIs that exist before GDV/1; its `EXPECTED` was captured on
//! the base build and the same file passes on both.
use super::{test_support::Fixture, *};
use crate::narrative_extraction::{
    nir1_entity_relation_index::{
        classify_graph_binding_with_control, GraphBindingClass, NeverStopGraphWorkControl,
    },
    restore_rebuild as rr,
    source_revision::ForegroundValidationControl,
};

fn published() -> Fixture {
    let f = Fixture::new();
    let (plan, docs) = f.prepare();
    let outcomes = f.outcomes(docs);
    publish_chronicle_index_build(&f.db, &f.runtime, plan, outcomes).expect("publish");
    f
}

fn prefix(text: &str) -> String {
    text.chars().take(70).collect()
}

fn observe(f: &Fixture) -> Vec<String> {
    let project = f.project();
    let report = f
        .db
        .with_conn_mut(|conn| rr::verify_narrative_dependency_graph_for_project(conn, project))
        .map(|report| {
            let value = serde_json::to_value(&report).expect("report json");
            let len = |key: &str| value[key].as_array().map(Vec::len).unwrap_or(0);
            format!(
                "unresolvable={} missingSource={} staleDeps={} rebuildRequired={} clean={} keys={}",
                len("edgeIdsWithUnresolvableConsumerScope"),
                len("edgeIdsWithMissingSource"),
                len("consumerKeysWithStaleDependencySetDigest"),
                value["rebuildRequired"],
                report.is_clean(),
                value.as_object().map(|object| object.len()).unwrap_or(0),
            )
        })
        .unwrap_or_else(|error| format!("ERR {}", prefix(&format!("{error:#}"))));
    let uncontrolled = f
        .db
        .with_conn_mut(|conn| rr::durable_graph_state_digest(conn, project))
        .map(|_| "Ok".to_string())
        .unwrap_or_else(|error| format!("ERR {}", prefix(&format!("{error:#}"))));
    let foreground = f
        .db
        .with_conn_mut(|conn| {
            let mut tx = crate::scoped_tx::ScopedTransaction::begin(conn)?;
            let mut control = ForegroundValidationControl;
            Ok(rr::durable_graph_state_digest_with_control(&mut tx, project, &mut control).is_ok())
        })
        .expect("foreground digest");
    vec![
        format!("verify report: {report}"),
        format!("digest uncontrolled: {uncontrolled}"),
        format!("digest foreground ok: {foreground}"),
    ]
}

const EXPECTED: &[&str] = &[
    "verify report: unresolvable=0 missingSource=0 staleDeps=0 rebuildRequired=false clean=true keys=22",
    "digest uncontrolled: ERR NEX_VALIDATION_TERMINATED:context-unavailable: Chronicle eligibility r",
    "digest foreground ok: true",
];

#[test]
fn a_chronicle_only_project_is_unchanged() {
    let f = published();
    let lines = observe(&f);
    for line in &lines {
        eprintln!("GDV1_UNCHANGED {line}");
    }
    assert_eq!(lines, EXPECTED);
}

/// The Graph helper sees no Graph binding in a Chronicle-only project.
#[test]
fn a_chronicle_only_project_has_no_graph_binding() {
    let f = published();
    let class = f
        .db
        .with_conn_mut(|conn| {
            let mut control = NeverStopGraphWorkControl;
            classify_graph_binding_with_control(conn, f.project(), &mut control)
        })
        .expect("classify");
    assert_eq!(class, GraphBindingClass::Absent);
}
