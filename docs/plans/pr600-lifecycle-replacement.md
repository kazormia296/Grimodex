# PR #600 lifecycle replacement contract

Status: implementation contract for `codex/pr600-lifecycle-replacement`
Contract: `pr600-lifecycle-ownership/2#workspace-maintenance-lifecycle`
Parent base: `codex/nir1-b-capacity-implementation` at
`8df6be62b2652a5c3e7bca1ffb0e874937313d43`
Child branch: `codex/pr600-lifecycle-replacement`

Latest committed implementation checkpoint: this document is updated with the
foreground execution lane, exact recovery rebinding, delivery-capacity retry,
project admission, pending-start retirement, and isolated lifecycle harness
fixes. The final candidate SHA and exact receipts are recorded only after the
clean commit and Quick/verify run. Focused evidence remains separate from
independent C5 acceptance; it is not a claim that every T01-T36 case is
complete.

This document is the C0 contract and impact ledger for the single stacked PR
that replaces the workspace maintenance control path. It is normative for the
implementation and for the independent C0/C1/C5 reviews. The attached v1 plan
and older I1-I12 wording are background material; where they conflict with
this document, this document wins.

The change keeps the PR #600 Graph, SQL, source, measurement, canonical
Freshness, Semantic Epoch, A2, Human Decision, D1, backup, WAL, CAS rollback,
and existing file-lease semantics. It does not add a new persistent journal,
schema, NIR lane, semantic authority, Graph dispatch path, or generic agent
framework. The shutdown value of 30 seconds is only the main-process budget
for observing Native termination. It is not a build deadline, a cleanup
deadline, or a promise that the whole application exits within 30 seconds.

## Ownership and non-negotiable boundaries

| Owner | Sole responsibility |
| --- | --- |
| Shared `WorkspaceLifecycleCore` in `WorkspaceState` | State, revision, admission, participant/execution membership, permits, recovery responsibility, delivery and descriptor ownership |
| Native `WorkspaceLifecycle` | Core adapter, worker start, supervisor, Join observation, open/restore/recovery operations |
| Native `MaintenanceExecution` | One execution, work outcomes, exact Run/Task/Attempt ownership, common finalizer |
| Electron main driver | Delivery, receipt application and ACK, re-query, retry/fence, authorization, renderer projection |
| Renderer | Revision-aware display, explicit Open, hydration, and dirty-draft protection |

The shared core has no Tokio or N-API dependency. Native supervisor handles
are mechanism-only storage and must not become a second admission or active
membership authority. Renderer input, delayed requests, restore candidates,
and unverified receipt shapes are not ownership evidence.

The implementation is one child PR. C0 records the contract and entry matrix;
C1 implements and independently accepts the pure core and types; C2/C3 may
proceed only after the C1 gate; C4 switches the product path atomically and
removes the old owners; C5 freezes a clean candidate and records the focused
and Quick verification. No partial slice is published independently.

## Implementation status and known gaps

This branch remains an implementation candidate until the independent C5
review and exact-head Quick/verify receipts are complete. The following
evidence gaps remain explicit:

- Full Layer C Electron IPC-to-N-API-to-SQLite-to-renderer journeys and
  all-green T01-T36 evidence still require execution; focused tests do not
  stand in for those acceptance layers.
- Frozen standalone/MCP adapters retain their explicit compatibility owner;
  product Native Apply/Freshness and proposal paths must continue to use the
  borrowed context entry points and may not add a permanent no-context
  fallback.
- A Windows GNU target build remains environment-dependent on the installed
  cross compiler.

## State, identity, and result contract

### Lifecycle states

| State | Admission rule |
| --- | --- |
| `NoWorkspace` | No normal DB access. Open and Shutdown are allowed. |
| `Ready(binding)` | Normal work is allowed only for the exact verified binding. |
| `Transition(Draining\|Replacing\|Recovering\|Finishing)` | Normal admission is closed. Registered participants receive stop and are joined. |
| `RecoveryRequired` | Normal access is closed. Only an exact descriptor-bound recovery or limited diagnostic is allowed. |
| `Closed` | No new execution is accepted. |

