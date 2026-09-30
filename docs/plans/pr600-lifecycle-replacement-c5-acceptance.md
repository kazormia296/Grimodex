# PR #600 lifecycle replacement: C5 candidate record

Parent PR: `#600`

Parent branch: `codex/nir1-b-capacity-implementation`

Base SHA: `8df6be62b2652a5c3e7bca1ffb0e874937313d43`

Child branch: `codex/pr600-lifecycle-replacement`

Contract: `pr600-lifecycle-ownership/2#workspace-maintenance-lifecycle`

Worktree: `/home/grimodex/.codex/worktrees/pr600-lifecycle-replacement`

This record separates implementation evidence from independent acceptance. The
implementation history includes the following PR #601 review corrections:

- retained work is rebound only by an exact descriptor-proven
  original-binding → rebound-binding pair; an unrelated Ready workspace is
  never used as a rebinding source;
- restore/open results use a strict versioned DTO: `NotAdmitted`, `Unchanged`,
  `Activated`, `Restored`, `RecoveryRequired`, and `Closed` remain distinct,
  with revision, opaque binding, activation, operation outcome, and content
  effect validated before renderer projection;
- a local full delivery ledger does not consume `H+1`; after ACK frees a
  record, the exact sequence can be admitted by Native;
- an unACKed recordless fence remains a live terminal obligation and blocks
  `Closed` until its transport ACK retires the fence;
- descriptor recovery that runs while another workspace is Ready suppresses
  the transient renderer Transition projection, so the live renderer scope is
  not left `switchInProgress`/unhydrated;
- automatic, manual, legacy, Freshness, and foreground transactions use the
  shared lifecycle ownership boundary, with explicit pending-start retirement;
- destructive project admission and Run creation use one process-local
  mutex-backed table, while durable lineage checks remain mandatory;
- JoinError/panic outcomes retain the admitted delivery and transfer durable
  responsibility before terminalizing the transport result;
- full-eligibility readers require an explicit owner and borrowed transaction
  context, while typed lifecycle termination remains distinct from Source
  absence.
- Open/Restore physical acquisition waits for participant cleanup and Join;
  initial Open failure retires without a bindingless descriptor, and restore
  authorization is captured through the transition owner boundary.
- A recordless Native delivery fence has an explicit ACK/retire path, so a
  pre-admission rejection cannot strand main's delivery ACK ledger.
- Foreground panic, rollback, and commit-cleanup uncertainty quarantine the
  authority instead of releasing a reusable permit; canonical writes, body
  saves, and renderer SQL batches remain shutdown participants.
- Background W1 recovery failure returns W2 to Ready while retaining the W1
  descriptor for retry; completed execution memberships are pruned after
  responsibility retirement.
- Completion receipts require an exact descriptor id and explicit binding
  fields before retained work is rebound or the receipt is ACKed.
- Windows file identity uses the stable `GetFileInformationByHandle` wrapper
  shared by creation and restore verification; no nightly-only
  `MetadataExt` methods are used.
- Safe Mode keeps a recovery-only authorization binding through
  `requires-open`, while ordinary Ready access remains denied until explicit
  Open succeeds.
- Scheduler quiescence owns the complete cycle, including recovery preflight,
  so a re-entrant no-op cycle cannot replace the Promise observed by
  `performWorkspaceQuiesce`.
- A Native delivery-capacity rejection retains the exact H+1 tuple without
  fencing or retiring it. The later retry is a fresh lifecycle attempt owner,
  while a true Native lost-response duplicate remains idempotent; workspace
  quiescence can cancel the retry before awaiting its in-flight Promise. If
  only part of the retry's project set is available, that partial claim is
  released before waiting and only the blocked projects are watched.
- Project lifecycle reservations are keyed by verified database identity plus
  project id, so equal ids in independent workspace copies do not interfere.

