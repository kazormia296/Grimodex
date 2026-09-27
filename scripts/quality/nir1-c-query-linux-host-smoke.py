#!/usr/bin/env python3
"""Opt-in Linux C-query benign lifecycle smoke and fixed-case diagnostics only."""

from __future__ import annotations

import fcntl
import io
import json
import os
import pwd
import re
import select
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path

MEMORY_MAX = 67_108_864
MEMORY_SWAP_MAX = 0
MAX_FRAME = 4096
MAX_COMMAND_OUTPUT = 4096
# Fixed I/O/parser sizes are not a measurement of simultaneous Python allocations.
# The final diagnostic remains incomplete until the aggregate parent-buffer bound is proved.
START_ACTIVE_LIMIT_NS = 120_000_000_000
STOP_GRACE_NS = 5_000_000_000
UNRESOLVED_GRACE_NS = 10_000_000_000
TOTAL_LIMIT_NS = START_ACTIVE_LIMIT_NS + STOP_GRACE_NS + UNRESOLVED_GRACE_NS
UNIT_PREFIX = "nir1-c-query-host-smoke-"
RUNTIME_DIRECTORY_PREFIX = "nir1-c-query-probe-"
RUNTIME_MARKER = ".nir1-c-query-probe-marker"
UNIT_PROPERTIES = (
    "MemoryMax",
    "MemorySwapMax",
    "TimeoutStartUSec",
    "RuntimeMaxUSec",
    "TimeoutStopUSec",
    "KillMode",
    "SendSIGKILL",
    "LimitCORE",
    "RuntimeDirectory",
    "RuntimeDirectoryMode",
    "RuntimeDirectoryPreserve",
    "UMask",
    "ControlGroup",
    "ActiveState",
    "SubState",
    "MainPID",
    "ActiveEnterTimestampMonotonic",
    "Result",
    "ExecMainCode",
    "ExecMainStatus",
    "InactiveEnterTimestampMonotonic",
)
STATE_NAME = "owner.json"
QUERY_CASES = {"Q2/R1/D0-local": 2, "Q513/R3/D0": 513}
ALLOCATOR_CASES = {
    "alloc-layout": 100,
    "alloc-shared-limit": 101,
    "alloc-realloc": 102,
    "alloc-rust-limit": 103,
}
FIXED_CASES = {**QUERY_CASES, **ALLOCATOR_CASES}
SHARED_LIMIT_BYTES = 2_097_152
FRAME_COMMON_FIELDS = (
    "schemaVersion", "domain", "caseCode", "diagnosticStatus", "claimsProductAcceptance",
)
SHARED_SNAPSHOT_SUFFIXES = (
    "BaselineRawBytes", "BaselinePendingBytes", "QueryChargedBytes", "QueryPendingBytes",
    "QueryHighWaterBytes", "RustRequestedLiveBytes", "RustRequestedPendingBytes",
    "RustRequestedPeakBytes",
)
SQLITE_REGISTRATION_FIELDS = (
    "sqliteRegisteredAuthorityCacheBytesApprox", "sqliteRegisteredAuthoritySchemaBytesApprox",
    "sqliteRegisteredAuthorityStatementBytesApprox", "sqliteRegisteredReaderCacheBytesApprox",
    "sqliteRegisteredReaderSchemaBytesApprox", "sqliteRegisteredReaderStatementBytesApprox",
)
GRAPH_FRAME_FIELDS = (
    *FRAME_COMMON_FIELDS,
    "checkpointCode", "queryStatus", "queryElapsedNsApprox", "closeElapsedNsApprox",
    "rustBaselineRequestedLiveBytes", "rustQueryRequestedLivePeakBytes",
    "rustQueryRequestedLiveAfterBytes", "sqliteBaselineMemoryUsedBytes",
    "sqliteQueryMemoryUsedPeakBytes", "sqliteQueryMemoryUsedAfterBytes",
    *SQLITE_REGISTRATION_FIELDS,
    "cgroupStartupBytes", "cgroupStartupLifetimePeakBytes", "cgroupRegisteredBytes",
    "cgroupRegisteredLifetimePeakBytes", "cgroupQueryBaselineBytes", "cgroupQueryPeakBytes",
    "cgroupQueryAfterBytes", "queryReachedMask", "queryFailureMask", "cgroupPeakReset",
    "registeredReadyObserved", "readerClosed", "participantReleased", "sourceUnchanged",
    "filesRetained", "sharedLimitBytes", "sharedControlStorageBytes",
    *(f"sharedAtEpoch{suffix}" for suffix in SHARED_SNAPSHOT_SUFFIXES),
    *(f"sharedAfterQuery{suffix}" for suffix in SHARED_SNAPSHOT_SUFFIXES),
    *(f"sharedAfterGraphCleanupAndObservationDrop{suffix}" for suffix in SHARED_SNAPSHOT_SUFFIXES),
)
ALLOCATOR_FRAME_FIELDS = (
    *FRAME_COMMON_FIELDS,
    "checkpointCode", "sharedLimitBytes", "sharedControlStorageBytes",
    "casePayloadRequestedBytes", "caseAdmittedRawChargeBytes", "caseRejectedPayloadBytes",
    "caseRejectedRawChargeBytes", "assertionMask",
    *(f"sharedAtEpoch{suffix}" for suffix in SHARED_SNAPSHOT_SUFFIXES),
    *(f"sharedAfterCase{suffix}" for suffix in SHARED_SNAPSHOT_SUFFIXES),
)
U64_MAX = (1 << 64) - 1


class ProbeError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class UnresolvedOwner(Exception):
    pass


def _require(condition: bool, code: str) -> None:
    if not condition:
        raise ProbeError(code)


def _nonce_ok(nonce: str) -> bool:
    return re.fullmatch(r"[0-9a-f]{32}", nonce) is not None


def _unit_for(nonce: str) -> str:
    _require(_nonce_ok(nonce), "nonce-invalid")
    return f"{UNIT_PREFIX}{nonce}.service"


def _runtime_directory_name(nonce: str) -> str:
    _require(_nonce_ok(nonce), "nonce-invalid")
    return f"{RUNTIME_DIRECTORY_PREFIX}{nonce}"


def _query_binary() -> str:
    # Fixed worktree release artifact; never PATH, CARGO_TARGET_DIR or caller authority.
    binary = Path(__file__).resolve(strict=True).parents[2] / "src-tauri/target/release/nir1-c-query-linux-probe"
    _require(binary.is_file() and not binary.is_symlink() and os.access(binary, os.X_OK),
             "query-binary-unavailable")
    return str(binary)


def _validate_shared_snapshots(values: dict[str, int | str | bool], prefixes: tuple[str, ...],
                               control_bytes: int) -> None:
    _require(0 < control_bytes <= SHARED_LIMIT_BYTES, "shared-control-invalid")
    previous_query_highwater = 0
    previous_rust_peak = 0
    for prefix in prefixes:
        charged = values[prefix + "QueryChargedBytes"]
        pending = values[prefix + "QueryPendingBytes"]
        highwater = values[prefix + "QueryHighWaterBytes"]
        rust_live = values[prefix + "RustRequestedLiveBytes"]
        rust_peak = values[prefix + "RustRequestedPeakBytes"]
        _require(control_bytes <= charged <= SHARED_LIMIT_BYTES, "shared-charge-out-of-range")
        _require(pending <= charged - control_bytes, "shared-pending-invalid")
        # Epoch start drains baseline reservations; Rust pending is query pending only.
        _require(values[prefix + "RustRequestedPendingBytes"] <= pending,
                 "rust-requested-pending-invalid")
        _require(charged <= highwater <= SHARED_LIMIT_BYTES, "shared-highwater-invalid")
        _require(rust_peak >= rust_live, "rust-requested-peak-invalid")
        _require(highwater >= previous_query_highwater and rust_peak >= previous_rust_peak,
                 "shared-counter-regressed")
        previous_query_highwater = highwater
        previous_rust_peak = rust_peak
    at_epoch = prefixes[0]
    _require(values[at_epoch + "BaselinePendingBytes"] == 0
             and values[at_epoch + "QueryChargedBytes"] == control_bytes
             and values[at_epoch + "QueryPendingBytes"] == 0
             and values[at_epoch + "QueryHighWaterBytes"] == control_bytes,
             "shared-epoch-invalid")


def _parse_query_frame(frame: bytes, case_code: int) -> dict[str, int | str | bool]:
    _require(len(frame) <= MAX_FRAME, "frame-too-large")
    _require(case_code in FIXED_CASES.values(), "query-case-invalid")
    domain = "graph" if case_code in QUERY_CASES.values() else "allocator"
    fields = GRAPH_FRAME_FIELDS if domain == "graph" else ALLOCATOR_FRAME_FIELDS
    values: dict[str, int | str | bool] = {}
    offset = 0
    for index, key in enumerate(fields):
        prefix = (("{" if index == 0 else ",") + '"' + key + '":').encode("ascii")
        _require(frame.startswith(prefix, offset), "query-frame-invalid")
        offset += len(prefix)
        if key == "domain":
            grammar = rb'"(graph|allocator)"(?=[,}])'
        elif key == "queryStatus":
            grammar = rb'"(available|unavailable|error)"(?=[,}])'
        elif key == "diagnosticStatus":
            grammar = rb'"(incomplete)"(?=[,}])'
        elif key == "claimsProductAcceptance":
            grammar = rb"false(?=[,}])"
        else:
            grammar = rb"(0|[1-9][0-9]{0,19})(?=[,}])"
        token = re.compile(grammar).match(frame, offset)
        _require(token is not None, "query-frame-invalid")
        if key in ("domain", "queryStatus", "diagnosticStatus"):
            values[key] = token[1].decode("ascii")
        elif key == "claimsProductAcceptance":
            values[key] = False
        else:
            value = int(token[1])
            _require(value <= U64_MAX, "query-number-out-of-range")
            values[key] = value
        offset = token.end()
    _require(frame[offset:] == b"}\n", "query-frame-extra-data")
    _require(values["schemaVersion"] == 5 and values["domain"] == domain
             and values["caseCode"] == case_code and values["diagnosticStatus"] == "incomplete"
             and values["claimsProductAcceptance"] is False and values["checkpointCode"] == 86,
             "query-schema-mismatch")
    control_bytes = values["sharedControlStorageBytes"]
    _require(values["sharedLimitBytes"] == SHARED_LIMIT_BYTES, "shared-limit-mismatch")
    if domain == "graph":
        prefixes = ("sharedAtEpoch", "sharedAfterQuery", "sharedAfterGraphCleanupAndObservationDrop")
        proofs = ("cgroupPeakReset", "registeredReadyObserved", "readerClosed",
                  "participantReleased", "sourceUnchanged", "filesRetained")
        _require(all(values[key] == 1 for key in proofs), "query-proof-missing")
        _require(values["queryReachedMask"] <= 255 and values["queryFailureMask"] <= 15,
                 "query-mask-out-of-range")
        _require(all(values[key] <= (1 << 31) - 1 for key in SQLITE_REGISTRATION_FIELDS),
                 "query-sqlite-dbstatus-out-of-range")
        _require(0 < values["sqliteBaselineMemoryUsedBytes"]
                 <= values["sqliteQueryMemoryUsedPeakBytes"]
                 and values["sqliteQueryMemoryUsedAfterBytes"] <= values["sqliteQueryMemoryUsedPeakBytes"],
                 "query-sqlite-invalid")
        _require(values["rustQueryRequestedLivePeakBytes"]
                 >= max(values["rustBaselineRequestedLiveBytes"], values["rustQueryRequestedLiveAfterBytes"]),
                 "query-rust-peak-invalid")
        _require(values["cgroupStartupLifetimePeakBytes"] >= values["cgroupStartupBytes"]
                 and values["cgroupRegisteredLifetimePeakBytes"] >= values["cgroupRegisteredBytes"]
                 and values["cgroupQueryPeakBytes"] >= max(values["cgroupQueryBaselineBytes"],
                                                            values["cgroupQueryAfterBytes"]),
                 "query-cgroup-peak-invalid")
    else:
        prefixes = ("sharedAtEpoch", "sharedAfterCase")
        expected_masks = {100: 63, 101: 31, 102: 127}
        _require(case_code in expected_masks and values["assertionMask"] == expected_masks[case_code],
                 "allocator-assertions-invalid")
        _require(values["caseAdmittedRawChargeBytes"] >= values["casePayloadRequestedBytes"]
                 and values["caseRejectedRawChargeBytes"] >= values["caseRejectedPayloadBytes"],
                 "allocator-charge-totals-invalid")
        if case_code == 100:
            _require(values["casePayloadRequestedBytes"] == 8_064
                     and values["caseRejectedPayloadBytes"] == 0
                     and values["caseRejectedRawChargeBytes"] == 0,
                     "allocator-layout-totals-invalid")
        elif case_code == 101:
            _require(values["caseRejectedPayloadBytes"] == 1
                     and values["caseRejectedRawChargeBytes"] > 0,
                     "allocator-limit-totals-invalid")
        else:
            _require(values["caseRejectedPayloadBytes"] == 32_768
                     and values["caseRejectedRawChargeBytes"] > 0,
                     "allocator-realloc-totals-invalid")
        after = "sharedAfterCase"
        _require(values[after + "QueryChargedBytes"] == control_bytes
                 and values[after + "QueryPendingBytes"] == 0,
                 "allocator-case-not-freed")
    _validate_shared_snapshots(values, prefixes, control_bytes)
    return values


def _query_report(mode: str) -> dict:
    # Missing measurements are omitted, never synthesized as zero-byte samples.
    _require(mode in FIXED_CASES, "fixed-case-invalid")
    return {"status": "incomplete", "domain": "graph" if mode in QUERY_CASES else "allocator",
            "caseCode": FIXED_CASES[mode], "startupObserved": 0, "serviceIdentityCaptured": 0,
            "serviceIdentityStable": 0, "registeredReadyObserved": 0, "allocatorArmedObserved": 0,
            "continuationSent": 0, "finalFrameObserved": 0, "case103NoFrameObserved": 0,
            "case103ExpectedExitObserved": 0, "serviceClientReaped": 0, "pipeEofObserved": 0,
            "cgroupRetired": 0, "runtimeDirectoryRemoved": 0, "ownerStateCleared": 0,
            "parentBufferBoundProved": False, "claimsProductAcceptance": False}