The frozen Tauri compatibility shell may temporarily read a directly installed
verified authority before it publishes a shared-core `Ready` binding. This is
an explicitly bounded legacy owner path; Electron Transition,
RecoveryRequired, and Closed states never use it as a fallback.

`LiveBinding` contains the verified locator, workspace identity, authority
instance, and recovery generation. A matching metadata ID alone is never a
binding match. A descriptor for W1 may remain while verified W2 is `Ready`;
that does not transfer W1's responsibility to W2.

`OperationId`, Native `ExecutionId`, `WorkExecutionId`, durable Run/Task/
Attempt, and main delivery sequence are different identities. Reusing a
work key never permits an old receipt to remove a newer occurrence.

### Admission, operation effect, and availability are separate

The public result must preserve these axes. An error string must not be parsed
into `Unchanged`.

| Result | Required proof and meaning |
| --- | --- |
| `NotAdmitted` | This request did not start. It says nothing about current workspace availability. |
| `Pending` | The request was admitted; terminal execution is not yet proven. |
| `Unchanged` | The admitted operation ended and the exact original `LiveBinding` was verified healthy. Include that binding and the state revision. |
| `Activated` | A verified authority was published. A close/reopen with a new authority instance is `Activated`, even if content was retained. |
| `Restored` | Restore succeeded and includes `activation: ready` or `activation: requires-open`. These states are not interchangeable. |
| `RecoveryRequired` | The original owner ended and responsibility was transferred to the exact durable descriptor. |
| `Closed` | Native termination and the required cleanup have both been observed. |

Operation success, cancellation, failure, and unknown outcome are separate
from workspace effect. For example, an Open may fail while a newly verified
authority is activated with `contentEffect: retained`.

An old `Unchanged` result cannot reopen autosave or runtime after a newer
revision has been observed. Every Native DB entry rechecks the exact binding
and current state at pin time. Closing and reopening the same file creates a
new authority instance and cannot produce `Unchanged`. A lost or version-
unknown response is re-queried; it never authorizes old-binding reuse.

The required regression is:

```text
Open A is transitioning W1 -> W2
Restore B arrives for W1
B is NotAdmitted because the lifecycle is busy
B must not tell the renderer that W1 is safe to resume
```

Renderer projection is sanitized. It exposes only an opaque UI binding token,
revision, allowlisted state, and reason. It does not expose Run tuples,
descriptor internals, Native locator authority, or execution capabilities.

## Run ownership and absence evidence

Each work reserves its ownership slot before the Run creation SQL. The existing
writer, validation, and DML remain the shared implementation; an internal
entry point supplies a reserved exact tuple and records whether the work is
fresh or reusing an existing tuple before a result can be lost.

| Creation state | Meaning |
| --- | --- |
| `Reserved` | Exact IDs and ownership slot exist; creation transaction has not started. |
| `CreationNotCommitted` | Creation was not started or rollback was directly confirmed. |
| `CreationUnknown` | Creation started but its commit result was not recovered. |
| `Created` | Exact Run/Task/Attempt commit was observed. |
| `Reused` | An exact existing tuple was validated and selected. |

Record `Created` immediately after COMMIT and before any fallible cleanup or
notification. Record `Fresh(reserved tuple)` versus
`Reused(existing tuple)` before the result-loss window. A missing reserved ID
does not prove that reuse did not occur.

`CreationUnknown` may become `CreationNotCommitted` only with all of the
following evidence:

1. The original worker joined.
2. Every original transaction, statement, and connection is retired and can no longer commit.
3. The locator, DB identity, project, and epoch are verified against one correct DB.
4. The project birth/canonical creation lineage remains continuous.
5. No DB replacement, project delete/recreate, or other destructive boundary occurred without a trusted boundary proof.
6. One consistent transaction checks all three exact IDs and their child references.
7. Run, Task, Attempt, and their required children are all absent.

