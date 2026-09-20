# PR #600 lifecycle replacement: C5 candidate record

Parent PR: `#600`

Parent branch: `codex/nir1-b-capacity-implementation`

Base SHA: `8df6be62b2652a5c3e7bca1ffb0e874937313d43`

Child branch: `codex/pr600-lifecycle-replacement`

Contract: `pr600-lifecycle-ownership/2#workspace-maintenance-lifecycle`

Worktree: `/home/grimodex/.codex/worktrees/pr600-lifecycle-replacement`

This record separates implementation evidence from independent acceptance. The
candidate incorporates the three additional P1 findings from the PR #601
review and the earlier Sol max findings:

- retained work is rebound only by an exact descriptor-proven
  original-binding → rebound-binding pair; an unrelated Ready workspace is
  never used as a rebinding source;
- a local full delivery ledger does not consume `H+1`; after ACK frees a
  record, the exact sequence can be admitted by Native;
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

The candidate is ready for an independent Sol max re-review. It is not a claim
that every Layer C journey or T01–T36 case has been executed.

## Focused implementation evidence

- `pnpm test:electron --run electron/main/narrativeMaintenanceDelivery.test.ts electron/main/narrativeMaintenance.wiring.test.ts electron/main/workspaceLifecycleResult.test.ts` — 3 files, 28 tests passed.
- `pnpm exec tsc -p electron/tsconfig.json --noEmit` — passed.
- `pnpm test:narrative:lifecycle` — contract marker validation, 27 Layer A core tests, the Freshness lifecycle-control test, the opt-in `test-lifecycle` harness, and four Native lifecycle-view tests passed.
- `cargo check --manifest-path electron/native/grimodex-node/Cargo.toml` — passed; existing dead-code warnings only.
- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib workspace_lifecycle` — 27 passed, including shared foreground/maintenance admission, pending-start retirement, exact H+1 retry, and independent W2 Open with a W1 descriptor.
- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib narrative_extraction::repository::unit_tests::project_creation_and_destructive_admission_share_one_boundary` — passed.
- the isolated `lifecycle-harness` (`--features test-lifecycle`) — passed; it checks the shared execution lane and full-capacity reject → ACK → exact-sequence retry model.
- prior focused DB, Native, Graph, Freshness, connection-retirement, result-validation, and compatibility-owner suites recorded in the C0/C1 acceptance records remain applicable to this candidate.
- `git diff --check` — passed before final candidate freeze.

## Independent gates and remaining evidence

| Gate | Status | Evidence boundary |
| --- | --- | --- |
| C0 contract review | bounded/limited | Contract and entry ledger are updated; full Layer C and T01–T36 evidence remain separate. |
| C1 core review | bounded/limited | Shared core, owner permits, delivery/descriptors, result axes, and resource order have focused coverage. |
| Sol max C5 review | pending | Must review the exact clean final HEAD read-only, including the three PR #601 P1 findings and prior ownership findings. |
| Layer C IPC journey | pending | A full Electron IPC → N-API → SQLite → renderer run has not been claimed. |
| T01–T36 matrix | pending | Focused tests cover representative cases; absence of a complete matrix is not a pass. |
| Quick + immediate verify | pending | Both commands must use the same frozen base/head pair after the final commit. |

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
head_sha=recorded in the final PR update and freeze receipt
tree_status=must be clean before Quick/verify
implementer=Luna max
independent_reviewer=Sol max (C5; read-only)
threat_model_ref_and_confirmation=policies/quality/iron-laws.md#GDX-PRECHECK-001; lifecycle ownership, renderer trust boundary, and process-local evidence limits are recorded in the contract
gate_status_c0=bounded-review
gate_status_c1=bounded-review
gate_status_c5=pending exact-head Sol max plus Quick/verify
quick_command=pnpm ci:local:quick -- --base 8df6be62b2652a5c3e7bca1ffb0e874937313d43 --head "$candidate_head"
verify_command=pnpm ci:local:verify -- quick --base 8df6be62b2652a5c3e7bca1ffb0e874937313d43 --head "$candidate_head"
unresolved_findings=full Layer C IPC journey, complete T01-T36 evidence, and independent final Sol max review
environment_limits=Windows GNU check may be blocked by missing x86_64-w64-mingw32-gcc; no hosted-check claim
freeze_timestamp=to be recorded after the final clean-head gates
```

No merge or master publication is included in this child PR.
