//! Fixed stack frames for the opt-in C-query shared-allocation diagnostic.
//!
//! Frames are bounded observations, never product acceptance or enforcement.

use crate::c_query_allocator::AllocatorSnapshot;
use grimodex_db::narrative_extraction::nir1_graph_memory_diagnostics::SqliteConnectionMemory;

pub const MAX_FRAME_BYTES: usize = 4_096;
pub const CHECKPOINT_FRAME: u8 = 86;
pub const SHARED_LIMIT_BYTES: u64 = crate::c_query_allocator::SHARED_LIMIT_BYTES;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum QueryStatus {
    Available,
    Unavailable,
    Error,
}

impl QueryStatus {
    fn as_bytes(self) -> &'static [u8] {
        match self {
            Self::Available => b"available",
            Self::Unavailable => b"unavailable",
            Self::Error => b"error",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GraphObservation {
    pub case_code: u16,
    pub query_elapsed_ns_approx: u64,
    pub close_elapsed_ns_approx: u64,
    pub cgroup_startup_bytes: u64,
    pub cgroup_startup_lifetime_peak_bytes: u64,
    pub cgroup_registered_bytes: u64,
    pub cgroup_registered_lifetime_peak_bytes: u64,
    pub cgroup_query_baseline_bytes: u64,
    pub cgroup_query_peak_bytes: u64,
    pub cgroup_query_after_bytes: u64,
    /// Bits 0..7: identity, candidate page, A2 preflight, A2 length SQL,
    /// A3 preflight, A3 first SQL, A3 evaluation, cleanup post-stamp reached.
    pub query_reached_mask: u8,
    /// Bits 0..3: work error, post-stamp error, deadline observed, unattributed.
    pub query_failure_mask: u8,
    pub rust_baseline_requested_live_bytes: u64,
    pub rust_query_requested_live_peak_bytes: u64,
    pub rust_query_requested_live_after_bytes: u64,
    pub sqlite_baseline_memory_used_bytes: u64,
    pub sqlite_query_memory_used_peak_bytes: u64,
    pub sqlite_query_memory_used_after_bytes: u64,
    pub sqlite_registered_authority: SqliteConnectionMemory,
    pub sqlite_registered_reader: SqliteConnectionMemory,
    pub query_status: QueryStatus,
    pub at_epoch: AllocatorSnapshot,
    pub after_query: AllocatorSnapshot,
    pub after_graph_cleanup_and_observation_drop: AllocatorSnapshot,
    pub registered_ready_observed: bool,
    pub reader_closed: bool,
    pub participant_released: bool,
    pub source_unchanged: bool,
    pub files_retained: bool,
    pub cgroup_peak_reset: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AllocationCaseObservation {
    pub case_code: u16,
    /// Sum of fixed payload sizes requested by this case; not raw charge.
    pub case_payload_requested_bytes: u64,
    /// Sum of full raw System layouts admitted by this case; includes headers/padding.
    pub case_admitted_raw_charge_bytes: u64,
    pub case_rejected_payload_bytes: u64,
    pub case_rejected_raw_charge_bytes: u64,
    pub assertion_mask: u16,
    pub at_epoch: AllocatorSnapshot,
    pub after_case: AllocatorSnapshot,
}

pub struct EncodedCQueryFrame {
    bytes: [u8; MAX_FRAME_BYTES],
    len: usize,
}

impl EncodedCQueryFrame {
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes[..self.len]
    }
}

/// Encode the two approved managed-Graph cases. Graph cleanup facts are emitted
/// only for Graph-domain observations; no 2 MiB/physical-memory claim is made.
pub fn encode_graph_observation(observation: GraphObservation) -> Option<EncodedCQueryFrame> {
    if !matches!(observation.case_code, 2 | 513)
        || observation.query_failure_mask > 15
        || !observation.registered_ready_observed
        || !observation.reader_closed
        || !observation.participant_released
        || !observation.source_unchanged
        || !observation.files_retained
        || !observation.cgroup_peak_reset
        || [
            observation.sqlite_registered_authority,
            observation.sqlite_registered_reader,
        ]
        .into_iter()
        .any(|s| {
            [
                s.cache_bytes_approx,
                s.schema_bytes_approx,
                s.statement_bytes_approx,
            ]
            .into_iter()
            .any(|n| n > i32::MAX as u64)
        })
    {
        return None;
    }
    let mut writer = FrameWriter::new();
    write_common(&mut writer, b"graph", observation.case_code)?;
    writer.write(b",\"checkpointCode\":")?;
    writer.write_u64(u64::from(CHECKPOINT_FRAME))?;
    writer.write(b",\"queryStatus\":\"")?;
    writer.write(observation.query_status.as_bytes())?;
    writer.write(b"\",\"queryElapsedNsApprox\":")?;
    writer.write_u64(observation.query_elapsed_ns_approx)?;
    writer.write(b",\"closeElapsedNsApprox\":")?;
    writer.write_u64(observation.close_elapsed_ns_approx)?;
    for (name, value) in [
        (
            b",\"rustBaselineRequestedLiveBytes\":".as_slice(),
            observation.rust_baseline_requested_live_bytes,
        ),
        (
            b",\"rustQueryRequestedLivePeakBytes\":".as_slice(),
            observation.rust_query_requested_live_peak_bytes,
        ),
        (
            b",\"rustQueryRequestedLiveAfterBytes\":".as_slice(),
            observation.rust_query_requested_live_after_bytes,
        ),
        (
            b",\"sqliteBaselineMemoryUsedBytes\":".as_slice(),
            observation.sqlite_baseline_memory_used_bytes,
        ),
        (
            b",\"sqliteQueryMemoryUsedPeakBytes\":".as_slice(),
            observation.sqlite_query_memory_used_peak_bytes,
        ),
        (
            b",\"sqliteQueryMemoryUsedAfterBytes\":".as_slice(),
            observation.sqlite_query_memory_used_after_bytes,
        ),
        (
            b",\"sqliteRegisteredAuthorityCacheBytesApprox\":".as_slice(),
            observation.sqlite_registered_authority.cache_bytes_approx,
        ),
        (
            b",\"sqliteRegisteredAuthoritySchemaBytesApprox\":".as_slice(),
            observation.sqlite_registered_authority.schema_bytes_approx,
        ),
        (
            b",\"sqliteRegisteredAuthorityStatementBytesApprox\":".as_slice(),
            observation
                .sqlite_registered_authority
                .statement_bytes_approx,
        ),
        (
            b",\"sqliteRegisteredReaderCacheBytesApprox\":".as_slice(),
            observation.sqlite_registered_reader.cache_bytes_approx,
        ),
        (
            b",\"sqliteRegisteredReaderSchemaBytesApprox\":".as_slice(),
            observation.sqlite_registered_reader.schema_bytes_approx,
        ),
        (
            b",\"sqliteRegisteredReaderStatementBytesApprox\":".as_slice(),
            observation.sqlite_registered_reader.statement_bytes_approx,
        ),
        (
            b",\"cgroupStartupBytes\":".as_slice(),
            observation.cgroup_startup_bytes,
        ),
        (
            b",\"cgroupStartupLifetimePeakBytes\":".as_slice(),
            observation.cgroup_startup_lifetime_peak_bytes,
        ),
        (
            b",\"cgroupRegisteredBytes\":".as_slice(),
            observation.cgroup_registered_bytes,
        ),
        (
            b",\"cgroupRegisteredLifetimePeakBytes\":".as_slice(),
            observation.cgroup_registered_lifetime_peak_bytes,
        ),
        (
            b",\"cgroupQueryBaselineBytes\":".as_slice(),
            observation.cgroup_query_baseline_bytes,
        ),
        (
            b",\"cgroupQueryPeakBytes\":".as_slice(),
            observation.cgroup_query_peak_bytes,
        ),
        (
            b",\"cgroupQueryAfterBytes\":".as_slice(),
            observation.cgroup_query_after_bytes,
        ),
    ] {
        writer.write(name)?;
        writer.write_u64(value)?;
    }
    writer.write(b",\"queryReachedMask\":")?;
    writer.write_u64(u64::from(observation.query_reached_mask))?;
    writer.write(b",\"queryFailureMask\":")?;
    writer.write_u64(u64::from(observation.query_failure_mask))?;
    writer.write(b",\"cgroupPeakReset\":1,\"registeredReadyObserved\":1,\"readerClosed\":1,\"participantReleased\":1,\"sourceUnchanged\":1,\"filesRetained\":1,\"sharedLimitBytes\":")?;
    writer.write_u64(SHARED_LIMIT_BYTES)?;
    writer.write(b",\"sharedControlStorageBytes\":")?;
    writer.write_u64(crate::c_query_allocator::CONTROL_STORAGE_BYTES)?;
    write_snapshot(&mut writer, b"sharedAtEpoch", observation.at_epoch)?;
    write_snapshot(&mut writer, b"sharedAfterQuery", observation.after_query)?;
    write_snapshot(
        &mut writer,
        b"sharedAfterGraphCleanupAndObservationDrop",
        observation.after_graph_cleanup_and_observation_drop,
    )?;
    writer.write(b"}")?;
    writer.finish()
}

/// Encode a successful data-free allocator case. The closed case implementation
/// verifies each assertion before constructing this fixed numeric summary.
pub fn encode_allocation_case(
    observation: AllocationCaseObservation,
) -> Option<EncodedCQueryFrame> {
    let expected_mask = match observation.case_code {
        100 => 0b00_0011_1111,
        101 => 0b00_0001_1111,
        102 => 0b00_0111_1111,
        _ => return None,
    };
    if observation.assertion_mask != expected_mask {
        return None;
    }
    let mut writer = FrameWriter::new();
    write_common(&mut writer, b"allocator", observation.case_code)?;
    writer.write(b",\"checkpointCode\":")?;
    writer.write_u64(u64::from(CHECKPOINT_FRAME))?;
    writer.write(b",\"sharedLimitBytes\":")?;
    writer.write_u64(SHARED_LIMIT_BYTES)?;
    writer.write(b",\"sharedControlStorageBytes\":")?;
    writer.write_u64(crate::c_query_allocator::CONTROL_STORAGE_BYTES)?;
    for (name, value) in [
        (
            b",\"casePayloadRequestedBytes\":".as_slice(),
            observation.case_payload_requested_bytes,
        ),
        (
            b",\"caseAdmittedRawChargeBytes\":".as_slice(),
            observation.case_admitted_raw_charge_bytes,
        ),
        (
            b",\"caseRejectedPayloadBytes\":".as_slice(),
            observation.case_rejected_payload_bytes,
        ),
        (
            b",\"caseRejectedRawChargeBytes\":".as_slice(),
            observation.case_rejected_raw_charge_bytes,
        ),
        (
            b",\"assertionMask\":".as_slice(),
            u64::from(observation.assertion_mask),
        ),
    ] {
        writer.write(name)?;
        writer.write_u64(value)?;
    }
    write_snapshot(&mut writer, b"sharedAtEpoch", observation.at_epoch)?;
    write_snapshot(&mut writer, b"sharedAfterCase", observation.after_case)?;
    writer.write(b"}")?;
    writer.finish()
}

fn write_common(writer: &mut FrameWriter, domain: &[u8], case_code: u16) -> Option<()> {
    writer.write(b"{\"schemaVersion\":5,\"domain\":\"")?;
    writer.write(domain)?;
    writer.write(b"\",\"caseCode\":")?;
    writer.write_u64(u64::from(case_code))?;
    writer.write(b",\"diagnosticStatus\":\"incomplete\",\"claimsProductAcceptance\":false")
}

fn write_snapshot(
    writer: &mut FrameWriter,
    prefix: &[u8],
    snapshot: AllocatorSnapshot,
) -> Option<()> {
    for (suffix, value) in [
        (
            b"BaselineRawBytes".as_slice(),
            snapshot.baseline_charged_bytes,
        ),
        (
            b"BaselinePendingBytes".as_slice(),
            snapshot.baseline_pending_bytes,
        ),
        (
            b"QueryChargedBytes".as_slice(),
            snapshot.query_charged_bytes,
        ),
        (
            b"QueryPendingBytes".as_slice(),
            snapshot.query_pending_bytes,
        ),
        (
            b"QueryHighWaterBytes".as_slice(),
            snapshot.query_high_water_bytes,
        ),
        (
            b"RustRequestedLiveBytes".as_slice(),
            snapshot.rust_requested_live_bytes,
        ),
        (
            b"RustRequestedPendingBytes".as_slice(),
            snapshot.rust_requested_pending_bytes,
        ),
        (
            b"RustRequestedPeakBytes".as_slice(),
            snapshot.rust_requested_peak_bytes,
        ),
    ] {
        writer.write(b",\"")?;
        writer.write(prefix)?;
        writer.write(suffix)?;
        writer.write(b"\":")?;
        writer.write_u64(value)?;
    }
    Some(())
}

struct FrameWriter {
    bytes: [u8; MAX_FRAME_BYTES],
    len: usize,
    failed: bool,
}

impl FrameWriter {
    fn new() -> Self {
        Self {
            bytes: [0; MAX_FRAME_BYTES],
            len: 0,
            failed: false,
        }
    }

    fn checked_end(&mut self, additional: usize) -> Option<usize> {
        if self.failed {
            return None;
        }
        let Some(end) = self.len.checked_add(additional) else {
            self.failed = true;
            return None;
        };
        if end > MAX_FRAME_BYTES {
            self.failed = true;
            return None;
        }
        Some(end)
    }

    fn write(&mut self, bytes: &[u8]) -> Option<()> {
        let end = self.checked_end(bytes.len())?;
        self.bytes[self.len..end].copy_from_slice(bytes);
        self.len = end;
        Some(())
    }

    fn write_u64(&mut self, value: u64) -> Option<()> {
        let digit_count = decimal_digits(value);
        self.checked_end(digit_count)?;
        let mut digits = [0; 20];
        let mut remaining = value;
        for index in (0..digit_count).rev() {
            digits[index] = b'0' + (remaining % 10) as u8;
            remaining /= 10;
        }
        self.write(&digits[..digit_count])
    }

    fn finish(mut self) -> Option<EncodedCQueryFrame> {
        self.write(b"\n")?;
        Some(EncodedCQueryFrame {
            bytes: self.bytes,
            len: self.len,
        })
    }
}

fn decimal_digits(mut value: u64) -> usize {
    let mut digits = 1;
    while value >= 10 {
        value /= 10;
        digits += 1;
    }
    digits
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(value: u64) -> AllocatorSnapshot {
        AllocatorSnapshot {
            baseline_charged_bytes: value,
            baseline_pending_bytes: value,
            baseline_high_water_bytes: value,
            query_charged_bytes: value,
            query_pending_bytes: value,
            query_high_water_bytes: value,
            rust_requested_live_bytes: value,
            rust_requested_pending_bytes: value,
            rust_requested_peak_bytes: value,
            rust_baseline_requested_live_bytes: value,
        }
    }

    fn graph() -> GraphObservation {
        GraphObservation {
            case_code: 2,
            query_elapsed_ns_approx: 7,
            close_elapsed_ns_approx: 8,
            cgroup_startup_bytes: 9,
            cgroup_startup_lifetime_peak_bytes: 10,
            cgroup_registered_bytes: 11,
            cgroup_registered_lifetime_peak_bytes: 12,
            cgroup_query_baseline_bytes: 13,
            cgroup_query_peak_bytes: 14,
            cgroup_query_after_bytes: 15,
            query_reached_mask: 255,
            query_failure_mask: 0,
            rust_baseline_requested_live_bytes: 1,
            rust_query_requested_live_peak_bytes: 2,
            rust_query_requested_live_after_bytes: 3,
            sqlite_baseline_memory_used_bytes: 4,
            sqlite_query_memory_used_peak_bytes: 5,
            sqlite_query_memory_used_after_bytes: 6,
            sqlite_registered_authority: SqliteConnectionMemory {
                cache_bytes_approx: 10,
                schema_bytes_approx: 11,
                statement_bytes_approx: 12,
            },
            sqlite_registered_reader: SqliteConnectionMemory {
                cache_bytes_approx: 20,
                schema_bytes_approx: 21,
                statement_bytes_approx: 22,
            },
            query_status: QueryStatus::Available,
            at_epoch: snapshot(16),
            after_query: snapshot(17),
            after_graph_cleanup_and_observation_drop: snapshot(18),
            registered_ready_observed: true,
            reader_closed: true,
            participant_released: true,
            source_unchanged: true,
            files_retained: true,
            cgroup_peak_reset: true,
        }
    }

    #[test]
    fn graph_frame_has_graph_only_facts_and_named_shared_snapshots() {
        let frame = encode_graph_observation(graph()).expect("fixed Graph frame");
        let text = std::str::from_utf8(frame.as_bytes()).expect("ASCII frame");
        assert!(text.starts_with("{"));
        assert!(text.contains("\"schemaVersion\":5,\"domain\":\"graph\",\"caseCode\":2"));
        for (name, value) in [
            ("AuthorityCache", 10),
            ("AuthoritySchema", 11),
            ("AuthorityStatement", 12),
            ("ReaderCache", 20),
            ("ReaderSchema", 21),
            ("ReaderStatement", 22),
        ] {
            assert!(text.contains(&format!("\"sqliteRegistered{name}BytesApprox\":{value}")));
        }
        assert!(text.contains("\"registeredReadyObserved\":1"));
        assert!(text.contains("\"sharedAfterGraphCleanupAndObservationDropQueryChargedBytes\":18"));
        assert!(text.contains("\"claimsProductAcceptance\":false"));
        assert!(!text.contains("assertionMask"));
        assert!(text.ends_with("\n"));
        assert!(frame.as_bytes().len() <= MAX_FRAME_BYTES);
    }

    #[test]
    fn allocator_frame_has_no_graph_cleanup_proofs_or_dynamic_values() {
        let frame = encode_allocation_case(AllocationCaseObservation {
            case_code: 101,
            case_payload_requested_bytes: 200_000,
            case_admitted_raw_charge_bytes: 2_000_000,
            case_rejected_payload_bytes: 1,
            case_rejected_raw_charge_bytes: 80,
            assertion_mask: 0b1_1111,
            at_epoch: snapshot(0),
            after_case: snapshot(16),
        })
        .expect("fixed allocation frame");
        let text = std::str::from_utf8(frame.as_bytes()).expect("ASCII frame");
        assert!(text.contains("\"domain\":\"allocator\",\"caseCode\":101"));
        assert!(text.contains("\"casePayloadRequestedBytes\":200000"));
        assert!(text.contains("\"caseAdmittedRawChargeBytes\":2000000"));
        assert!(text.contains("\"assertionMask\":31"));
        assert!(!text.contains("readerClosed"));
        assert!(!text.contains("participantReleased"));
        assert!(!text.contains("sourceUnchanged"));
        assert!(!text.contains("filesRetained"));
        assert!(text.contains("\"diagnosticStatus\":\"incomplete\""));
        assert!(text.ends_with("\n"));
        for (case_code, assertion_mask) in [(100, 0b00_0011_1111), (102, 0b00_0111_1111)] {
            assert!(encode_allocation_case(AllocationCaseObservation {
                case_code,
                case_payload_requested_bytes: 1,
                case_admitted_raw_charge_bytes: 1,
                case_rejected_payload_bytes: 0,
                case_rejected_raw_charge_bytes: 0,
                assertion_mask,
                at_epoch: snapshot(0),
                after_case: snapshot(0),
            })
            .is_some());
        }
    }

    #[test]
    fn max_numeric_width_is_bounded_and_invalid_cases_or_graph_proofs_fail_closed() {
        let mut observation = graph();
        observation.case_code = 513;
        observation.query_elapsed_ns_approx = u64::MAX;
        observation.cgroup_startup_bytes = u64::MAX;
        observation.at_epoch = snapshot(u64::MAX);
        observation.sqlite_registered_authority = SqliteConnectionMemory {
            cache_bytes_approx: i32::MAX as u64,
            schema_bytes_approx: i32::MAX as u64,
            statement_bytes_approx: i32::MAX as u64,
        };
        observation.sqlite_registered_reader = observation.sqlite_registered_authority;
        let frame = encode_graph_observation(observation).expect("bounded u64 frame");
        assert!(frame.as_bytes().len() <= MAX_FRAME_BYTES);
        assert!(std::str::from_utf8(frame.as_bytes())
            .expect("ASCII")
            .contains("18446744073709551615"));
        for role in 0..2 {
            for field in 0..3 {
                let mut invalid = observation;
                let status = if role == 0 {
                    &mut invalid.sqlite_registered_authority
                } else {
                    &mut invalid.sqlite_registered_reader
                };
                match field {
                    0 => status.cache_bytes_approx += 1,
                    1 => status.schema_bytes_approx += 1,
                    _ => status.statement_bytes_approx += 1,
                }
                assert!(encode_graph_observation(invalid).is_none());
            }
        }
        observation.case_code = 1;
        assert!(encode_graph_observation(observation).is_none());
        observation.case_code = 2;
        observation.reader_closed = false;
        assert!(encode_graph_observation(observation).is_none());
        assert!(encode_allocation_case(AllocationCaseObservation {
            case_code: 103,
            case_payload_requested_bytes: 0,
            case_admitted_raw_charge_bytes: 0,
            case_rejected_payload_bytes: 0,
            case_rejected_raw_charge_bytes: 0,
            assertion_mask: 0,
            at_epoch: snapshot(0),
            after_case: snapshot(0),
        })
        .is_none());
    }

    fn fill(writer: &mut FrameWriter, len: usize) {
        let chunk = [b'x'; 128];
        for _ in 0..len / chunk.len() {
            assert!(writer.write(&chunk).is_some());
        }
        for _ in 0..len % chunk.len() {
            assert!(writer.write(b"x").is_some());
        }
    }

    #[test]
    fn newline_fits_exactly_at_the_frame_cap_and_overflow_fails_closed() {
        let mut writer = FrameWriter::new();
        fill(&mut writer, MAX_FRAME_BYTES - 1);
        let frame = writer.finish().expect("newline fits exactly at cap");
        assert_eq!(frame.as_bytes().len(), MAX_FRAME_BYTES);
        assert_eq!(frame.as_bytes().last(), Some(&b'\n'));

        let mut writer = FrameWriter::new();
        fill(&mut writer, MAX_FRAME_BYTES - 1);
        assert!(writer.write(b"xy").is_none());
        assert!(writer.finish().is_none());
    }
}
