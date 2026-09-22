# NIR-1 B-close capacity diagnostic observation — 2026-09-22

## Status and claim boundary

This preserves the first B-close measurement and the stage-2 diagnostic follow-up
below. Neither is a numeric supported-capacity ratification, a B-close acceptance
receipt, or an activation record.

- `capacityDecision`: `unratified`
- `supportedCapacityClaim`: `false`
- Graph query activation: `not-activated`
- product dispatch: `not-activated`
- local/external AI dispatch: unchanged and not enabled by this work

The run used an uncommitted working tree, so it is not a candidate-bound
Quick/Full receipt and must not be reused after the implementation changes.

## Bound inputs

| Input | Value |
|---|---|
| branch base | `origin/master` at `6217e0155f53c9f8d267ed3c17e3952bc2f8f986` |
| branch | `codex/nir1-post-b-implementation` |
| OS | Linux `7.2.6-arch2-1`, x86_64 |
| Node | `v24.18.0` |
| Rust | `rustc 1.96.1 (31fca3adb 2026-06-26)` |
| release diagnostic binary SHA-256 | `d0a336fdf7206be3af30671c104a4095b12859f0982224ad39a630609a1829cd` |
| manifest SHA-256 | `3c6b1d21935c92def21e486d2f6269acd99f0be6c99c495f67d455b99af92c9c` |
| schema SHA-256 | `7819cbaa66a17dafd6c3b54ec0f29f61a7fc14fab8b91fafa998dd0ba3fb1565` |
| probe SHA-256 | `5c2f0b66f3e4e46c4e447c060ef55932cc3c208ae3f2f7b52915621a6d1e26e7` |
| ordered fixture-hash list SHA-256 | `7d55cf53d3731225083d5a78017af2200d0d6f295b31ac481575de6db60cc440` |

## Protocol and result

The canonical manifest selected 19 paths. Each path used one warmup and five
measured runs; every child received a fresh copy of the same preseeded
file-backed fixture and ran in a fresh process. Child timeout was overridden to
an unratified 180-second safety cap because the existing 30-second diagnostic
default was below observed valid workloads.

- paths: 19/19
- child executions: 114/114
- measured executions: 95/95, all `status=measured`
- Rust requested-heap high-water: 114/114 children
- shared Graph-prepare cancel probe: 114/114 children
- shared Graph-prepare foreground handoff probe: 114/114 children
- wall time for the matrix: 2,796.485 seconds

Artifacts (ignored local diagnostics):

- `.artifacts/nir1-capacity/b-close-2026-09-22/matrix-scoped-interruptions-v3/capacity-report.json`
  - SHA-256: `0075f64978989ee2c89f13e645ec331ee3984bc9de2817667191682d383d6e05`
- `.artifacts/nir1-capacity/b-close-2026-09-22/matrix-scoped-interruptions-v3/summary.json`
  - SHA-256: `3b766d21107edd516b5a35d09425ebc66ada7ff3cc6d395b9e0c0f2bd0c795dc`

## Selected observations

| Observation | Value | Path |
|---|---:|---|
| maximum primary elapsed time | 91,318.64 ms | `Q8176/R16` restore |
| maximum requested Rust heap high-water | 249,673,709 bytes | `Q8176/R16` full-build |
| maximum whole-process peak RSS | 320,442,368 bytes | `Q8176/R16` restore |
| maximum conservative SQL VM-step upper bound | 396,802,475 | `Q2044/R1022` full-build |
| maximum shared Graph-prepare cancel latency | 1.24737 ms | probe attached to `Q8176/R16` coverage child |
| maximum shared Graph-prepare foreground wait | 1.106333 ms | probe attached to `Q8176/R16` full-build child |

The allocator metric covers requested Rust allocations from fresh-child start
through primary path completion. It excludes allocator metadata and non-Rust
allocators; total peak RSS and SQLite high-water remain separate whole-process
signals. The SQL value is a conservative upper bound because reused statement
counters are cumulative; it is not an exact VM-step count.

The interruption values exercise the real shared maintenance owner with a real
whole-project Graph prepare, trigger after the first SQL progress callback, and
verify rollback/cleanup plus connection reuse. They do **not** establish cancel
or foreground-wait latency for each selected Source/registration/coverage/
Restore/cold-reopen operation. The report records this scope and uncertainty.

## Remaining blockers at the first-stage checkpoint

A numeric whole-project capacity or deadline is intentionally not selected.
The report keeps these material gaps explicit:

- SQLite temporary bytes are not measured; write bytes are not relabeled as a
  temp-byte measurement.
- selected-mode cancel latency is not measured for all six operations.
- selected-mode foreground wait is not measured for all six operations.
- exact lifecycle VM steps remain unavailable; the reported value is an upper
  bound.

Path-inapplicable values such as report counts for fixtures/modes that do not
produce reports, Graph serialization bytes for Source-only re-resolution, and
publish hold for Source-only re-resolution also remain explicit rather than
being filled with zero.

