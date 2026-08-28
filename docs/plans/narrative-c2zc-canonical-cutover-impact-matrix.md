# C2-ZC Canonical Freshness Cutover Impact Matrix (final acceptance candidate)

This matrix records the C2-ZC final acceptance candidate and its pre-closeout
evidence; it is not an acceptance record. Literal acceptance remains
conditional on the gates named below. The feature remains a
main/N-API/shared-Rust maintenance seam; renderer and preload do not gain a
cutover or scheduler-maintenance surface. An ordinary Freshness wake runs a
bounded cycle, mints a capability-bound liveness receipt, and attempts the
durable cutover on the revalidated current authority. A not-ready workspace is
retried on a later wake; marker, schema, evidence, and authority errors are
surfaced rather than treated as readiness misses. When no Feed range remains,
the existing `incremental-freshness` Run Kind may use its exact nested
`idleCheckpoint` contract to record a zero-width current-Epoch completion; this
database checkpoint is not scheduler-liveness or cutover evidence.

| ID | Flow / variant | Owner / producer | Boundary, contract, transform, validation | Consumer / sink | Preserved invariant | Compatibility / fallback | Verification | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C2ZC-P1 | Ordinary workspace wake | Electron main freshness scheduler | `runNarrativeFreshnessCycle` is the existing main-only wake. N-API pins the active workspace, binds the current authority/generation, runs one bounded cycle, records a typed shared-Rust scheduler heartbeat only after the cycle returns `Idle` or `Processed`, then calls `cut_over_workspace_freshness` on that same revalidated authority. | Shared Rust incremental freshness runtime and C2-ZC cutover | One in-flight bounded cycle; cursor reservation/replay/ack remains Rust-owned. A failed cycle cannot mint liveness or activate the marker. | Missing workspace or unavailable native method remains the existing fail-soft `null`; exact `NEX_C2ZC_CUTOVER_NOT_READY:` is retried on later wakes; unexpected failures surface; no renderer/preload route. | `c2-zc-canonical-authority-cutover` product journey (real Electron main -> N-API route); `narrativeMaintenance` trigger tests; N-API marker-error and heartbeat-binding tests. | final acceptance candidate — see C2-ZC-00 gate |
| C2ZC-P2 | Active scheduler receipt | N-API + shared Rust | Shared Rust creates the `SchedulerLivenessEvidence` from the live N-API authority binding and current project set only by consuming a successful-cycle capability. That capability carries the exact SQLite connection epoch and monotonic completion instant observed after the cycle; heartbeat rejects a capability from any other `Database` authority or one older than the liveness bound. Cutover accepts only the process-local receipt registered by that heartbeat, with canonical timestamp, exact project scope, current authority generation, bounded monotonic age, and the same connection epoch. | C2-ZC readiness gate | A completed DB Run never self-attests scheduler liveness; caller-shaped/fabricated, replayed, stale, and cross-authority cycle capabilities fail closed. | No receipt, stale capability or receipt, malformed scope, wrong authority, or same-project different-Database binding is `Blocked`/`Incomplete`; no DB-only promotion. | Rust C2-ZC liveness negative/positive tests; N-API binding tests; stale-capability, same-project cross-Database capability, and receipt negatives. | final acceptance candidate — see C2-ZC-00 gate |
| C2ZC-P3 | Stale or wrong binding | Workspace recovery gate | N-API obtains `MaintenanceWorkspaceBinding` from the pinned authority. Shared heartbeat receipt is replaced on authority/generation change and every cutover requires an exact current receipt, including the bound Database connection identity. | C2-ZC cutover | Old workspace/database authority cannot activate a new or swapped workspace. | No fallback to path identity, old generation, same-project identity, or prior receipt. | `narrativeMaintenance` binding mismatch tests plus Rust stale/wrong-Database receipt tests. | final acceptance candidate — see C2-ZC-00 gate |
| C2ZC-P4 | Authority swap | N-API workspace authority owner | The cycle pins one authority, then takes the existing workspace-open serialization guard, re-resolves the active authority and binding, and only then mints liveness and attempts cutover. Binding generation changes on swap/recovery; the old process-local receipt is invalidated by replacement. | Scheduler and cutover gate | No operation crosses workspace authorities; same-path restore still changes authority identity/generation, and a late old cycle cannot activate its database. | Workspace switching/safe mode remains fail-soft; any later activation waits for a new heartbeat. | Workspace-generation tests; focused N-API swap characterization. | final acceptance candidate — see C2-ZC-00 gate |
| C2ZC-P5 | Retry / restart | Main scheduler + N-API backend | Scheduler retries only after cycle completion. A new backend must emit a new heartbeat; the receipt is process-local and cannot be inherited from a prior process. | C2-ZC readiness | Recovery never treats a stale process as live. | The durable cutover marker persists; lack of a new live receipt blocks activation until a later successful wake. | `c2-zc-canonical-authority-cutover` product journey restart phase; main scheduler retry tests and shared Rust receipt-age/restart tests. | final acceptance candidate — see C2-ZC-00 gate |
| C2ZC-P6 | Marker persistence | Shared Rust cutover + `Database` schema-owner helper | C2-ZC never executes `schema_data_migrations` SQL directly. The scheduler-owned cutover calls the authorized `migrate.rs` marker helper, which validates the current contract and writes the activation marker atomically with the readiness decision. | Workspace open/recovery and canonical read | One durable activation record; schema migration ownership remains in the schema-owner module. | Existing C2-ZB marker/rekey path is untouched; wrong marker version fails closed. | Migration-owner unit test; marker atomicity/idempotency tests. | final acceptance candidate — see C2-ZC-00 gate |
| C2ZC-P7 | Canonical read | Shared Rust C2-ZC API | After a current marker, read only `narrative_consumer_freshness` for an Application; validate vocabulary, current epoch, dependency-set digest, timestamp, exact Incremental Freshness Run provenance, and Edge State roll-up. | Native consumers of candidate canonical Freshness | Generic Consumer Freshness is a candidate sole read authority; it is accepted if and only if the complete C2-ZC gate receipt exists. Missing/invalid Generic evidence is an error. | No read fallback to `narrative_projection_freshness`; absent application remains `None`. | Immutable public contract tests plus strict Generic contract tests. | final acceptance candidate — see C2-ZC-00 gate |
| C2ZC-P8 | Legacy compatibility / no fallback | Shared Rust Apply and source-propagation writers | Before marker, preserve existing Legacy writes. After marker, Apply declares typed Generic Edges only; Source mutations go through the live incremental evaluator, while an idempotent `ensure-existing` Application (which intentionally has no Feed event) may use the typed publish-runtime owner to seed its declared Edges and Consumer row as `Unknown`/`Manual` at the current Epoch/digest. Legacy source propagation returns without mutating the mirror. | Generic runtime and compatibility tables | Legacy is compatibility-only and cannot silently diverge as a second authority; no-op initialization never fabricates a Feed or a Fresh result. | Existing legacy rows remain readable for parity/diagnostics only; canonical read never consults them. | Post-marker writer characterization tests; immutable no-fallback tests; idempotent temporal-ensure canonical test. | final acceptance candidate — see C2-ZC-00 gate |
| C2ZC-P9 | Post-marker Project birth | `domain_writes::project_create`, `import::apply_commit`, + shared Rust epoch owner | After its canonical Project-birth event is appended in the same transaction, an exact-current marker mints exactly one `initial` Semantic Epoch bound to that event UID. `project.create` and `import.session.apply` retain distinct exact event identities; Import also verifies the canonical session identity and payload target. No marker means no new Epoch; an unsupported marker or pre-existing Epoch rolls back the whole Project creation. Apply never mints this bootstrap Epoch. | Post-marker Application writer | Every new Project has a durable, event-bound current Epoch before a post-marker Application can declare Generic dependencies. | No best-effort epoch mint; unsupported marker and duplicate bootstrap fail closed. | `c2-zc-canonical-authority-cutover` direct post-marker Project create/restart assertion; Project create and Import pre-marker/current-marker/idempotent-replay/unsupported-marker rollback tests. | final acceptance candidate — see C2-ZC-00 gate |
| C2ZC-P10 | Renderer/preload maintenance surface | None (explicit non-owner) | No renderer IPC command, preload method, or renderer maintenance state is added. Main-only N-API scheduler wake remains the only runtime entry point. | N/A | No user-controlled cutover or forged liveness payload crosses renderer boundary. | Existing renderer behavior unchanged. | `rg`/contract surface audit; frontend lane is out of scope. | out of scope: no renderer/preload maintenance surface |
| C2ZC-P11 | Current-Epoch idle checkpoint | Existing incremental Freshness Run Kind; shared Rust DB authority | The nested `idleCheckpoint` keeps `runKind = 'freshness-evaluation'` and `taskKind = 'incremental-freshness-batch'`. It records an exact tagged payload/spec/Work Key bound by `sha256-canonical-json`, with `fromSequenceExclusive = throughSequenceInclusive = feedHead`, a clean cursor, and no missing cursor unless `feedHead = 0`. One project is selected per wake in ascending project-id order; any current-Epoch Freshness Run in any status suppresses a new mint. | Run/Task/Attempt state and Freshness cursor only | Normal Feed-backed Change Set, Edge State, Generic Consumer Freshness, Finding, Attention/Domain, D2, and Semantic Index behavior is not widened or replaced. Idle completion is exactly one completed Task and one completed Attempt with no active Attempt; the Task is `completed`, `attempt_count` equals Attempt rows, Attempt numbers are contiguous, only failed/completed Attempts are allowed with the completed Attempt last, failed retries precede completion, and malformed `task_kind` cannot bypass the retry cap. | Completed idle state creates no next-wake churn. A database checkpoint alone cannot establish scheduler liveness or C2-ZC cutover; the main/N-API receipt and final gates remain required. | Run-kind policy validator RED/GREEN mutation suite plus focused idle-checkpoint runtime/readiness tests; no product-journey or final acceptance claim. | final acceptance candidate — see C2-ZC-00 gate |