def _parse_decimal(value: str, code: str) -> int:
    _require(re.fullmatch(r"[0-9]+", value) is not None, code)
    return int(value)


def _parse_usec(value: str, code: str) -> int:
    units = {"us": 1, "ms": 1_000, "s": 1_000_000, "min": 60_000_000}
    parts = value.split(" ")
    _require(1 <= len(parts) <= 2, code)
    total = 0
    for part in parts:
        match = re.fullmatch(r"([0-9]+)(us|ms|s|min)", part)
        _require(match is not None, code)
        total += int(match.group(1)) * units[match.group(2)]
    return total


def _parse_properties(raw: bytes) -> dict[str, str]:
    _require(len(raw) <= MAX_COMMAND_OUTPUT, "unit-output-too-large")
    values: dict[str, str] = {}
    for raw_line in io.BytesIO(raw):
        line = raw_line.rstrip(b"\n")
        _require(b"=" in line, "unit-output-invalid")
        key_raw, value_raw = line.split(b"=", 1)
        try:
            key = key_raw.decode("ascii")
            value = value_raw.decode("ascii")
        except UnicodeDecodeError as exc:
            raise ProbeError("unit-output-invalid") from exc
        _require(key in UNIT_PROPERTIES and key not in values, "unit-output-invalid")
        values[key] = value
    _require(set(values) == set(UNIT_PROPERTIES), "unit-properties-incomplete")
    return values


def _verify_unit_properties(values: dict[str, str], nonce: str) -> tuple[str, int, int]:
    runtime_directory = _runtime_directory_name(nonce)
    _require(values["RuntimeDirectory"] == runtime_directory, "runtime-directory-mismatch")
    _require(values["RuntimeDirectoryMode"] == "0700", "runtime-directory-mode-mismatch")
    _require(values["RuntimeDirectoryPreserve"] == "no", "runtime-directory-preserve-mismatch")
    _require(values["UMask"] == "0077", "umask-mismatch")
    _require(_parse_decimal(values["MemoryMax"], "memory-property-invalid") == MEMORY_MAX, "memory-property-mismatch")
    _require(_parse_decimal(values["MemorySwapMax"], "swap-property-invalid") == MEMORY_SWAP_MAX, "swap-property-mismatch")
    _require(_parse_usec(values["TimeoutStartUSec"], "start-timeout-invalid") == 5_000_000, "start-timeout-mismatch")
    _require(_parse_usec(values["RuntimeMaxUSec"], "runtime-limit-invalid") == 115_000_000, "runtime-limit-mismatch")
    _require(_parse_usec(values["TimeoutStopUSec"], "stop-timeout-invalid") == 5_000_000, "stop-timeout-mismatch")
    _require(values["KillMode"] == "control-group", "kill-mode-mismatch")
    _require(values["SendSIGKILL"] == "yes", "sigkill-mismatch")
    _require(_parse_decimal(values["LimitCORE"], "core-limit-invalid") == 0, "core-limit-mismatch")
    _require(values["ActiveState"] == "active" and values["SubState"] == "running", "unit-not-running")
    control_group = values["ControlGroup"]
    _require(control_group.startswith("/") and len(control_group) < 1024, "control-group-invalid")
    parts = control_group[1:].split("/")
    _require(all(re.fullmatch(r"[A-Za-z0-9_.@:-]+", p) and p not in (".", "..") for p in parts), "control-group-invalid")
    main_pid = _parse_decimal(values["MainPID"], "main-pid-invalid")
    active_enter_usec = _parse_decimal(values["ActiveEnterTimestampMonotonic"], "active-time-invalid")
    _require(main_pid > 0 and active_enter_usec > 0, "unit-not-running")
    return control_group, main_pid, active_enter_usec


def _runtime_parent_fd() -> int:
    uid = os.geteuid()
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for component in ("run", "user", str(uid)):
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                            dir_fd=fd)
            os.close(fd)
            fd = child
            info = os.fstat(fd)
            _require(stat.S_ISDIR(info.st_mode), "runtime-parent-untrusted")
            if component == str(uid):
                _require(info.st_uid == uid and stat.S_IMODE(info.st_mode) == 0o700,
                         "runtime-parent-untrusted")
            else:
                _require(info.st_uid == 0 and not (info.st_mode & 0o022), "runtime-parent-untrusted")
        return fd
    except BaseException as exc:
        os.close(fd)
        if isinstance(exc, ProbeError):
            raise
        raise ProbeError("runtime-parent-untrusted") from exc


def _runtime_directory_absent(nonce: str) -> bool:
    name = _runtime_directory_name(nonce)
    parent_fd = _runtime_parent_fd()
    try:
        try:
            os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            return True
        except OSError as exc:
            raise ProbeError("runtime-directory-unverifiable") from exc
        return False
    finally:
        os.close(parent_fd)


def _runtime_directory_fd(nonce: str) -> int:
    name = _runtime_directory_name(nonce)
    parent_fd = _runtime_parent_fd()
    try:
        try:
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                         dir_fd=parent_fd)
        except OSError as exc:
            raise ProbeError("runtime-directory-unavailable") from exc
    finally:
        os.close(parent_fd)
    try:
        info = os.fstat(fd)
        _require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid()
                 and stat.S_IMODE(info.st_mode) == 0o700, "runtime-directory-identity-invalid")
        return fd
    except BaseException:
        os.close(fd)
        raise


def _runtime_identity(nonce: str, *, empty: bool = False) -> tuple[int, int]:
    fd = _runtime_directory_fd(nonce)
    try:
        if empty:
            with os.scandir(fd) as entries:
                _require(next(entries, None) is None, "runtime-directory-not-empty")
        info = os.fstat(fd)
        return info.st_dev, info.st_ino
    finally:
        os.close(fd)


def _check_runtime_marker(fd: int) -> None:
    try:
        marker_fd = os.open(RUNTIME_MARKER, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
    except OSError as exc:
        raise ProbeError("runtime-marker-invalid") from exc
    try:
        info = os.fstat(marker_fd)
        _require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                 and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size == 0
                 and info.st_nlink == 1, "runtime-marker-invalid")
    finally:
        os.close(marker_fd)


def _check_runtime_contents(directory_fd: int, *, marker: bool) -> None:
    # Reject extra names before materializing an arbitrarily large directory.
    with os.scandir(directory_fd) as entries:
        first = next(entries, None)
        if marker:
            _require(first is not None and first.name == RUNTIME_MARKER
                     and next(entries, None) is None, "runtime-directory-contents-invalid")
        else:
            _require(first is None, "runtime-directory-not-empty")


def _create_runtime_marker(nonce: str) -> None:
    directory_fd = _runtime_directory_fd(nonce)
    try:
        _check_runtime_contents(directory_fd, marker=False)
        try:
            marker_fd = os.open(RUNTIME_MARKER,
                                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                                0o600, dir_fd=directory_fd)
        except OSError as exc:
            raise ProbeError("runtime-marker-create-failed") from exc
        try:
            info = os.fstat(marker_fd)
            _require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                     and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size == 0
                     and info.st_nlink == 1, "runtime-marker-invalid")
            _check_runtime_contents(directory_fd, marker=True)
        finally:
            os.close(marker_fd)
    finally:
        os.close(directory_fd)


def _verify_runtime_marker(nonce: str) -> None:
    directory_fd = _runtime_directory_fd(nonce)
    try:
        _check_runtime_contents(directory_fd, marker=True)
        _check_runtime_marker(directory_fd)
    finally:
        os.close(directory_fd)


def _parse_cgroup_events(raw: bytes) -> dict[str, int]:
    _require(len(raw) <= 256, "cgroup-events-too-large")
    events: dict[str, int] = {}
    for raw_line in io.BytesIO(raw):
        try:
            line = raw_line.decode("ascii").rstrip("\n")
        except UnicodeDecodeError as exc:
            raise ProbeError("cgroup-events-invalid") from exc
        fields = line.split(" ")
        _require(len(fields) == 2 and fields[0] in ("populated", "frozen"), "cgroup-events-invalid")
        _require(fields[0] not in events and fields[1] in ("0", "1"), "cgroup-events-invalid")
        events[fields[0]] = int(fields[1])
    _require("populated" in events, "cgroup-events-invalid")
    return events


def _check_frame(frame: bytes, expected: bytes, code: str) -> None:
    _require(len(frame) <= MAX_FRAME, "frame-too-large")
    _require(frame.endswith(b"\n") and frame == expected, code)


def _read_fd_limited(fd: int, limit: int) -> bytes:
    chunks = bytearray()
    while len(chunks) <= limit:
        block = os.read(fd, min(1024, limit + 1 - len(chunks)))
        if not block:
            break
        chunks.extend(block)
        if len(chunks) > limit:
            break
    return bytes(chunks)


def _read_small_file(path: str, limit: int) -> bytes:
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
    try:
        return _read_fd_limited(fd, limit)
    finally:
        os.close(fd)


def _parse_self_cgroup(raw: bytes) -> str:
    _require(len(raw) <= 4096, "self-cgroup-too-large")
    path: str | None = None
    for raw_line in io.BytesIO(raw):
        if not raw_line.startswith(b"0::/"):
            continue
        _require(path is None, "cgroup-v2-unavailable")
        try:
            path = raw_line[3:].decode("ascii").rstrip("\n")
        except UnicodeDecodeError as exc:
            raise ProbeError("self-cgroup-invalid") from exc
    _require(path is not None, "cgroup-v2-unavailable")
    # systemd unit names may contain literal \\xNN sequences. Linux does not
    # interpret backslash as a separator: preserve it, never unescape it.
    _require(".." not in path.split("/") and "//" not in path
             and not any(ord(char) < 32 or ord(char) == 127 for char in path), "self-cgroup-invalid")
    return path


def _mountinfo_has_cgroup2() -> bool:
    raw = _read_small_file("/proc/self/mountinfo", 8192)
    _require(len(raw) <= 8192, "mountinfo-too-large")
    matches = 0
    for raw_line in io.BytesIO(raw):
        before, separator, after = raw_line.partition(b" - ")
        if not separator:
            continue
        fields = before.split(b" ", 5)
        filesystem = after.split(b" ", 1)[0]
        if filesystem == b"cgroup2":
            _require(len(fields) >= 5, "mountinfo-invalid")
            if fields[3] == b"/" and fields[4] == b"/sys/fs/cgroup":
                matches += 1
    return matches == 1


def _parse_controllers(raw: bytes) -> list[str]:
    try:
        text = raw.decode("ascii")
    except UnicodeDecodeError as exc:
        raise ProbeError("controller-list-invalid") from exc
    values = text.strip().split(" ")
    _require(len(values) <= 32 and all(re.fullmatch(r"[a-z0-9_]{1,32}", value) for value in values),
             "controller-list-invalid")
    return values


def _preflight_cgroup() -> None:
    _require(_mountinfo_has_cgroup2(), "cgroup-v2-mount-unavailable")
    root_raw = _read_small_file("/sys/fs/cgroup/cgroup.controllers", 1024)
    _require(len(root_raw) <= 1024, "controller-list-too-large")
    root_controllers = _parse_controllers(root_raw)
    _require("memory" in root_controllers, "memory-controller-unavailable")
    del root_controllers, root_raw
    relative = _parse_self_cgroup(_read_small_file("/proc/self/cgroup", 4096))
    current = Path("/sys/fs/cgroup")
    for component in relative.strip("/").split("/") if relative != "/" else ():
        _require(component not in (".", ".."), "self-cgroup-invalid")
        current = current / component
    _require(current.is_dir() and not current.is_symlink(), "self-cgroup-unavailable")
    available_raw = _read_small_file(str(current / "cgroup.controllers"), 1024)
    _require(len(available_raw) <= 1024, "controller-list-too-large")
    available = _parse_controllers(available_raw)
    _require("memory" in available, "memory-controller-not-delegated")
    del available, available_raw
    _require((current / "memory.max").is_file() and (current / "memory.swap.max").is_file(), "memory-cgroup-files-unavailable")


def _preflight_app_slice(cutoff_ns: int | None = None) -> str:
    _, raw = _systemctl(["show", "--no-pager", "--property=ControlGroup", "app.slice"],
                       cutoff_ns=cutoff_ns)
    _require(len(raw) <= MAX_COMMAND_OUTPUT, "slice-output-too-large")
    try:
        line = raw.decode("ascii").strip()
    except UnicodeDecodeError as exc:
        raise ProbeError("slice-output-invalid") from exc
    _require(line.startswith("ControlGroup="), "app-slice-unavailable")
    group = line.split("=", 1)[1]
    _require(group.startswith("/") and len(group) < 1024, "app-slice-path-invalid")
    parts = group[1:].split("/")
    _require(all(re.fullmatch(r"[A-Za-z0-9_.@:-]+", p) and p not in (".", "..") for p in parts), "app-slice-path-invalid")
    directory = _cgroup_directory(group)
    _require(directory.is_dir(), "app-slice-cgroup-unavailable")
    controllers_raw = _read_small_file(str(directory / "cgroup.controllers"), 1024)
    _require(len(controllers_raw) <= 1024, "controller-list-too-large")
    controllers = _parse_controllers(controllers_raw)
    _require("memory" in controllers, "app-slice-memory-not-delegated")
    return group


def _fixed_command(name: str) -> str:
    candidates = {"systemctl": ("/usr/bin/systemctl", "/bin/systemctl"),
                  "systemd-run": ("/usr/bin/systemd-run", "/bin/systemd-run"),
                  "env": ("/usr/bin/env", "/bin/env")}[name]
    for candidate in candidates:
        path = Path(candidate)
        if path.is_file() and os.access(candidate, os.X_OK):
            return str(path.resolve())
    raise ProbeError(f"{name}-unavailable")