All-absent without this evidence remains unknown. Partial tuples, foreign
references, wrong epoch/spec, wrong DB, an unjoined worker, or a project
delete/recreate boundary are anomalies. A `Created` or `Reused` tuple that is
later absent requires verified restore-image or equivalent durable deletion
evidence; normal `SELECT ... None` is not enough.

Project deletion/recreation is a destructive boundary. Reserve a project
destructive permit before obtaining its DB connection, reject deletion while
the project has a reserved/unknown/live Run or recovery descriptor, and reject
new Run reservation while deletion is in progress. This process-local permit
is not a cross-process security authority; lineage checks remain mandatory.

Connection retirement has an explicit primitive. After sole ownership and
Join are proven, consume the old authority and close the SQLite connection
outside core locks. A same-path reopen keeps a lease-only recovery baton until
the new verified connection is available. Close or reopen failure retains the
baton and responsibility for retry. A replacement path releases the shared
lease before taking the replacement exclusive lease. A descriptor stores
identity and evidence, never an old authority `Arc`.

## Delivery, descriptor, and capacity contract

Transport ACK means that main applied the delivery result. It does not mean
that the work succeeded or that recovery finished. After execution termination,
transfer unfinished responsibility atomically to an exact descriptor. Once
main applies and ACKs that transfer, the delivery record may retire while the
descriptor remains independently owned.

### Capacity

- Normal delivery records are bounded at 256.
- Active, pending, or unACKed records are never capacity-evicted.
- A normal submit that cannot reserve its record/ownership cell is
  `NotAdmitted`; no side effect may have started.
- ACK-retire and capacity eviction are different operations and different test
  cases.
- Recovery must not depend on allocating an ordinary delivery record.

Recovery responsibility has 256 cells: 255 general cells tagged to an exact
Run or workspace operation, and one recovery-transition emergency cell.
Reserve the relevant cell before the first side effect. An existing
descriptor reuses its own cell. The emergency cell is used only when an exact
root continuation could create another independent recovery responsibility;
while it is occupied, that exact root plus stop, snapshot, ACK, fence, and
Shutdown may proceed, while unrelated new roots are rejected with the root
prerequisite. The cell is never overwritten or allocated once per retry.

The presence of W1's descriptor does not block W2 when a general cell is
available. A Run that is resolved but whose activation fails records that
phase and does not recreate the Run on retry.

### Sequence and fence

The Native session has a monotonic delivery sequence and sealed high-water mark
`H`. Main resolves at most one new unconfirmed sequence at a time; admitted
execution completion may remain parallel.

| Input | Required behavior |
| --- | --- |
| `n = H + 1`, admitted | Atomically reserve record, required cells, execution, and advance `H`. |
| `n = H + 1`, temporary capacity rejection | Return `NotAdmitted` without advancing `H`; the exact sequence remains retryable after ACK frees a record. |
| `resolveOrFence(H + 1)` | Allocate nothing; seal the sequence so a late submit cannot execute. |
| Existing record | Same fingerprint replays the same result; a different fingerprint is a conflict. |
| `n <= H`, no record | Return `SealedAbsent`, not a generic busy response. |
| `n > H + 1` | Return `OutOfOrder` and do not advance `H`. |

Only the current unACKed sequence whose admission is genuinely unresolved may
be inferred as not admitted. An admitted record disappearing before ACK is a
protocol violation. Old ACKed callbacks are retired and cannot create new
work. A local capacity rejection does not seal a sequence; only the explicit
`resolveOrFence` operation may seal `H+1` without a record. `resolveOrFence`,
stop, snapshot, ACK, Shutdown, and recovery of an existing descriptor remain
executable when ordinary capacity is full.

Each descriptor root has one control-result slot and a monotonic generation:
same request replays the same result, a payload conflict is rejected, an
unACKed result is not overwritten, and a retired root cannot create a new
Open. Keep the descriptor until the control result and all referencing
delivery records are resolved.