Checkpoint `261676581966cc0748e0272876e1c0a129961e69` received Request
changes for Related Scenes/Chronicle eligibility reads that could not observe
lifecycle stop during SQL row scans and serialization. The first correction
propagated the pinned request's `GraphWorkControl` through Chronicle
source/build/canonical/query/publish and Related Scenes status, qualification,
validation, and evidence navigation.

That first candidate, `5ef56b0763ec2b708e1d67b6d05e91c8c13f0cb4`, received
Luna Max and Sol Request changes: P1 for SQLite VM work before the first row
that still did not observe stop, and P2 for background embedding admission
that could wait without observing stop. Its focused passes below are
historical evidence, not acceptance of the current correction.

The r2 working-tree correction uses the existing participant's SQL scope for
all Related Scenes reads and publication, with SQLite progress checks every
1,000 VM instructions and the existing cleanup, typed termination, and
quarantine behavior. Background embedding identity/document admission uses
50 ms waits with stop and epoch checks, including checks between documents.
These changes do not promise hard 30-second termination of synchronous
inference or an OS stall. Independent acceptance remains candidate-bound in
the external ledger.

The second candidate, `2de4ff4bf45ef71ebec0dd2c444a604d2696068d`, received
Sol Approve and Luna Max Request changes for one remaining P2: a stopped
participant could remain blocked in connection mutex acquisition before the
SQL progress hook existed. The r3 correction adds cancellation checks to that
existing acquisition path while preserving ordinary blocking callers,
foreground handoff, finalization reservations, and connection health checks.
A held-mutex regression requires the queued participant to cancel and drain
before the original holder releases the connection.

The rebuilt second candidate passed the selected `editor-persistence`,
`editor-pending-project-switch`, and `chronicle-extract-review-apply-reopen`
journeys, with all three per-case clean passes. This is diagnostic evidence
for the wrapped preemption correction, not a complete catalog or final
candidate acceptance. The final ledger records the rebuilt r3 results.

The r3 candidate `4f0863fc71a22154c68081a37350e7b59cdc5ba8`, tree
`4ab7f4a69d9a8fe5048c2f190696b8c11339858d`, received Luna Max and Sol
Approve. Quick run `b0a95324-8b40-4bea-9ba4-7240e44a20c9` and its immediate
verify passed. Full run `4d3991ca-3266-4502-a218-8e5e1f0eb982` failed:
`journeys.shard-1` encountered `NEX_WORKSPACE_RECOVERY_REQUIRES_DESCRIPTOR`
during the configure Open A → B → A sequence for
`chat-stream-workspace-switch`, and `rust.clippy` rejected the unused
test-only `snapshot_current` wrapper. Full verification did not run. Removing
that wrapper passed the exact clippy command; it does not repair the failed
Full receipt or validate the new functional correction.

The r4 target-Open correction keeps both Maintenance and Freshness quiesce
leases while main's validated `open_workspace` invokes the existing recovery
proof/ACK drain with an optional target path. Native selects both maintenance
descriptors and retained receipts by canonical locator plus durable workspace
ID under the existing `open_lock`; a private retained receipt preserves the
original `LiveBinding` for replay filtering. The no-argument ordinary pump is
unchanged, and failed W1 recovery must not block unrelated Open W2/W3. The
exact recovery proof and descriptor receipt ACK precede Open dispatch.
Delivery retirement is attempted separately: transient failure retains the
existing `pendingDeliveryAcks`/`terminalReceiptFailure` responsibility and may
allow Open after descriptor resolution, without a new path-proof cache. The
existing C0 matrix records admission closure, handle ownership, cancellation,
terminal evidence, retry, and restart boundaries for this correction.

The separate ordinary Verify failure is now attributed to Native's handling
of incomplete accepted work. The release diagnostic in
`.artifacts/pr601-chat-release-r4-diagnostic-1` captured
`NEX_MAINTENANCE_ATTEMPT_CANCELLED` with "cancellation won before final attempt
publication" despite a null stop reason. Both foreground-deferred work and
work left by the per-cycle dequeue cap can legitimately return accepted work
with `hasMore`. Native ignored the existing `close_work_registration`
completeness result, attempted success finalization, and reported cancellation
when finalization was correctly refused, causing healthy connection retirement.