def _bounded_command(argv: list[str], timeout: float, allow_failure: bool = False,
                     cutoff_ns: int | None = None) -> tuple[int, bytes]:
    now = time.monotonic()
    deadline = min(now + timeout, cutoff_ns / 1_000_000_000) if cutoff_ns is not None else now + timeout
    _require(deadline > now, "command-deadline-exhausted")
    # Reserve time for kill + actual wait within the SAME command/parent deadline.
    work_deadline = deadline - min(1.0, (deadline - now) / 2)
    try:
        # Descriptor I/O below bypasses Python buffers; the default can exceed 65 KiB per pipe.
        proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, close_fds=True, bufsize=0, pipesize=4096)
    except OSError as exc:
        raise ProbeError("command-start-failed") from exc
    assert proc.stdout is not None
    fd = proc.stdout.fileno()
    output = bytearray()
    try:
        while True:
            remaining = work_deadline - time.monotonic()
            _require(remaining > 0, "command-timeout")
            readable, _, _ = select.select([fd], [], [], remaining)
            _require(bool(readable), "command-timeout")
            block = os.read(fd, min(1024, MAX_COMMAND_OUTPUT + 1 - len(output)))
            if not block:
                break
            output.extend(block)
            _require(len(output) <= MAX_COMMAND_OUTPUT, "command-output-too-large")
        code = proc.wait(timeout=max(0.0, work_deadline - time.monotonic()))
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ProbeError("command-timeout") from exc
    finally:
        try:
            if proc.poll() is None:
                try:
                    proc.kill()
                except OSError:
                    pass  # Only a successful wait below can establish termination.
                try:
                    proc.wait(timeout=max(0.0, deadline - time.monotonic()))
                except (OSError, subprocess.TimeoutExpired) as exc:
                    raise UnresolvedOwner from exc
        finally:
            proc.stdout.close()
    if code != 0 and not allow_failure:
        raise ProbeError("command-failed")
    return code, bytes(output)


def _systemctl(args: list[str], timeout: float = 3.0, allow_failure: bool = False,
               cutoff_ns: int | None = None) -> tuple[int, bytes]:
    # Use the local UID's manager, never a caller-supplied D-Bus destination.
    return _bounded_command([_fixed_command("env"), "-i", f"XDG_RUNTIME_DIR=/run/user/{os.geteuid()}",
                             "LC_ALL=C", _fixed_command("systemctl"), "--user", *args],
                            timeout, allow_failure, cutoff_ns)


def _show_unit(unit: str, cutoff_ns: int | None = None) -> dict[str, str]:
    _require(_unit_for(unit[len(UNIT_PREFIX):-len(".service")]) == unit, "unit-invalid")
    _, raw = _systemctl(["show", "--no-pager", "--property=" + ",".join(UNIT_PROPERTIES), unit],
                       cutoff_ns=cutoff_ns)
    return _parse_properties(raw)


def _cgroup_directory(control_group: str) -> Path:
    _require(control_group.startswith("/"), "control-group-invalid")
    root = Path("/sys/fs/cgroup")
    path = root
    for component in control_group[1:].split("/"):
        _require(component and component not in (".", ".."), "control-group-invalid")
        path = path / component
        try:
            info = path.lstat()
        except FileNotFoundError:
            return path
        _require(stat.S_ISDIR(info.st_mode), "control-group-invalid")
    return path


def _cgroup_snapshot(directory: Path) -> tuple[list[int], dict[str, int]] | None:
    try:
        info = directory.lstat()
    except FileNotFoundError:
        return None
    _require(stat.S_ISDIR(info.st_mode), "control-group-invalid")
    procs_raw = _read_small_file(str(directory / "cgroup.procs"), 64)
    try:
        text = procs_raw.decode("ascii")
    except UnicodeDecodeError as exc:
        raise ProbeError("cgroup-procs-invalid") from exc
    _require(len(procs_raw) <= 64, "cgroup-procs-too-large")
    pids: list[int] = []
    for line in text.splitlines():
        _require(len(pids) == 0, "service-cgroup-process-count-invalid")
        pid = _parse_decimal(line, "cgroup-procs-invalid")
        _require(pid > 0, "cgroup-procs-invalid")
        pids.append(pid)
    events = _parse_cgroup_events(_read_small_file(str(directory / "cgroup.events"), 256))
    return pids, events


def _verify_cgroup_limits(directory: Path) -> None:
    memory = _read_small_file(str(directory / "memory.max"), 128).decode("ascii").strip()
    swap = _read_small_file(str(directory / "memory.swap.max"), 128).decode("ascii").strip()
    _require(memory == str(MEMORY_MAX), "memory-limit-mismatch")
    _require(swap == str(MEMORY_SWAP_MAX), "swap-limit-mismatch")


def _proc_identity(pid: int) -> tuple[int, int] | None:
    _require(pid > 0, "pid-invalid")
    try:
        raw = _read_small_file(f"/proc/{pid}/stat", 4096)
    except FileNotFoundError:
        return None
    _require(len(raw) <= 4096, "proc-stat-too-large")
    try:
        text = raw.decode("ascii")
        close = text.rfind(")")
        head = text[:text.find(" ")]
        rest = text[close + 2:].split()
        _require(int(head) == pid and close > 0 and len(rest) > 19, "proc-stat-invalid")
        start_time = _parse_decimal(rest[19], "proc-stat-invalid")
        return start_time, ord(rest[0])
    except (UnicodeDecodeError, ValueError, IndexError) as exc:
        raise ProbeError("proc-stat-invalid") from exc


def _identity_alive(identity: tuple[int, int, int]) -> bool:
    pid, start_time, _ = identity
    current = _proc_identity(pid)
    return current is not None and current[0] == start_time and current[1] not in (ord("Z"), ord("X"))


def _launcher_child_identity(launcher_pid: int) -> tuple[int, int, int]:
    raw = _read_small_file(f"/proc/{launcher_pid}/task/{launcher_pid}/children", 128)
    _require(len(raw) <= 128, "launcher-children-too-large")
    try:
        fields = raw.decode("ascii").split()
    except UnicodeDecodeError as exc:
        raise ProbeError("launcher-children-invalid") from exc
    _require(len(fields) == 1, "launcher-child-count-invalid")
    pid = _parse_decimal(fields[0], "launcher-children-invalid")
    identity = _proc_identity(pid)
    _require(identity is not None and identity[1] not in (ord("Z"), ord("X")), "launcher-client-not-live")
    return pid, identity[0], identity[1]


def _capture_service(control_group: str, main_pid: int) -> tuple[Path, tuple[int, int, int]]:
    directory = _cgroup_directory(control_group)
    _require(directory.is_dir(), "service-cgroup-missing")
    _verify_cgroup_limits(directory)
    snapshot = _cgroup_snapshot(directory)
    _require(snapshot is not None, "service-cgroup-missing")
    pids, events = snapshot
    _require(pids == [main_pid] and events["populated"] == 1 and events.get("frozen", 0) == 0,
             "service-cgroup-membership-mismatch")
    identity = _proc_identity(main_pid)
    _require(identity is not None and identity[1] not in (ord("Z"), ord("X")), "service-process-not-live")
    return directory, (main_pid, identity[0], identity[1])


def _read_frame(stream, expected: bytes, deadline: float) -> None:
    fd = stream.fileno()
    frame = bytearray()
    while len(frame) <= MAX_FRAME:
        remaining = deadline - time.monotonic()
        _require(remaining > 0, "ready-timeout")
        readable, _, _ = select.select([fd], [], [], remaining)
        _require(bool(readable), "ready-timeout")
        block = os.read(fd, min(512, MAX_FRAME + 1 - len(frame)))
        _require(bool(block), "ready-eof")
        frame.extend(block)
        newline = frame.find(b"\n")
        if newline >= 0:
            _require(newline == len(frame) - 1, "ready-extra-data")
            _check_frame(bytes(frame), expected, "ready-frame-invalid")
            return
        _require(len(frame) <= MAX_FRAME, "frame-too-large")
    raise ProbeError("frame-too-large")


def _read_query_result(stream, deadline: float) -> bytes:
    # Retain at most MAX_FRAME bytes; a one-byte overflow sentinel is never appended.
    # EOF is mandatory even after a syntactically complete frame.
    frame = bytearray()
    while True:
        remaining = deadline - time.monotonic()
        _require(remaining > 0, "query-result-timeout")
        readable, _, _ = select.select([stream.fileno()], [], [], remaining)
        _require(bool(readable), "query-result-timeout")
        block = os.read(stream.fileno(), min(512, MAX_FRAME - len(frame)) or 1)
        if not block:
            return bytes(frame)
        _require(len(frame) < MAX_FRAME, "frame-too-large")
        frame.extend(block)


def _send_frame(stream, frame: bytes) -> None:
    _require(len(frame) <= MAX_FRAME and frame.endswith(b"\n"), "continue-frame-invalid")
    written = os.write(stream.fileno(), frame)
    _require(written == len(frame), "continue-write-failed")


def _read_pipe_available(stream, seen_eof: bool) -> tuple[bool, bool]:
    if seen_eof:
        return True, False
    fd = stream.fileno()
    readable, _, _ = select.select([fd], [], [], 0)
    if not readable:
        return False, False
    data = os.read(fd, 512)
    if not data:
        return True, False
    return False, True


def _drain_to_eof(stream, deadline: float) -> bool:
    fd = stream.fileno()
    bad_output = False
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        readable, _, _ = select.select([fd], [], [], remaining)
        if not readable:
            return False
        data = os.read(fd, 512)
        if not data:
            return not bad_output
        bad_output = True


def _systemd_run_argv(unit: str, nonce: str, mode: str) -> list[str]:
    _require((mode in ("normal", "hold") or mode in FIXED_CASES) and _unit_for(nonce) == unit,
             "mode-invalid")
    runtime_directory = _runtime_directory_name(nonce)
    env = _fixed_command("env")
    python = str(Path(sys.executable).resolve(strict=True))
    script = str(Path(__file__).resolve(strict=True))
    # systemd receives the policy in the same unit-start request; Type=exec places
    # the process in that unit before exec, with no later cgroup move.
    args = [
        env, "-i", f"XDG_RUNTIME_DIR=/run/user/{os.geteuid()}", "LC_ALL=C",
        _fixed_command("systemd-run"), "--user", "--quiet", "--pipe", "--wait",
        "--service-type=exec", "--slice=app.slice", f"--unit={unit}",
        f"--property=MemoryMax={MEMORY_MAX}",
        f"--property=MemorySwapMax={MEMORY_SWAP_MAX}",
        "--property=TimeoutStartSec=5s", "--property=RuntimeMaxSec=115s",
        "--property=TimeoutStopSec=5s", "--property=KillMode=control-group",
        "--property=SendSIGKILL=yes", "--property=LimitCORE=0",
        f"--property=RuntimeDirectory={runtime_directory}",
        "--property=RuntimeDirectoryMode=0700", "--property=RuntimeDirectoryPreserve=no",
        "--property=UMask=0077", "--property=WorkingDirectory=/",
    ]
    if mode != "hold":
        args.append("--collect")
    args.extend([env, "-i", python, "-I", "-S", script, "--service", nonce, mode])
    return args


def _service_read_frame() -> bytes:
    frame = bytearray()
    while len(frame) <= MAX_FRAME:
        block = os.read(0, min(512, MAX_FRAME + 1 - len(frame)))
        if not block:
            return bytes(frame)
        frame.extend(block)
        newline = frame.find(b"\n")
        if newline >= 0:
            if newline != len(frame) - 1:
                return bytes(frame)
            return bytes(frame)
    return bytes(frame)


def _service_main(nonce: str, mode: str) -> int:
    _require(_nonce_ok(nonce) and (mode in ("normal", "hold") or mode in FIXED_CASES),
             "service-args-invalid")
    service_deadline = time.monotonic() + 115.0
    # Direct entry must prove the SAME manager policy before ignoring SIGTERM.
    unit = _unit_for(nonce)
    group = _parse_self_cgroup(_read_small_file("/proc/self/cgroup", 4096))
    cutoff = time.monotonic_ns() + 5_000_000_000
    expected_group = _preflight_app_slice(cutoff) + "/" + unit
    actual_group, main_pid, _ = _verify_unit_properties(_show_unit(unit, cutoff), nonce)
    _require(group == expected_group == actual_group and main_pid == os.getpid(),
             "service-unit-mismatch")
    _verify_cgroup_limits(_cgroup_directory(group))
    if mode in FIXED_CASES:
        binary = _query_binary()
        runtime_identity = _runtime_identity(nonce, empty=True)
        started = f"STARTED {nonce}\n".encode("ascii")
        _require(os.write(1, started) == len(started), "started-write-failed")
        _read_frame(sys.stdin, f"PREPARE {nonce}\n".encode("ascii"), service_deadline)
        _require(_runtime_identity(nonce, empty=True) == runtime_identity, "runtime-identity-changed")
        _require(time.monotonic() < service_deadline, "prepare-timeout")
        # execve preserves the manager PID/start identity, pipes, cgroup and TTL.
        # STARTED/PREPARE is setup admission only; Rust alone emits registered READY.
        os.execve(binary, [binary, mode], {})
        raise ProbeError("query-exec-returned")
    _create_runtime_marker(nonce)
    if mode == "hold":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
    ready = f"READY {nonce}\n".encode("ascii")
    _require(len(ready) <= MAX_FRAME, "ready-frame-invalid")
    try:
        os.write(1, ready)
    except OSError:
        return 3
    if mode == "hold":
        while True:
            signal.pause()
    expected = f"CONTINUE {nonce}\n".encode("ascii")
    received = _service_read_frame()
    return 0 if received == expected and len(received) <= MAX_FRAME else 2