## Context supply and eligibility

Rejecting a missing context is a safety rule, not a successful normal path.
Every reachable full eligibility callsite must have a positive owner mapping.
Use a private non-clone `ValidationConnectionScope<'conn>` and a
`ValidationContext<'tx>` borrowing the same connection/transaction. Do not
accept connection and context as independent arguments.

| Callsite | Context owner and lifetime |
| --- | --- |
| Prepare/Apply source contract | Foreground command participant; borrow the existing write transaction. |
| Apply V2 source loading and post-DML dependency assembly | The same Apply owner and transaction. |
| Proposal save, seed, source-token validation | Bound foreground extraction writer and exact binding. |
| FinishTask proposal save | Existing Task/Chronicle owner; preserve terminal transaction atomicity. |
| Append/revise-and-decide | Foreground writer's outer transaction; no nested admission. |
| Initial V2/Human child materialization | Existing proposal/Human writer transaction. |
| Bounded Freshness | One cycle participant; create a borrowed scope per reservation, evaluation, and publish DB acquisition. |
| Revision eligibility/batch Source resolver | Propagate the caller's snapshot/transaction context. |
| Chronicle build/query/canonical/owned-edge paths | Existing Chronicle runtime owner and generation; register as a drain participant. |
| Verify/Rebuild/discovery/Graph/coverage | `MaintenanceExecution`; nested work reuses the same context. |
| Diagnostics | Dedicated controlled context; never the product authority. |
| Fixed scene-body disclosure precheck | Bounded reader; document as unreachable from full eligibility. |

Foreground keeps its existing priority and Apply busy timeout; it does not wait
for a maintenance lane. Freshness releases the DB mutex between phases and
revalidates in publish. Nested readers do not acquire a second transaction,
mutex, or progress hook. The outer scope owns the SQLite progress handler and
the existing checkpoint interval.

Without context, return typed `ValidationTerminated::ContextUnavailable`
before roster SQL. Preserve Prepared and do not translate the error to Source
missing, stale, unsupported, or success. Freshness preserves its durable
Task/Attempt and retry ownership. Valid foreground Apply/Freshness paths must
also have positive success tests.

## I7 and resource-release order

The old I7 wording is superseded by two rules:

- **I7-P physical exclusion:** `WorkspaceExclusive/open_lock` remains held
  through all protected DB/filesystem I/O, statements, cleanup, and replacement
  post-processing. After release, the worker performs no protected I/O.
- **I7-L logical exclusion:** `WorkspaceTransitionPermit` remains held until
  the supervisor has joined the worker and candidate activation or recovery
  responsibility transfer is committed.

Between physical unlock and Join, the candidate is hidden, ordinary admission
is closed, and competing exclusive operations are rejected.

| Resource | Release point |
| --- | --- |
| Core/authority mutex | Short state update only; never across I/O, await, Join, or final authority drop. |
| Logical transition permit | Reservation through Join plus activation/descriptor handoff. |
| `open_lock`/workspace exclusive | Protected worker I/O through cleanup completion. |
| Old workers/readers/statements/pins | Joined and retired before same-path replacement. |
| Old authority final Arc/DB connection | Retired before replacement exclusive lease, sidecar handling, or rename. |
| Old shared file lease | Released before replacement exclusive lease. |
| Lease-only recovery baton | Held only across verified same-path reopen; released before replacement. |
| Replacement exclusive lease | Through recheck, safe copy, WAL/install, verification, and rollback decision. |
| Hidden candidate DB/shared lease | Acquired through Join; move the same authority at activation. |
| Descriptor | Values-only identity/evidence/progress; never an old authority handle. |

The lock order is core → short authority mutex; never wait for `open_lock`
while holding core. A final publish latch cannot acquire core, open_lock, or a
new DB. Never hold a transaction while dropping only the DB mutex. `Drop` may
release resources but cannot start long recovery or reopen work.

