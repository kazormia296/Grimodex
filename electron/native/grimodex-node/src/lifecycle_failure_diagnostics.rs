//! Failure-only, values-only records in the existing main-process stderr.
//! E = returned error, P = observed panic, J = non-panic worker JoinError.
//! Codes intentionally avoid error-class prose: adding evidence must not
//! change the product-journey stderr verdict for an existing lifecycle retry.
use std::io::Write;

use grimodex_db::state::DbLifecycleRejectionSite;
use grimodex_db::workspace_lifecycle::LifecycleDiagnostic;
use serde::Serialize;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Producer {
    ManualMaintenance,
    Foreground,
    Freshness,
    AutomaticMaintenance,
    TimelapseAppend,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub(super) enum FailureClass {
    #[serde(rename = "E")]
    Error,
    #[serde(rename = "P")]
    Panic,
    #[serde(rename = "J")]
    Join,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    version: u8,
    pid: u32,
    timestamp_ms: u128,
    producer: Producer,
    cause: FailureClass,
    boundary: &'static str,
    site: Option<DbLifecycleRejectionSite>,
    #[serde(flatten)]
    evidence: LifecycleDiagnostic,
}

fn record(
    producer: Producer,
    cause: FailureClass,
    boundary: &'static str,
    site: Option<DbLifecycleRejectionSite>,
    evidence: LifecycleDiagnostic,
) -> Record {
    Record {
        version: 1,
        pid: std::process::id(),
        timestamp_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0),
        producer,
        cause,
        boundary,
        site,
        evidence,
    }
}

fn write_record(record: Record, writer: &mut impl Write) {
    if let Ok(json) = serde_json::to_string(&record) {
        // A failed diagnostic write never changes the original operation.
        let _ = writeln!(writer, "[workspace-lifecycle-diag] {json}");
    }
}

pub(super) fn handoff(producer: Producer, cause: FailureClass, evidence: LifecycleDiagnostic) {
    write_record(
        record(producer, cause, "handoff", None, evidence),
        &mut std::io::stderr().lock(),
    );
}

pub(super) fn append_rejected(site: DbLifecycleRejectionSite, evidence: LifecycleDiagnostic) {
    write_record(
        record(
            Producer::TimelapseAppend,
            FailureClass::Error,
            "append-rejected",
            Some(site),
            evidence,
        ),
        &mut std::io::stderr().lock(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use grimodex_db::workspace_lifecycle::{
        DiagnosticLifecycleState, OperationId, RecoveryDescriptorId, RecoveryDescriptorOwner,
    };

    #[test]
    fn records_have_only_fixed_classifications_and_safe_lifecycle_values() {
        let evidence = LifecycleDiagnostic {
            revision: 7,
            compatibility_switching: None,
            projected_state: None,
            state: DiagnosticLifecycleState::RecoveryRequired,
            shutdown_requested: false,
            descriptor_id: Some(RecoveryDescriptorId::new(3)),
            owner: Some(RecoveryDescriptorOwner::Maintenance),
            root_operation_id: Some(OperationId::new(2)),
        };
        for (class, expected) in [
            (FailureClass::Error, "E"),
            (FailureClass::Panic, "P"),
            (FailureClass::Join, "J"),
        ] {
            let mut bytes = Vec::new();
            write_record(
                record(Producer::Freshness, class, "handoff", None, evidence),
                &mut bytes,
            );
            let line = String::from_utf8(bytes).expect("UTF-8");
            let json: serde_json::Value = serde_json::from_str(
                line.trim()
                    .strip_prefix("[workspace-lifecycle-diag] ")
                    .expect("prefix"),
            )
            .expect("JSON");
            assert_eq!(json["cause"], expected);
            assert_eq!(json["descriptorId"], 3);
            assert_eq!(json["rootOperationId"], 2);
            assert_eq!(json["revision"], 7);
            assert_eq!(json["state"], "recovery-required");
            let mut keys: Vec<_> = json
                .as_object()
                .expect("record")
                .keys()
                .map(String::as_str)
                .collect();
            keys.sort();
            assert_eq!(
                keys,
                [
                    "boundary",
                    "cause",
                    "descriptorId",
                    "owner",
                    "pid",
                    "producer",
                    "revision",
                    "rootOperationId",
                    "shutdownRequested",
                    "site",
                    "state",
                    "timestampMs",
                    "version"
                ]
            );
            assert!(!line.contains('/'));
        }
    }

    #[test]
    fn unavailable_stderr_does_not_replace_the_operation_outcome() {
        struct Unavailable;
        impl Write for Unavailable {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let evidence = LifecycleDiagnostic {
            revision: 1,
            compatibility_switching: None,
            projected_state: None,
            state: DiagnosticLifecycleState::Closed,
            shutdown_requested: true,
            descriptor_id: None,
            owner: None,
            root_operation_id: None,
        };
        write_record(
            record(
                Producer::TimelapseAppend,
                FailureClass::Error,
                "append-rejected",
                Some(DbLifecycleRejectionSite::DatabaseParticipant),
                evidence,
            ),
            &mut Unavailable,
        );
    }
}