def _home_directory_fd(uid: int) -> int:
    home = Path(pwd.getpwuid(uid).pw_dir)
    _require(home.is_absolute(), "state-home-invalid")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for component in home.parts[1:]:
            _require(component not in (".", ".."), "state-home-invalid")
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = child
        home_stat = os.fstat(fd)
        _require(home_stat.st_uid == uid and not (home_stat.st_mode & 0o022), "state-home-not-private")
        return fd
    except BaseException:
        os.close(fd)
        raise


def _open_or_create_directory(parent_fd: int, name: str, uid: int, private: bool) -> int:
    _require("/" not in name and name not in (".", ".."), "state-path-invalid")
    try:
        os.mkdir(name, 0o700, dir_fd=parent_fd)
    except FileExistsError:
        pass
    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent_fd)
    info = os.fstat(child)
    _require(info.st_uid == uid and not (info.st_mode & 0o022), "state-directory-not-private")
    if private:
        _require(stat.S_IMODE(info.st_mode) == 0o700, "state-directory-mode-invalid")
    return child


def _open_state_directory() -> int:
    uid = os.geteuid()
    home_fd = _home_directory_fd(uid)
    try:
        local_fd = _open_or_create_directory(home_fd, ".local", uid, False)
        state_fd = _open_or_create_directory(local_fd, "state", uid, False)
        owner_fd = _open_or_create_directory(state_fd, "nir1-c-query-linux-host-smoke", uid, True)
        return owner_fd
    finally:
        os.close(home_fd)
        if "local_fd" in locals():
            os.close(local_fd)
        if "state_fd" in locals():
            os.close(state_fd)


def _state_is_clear(directory_fd: int) -> bool:
    with os.scandir(directory_fd) as entries:
        return next(entries, None) is None


def _write_owner(directory_fd: int, nonce: str, unit: str, phase: int,
                 launcher_exit: int | None, child_terminated: int) -> None:
    _require(_nonce_ok(nonce) and unit == _unit_for(nonce), "owner-state-invalid")
    _require(0 <= phase <= 5 and child_terminated in (0, 1), "owner-state-invalid")
    if launcher_exit is not None:
        _require(-255 <= launcher_exit <= 255, "owner-state-invalid")
    data = json.dumps({"nonce": nonce, "unit": unit, "phase": phase,
                       "launcher_exit": launcher_exit,
                       "child_terminated": child_terminated}, separators=(",", ":")).encode("ascii") + b"\n"
    _require(len(data) <= 512, "owner-state-too-large")
    temp = f".owner-{nonce}"
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory_fd)
    try:
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temp, STATE_NAME, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
    os.fsync(directory_fd)


def _remove_owner(directory_fd: int) -> None:
    try:
        os.unlink(STATE_NAME, dir_fd=directory_fd)
        os.fsync(directory_fd)
    except FileNotFoundError:
        pass


def _unit_runtime_state(values: dict[str, str]) -> bool:
    return (values["Result"] == "timeout"
            and values["ActiveState"] == "failed"
            and _parse_decimal(values["ExecMainCode"], "exit-code-invalid") == 2
            and _parse_decimal(values["ExecMainStatus"], "exit-status-invalid") == signal.SIGKILL)


def _wait_cgroup_release(directory: Path, identity: tuple[int, int, int], deadline_ns: int,
                         client_identity: tuple[int, int, int] | None, nonce: str) -> bool:
    while time.monotonic_ns() < deadline_ns:
        # Require disappearance/PID replacement, not merely a zombie state.
        service = _proc_identity(identity[0])
        client = _proc_identity(client_identity[0]) if client_identity is not None else None
        service_reaped = service is None or service[0] != identity[1]
        client_reaped = client_identity is None or client is None or client[0] != client_identity[1]
        if (service_reaped and client_reaped and _cgroup_snapshot(directory) is None
                and _runtime_directory_absent(nonce)):
            return True  # Reaped processes, retired cgroup and manager-removed directory.
        time.sleep(min(0.1, max(0.0, (deadline_ns - time.monotonic_ns()) / 1_000_000_000)))
    return False


def _read_until_ready(stream, nonce: str, start_ns: int) -> None:
    _read_frame(stream, f"READY {nonce}\n".encode("ascii"), (start_ns + START_ACTIVE_LIMIT_NS) / 1_000_000_000)


def _capture_active_unit(unit: str, nonce: str, app_slice_group: str,
                         cutoff_ns: int | None = None) -> tuple[Path, tuple[int, int, int], int, dict[str, str]]:
    values = _show_unit(unit, cutoff_ns)
    control_group, main_pid, active_enter_us = _verify_unit_properties(values, nonce)
    _require(control_group == f"{app_slice_group}/{unit}", "service-slice-mismatch")
    directory, identity = _capture_service(control_group, main_pid)
    return directory, identity, active_enter_us, values


def _wait_launcher(proc: subprocess.Popen, deadline_ns: int) -> int | None:
    try:
        remaining = max(0.0, (deadline_ns - time.monotonic_ns()) / 1_000_000_000)
        return proc.wait(timeout=remaining)
    except (subprocess.TimeoutExpired, OSError):
        return None


def _try_cleanup(unit: str, nonce: str, app_slice_group: str, proc: subprocess.Popen, stream,
                 start_ns: int, directory: Path | None, identity: tuple[int, int, int] | None,
                 client_identity: tuple[int, int, int] | None, pipe_eof: bool) -> bool:
    cutoff = start_ns + TOTAL_LIMIT_NS
    if time.monotonic_ns() >= cutoff:
        return False
    # Close pending admission first; never leave an owner able to submit a late unit.
    if proc.poll() is None:
        try:
            proc.kill()
        except OSError:
            pass
    if _wait_launcher(proc, min(cutoff, time.monotonic_ns() + 1_000_000_000)) is None:
        raise UnresolvedOwner
    if directory is None or identity is None:
        try:
            directory, identity, _, _ = _capture_active_unit(unit, nonce, app_slice_group, cutoff)
        except (ProbeError, OSError):
            pass
    try:
        _systemctl(["stop", unit], timeout=7.0, allow_failure=True, cutoff_ns=cutoff)
        _systemctl(["reset-failed", unit], allow_failure=True, cutoff_ns=cutoff)
    except ProbeError:
        pass
    if directory is None or identity is None:
        return False  # No captured process identity: missing evidence is not cleanup.
    # On an error path discard bounded chunks; only real EOF is retained.
    while time.monotonic_ns() < cutoff:
        if not pipe_eof:
            readable, _, _ = select.select([stream.fileno()], [], [], 0)
            if readable and not os.read(stream.fileno(), 512):
                pipe_eof = True
        if pipe_eof and _wait_cgroup_release(directory, identity, cutoff, client_identity, nonce):
            return True
        time.sleep(min(0.1, max(0.0, (cutoff - time.monotonic_ns()) / 1_000_000_000)))
    return False


def _run_stage(directory_fd: int, mode: str, app_slice_group: str, *,
               nonce: str | None = None, start_ns: int | None = None,
               service_pipe: tuple[int, int] | None = None, ready_fd: int | None = None) -> dict | None:
    nonce = nonce if nonce is not None else os.urandom(16).hex()
    unit = _unit_for(nonce)
    start_ns = start_ns if start_ns is not None else time.monotonic_ns()
    cutoff = start_ns + TOTAL_LIMIT_NS
    query = mode in FIXED_CASES
    graph = mode in QUERY_CASES
    report = _query_report(mode) if query else None
    active_deadline = (start_ns + START_ACTIVE_LIMIT_NS) / 1_000_000_000
    _require(mode == "normal" or query
             or (mode == "hold" and service_pipe is not None and ready_fd is not None),
             "owner-observer-required")
    _write_owner(directory_fd, nonce, unit, 0, None, 0)
    proc: subprocess.Popen | None = None
    stream = None
    cgroup: Path | None = None
    identity: tuple[int, int, int] | None = None
    client_identity: tuple[int, int, int] | None = None
    pipe_eof = False
    try:
        _require(time.monotonic_ns() < start_ns + START_ACTIVE_LIMIT_NS, "owner-start-overdue")
        argv = _systemd_run_argv(unit, nonce, mode)
        _require(_runtime_directory_absent(nonce), "runtime-directory-preexisting")
        proc = subprocess.Popen(argv,
                                stdin=subprocess.DEVNULL if mode == "hold" else subprocess.PIPE,
                                stdout=subprocess.PIPE if service_pipe is None else service_pipe[1],
                                stderr=subprocess.DEVNULL, close_fds=True, bufsize=0, pipesize=4096)
        if service_pipe is None:
            stream = proc.stdout
        else:
            os.close(service_pipe[1])
            stream = os.fdopen(service_pipe[0], "rb", buffering=0)
        assert stream is not None
        client = _proc_identity(proc.pid)
        _require(client is not None, "manager-client-not-live")
        client_identity = (proc.pid, client[0], client[1])
        _write_owner(directory_fd, nonce, unit, 1, None, 0)
        if query:
            _read_frame(stream, f"STARTED {nonce}\n".encode("ascii"), active_deadline)
            # Capture before PREPARE: fixture OOM must not erase the cleanup identity.
            cgroup, identity, _, _ = _capture_active_unit(
                unit, nonce, app_slice_group, start_ns + START_ACTIVE_LIMIT_NS)
            runtime_identity = _runtime_identity(nonce, empty=True)
            report["startupObserved"] = 1
            report["serviceIdentityCaptured"] = 1
            assert proc.stdin is not None
            _require(time.monotonic() < active_deadline, "prepare-timeout")
            _send_frame(proc.stdin, f"PREPARE {nonce}\n".encode("ascii"))
            if graph:
                _read_until_ready(stream, nonce, start_ns)
            else:
                _read_frame(stream, f"ARMED {nonce}\n".encode("ascii"), active_deadline)
                report["allocatorArmedObserved"] = 1
            registered_group, registered_identity, _, _ = _capture_active_unit(
                unit, nonce, app_slice_group, start_ns + START_ACTIVE_LIMIT_NS)
            _require(registered_group == cgroup and registered_identity[:2] == identity[:2],
                     "query-exec-identity-changed")
            _require(_runtime_identity(nonce) == runtime_identity, "runtime-identity-changed")
            report["serviceIdentityStable"] = 1
            if graph:
                report["registeredReadyObserved"] = 1
        else:
            _read_until_ready(stream, nonce, start_ns)
            cgroup, identity, _, _ = _capture_active_unit(unit, nonce, app_slice_group, cutoff)
            _verify_runtime_marker(nonce)
        _write_owner(directory_fd, nonce, unit, 2, None, 0)
        if mode == "hold":
            # This is the real owner: it owns the unit, client handle, state and
            # cleanup deadline. The separate supervisor kills THIS process.
            frame = f"OWNER_READY {nonce}\n".encode("ascii")
            _require(os.write(ready_fd, frame) == len(frame), "owner-ready-write-failed")
            _wait_launcher(proc, start_ns + START_ACTIVE_LIMIT_NS)
            raise ProbeError("fault-owner-was-not-terminated")
        assert proc.stdin is not None
        if query:
            _require(time.monotonic() < active_deadline, "continue-timeout")
        _send_frame(proc.stdin, f"CONTINUE {nonce}\n".encode("ascii"))
        proc.stdin.close()
        if query:
            report["continuationSent"] = 1
            final_frame = _read_query_result(stream, active_deadline)
            pipe_eof = True
        else:
            pipe_eof = _drain_to_eof(stream, active_deadline)
        launcher_exit = _wait_launcher(proc, start_ns + START_ACTIVE_LIMIT_NS)
        _write_owner(directory_fd, nonce, unit, 3, launcher_exit, int(not _identity_alive(identity)))
        _require(pipe_eof, "normal-pipe-not-clean-eof")
        if query:
            _require(type(launcher_exit) is int and -255 <= launcher_exit <= 255,
                     "client-exit-unavailable")
            if mode != "alloc-rust-limit":
                _require(launcher_exit == 0, "normal-client-exit-invalid")
        else:
            _require(launcher_exit == 0, "normal-client-exit-invalid")
        _require(_wait_cgroup_release(cgroup, identity, cutoff, client_identity, nonce),
                 "normal-cleanup-not-verified")
        if query:
            report.update(serviceClientReaped=1, pipeEofObserved=1, cgroupRetired=1,
                          runtimeDirectoryRemoved=1, launcherExitCode=launcher_exit)
        _remove_owner(directory_fd)
        if not _state_is_clear(directory_fd):
            raise UnresolvedOwner
        if query:
            report["ownerStateCleared"] = 1
            if mode == "alloc-rust-limit":
                report["case103NoFrameObserved"] = int(final_frame == b"")
                report["case103ExpectedExitObserved"] = int(
                    report["domain"] == "allocator" and report["caseCode"] == 103
                    and report["startupObserved"] == 1 and report["serviceIdentityCaptured"] == 1
                    and report["serviceIdentityStable"] == 1 and report["registeredReadyObserved"] == 0
                    and report["allocatorArmedObserved"] == 1 and report["continuationSent"] == 1
                    and launcher_exit == 90 and final_frame == b"" and report["finalFrameObserved"] == 0
                    and report["serviceClientReaped"] == 1
                    and report["pipeEofObserved"] == 1 and report["cgroupRetired"] == 1
                    and report["runtimeDirectoryRemoved"] == 1 and report["ownerStateCleared"] == 1)
            else:
                # No frame adoption until identity, EOF, exit, cgroup/runtime and owner clear.
                try:
                    observation = _parse_query_frame(final_frame, FIXED_CASES[mode])
                except ProbeError:
                    pass  # Verified cleanup + invalid/missing frame is a sanitized incomplete.
                else:
                    report.update(observation)
                    report["finalFrameObserved"] = 1
            del final_frame
        return report
    except BaseException as exc:
        if proc is None:
            try:
                absent = _runtime_directory_absent(nonce)
            except (ProbeError, OSError):
                absent = False
            if not absent or isinstance(exc, UnresolvedOwner):
                raise UnresolvedOwner from exc
            _remove_owner(directory_fd)
            if isinstance(exc, ProbeError):
                raise
            raise ProbeError("client-start-failed") from exc
        try:
            if proc.stdin is not None and not proc.stdin.closed:
                proc.stdin.close()
            if (query and identity is not None and isinstance(exc, ProbeError)
                    and exc.code == "ready-eof"):
                # Admission is closed and STARTED identity is known. Preserve a
                # natural client exit instead of racing it with our cleanup kill.
                # No renewed deadline or grace for an uncaptured pending start.
                _wait_launcher(proc, min(cutoff, time.monotonic_ns() + 1_000_000_000))
            cleaned = stream is not None and _try_cleanup(
                unit, nonce, app_slice_group, proc, stream, start_ns, cgroup, identity, client_identity, pipe_eof)
        except Exception:
            cleaned = False
        if cleaned and not isinstance(exc, UnresolvedOwner):
            _remove_owner(directory_fd)
            if query:
                if not _state_is_clear(directory_fd):
                    raise UnresolvedOwner
                _require(type(proc.returncode) is int and -255 <= proc.returncode <= 255,
                         "client-exit-unavailable")
                report.update(serviceClientReaped=1, pipeEofObserved=1, cgroupRetired=1,
                              runtimeDirectoryRemoved=1, ownerStateCleared=1,
                              launcherExitCode=proc.returncode)
                return report
            if isinstance(exc, ProbeError):
                raise
            raise ProbeError("probe-failed") from exc
        try:
            _write_owner(directory_fd, nonce, unit, 5, proc.returncode,
                         int(identity is not None and not _identity_alive(identity)))
        except (OSError, ProbeError):
            pass
        raise UnresolvedOwner from exc
    finally:
        if stream is not None:
            stream.close()
        if proc is not None and proc.stdin is not None:
            proc.stdin.close()


