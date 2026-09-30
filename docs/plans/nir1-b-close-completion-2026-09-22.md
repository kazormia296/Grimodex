# NIR-1 B-close completion evidence

Status: **B-close implementation and required focused boundary evidence complete**. Parent PR #604 is pinned at
`ca05ae523e05668c4174c17a1a5fec544765b3c2`; the child branch is
`codex/nir1-b-close-completion`. Numeric supported capacity was explicitly ratified in this session and passed the release boundary qualification.
Graph query, Packing and product dispatch remain inactive. This ledger does
not declare merge readiness. The user excluded acceptance review and Full CI
for this session; focused implementation validation and PR Quick remain in scope.

The authority is unchanged:
`nir1-l6-l9-contract-proposal/5#graph-limited-binding`. The two-stage decision
in [the post-B plan](nir1-post-b-execution-plan.md#52-二段階の容量確定) remains
the numeric confirmation boundary. Measurements alone do not approve a limit. The user confirmed the memory
semantics for this session: runtime guards constrain input counts/bytes, SQL
and deadline inside the existing owners; total RSS and Rust heap are
boundary-fixture acceptance criteria, not process-wide absolute runtime caps.
The user then confirmed the values and scope below with “この数値と適用範囲で確定する（推奨）”.

## Ratified numeric contract

The existing `nir1-l6-l9-contract-proposal/5#graph-limited-binding` authority
and the three resource units remain unchanged. This confirmation supplies the
previously pending numbers for the **B full-set unit** only. The request-local
Revision limit (512 records / 2 MiB) and seed-local query contract are unchanged.
Runtime constants live in `nir1_capacity.rs`.

| Dimension | Limit | Enforcement / meaning |
|---|---:|---|
| Qualified Entity + Relation + Evidence records | 8,192 | count before roster append; no truncation |
| Qualified current Revisions | 1,024 | count after full A2 qualification |
| Scanned candidate proposals | 2,064 | count before allocating each keyset row |
| Admitted Source input per scan | 16 MiB | key, payload, envelope, metadata/Decision and live-source byte lengths before materialization |
| Retained roster | 4 MiB | six String payload lengths plus `size_of::<GraphObjectRosterEntry>()` per record; allocator/container overhead is additionally covered by fixture peak measurements |
| Stored Graph edges / active D1 collection | 8,193 rows and 16 MiB each | scalar SQL count/length preflight before loading; D1 includes its headers and Graph metadata |
| SQL per full-set attempt | 600,000,000 progress counts | cadence one on the audited SQLite; shared prepare→publish and nested Verify/Rebuild validation |
| Cooperative deadline | 180 seconds | same attempt clock and existing Rust/SQL checkpoints; existing exact finalization grant remains authoritative |
| Fresh-child total RSS qualification | 384 MiB | fixture criterion, not an absolute process cap |
| Fresh-child Rust requested heap qualification | 320 MiB | fixture criterion, not allocator resident bytes or an absolute cap |
| Total temporary logical file-length upper bound | 1 GiB | fixture criterion under the measurement definition below |

An input/count/SQL/deadline excess is a typed capacity failure. The complete
Source cannot silently become a partial roster. Graph publication keeps its
previous generation on refusal. Verify/Rebuild share a synchronous attempt
budget across their existing connection phases. A completed phase is not
retroactively turned into failure by a late clock check. After failure,
terminal Run recording, rollback and connection retirement run outside the
spent validation budget; otherwise an exhausted budget could strand its own
owner. These cleanup obligations and file-install OS stalls have no absolute
180-second termination guarantee. Normal Rebuild retains its existing per-consumer
transaction semantics; the Graph generation remains an atomic transaction.

COMMIT is a separate irreversible boundary within that same SQL budget.
The fixed SQLite's literal COMMIT executes `Init → Goto → AutoCommit`;
`Goto` drains two progress callbacks, and `AutoCommit` commits before its
last callback. The transaction helper therefore uses SQLite's commit hook
to check the existing deadline/grant policy and debit **one remaining count from every active
budget before durability**. This gate runs after FTS `xSync`, so its SQL is
still metered; FTS `xCommit` is a no-op in the audited source. Only the one
prepaid tail callback cannot interrupt. A finalization grant does not exempt
terminal DML, COMMIT preparation or FTS work from the SQL limit. The hook and
credit are scoped to this literal COMMIT and removed before later SQL.
The same 600,000,000 limit applies; no extra terminal allowance is added.

Rebuild checks stored Graph capacity before its D1 read and at each consumer
phase, within the transaction that reads that phase. The ordinary D1 path
now owns a read transaction, and the cycle-control path keeps its existing
IMMEDIATE transaction. Reserved semantic-index consumers are skipped before
loading their Edge vectors. Reacquiring a connection never reuses an earlier
phase's capacity verdict.

No new IPC, table, authority, product Graph reader or dispatch is introduced.
The normal maintenance/foreground owners retain transaction, finalization,
interruption, cleanup and quarantine responsibility. The Native supervisor
owns Join even if the N-API response waiter is dropped; main and renderer keep
the existing lifecycle receipt and projection contracts.

## Completed measurement matrix

`matrix-r1` completed all **19 paths, 19 warmups and 95 measured children** on
fresh copies. All 114 children report complete lifecycle SQL and temporary
logical disk upper bounds; the phase evidence contains **768 interruption
probes**. The source/fixture/binary hashes were checked before any subsequent
capacity-enforcement edits. `inputs.json`, `original-source.patch` and the
new-file snapshots preserve that measured implementation.

The combined `matrix-r1/capacity-report.json` SHA-256 is
`43b91e90a3a6476a66c7fa2589c0b005aae05eb8ce7b7f1464fd951588ba10c4`.
This is the measurement-stage receipt, not a claim that the final guarded
candidate has the same binary. The release boundary qualification below
checks the later enforcement implementation separately.

| Maximum across measured children | Value | Path |
|---|---:|---|
| Lifecycle SQL conservative upper | 455,778,688 | D2064/report-heavy, Restore |
| PROFILE-visible lower | 446,253,842 | D2064/report-heavy, Restore |
| Total temporary logical upper | 738,865,473 bytes (704.64 MiB) | D2064/report-heavy, Restore |
| Total peak RSS | 321,040,384 bytes (306.17 MiB) | Q8176/R16, Restore |
| Rust requested heap high-water | 249,674,829 bytes (238.11 MiB) | Q8176/R16, full build |
| Primary elapsed time | 97,523.71487 ms | Q8176/R16, Restore |
| Observed cancellation / foreground wait | 2.389173 / 4.240579 ms | Q8176/R16, full build |
| SQLite spill traffic | 5,340,655 bytes | Q8176/R16, full build |

The two matrix partitions ran concurrently. Focused native compilation overlapped
part of the matrix and is recorded in `concurrent-validation.json`; elapsed
values are observations under that load. They are not isolated-hardware or
worst-case latency guarantees.

## Measurement definitions

### Lifecycle SQL

The previous PROFILE sum is retained as `profiled-subset-lower-bound` with
`exactVmSteps=false`. PROFILE suppresses SQLite-internal statements such as
VACUUM's `SqlExec`, so its sum is not promoted to a lifecycle upper bound.

The feature-only observer now also counts every cadence-one progress callback
from before the primary connection opens until every primary connection closes.
The audited engine is SQLite 3.53.2 (`libsqlite3-sys` 0.38.1), source ID
`2026-06-03 19:12:13 d6e03d8c777cfa2d35e3b60d8ec3e0187f3e9f99d8e2ee9cac695fd6fcdf1a24`.
In this interpreter `nVmStep` advances per opcode and `vdbe_return` drains the
remaining cadence-one callbacks. This includes nested `SqlExec`/VACUUM VMs.
Prepare and integrity-check callbacks can add counts, so the result is a
conservative upper bound, not exact VM work. See SQLite's
[progress-handler contract](https://www.sqlite.org/c3ref/progress_handler.html)
and [interpreter reference](https://www.sqlite.org/opcode.html).

The outer connection still owns cancellation. Its existing check cadence is
composed with the meter; clearing cancellation leaves a noncancelling meter
through rollback/settings cleanup. A cancelling callback can bypass the VM's
tail accounting. Interrupted scopes, unclosed connections, observer failures,
or a different SQLite source ID therefore produce no lifecycle upper bound.
The runner rejects a claimed upper bound below PROFILE or without the audited
method/source and complete connection coverage. Interruption experiments are
outside the primary SQL and memory interval.

### Total temporary disk

The reported quantity is a conservative **logical file-length high-water upper
bound across filesystems** for one primary child:

```text
initial DB + WAL + SHM + journal lengths
+ increase in Linux /proc/self/io wchar
+ cumulative positive SQLite VFS file-length growth
+ cumulative SQLite SHM mapping growth
```

`wchar` includes successful ordinary writes and kernel file copies. The VFS
terms cover sparse growth, truncate extension and mmap-backed WAL-index SHM.
They also account for unlinked SQLite temporary files. Rewrites and ordinary
SQLite writes are intentionally overcounted. Deleting a file or replacing a
Restore staging image does not subtract it from the bound. Backup, staging,
safety, rollback copies and markers share the same interval. See the Linux
[`/proc` accounting contract](https://docs.kernel.org/filesystems/proc.html)
and SQLite [VFS interface](https://www.sqlite.org/vfs.html).
For this Linux run, Rust 1.96.1's [`fs::copy`](https://github.com/rust-lang/rust/blob/1.96.1/library/std/src/sys/fs/unix.rs)
uses [`io::copy` kernel offload](https://github.com/rust-lang/rust/blob/1.96.1/library/std/src/sys/io/kernel_copy/linux.rs)
(`copy_file_range`, then `sendfile`, or ordinary reads/writes). Linux 7.2.6's
[`read_write.c`](https://github.com/gregkh/linux/blob/v7.2.6/fs/read_write.c)
charges successful copies to `add_wchar`, including reflink-assisted
`copy_file_range`; it does not silently bypass the logical-copy term.

This is not physical allocated-block accounting: filesystem metadata, block
rounding and KEEP_SIZE preallocation are excluded. It is not the maximum of
sparse directory polls. The old `temporaryBytes` remains cumulative SQLite
spill traffic, a different metric. A failed extending IO or an unclosed VFS
file prevents the new bound from being reported. The runner verifies the sum
and file closure before producing a success artifact.

### Cancellation and Restore

Each full-set phase has cancel and foreground experiments at first SQL progress
and at the final Rust boundary before transaction commit. Build prepare and
publish are separate; Restore includes restored-state full-set validation,
Graph prepare and Graph publish. Every probe proves typed termination,
rollback/autocommit, hook removal, busy-timeout restoration, a succeeding
foreground SELECT and unchanged sealed Graph binding. An operation that
completes before the requested point fails the experiment.

The summary is the maximum of the named phase samples. It is an observation,
not an OS-stall or scheduler upper bound. The runner checks the exact
phase/kind/trigger-point set, scope and maximum. `cancel.status=not-run` requires
null latency and metadata; only `measured` values can enter cancellation
aggregation. The reported #604 inconsistency is a regression case and must
leave no success report.

File installation has no separate cooperative cancellation API. Real Native
tests pause after installation while the marker and open lock still exist,
request Shutdown, prove that Shutdown has not finished, then permit cleanup
and observe Join/Closed. Crash tests separately kill and wait at live seal and
after replacement, prove Safe Mode without authority, then explicitly restore
the selected candidate and Retry Open. A kill-to-exit sample is not relabelled
as cooperative cancellation. The diagnostic JSON continues to distinguish
file-install cancellation from these Native lifecycle observations.

## BC-2 ownership corrections

The following real boundaries were reproduced and corrected:

1. Restore completing during Shutdown could return an error while the shared
   core was legitimately Finishing. After Join and transition retirement it
   now releases its observation slot and uses the existing idempotent Shutdown
   drain to obtain the core's actual Closed proof.
2. Dropping an Open/Restore/Freshness response future detached the blocking worker but
   also dropped the code that observed Join and published the terminal state.
   The whole existing operation now lives in a Tokio task independent of the
   N-API response awaiter, matching maintenance's existing supervision pattern.
   It retains the captured target, AppState, operation guard and terminal
   publication through actual completion. Shutdown still closes admission
   before an unstarted task can acquire responsibility.
3. The shared DB error conversion had erased the typed lifecycle Closed reason.
   Preserving the original error lets the supervised Freshness worker retire
   normally during Shutdown instead of treating Closed as an unrelated failure.

No timer or promise rejection supplies Join. The cfg(test) rendezvous and
test-failpoints crash parking do not add a product capability.

## T01–T36 evidence map

The IDs are from [the existing lifecycle contract](pr600-lifecycle-replacement.md#t01-t36-acceptance-map).
The map names executable boundaries instead of treating historical Full as
proof of every fault combination. The focused evidence covers each listed mandatory boundary. It does not assert every possible cross-product of faults or a new end-to-end acceptance review.

Source abbreviations:

- **core**: `src-tauri/crates/grimodex-db/src/workspace_lifecycle.rs`.
- **connection**: `src-tauri/crates/grimodex-db/src/narrative_maintenance_connection.rs`.
- **runtime**, **Run**, **rebuild**: `maintenance_runtime.rs`,
  `maintenance_lifecycle.rs`, `restore_rebuild.rs` under the DB narrative module.
- **Native**: `electron/native/grimodex-node/src/lib.rs`, its `state.rs`, and
  `workspace_lifecycle_view.rs` tests.
- **main**: `electron/main/narrativeMaintenance*.test.ts`, lifecycle result/view tests.

| ID | Boundary and evidence | Current status |
|---|---|---|
| T01 | main `shares admission between a manual attempt and the automatic queue`; held work executes after release | passed |
| T02 | main pending manual begin rejection, pending begin/dispose ordering, lost-wake and capacity retry tests | passed |
| T03 | core `shutdown_stops_reserved_execution_before_body_start`; detached Native task admits only after the shutdown guard | passed |
| T04 | core transition/descriptor admission tests; Native `production_restore_cannot_borrow_a_closed_open_recovery_gate` | passed |
| T05 | Native repeated-key real DB test; Run exact interruption/new sealed occurrence | passed; exact Run failure/reuse suite |
| T06 | rebuild typed stop/failure rollback; Run exact failure-policy tests | passed; exact Run failure/reuse suite |
| T07 | connection aggregate cleanup failures/quarantine/retirement baton; Native exact replacement recovery | passed |
| T08 | core descriptor retry; Native targeted Open recovery; real crash → Safe Mode → Restore → Retry Open | passed |
| T09 | runtime before/after-final-grant cancellation; Native per-work finalize grant; rebuild finalizer failure rollback | passed |
| T10 | Native `native_registry_and_real_db_repeated_key_preserves_first_success`; runtime successful work survives follow-up preemption | passed |
| T11 | Native captured workspace/competing Restore; backup source descriptor/materialized digest and exact recovery candidate | passed; backup source/replacement suite |
| T12 | Native `two_restore_interleaving_rejects_second_before_open_lock`, borrowed lock through postprocessing, installed-worker Shutdown | passed |
| T13 | Native `production_restore_recovery_handoff_is_consumed_by_next_open` and exact original identity/replacement proof | passed |
| T14 | main NotAdmitted cannot revive Transition; Native competing restore rejected before open lock | passed |
| T15 | real dropped Open/Restore response tests retain the worker until Shutdown; worker panic tests retain recovery ownership | passed |
| T16 | core immutable duplicate delivery/fence/ACK; main lost ACK retries without redispatch; Native stale authority receipt rejection | passed |
| T17 | connection no-wait mutex acquisition and real SQLite interrupt/rollback; foreground reservation ordering | passed |
| T18 | real Native restart/backoff and Run creation-resolution evidence | passed; Native foreground and exact Run suite |
| T19 | Native targeted Open original locator/identity proof and core exact descriptor-root admission | passed |
| T20 | restored image/epoch/old Run/Decision evidence in capacity Restore; replacement proof refuses unsupported disappearance | passed; 114-child matrix and exact Run suite |
| T21 | main independent cleanup starts while Native observation is stuck; fatal path attempts every teardown | passed |
| T22 | installed-worker test proves stop does not imply completion; core refuses Closed before Join; Native retains physical lock | passed |
| T23 | core confirmed rollback vs unknown and exact reuse selection; Run creation resolution and Native targeted recovery | passed; real file-backed committed/rolled-back/partial tuple reopen contrast |
| T24 | Native repeated effective key gives distinct executions; main old in-flight failure cannot erase replacement retry state | passed |
| T25 | core dropping armed/reserved permits cannot fabricate Join; Native worker panic and response-notification loss preserve supervision | passed; reachable owner/drop/panic and rejected spawn on a shut-down Tokio runtime |
| T26 | connection nested scope preserves outer hook; Source/coverage/rebuild propagate typed termination | passed |
| T27 | core delivery fingerprints and strict lifecycle wire/result schemas; malformed Native result retries fail closed | passed |
| T28 | core full delivery → fence/ACK → same-sequence retry; main full-delivery recovery progress | passed |
| T29 | main/IPC manual caller, profile and binding revalidation | passed, 158 IPC/profile tests |
| T30 | main exact Unchanged, stale proof, NotAdmitted and requires-open projections; Native same-path replacement | passed |
| T31 | real renderer dirty session + retained draft survives repeated recovery; IME/runtime identity cleared; explicit hydration ordering tests and store Open success | passed |
| T32 | main independent monotonic observation budget; no Native timer fabricates termination | passed |
| T33 | positive Apply/Freshness with exact owner; missing/wrong/stopped context rejection | passed; real Prepare/Apply success after wrong/stopped context refusal, and positive Freshness owner |
| T34 | feature-only harness, IPC/renderer Graph denial, MCP/compatibility and lease contracts | passed; product Native check, static ownership, IPC denial and selected Light regressions |
| T35 | exact complete Graph roster/publication, writer invalidation, reader keysets and missing-RSS regression | passed; source/roster/publish semantic gates and guarded release boundary qualification |
| T36 | core Join and physical exclusion tests, connection retirement proof, Native installed-owner/open-lock and replacement recovery tests | passed |

The already-merged #600 Full is historical regression evidence at
`59a9ada4dbc02495dde36e40b55bbf938d11a863`, base
`9f6aba5f7f94df3892ef3c322f4a47a78b6928e2`, run
`79ce9a11-c8c3-42e7-9f5c-330d162e61a3` (62 tasks, 28 clean journeys).
Its [PR ledger](https://github.com/kazormia296/Grimodex/pull/600) explicitly
does not certify all T01–T36 combinations. It is not this child's CI receipt.

## Initial guarded boundary qualification

`boundaries-final/complete.json` records **8 successful fresh release children
and 4 safe N+1 refusals** at the pre-review implementation delivered in
`6e44efac09bc73c779673e0f02b677e44c1b8011`. The review correction receipts
below supersede its candidate claim. The real Native fixture writer seeded each source,
closed/checkpointed it, and the harness verified that measurement left its hash
unchanged. An over-limit fixture may be created successfully as data while its
embedded observation reports `status=failed`; it is not a qualified build.
Each N+1 measured child exits unsuccessfully, emits no success JSON and leaves
zero Graph generations. The failure output names the exact exceeded dimension.

Positive cases are 8,192 materials / 17 Revisions, 1,024 Revisions / 2,048
materials, 2,064 report-heavy candidates and exactly 16 MiB admitted Source
input. Each runs full-build and Restore. The paired negative cases add one
material, Revision, candidate or input byte. `nir1_capacity_boundary_tests.rs`
additionally checks real SQLite edge/D1 sets at 8,193/8,194 rows and
16 MiB/16 MiB+1, and proves a previously published generation survives Source
byte refusal. Its retained-roster test checks the projection's independent
4 MiB/4 MiB+1 accounting with a synthetic enlarged Evidence reference; it does
not mislabel that reference as a valid Native A2 bundle.

`nir1_capacity.rs` tests use real SQLite work at its measured SQL N and N+1,
and an expired deadline without a 180-second sleep. They prove prepare→publish
budget continuity, retained previous generation, nested owner preservation,
rollback and subsequent connection use. An actual SQL interrupt after a Run
creation commit closes Verify/Rebuild Run/Attempt as `failed` with
`retry_disposition=manual`, with no automatic retry timestamp. Failure and
cleanup can complete after the validation budget is exhausted.

| Final release boundary maximum | Value |
|---|---:|
| Total peak RSS | 320,962,560 bytes (306.09 MiB) |
| Rust requested heap | 249,870,264 bytes (238.29 MiB) |
| Total temporary logical upper | 739,204,904 bytes (704.96 MiB) |
| Lifecycle SQL upper | 718,792,353 |

The largest lifecycle SQL total is the report-heavy Restore child. Its interval
includes the pre-backup build and stale-snapshot proof, backup/install, separate
post-Restore build/validation attempts and diagnostic evidence reads. The
600,000,000 runtime budget applies to **one owned full-set attempt**, including
its prepare→publish and nested validation; it is not a limit on the sum of
these separate attempts or on the whole diagnostic child. No budget is renewed
inside a prepare→publish pair or its nested validation.

Binary SHA-256: `8a53c8334c439da2a207b810aa876c3d063eb9f8fe3ebc11672baa362d7a786f`.
Boundary manifest SHA-256: `073091c2224c17ff41f4b78a5abc4d7fb0719405d0ca697d631bebc32ff35adc`.
`validated-summary.json` rechecks successful status, required mode success,
true peak RSS sources (never instantaneous RSS fallback), heap, disk and SQL
coverage from every saved child observation. CLI elapsed seconds include the
independent interruption experiments; they are not the 180-second cooperative
validation deadline. Focused builds may overlap; no isolated-hardware claim.

Reproduce from a clean output directory:

```bash
NIR1_CAPACITY_BOUNDARY_OUTPUT=/absolute/new/output CARGO_BUILD_JOBS=2 cargo test --release --manifest-path src-tauri/Cargo.toml -p grimodex-db --features nir1-material-diagnostics --test nir1_capacity_boundaries -- --ignored --nocapture --test-threads=1
```

Routine Light runs the SQL/byte guards and diagnostic fake/real-child suites.
The explicit release qualification is separate because it builds all eight
large boundary fixtures. The original 19-path measurement protocol remains one
warmup plus five runs per path; this confirmation-stage boundary protocol does
not pool its observations into those historical medians.

## Review corrections to PR #605

The review of `ca05ae523e05 → 6e44efac09bc` identified two capacity gaps.
Both were reproduced against the repository's bundled SQLite 3.53.2, then
fixed within the existing transaction and Rebuild owners. No capacity value,
authority, activation boundary or lifecycle owner changed.

- P1: the regression places the real Verify/Rebuild Run/Attempt success writer
  and COMMIT inside the capacity scope. With the successful callback total
  minus one, the old implementation returned a capacity error while another
  WAL connection read both rows as `completed`. With the commit reservation,
  N succeeds and N−1 refuses before durability: that connection sees the prior
  `running` pair before any failure re-finalization. The same test covers an
  active finalization grant with pending FTS `xSync` work; that SQL remains
  charged. Other commit errors retain ambiguous-outcome cleanup/quarantine.
- P2: both real Rebuild entry variants refuse oversized active Graph D1/Edge
  collections before calling their vector materializers. Eight cases cross
  the row/byte limit independently for both collections and both owners; the
  resulting Run/Attempt are `failed` with `manual` retry disposition. A second
  test uses a separate WAL writer to enlarge Graph edges after the D1 snapshot
  in each entry variant. The later phase detects the new size; D1 reads remain
  inside their snapshots, and no Graph Edge vector is loaded.

Artifacts for these corrections are under
`.artifacts/nir1-capacity/pr605-review-fixes/`; the earlier directory above is
retained as historical evidence. `p1-red-r4.log` and `p2-red-r2.log` contain
the product regressions. Earlier fixture/compiler corrections remain retained
and are not counted as product reproductions or passes.

`focused-final.json` records 157 passing Rust tests: capacity (6), stored
boundaries (4), Restore/Rebuild (98), transaction wrappers (3), Run lifecycle
(21), and maintenance connection (25). Strict Clippy for the DB library and
the three diagnostic/boundary/Apply integration targets passed in `clippy.log`.
`quality.log` records `pnpm verify:quality`, including all 72 active writers.
The release boundary rerun and replacement clean-candidate Quick/verify receipt
are recorded with the delivery PR after the candidate is frozen. The original
Quick at `6e44efac09bc` is not reused for the corrected candidate.

## Initial delivery receipts

Local artifacts are under `.artifacts/nir1-capacity/b-close-completion/`.
The delivery PR records the frozen base/head/tree tuple and the clean-candidate Quick/verify receipt. Full CI and independent acceptance review are excluded by the user for this session; merge is outside the requested PR scope. This ledger does not claim them.

| Gate | Result |
|---|---|
| Fake-child/aggregation regression, `js-r5.log` | 25 passed; includes the reported not-run/non-null/empty-probes combination, invalid SQL/disk bounds, missing late phase evidence |
| Diagnostic library, `capacity-focused-r4.log` | 19 passed |
| Real diagnostic binary, `binary-r4.log` | 3 passed |
| Restore crash integration, `restore-crash-r2.log` | 3 passed, including live seal and after replacement |
| Native admission/supervision, `native-admission-final-r1.log` | 21 passed |
| Native state/views/Open, `native-state-r2.log`, `native-views-r2.log`, `native-open-r2.log` | 38 / 9 / 3 passed |
| Shared core/connection/runtime/rebuild/index, `core-lifecycle.log`, `db-owner.log`, `db-maintenance.log`, `db-restore.log`, `graph-contract.log` | 38 / 24 / 37 / 98 / 10 passed |
| Electron main, `lifecycle-main-r1.log` | 10 files, 155 passed |
| Native foreground/rebound, `native-foreground.log`, `native-rebound.log` | 11 / 1 passed |
| Electron IPC/profile, `lifecycle-ipc-r1.log` | 158 passed |
| Native ownership/static lifecycle, `native-ownership-static.log`, `lifecycle-static-r2.log` | passed, 72 active writers / 8 tests |
| Renderer projection, `lifecycle-ts-r2.log` | 7 passed; the unchanged workspace store and Open-proof modules also passed in r1 |
| Release diagnostic build, `release-r4.log` | passed |
| 19-path / 114-child matrix, `matrix-r1/complete.json` | passed; two independent partitions, fresh process/copy per run; wall times retain this load qualification |

Failed attempts remain retained: the P2 reproduction, installed Restore
Shutdown failure, dropped response failure, the missing crash-park seam,
test-fixture/formatting corrections. A later passing run does not turn these
failed attempts into successful receipts.

Additional final focused receipts: `budget-final-r1.log` (5),
`bytes-boundary-r1.log` (2), `db-restore-final-r1.log` (98),
`db-connection-capacity-r1.log` (25), `db-runtime-capacity-r1.log` (37),
`db-source-capacity-r1.log` (11), `contracts-final-r1.log` (4),
`diagnostic-final-r1.log` (12), `db-run-final-r1.log` (21),
`db-backup-final-r1.log` (23), `apply-context-r3.log` (19),
`native-product-check-r2.log`, and strict `clippy-final-r3.log`
(DB library and the three boundary/diagnostic/Apply integration targets).
`pnpm verify:quality` passed in `quality-final-r2.log` after the plan and
quality-contract synchronization, including all 72 active writer contracts.
The final clean-candidate Quick also reruns the canonical selected Light suites.
