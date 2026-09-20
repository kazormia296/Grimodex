# PR #600 lifecycle replacement: C1 acceptance record

Candidate under review: `044340e6` (built from parent
`8df6be62b2652a5c3e7bca1ffb0e874937313d43`). Contract:
`pr600-lifecycle-ownership/2#workspace-maintenance-lifecycle`.

This is the independent C1 record for the pure lifecycle core, strict DTOs,
delivery ledger, responsibility capacity, and permit split. It is a read-only
review record; it does not claim whole-product acceptance.

## Accepted implementation checks

- `WorkspaceLifecycleCore` is shared through `WorkspaceState` and has no
  Tokio/N-API dependency.
- Transition completion requires the supervisor's explicit Join observation;
  lifecycle snapshots do not publish Ready or RecoveryRequired as a side
  effect.
- maintenance, workspace transition, workspace-exclusive, and work
  publication permits are distinct, and compatibility switching cannot reopen
  normal DB access while a core transition remains active.
- delivery high-water/fingerprint replay, `resolveOrFence`, terminal result
  retention, ACK retirement, descriptor control generation, and the
  255+1 responsibility capacity are covered by core tests.
- the projection exposes only revision, opaque UI token, allowlisted status,
  and activation; repeated same-revision payloads are idempotent and stale
  results do not restore a renderer binding.
- panic/open-lock recovery and Safe Mode/RecoveryRequired open paths have
  Native regression coverage.

## Evidence inspected

- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib workspace_lifecycle`
  passed 15 tests.
- `cargo test --manifest-path electron/native/grimodex-node/Cargo.toml`
  passed 146 tests, including lifecycle view and open/restore ownership cases.
- Electron lifecycle result, projection, delivery, scheduler, and shutdown
  tests passed (526 tests in the combined focused run).
- `git diff --cached --check` passed before the candidate commit.

## Scope limits

C1 proves the pure core and its Layer B owner integration only. It does not
claim the dedicated `test-lifecycle` feature/binary, full Layer C journeys,
or successful execution of every T01–T36 case. Those remain explicitly
tracked for C5.