The Native correction preserves that completeness result, checks an actual
stop first, and routes incomplete `Accepted`/`Coalesced` work with `hasMore`
through the existing interrupted cleanup receipt before success bookkeeping.
The shared runtime's production accepted-result contract remains unchanged.
The shared real-DB characterization covers foreground preemption after a
successful Backfill, deferred Verify work, and a reusable connection; the
Native 32-Backfill batch regression exercises the dequeue-cap finalization
path. The final Native correction now has focused red/green regression proof
and a passing full Native library suite. The rebuilt release Journey,
independent reviews, and canonical Quick/Full results are recorded separately
in the final ledger; focused passes do not establish those outcomes. The
earlier single passing development-instrumented replay did not establish a fix.

After the final clean commit, `.artifacts/c5-final-candidate.json` and the
PR #601 body record the exact base/head/tree, reviewer results, focused
evidence, and Quick/Full plus immediate verification receipts. Earlier reviews
and receipts do not establish acceptance of the final candidate.

## Current r4 focused evidence

- Final Native library suite — 158/158 passed; `.artifacts/pr601-napi-tests-r6-final.log`. The real Native 32-Backfill regression failed before the fix with expected `accepted` versus actual `workspace-unavailable` in `.artifacts/pr601-napi-cap-before.log`, then passed in the final suite.
- Shared real-DB accepted-result characterization — 1 passed; `.artifacts/pr601-preempted-cycle-contract.log`. The maintenance runtime suite passed 36 tests; `.artifacts/pr601-preempted-cycle-contract-runtime.log`.
- Exact shared-Rust clippy command — passed; `.artifacts/pr601-shared-clippy-r4-final.log`.
- Native clippy with release features `licensing,legacy-keyring-migration` — passed; `.artifacts/pr601-native-clippy-r4-final.log`.
- Electron TypeScript check, 3 focused Electron files / 186 tests, and 87 IPC tests — passed. These checks cover the unchanged Electron sources; the later Native correction is covered by the final Native suite above.

The target-Open routes in the C0 matrix and Native incomplete-work correction
are implemented with the focused evidence above. This does not replace the
rebuilt release Journey or independent acceptance. Their results and final
Quick/Full receipts are recorded with the clean candidate in the external
ledger and PR #601; no pass is implied before those results exist.

## Historical r3 focused evidence (2026-09-21)

- Chronicle focused suite — 56 tests passed; `.artifacts/pr601-chronicle-tests-r3.log`.
- Maintenance connection focused suite — 24 tests passed, including queued mutex and reserved-handoff cancellation; `.artifacts/pr601-connection-tests-r3.log`.
- Shared semantic suite — 275 tests passed; `.artifacts/pr601-semantic-tests.log`.
- Native full library suite — 155 tests passed, including the wrapped Verify preemption regression; `.artifacts/pr601-napi-tests-r3.log`. The regression failed before classifier reuse in `.artifacts/pr601-wrapped-preemption-before.log`.
- `cargo check --manifest-path electron/native/grimodex-node/Cargo.toml` — passed; `.artifacts/pr601-napi-check-r2.log`.
- Maintenance runtime focused suite — 35 tests passed; `.artifacts/pr601-maintenance-runtime-tests-r2.log`.
- `pnpm test:narrative:lifecycle` — 38 shared-core tests, one Freshness lifecycle test, the isolated harness, 9 Native adapter tests, and 3 Native Open/Restore tests passed; `.artifacts/pr601-lifecycle-tests-r2.log`.

