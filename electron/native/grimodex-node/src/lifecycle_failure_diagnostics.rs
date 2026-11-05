//! Failure-only, values-only records in the existing main-process stderr.
//! E = returned error, P = observed panic, J = non-panic worker JoinError,
//! D = a recovery-pump exit that deferred (not an error).
//! Codes intentionally avoid error-class prose: adding evidence must not
//! change the product-journey stderr verdict for an existing lifecycle retry.
use std::io::Write;
use std::sync::Mutex;

use grimodex_db::state::DbLifecycleRejectionSite;
use grimodex_db::workspace_lifecycle::{
    LifecycleDiagnostic, RecoveryDescriptorId, RecoveryDescriptorOwner,
};
use serde::Serialize;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Producer {
    ManualMaintenance,
    Foreground,
    Freshness,
    AutomaticMaintenance,
    TimelapseAppend,
    RecoveryPump,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub(super) enum FailureClass {
    #[serde(rename = "E")]
    Error,
    #[serde(rename = "P")]
    Panic,
    #[serde(rename = "J")]
    Join,
    #[serde(rename = "D")]
    Deferred,
}

/// Fixed exits of the recovery pump that return without leaving any value.
/// The strings never contain an error-class word (see the module header).
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(super) enum PumpExit {
    TransitionPending,
    BindingUnproven,
    AuthorityUnopened,
    AdmissionPending,
    NoActionableDescriptor,
}

impl PumpExit {
    fn as_str(self) -> &'static str {
        match self {
            Self::TransitionPending => "transition-pending",
            Self::BindingUnproven => "binding-unproven",
            Self::AuthorityUnopened => "authority-unopened",
            Self::AdmissionPending => "admission-pending",
            Self::NoActionableDescriptor => "no-actionable-descriptor",
        }
    }
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
    /// A fixed `NEX_` code taken from an error's Display; never prose.
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    /// Which silent recovery-pump exit was taken.
    #[serde(skip_serializing_if = "Option::is_none")]
    exit: Option<&'static str>,
    #[serde(flatten)]
    evidence: LifecycleDiagnostic,
}

const FIXED_CODE_PREFIX: &str = "NEX_";
const FIXED_CODE_MIN_LEN: usize = 5;
const FIXED_CODE_MAX_LEN: usize = 96;