def _owner_main(nonce: str, start_ns: int, directory_fd: int,
                read_fd: int, write_fd: int, ready_fd: int) -> int:
    try:
        _require(_nonce_ok(nonce), "owner-nonce-invalid")
        info = os.fstat(directory_fd)
        _require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid()
                 and stat.S_IMODE(info.st_mode) == 0o700, "owner-directory-invalid")
        _require(all(stat.S_ISFIFO(os.fstat(fd).st_mode) for fd in (read_fd, write_fd, ready_fd)),
                 "owner-pipe-invalid")
        _require(0 <= time.monotonic_ns() - start_ns < START_ACTIVE_LIMIT_NS, "owner-start-invalid")
        app_slice = _preflight_app_slice(start_ns + TOTAL_LIMIT_NS)
        _run_stage(directory_fd, "hold", app_slice, nonce=nonce, start_ns=start_ns,
                   service_pipe=(read_fd, write_fd), ready_fd=ready_fd)
    except (ProbeError, UnresolvedOwner, OSError):
        return 3
    return 2  # A successful fault requires this owner to be killed, never to return.


def _run_owner_death(directory_fd: int, app_slice_group: str) -> None:
    from contextlib import ExitStack

    nonce = os.urandom(16).hex()
    unit = _unit_for(nonce)
    start_ns = time.monotonic_ns()
    cutoff = start_ns + TOTAL_LIMIT_NS
    _write_owner(directory_fd, nonce, unit, 0, None, 0)
    owner: subprocess.Popen | None = None
    cgroup = None
    identity = None
    client_identity = None
    pipe_eof = False
    with ExitStack() as files:
        streams = []
        for _ in range(2):
            read_fd, write_fd = os.pipe2(os.O_CLOEXEC)
            read = files.enter_context(os.fdopen(read_fd, "rb", buffering=0))
            write = files.enter_context(os.fdopen(write_fd, "wb", buffering=0))
            fcntl.fcntl(write_fd, fcntl.F_SETPIPE_SZ, 4096)
            streams.append((read, write))
        (service_read, service_write), (ready_read, ready_write) = streams
        try:
            fds = (directory_fd, service_read.fileno(), service_write.fileno(), ready_write.fileno())
            argv = [str(Path(sys.executable).resolve(strict=True)), "-I", "-S",
                    str(Path(__file__).resolve(strict=True)), "--owner", nonce, str(start_ns),
                    *(str(fd) for fd in fds)]
            owner = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL, close_fds=True, pass_fds=fds)
            service_write.close()
            ready_write.close()
            _read_frame(ready_read, f"OWNER_READY {nonce}\n".encode("ascii"),
                        (start_ns + START_ACTIVE_LIMIT_NS) / 1_000_000_000)
            cgroup, identity, active_us, _ = _capture_active_unit(unit, nonce, app_slice_group, cutoff)
            _verify_runtime_marker(nonce)
            client_identity = _launcher_child_identity(owner.pid)
            _require(active_us * 1000 <= start_ns + 5_000_000_000, "fault-start-overdue")
            owner.kill()  # Kill the process executing _run_stage, not its systemd client.
            owner_exit = _wait_launcher(owner, min(cutoff, time.monotonic_ns() + 2_000_000_000))
            _require(owner_exit == -signal.SIGKILL, "actual-owner-not-reaped")
            _require(_drain_to_eof(ready_read, cutoff / 1_000_000_000), "owner-ready-pipe-not-eof")
            _require(not _state_is_clear(directory_fd), "orphan-state-missing")
            snapshot = _cgroup_snapshot(cgroup)
            _require(snapshot is not None and snapshot[0] == [identity[0]]
                     and snapshot[1]["populated"] == 1 and _identity_alive(identity),
                     "service-not-live-after-owner-death")
            _write_owner(directory_fd, nonce, unit, 3, owner_exit, 0)
            expected_exit_ns = active_us * 1000 + 115_000_000_000
            last_exit_ns = start_ns + START_ACTIVE_LIMIT_NS + STOP_GRACE_NS
            output_after_ready = False
            eof_while_live = False
            while _identity_alive(identity) and time.monotonic_ns() < last_exit_ns:
                eof, output = _read_pipe_available(service_read, pipe_eof)
                if eof and not pipe_eof:
                    eof_while_live = _identity_alive(identity)
                pipe_eof = pipe_eof or eof
                output_after_ready = output_after_ready or output
                time.sleep(min(0.05, max(0.0, (last_exit_ns - time.monotonic_ns()) / 1_000_000_000)))
            _require(not _identity_alive(identity), "manager-did-not-terminate-service")
            status = _show_unit(unit, cutoff)
            inactive_ns = _parse_decimal(status["InactiveEnterTimestampMonotonic"], "inactive-time-invalid") * 1000
            _require(_unit_runtime_state(status) and expected_exit_ns <= inactive_ns <= last_exit_ns,
                     "manager-expiry-not-proved")
            if not pipe_eof:
                pipe_eof = _drain_to_eof(service_read, cutoff / 1_000_000_000)
            _require(pipe_eof and not eof_while_live and not output_after_ready, "service-pipe-not-clean-eof")
            _systemctl(["reset-failed", unit], cutoff_ns=cutoff)
            _require(_wait_cgroup_release(cgroup, identity, cutoff, client_identity, nonce),
                     "fault-cleanup-not-verified")
            _remove_owner(directory_fd)
            _require(_state_is_clear(directory_fd), "owner-state-not-cleared")
        except BaseException as exc:
            if owner is None:
                try:
                    absent = _runtime_directory_absent(nonce)
                except (ProbeError, OSError):
                    absent = False
                if not absent:
                    raise UnresolvedOwner from exc
                _remove_owner(directory_fd)
                raise ProbeError("supervisor-start-failed") from exc
            try:
                cleaned = _try_cleanup(unit, nonce, app_slice_group, owner, service_read, start_ns,
                                       cgroup, identity, client_identity, pipe_eof)
            except Exception:
                cleaned = False
            if cleaned and not isinstance(exc, UnresolvedOwner):
                _remove_owner(directory_fd)
                if isinstance(exc, ProbeError):
                    raise
                raise ProbeError("supervisor-fault-failed") from exc
            try:
                _write_owner(directory_fd, nonce, unit, 5, owner.returncode,
                             int(identity is not None and not _identity_alive(identity)))
            except (OSError, ProbeError):
                pass
            raise UnresolvedOwner from exc


def _preflight() -> str:
    _require(sys.platform == "linux", "linux-only")
    _require(os.geteuid() != 0, "root-not-allowed")
    _fixed_command("systemctl")
    _fixed_command("systemd-run")
    _fixed_command("env")
    python = Path(sys.executable).resolve(strict=True)
    _require(python.is_file() and os.access(python, os.X_OK), "python-unavailable")
    script = Path(__file__).resolve(strict=True)
    _require(script.is_file(), "script-unavailable")
    _, version = _systemctl(["show", "--no-pager", "--property=Version", "--value"])
    _require(re.fullmatch(rb"[0-9][A-Za-z0-9.+:~_-]{0,63}", version.strip()) is not None,
             "user-manager-unavailable")
    _preflight_cgroup()
    return _preflight_app_slice()