The r3 Native full suite compiled the acquisition and classifier corrections
at that checkpoint. The r2 maintenance-runtime, semantic, and lifecycle
results are earlier focused evidence; they do not validate the r4 target-Open
changes. The lifecycle gate used the default Cargo
profiles; the other focused Rust commands used two build jobs and debug-free
dev/test profiles.

These historical focused results do not establish final acceptance. The final
ledger records the new candidate's exact commands, results, and binding.

## First correction checkpoint evidence (2026-09-21)

These results preceded the P1/P2 findings on
`5ef56b0763ec2b708e1d67b6d05e91c8c13f0cb4` and are not r2 acceptance:

- `pnpm test:electron --run electron/main/narrativeMaintenance.test.ts electron/main/narrativeMaintenanceShutdown.test.ts electron/main/narrativeMaintenanceBootstrap.test.ts electron/main/narrativeFreshness.test.ts electron/main/relatedScenesReconciler.test.ts` — 5 files, 101 tests passed.
- `pnpm test:electron --run electron/main/narrativeMaintenanceDelivery.test.ts electron/main/narrativeMaintenance.followup.test.ts electron/main/narrativeMaintenance.review-fixes.test.ts electron/main/narrativeMaintenance.reacceptance.test.ts electron/main/narrativeMaintenance.reacceptance.wire.test.ts` — 5 files, 41 tests passed.
- `pnpm exec tsc -p electron/tsconfig.json --noEmit` — passed.
- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib nir1_chronicle_index` — 54 passed, including controlled query/build/publish/input-guard interruption and unchanged canonical Source digest.
- `cargo test --manifest-path electron/native/grimodex-node/Cargo.toml --lib` — 154 passed.
- `pnpm test:narrative:lifecycle` — 38 shared-core tests, one Freshness lifecycle test, the isolated lifecycle harness, 9 Native adapter tests, and 3 Native Open/Restore tests passed.
- `pnpm verify:quality` — passed.

The Rust commands used `CARGO_BUILD_JOBS=2`, `CARGO_PROFILE_DEV_DEBUG=0`, and
`CARGO_PROFILE_TEST_DEBUG=0`, matching the debug-free Full profiles. The
row/serialization checks covered here did not close the subsequently reported
pre-first-row SQLite VM and background admission gaps.

A real Layer C `editor-persistence` journey failed on this first candidate
because maintenance unexpectedly entered recovery. A focused regression
subsequently reproduced the Native classifier losing typed foreground
preemption behind the existing Verify validation context. The correction
reuses the shared cause-chain classifier and preserves cleanup-failure
precedence. The final ledger records the required rebuilt Journey result;
the first-candidate failure is not an attributed environment limitation.

## Historical focused evidence

The following results predate both Related Scenes corrections. The
checkpoint `a076389526654206fe712ae7f4bacd7ce4b42731` also received a bounded
read-only Sol max review (`gpt-5.6-sol`, max reasoning; P1: 0, P2: 0) covering
capacity retry, exact H+1 retention, quiescence cancellation, partial-claim
release, and Restore `Unchanged`. That approval is historical.

- `pnpm test:electron --run electron/main/profileEgress.test.ts electron/main/narrativeMaintenance.test.ts electron/main/ipc.test.ts electron/shared/ipcContract.test.ts` — 4 files, 660 tests passed on implementation checkpoint `a076389526654206fe712ae7f4bacd7ce4b42731`.
- `pnpm exec vitest run electron/shared/workspaceRestoreOutcome.test.ts src/features/settings/backupRestoreAuthority.test.ts src/features/workspace/workspaceLifecycleProjection.test.ts src/features/workspace/recovery/applyNativeOpenOutcome.test.ts` — 3 files, 16 tests passed.
- `pnpm exec tsc -p electron/tsconfig.json --noEmit` — passed.
- `pnpm test:narrative:lifecycle` — 36 shared-core tests, one Freshness lifecycle-control test, and the opt-in foreground/maintenance plus full-capacity lifecycle harness passed.
- `cargo check --manifest-path electron/native/grimodex-node/Cargo.toml` — passed; existing dead-code warnings only.
- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib workspace_lifecycle` — 35 passed, including shared foreground/maintenance admission, physical drain, recordless fence ACK, execution pruning, pending-start retirement, exact H+1 retry, and independent W2 Open with a W1 descriptor.
- `cargo test --manifest-path electron/native/grimodex-node/Cargo.toml --lib` — 153 passed, including strict Restore DTO classification, Open/Restore ordering, same-path authority rebound, background recovery projection, Safe Mode authorization, and foreground cleanup ownership.
- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib narrative_maintenance_connection` — 19 passed, including cleanup quarantine, panic rollback, and foreground-priority admission.
- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib maintenance_runtime` — 35 passed, including typed stop propagation and exact Run ownership.
- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib repository` — 47 passed, including project creation/destructive admission and lifecycle namespace behavior.
- the isolated `lifecycle-harness` (`--features test-lifecycle`) — passed; it checks independent foreground/maintenance slots and the full-capacity reject → ACK → exact-sequence retry model.
- prior focused DB, Native, Graph, Freshness, connection-retirement, result-validation, and compatibility-owner suites are recorded in the historical C0/C1 acceptance records.
- `git diff --check` — passed before the earlier checkpoint freeze.

## Independent gates and remaining evidence

| Gate | Status | Evidence boundary |
| --- | --- | --- |
| C0 contract review | historical bounded/limited | The current ledger includes Related Scenes and target-Open recovery callsites; final review must inspect the r4 correction. |
| C1 core review | historical bounded/limited | Earlier core coverage does not establish acceptance of the current correction. |
| Luna Max / Sol C5 reviews | see final candidate ledger | Read-only independent results and exact candidate identity are recorded in `.artifacts/c5-final-candidate.json` and PR #601. |
| Layer C IPC journey | see final candidate ledger | r3 Full failed `chat-stream-workspace-switch` during configure; the separate ordinary Verify failure is attributed to Native incomplete-work finalization and its focused correction regressions passed. Rebuilt release diagnostics and canonical Full results are recorded externally and remain distinct from the complete T01–T36 fault matrix. |
| T01–T36 matrix | pending | Focused tests cover representative cases; absence of a complete matrix is not a pass. |
| Quick + immediate verify | see final candidate ledger | Both commands and receipt paths use the same fixed base/head in the external ledger. |
| Full + immediate verify | see final candidate ledger | Runs after independent acceptance and resource-isolation preflight; both commands and receipts use the same fixed base/head. |

The Windows GNU target check remains environment-blocked when the
`x86_64-w64-mingw32-gcc` toolchain is unavailable. The Windows installer is a
release-only item requiring a Windows runner and is unrun on Linux. Neither
limitation is a pass; no hosted-check or publication success is claimed here.

## Candidate ledger

```text
contract_id=pr600-lifecycle-ownership/2#workspace-maintenance-lifecycle
parent_pr=#600
parent_branch=codex/nir1-b-capacity-implementation
base_sha=8df6be62b2652a5c3e7bca1ffb0e874937313d43
child_branch=codex/pr600-lifecycle-replacement
worktree=/home/grimodex/.codex/worktrees/pr600-lifecycle-replacement
final_candidate_ledger=.artifacts/c5-final-candidate.json (written after final clean commit; mirrored in PR #601)
head_sha=exact head and tree recorded in final_candidate_ledger after the clean commit
tree_status=must be clean before final candidate gates
independent_reviewers=Luna Max / Sol (read-only; results in final_candidate_ledger)
threat_model_ref_and_confirmation=policies/quality/iron-laws.md#GDX-PRECHECK-001; lifecycle ownership, renderer trust boundary, and process-local evidence limits are recorded in the contract
entry_matrix_ref=docs/plans/pr600-lifecycle-replacement.md#concrete-c0-callsite-ledger
gate_status_c0=historical bounded review; current correction awaits final review
gate_status_c1=historical bounded review
gate_status_c5=see final_candidate_ledger for candidate-bound review and receipts
focused_commands_and_receipts=pre-freeze evidence above; final candidate binding recorded in final_candidate_ledger
quick_and_verify=exact commands, fixed base/head, and receipt paths recorded in final_candidate_ledger
full_and_verify=exact commands, fixed base/head, and receipt paths recorded in final_candidate_ledger
unresolved_findings=final acceptance and rebuilt release Journey/canonical Full results for target-Open and Native incomplete-work corrections are recorded in final_candidate_ledger; focused regression passes do not close those gates; complete T01-T36 evidence is not claimed
environment_limits=Windows GNU check may require missing x86_64-w64-mingw32-gcc; Windows installer requires Windows runner; no hosted-check claim
freeze_timestamp=recorded in final_candidate_ledger
```

The external ledger records the remaining candidate fields required by the
contract, including changed paths, implementer/reviewers, evidence paths,
binary hashes, unresolved findings, and completeness. Any subsequent candidate
change invalidates its receipts.

PR #601 was squash-merged into `codex/nir1-b-capacity-implementation` as
`8052edc9cf256f31113f9f89a34470c7a7a194c8`. Its original candidate
`4cef7a8fcffbd41a4c3d551350a882afa2f3bc43` passed both independent reviews,
Quick/verify, and Full/verify (62 tasks and 28 clean Product Journeys).
Those receipts remain bound to the child PR's original base/head.

## Parent PR #600 follow-up

The user subsequently authorized PR #600 to merge into master. Its fixed base
is `9f6aba5f7f94df3892ef3c322f4a47a78b6928e2`; the clean final candidate,
reviews, commands, and receipt hashes are recorded in
`.artifacts/pr600-final-candidate.json` and the parent PR body. The child
ledger above is historical and does not establish parent merge readiness.

The first parent candidate, `8052edc9cf256f31113f9f89a34470c7a7a194c8`,
had the same tracked content as the approved child candidate. Both independent
parent reviews and Quick/verify passed. Full run
`1a5b011f-2244-4eae-8bad-f42ed698283e` failed the producer-generation and
rule-digest baseline Journeys while waiting for durable canonical cutover.
Verify had completed, DB queries continued to return, and the preserved
ledgers contained no Rebuild. An isolated replay passed; that does not classify
the failure as environmental or replace a complete Full receipt.

The uncovered continuation boundary is foreground preemption after an adapter
commits successfully but before follow-up discovery completes. Native retains
the successful work and reports an accepted, preempted cycle with more work.
Main must preserve the existing bounded rediscovery obligation after consuming
that receipt, even when no unfinished work remains to requeue. Successful
work must not be replayed merely to recover that obligation. Candidate-bound
regression, review, and full validation evidence for this correction belongs
in the parent ledger; the failed Full remains retained separately.

A subsequent parent Full on `0a4a2a30af7462a8697add7467401e6d2e5f28e6`
(run `b30e2718-d809-4503-95d5-40e84bdd28d4`) failed before the chat workspace
switch: the open menu and persisted recent-workspace list both lacked the
prepared second workspace. The cold fixture launched Native workspace setup
after bridge readiness, while renderer initialization could still read and
save an intermediate settings snapshot. Fixture setup now waits for the
existing first-run Welcome DOM (also behind the EULA modal), which proves
that initialization selected Welcome from its empty recent-workspace list,
before performing Native setup. This
orders fixture preparation without changing product settings behavior or
weakening the switch Journey. The exact stale writer in the retained failed
run was not recorded; the delayed-initialization regression and fresh Full
remain required evidence for the correction.

This parent merge does not ratify numeric supported capacity, activate Graph
query/product dispatch or later NIR-1 lanes, certify the complete T01–T36
matrix, or replace the release-only Windows installer gate.