Selecting supported work size, memory, SQL, or deadline values requires a
separate contract delta and explicit confirmation. Until then, B-close and
Graph/product activation remain incomplete.

## Retained failure evidence

The first full matrix stopped at `Q8176/R16` Restore with SQLite
`SQLITE_IOERR_WRITE`. The same Restore path passed 6/6 in isolation. The probe
was retaining every disposable child DB until the end of the matrix, causing
unbounded temp accumulation. It now removes each child state immediately after
capturing its terminal digest and source-stability evidence; a regression child
rejects any retained predecessor DB. The failed run remains at
`.artifacts/nir1-capacity/b-close-2026-09-22/matrix-rust-heap-v1/` and was not
overwritten.

## Validation boundary

Focused Rust binary, fixture, schema, and JavaScript orchestration tests pass.
The canonical quality-model and selected Light suites are run against the final
working tree after this document is written; their result belongs to the
working-tree handoff, not to this measurement receipt. Quick/Full, Heavy
evaluations, commit, push, PR, and merge are outside this diagnostic checkpoint.

## Stage-2 diagnostic follow-up — 2026-09-22

The follow-up starts at `ba093fda436b84aa02f75c0f5c5a5c43e89bc49e` on the same
work branch. It implements the remaining native SQL/temp instrumentation and
selected-mode full-set interruption measurements, **not** the ratified numeric
limits or all of B-close §5.3. Product entry gates are unchanged.

### Instrumentation and lifecycle

- A diagnostic-only, thread-scoped SQLite auto-extension instruments every
  newly opened primary-path connection, including backup/Restore/reopen. A
  scope guard clears the active counter on success and error; outside that
  scope the extension is inert. It does not replace the owner's progress hook.
- `SQLITE_STMTSTATUS_VM_STEP` is read/reset at each PROFILE event. Reused
  statements are not cumulatively double-counted. Open/close-event counts
  establish connection coverage, **not** coverage of every VM. SQLite disables
  tracing inside VACUUM and some SqlExec operations: `exactVmSteps=false` and
  `vmStepsKind=profiled-subset-lower-bound` are mandatory. SQL text is not logged.
  Reused/trigger/interrupted-SQL tests check the visible counter; a VACUUM INTO
  regression proves that hidden SQL work must not be called exact. Lifecycle
  exact/upper-bound SQL remains unmeasured, and the earlier upper-bound metric
  was likewise not an upper bound for uninstrumented Restore SQL.
- `temporaryBytes` now means the native 64-bit `SQLITE_DBSTATUS_TEMPBUF_SPILL`
  cumulative write count at connection close. It includes intermediate/sort/
  TEMP spills, including unlinked files. It is **not** peak disk occupancy,
  WAL/journal bytes, or backup/Restore copy size. In-memory temp storage remains
  part of SQLite/RSS high-water. A forced disk-spill test proves a positive
  counter; unsupported/incomplete coverage is never normalized to zero.
- Each interruption sample calls its named real full-set operation. Full-build
  probes prepare and publish separately; the other phases are Source
  re-resolution, complete registration, coverage Verify, cold reopen, and
  restored full-set validation. Restore setup performs real backup/install,
  epoch invalidation and rebuilding before measuring that final validation.
- A scoped trigger thread requests cancellation or a real foreground connection
  handoff after SQL progress. A bounded Rust-boundary rendezvous prevents short
  operations from racing ahead of the trigger. Typed termination, transaction
  cleanup, hook removal, timeout restoration, connection reuse, and unchanged
  sealed Graph binding are required before recording a sample. The 30-second
  owner/trigger safety cap is diagnostic, not a supported deadline.
- Primary memory/SQL/CPU/elapsed measurements finish **before** the isolated
  interruption probes and their preparation. Interruption summaries are the
  maximum of the recorded phases, never a worst-case proof over every possible
  interrupt point. The schema/JS runner reject wrong/missing phases, incomplete
  cleanup/binding proofs, inconsistent summary values, and incomplete SQL
  connection coverage.

### Bound run and results

The same nine immutable preseed files were reused; their bytes/hashes and all
executable input hashes were checked again after the matrix. One warmup and
five measured fresh-copy/fresh-process children ran for each of the 19 paths.
The matrix was partitioned into disjoint fixture/mode CLI runs. The aggregate
checks the exact canonical path set, common manifest digest/protocol, source
stability and every child outcome, and binds each source report by SHA-256.

The child safety cap is 300 seconds because a Restore child now also constructs
an isolated, genuinely restored state for its interruption probes. This cap is
not the primary-operation time below and is not a capacity ratification.