## Entry and impact matrix (C0 ledger)

This matrix is finite and must be completed before C1. Every row records the
start, retry, reentrant, stop, and failure path for the same entry. An entry
without a known owner remains `Unknown` and blocks the next gate.

| Entry family | Current anchor | New owner/permit | DB/lease boundary | Terminal evidence | Required C0 decision |
| --- | --- | --- | --- | --- | --- |
| Workspace Open/restore | `src-tauri/crates/grimodex-db/src/workspace.rs`, migration/restore supervisor | Lifecycle core + transition permit + physical exclusive | Old authority drain; same-path baton or replacement exclusive lease | worker Join, cleanup, candidate validation, activation | map every restore and Safe Mode path |
| Automatic maintenance | `narrative_extraction/maintenance_lifecycle.rs`, `maintenance_runtime.rs` | `MaintenanceExecution`, exact Run owner, finalizer | Existing DB transaction and file lease | Run/Task/Attempt commit or typed failure plus cleanup | reserve owner before SQL |
| Native discovery | `electron/native/grimodex-node/src/narrative_maintenance.rs` | Native lifecycle adapter; no renderer IDs | Pinned active Database; bounded pages | complete page result or typed rejection | preserve full roster and source coordinates |
| Foreground Prepare/Apply | `agent_writes.rs`, `commit.rs`, `v2_apply_sources.rs` | `WorkspaceLifecycleCore::admit_foreground_permit`; Native holds the permit through the borrowed transaction context and finalizer | Existing write transaction; Apply busy timeout | commit/rollback and Prepared retention | preserve the explicit compatibility owner only at frozen standalone boundaries |
| Proposal/revision writes | repository proposal/revision paths | Existing bound writer | Same outer transaction | exact revision and commit evidence | no nested maintenance admission |
| FinishTask/Human materialization | Task/Chronicle/Human writers | Existing owner and transaction | Existing terminal transaction | terminal commit or retryable failure | preserve atomicity |
| Freshness | `incremental_freshness.rs`, revision eligibility | Cycle participant + phase scopes | Reservation/evaluation/publish scopes | publish commit or requeue with exact owner | stop without false Source absence |
| Chronicle/Graph/coverage | Chronicle index runtime and Graph writers | Existing runtime owner or MaintenanceExecution | Borrowed context, full roster | atomic publish and generation validation | no new product dispatch |
| Project delete/recreate | `domain_writes.rs` project destructive writer | Project destructive permit and separate creation reservation map | DB transaction and lineage boundary | commit plus birth-lineage evidence | make delete/create admission atomic against live/unknown ownership |
| Recovery descriptor | restore/recovery finalizers | Descriptor root/control slot | delivery-independent recovery cell | exact handoff, result, ACK | progress at full ordinary capacity |
| Renderer lifecycle | existing workspace store/recovery shell | Main sanitized projection | UI opaque binding/revision | explicit Open + hydration | NotAdmitted never restores old binding |
| Shutdown | main shutdown path and Native stop | Core shutdown owner | independent cleanup; Native observation budget 30s | Native terminal + cleanup result | no timeout-to-Closed conversion |
| Compatibility/MCP | standalone and frozen adapters | Existing verified owner/context | Existing lease/connection | same terminal receipt contract | no permanent context-unavailable fallback |

For each row, C0 records the concrete symbols, caller, worker, retry source,
owner token, exact binding capture, lock order, cleanup owner, and durable
evidence. The matrix is an impact ledger, not a promise that every path is
rewritten if a read-only reachability proof excludes it.

### Concrete C0 callsite ledger

The following is the completed symbol-level ledger used by C1/C2/C3.  A row
may delegate its worker to an existing helper, but the owner and terminal
evidence remain explicit at this boundary.

