# PR #600 lifecycle replacement: C0 acceptance record

Candidate under review: `044340e6` (built from parent
`8df6be62b2652a5c3e7bca1ffb0e874937313d43`). Contract:
`pr600-lifecycle-ownership/2#workspace-maintenance-lifecycle`.

This is the independent C0 record for the lifecycle contract and entry-point
ledger. It is a read-only review record; it does not replace the C5 product
acceptance.

## Accepted contract boundaries

- `NotAdmitted`, `Pending`, `Unchanged`, `Activated`, `Restored`,
  `RecoveryRequired`, and `Closed` remain separate result/effect axes.
- `Unchanged` is tied to an exact binding and revision; a rejected request
  cannot authorize renderer binding reuse.
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

## Evidence inspected

- `docs/plans/pr600-lifecycle-replacement.md` and the implementation diff at
  candidate `044340e6`.
- Layer A shared-core tests: `pnpm test:narrative:lifecycle` (15 core tests).
- Native lifecycle/open/restore and supervisor tests: 146 tests passed.
- Electron scheduler, delivery, result, shutdown, IPC, and projection tests:
  526 tests passed.
- DB connection/runtime/lifecycle focused suites passed, including 15
  connection tests, 35 runtime tests, and the lifecycle/reacceptance test
  binaries.

## Scope limits

The dedicated `test-lifecycle` failpoint feature/binary and a full real
Electron IPC → N-API → SQLite → renderer Layer C evidence run are not part of
this candidate. The C0 contract is therefore accepted as the implementation
boundary, while full T01–T36 product acceptance remains a C5 responsibility.
