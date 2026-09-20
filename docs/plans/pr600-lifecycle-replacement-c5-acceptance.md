# PR #600 lifecycle replacement: C5 candidate record

Parent PR: `#600`
Parent branch: `codex/nir1-b-capacity-implementation`
Base SHA: `8df6be62b2652a5c3e7bca1ffb0e874937313d43`
Child branch: `codex/pr600-lifecycle-replacement`
Contract: `pr600-lifecycle-ownership/2#workspace-maintenance-lifecycle`
Implementation checkpoint: `6b7407e7`
Candidate HEAD: `19d19d7823838a67c16d44a667708dab485dea91`
Worktree: `/home/grimodex/.codex/worktrees/pr600-lifecycle-replacement`

This record separates focused implementation evidence from independent final
acceptance. The candidate keeps PR #600 Graph/SQL/measurement behavior and
adds the five C0 contract corrections: result/effect separation, exact Run
creation evidence, independent descriptor recovery capacity, positive context
supply, and I7-P/I7-L resource ordering.

## Focused implementation evidence

- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib workspace_lifecycle` — 26 passed.
- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib narrative_extraction::maintenance_lifecycle` — 20 passed.
- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib narrative_extraction::task_leases` — 2 passed (confirmed and ambiguous creation outcomes).
- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib narrative_maintenance_connection` — 19 passed (open-transaction retirement and close-baton retry).
- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib state::tests::active_workspace_snapshot_pins_authority_including_lease` — passed.
- `cargo test --manifest-path electron/native/grimodex-node/Cargo.toml --lib` — 146 passed.
- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib
  narrative_maintenance_connection::tests::retirement_receipt_can_be_emitted_after_cleanup_quarantine` — 1 passed.
- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib
  narrative_extraction::repository::unit_tests::project_creation_reservations_count_and_release_without_run_id_leaks` — 1 passed.
- `cargo test --manifest-path electron/native/grimodex-node/Cargo.toml --lib narrative_freshness_restore_lock_tests` — 4 passed.
- `pnpm exec tsc -p electron/tsconfig.json --noEmit` — passed.
- `pnpm exec vitest --config vitest.electron.config.ts --run electron/main/narrativeMaintenance.reacceptance.test.ts electron/main/narrativeMaintenanceDelivery.test.ts electron/main/narrativeMaintenance.test.ts` — 85 passed.
- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib narrative_extraction::nir1_entity_relation::tests::` — 75 passed, including Graph cold-reopen and foreground-context paths.
- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --features nir1-material-diagnostics --test nir1_capacity_binary` — 3 passed, including Restore/Freshness recovery through the validation owner.
- `git diff --check` — passed on the implementation checkpoint.
- `cargo check --target x86_64-pc-windows-gnu ...` — environment blocked before
  project compilation because `x86_64-w64-mingw32-gcc` is unavailable; this is
  recorded as a limitation, not a pass.

The focused tests cover the new W1-descriptor/W2-open transition, Native
descriptor control replay, creation reservation/recovery classification,
Freshness lifecycle membership, frozen Tauri direct-authority compatibility,
and ACK-only retry without a second Native cycle dispatch.

## Required final gates

| Gate | Status | Evidence rule |
| --- | --- | --- |
| C0 independent contract review | accepted in `pr600-lifecycle-replacement-c0-acceptance.md` | Must remain separate from implementation claims. |
| C1 independent core review | accepted in `pr600-lifecycle-replacement-c1-acceptance.md` | 26 core tests and Layer B Native tests are recorded. |
| C5 Sol max review | required for the exact clean final HEAD | Reviewer must be read-only and check the prior P1 findings again. |
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
head_sha=19d19d7823838a67c16d44a667708dab485dea91
tree_status=clean before final focused/Quick/verify runs
changed_paths=docs/plans, electron/main, electron/native/grimodex-node, src-tauri/crates/grimodex-db
implementer=Luna max
independent_reviewer=Sol max (C5; read-only)
threat_model_ref_and_confirmation=policies/quality/iron-laws.md#GDX-PRECHECK-001; lifecycle ownership, renderer trust boundary, and process-local evidence limits recorded in the contract
entry_matrix_ref=docs/plans/pr600-lifecycle-replacement.md#concrete-c0-callsite-ledger
gate_status_c0=accepted
gate_status_c1=accepted
gate_status_c5=pending exact-head Sol max plus Quick/verify
focused_commands=see focused implementation evidence above
focused_receipt_paths=docs/plans/pr600-lifecycle-replacement-c0-acceptance.md; docs/plans/pr600-lifecycle-replacement-c1-acceptance.md
quick_command=pnpm ci:local:quick -- --base 8df6be62b2652a5c3e7bca1ffb0e874937313d43 --head 19d19d7823838a67c16d44a667708dab485dea91
quick_base_sha=8df6be62b2652a5c3e7bca1ffb0e874937313d43
quick_head_sha=19d19d7823838a67c16d44a667708dab485dea91
quick_receipt_path=to be recorded after exact-head run
verify_command=pnpm ci:local:verify -- quick --base 8df6be62b2652a5c3e7bca1ffb0e874937313d43 --head 19d19d7823838a67c16d44a667708dab485dea91
verify_receipt_path=to be recorded after immediate exact-head run
test_binary_hashes=to be recorded for final test-lifecycle/build artifacts if produced
unresolved_findings=full Layer C IPC journey, dedicated test-lifecycle feature/binary, and all-green T01-T36 evidence are not yet run
environment_limits=Windows GNU check blocked by missing x86_64-w64-mingw32-gcc; no hosted-check claim
freeze_timestamp=to be recorded after Quick/verify and Sol max review
```
