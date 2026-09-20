# PR #600 lifecycle replacement: C0 acceptance record

Candidate under review: the clean final checkout recorded in the external C5
freeze receipt (built from parent
`8df6be62b2652a5c3e7bca1ffb0e874937313d43`). Contract:
`pr600-lifecycle-ownership/2#workspace-maintenance-lifecycle`.

This is the independent C0 record for the lifecycle contract and entry-point
ledger. It is a read-only, bounded contract review; it does not replace the
C5 product acceptance and is not a green implementation gate for the rows
listed below as unresolved.

## Accepted contract boundaries

- `NotAdmitted`, `Pending`, `Unchanged`, `Activated`, `Restored`,
  `RecoveryRequired`, and `Closed` remain separate result/effect axes.
- `Unchanged` is tied to an exact binding and revision; a rejected request
  cannot authorize renderer binding reuse. A descriptor-bound recovery may
  run while a verified independent workspace is `Ready`.
- Run absence is split into `CreationNotCommitted`, `CreationUnknown`,
  `Created`, and `Reused`; child IDs are checked independently before an
  all-absent conclusion.
- delivery records can retire after main applies/ACKs a result while the
  recovery descriptor remains independently owned; normal capacity and the
  descriptor control slot are separate.
- eligibility readers receive a borrowed owner/connection context, and typed
  lifecycle termination is preserved ahead of Source-missing classification.
- I7 is split into physical `I7-P` and logical `I7-L`; Join and activation are
  explicit lifecycle completion boundaries.
- A Native descriptor supervisor can resolve exact maintenance Runs from the
  control slot before ordinary maintenance admission; a failed main ACK is
  retried by sequence without redispatching the batch.
- Main preflight reconciles an exact recovery descriptor before delivery
  admission. A `reconciled` or unavailable result releases the claim and
  retries after binding rediscovery, so a stale binding cannot enter the
  delivery ledger.
- `CreationUnknown` resolution uses the original worker Join and explicit
  connection-retirement receipt, stable database file identity, captured
  project/semantic-epoch lineage, and a single all-ID absence check. A
  cleanup-quarantined authority cannot be reused as the resolver.
- Project creation reservations are counted by project, so Fresh-to-Reused
  selection cannot leak a generated reservation. Destructive delete and Run
  reservation now share one process-local mutex-backed admission table; the
  durable active-Run and lineage checks remain mandatory for cross-process
  safety.
- Automatic maintenance permits remain under the outer Native supervisor;
  manual/legacy maintenance and Freshness reject pending-start through an
  explicit cancellation path. The isolated lifecycle harness also exercises
  the shared foreground lane and exact H+1 retry after ACK.
- The frozen Tauri compatibility owner may use a directly installed verified
  authority when the shared core has not yet published a binding; explicit
  Electron Transition/RecoveryRequired/Closed states remain fail-closed.

The following C0 rows remain open and block a green C1/C5 conclusion: full
Layer C journeys and T01-T36 evidence are still unrun, and frozen standalone
or MCP compatibility adapters require their own positive context coverage.
The Native product foreground lanes use the shared core participant and
borrowed transaction context; the compatibility boundary must not be widened
back into those lanes.

## Evidence inspected

- `docs/plans/pr600-lifecycle-replacement.md` and the implementation diff at
  the candidate checkpoint recorded above.
- Layer A shared-core tests: `cargo test --manifest-path
  src-tauri/Cargo.toml -p grimodex-db --lib workspace_lifecycle` (27 tests,
  including independent W2 Open with an unresolved W1 descriptor).
- Native lifecycle/open/restore and supervisor tests: `cargo test
  --manifest-path electron/native/grimodex-node/Cargo.toml --lib` (146 tests).
- DB maintenance ownership tests: `cargo test --manifest-path
  src-tauri/Cargo.toml -p grimodex-db --lib
  narrative_extraction::maintenance_lifecycle` (20 tests).
- Electron lifecycle, delivery, scheduler, and result focused tests: the
  current boundary run passed 28 tests in three maintenance suites, including
  exact W1 rebinding and the full-ledger ACK retry case. Electron TypeScript
  typecheck also passed.
- `cargo test --manifest-path src-tauri/Cargo.toml -p grimodex-db --lib
  state::tests::active_workspace_snapshot_pins_authority_including_lease`
  passed for the frozen Tauri compatibility path.
- Graph index and cold-reopen tests passed with an explicit foreground
  validation owner; the no-context whole-eligibility rejection remains
  typed and fail-closed.

## Scope limits

The dedicated `test-lifecycle` failpoint feature/binary and a full real
Electron IPC → N-API → SQLite → renderer Layer C evidence run are not part of
this candidate. The Windows GNU target check is also environment-blocked by a
missing `x86_64-w64-mingw32-gcc` toolchain. T01–T36 are not represented as
all-green by this C0 record;
their execution and the independent C5 review remain required before the PR
is considered accepted.