def _offline_self_test() -> None:
    from unittest.mock import Mock, patch

    # Interpreter-created stdio buffers are separate from Popen(bufsize=0).
    for name, fd in (("stdin", 0), ("stdout", 1), ("stderr", 2)):
        stream = getattr(sys, name)
        assert type(stream.buffer) is io.FileIO, f"{name} must use raw FileIO"
        assert stream.fileno() == fd and stream.write_through
        assert getattr(sys, f"__{name}__") is stream

    nonce = "0123456789abcdef0123456789abcdef"
    module = sys.modules[__name__]
    # Missing stdio and a valid wrapper for the wrong fd both stop before ownership.
    for bad in (None, sys.stdout):
        with patch.object(sys, "stdin", bad), patch.object(sys, "__stdin__", bad), \
                patch.object(module, "_run_opt_in") as run:
            try:
                main(["--run"])
            except ProbeError as exc:
                assert exc.code == ("stdio-wrapper-invalid" if bad is None else "stdio-fd-invalid")
            else:
                raise AssertionError("invalid stdio admitted an owner")
            run.assert_not_called()
    sample = (
        "MemoryMax=67108864\nMemorySwapMax=0\nTimeoutStartUSec=5s\nRuntimeMaxUSec=1min 55s\n"
        "TimeoutStopUSec=5s\nKillMode=control-group\nSendSIGKILL=yes\nLimitCORE=0\n"
        f"RuntimeDirectory={_runtime_directory_name(nonce)}\nRuntimeDirectoryMode=0700\n"
        "RuntimeDirectoryPreserve=no\nUMask=0077\n"
        "ControlGroup=/user.slice/user-1000.slice/user@1000.service/app.slice/test.service\n"
        "ActiveState=active\nSubState=running\nMainPID=1234\nActiveEnterTimestampMonotonic=1000000\n"
        "Result=\nExecMainCode=0\nExecMainStatus=0\nInactiveEnterTimestampMonotonic=0\n"
    ).encode("ascii")
    parsed = _parse_properties(sample)
    group, pid, active = _verify_unit_properties(parsed, nonce)
    assert group.endswith("test.service") and pid == 1234 and active == 1_000_000
    assert _unit_for(nonce).endswith(nonce + ".service")
    assert _runtime_directory_name(nonce) == "nir1-c-query-probe-" + nonce
    with patch.object(module, "_fixed_command", side_effect=lambda name: "/mock/" + name):
        request = _systemd_run_argv(_unit_for(nonce), nonce, "normal")
    assert all(item in request for item in (
        "--property=RuntimeDirectory=" + _runtime_directory_name(nonce),
        "--property=RuntimeDirectoryMode=0700", "--property=RuntimeDirectoryPreserve=no",
        "--property=UMask=0077", "--property=LimitCORE=0"))
    _check_frame(f"READY {nonce}\n".encode(), f"READY {nonce}\n".encode(), "bad-frame")
    assert _parse_cgroup_events(b"populated 1\nfrozen 0\n") == {"populated": 1, "frozen": 0}
    assert _parse_usec("1min 55s", "bad-time") == 115_000_000
    literal = rb"0::/app.slice/app-example\x2dterminal.scope" + b"\n"
    assert _parse_self_cgroup(literal) == r"/app.slice/app-example\x2dterminal.scope"
    for invalid_path in (b"0::/app.slice/../other\n", b"0::/app.slice//other\n", b"0::/app.slice/\x00other\n"):
        try:
            _parse_self_cgroup(invalid_path)
        except ProbeError:
            continue
        raise AssertionError("unsafe self cgroup path accepted")
    for invalid in (sample + b"MemoryMax=1\n", sample.replace(b"SendSIGKILL=yes", b"SendSIGKILL=no"), sample + b"x" * (MAX_COMMAND_OUTPUT + 1)):
        try:
            values = _parse_properties(invalid)
            _verify_unit_properties(values, nonce)
        except ProbeError:
            continue
        raise AssertionError("unsafe unit-property input accepted")
    try:
        _check_frame(b"READY " + b"x" * MAX_FRAME + b"\n", b"never", "bad-frame")
    except ProbeError:
        pass
    else:
        raise AssertionError("oversize frame accepted")
    for properties in ({**parsed, "MemorySwapMax": "1"}, {**parsed, "LimitCORE": "1"}):
        try:
            _verify_unit_properties(properties, nonce)
        except ProbeError:
            continue
        raise AssertionError("unsafe swap/core limit accepted")
    for bad_properties, expected_nonce in (
        ({**parsed, "RuntimeDirectory": "../" + _runtime_directory_name(nonce)}, nonce),
        ({**parsed, "RuntimeDirectory": _runtime_directory_name("f" * 32)}, nonce),
        (parsed, "f" * 32),
        ({**parsed, "RuntimeDirectoryMode": "0755"}, nonce),
        ({**parsed, "RuntimeDirectoryPreserve": "yes"}, nonce),
        ({**parsed, "UMask": "0022"}, nonce),
    ):
        try:
            _verify_unit_properties(bad_properties, expected_nonce)
        except ProbeError:
            continue
        raise AssertionError("unsafe or mismatched runtime property accepted")
    missing_runtime = sample.replace(
        f"RuntimeDirectory={_runtime_directory_name(nonce)}\n".encode(), b"")
    try:
        _parse_properties(missing_runtime)
    except ProbeError:
        pass
    else:
        raise AssertionError("missing runtime directory property accepted")
    missing_core = sample.replace(b"LimitCORE=0\n", b"")
    try:
        _parse_properties(missing_core)
    except ProbeError:
        pass
    else:
        raise AssertionError("missing core limit property accepted")
    service_group = "/app.slice/" + _unit_for(nonce)
    for properties in (missing_core, sample.replace(b"LimitCORE=0", b"LimitCORE=1")):
        with patch.object(module, "_read_small_file", return_value=f"0::{service_group}\n".encode()), \
                patch.object(module, "_preflight_app_slice", return_value="/app.slice"), \
                patch.object(module, "_show_unit", side_effect=lambda *args, raw=properties: _parse_properties(raw)), \
                patch.object(module, "_verify_cgroup_limits"), \
                patch.object(module, "_query_binary", side_effect=AssertionError("pre-exec limit was not checked")), \
                patch.object(os, "write") as emit, patch.object(os, "execve") as execute:
            try:
                _service_main(nonce, "Q2/R1/D0-local")
            except ProbeError:
                pass
            else:
                raise AssertionError("service accepted missing/nonzero core limit")
            emit.assert_not_called()
            execute.assert_not_called()
    # Runtime-directory checks are mocked: no host runtime path is opened or created.
    import types
    from unittest.mock import MagicMock, call

    def directory_scan(names, limit):
        def entries():
            for index, name in enumerate(names):
                assert index < limit, "directory inspection exceeded its entry bound"
                yield types.SimpleNamespace(name=name)
        scan = MagicMock()
        scan.__enter__.return_value = entries()
        scan.__exit__.return_value = False
        return scan

    marker_stat = types.SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=os.geteuid(),
                                        st_size=0, st_nlink=1)
    for operation, contents, error, created in (
        (_verify_runtime_marker, [()], "runtime-directory-contents-invalid", False),
        (_verify_runtime_marker, [(RUNTIME_MARKER,)], None, False),
        (_verify_runtime_marker, [("wrong", "never", "never")], "runtime-directory-contents-invalid", False),
        (_verify_runtime_marker, [(RUNTIME_MARKER, "extra", "never")], "runtime-directory-contents-invalid", False),
        (_create_runtime_marker, [(), (RUNTIME_MARKER,)], None, True),
        (_create_runtime_marker, [(RUNTIME_MARKER, "never")], "runtime-directory-not-empty", False),
        (_create_runtime_marker, [(), (RUNTIME_MARKER, "extra", "never")], "runtime-directory-contents-invalid", True),
    ):
        scans = [directory_scan(names, 1 if operation is _create_runtime_marker and i == 0 else 2)
                 for i, names in enumerate(contents)]
        with patch.object(module, "_runtime_directory_fd", return_value=73), \
                patch.object(os, "scandir", side_effect=scans) as scan_dir, \
                patch.object(os, "listdir", side_effect=AssertionError("bulk directory listing is forbidden")), \
                patch.object(os, "open", return_value=74) as open_marker, \
                patch.object(os, "fstat", return_value=marker_stat), \
                patch.object(os, "close") as close_fd, \
                patch.object(module, "_check_runtime_marker") as check_marker:
            try:
                operation(nonce)
            except ProbeError as exc:
                assert error is not None and exc.code == error
            else:
                assert error is None, "unexpected runtime contents accepted"
            assert scan_dir.call_args_list == [call(73)] * len(scans)
            for scan in scans:
                scan.__exit__.assert_called_once()
            if created:
                open_marker.assert_called_once_with(
                    RUNTIME_MARKER, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                    0o600, dir_fd=73)
            else:
                open_marker.assert_not_called()
            assert close_fd.call_args_list == ([call(74)] if created else []) + [call(73)]
            if operation is _verify_runtime_marker and error is None:
                check_marker.assert_called_once_with(73)
            else:
                check_marker.assert_not_called()

    with patch.object(module, "_runtime_parent_fd", return_value=73), \
            patch.object(os, "stat", return_value=types.SimpleNamespace(st_mode=stat.S_IFDIR)) as stat_leaf, \
            patch.object(os, "close") as close_parent:
        assert not _runtime_directory_absent(nonce)  # Never adopt a pre-existing leaf.
        stat_leaf.assert_called_once_with(_runtime_directory_name(nonce), dir_fd=73, follow_symlinks=False)
        close_parent.assert_called_once_with(73)
    with patch.object(module, "_runtime_parent_fd", return_value=73), \
            patch.object(os, "stat", side_effect=FileNotFoundError), \
            patch.object(os, "close"):
        assert _runtime_directory_absent(nonce)
    with patch.object(module, "_runtime_parent_fd", return_value=73), \
            patch.object(os, "stat", side_effect=(types.SimpleNamespace(), FileNotFoundError)), \
            patch.object(os, "close"):
        assert not _runtime_directory_absent(nonce)
        assert _runtime_directory_absent(nonce)  # Observe manager removal; never delete manually.
    clock = iter((100, 100, 102))
    with patch.object(module, "_proc_identity", return_value=None), \
            patch.object(module, "_cgroup_snapshot", return_value=None), \
            patch.object(module, "_runtime_directory_absent", return_value=False), \
            patch.object(time, "monotonic_ns", side_effect=lambda: next(clock)), \
            patch.object(time, "sleep"):
        assert not _wait_cgroup_release(Path("/mock/cgroup"), (1234, 1, 0), 101, (4321, 1, 0), nonce)
    with patch.object(module, "_proc_identity", return_value=None), \
            patch.object(module, "_cgroup_snapshot", return_value=None), \
            patch.object(module, "_runtime_directory_absent", return_value=True), \
            patch.object(time, "monotonic_ns", return_value=100):
        assert _wait_cgroup_release(Path("/mock/cgroup"), (1234, 1, 0), 101, (4321, 1, 0), nonce)
    # These mocks exercise error/deadline handling without starting any process.
    with patch.object(subprocess, "Popen") as spawn:
        try:
            _bounded_command(["unused"], 7.0, cutoff_ns=0)
        except ProbeError:
            pass
        else:
            raise AssertionError("expired command deadline accepted")
        spawn.assert_not_called()
    command = Mock()
    command.stdout.fileno.return_value = 1
    command.poll.return_value = None
    command.wait.side_effect = subprocess.TimeoutExpired("unused", 0)
    with patch.object(subprocess, "Popen", return_value=command), \
            patch.object(select, "select", return_value=([1], [], [])), \
            patch.object(os, "read", return_value=b""):
        try:
            _bounded_command(["unused"], 2.0)
        except UnresolvedOwner:
            pass
        else:
            raise AssertionError("unconfirmed command reaping was suppressed")
    command.kill.assert_called_once()
    command.stdout.close.assert_called_once()
    command = Mock()
    command.stdout.fileno.return_value = 1
    command.poll.return_value = 0
    command.wait.return_value = 0
    with patch.object(subprocess, "Popen", return_value=command) as spawn, \
            patch.object(select, "select", return_value=([1], [], [])), \
            patch.object(os, "read", return_value=b""), \
            patch.object(time, "monotonic", return_value=100.0):
        assert _bounded_command(["unused"], 7.0, cutoff_ns=101_000_000_000) == (0, b"")
    assert spawn.call_args.kwargs.get("bufsize", -1) == 0, "command pipe must be unbuffered"
    assert 0 <= command.wait.call_args.kwargs["timeout"] <= 1.0
    # --owner uses the same lifecycle owner as the normal stage, not a launcher.
    with patch.object(os, "fstat", side_effect=lambda fd: types.SimpleNamespace(
            st_mode=stat.S_IFDIR | 0o700 if fd == 3 else stat.S_IFIFO, st_uid=os.geteuid())), \
            patch.object(module, "_preflight_app_slice", return_value="/app.slice"), \
            patch.object(module, "_run_stage") as stage, \
            patch.object(time, "monotonic_ns", return_value=1_000):
        assert _owner_main(nonce, 999, 3, 4, 5, 6) == 2
    stage.assert_called_once_with(3, "hold", "/app.slice", nonce=nonce, start_ns=999,
                                  service_pipe=(4, 5), ready_fd=6)
    service_group = "/app.slice/" + _unit_for(nonce)
    unlimited = {**parsed, "RuntimeMaxUSec": "infinity", "ControlGroup": service_group,
                 "MainPID": str(os.getpid())}
    with patch.object(module, "_read_small_file", return_value=f"0::{service_group}\n".encode()), \
            patch.object(module, "_preflight_app_slice", return_value="/app.slice"), \
            patch.object(module, "_show_unit", return_value=unlimited), \
            patch.object(module, "_verify_cgroup_limits"), \
            patch.object(signal, "pause", side_effect=AssertionError("unlimited hold reached")), \
            patch.object(signal, "signal") as ignore_signal, patch.object(os, "write") as emit:
        try:
            _service_main(nonce, "hold")
        except ProbeError:
            pass
        else:
            raise AssertionError("direct service accepted an unlimited unit")
        ignore_signal.assert_not_called()
        emit.assert_not_called()
    _offline_query_test()
    print("OFFLINE_SELF_TEST_OK")


