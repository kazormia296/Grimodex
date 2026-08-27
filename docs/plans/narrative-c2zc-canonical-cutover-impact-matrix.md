# C2-ZC Canonical Freshness Cutover Impact Matrix (candidate)

This matrix records the C2-ZC canonical-authority candidate and its current
evidence; it is not a final acceptance record. The feature remains a
main/N-API/shared-Rust maintenance seam; renderer and preload do not gain a
cutover or scheduler-maintenance surface. An ordinary Freshness wake runs a
bounded cycle, mints a capability-bound liveness receipt, and attempts the
durable cutover on the revalidated current authority. A not-ready workspace is
retried on a later wake; marker, schema, evidence, and authority errors are
surfaced rather than treated as readiness misses.

| ID | Flow / variant | Owner / producer | Boundary, contract, transform, validation | Consumer / sink | Preserved invariant | Compatibility / fallback | Verification | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C2ZC-P1 | Ordinary workspace wake | Electron main freshness scheduler | `runNarrativeFreshnessCycle` is the existing main-only wake. N-API pins the active workspace, binds the current authority/generation, runs one bounded cycle, records a typed shared-Rust scheduler heartbeat only after the cycle returns `Idle` or `Processed`, then calls `cut_over_workspace_freshness` on that same revalidated authority. | Shared Rust incremental freshness runtime and C2-ZC cutover | One in-flight bounded cycle; cursor reservation/replay/ack remains Rust-owned. A failed cycle cannot mint liveness or activate the marker. | Missing workspace or unavailable native method remains the existing fail-soft `null`; exact `NEX_C2ZC_CUTOVER_NOT_READY:` is retried on later wakes; unexpected failures surface; no renderer/preload route. | `c2-zc-canonical-authority-cutover` product journey (real Electron main -> N-API route); `narrativeMaintenance` trigger tests; N-API marker-error and heartbeat-binding tests. | code candidate — focused green; final acceptance pending |
| C2ZC-P2 | Active scheduler receipt | N-API + shared Rust | Shared Rust creates the `SchedulerLivenessEvidence` from the live N-API authority binding and current project set only by consuming a successful-cycle capability. That capability carries the exact SQLite connection epoch and monotonic completion instant observed after the cycle; heartbeat rejects a capability from any other `Database` authority or one older than the liveness bound. Cutover accepts only the process-local receipt registered by that heartbeat, with canonical timestamp, exact project scope, current authority generation, bounded monotonic age, and the same connection epoch. | C2-ZC readiness gate | A completed DB Run never self-attests scheduler liveness; caller-shaped/fabricated, replayed, stale, and cross-authority cycle capabilities fail closed. | No receipt, stale capability or receipt, malformed scope, wrong authority, or same-project different-Database binding is `Blocked`/`Incomplete`; no DB-only promotion. | Rust C2-ZC liveness negative/positive tests; N-API binding tests; stale-capability, same-project cross-Database capability, and receipt negatives. | code candidate — focused green; final acceptance pending |
| C2ZC-P3 | Stale or wrong binding | Workspace recovery gate | N-API obtains `MaintenanceWorkspaceBinding` from the pinned authority. Shared heartbeat receipt is replaced on authority/generation change and every cutover requires an exact current receipt, including the bound Database connection identity. | C2-ZC cutover | Old workspace/database authority cannot activate a new or swapped workspace. | No fallback to path identity, old generation, same-project identity, or prior receipt. | `narrativeMaintenance` binding mismatch tests plus Rust stale/wrong-Database receipt tests. | code candidate — focused green; final acceptance pending |
| C2ZC-P4 | Authority swap | N-API workspace authority owner | The cycle pins one authority, then takes the existing workspace-open serialization guard, re-resolves the active authority and binding, and only then mints liveness and attempts cutover. Binding generation changes on swap/recovery; the old process-local receipt is invalidated by replacement. | Scheduler and cutover gate | No operation crosses workspace authorities; same-path restore still changes authority identity/generation, and a late old cycle cannot activate its database. | Workspace switching/safe mode remains fail-soft; any later activation waits for a new heartbeat. | Workspace-generation tests; focused N-API swap characterization. | code candidate — focused green; final acceptance pending |
| C2ZC-P5 | Retry / restart | Main scheduler + N-API backend | Scheduler retries only after cycle completion. A new backend must emit a new heartbeat; the receipt is process-local and cannot be inherited from a prior process. | C2-ZC readiness | Recovery never treats a stale process as live. | The durable cutover marker persists; lack of a new live receipt blocks activation until a later successful wake. | `c2-zc-canonical-authority-cutover` product journey restart phase; main scheduler retry tests and shared Rust receipt-age/restart tests. | code candidate — focused green; final acceptance pending |
| C2ZC-P6 | Marker persistence | Shared Rust cutover + `Database` schema-owner helper | C2-ZC never executes `schema_data_migrations` SQL directly. The scheduler-owned cutover calls the authorized `migrate.rs` marker helper, which validates the current contract and writes the activation marker atomically with the readiness decision. | Workspace open/recovery and canonical read | One durable activation record; schema migration ownership remains in the schema-owner module. | Existing C2-ZB marker/rekey path is untouched; wrong marker version fails closed. | Migration-owner unit test; marker atomicity/idempotency tests. | code candidate — focused green; final acceptance pending |
| C2ZC-P7 | Canonical read | Shared Rust C2-ZC API | After a current marker, read only `narrative_consumer_freshness` for an Application; validate vocabulary, current epoch, dependency-set digest, timestamp, exact Incremental Freshness Run provenance, and Edge State roll-up. | Native consumers of candidate canonical Freshness | Generic Consumer Freshness is the candidate sole read authority, pending C2-ZC final acceptance. Missing/invalid Generic evidence is an error. | No read fallback to `narrative_projection_freshness`; absent application remains `None`. | Immutable public contract tests plus strict Generic contract tests. | code candidate — focused green; final acceptance pending |
| C2ZC-P8 | Legacy compatibility / no fallback | Shared Rust Apply and source-propagation writers | Before marker, preserve existing Legacy writes. After marker, Apply declares typed Generic Edges only; Source mutations go through the live incremental evaluator, while an idempotent `ensure-existing` Application (which intentionally has no Feed event) may use the typed publish-runtime owner to seed its declared Edges and Consumer row as `Unknown`/`Manual` at the current Epoch/digest. Legacy source propagation returns without mutating the mirror. | Generic runtime and compatibility tables | Legacy is compatibility-only and cannot silently diverge as a second authority; no-op initialization never fabricates a Feed or a Fresh result. | Existing legacy rows remain readable for parity/diagnostics only; canonical read never consults them. | Post-marker writer characterization tests; immutable no-fallback tests; idempotent temporal-ensure canonical test. | code candidate — focused green; final acceptance pending |
| C2ZC-P9 | Post-marker Project birth | `domain_writes::project_create`, `import::apply_commit`, + shared Rust epoch owner | After its canonical Project-birth event is appended in the same transaction, an exact-current marker mints exactly one `initial` Semantic Epoch bound to that event UID. `project.create` and `import.session.apply` retain distinct exact event identities; Import also verifies the canonical session identity and payload target. No marker means no new Epoch; an unsupported marker or pre-existing Epoch rolls back the whole Project creation. Apply never mints this bootstrap Epoch. | Post-marker Application writer | Every new Project has a durable, event-bound current Epoch before a post-marker Application can declare Generic dependencies. | No best-effort epoch mint; unsupported marker and duplicate bootstrap fail closed. | `c2-zc-canonical-authority-cutover` direct post-marker Project create/restart assertion; Project create and Import pre-marker/current-marker/idempotent-replay/unsupported-marker rollback tests. | code candidate — focused green; final acceptance pending |
| C2ZC-P10 | Renderer/preload maintenance surface | None (explicit non-owner) | No renderer IPC command, preload method, or renderer maintenance state is added. Main-only N-API scheduler wake remains the only runtime entry point. | N/A | No user-controlled cutover or forged liveness payload crosses renderer boundary. | Existing renderer behavior unchanged. | `rg`/contract surface audit; frontend lane is out of scope. | out of scope: no renderer/preload maintenance surface |

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

## C2-ZC-00 candidate evidence and final gate

The code candidate was re-audited against the base used for this lane. Focused
Rust/N-API evidence covers the successful-cycle owner, authority/generation
revalidation, and capability-bound heartbeat. The call swallows only the exact
`NEX_C2ZC_CUTOVER_NOT_READY:` readiness result, so a malformed marker or any
other contract error remains observable. Focused green evidence is not final
acceptance: the production product journey, clean Full CI plus receipt
verification, and the Sol final have not completed.

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

The C2-ZC code candidate and focused contract evidence are not an accepted or
complete cutover. Final acceptance remains blocked until the product journey,
clean Full CI and its verification, and the Sol final are recorded. The NIR-1
start condition is therefore not met; NIR-1 remains blocked rather than
starting from this candidate.