| Entry | Admission/start and owner | Binding/lock/DB scope | Stop, retry, and terminal evidence |
| --- | --- | --- | --- |
| `WorkspaceLifecycleViewAdapter::begin_transition_kind` → `open_workspace` / `restore_recovery_candidate` | `WorkspaceLifecycleCore::begin_transition`; `WorkspaceTransitionPermit` and Native supervisor slot are created before `spawn_blocking` | `WorkspaceState.inner` binding is captured before `open_lock`; protected worker owns `WorkspaceExclusive` and the verified file lease | `AppState::request_workspace_shutdown`/participant stop, Join from the blocking owner, `complete_transition_from_workspace`; JoinError/panic maps to descriptor, never Ready |
  | `State::run_narrative_maintenance_cycle` → `maintenance_runtime::run_*` | `WorkspaceLifecycleViewAdapter::begin_maintenance`; `MaintenancePermit` reserves execution before DB work; automatic delivery owns it in the outer Native supervisor, and exact Run callbacks attach the selected tuple | `narrative_maintenance_no_wait` on the pinned authority; existing transaction and file lease; no path-based second connection | attempt stop signal and `GraphWorkControl::check`; requeue/failure recorder; terminal delivery result is marked only after the supervisor observes Join and completes release or descriptor transfer |
| Native discovery `narrative_maintenance::discover_projects` | Same maintenance owner, no renderer identity accepted | Pinned authority, keyset pages, Source ID lookup; no `active_database()` reacquisition | page completion or typed lifecycle rejection; wake remains durable until ACK |
| `narrative_extraction_prepare_commit_with_control` / `...apply_commit_with_control` | Native foreground command admits `AdmissionKind::Foreground` before DB access; `ForegroundValidationControl` borrows that permit and remains live through transaction cleanup | Existing write connection/transaction and Apply busy timeout are preserved; `ValidationConnectionScope` couples the owner to the same connection | stop is checked before Source normalization and at eligibility checkpoints; rollback preserves Prepared; successful commit is recorded separately from cleanup |
| `repository::save_proposal_set_in_tx`, `append_revision_in_tx`, `revise_and_decide` | Bound foreground writer owns the outer transaction and supplies the same validation scope | exact extraction binding, outer transaction, existing writer authorization | caller retries the exact request/revision; commit evidence and connection cleanup are separate |
| `repository::finish_task` / `human_materialization::*` | Existing Task/Chronicle or Human writer participant; no nested maintenance admission | Existing terminal transaction with borrowed context | terminal commit or typed retry; child revision, Decision, D1, and Freshness remain atomic |
| `incremental_freshness::{reserve,evaluate,publish}` | One cycle participant registered for the whole cycle; a fresh borrowed scope is created for each DB acquisition | Reservation/evaluation/publish release the DB mutex between phases; publish revalidates the same Source in its transaction | stop is requeued with exact Task/Attempt ownership; no Source-missing or success heartbeat conversion |
| `revision_eligibility::{read_revision_canonical_freshness,read_with_validation_context}` | Caller propagates its foreground, Chronicle, or maintenance context | Same caller snapshot/transaction; nested reader cannot acquire a second mutex/transaction | `ContextUnavailable` is returned before roster SQL; caller owns retry and failure classification |
| Chronicle `nir1_chronicle_index::{build,canonical,source}` and `restore_rebuild::owned_edges` | Existing Chronicle runtime owner or `MaintenanceExecution`; controlled reader is nested, never re-admitted | Caller snapshot/publish transaction, complete roster and canonical bytes/digest retained | generation/stop check at page and serialize checkpoints; publish commit or exact recovery descriptor |
| Verify/Rebuild/discovery/Graph coverage | `MaintenanceExecution` registration and work membership | Controlled connection scope and existing file lease | common finalizer records Run/Task/Attempt outcome; no `NeverStop` fallback for reachable eligibility |
| `domain_writes::project_delete` and project recreation | One mutex-backed project lifecycle admission table atomically excludes destructive delete from Reserved/CreationUnknown Run reservations | Project-scoped permit plus lineage/birth evidence; process-local only | normal conflict checks and durable lineage receipt remain mandatory; cross-process authority is not claimed |
| `WorkspaceLifecycleCore::{admit_delivery_at,resolve_or_fence,ack_delivery}` and main `NarrativeMaintenanceDeliveryLedger` | Main owns at most one unresolved H+1; Native atomically reserves record/cells/execution | Sequence/fingerprint and descriptor control slot; ACK is transport-only | Full returns temporary `NotAdmitted` without consuming H+1; explicit fence yields `SealedAbsent`; ACK retires record while descriptor responsibility remains |
| Renderer `events.ts` / `workspaceLifecycleProjection.ts` | Main `workspace:lifecycle-state` subscription followed by `get_workspace_lifecycle_view` snapshot | Opaque UI binding token and monotonic revision only; no locator/Run/descriptor | RecoveryRequired stores dirty drafts before unmount; explicit Open → hydration is the only resume path |
| `shutdown_workspace_lifecycle` / `AppState::wait_workspace_operations` | Core `request_shutdown` closes admission before Native observation; independent cleanup starts in main | Native worker/permit count is process-local; 30s is monotonic observation budget | only observed Native terminal plus independent cleanup yields graceful success; timeout keeps Transition/owners |
| standalone MCP and frozen compatibility adapters | Existing verified workspace/lease owner supplies the explicit compatibility context; Native product lanes cannot fall back to it | Existing connection/file lease; no permanent `NeverStop` authority is accepted for reachable product eligibility | same terminal receipt/cleanup contract is required; adapter coverage remains a C5 evidence item |