/// Extract the first fixed `NEX_` code from an error message. Only
/// `[A-Z0-9_]` bytes of the token itself are returned: prose, lowercase text
/// and paths never pass. An occurrence directly after a word character or a
/// path separator is not a code boundary (a file name must not reach stderr).
pub(super) fn fixed_code(message: &str) -> Option<String> {
    let bytes = message.as_bytes();
    let mut from = 0;
    while let Some(offset) = message[from..].find(FIXED_CODE_PREFIX) {
        let start = from + offset;
        let boundary = start == 0
            || !matches!(
                bytes[start - 1],
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'/' | b'\\'
            );
        if boundary {
            let len = bytes[start..]
                .iter()
                .take_while(|&&byte| matches!(byte, b'A'..=b'Z' | b'0'..=b'9' | b'_'))
                .count();
            return (FIXED_CODE_MIN_LEN..=FIXED_CODE_MAX_LEN)
                .contains(&len)
                .then(|| message[start..start + len].to_owned());
        }
        from = start + FIXED_CODE_PREFIX.len();
    }
    None
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
        code: None,
        exit: None,
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

/// A handoff that also carries the fixed code of the returned error.
pub(super) fn handoff_with_code(
    producer: Producer,
    cause: FailureClass,
    evidence: LifecycleDiagnostic,
    code: Option<String>,
) {
    let mut record = record(producer, cause, "handoff", None, evidence);
    record.code = code;
    write_record(record, &mut std::io::stderr().lock());
}

/// Remembers which recovery-pump exits were already written for the current
/// lifecycle revision. The pump runs every second; one line per distinct
/// (exit, descriptor, revision) is enough.
struct PumpExitThrottle {
    seen: Mutex<Option<PumpExitSeen>>,
}

struct PumpExitSeen {
    revision: u64,
    exits: Vec<(PumpExit, Option<u64>)>,
}

const PUMP_EXIT_SEEN_LIMIT: usize = 64;

impl PumpExitThrottle {
    const fn new() -> Self {
        Self {
            seen: Mutex::new(None),
        }
    }

    /// True the first time a key is seen for its revision. A poisoned lock is
    /// recovered; the diagnostic never changes the operation.
    fn first_time(&self, exit: PumpExit, descriptor_id: Option<u64>, revision: u64) -> bool {
        let mut guard = self.seen.lock().unwrap_or_else(|error| error.into_inner());
        if guard.as_ref().is_none_or(|seen| seen.revision != revision) {
            *guard = Some(PumpExitSeen {
                revision,
                exits: Vec::new(),
            });
        }
        let Some(seen) = guard.as_mut() else {
            return false;
        };
        let key = (exit, descriptor_id);
        if seen.exits.contains(&key) || seen.exits.len() >= PUMP_EXIT_SEEN_LIMIT {
            return false;
        }
        seen.exits.push(key);
        true
    }
}

static PUMP_EXIT_THROTTLE: PumpExitThrottle = PumpExitThrottle::new();

fn write_pump_exit(
    throttle: &PumpExitThrottle,
    exit: PumpExit,
    descriptor_id: Option<u64>,
    code: Option<String>,
    mut evidence: LifecycleDiagnostic,
    writer: &mut impl Write,
) {
    if !throttle.first_time(exit, descriptor_id, evidence.revision) {
        return;
    }
    // The pump may be looking at a maintenance descriptor the core state does
    // not name (a descriptor left unresolved while the state is Ready).
    if evidence.descriptor_id.is_none() {
        if let Some(id) = descriptor_id {
            evidence.descriptor_id = Some(RecoveryDescriptorId::new(id));
            evidence.owner = Some(RecoveryDescriptorOwner::Maintenance);
        }
    }
    let mut record = record(
        Producer::RecoveryPump,
        FailureClass::Deferred,
        "recovery-pump",
        None,
        evidence,
    );
    record.code = code;
    record.exit = Some(exit.as_str());
    write_record(record, writer);
}

/// One value-only line for a recovery-pump exit that returns without a
/// result. Repeats within the same lifecycle revision are suppressed.
pub(super) fn recovery_pump_exit(
    exit: PumpExit,
    descriptor_id: Option<u64>,
    code: Option<String>,
    evidence: LifecycleDiagnostic,
) {
    write_pump_exit(
        &PUMP_EXIT_THROTTLE,
        exit,
        descriptor_id,
        code,
        evidence,
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

    fn sample_evidence(revision: u64) -> LifecycleDiagnostic {
        LifecycleDiagnostic {
            revision,
            compatibility_switching: None,
            projected_state: None,
            state: DiagnosticLifecycleState::Ready,
            shutdown_requested: false,
            descriptor_id: None,
            owner: None,
            root_operation_id: None,
        }
    }

    fn parse_line(bytes: Vec<u8>) -> serde_json::Value {
        let line = String::from_utf8(bytes).expect("UTF-8");
        serde_json::from_str(
            line.trim()
                .strip_prefix("[workspace-lifecycle-diag] ")
                .expect("prefix"),
        )
        .expect("JSON")
    }

    fn sorted_keys(json: &serde_json::Value) -> Vec<&str> {
        let mut keys: Vec<_> = json
            .as_object()
            .expect("record")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort();
        keys
    }

    #[test]
    fn fixed_code_accepts_only_a_bounded_nex_token() {
        let long_ok = format!("NEX_{}", "A".repeat(92));
        let too_long = format!("NEX_{}", "A".repeat(93));
        assert_eq!(long_ok.len(), 96);
        let cases: [(&str, Option<&str>); 14] = [
            (
                "NEX_C2ZC_SCHEDULER_LIVENESS_CYCLE_STALE: completed Incremental Freshness cycle exceeded its age bound",
                Some("NEX_C2ZC_SCHEDULER_LIVENESS_CYCLE_STALE"),
            ),
            ("Anyhow(NEX_A_B)", Some("NEX_A_B")),
            ("error: NEX_A1 happened", Some("NEX_A1")),
            ("NEX_A", Some("NEX_A")),
            ("xNEX_A", None),
            ("_NEX_A", None),
            ("1NEX_A", None),
            ("nex_a", None),
            ("NEX_a", None),
            ("NEX_", None),
            // A path separator is not a code boundary: file names stay out.
            ("/tmp/NEX_A", None),
            ("C:\\work\\NEX_A", None),
            ("no code here", None),
            ("", None),
        ];
        for (message, expected) in cases {
            assert_eq!(fixed_code(message).as_deref(), expected, "{message:?}");
        }
        assert_eq!(fixed_code(&long_ok).as_deref(), Some(long_ok.as_str()));
        assert_eq!(fixed_code(&too_long), None);
        // The first valid occurrence decides; a later token is not a fallback.
        assert_eq!(fixed_code("xNEX_A then NEX_B").as_deref(), Some("NEX_B"));
        assert_eq!(fixed_code("NEX_ then NEX_B"), None);
        // Non-ASCII text around the token is never copied.
        assert_eq!(fixed_code("失敗 NEX_A_B 本文").as_deref(), Some("NEX_A_B"));
    }

    #[test]
    fn handoff_code_is_the_only_added_key_and_absent_without_it() {
        let mut evidence = sample_evidence(7);
        evidence.state = DiagnosticLifecycleState::RecoveryRequired;
        let mut with_code = record(
            Producer::Freshness,
            FailureClass::Error,
            "handoff",
            None,
            evidence,
        );
        with_code.code = Some("NEX_C2ZC_SCHEDULER_LIVENESS_CYCLE_STALE".to_owned());
        let mut bytes = Vec::new();
        write_record(with_code, &mut bytes);
        let json = parse_line(bytes);
        assert_eq!(json["code"], "NEX_C2ZC_SCHEDULER_LIVENESS_CYCLE_STALE");
        assert_eq!(
            sorted_keys(&json),
            [
                "boundary",
                "cause",
                "code",
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
        let mut bytes = Vec::new();
        write_record(
            record(
                Producer::Freshness,
                FailureClass::Join,
                "handoff",
                None,
                evidence,
            ),
            &mut bytes,
        );
        let json = parse_line(bytes);
        assert!(json.get("code").is_none());
        assert!(json.get("exit").is_none());
    }

    #[test]
    fn pump_exit_records_carry_only_fixed_values() {
        for (exit, expected) in [
            (PumpExit::TransitionPending, "transition-pending"),
            (PumpExit::BindingUnproven, "binding-unproven"),
            (PumpExit::AuthorityUnopened, "authority-unopened"),
            (PumpExit::AdmissionPending, "admission-pending"),
            (PumpExit::NoActionableDescriptor, "no-actionable-descriptor"),
        ] {
            let throttle = PumpExitThrottle::new();
            let mut bytes = Vec::new();
            write_pump_exit(
                &throttle,
                exit,
                Some(5),
                Some("NEX_MAINTENANCE_OPEN_X".to_owned()),
                sample_evidence(9),
                &mut bytes,
            );
            let line = String::from_utf8(bytes.clone()).expect("UTF-8");
            let json = parse_line(bytes);
            assert_eq!(json["producer"], "recovery-pump");
            assert_eq!(json["boundary"], "recovery-pump");
            assert_eq!(json["cause"], "D");
            assert_eq!(json["exit"], expected);
            assert_eq!(json["code"], "NEX_MAINTENANCE_OPEN_X");
            assert_eq!(json["revision"], 9);
            // The pump's own descriptor is reported when the state names none.
            assert_eq!(json["descriptorId"], 5);
            assert_eq!(json["owner"], "Maintenance");
            assert_eq!(
                sorted_keys(&json),
                [
                    "boundary",
                    "cause",
                    "code",
                    "descriptorId",
                    "exit",
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
        // Without a code or descriptor, neither key is invented.
        let throttle = PumpExitThrottle::new();
        let mut bytes = Vec::new();
        write_pump_exit(
            &throttle,
            PumpExit::NoActionableDescriptor,
            None,
            None,
            sample_evidence(2),
            &mut bytes,
        );
        let json = parse_line(bytes);
        assert!(json.get("code").is_none());
        assert_eq!(json["descriptorId"], serde_json::Value::Null);
        assert_eq!(json["owner"], serde_json::Value::Null);
    }

    #[test]
    fn pump_exit_repeats_are_written_once_per_revision() {
        let throttle = PumpExitThrottle::new();
        let count = |exit, descriptor, revision| {
            let mut bytes = Vec::new();
            write_pump_exit(
                &throttle,
                exit,
                descriptor,
                None,
                sample_evidence(revision),
                &mut bytes,
            );
            usize::from(!bytes.is_empty())
        };
        assert_eq!(count(PumpExit::BindingUnproven, Some(2), 4), 1);
        assert_eq!(count(PumpExit::BindingUnproven, Some(2), 4), 0);
        assert_eq!(count(PumpExit::BindingUnproven, Some(2), 4), 0);
        // A different exit or descriptor in the same revision is its own line,
        // and alternating between them does not repeat either.
        assert_eq!(count(PumpExit::AdmissionPending, Some(2), 4), 1);
        assert_eq!(count(PumpExit::BindingUnproven, Some(3), 4), 1);
        assert_eq!(count(PumpExit::BindingUnproven, Some(2), 4), 0);
        assert_eq!(count(PumpExit::AdmissionPending, Some(2), 4), 0);
        // A new revision writes again, then suppresses again.
        assert_eq!(count(PumpExit::BindingUnproven, Some(2), 5), 1);
        assert_eq!(count(PumpExit::BindingUnproven, Some(2), 5), 0);
    }

    #[test]
    fn pump_exit_throttle_survives_poison_and_unavailable_writers() {
        struct Unavailable;
        impl Write for Unavailable {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let throttle = std::sync::Arc::new(PumpExitThrottle::new());
        let poisoner = std::sync::Arc::clone(&throttle);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.seen.lock().expect("lock");
            panic!("poison the throttle");
        })
        .join();
        assert!(throttle.seen.is_poisoned());
        write_pump_exit(
            &throttle,
            PumpExit::AuthorityUnopened,
            Some(1),
            None,
            sample_evidence(1),
            &mut Unavailable,
        );
        // The failed write still counted as seen; a repeat stays quiet.
        let mut bytes = Vec::new();
        write_pump_exit(
            &throttle,
            PumpExit::AuthorityUnopened,
            Some(1),
            None,
            sample_evidence(1),
            &mut bytes,
        );
        assert!(bytes.is_empty());
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