## Authority decision

The durable authority marker is owned by the schema migration module, while the
C2-ZC decision is owned by shared Rust and reached only from the main/N-API
Freshness wake. The live scheduler proof is not a free-form timestamp: the
N-API call obtains the current main-process authority binding and shared Rust
mints/registers the receipt only from a cycle capability for that exact SQLite
authority. Cutover accepts that receipt only while its exact
authority/generation, connection epoch, scope, and monotonic age remain
current; the consumed cycle capability itself must also still be within that
liveness bound. This keeps the marker durable without making it a second
Freshness authority and keeps restart/swap recovery fail closed. A readiness
miss is the sole fail-soft outcome; all marker/schema/evidence failures are
visible to the caller.

## C2-ZC-00 final acceptance candidate evidence and final gate

The implementation candidate for this closeout is
`3010e13e4a91da99eae16cb9f8bd773177c2ac58`, based on
`78732ff5635da220396bd606010dd53f4d0350a9`. Focused Rust/N-API evidence
covers the successful-cycle owner, authority/generation revalidation, and
capability-bound heartbeat. The call swallows only the exact
`NEX_C2ZC_CUTOVER_NOT_READY:` readiness result, so a malformed marker or any
other contract error remains observable.

The following pre-closeout evidence was recorded before this documentation
candidate was committed:

