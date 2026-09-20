# PR #600 lifecycle replacement: C5 candidate record

Parent PR: `#600`

Parent branch: `codex/nir1-b-capacity-implementation`

Base SHA: `8df6be62b2652a5c3e7bca1ffb0e874937313d43`

Child branch: `codex/pr600-lifecycle-replacement`

Contract: `pr600-lifecycle-ownership/2#workspace-maintenance-lifecycle`

Worktree: `/home/grimodex/.codex/worktrees/pr600-lifecycle-replacement`

This record separates implementation evidence from independent acceptance. The
candidate incorporates the additional PR #601 review findings, the earlier Sol
max findings, the seven follow-up findings from the expanded static review,
and the latest four boundary findings:

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

The implementation checkpoint `a076389526654206fe712ae7f4bacd7ce4b42731`
received the bounded Sol max review below. The acceptance-record commits are
docs-only; their exact-head Quick/verify receipts are recorded in the PR body
after each final docs-only freeze. This is not a claim that every Layer C
journey or T01–T36 case has been executed.

## Focused implementation evidence

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
- prior focused DB, Native, Graph, Freshness, connection-retirement, result-validation, and compatibility-owner suites recorded in the C0/C1 acceptance records remain applicable to this candidate.
- `git diff --check` — passed before final candidate freeze.

## Independent gates and remaining evidence

| Gate | Status | Evidence boundary |
| --- | --- | --- |
| C0 contract review | bounded/limited | Contract and entry ledger are updated; full Layer C and T01–T36 evidence remain separate. |
| C1 core review | bounded/limited | Shared core, owner permits, delivery/descriptors, result axes, and resource order have focused coverage. |
| Sol max C5 review | approved/bounded for implementation checkpoint | `a076389526654206fe712ae7f4bacd7ce4b42731` was reviewed read-only with `gpt-5.6-sol`, max reasoning; P1: 0 and P2: 0. The review verified the fresh capacity-retry owner, exact H+1 retention, quiescence cancellation, partial-claim release, and the prior Restore `Unchanged` proof. The docs-only acceptance-record commit adds no code. |
| Layer C IPC journey | pending | A full Electron IPC → N-API → SQLite → renderer run has not been claimed. |
| T01–T36 matrix | pending | Focused tests cover representative cases; absence of a complete matrix is not a pass. |
| Quick + immediate verify | passed for implementation checkpoint; final docs-only receipt in PR body | The recorded commands below are bound to implementation checkpoint `1a87684b`; each later docs-only freeze is verified separately and reported with its exact HEAD in the PR body. |

The Windows GNU target check remains environment-blocked when the
`x86_64-w64-mingw32-gcc` toolchain is unavailable. No hosted-check, merge, or
master-publication claim is made here.

## Candidate ledger

```text
contract_id=pr600-lifecycle-ownership/2#workspace-maintenance-lifecycle
parent_pr=#600
parent_branch=codex/nir1-b-capacity-implementation
base_sha=8df6be62b2652a5c3e7bca1ffb0e874937313d43
child_branch=codex/pr600-lifecycle-replacement
worktree=/home/grimodex/.codex/worktrees/pr600-lifecycle-replacement
head_sha=a076389526654206fe712ae7f4bacd7ce4b42731 (implementation checkpoint; this acceptance record is docs-only and its final freeze receipt is recorded in the PR body)
tree_status=must be clean before Quick/verify
implementer=Luna max
independent_reviewers=Sol max (C5; read-only; model gpt-5.6-sol, max reasoning)
threat_model_ref_and_confirmation=policies/quality/iron-laws.md#GDX-PRECHECK-001; lifecycle ownership, renderer trust boundary, and process-local evidence limits are recorded in the contract
gate_status_c0=bounded-review
gate_status_c1=bounded-review
gate_status_c5=bounded-approve implementation checkpoint Sol max; docs-only freeze Quick/verify recorded in PR body
quick_command=pnpm ci:local:quick -- --base 8df6be62b2652a5c3e7bca1ffb0e874937313d43 --head a076389526654206fe712ae7f4bacd7ce4b42731
verify_command=pnpm ci:local:verify -- quick --base 8df6be62b2652a5c3e7bca1ffb0e874937313d43 --head a076389526654206fe712ae7f4bacd7ce4b42731
unresolved_findings=full Layer C IPC journey, complete T01-T36 evidence, Windows GNU cross-build when x86_64-w64-mingw32-gcc is unavailable, and no claim beyond the exact docs-only receipt in the PR body
environment_limits=Windows GNU check may be blocked by missing x86_64-w64-mingw32-gcc; no hosted-check claim
freeze_timestamp=docs-only record; final candidate timestamp and exact receipt are recorded in the PR body
```

No merge or master publication is included in this child PR.
