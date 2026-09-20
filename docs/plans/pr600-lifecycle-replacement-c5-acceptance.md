# PR #600 lifecycle replacement: C5 candidate record

Parent PR: `#600`
Parent branch: `codex/nir1-b-capacity-implementation`
Base SHA: `8df6be62b2652a5c3e7bca1ffb0e874937313d43`
Child branch: `codex/pr600-lifecycle-replacement`
Contract: `pr600-lifecycle-ownership/2#workspace-maintenance-lifecycle`
Implementation checkpoint: `2d5d1de2`
Worktree: `/home/grimodex/.codex/worktrees/pr600-lifecycle-replacement`

This record separates focused implementation evidence from independent final
acceptance. The candidate keeps PR #600 Graph/SQL/measurement behavior and
adds the five C0 contract corrections: result/effect separation, exact Run
creation evidence, independent descriptor recovery capacity, positive context
supply, and I7-P/I7-L resource ordering.

## Evidence completed

- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib workspace_lifecycle` — 24 passed.
- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib narrative_extraction::maintenance_lifecycle` — 20 passed.
- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib state::tests::active_workspace_snapshot_pins_authority_including_lease` — passed.
- `cargo test --manifest-path electron/native/grimodex-node/Cargo.toml --lib` — 146 passed.
- `cargo test --manifest-path electron/native/grimodex-node/Cargo.toml --lib narrative_freshness_restore_lock_tests` — 4 passed.
- `pnpm exec tsc -p electron/tsconfig.json --noEmit` — passed.
- `pnpm test:electron --run electron/main/narrativeMaintenance.reacceptance.test.ts electron/main/narrativeMaintenanceDelivery.test.ts electron/main/narrativeMaintenance.test.ts` — 83 passed.
- `git diff --check` — passed on the implementation checkpoint.

The focused tests cover the new W1-descriptor/W2-open transition, Native
descriptor control replay, creation reservation/recovery classification,
Freshness lifecycle membership, frozen Tauri direct-authority compatibility,
and ACK-only retry without a second Native cycle dispatch.

## Required final gates

| Gate | Status | Evidence rule |
| --- | --- | --- |
| C0 independent contract review | accepted in `pr600-lifecycle-replacement-c0-acceptance.md` | Must remain separate from implementation claims. |
| C1 independent core review | accepted in `pr600-lifecycle-replacement-c1-acceptance.md` | 24 core tests and Layer B Native tests are recorded. |
| C5 Astra High review | required for the exact clean final HEAD | Reviewer must be read-only and check the prior P1 findings again. |
| local Quick + immediate verify | required on the frozen final HEAD | Base and head must be the same exact pair in both commands. |

The dedicated `test-lifecycle` feature/binary, a full real Electron
IPC → N-API → SQLite → renderer Layer C journey, and an all-green T01–T36
run have not been claimed by this record. Their absence is an explicit
environment/evidence limitation, not a pass. No merge or master publication
is included in this child PR.

## Candidate ledger fields

```text
contract_id=pr600-lifecycle-ownership/2#workspace-maintenance-lifecycle
parent_pr=#600
parent_branch=codex/nir1-b-capacity-implementation
base_sha=8df6be62b2652a5c3e7bca1ffb0e874937313d43
child_branch=codex/pr600-lifecycle-replacement
worktree=/home/grimodex/.codex/worktrees/pr600-lifecycle-replacement
implementer=Luna max
independent_reviewer=Astra High (C5; read-only)
gate_status_c0=accepted
gate_status_c1=accepted
gate_status_c5=pending exact-head Astra High plus Quick/verify
```