| Evidence | Result |
| --- | --- |
| Standalone real Electron C2-ZC journey | PASS; `.artifacts/product-journeys-c2zc-3010e13e-final-1/results.json`; `19621ms`; renderer/page errors `0`; main raw error `1`; the exact scoped restore Skia allowance leaves `unallowedMainErrors = []`, `mainCleanPass = true`, and `cleanPass = true` |
| Candidate-bound Quick | PASS; all 8 selected Light suites; `.artifacts/local-ci/quick-precloseout-3010e13e-20260828.json`; SHA-256 `0236ab55100528bb0844624536efd8c50adfe80f7ceb67b0ab4273c38fd40efe` |
| Candidate-bound impact selection | `.artifacts/local-ci/impact-precloseout-3010e13e-20260828.json`; SHA-256 `292ba86ae1014c2563c05955b08a0fca47d2b557154c261c098af1203f7372d2` |
| Immediate Quick receipt verification | PASS for the same `origin/master` / `HEAD` refs and the implementation candidate above |

These are pre-closeout facts, not acceptance of this documentation tree. At
candidate-preparation time, Full CI and its receipt verification had not been
run on the final documentation candidate.

The C2-ZC candidate requires the complete Verify set: all 13 named checks are
required and production coverage is 13/13. Coverage may not be reduced. The
Semantic Index checks are production read-only boundary checks, not an
activation signal; the reserved authority footprint below must be observed
directly.

## Reserved Semantic Index boundary

`semantic-index` remains `reserved`. The only passing C2-ZC observation is an
all-zero scan across these four authority surfaces:

1. All rows for the project in `narrative_semantic_index_metadata`
   (`metadataRows`; `project_id = ?1`)
2. Active sealed D1 declaration heads for the project and
   `consumer_kind = 'semantic-index'` (`activeD1HeadRows`)
3. V1 `narrative_dependency_edges` rows for the project and
   `consumer_kind = 'semantic-index'` (`v1EdgeRows`)
4. `narrative_consumer_freshness` rows for the project and
   `consumer_kind = 'semantic-index'` (`consumerFreshnessRows`)

The machine-readable policy records these four scopes/predicates so the
authority scan cannot accidentally interpret `all-zero` as a database-wide
count or include unrelated Consumer kinds.

Any non-zero footprint is manual/terminal evidence and is not a
Rebuild-Derived target. Scene, Codex, Event, and Chat embedding chunk rows may
exist as rebuildable acceleration, but they never authorize or imply a
Narrative dependency authority claim.

The dormant future binding algorithm is reserved for NIR-1 approval:

- `metadata.index_key = D1 consumer_key = freshness.consumer_key`;
- `metadata.generation = active sealed D1 head consumer-scoped
  producer_generation`;
- `metadata.dependency_set_digest = active sealed D1 set digest`.

This does not approve fixed keys, a producer registry, Source identities,
writers, D1 declarations, metadata migration, restore invalidation, or
`reserved` → `declared` activation. NIR-1 may start with one shared producer as
the first candidate, but producer granularity, metadata producer identity
composition, dirty/pending semantics, and Codex Source granularity remain
unapproved.

## Current acceptance state

This commit records a final acceptance candidate, not an accepted or complete
cutover. The candidate is accepted if and only if this exact clean
documentation candidate passes Quick, immediate Quick receipt verification,
Full from stage 1, and Full receipt verification, followed by the Sol final.
Until that receipt exists, NIR-1 remains blocked and does not start.