The C0 reviewers must trace every symbol above to its caller and record the
resolved base/head in the candidate ledger.  A new callsite that reaches full
eligibility, project destruction, Open/Restore, or Run creation is a C0 change
and cannot be hidden under a family row.

## C0-C5 gates

### C0 — contract and inventory

Deliver the state/result tables, Run evidence rules, capacity/descriptors,
context supply matrix, I7/resource table, complete entry matrix, parent SHA,
and T01-T36 mapping. Independently review (a) state/result/capacity/renderer
semantics and (b) Run/context/retirement/lock order. Unknown or deadlocked
transitions block C1.

### C1 — pure core and types

Implement the shared lifecycle state, identities, private permits, revision,
strict DTOs, descriptor ownership, delivery fencing, and bounded-core tests.
Independently check that implementation matches C0, including full capacity,
stale `Unchanged`, `SealedAbsent`, and I7-P/I7-L. Freeze these interfaces before
C2/C3 parallel work.

### C2 — workspace and recovery boundary

Unify Open/restore/recovery through admission, drain, physical worker,
protected cleanup, Join, and logical activation/handoff. A Join error, panic,
close failure, or replacement failure never creates `Ready` without proof.

### C3 — execution, Run, and context

Register owners and supervisor slots before spawn; retain supervision after
Promise/window loss; route exact Run/reuse/finalizer outcomes; supply context to
all reachable Apply/Freshness paths; preserve existing Graph/SQL/measurement
semantics. No old/new shadow writes.

### C4 — atomic product cutover

Switch Native, shared DB entrances, main delivery, IPC projection, and renderer
recovery together. Remove independent gates, attempt state machines, switching
booleans, Drop reopen, and product fallback paths. Renderer resumes only after
explicit Open and hydration with a current binding.

### C5 — candidate acceptance

Run the focused Layer A/B/C suites, T01-T36, code/type checks, and the applicable
local Quick on a clean frozen candidate. Record base/head/tree/receipts and
keep independent acceptance separate from implementation. No merge or master
publication is part of this child PR.

## T01-T36 acceptance map

