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

The last pre-P1 checkpoint, `261676581966cc0748e0272876e1c0a129961e69`,
received Request changes for Related Scenes/Chronicle eligibility reads that
could not observe lifecycle stop during SQL row scans and serialization. The
corrective lane propagates the pinned request's `GraphWorkControl` through
Chronicle source/build/canonical/query/publish and Related Scenes status,
qualification, validation, and evidence navigation. The focused Rust checks
below validate that correction; independent acceptance is recorded for the
final commit in the external ledger.

After the final clean commit, `.artifacts/c5-final-candidate.json` and the
PR #601 body record the exact base/head/tree, reviewer results, focused
evidence, and Quick/Full plus immediate verification receipts. Earlier reviews
and receipts do not establish acceptance of the final candidate.

## Current pre-freeze focused evidence (2026-09-21)

- `pnpm test:electron --run electron/main/narrativeMaintenance.test.ts electron/main/narrativeMaintenanceShutdown.test.ts electron/main/narrativeMaintenanceBootstrap.test.ts electron/main/narrativeFreshness.test.ts electron/main/relatedScenesReconciler.test.ts` — 5 files, 101 tests passed.
- `pnpm test:electron --run electron/main/narrativeMaintenanceDelivery.test.ts electron/main/narrativeMaintenance.followup.test.ts electron/main/narrativeMaintenance.review-fixes.test.ts electron/main/narrativeMaintenance.reacceptance.test.ts electron/main/narrativeMaintenance.reacceptance.wire.test.ts` — 5 files, 41 tests passed.
- `pnpm exec tsc -p electron/tsconfig.json --noEmit` — passed.
- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib nir1_chronicle_index` — 54 passed, including controlled query/build/publish/input-guard interruption and unchanged canonical Source digest.
- `cargo test --manifest-path electron/native/grimodex-node/Cargo.toml --lib` — 154 passed.
- `pnpm test:narrative:lifecycle` — 38 shared-core tests, one Freshness lifecycle test, the isolated lifecycle harness, 9 Native adapter tests, and 3 Native Open/Restore tests passed.
- `pnpm verify:quality` — passed.

The Rust commands used `CARGO_BUILD_JOBS=2`, `CARGO_PROFILE_DEV_DEBUG=0`, and
`CARGO_PROFILE_TEST_DEBUG=0`, matching the debug-free Full profiles. Cancellation
is observed at row and serialization boundaries; this does not assert a hard
30-second completion bound for an individual SQLite VM operation or the
existing audit-chain verification.

These results precede final freeze and are focused implementation evidence,
not independent acceptance. The final ledger records the Rust results and
their candidate binding after the correction is complete.

## Historical focused evidence

The following results were recorded before the current P1 correction. The
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
| C0 contract review | historical bounded/limited | The current ledger includes the Related Scenes callsites; final review must inspect that correction. |
| C1 core review | historical bounded/limited | Earlier core coverage does not establish acceptance of the current correction. |
| Luna Max / Sol C5 reviews | see final candidate ledger | Read-only independent results and exact candidate identity are recorded in `.artifacts/c5-final-candidate.json` and PR #601. |
| Layer C IPC journey | pending | A full Electron IPC → N-API → SQLite → renderer run has not been claimed. |
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
unresolved_findings=current P1 status in final_candidate_ledger; full Layer C IPC journey and complete T01-T36 evidence remain bounded evidence limits
environment_limits=Windows GNU check may require missing x86_64-w64-mingw32-gcc; Windows installer requires Windows runner; no hosted-check claim
freeze_timestamp=recorded in final_candidate_ledger
```

The external ledger records the remaining candidate fields required by the
contract, including changed paths, implementer/reviewers, evidence paths,
binary hashes, unresolved findings, and completeness. Any subsequent candidate
change invalidates its receipts.

Authorized publication is PR #601 into `codex/nir1-b-capacity-implementation`
after all final gates pass. Retargeting or direct publication to master is
outside this scope.
