# NIR-1 D2b dispatch ownership implementation record

This candidate implements the existing confirmed
`nir1-l6-l9-contract-proposal/3#native-generation-receipt` and
`#caller-profile-egress` contracts and post-B sections 4 and 9. It does not
open a product entry, change the threat model, or authorize HTTP. The test
recorder cannot be selected from renderer, IPC, environment, or settings.

## Pre-mutation ownership and lock proof

The existing profile permit and workspace participant remain the owners.
Their current check-only APIs cannot linearize authorization with a later DB
claim. Narrow closure APIs retain their existing locks through the claim and
COMMIT. The workspace closure requires the exact `LiveBinding`, including
authority instance and recovery generation. The legacy switching view must
hold the same core mutex across both true and false atomic writes.

Lock order is DB connection / fresh IMMEDIATE transaction, attempt cancellation
state, profile state, workspace lifecycle core. Cancel only mutates attempt
state and releases that lock before any DB terminal write, so cancellation
can win while dispatch is waiting for a DB connection. No profile/core
critical section acquires a DB connection. Settings update holds the profile
state lock, revokes the existing permit generation, and writes the settings
file without acquiring DB/core. The one Electron production settings writer
is `Backend::save_ai_settings`; the shared file writer does only serialization
and filesystem I/O. Final route verification belongs under this same profile
lock. A failed route write still revokes old permits.

The final claim must use an ordinary freshly owned DB connection, not
`with_participant_sql_scope` or `with_participant_read_transaction`: their
progress hook calls `WorkspaceParticipant::stop_requested`, which would
re-lock the lifecycle mutex. Canonical currentness reads happen in the same
fresh IMMEDIATE transaction before the final guards. Only the bounded CAS
and COMMIT remain under the guards; no helper in this interval may install
a progress hook or reacquire profile/lifecycle state. A failed/unknown COMMIT
never grants transport ownership. Locks are released before any transport
wait. Claim durability marks the application dispatch right, not evidence
that a provider received bytes.

The unpublished Native `GenerationRecoveryCoordinator` is a separate
restart/reopen primitive. It captures one exact `Ready` lifecycle binding with
a pinned `ActiveWorkspaceSnapshot`, participant, and Native workspace-operation
guard. DB APIs expose bounded keyset pages for projects with pending attempts
across the workspace, each project's pending IDs, and a participant-controlled
terminal write. Each operation has a finite deadline and SQLite busy-wait cap; the Native sweep caps
pages (4,096), items (2,048), and wall time (5 seconds), with pages of at most
64 IDs and operations capped at 250 ms / 100 ms busy wait. Stops, contention,
errors, and budget exhaustion return incomplete; already committed terminal
rows remain for a later fresh capture. Recovery never resends, reconstructs a
payload, claims an old handle, creates a body/message version, qualifies
history, touches Graph, or invokes transport.

### Bounded recovery implementation impact matrix and finite owner notes

| ID | Flow / variant | Owner / boundary | Consumer / sink | Preserved invariant | Verification | Status |
|---|---|---|---|---|---|---|
| R1 | One pending-project-ID page | `grimodex-db::ActiveWorkspaceSnapshot` selects projects with `terminal_json IS NULL` attempts before ascending keyset LIMIT | Native recovery sweep | Workspace-wide scope, no caller project selector; empty/terminal-only projects do not consume pending-page budget; no DB mutex or transaction spans pages | 65 pending projects across keyset boundaries; unchanged three-page budget retires later projects on fresh-owner retries | implemented; Native follow-up passed 24/24 |
| R2 | One pending-attempt page | DB pager scoped to exact project ID and pending status, ascending attempt ID keyset | Native recovery sweep | Immutable attempt ID; exhaustive per-project cursor; no truncated global sample | 65 pending attempts recovered across 64-ID page boundary | implemented |
| R3 | One terminal recovery write | DB writer updates only the selected existing attempt inside participant-controlled IMMEDIATE transaction | Native coordinator | Existing conservative terminal matrix; no body/message creation, output replay, resend, or history qualification | partial terminal failure leaves committed row; fresh capture retries pending rows | implemented |
| R4 | Bounded participant SQL operation | `Database` owns mutex acquisition checks, bounded busy timeout, SQL progress stop/deadline, rollback, setting restoration, and connection quarantine | R1–R3 | Exact participant and pinned snapshot remain authoritative; an interrupted/unknown operation is incomplete, never success | bounded DB filter passed 18 tests; covers mutex wait, busy timeout, SQL cancel/deadline, rollback, settings restoration and connection reuse | implemented |
| R5 | Whole recovery sweep | Private Native coordinator owns exact binding single-flight, detached blocking worker, all-project enumeration, and finite item/page/wall-clock limits | Private post-Ready helper, called only from Open/Restore supervisors after Ready publication | One DB operation at a time, partial terminal rows persist, all owner state released on every exit; fresh capture only retries | Native focused filter passed 24 tests; includes >64 pending-project/attempt boundaries, same-page-budget fresh-owner progress, each sweep cutoff, re-entry, distinct DB pinning, transition/shutdown, detached completion and regressed wall-clock recovery | implemented, private only |
| R6 | Open / Restore placement | Native supervisors pass the exact published Ready revision to the private helper after releasing operation guards; worker captures the exact `LiveBinding` only when it starts | Actual Open and successful Restore callsites | Detached, best-effort recovery cannot alter caller outcome; only exact Ready / Restore activation `ready` is eligible; monotonic revision-tagged status is bounded to one binding and incomplete remains retryable | Native 30/30 focused tests include actual Open + Restore callsites; a test-only synchronous pre-spawn observation records the exact revision/binding, `open_lock.try_lock`, operation count and participant count; failure-preserving outcomes, A→B/revision races, shutdown retirement, and fresh-entry retry remain covered | implemented; private only |