| Observation | Result |
|---|---:|
| paths / children / measured runs | 19 / 114 / 95, all successful |
| native profiled-SQL / temp-spill connection coverage | 114 / 114 children |
| named-phase interruption samples, including warmups | 336 / 336 |
| maximum primary elapsed | 97,962.928 ms (`Q8176/R16` Restore) |
| maximum Rust requested heap | 249,673,733 bytes (`Q8176/R16` full-build) |
| maximum primary peak RSS | 320,835,584 bytes (`Q8176/R16` Restore) |
| maximum PROFILE-visible VM steps (lifecycle lower bound only) | 446,253,842 (`D2064/report-heavy` Restore) |
| maximum cumulative temp spill | 5,340,655 bytes (`Q8176/R16` full-build) |
| maximum sampled cancel latency | 3.185744 ms (`Q8176/R16` full-build) |
| maximum sampled foreground wait | 3.206384 ms (`Q8176/R16` full-build) |
| summed partition wall time | 4,074.445 seconds |

All maxima exclude warmups. Artifacts are local, ignored diagnostic evidence,
not clean-candidate Quick/Full receipts:

| Artifact/input | SHA-256 |
|---|---|
| `.artifacts/nir1-capacity/b-close-stage2/matrix-inputs-r2.json` | `b274e2902f1aa3f1af2cd0f3e2e44fbf48a3fa2fda2131748a7825298efcd326` |
| `matrix-v4/capacity-report.json` under that stage-2 directory | `d9a027d2343005ace289050151bb5855cfeb1e565faeafe93c02ecdded82a6ae` |
| `matrix-v4/summary.json` | `479e30715aeb6ec6583f3aac0ad47a9ada7298639980b189e016b4aa7fb7ae88` |
| release diagnostic binary | `188e41e4dfb5b97119e850394f61ccfb5c2a227cbfc83a27cd6f776db88a8d54` |
| manifest | `8ecb1dbb058959f667e406b69e680eca82b0dfadbb50a861cd316dfa6c2a4846` |
| schema | `e405dede68d9d3dc811cf3ccb547f9e203d7cdaacb46a3986889a1befb7999fe` |
| JavaScript probe | `e5d8fbbbfb89a5c72e159fb584ce29cb44eefbf0e1cc055a7854c00c943dcc4e` |

`matrix-v1` retains a `[precheck]` failure before any child ran (`/usr/bin/time`
was unavailable; subsequent commands use Bash's builtin). `matrix-v2` retains an
aborted foreground run with no completed report. No coordinator/child remained
when work resumed; neither failed/incomplete run is counted as successful.

### Numeric draft and remaining acceptance

The following are **diagnostic boundary-test candidates only**, not implemented
product caps or a request to ratify a complete capacity contract. Resource
candidates round observed maxima plus at least 25% headroom upward; they are
not statistical confidence bounds or portable hardware guarantees.

| Axis | Draft candidate | Acceptance still needed |
|---|---|---|
| work shape | named fixture points up to 8,176 materials, 1,022 qualified Revisions, 2,064 ineligible candidates | maxima occurred in different fixtures, not a tested Cartesian envelope; combined byte/edge/report stress and N/N+1 rejection |
| primary Rust requested heap / RSS | 320 MiB / 384 MiB per diagnostic child | production accounting/enforcement cannot substitute process RSS for retained native bytes; include concurrent owners |
| primary lifecycle SQL | Hold — no numeric candidate | PROFILE-visible counts are lower bounds; first account for trace-suppressed VMs, then agree shared attempt scope and N/N+1 acceptance |
| primary attempt time | 150 seconds | agree deadline scope across owners/Restore and test timeout cleanup; do not reuse the 300-second child cap |
| SQLite cumulative spill writes | 8 MiB | not a total temporary-disk capacity; separately account WAL/journals and backup/Restore copies |

Still unresolved: lifecycle SQL exact totals or a defensible upper bound;
Restore **file-install/recovery/rebuild** cancellation and
foreground latency outside the final validation probe; total temporary disk
high-water; arbitrary late interrupt points; BC-2's remaining mandatory
lifecycle evidence; a user-confirmed numeric contract and its boundary tests.
The report explicitly retains Restore file-install `notMeasured` entries, and
phase/method/uncertainty fields restrict all measured claims. Path-inapplicable
report/serialization counts remain explicit rather than fabricated zeros.

Focused native metric tests, real-binary tests across all six modes, JavaScript
schema/orchestration tests and the release matrix passed. A separate read-only
Codex reviewer (requested `gpt-6-astra`, `high`; effective metadata unavailable)
initially reported no P2+ findings. Final inspection found a P2 overclaim from
SQLite's trace-suppressed VACUUM SQL. The implementation now always labels
PROFILE-visible counters as a subset/lower bound, rejects an exact claim, and
retains missing lifecycle exact/upper-bound evidence. The prior `matrix-v3`
exact-SQL claims are invalid; those raw artifacts remain historical evidence,
not proof of lifecycle SQL capacity. Independent recheck closed the P2 at the
source/contract boundary; the replacement `matrix-v4` above reran all 114
children with the corrected labels, with **0 exact lifecycle SQL claims**.
Final quality/Light results and the
commit belong to the worktree handoff. No Quick/Full, Heavy product evaluation,
push, PR, merge, Graph activation, or product dispatch is claimed.