def _offline_query_test() -> None:
    from contextlib import ExitStack
    from unittest.mock import Mock, patch

    module = sys.modules[__name__]
    nonce = "0123456789abcdef0123456789abcdef"
    case = "Q2/R1/D0-local"

    def rejects(call) -> None:
        try:
            call()
        except ProbeError:
            return
        raise AssertionError("unsafe query input accepted")

    # Schema 4 is a fixed ordered grammar; domain comes from the parent allowlist.
    def set_snapshot(values, prefix, *, charged, highwater, rust_live, rust_peak, baseline=0):
        values.update({
            prefix + "BaselineRawBytes": baseline,
            prefix + "BaselinePendingBytes": 0,
            prefix + "QueryChargedBytes": charged,
            prefix + "QueryPendingBytes": 0,
            prefix + "QueryHighWaterBytes": highwater,
            prefix + "RustRequestedLiveBytes": rust_live,
            prefix + "RustRequestedPendingBytes": 0,
            prefix + "RustRequestedPeakBytes": rust_peak,
        })

    def graph_values(**changes):
        values = {key: 0 for key in GRAPH_FRAME_FIELDS}
        values.update(schemaVersion=5, domain="graph", caseCode=2, diagnosticStatus="incomplete",
                      claimsProductAcceptance=False, checkpointCode=86, queryStatus="available",
                      queryElapsedNsApprox=10, closeElapsedNsApprox=20,
                      rustBaselineRequestedLiveBytes=100, rustQueryRequestedLivePeakBytes=200,
                      rustQueryRequestedLiveAfterBytes=150, sqliteBaselineMemoryUsedBytes=100,
                      sqliteQueryMemoryUsedPeakBytes=300, sqliteQueryMemoryUsedAfterBytes=250,
                      cgroupStartupBytes=100, cgroupStartupLifetimePeakBytes=120,
                      cgroupRegisteredBytes=130, cgroupRegisteredLifetimePeakBytes=140,
                      cgroupQueryBaselineBytes=100, cgroupQueryPeakBytes=200,
                      cgroupQueryAfterBytes=150, queryReachedMask=255, queryFailureMask=15,
                      cgroupPeakReset=1, registeredReadyObserved=1, readerClosed=1,
                      participantReleased=1, sourceUnchanged=1, filesRetained=1,
                      sharedLimitBytes=SHARED_LIMIT_BYTES, sharedControlStorageBytes=128)
        set_snapshot(values, "sharedAtEpoch", charged=128, highwater=128,
                     rust_live=100, rust_peak=100, baseline=64)
        set_snapshot(values, "sharedAfterQuery", charged=200, highwater=200,
                     rust_live=150, rust_peak=220, baseline=64)
        set_snapshot(values, "sharedAfterGraphCleanupAndObservationDrop", charged=128,
                     highwater=200, rust_live=120, rust_peak=220, baseline=64)
        values.update(changes)
        return values

    def graph_frame(**changes):
        return json.dumps(graph_values(**changes), separators=(",", ":")).encode("ascii") + b"\n"

    def allocator_values(case_code=100, **changes):
        values = {key: 0 for key in ALLOCATOR_FRAME_FIELDS}
        payload, admitted, rejected, rejected_raw, mask = {
            100: (8_064, 9_000, 0, 0, 63),
            101: (SHARED_LIMIT_BYTES + 1, SHARED_LIMIT_BYTES + 100, 1, 64, 31),
            102: (SHARED_LIMIT_BYTES + 100, SHARED_LIMIT_BYTES + 200, 32_768, 32_832, 127),
        }.get(case_code, (0, 0, 0, 0, 0))
        values.update(schemaVersion=5, domain="allocator", caseCode=case_code,
                      diagnosticStatus="incomplete", claimsProductAcceptance=False,
                      checkpointCode=86, sharedLimitBytes=SHARED_LIMIT_BYTES,
                      sharedControlStorageBytes=128, casePayloadRequestedBytes=payload,
                      caseAdmittedRawChargeBytes=admitted, caseRejectedPayloadBytes=rejected,
                      caseRejectedRawChargeBytes=rejected_raw, assertionMask=mask)
        set_snapshot(values, "sharedAtEpoch", charged=128, highwater=128,
                     rust_live=0, rust_peak=0, baseline=1_024)
        set_snapshot(values, "sharedAfterCase", charged=128,
                     highwater=SHARED_LIMIT_BYTES if case_code != 100 else 4_096,
                     rust_live=0, rust_peak=SHARED_LIMIT_BYTES if case_code != 100 else 2_048)
        values.update(changes)
        return values

    def allocator_frame(case_code=100, **changes):
        return json.dumps(allocator_values(case_code, **changes),
                          separators=(",", ":")).encode("ascii") + b"\n"

    values = graph_values()
    valid = graph_frame()
    assert _parse_query_frame(valid, 2) == values
    assert _parse_query_frame(graph_frame(caseCode=513), 513)["caseCode"] == 513
    # All six current DBSTATUS values are required, approximate signed-int counters.
    for key in SQLITE_REGISTRATION_FIELDS:
        assert _parse_query_frame(graph_frame(**{key: (1 << 31) - 1}), 2)[key] == (1 << 31) - 1
        for bad in ((1 << 31), U64_MAX, -1, True, 1.5):
            rejects(lambda key=key, bad=bad: _parse_query_frame(graph_frame(**{key: bad}), 2))
        missing = graph_values()
        del missing[key]
        rejects(lambda missing=missing: _parse_query_frame(
            json.dumps(missing, separators=(",", ":")).encode("ascii") + b"\n", 2))
    assert _parse_query_frame(graph_frame(sharedAtEpochBaselineRawBytes=U64_MAX), 2)[
        "sharedAtEpochBaselineRawBytes"] == U64_MAX
    assert _parse_query_frame(graph_frame(
        sharedAfterQueryQueryPendingBytes=72, sharedAfterQueryRustRequestedPendingBytes=1), 2)[
            "sharedAfterQueryRustRequestedPendingBytes"] == 1
    for status in ("unavailable", "error"):
        assert _parse_query_frame(graph_frame(queryStatus=status), 2)["queryStatus"] == status
    assert _parse_query_frame(allocator_frame(100), 100)["domain"] == "allocator"
    assert _parse_query_frame(allocator_frame(101), 101)["casePayloadRequestedBytes"] > SHARED_LIMIT_BYTES
    assert _parse_query_frame(allocator_frame(102), 102)["casePayloadRequestedBytes"] > SHARED_LIMIT_BYTES
    assert _parse_query_frame(allocator_frame(
        101, casePayloadRequestedBytes=U64_MAX, caseAdmittedRawChargeBytes=U64_MAX), 101)[
            "casePayloadRequestedBytes"] == U64_MAX
    for case_code in (100, 101, 102):
        assert _parse_query_frame(allocator_frame(case_code), case_code)["assertionMask"] == {
            100: 63, 101: 31, 102: 127}[case_code]
    for changes in (
        {"schemaVersion": 4}, {"domain": "allocator"}, {"caseCode": 513},
        {"claimsProductAcceptance": True}, {"checkpointCode": 85},
        {"rustQueryRequestedLivePeakBytes": U64_MAX + 1},
        {"rustQueryRequestedLiveAfterBytes": -1}, {"rustBaselineRequestedLiveBytes": 1.5},
        {"rustBaselineRequestedLiveBytes": True}, {"sqliteBaselineMemoryUsedBytes": 0},
        {"sqliteQueryMemoryUsedPeakBytes": 0}, {"cgroupQueryPeakBytes": 0},
        {"queryReachedMask": 256}, {"queryFailureMask": 16}, {"readerClosed": 0},
        {"queryStatus": "PASS"}, {"diagnosticStatus": "observation-only"},
        {"filesRetained": None}, {"queryReachedMask": []},
        {"sharedControlStorageBytes": 0},
        {"sharedAfterQueryQueryChargedBytes": SHARED_LIMIT_BYTES + 1},
        {"sharedAfterQueryQueryPendingBytes": 73},
        {"sharedAtEpochRustRequestedPendingBytes": 1},
        {"sharedAfterQueryQueryPendingBytes": 72, "sharedAfterQueryRustRequestedPendingBytes": 73},
        {"sharedAfterQueryQueryHighWaterBytes": 199},
        {"sharedAfterQueryRustRequestedPeakBytes": 0},
        {"extra": 1},
    ):
        rejects(lambda changes=changes: _parse_query_frame(graph_frame(**changes), 2))
    for code, changes in (
        (100, {"assertionMask": 62}), (101, {"assertionMask": 31, "caseRejectedPayloadBytes": 0}),
        (101, {"assertionMask": 30}), (102, {"caseRejectedPayloadBytes": 1}),
        (102, {"caseAdmittedRawChargeBytes": 1}),
        (101, {"sharedAfterCaseQueryChargedBytes": 129}),
        (101, {"sharedAfterCaseQueryPendingBytes": 1}),
        (102, {"sharedAfterCaseRustRequestedPendingBytes": 1}),
    ):
        rejects(lambda code=code, changes=changes: _parse_query_frame(allocator_frame(code, **changes), code))
    rejects(lambda: _parse_query_frame(allocator_frame(103), 103))  # Fault case has no frame.
    for invalid in (valid + valid, valid + b" ", valid[:-1], b"x" * (MAX_FRAME + 1),
                    valid.replace(b'"schemaVersion":5', b'"schemaVersion":05'),
                    valid.replace(b'"schemaVersion":5', b'"schemaVersion":5e0'),
                    valid.replace(b'"schemaVersion":5', b'"schemaVersion":5,"schemaVersion":5'),
                    valid.replace(b'"caseCode":2,', b''),
                    valid.replace(b'"domain":"graph"', b'"domain":"allocator"')):
        rejects(lambda invalid=invalid: _parse_query_frame(invalid, 2))
    # No host pipes: bounded reads require EOF, reject overflow before retaining it.
    stream = Mock()
    stream.fileno.return_value = 81
    with patch.object(select, "select", return_value=([81], [], [])), \
            patch.object(time, "monotonic", return_value=1.0):
        with patch.object(os, "read", side_effect=[valid[i:i + 512] for i in range(0, len(valid), 512)] + [b""]):
            assert _read_query_result(stream, 2.0) == valid
        with patch.object(os, "read", side_effect=([b"x" * 512] * 8 + [b"x"])) as read:
            rejects(lambda: _read_query_result(stream, 2.0))
            assert read.call_args.args[1] == 1
        with patch.object(select, "select", side_effect=(([81], [], []), ([], [], []))), \
                patch.object(os, "read", return_value=valid):
            rejects(lambda: _read_query_result(stream, 2.0))  # Frame without EOF.
        with patch.object(os, "read") as read:
            rejects(lambda: _read_query_result(stream, 1.0))
            read.assert_not_called()

    # Public argv has no binary/path/env/DB/manifest override and never invokes the fault supervisor.
    with patch.object(module, "_run_opt_in", return_value=2) as run:
        assert main(["--run"]) == 2
        assert run.call_args.args == ()
        for fixed in QUERY_CASES:
            assert main(["--query", fixed]) == 2 and run.call_args.args == (fixed,)
        for fixed in ALLOCATOR_CASES:
            assert main(["--allocator", fixed]) == 2 and run.call_args.args == (fixed,)
        run.reset_mock()
        for args in (["--query"], ["--query", "Q2"], ["--query", case, "/tmp/db"],
                     ["--query", case, "Q513/R3/D0"], ["--query", "alloc-layout"],
                     ["--allocator"], ["--allocator", "alloc-layout", "/tmp/db"],
                     ["--allocator", "alloc-layout/1"]):
            assert main(args) == 2
        run.assert_not_called()
    with patch.object(module, "_fixed_command", side_effect=lambda name: "/mock/" + name):
        for fixed in FIXED_CASES:
            argv = _systemd_run_argv(_unit_for(nonce), nonce, fixed)
            assert argv[-3:] == ["--service", nonce, fixed]
            assert "--collect" in argv and "--property=MemoryMax=67108864" in argv
            assert "--property=MemorySwapMax=0" in argv and "--property=RuntimeMaxSec=115s" in argv
            assert "--property=LimitCORE=0" in argv
        assert "--collect" not in _systemd_run_argv(_unit_for(nonce), nonce, "hold")
    with patch.object(Path, "is_file", return_value=True), \
            patch.object(Path, "is_symlink", return_value=False), patch.object(os, "access", return_value=True):
        binary = _query_binary()
    assert binary == str(Path(__file__).resolve().parents[2] / "src-tauri/target/release/nir1-c-query-linux-probe")

    # Entry-point lock/preflight stays shared; query runs exactly one case, not the fault test.
    with patch.object(sys, "platform", "linux"), patch.object(os, "geteuid", return_value=1000), \
            patch.object(module, "_open_state_directory", return_value=73), \
            patch.object(fcntl, "flock"), patch.object(os, "close"), \
            patch.object(module, "_state_is_clear", return_value=True), \
            patch.object(module, "_preflight", return_value="/app.slice"), \
            patch.object(module, "_query_binary", return_value=binary), \
            patch.object(module, "_run_stage", return_value=_query_report(case)) as stage, \
            patch.object(module, "_run_owner_death") as fault, \
            patch("builtins.print") as output:
        assert _run_opt_in() == 2
        stage.assert_called_once_with(73, "normal", "/app.slice")
        fault.assert_called_once_with(73, "/app.slice")
        fault.reset_mock()
        stage.reset_mock()
        assert _run_opt_in(case) == 2
        stage.assert_called_once_with(73, case, "/app.slice")
        fault.assert_not_called()
        assert '"status":"incomplete"' in output.call_args.args[0]
        stage.reset_mock()
        assert _run_opt_in("alloc-layout") == 2
        stage.assert_called_once_with(73, "alloc-layout", "/app.slice")
        fault.assert_not_called()
        stage.side_effect = UnresolvedOwner
        with patch.object(module, "_state_is_clear", return_value=False):
            output.reset_mock()
            assert _run_opt_in(case) == 3  # Existing owner is quarantined before launch.
            output.assert_not_called()
        with patch.object(module, "_state_is_clear", side_effect=(True, False)):
            output.reset_mock()
            assert _run_opt_in(case) == 3  # Unknown retirement emits no report.
            output.assert_not_called()

    class ExecReplacement(Exception):
        pass

    # Only a policy-checked bootstrap emits STARTED; PREPARE precedes same-PID execve.
    group = "/app.slice/" + _unit_for(nonce)
    events = []
    with ExitStack() as stack:
        def patched(name, **kwargs):
            return stack.enter_context(patch.object(module, name, **kwargs))
        patched("_read_small_file", return_value=f"0::{group}\n".encode())
        patched("_preflight_app_slice", return_value="/app.slice")
        patched("_show_unit", return_value={})
        policy = patched("_verify_unit_properties", return_value=(group, os.getpid(), 1))
        patched("_cgroup_directory", return_value=Path("/mock/cgroup"))
        patched("_verify_cgroup_limits")
        patched("_query_binary", return_value=binary)
        patched("_runtime_identity", return_value=(1, 2))
        marker = patched("_create_runtime_marker")
        gate = patched("_read_frame", side_effect=lambda *args: events.append("prepare"))
        emit = stack.enter_context(patch.object(os, "write", side_effect=lambda fd, data:
                                                events.append(data) or len(data)))
        execute = stack.enter_context(patch.object(os, "execve", side_effect=ExecReplacement))
        try:
            _service_main(nonce, case)
        except ExecReplacement:
            pass
        else:
            raise AssertionError("bootstrap did not exec")
        assert events == [f"STARTED {nonce}\n".encode(), "prepare"]
        execute.assert_called_once_with(binary, [binary, case], {})
        marker.assert_not_called()
        execute.reset_mock()
        gate.side_effect = ProbeError("prepare-timeout")
        rejects(lambda: _service_main(nonce, case))
        execute.assert_not_called()
        emit.reset_mock()
        policy.side_effect = ProbeError("unit-policy-invalid")
        rejects(lambda: _service_main(nonce, case))
        emit.assert_not_called()
        execute.assert_not_called()

    # Exercise the existing owner, entirely mocked; no processes, files or pipes are created.
    with ExitStack() as stack:
        def patched(name, **kwargs):
            return stack.enter_context(patch.object(module, name, **kwargs))
        proc = Mock(pid=4321, returncode=0)
        proc.stdin.closed = False
        spawn = stack.enter_context(patch.object(subprocess, "Popen", return_value=proc))
        stack.enter_context(patch.object(time, "monotonic_ns", return_value=100))
        clock = stack.enter_context(patch.object(time, "monotonic", return_value=0.0))
        patched("_systemd_run_argv", return_value=["mock-only"])
        patched("_runtime_directory_absent", return_value=True)
        patched("_write_owner")
        clear = patched("_remove_owner")
        owner_clear = patched("_state_is_clear", return_value=True)
        patched("_proc_identity", return_value=(123, ord("R")))
        identity = (1234, 5678, ord("R"))
        cgroup = Path("/mock/cgroup")
        capture = patched("_capture_active_unit", return_value=(cgroup, identity, 1, {}))
        runtime = patched("_runtime_identity", return_value=(1, 2))
        started = patched("_read_frame")
        ready = patched("_read_until_ready")
        sent = patched("_send_frame")
        result = patched("_read_query_result", return_value=valid)
        waited = patched("_wait_launcher", return_value=0)
        patched("_identity_alive", return_value=False)
        retired = patched("_wait_cgroup_release", return_value=True)
        cleanup = patched("_try_cleanup", return_value=True)
        marker = patched("_verify_runtime_marker")
        drain = patched("_drain_to_eof", return_value=True)
        parser = patched("_parse_query_frame", wraps=_parse_query_frame)
        order = Mock()
        for name, mock in (("capture", capture), ("runtime", runtime), ("send", sent),
                           ("retired", retired), ("parse", parser), ("clear", clear),
                           ("owner_clear", owner_clear), ("waited", waited), ("cleanup", cleanup)):
            order.attach_mock(mock, name)
        report = _run_stage(3, case, "/app.slice", nonce=nonce, start_ns=100)
        assert spawn.call_args.kwargs.get("bufsize", -1) == 0, "service pipes must be unbuffered"
        assert report["startupObserved"] == report["registeredReadyObserved"] == report["finalFrameObserved"] == 1
        assert report["runtimeDirectoryRemoved"] == 1 and report["status"] == "incomplete"
        assert report["parentBufferBoundProved"] is False and report["launcherExitCode"] == 0
        names = [call[0] for call in order.mock_calls]
        assert names.index("capture") < names.index("runtime") < names.index("send")
        assert names.index("retired") < names.index("clear") < names.index("owner_clear") < names.index("parse")
        assert sent.call_args_list[0].args[1] == f"PREPARE {nonce}\n".encode()
        assert sent.call_args_list[1].args[1] == f"CONTINUE {nonce}\n".encode()
        assert result.call_args.args[1] == (100 + START_ACTIVE_LIMIT_NS) / 1_000_000_000
        marker.assert_not_called()
        # Allocator cases use ARMED, never the Graph registration READY assertion.
        result.return_value = allocator_frame(100)
        started.reset_mock()
        parser.reset_mock()
        order.reset_mock()
        report = _run_stage(3, "alloc-layout", "/app.slice", nonce=nonce, start_ns=100)
        assert report["domain"] == "allocator" and report["allocatorArmedObserved"] == 1
        assert report["registeredReadyObserved"] == 0 and report["serviceIdentityStable"] == 1
        assert report["finalFrameObserved"] == 1 and report["ownerStateCleared"] == 1
        assert started.call_args_list[0].args[1] == f"STARTED {nonce}\n".encode()
        assert started.call_args_list[1].args[1] == f"ARMED {nonce}\n".encode()
        assert parser.call_args.args[1] == ALLOCATOR_CASES["alloc-layout"]
        names = [call[0] for call in order.mock_calls]
        assert names.index("retired") < names.index("clear") < names.index("owner_clear") < names.index("parse")
        # Case 103 succeeds only as an empty stream + propagated natural exit 90
        # after all captured identity, terminal and owner-state facts hold.
        result.return_value = b""
        proc.returncode = waited.return_value = 90
        parser.reset_mock()
        order.reset_mock()
        fault_report = _run_stage(3, "alloc-rust-limit", "/app.slice", nonce=nonce, start_ns=100)
        assert fault_report["allocatorArmedObserved"] == fault_report["continuationSent"] == 1
        assert fault_report["case103NoFrameObserved"] == fault_report["case103ExpectedExitObserved"] == 1
        assert fault_report["finalFrameObserved"] == 0 and fault_report["ownerStateCleared"] == 1
        parser.assert_not_called()
        for exit_code, frame_bytes in ((0, b""), (91, b""), (92, b""),
                                       (93, b""), (90, b"unexpected\\n")):
            proc.returncode = waited.return_value = exit_code
            result.return_value = frame_bytes
            parser.reset_mock()
            fault_report = _run_stage(3, "alloc-rust-limit", "/app.slice", nonce=nonce, start_ns=100)
            assert fault_report["case103ExpectedExitObserved"] == 0
            assert fault_report["case103NoFrameObserved"] == int(frame_bytes == b"")
            parser.assert_not_called()
        proc.returncode = waited.return_value = 90
        result.return_value = b""
        def reject_armed_frame(_stream, expected, _deadline):
            if expected == f"ARMED {nonce}\n".encode():
                raise ProbeError("ready-frame-invalid")
        started.side_effect = reject_armed_frame
        sent.reset_mock()
        fault_report = _run_stage(3, "alloc-rust-limit", "/app.slice", nonce=nonce, start_ns=100)
        assert fault_report["case103ExpectedExitObserved"] == 0 and sent.call_count == 1
        started.side_effect = None
        capture.side_effect = [(cgroup, identity, 1, {}), (cgroup, (99, 99, 0), 1, {})]
        sent.reset_mock()
        fault_report = _run_stage(3, "alloc-rust-limit", "/app.slice", nonce=nonce, start_ns=100)
        assert fault_report["case103ExpectedExitObserved"] == 0 and sent.call_count == 1
        capture.side_effect = None
        # Unknown cleanup cannot mint fault evidence or return a report.
        retired.return_value = False
        cleanup.return_value = False
        clear.reset_mock()
        try:
            _run_stage(3, "alloc-rust-limit", "/app.slice", nonce=nonce, start_ns=100)
        except UnresolvedOwner:
            pass
        else:
            raise AssertionError("case 103 reported before complete cleanup")
        clear.assert_not_called()
        retired.return_value = cleanup.return_value = True
        owner_clear.return_value = False
        try:
            _run_stage(3, "alloc-rust-limit", "/app.slice", nonce=nonce, start_ns=100)
        except UnresolvedOwner:
            pass
        else:
            raise AssertionError("case 103 reported before owner-state clearing")
        owner_clear.return_value = True
        proc.returncode = waited.return_value = 0
        result.return_value = valid
        # Setup OOM/EOF after STARTED keeps the original PID/cgroup for cleanup.
        ready.side_effect = ProbeError("ready-eof")
        proc.returncode = waited.return_value = 73
        waited.reset_mock()
        parser.reset_mock()
        order.reset_mock()
        report = _run_stage(3, case, "/app.slice", nonce=nonce, start_ns=100)
        assert report["startupObserved"] == 1 and report["registeredReadyObserved"] == 0
        assert report["finalFrameObserved"] == 0 and report["pipeEofObserved"] == 1
        assert report["launcherExitCode"] == 73
        waited.assert_called_once_with(proc, 100 + 1_000_000_000)
        names = [call[0] for call in order.mock_calls]
        assert names.index("waited") < names.index("cleanup")
        assert cleanup.call_args.args[6:8] == (cgroup, identity)
        parser.assert_not_called()
        # The extra observation wait cannot overrun the original total cutoff.
        with patch.object(time, "monotonic_ns", side_effect=(100, 100 + TOTAL_LIMIT_NS - 5)):
            _run_stage(3, case, "/app.slice", nonce=nonce, start_ns=100)
        waited.assert_called_with(proc, 100 + TOTAL_LIMIT_NS)
        # No grace for an uncaptured pending start, and no invented zero status.
        started.side_effect = ProbeError("ready-eof")
        waited.reset_mock()
        _run_stage(3, case, "/app.slice", nonce=nonce, start_ns=100)
        waited.assert_not_called()
        started.side_effect = None
        for invalid_exit in (None, True, 256, -256):
            proc.returncode = waited.return_value = invalid_exit
            rejects(lambda: _run_stage(3, case, "/app.slice", nonce=nonce, start_ns=100))
        proc.returncode = waited.return_value = -9
        assert _run_stage(3, case, "/app.slice", nonce=nonce, start_ns=100)["launcherExitCode"] == -9
        proc.returncode = waited.return_value = 0
        cleanup.return_value = False
        clear.reset_mock()
        try:
            _run_stage(3, case, "/app.slice", nonce=nonce, start_ns=100)
        except UnresolvedOwner:
            pass
        else:
            raise AssertionError("unknown cleanup returned a report")
        clear.assert_not_called()
        cleanup.return_value = True
        ready.side_effect = None
        # A changed exec PID is rejected before CONTINUE; never adopt the replacement.
        capture.side_effect = [(cgroup, identity, 1, {}), (cgroup, (99, 99, 0), 1, {})]
        sent.reset_mock()
        report = _run_stage(3, case, "/app.slice", nonce=nonce, start_ns=100)
        assert report["registeredReadyObserved"] == 0 and sent.call_count == 1
        assert cleanup.call_args.args[6:8] == (cgroup, identity)
        capture.side_effect = None
        # Admission cannot renew the original absolute active deadline.
        clock.return_value = (100 + START_ACTIVE_LIMIT_NS) / 1_000_000_000
        sent.reset_mock()
        report = _run_stage(3, case, "/app.slice", nonce=nonce, start_ns=100)
        assert report["continuationSent"] == 0
        sent.assert_not_called()
        clock.return_value = 0.0
        for invalid in (b"", valid + valid):
            result.return_value = invalid
            report = _run_stage(3, case, "/app.slice", nonce=nonce, start_ns=100)
            assert report["finalFrameObserved"] == 0 and report["serviceClientReaped"] == 1
        result.side_effect = ProbeError("query-result-timeout")
        parser.reset_mock()
        report = _run_stage(3, case, "/app.slice", nonce=nonce, start_ns=100)
        parser.assert_not_called()
        assert report["finalFrameObserved"] == 0
        # Original benign normal remains READY/CONTINUE + marker + clean EOF, no parser.
        sent.reset_mock()
        started.reset_mock()
        assert _run_stage(3, "normal", "/app.slice", nonce=nonce, start_ns=100) is None
        marker.assert_called_once_with(nonce)
        drain.assert_called_once()
        started.assert_not_called()
        assert sent.call_count == 1 and sent.call_args.args[1] == f"CONTINUE {nonce}\n".encode()
        parser.assert_not_called()
    # Retirement requires actual service/client reap AND cgroup AND directory absence.
    for identities, snapshot, absent in (
        (((5678, ord("Z")), None), None, True),
        ((None, (123, ord("Z"))), None, True),
        ((None, None), ([], {"populated": 0}), True),
        ((None, None), None, False),
    ):
        with patch.object(module, "_proc_identity", side_effect=identities), \
                patch.object(module, "_cgroup_snapshot", return_value=snapshot), \
                patch.object(module, "_runtime_directory_absent", return_value=absent), \
                patch.object(time, "monotonic_ns", side_effect=(100, 100, 102)), \
                patch.object(time, "sleep"):
            assert not _wait_cgroup_release(Path("/mock/cgroup"), (1234, 5678, 0), 101,
                                           (4321, 123, 0), nonce)