Lifecycle note (R1–R6): one private owner is created only for one exact
`LiveBinding`; identical-binding re-entry coalesces, and a different pinned
database remains isolated. The owner retains its participant and operation
guard for the sweep, but never holds a connection mutex or transaction across
pages. Participant stop, transition, shutdown, SQL error, and any operation or
sweep cutoff return incomplete; only confirmed terminal writes survive. A
worker stop request, timeout, or rejection is never treated as proof that
unknown work completed. Since recovery does no egress and creates no handle,
remaining attempts await a later Ready entry. The private Open/Restore hook is
detached and never completion or attempt-creation-barrier evidence.

Finite values are safety cutoffs, not a supported project/backlog capacity or
permission to delay startup. The DB participant operations and sweep budget are
implemented and focused-tested. Normal Open and successful Restore now launch
a private best-effort worker only after Ready publication and Native operation
guards release; Restore additionally requires activation `ready`. The worker
captures no participant or workspace-operation guard before it starts, then
checks the exact publication revision, `LiveBinding` (including recovery
generation), transition and shutdown. A monotonic revision-tagged ledger retains
at most one binding; stale launchers/workers cannot prune or overwrite a newer
entry. Failure and incomplete passes remain retryable at a later Ready entry
under the unchanged finite sweep limits. The hook does not establish an
attempt-creation barrier.

### Startup integration (R-hook implemented; claim barrier remains HOLD)

The Open and successful Restore callsites publish lifecycle Ready before
invoking the private helper, release their workspace-operation guard, and do
not await recovery. Failed Open/Restore, Restore `requires-open`,
RecoveryRequired, Closed, and stale lifecycle revisions are suppressed. Real
callsite tests preserve successful Open/Restore outcomes even when recovery
fails. They synchronously observe the launcher boundary before detached spawn:
the exact Ready revision/binding, `open_lock.try_lock`, workspace-operation
count and participant count. Separate post-response checks remain additional
evidence, not the launch-time proof. Tests also cover a real RecoveryRequired
Restore (`requires-open` activation), completed duplicate suppression, delayed
A→B rejection, same-binding failed-Restore revision invalidation, DB-wait
shutdown status retirement and fresh Ready-entry retry. Renderer evidence is
paired but remains a separate boundary: the focused
`workspaceLifecycleProjection.test.ts` exercises exact Open Ready while
explicit hydration is pending, operation-scoped Unchanged, and repeated
RecoveryRequired projections with a retained dirty detached draft. This is the
production renderer projection machine, fed exact lifecycle proof values; it is
not a renderer-driven Native Open/Restore journey. The current product-journey
fixture DML allowlist and IPC contract do not provide a NIR-1 attempt writer;
a separate approved fixture producer would be needed for one joined journey.
Open's old-scope draft cleanup also runs after successful Project hydration;
the Ready assertion is deliberately before that boundary. Broader product
journeys remain with E-acceptance; no renderer test-only gate is introduced.
The attempt-creation barrier remains HOLD.

The previous uncontrolled-`with_conn` mutex-wait gap remains addressed:
project and pending-ID pages plus terminal writes use participant-controlled DB
operations with finite SQL deadlines, bounded SQLite busy wait,
cancellation/rollback, and connection-setting restoration. The Native owner
caps a full sweep at 4,096 pages, 2,048 attempts and 5 seconds. No
attempt-creation barrier exists; such a barrier is separately HOLD and no
completion authority is granted by publishing Ready or launching recovery.