| ID | Required scenario |
| --- | --- |
| T01 | Manual execution and automatic timer serialize; held work runs once after manual completion. |
| T02 | Begin wait/rejection wakes without duplicate enqueue. |
| T03 | Pending-start Open/Shutdown leaves body unstarted and owner supervised. |
| T04 | Transition/RecoveryRequired/Closed rejects new work without owner theft. |
| T05 | Post-commit cancellation handles the exact triplet and the next same-key occurrence progresses. |
| T06 | Body failure records typed policy and retains exact Run responsibility. |
| T07 | Cleanup failure quarantines the connection; recovery uses a new verified connection. |
| T08 | Failed reopen/recovery can retry after the cause is removed. |
| T09 | Stop around final grant cannot fabricate a successful commit. |
| T10 | A success and B cancellation affect only their own work occurrence. |
| T11 | Open/restore target is captured and cannot switch to a same-name backup. |
| T12 | Competing Open during install/post-processing observes both physical and logical exclusion. |
| T13 | Lost Run recovery distinguishes worker termination, descriptor handoff, and restore reapplication. |
| T14 | A progressing Open makes B `NotAdmitted`; B cannot resume W1. |
| T15 | Promise drop, window close, and panic do not drop Native supervision. |
| T16 | Lost/duplicate/old-binding receipts converge by re-query without false ACK. |
| T17 | DB mutex and another connection's write lock remain distinct; foreground wait policy is preserved. |
| T18 | Restart after observed creation commit recovers from durable evidence. |
| T19 | Same metadata ID on another path cannot inherit responsibility. |
| T20 | Restore image evidence is required to explain disappearance of a committed Run. |
| T21 | Native shutdown failure still starts independent cleanup and is not graceful. |
| T22 | Observation timeout retains Transition/owner state until actual termination is proven. |
| T23 | Contrast committed+cleanup-failed, unknown-but-uncommitted, unknown-but-committed, and reuse-loss cases. |
| T24 | Old receipt for one WorkExecution cannot erase a later occurrence. |
| T25 | Spawn failure, supervisor notification loss, and pre/post-commit panic retain reserved ownership. |
| T26 | Nested Source/coverage/discovery reuses context without re-admission or hook replacement. |
| T27 | Unknown version, invalid result combination, and fingerprint conflict fail closed. |
| T28 | Full ordinary delivery rejects submit, but fence/ACK/existing descriptor recovery progresses and normal admission resumes. |
| T29 | Profile/window change after manual authorization preserves caller and binding checks. |
| T30 | `NotAdmitted`, stale `Unchanged`, new-instance `Activated`, and `requires-open` project distinctly. |
| T31 | Recovery preserves dirty drafts, nulls old runtime/IME identity, and explicit Retry Open succeeds. |
| T32 | Shutdown 30-second Native observation budget is monotonic and independent cleanup remains separate. |
| T33 | Valid Apply/Freshness with supplied context succeeds; missing/wrong/stopped context is rejected safely. |
| T34 | Test capability stays out of product binary; MCP/compatibility and lease paths retain contract. |
| T35 | PR #600 Graph roster, atomic publish, keyset/Source lookup, RSS missingness, and semantic measurements remain unchanged. |
| T36 | Updated I7-P/I7-L and resource table are observed: old resource release precedes replacement and Join precedes activation. |

T23, T28, T30, T33, and T36 are blocking regressions for the five review
findings. A negative safety result without the paired positive progress result
does not satisfy acceptance.

## Candidate ledger

The C0/C1/C5 record must contain one row per candidate and these exact fields:

```text
contract_id
parent_pr
parent_branch
base_sha
child_branch
head_sha
worktree
tree_status
changed_paths
implementer
independent_reviewers
threat_model_ref_and_confirmation
entry_matrix_ref
gate_status_c0
gate_status_c1
gate_status_c5
focused_commands
focused_receipt_paths
quick_command
quick_base_sha
quick_head_sha
quick_receipt_path
verify_command
verify_receipt_path
test_binary_hashes
unresolved_findings
environment_limits
freeze_timestamp
```

The candidate must be clean and commit-pinned before Quick. If the candidate
changes after a receipt, invalidate that receipt and rerun the applicable gate.
Do not claim merge or release readiness from focused tests, skipped checks,
old receipts, or a hosted-check absence.