def _run_opt_in(mode: str = "normal") -> int:
    _require(mode == "normal" or mode in FIXED_CASES, "mode-invalid")
    query = mode in FIXED_CASES
    try:
        _require(sys.platform == "linux" and os.geteuid() != 0, "unprivileged-linux-only")
        owner_fd = _open_state_directory()
    except ProbeError as exc:
        if query:
            return 3  # Cannot establish private owner state: no terminal report.
        print(f"BLOCK preflight_{exc.code}")
        return 2
    except (OSError, KeyError, PermissionError):
        if query:
            return 3
        print("BLOCK preflight_private-state-unavailable")
        return 2
    try:
        try:
            fcntl.flock(owner_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 3
        except OSError:
            if query:
                return 3
            print("BLOCK preflight_owner-lock-unavailable")
            return 2
        if not _state_is_clear(owner_fd):
            return 3
        try:
            if query:
                _query_binary()  # No build or fallback path; missing release artifact stops here.
            app_slice_group = _preflight()
            report = _run_stage(owner_fd, mode, app_slice_group)
            if not query:
                _run_owner_death(owner_fd, app_slice_group)
        except UnresolvedOwner:
            if _state_is_clear(owner_fd):
                nonce = os.urandom(16).hex()
                _write_owner(owner_fd, nonce, _unit_for(nonce), 5, None, 0)
            return 3
        except ProbeError as exc:
            print('{"status":"incomplete","parentBufferBoundProved":false,"claimsProductAcceptance":false}'
                  if query else f"BLOCK {exc.code}")
            return 2
        if query:
            encoded = json.dumps(report, separators=(",", ":"))
            _require(len(encoded) + 1 <= MAX_FRAME, "report-too-large")
            print(encoded)
            return 2
        print('{"status":"incomplete","benignLifecycleObserved":true,'
              '"parentBufferBoundProved":false,"claimsProductAcceptance":false}')
        return 2
    finally:
        os.close(owner_fd)


def _unbuffer_standard_streams() -> None:
    # Drop interpreter-created buffers before any owner, input or report exists.
    # Detach preserves the original fd; replacing both aliases releases wrappers.
    for name, fd in (("stdin", 0), ("stdout", 1), ("stderr", 2)):
        stream = getattr(sys, name)
        _require(type(stream) is io.TextIOWrapper and getattr(sys, f"__{name}__") is stream,
                 "stdio-wrapper-invalid")
        buffer = stream.buffer
        _require(type(buffer) in (io.FileIO, io.BufferedReader, io.BufferedWriter),
                 "stdio-buffer-invalid")
        raw = buffer if type(buffer) is io.FileIO else buffer.raw
        _require(type(raw) is io.FileIO and raw.fileno() == fd, "stdio-fd-invalid")
        if raw is not buffer:
            encoding, errors, line_buffering = stream.encoding, stream.errors, stream.line_buffering
            stream.detach()
            buffer.detach()
            stream = io.TextIOWrapper(raw, encoding=encoding, errors=errors,
                                      line_buffering=line_buffering, write_through=True)
        else:
            stream.reconfigure(write_through=True)
        setattr(sys, name, stream)
        setattr(sys, f"__{name}__", stream)


def main(argv: list[str]) -> int:
    _unbuffer_standard_streams()
    if argv == ["--self-test"]:
        try:
            _offline_self_test()
            return 0
        except Exception:
            return 1
    if argv == ["--run"]:
        return _run_opt_in()
    if len(argv) == 2 and argv[0] == "--query" and argv[1] in QUERY_CASES:
        return _run_opt_in(argv[1])
    if len(argv) == 2 and argv[0] == "--allocator" and argv[1] in ALLOCATOR_CASES:
        return _run_opt_in(argv[1])
    if len(argv) == 3 and argv[0] == "--service":
        try:
            return _service_main(argv[1], argv[2])
        except (ProbeError, OSError):
            return 2
    if len(argv) == 7 and argv[0] == "--owner":
        if not _nonce_ok(argv[1]) or any(re.fullmatch(r"[0-9]{1,20}", arg) is None for arg in argv[2:]):
            return 2
        return _owner_main(argv[1], *(int(arg) for arg in argv[2:]))
    return 2


if __name__ == "__main__":
    try:
        exit_code = main(sys.argv[1:])
    except BaseException:
        # An unexpected failure is never serialized as a raw path/error/receipt.
        # Any persisted owner remains quarantined; no automatic recovery.
        exit_code = 3
    raise SystemExit(exit_code)