## Finite lifecycle matrix

| Entry or state | Owner and action | Stop, termination and restart |
|---|---|---|
| Create and reentrant create | Native owner persists fixed payload and exact ordered references through the existing durable-attempt writer; retains profile permit, participant and pinned DB | Before commit no accepted attempt exists; after commit it is recoverable. An opaque ID never grants authorization. |
| Pending start and DB wait | Owner retains no DB transaction while queued and no cancellation lock while waiting for DB | Cancel/expiry/profile/workspace/route change before the fixed point prevents the recorder call. Pending work cannot outlive owner cleanup. |
| Concurrent start | One fresh transaction plus profile and exact workspace guards covers currentness, CAS and COMMIT | One committed claim owns the right. A losing duplicate never calls transport. No retry resets the claimed state. |
| Claimed before transport | Successful claim owner alone may enter the fixed internal transport | A later stop may cancel before transport or during it; bytes already passed cannot be recalled. Reuse of the old attempt is forbidden. |
| Transport response wait | Same owner retains profile lease and workspace participant; no DB/profile/lifecycle/attempt lock spans the wait | Cancel/timeout requests stop, observes actual transport close, and invalidates result qualification. A rejected promise or stop request is not close proof. The isolated recorder has no background task or unbounded wait. |
| Terminal save after admissions close | Existing owner writes only its exact attempt on the pinned DB through the body/version/receipt transaction | New admission is not required. Failed persistence leaves history unavailable and the durable attempt recoverable. Ownership retires after actual close and cleanup. |
| Error, timeout and onClosed | Same owner chooses an existing five-row terminal matrix observation | Unobserved provider termination is never invented. No callback-first success publication. |
| Retry and regenerate | New handle/attempt, payload references and authorization | Old claimed handles never reenter. No hidden HTTP retry, redirect or proxy exists in the test path. |
| Startup and explicit Open | Startup auto-open and explicit Open converge on Native `open_workspace`. The private hook runs after `publish_workspace_lifecycle_from_workspace` returns exact `Ready` and the supervisor releases its workspace-operation guard; it is never inside `finish_workspace_open_success`. | Native real-callsite test records lock/operation/participant state synchronously at launcher boundary before detached spawn. Separate renderer projection test observes exact Ready during pending explicit hydration and a retained detached dirty draft; it stops before the Open owner's post-hydration old-scope cleanup. |
| Successful Restore | Restore publishes Ready from its own supervisor through `publish_workspace_lifecycle_from_workspace`; it does not pass through the Open supervisor. Its hook runs only for successful Restore with exact `Ready` / activation `ready`, after operation guard release; `requires-open` defers to bootstrap Open. | Native real-callsite tests capture the exact revision/binding and lock/operation/participant state synchronously before spawn, and cover successful and failed/RecoveryRequired outcomes. Separate renderer projection assertions retain a dirty detached draft across exact Unchanged and RecoveryRequired proofs; they do not run `restoreBackupWithWorkspaceAuthority` or one real Electron Restore. |
| Begin and re-entry | The private sweep owns the exact Ready binding, pinned snapshot, participant, and operation guard. Permit at most one sweep per exact binding; same-binding re-entry coalesces. It enumerates all projects with pending attempts (no renderer/caller project ID), filtering before keyset LIMIT with pages capped at 64, then exhausts bounded pending-ID pages per project under finite sweep limits. | Capture racing Transition/shutdown skips. Each DB call is a separate controlled operation; no transaction or connection mutex spans pages. |
| Page, workspace switch, and shutdown | Controlled DB calls check participant stop/deadline during mutex acquisition and SQL, use bounded SQLite busy waits, roll back interrupted writes, and restore connection settings. | Held-mutex transition/shutdown tests prove participant and operation ownership drain within the operation bound. Any stop or error is incomplete, never success. |
| Completion evidence | The internal summary is returned only after bounded project enumeration and every per-project pending page are exhausted under the same binding and within item/page/time/operation cutoffs. | Any stop, timeout, item/page-budget exhaustion, mutex contention, SQLite busy/error, or lifecycle change means incomplete. Recovery writes no body/message version and grants no old-handle or history authority. |
| Partial failure and retry | A page/read/write error or per-sweep budget exhaustion exits the owner and leaves already-committed terminal rows intact. Remove the in-memory single-flight entry on every exit. | No tight retry loop: release participant/operation ownership, then a later Open/cold start captures a fresh owner and resumes remaining pending rows. Fresh enumeration skips empty and fully terminalized projects rather than spending the same page budget on them again. Until then those outputs remain unavailable for history. |
| Future claim barrier — HOLD | No production claim/attempt creator is wired today. Before any `GenerationClaimOwner` start/claim is connected, add a serialized startup barrier that prevents new attempt creation until exhaustive all-project recovery reports complete for the exact binding. | Recovery never authorizes dispatch, transport, Graph, history qualification, or reuse of an old handle. One-project completion, an interrupted pass, or merely publishing Ready is not barrier proof. |

