# PR #600 lifecycle replacement: C1 acceptance record

Candidate under review: the clean final checkout recorded in the external C5
freeze receipt (built from parent
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
  255+1 responsibility capacity are covered by core tests. Descriptor-bound
  recovery is admitted from `Ready` only for the exact unresolved root.
- Native recovery consumes exact descriptor Run tuples, resolves unknown
  creation only with the post-Join evidence contract, and replays the control
  generation idempotently before activation.
- the projection exposes only revision, opaque UI token, allowlisted status,
  and activation; repeated same-revision payloads are idempotent and stale
  results do not restore a renderer binding.
- panic/open-lock recovery and Safe Mode/RecoveryRequired open paths have
  Native regression coverage.
- the recovery root's expected binding remains immutable across retries while
  the current active binding is kept separate; Native preflight reaches
  descriptor reconciliation before normal delivery admission.
- creation evidence records stable file identity and semantic epoch lineage
  at reservation time, and the supervisor records connection retirement after
  Join before resolving an unknown creation.
- permit ownership remains with the outer supervisor on worker panic or
  JoinError, and terminal delivery is persisted only after Join plus release
  or descriptor transfer.

## Evidence inspected

- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib
  workspace_lifecycle` passed 26 tests.
- `cargo test --manifest-path electron/native/grimodex-node/Cargo.toml --lib`
  passed 146 tests, including lifecycle view and open/restore ownership cases.
- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib
  narrative_extraction::maintenance_lifecycle` passed 20 tests.
- Electron lifecycle result, projection, delivery, scheduler, and shutdown
  focused tests passed (85 tests); `pnpm exec tsc -p electron/tsconfig.json
  --noEmit` passed.
- The maintenance lifecycle DB suite passed 20 tests after adding the
  reservation/control callback path; Native Freshness restore-lock tests
  passed 4 tests with the shared maintenance permit.
- `git diff --check` and the staged candidate diff check passed before the
  candidate commit.

## Scope limits

C1 proves the pure core and its Layer B owner integration only. It does not
claim the dedicated `test-lifecycle` feature/binary, full Layer C journeys,
or successful execution of every T01–T36 case. Those remain explicitly
tracked for C5.