## Validation scope

The dispatch claim suite covers profile/route and exact workspace guard
ordering, pending DB-wait cancellation, duplicate claim recorder 0/1,
invalidation-before-claim 0, and guard release before transport observation.
Recovery evidence includes the focused DB `bounded_` filter (18 passed),
then the original serialized DB `nir1_generation` filter (58 passed) and Native
`nir1_generation::tests::` filter (23 passed): file-backed all-
project cold reopen beyond 64 project/attempt boundaries, no-resend terminal
observations, partial terminal-write failure and fresh-owner retry, item/page/
time cutoffs, same-binding re-entry, pinned distinct databases, held-mutex
transition/shutdown cleanup, Ready-only launch, and return before detached
work completes. DB tests cover bounded SQLite busy wait, SQL cancellation and
deadline rollback, prior busy-timeout restoration, and connection reuse.

Independent Luna Max review found a P2 where wall-clock regression could leave
an attempt pending. Recovery-only terminalization now clamps its timestamp to
the durable creation/claim times in the same transaction. Live completion still
rejects timestamp mismatch. DB and cold-reopen Native regressions passed in the
58/23 runs, and candidate-untouched re-review resolved the P2 with no findings
for this recovery slice. Logs are `.artifacts/nir1-post-b/recovery-clock-storage-final.log`
and `recovery-clock-native-final.log`; this is not whole-candidate acceptance.

The subsequent PR #608 review found a separate P2: empty and terminal-only
projects could consume the page budget again on every fresh capture. The DB
project pager now filters by pending-attempt existence before keyset LIMIT,
using the existing pending index and unchanged bounded participant scope.
A real Native regression failed against the old SQL, then passed after the
fix: four empty leading projects and two pending projects use the same
three-page limit on every owner; pending counts decrease 2 → 1 → 0, and a
final owner confirms exhaustion without increasing any limit. The >64-project
fixture now gives every project pending work (129 attempts across 65 projects),
rather than counting empty projects as coverage. The one-page rejection test
runs while pending work exists, not after all work is terminalized.

Post-fix serialized focused commands passed Native **24/24** and DB **58/58**.
Logs: `.artifacts/nir1-post-b/recovery-page-starvation-red.log`,
`recovery-page-starvation-native-green.log`, and
`recovery-page-starvation-storage-green.log`. This is working-tree diagnostic
evidence, not a new independent acceptance or Quick/Full receipt.

R-hook Native tests pass 30/30 and cover exact Ready-only Open/Restore
placement, synchronous pre-spawn launch observations (exact revision/binding,
open-lock availability, operation count and participant count), caller success
under recovery failure, actual failed and RecoveryRequired Restore, direct
`requires-open` activation gating, completed duplicate suppression, delayed A→B
schedule and cleanup interleaving, same-binding failed-Restore revision
invalidation, DB-wait shutdown status retirement, and fresh Ready-entry retry.
The focused renderer projection file passes 7/7 and covers exact pending-Open
Ready, Unchanged Restore proof, and repeated RecoveryRequired projection while
a dirty detached draft remains registered. These are separate Native and
renderer boundary tests, not an Electron end-to-end journey; the current
harness has no approved NIR-1 attempt fixture writer. This is working-tree
diagnostic evidence, not independent acceptance or a Quick/Full receipt.
Storage tests separately own crash recovery and body/receipt atomicity.
Focused tests do not establish product dispatch, history qualification, bounded
real-provider termination, or NIR-1 completion.

The landed `GenerationClaimOwner` is an unpublished control-plane foundation.
It owns a pinned DB, profile permit, exact workspace participant binding, route
configuration digest and cancellation state. The durable prepared-claim API
validates references before authority guards and consumes its private
transaction inside them. The recovery coordinator remains a private post-Ready
Open/Restore path; it does not authorize claim or dispatch. The only transport
is a synchronous test recorder.
There is no production coordinator for material/Scope/history reauthorization,
provider wait/cancel/close, terminal cleanup or renderer handle lookup yet;
`consume_claim` explicitly grants none of those permissions. D2b-1 remains
incomplete until those required paths and their acceptance are integrated.
