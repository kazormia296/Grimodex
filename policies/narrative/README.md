# Narrative writer protection (Gate B PASS / Gate C1)

`protected-writers.json` is the active Release Gate B writer-authority registry
for Narrative domain tables, shared protected columns, and the Native-owned
runtime policy.

## Enforcement

- `enforcement: "deferred"` — declared only while a future table is waiting for
  its typed Native writer cutover.
- `enforcement: "active"` — Native authorizer denies untrusted mutations and
  `pnpm test:narrative:writers` requires zero production Drizzle / raw-SQL writes.

Gate B2 has passed. All registered Narrative authority tables, including the
five Narrative Change Feed tables, are `active` and remain unavailable to
Renderer and MCP generic SQL.

## Change Feed operation coverage

`change-feed-writers.json` is the Gate C1 operation-level inventory. It does not
replace `protected-writers.json`: the protected writer registry owns table and
column authority, while the Change Feed inventory classifies each mutating
Electron IPC／N-API／MCP／internal operation as:

- `required` — the operation must append a canonical Change Event and its linked
  Narrative Change Feed transaction atomically.
- `delegated` — an existing aggregate workflow owns the linked Feed append.
- `excluded` — the operation has a fixed non-domain reason such as migration,
  database-image replacement, staging, derived state, or untrusted generic SQL.

The manifest's `writerMatrix` is the C1 input contract for the Semantic Build
System. Every row fixes the addressing strategy (`independent-key` or
`aggregate-path`), canonical object-key family, JSON Pointer path vocabulary,
text-impact requirement, allowed cause directions, transaction atomicity,
Undo/Redo coverage, and retry idempotency. Plot and temporal child rows use
independent typed keys. Foreshadow's renderer writer deliberately uses
aggregate-root addressing because its root OCC token owns setup/payoff writes;
its child paths are therefore `/setups/<setupId>` and `/payoffs/<payoffId>`.
Writers that own an independent Foreshadow child table may use the typed child
key, and must declare that strategy in their matrix row. A restore is the
exception: it emits one project-level `project-restored` epoch-reset marker and
asks C2 for a full rebuild instead of replaying every restored row.

`pnpm test:narrative:change-feed-writers` validates the manifest, known public
routes, implementation modules and symbols, active writer IDs, identity
contract, fixed exclusion reasons, and runtime evidence. `coverageStatus:
"verified"` requires a versioned `runtimeEvidence` bundle naming the commands,
regression files, and controls that exercise the declared Native/browser
contract. The bundle is evidence for review; this static validator does not
itself prove every transaction's runtime atomicity. Gate C1 additionally requires
`pnpm test:narrative:change-feed-writers:strict`: every `required` or
`delegated` operation must have `coverageStatus: "verified"`; runtime proof
comes from the Native writer, browser contract, and Journey/quality tests.

Generic Renderer/MCP SQL and `agent_write_bundle` are never Feed authorities.
Staging-only prose accept also stays out of the Feed; the subsequent typed scene
body save records the authoritative `ai-apply` mutation.

Project metadata is published by the typed `project_patch` Native writer. It
uses the previous `updatedAt` as an OCC token and appends the semantic JSON
Pointer paths (including `aiPolicy`) in the same transaction as the domain
update, Undo Journal, canonical Change Event, and Narrative Change Feed.
Project INSERT/DELETE is also structurally protected. `project_create`
publishes the Project scope and its four builtin Codex types in one trusted
transaction; the builtin catalog is the ordered Feed payload. Bootstrap, sample
seed, and scan staging creation retain their fixed non-user initialization
contracts.

Map has an explicit boundary. `map_write_bundle` is the only Canonical Native
Map aggregate writer and owns promotions that create Scene, Snippet, Codex Entry,
or Codex Relation state. Direct Renderer CRUD for board settings, positions,
stickies, user edges, and frames is canvas-layout state only: it is classified
under the `renderer.generic-sql.execute` / `renderer.generic-sql.batch`
`untrusted-generic-sql` exclusion, does not participate in narrative freshness,
and must never create or mutate Scene, Codex, Chronicle, Plot, or Foreshadow
artifacts. Moving a canvas card or editing a visual edge therefore does not claim
a Narrative Change Feed mutation; promoting it into a narrative artifact does.

## Gate status

Gate B2 is **PASS**. Gate C0 established the SCHEMA 21 Feed foundation; Gate C1
advances the contract to SCHEMA 22 and wires Canonical Native Writers so domain
state, Undo Journal where supported, canonical Change Event, idempotency receipt,
and Narrative Change Feed commit or roll back together. Dependency Index,
scheduler, automatic maintenance, and Background AI remain Gate C2+ work and do
not start here.

## Gate C1.5 semantic contract

The C1.5 machine-readable contracts are:

- `mutation-authority-routes.json` — the seven Mutation Authority Routes
  (the C1.5-ratified six plus C2-T1's `attention-typed-writer`, see below),
  positive fail-closed caller allowlists, diagnostic-only forbidden caller
  lists, route-specific required controls, and Human Direct's conditional
  Field Authority requirement;
- `semantic-state-vocabulary.json` — Review, Evidence Freshness,
  Reconciliation Signal, Build Action, Component Compatibility, and Projection
  Application State as separate axes;
- `semantic-core-authorities.json` — the canonical authority matrix and the
  Semantic Index field allowlist;
- `retrieval-disclosure.json` — pre-admission spoiler, phase, scope, and
  knowledge-holder rules;
- `schemas/*.schema.json` — JSON Schema draft 2020-12 definitions for the four
  policy documents;
- `fixtures/` — route, evidence, and many-to-many Projection contract cases.

`authorityRoute` is required on every C1 operation; operations that share one
typed writer across surfaces may additionally declare `authorityVariants` so
each runtime route has its own controls and caller allowlist. The route is
also carried by the renderer Native write context. Native validation binds the route to an exact
caller allowlist, origin, provenance, and replay lineage, then records the
validated route and runtime evidence in the canonical audit payload. It
complements, and does not replace, the existing low-level `canonical.origin`
audit attribute. The read-only validator
`scripts/quality/validate-semantic-core-boundary.mjs` rejects unknown routes,
missing route controls, false runtime-control claims for untrusted generic SQL,
direct Interpreter/Maintenance imports of Agent Writers, mixed state
vocabulary, and a second Freshness authority. C1.5 keeps workspace SCHEMA 22
and does not create C2 tables. `ai-apply` must carry an explicit authority
route because it is valid for both Interactive Agent Command and Interpreter
Projection; no origin-only fallback is permitted.

## NIR-0 Scope and Dependency contracts — C2B WIRED / Disclosure DECLARED

ADR 009 and ADR 010 define the machine-readable contracts used by the current
C2B add-only slice:

- `narrative-scope-relation-contract.json` — the V2 Scope axes, explicit
  `any` versus constrained-but-`unresolved`, strongest-established Relation
  semantics, structural Digest boundary, Oracle Basis rule, Assertion Scope
  Profiles, and Consumer use policies;
- `narrative-dependency-role-registry.json` — Evidence／Dependency／Context Set
  separation, ten Dependency Roles, Role × Consumer × Change Class effects,
  UTF-16 Selector V2, independent required／advisory Build Action aggregation,
  sealed Declaration Set, Head CAS, and V1／V2 priority rules;
- matching `schemas/narrative-*-v1` JSON Schema draft 2020-12 contracts.

The live project Scope authority and C2B ScopeOverride materialization are
`wired` for the Chronicle add-only pilot. The typed route derives Scope V2,
child D1/V1 dependencies, current-Epoch Freshness, and the final current
pointer atomically; it has no mutable Scope head of its own. Historical
`snapshot:<runId>` authority remains a separate sealed basis. The current
`scope.ts`/Disclosure contract remains V1-compatible and its production
admission is still `declared`; D2 full V2 authority cutover is not implied.

## NIR-0 Shared Narrative IR contracts — ACTIVATED (Chronicle add-only pilot)

NIR-0 freezes the shared Narrative IR contract through [ADR
011](../../docs/adr/011-narrative-ir-revision-semantics-contract.md) and
activates only the typed Chronicle `scene-event@1` / `add` route:

- `narrative-ir-contract.json` — Envelope V2 and V2 monotonicity, project-scoped
  `narrative_proposal_revisions.id` identity, Native-verified Human-derived
  edits, material-basis ownership, stale-validation split, Chronicle add-only
  pilot wiring, activation rule, and the independent Scope Disclosure adoption
  reference;
- `schemas/narrative-ir-contract.schema.json` — machine-readable contract
  schema;
- `fixtures/narrative-ir/chronicle-scene-event-v2.json` — shared versioned
  Adapter golden corpus that future TypeScript and Rust implementations must
  pass for Scope derivation, Human-derived old/new payload classification,
  unsupported-path refusal, and canonical Scope/digest agreement; stale
  validation and activation remain semantic contract tests;
- `validate-narrative-ir-contract.mjs` — semantic checks for identity,
  monotonicity, Human-derived boundaries, cumulative mixed-edit
  classification, golden-corpus integrity, Chronicle add-only wiring, and
  activation production markers.

ADR 009 remains the owner of Scope capability status and the independent Scope
Disclosure adoption track. ADR 010 remains the owner of Context Set and
Dependency Role semantics. The active production entry points are the
Chronicle extraction coordinator, atomic proposal-set save, and C2B
Human-derived revision writer. Direct generic V2 append remains blocked; the
existing V1 append path is an explicit compatibility fallback. V2
emission/current-Revision promotion are limited to the `add` pilot.

These contracts do not create a second Freshness or semantic authority. The
existing `scope.ts`, Disclosure evaluator, Dependency Edge, and Consumer
Freshness paths remain V1-compatible. Disclosure admission, revise/retract/
merge/split, D2 full cutover, and NIR1 retrieval remain deferred.

The [NIR0-CERT completion ledger](../../docs/certification/nir0/NIR0-CERT.md)
binds PR #559's clean candidate base/head/tree to the byte-identical tree merged
as `651791655177538ee02bc7e773f7d98c534ea324`. Credentialed/live-model Heavy
work remains deferred and is not counted as passing NIR-0 evidence.

## Gate C2 — COMPLETE

Gate C2 begins from ADR 005's existing "Authority matrix and C2 start
condition" checklist (Mutation Route / Source Event Contract / Object
Addressing / State Vocabulary / Authority Matrix / Disclosure Policy /
Evidence-Scope, all fixed at C1.5) and implements only Dependency Edge, Edge
State, Consumer Freshness, Application Contribution, Reverse Lookup,
Incremental Evaluator, Cursor, and Backfill persistence/runtime, per that
ADR. There is no separate `docs/certification/gate-c2/` directory or base-SHA
file; this section is the running status record, alongside PR history and the
accepted ADR/policy contracts.

```text
Gate C2 — COMPLETE
  Contract / Registry / Ledger Spine (C2-00): complete
  Schema / Transport Extension Spine (C2-01): complete
  Wave 1 foundation lanes:                    complete
  Wave 1 Transport Assembly (C2-T1):          complete
  Wave 2 runtime / read-model lanes:          complete
  C2-1 incremental Freshness runtime:         complete (see below)
  C2-3 Finding identity / Attention re-home:  complete; merged through PR #556/#559
  C2-5 shared triggers / lifecycle recovery:  complete; merged through PR #556/#559
  C2-ZB Application re-key migration:         complete; SCHEMA 32 merged and hardened
  C2-ZC Canonical Authority Cutover:          complete; Generic is canonical
```

### C2-1 Change-Feed-driven incremental Freshness runtime

The production runtime is
`src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs`.
It reserves a bounded canonical Change Feed range, resolves event object keys
to Source identities, performs reverse Dependency lookup, evaluates the
affected Edges, and publishes every affected Consumer before one cursor
acknowledgement in the same transaction. Ratified component-schema and
restore/Epoch-reset markers conservatively fan out to the full graph. Semantic
Epoch, Task lease, cursor reservation, evaluated Source state, and Edge
declaration checks guard publication. Only running work is resumable; a
completed Run cannot acknowledge an unacknowledged range, and bounded
Run/Task/Attempt recovery stops after three failed Attempts until a canonical
Epoch rotation releases the held range for a new runtime-owned Run.

`electron/native/grimodex-node/src/lib.rs` exposes this as a main-only Native
cycle. `electron/main/narrativeFreshness.ts` owns the single-flight scheduler
and bounded backlog pacing; it deliberately adds no renderer IPC or preload
surface. Contract-level fixtures live in
`src-tauri/crates/grimodex-db/tests/narrative_incremental_freshness_runtime.rs`
and `electron/main/narrativeFreshness.test.ts`.

The C2-1 runtime completion is intentionally narrower than later NIR-1
retrieval work. C2-3's
three-layer Finding identity and exact Attention re-homing, C2-5's automatic
Backfill/Verify/Rebuild-Derived scheduling and shared cross-Run-Kind recovery,
and C2-ZB's schema-owned Application re-key are merged through PR #556 and PR
#559. C2-ZC is now accepted as the canonical authority switch: Generic
Consumer Freshness is canonical after the durable marker, while the Legacy
projection remains compatibility-only and is never a canonical read fallback.

The paragraphs below preserve the landing rationale for earlier C2 slices;
their historical environment-specific validation caveats are not the current
Gate status.

C2-T1 has wired its first slice end-to-end: Lane D's Attention typed writer
(`narrative_maintenance_attention_set`/`_clear`) and Lane O's Maintenance
Inbox read model (`narrative_maintenance_inbox_list`), from Rust
(`set_attention_in_tx`/`clear_attention_in_tx`/`build_maintenance_inbox`,
promoted `pub(crate)` → `pub` in `attention.rs`/`finding_observation.rs`/
`inbox_read_model.rs`/`mod.rs`) through three new `#[napi]` functions in
`electron/native/grimodex-node/src/lib.rs` to three new
`electron/shared/ipcContract.ts` commands (`NapiBackendLike` optional
methods, payload validators, `requireNapiMethod`-wrapped command-table
entries). `narrative_maintenance_attention` is a new active writer in
`protected-writers.json`/`validate-native-writer-ownership.mjs`
(`narrative.maintenance-attention`).

Wiring the Attention writer into `change-feed-writers.json`'s per-writer
coverage requirement (every active `protected-writers.json` writer id needs
an operation entry) surfaced a real gap, not a paperwork one: none of the
six C1.5 Mutation Authority Routes fit an operation that is, by contract,
permanently excluded from OCC, the Proposal/Decision/Prepared-Commit
pipeline, and the Change Feed alike (`maintenance-attention-contract.json`:
`backflowPolicy: "forbid"`). Rather than force a false `requiredControls`
claim onto an existing route, ADR 006 was amended (2026-08-15) to add a
seventh route, `attention-typed-writer` — `requiredControls: ["typed-writer"]`
only, `allowedCallers: ["human-ui"]`, same `forbiddenCallers` as every other
route (`background-maintenance`/`reconciler`/`idle-scheduler`). This
required consistent edits across
`policies/narrative/mutation-authority-routes.json`,
`policies/narrative/schemas/mutation-authority-routes.schema.json`,
`scripts/quality/validate-semantic-core-boundary.mjs`'s four hardcoded
per-route expectation tables, and its test fixture. The two new
`change-feed-writers.json` operations
(`narrative.maintenance-attention.set`/`.clear`) declare
`feedPolicy: "excluded"`, `exclusionReason: "non-backflow-invariant"` (the
C2-00-added reason, used here for the first time), and
`coverageStatus: "verified"` — matching the existing
`narrative.field-authority.set-lock`/`narrative.commit.prepare` pattern
where "verified" certifies the operation's Change-Feed-exclusion is a
structural, provable fact from its contract, not a claim that
`narrative_maintenance_attention_set` itself has been through a runtime
test in this environment.

`narrative_maintenance_inbox_list` is read-only and mutates nothing, so it
needed no `protected-writers.json`/`change-feed-writers.json` entry.

As with C2-01/Wave 1/Wave 2, this environment's broken Rust toolchain
(`libsqlite3-sys` `cfg_select` build-script failure, pre-existing) means
none of C2-T1's Rust changes have been through `cargo check`/`napi build`.
Verification here used `rustfmt --edition 2021 --check`, a brace/paren
balance check, `npx tsc --noEmit` (both root and
`electron/tsconfig.json`), and the full `pnpm test:quality` suite (149
tests; 148 pass, 1 pre-existing failure unrelated to this branch — a
sandboxed-environment "unable to resolve GitHub repo slug from origin"
error in `certify-gate-b2-bindings.test.mjs`, confirmed via `git stash` to
reproduce identically on an unmodified checkout).
`electron/native/grimodex-node/index.d.ts` was not regenerated (needs a
working `pnpm napi:build`).

**The remaining Wave 1/2 lanes are not a second batch of the same kind of
work.** Attention and the Maintenance Inbox were genuinely standalone,
additive typed-writer/read-model commands — new table, new writer, new IPC
entrypoint, nothing pre-existing touched. A follow-up audit of the other 9
Wave 1/2 modules found that most of them are explicitly documented, in
their own module doc comments, as internal helpers meant to be called from
_existing_ pipelines, not new standalone commands:

- `semantic_epoch.rs` (Lane A) and `restore_rebuild.rs`'s
  `rotate_epoch_for_restore_in_tx` (Lane N): **wired (C2-T1, see below)** —
  minting/rotating a Semantic Epoch requires ADR 006's
  `restore-or-migration` route (`allowedCallers`: `restore-controller`/
  `migration-runner`/`integrity-repair` only), so it belongs inside the
  existing restore and integrity-repair paths, not a new command; DB
  migration itself does not yet mint an "initial" epoch and remains
  out of scope for this piece.
- `evaluator.rs` (Lane F): pure, I/O-free computation (its own doc
  comment says so) — a library called by `publish_runtime.rs`, never an
  IPC entrypoint itself.
- `dependency_edges.rs` (Lane G): **wired (C2-T1, see below)** — its
  "Producer-time commit path" turned out, on closer reading, to mean
  Proposal/Revision _generation_ (`repository.rs`), not `commit.rs`'s
  _apply_, and needed no change to `commit.rs` at all.
- `application_contributions.rs` (Lane H): **wired (C2-T1, see below)** —
  a genuine `commit.rs` apply-time concern, but it turned out to need only
  _one_ new call site, not 15: `commit.rs` already has a single central
  loop (right after applying every operation) that calls
  `field_authority::affected_fields` per operation to record Field
  Authority, and that loop already has `application_id`,
  `entity_kind`/`entity_id`, and `now` in scope. Reusing that exact
  already-correct field list, rather than re-deriving "which fields did
  this operation kind touch" a second, drifting way per operation kind,
  turned this from a feared 15-call-site risk into one small addition.
- `cursor_reservation.rs` (Lane I) and `publish_runtime.rs` (Lane J):
  internal bookkeeping for the Run execution pipeline and the (not yet
  built) Change Feed → Reverse Lookup → evaluator → publish background
  path; `semantic-core-authorities.json` already fixes Evidence Freshness's
  `canonicalAuthority` as this evaluator with `writePolicy:
canonical-only`, and no ratified Mutation Authority Route yet permits a
  background/scheduler caller for it.
- `semantic_index_diagnostics.rs` (Lane M): pure diagnostic, no I/O; its
  own doc comment says it never triggers a rebuild itself.
- `legacy_backfill.rs` (Lane K) and `restore_rebuild.rs`'s
  `rebuild_verify_dependency_edges`/`rebuild_repair_dependency_edges_in_tx`
  (Lane N): **design ratified, see `narrative-run-kind-policy.json`
  below** — Legacy Backfill and Rebuild-verify run automatically; only a
  Repair that corrects a _durable_ Dependency/Contribution declaration is
  human-triggered. Run creation/scheduling for all four is still to be
  implemented.

No frontend UI exists yet for any of this beyond a Gate C0 placeholder
(`src/features/narrative-extraction/.../StructureHealthPanel.tsx`,
`liveCountsAvailable: false`, no IPC calls).

**Lane G (`dependency_edges.rs`) Producer-time wiring landed in C2-T1.**
`repository.rs`'s `insert_proposal_seed` (first revision) and
`append_revision_on_conn` (subsequent revisions) now call a new
`record_run_dependency_edges_in_tx` helper for every `SourceBasisRow` a
Proposal's validated Reconciliation Envelope carries. Two things only
became clear by reading `restore_rebuild.rs` (Lane N) closely: Edges are
declared under Consumer identity `(RUN_CONSUMER_KIND =
"narrative-extraction-run", run_id)` — the _Run_, never the individual
Proposal — because Lane N's Rebuild-verify diagnostic already queried Edges
by that exact convention before any Producer declared them; and
`source_object_identity` uses fixed prefixes (`project:scope-authority:`,
`project:scene:`, `snapshot:`, `project:codex-catalog:`, `projection:`,
`artifact:`, `capture:`, `evidence:`) that `restore_rebuild.rs`'s `infer_source_kind`
already reads in reverse, so a new `dependency_edges::source_object_identity_for`
builds the same strings forward from a `SourceBasisRow`'s `(sourceKind,
sourceKey)`, cross-checked against `reconciliation_envelope.rs`'s own
`sourceKind` vocabulary. `RUN_CONSUMER_KIND` moved from a private const in
`restore_rebuild.rs` into `dependency_edges.rs` (which owns the Consumer/
Source model) so both the Producer and the Rebuild-time reader share one
definition. Edges accumulate per Run across every Proposal/Revision it
produces — an upsert per Source, never a delete-then-redeclare at Proposal
granularity, since that would erase sibling Proposals' Edges from the same
Run; when a Run's whole Edge set should be cleared (a full re-run/redo) is
a separate, still-open question left to Run/Task/Attempt lifecycle code
(Lane B). `commit.rs` needed no changes at all for this piece — the
"Producer-time commit path" its own doc comment referred to turned out to
mean Proposal/Revision generation, not commit _apply_.

`project:scope-authority:<projectId>` is a computed Source added by the NIR-0
C2B live-authority foundation. It has no durable head of its own: the resolver
derives one typed revision from a single SQLite snapshot of live `tree_nodes`.
The source is wired through Incremental Freshness, restore/rebuild, and the
C2B ScopeOverride materialization transaction. Empty-folder structural events
carry typed live-Scene subtree impact and do not false-stale the aggregate.

Verified via the NIR0-CERT focused Rust and TypeScript suites,
a Python `sqlite3` replay of the exact `narrative_dependency_edges` upsert
SQL confirming two sibling Proposals' Edges survive independently and a
re-declared Source upserts in place, and a new
`repository.rs::unit_tests::saving_proposals_declares_dependency_edges_under_the_owning_run`
test (using the real migrated schema, not the lightweight
`ensure_test_schema` fixture, since it needs `tree_nodes` and the Gate C2
tables) that saves two Proposals against real `tree_nodes` scene rows and
asserts both Edges land under the Run, then that a legacy-unbound Proposal
in the same Run neither adds nor removes them. As with everything else on
this branch, this has not been through `cargo check`/`cargo test`.

**Lane H (`application_contributions.rs`) apply-time wiring also landed in
C2-T1.** `commit.rs`'s `narrative_extraction_apply_commit` gained one new
loop, immediately after its existing `record_operation_field_authority`
call: `for (operation, application_id) in payload.operations.iter().zip(&application_ids)
{ for field in affected_fields(operation, &commit_map)? { record_contribution_in_tx(...) } }`.
`application_ids` is 1:1 with `payload.operations` by construction (both
built from the same per-index loop over `payload.applications` moments
earlier), and `commit.rs` already validates `applications.len() ==
operations.len()` before apply ever runs, so the `zip` is safe. Calling
`affected_fields` a second time (it was already called once inside
`record_operation_field_authority`) is a deliberate, cheap redundancy
instead of threading its result through two functions — `affected_fields`
is pure (payload parsing plus a `CommitMap` lookup, no I/O), so the two
calls are guaranteed identical. Every contribution lands with
`target_state: Unchanged` (the write just happened, so the field currently
matches exactly what this Application applied); a later process — Undo/
Redo, a superseding Application, a hand edit — is what would ever
transition it away from `Unchanged`, not this commit itself. This is
_not_ the 15-operation-kind risk originally feared: `affected_fields`
already centralizes per-operation-kind field derivation for Field
Authority, so Lane H needed no new per-operation-kind logic at all, only
one small addition at the one place all operation kinds already converge.

Verified via `rustfmt --edition 2021 --check`, a brace/paren balance
check, and a new
`codex_narrative_commit.rs::apply_commit_records_application_contributions_per_affected_field`
integration test that applies a real `codex.entry.create` commit and
asserts `narrative_application_contributions` has exactly one row per
field `affected_fields`'s own `"codex.entry.create"` arm declares
(`/name`, `/summary`, `/aliases`, `/type`, `/content`, `/parentId`), all
under the real `narrative_proposal_applications.id` and all
`target_state = 'unchanged'`. As with everything else on this branch, this
has not been through `cargo check`/`cargo test`.

**Lane A/N (`semantic_epoch.rs`/`restore_rebuild.rs`) restore-path wiring
also landed in C2-T1.** Both existing structural-reset call sites now mint
a Semantic Epoch, in the same transaction as their Change Feed append:

- `project_snapshots.rs`'s `apply_project_snapshot_restore` calls
  `rotate_epoch_for_restore_in_tx(&transaction, &payload.project_id,
"project-restored", Some(&change_event_uid))` right after
  `append_canonical_and_narrative_change_in_tx` succeeds.
  `build_snapshot_restore_feed_events` — the only place this function ever
  sets a `structural_impact` — always uses the literal `"project-restored"`
  marker, and this call site is unreachable for a net no-op restore (that
  path already returns early), so the literal is safe to hardcode. Reason
  `"restore"`.
- `integrity.rs`'s `repair_integrity` calls the same function with
  `"semantic-epoch-reset"` and `Some(&payload.event_uid)`, inside the
  `if changed { ... }` branch that is the only place this function's
  `events` vector carries that marker. Reason `"migration"`.

Both call sites reuse `crate::narrative_extraction::rotate_epoch_for_restore_in_tx`,
already `pub(crate)`-re-exported at the `narrative_extraction` module root
by Lane N, so neither needed a new visibility promotion. Minting an epoch
is unconditionally additive (`create_epoch_in_tx` auto-increments
`epoch_number` per project, no uniqueness conflict possible), so no guard
against double-minting was needed beyond what each call site's own
idempotency/atomicity already provides — the idempotent-replay path in
`apply_project_snapshot_restore` short-circuits on the stored response
before ever reaching the epoch-rotation call, and a transaction rollback
(e.g. a forced Change Feed append failure) undoes the epoch mint along
with everything else in the same transaction.

DB migration itself does not yet mint an `"initial"` epoch for existing
projects — that is a separate, not-yet-decided piece (a project's first
Epoch being `"restore"` or `"migration"` rather than `"initial"` is
harmless, just not the tidiest possible ledger), left out of this scope.

Verified via `rustfmt --edition 2021 --check`, a brace/paren balance
check, and new assertions in `project_snapshots.rs`'s own
`restore_emits_one_ordered_feed_transaction_and_replays_without_duplicates`
test (exactly one `reason = 'restore'` Epoch survives a real restore
followed by its idempotent replay) and
`net_no_op_restore_persists_only_its_retry_receipt` test (a genuine no-op
restore mints zero Epochs), plus new assertions in
`integrity_change_feed.rs`'s
`repair_integrity_is_atomic_idempotent_deterministic_and_project_scoped`
test (exactly one `reason = 'migration'` Epoch survives a real repair, an
idempotent replay, and a rejected conflicting retry) and
`repair_integrity_feed_failure_rolls_back_domain_canonical_and_retry_ledger`
test (a forced Change Feed failure leaves zero Epochs, proving the
rollback is atomic). As with everything else on this branch, this has not
been through `cargo check`/`cargo test`.

Of Wave 1's 8 lanes, A, G, and H now have real transport landed; F needs
none (a pure library). Lane N's own restore-path piece (epoch rotation)
landed alongside Lane A above; its verify/rebuild pair and Lane K's
`legacy_backfill.rs` now have a ratified Run Kind Policy (see below), but
Run creation/scheduling for all four is still to be implemented.

## Lane K/N Run Kind Policy (design ratified, core implementation landed)

`policies/narrative/narrative-run-kind-policy.json` (schema:
`schemas/narrative-run-kind-policy.schema.json`, validator:
`scripts/quality/validate-run-kind-policy.mjs`,
`pnpm test:narrative:run-kind-policy`) fixes the design decision for the
four remaining Lane K/N operations, replacing the earlier "genuinely
open — automatic or human-triggered?" framing with one principle:

> Migration and recomputation are the system's responsibility;
> correcting a meaningful durable declaration is a human's responsibility.

- **`dependency-backfill`** (Lane K; reuses the existing `run_kind =
'backfill'` column value) — automatic, once, after a schema upgrade. SCHEMA
  32's C2-ZB owner re-keys durable legacy evidence atomically; a post-open
  bootstrap Backfill still runs the v3 transform for evidence outside that
  migration boundary and creates a fresh owning Run. Lane G/H's dual-write
  into the Generic Graph must already be enabled before Backfill starts, so no
  Application created during Backfill is lost to the Backfill's own snapshot.
  The Run seals
  `{projectId, runKind, semanticEpochId, legacySourceSchemaVersion,
legacyHighWaterMark, targetGraphContractDigest,
backfillAlgorithmVersion}` at creation. Editing is never blocked while
  Backfill runs or if it fails — the pre-marker Legacy Freshness path remains
  the compatibility behavior until C2-Z readiness. Auto-retry is
  bounded to transient causes (SQLite busy, process interruption, app
  shutdown, lease timeout, transient I/O); a contract-shaped failure
  (`NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION` — cross-project
  inconsistency, unknown legacy shape, digest mismatch, duplicate
  identity, invalid Source, algorithm invariant violation) stops with
  `retryDisposition: manual`. The admin commands
  (`retryNarrativeLegacyBackfill`/`getNarrativeBackfillStatus`) are
  failure-recovery tools, not the primary way to run it.
- **`dependency-verify`** (Lane N's `rebuild_verify_dependency_edges`; no
  existing `run_kind` value, new) — automatic after Backfill completes, a
  Restore or Migration Semantic Epoch rotation, an Integrity Repair, or a
  Dependency/Rule/Normalizer contract digest change. The scheduler-owned C2-ZC
  activation consumes current Verify evidence; it is not a separate user or
  renderer trigger. Manual re-run is also allowed. Skips
  re-running when the same Epoch, graph contract, and Producer generation
  set already passed. Read-only: may write only Run status, typed
  diagnostics, Finding Observations, and its own report digest — it must
  never repair Dependency Edge/Contribution/Freshness as a side effect
  (`forbidSideEffectRepair: true` in the contract).
- **`dependency-rebuild-derived`** (Lane N; reuses the existing `run_kind
= 'semantic-index-rebuild'` column value) — automatic whenever
  Rebuildable Derived State (`narrative_dependency_edge_states`,
  `narrative_consumer_freshness`,
  `narrative_maintenance_finding_observations`, reanchor candidates,
  Semantic Index generation/cache, the Freshness evaluator's cursor
  reservation) is absent, contract-mismatched, digest-mismatched, or
  Verify reports it as required. Never touches Domain data or the Durable
  Dependency declarations Lane G/H own.
- **`dependency-repair`** (Lane N's `rebuild_repair_dependency_edges_in_tx`,
  generalized; no existing `run_kind` value, new) — manual-only. Requires
  a successful Verify Run id, a sealed repair plan derived from that
  Verify's result, the repair plan's digest, the current Semantic Epoch
  matching, an exclusive Workspace lease, an automatic backup/snapshot,
  explicit confirmation, a stable request id, and a change-count preview
  before it runs. A crash mid-repair may resume the same already-approved
  sealed plan automatically — that is recovery of an approved operation,
  not a new repair decision. Allowed repairs are limited to what is
  _reconstructible_, not _inferred_: an Edge fully rebuildable from the
  Durable Ledger, an Artifact with an explicit Dependency Manifest, a
  Proposal Revision Edge uniquely derivable from its own Source Basis/Read
  Set, an Application Contribution uniquely derivable from its Commit
  receipt, deactivating a duplicate Edge, or superseding a clear prior
  generation. Forbidden: inferring a Dependency from payload semantic
  analysis, AI-completing a missing Dependency, picking an ambiguous
  target path, touching a Domain field, rewriting author ownership,
  guessing an Evidence range, or re-adjudicating semantic truth. What
  cannot be reconstructed this way is left `detached`/`unknown`/
  `manual-review-required`, not guessed at.

The prior two-value `rebuildNarrativeDependencyIndex(mode: verify|repair)`
API shape is replaced by five named operations
(`verifyNarrativeDependencyGraph`, `rebuildNarrativeDerivedState`,
`repairNarrativeDependencyDeclarations`, `getNarrativeBackfillStatus`,
`retryNarrativeLegacyBackfill`), so Background/scheduler code cannot
accidentally reach Repair through a shared entrypoint.

C2-Z cutover (Generic Consumer Freshness becoming canonical, ending
Legacy Freshness's read authority) requires, per Workspace: Legacy
Backfill completed, the current Epoch's Verify passed, no unresolved
Durable Graph errors, Derived State rebuild completed, Legacy/Generic
parity within contract, and no active Backfill/Repair Run. Before its durable
marker, Legacy Freshness remains the compatibility behavior and the Generic
Graph is prepared; after the marker Generic Consumer Freshness is canonical
and Legacy is compatibility-only. Ordinary editing is never blocked either
way, only C2's own Structure Health/Freshness UI degrades to "semantic index is
being prepared" or "semantic graph requires repair".

This is a policy/schema contract — `validate-run-kind-policy.mjs`
confirms internal consistency (all five Run Kinds present, repair-only
fields confined to `dependency-repair`, `dependency-verify` is
diagnostics-only and side-effect-free, every `adminCommands` entry is
covered by the five named operations), requires the stable
`narrative-maintenance-route/v1` metadata for the three automatic maintenance
Run Kinds, and requires the C2-ZC cutover condition to be owned by the
main-only scheduler wake rather than a renderer or the retired manual
obligation.
`triggerEvents` names
semantic database/runtime discovery conditions, not literal emitter names.
The validator is intentionally JSON-only: it does not parse TypeScript, Rust,
SQL, call graphs, aliases, callbacks, or execution order. Electron integration
tests own wake, durable rediscovery, and route reachability evidence.
`dependency-backfill` and
`dependency-rebuild-derived` reuse the existing `'backfill'`/
`'semantic-index-rebuild'` column values with no schema change needed;
`dependency-verify` and `dependency-repair` are genuinely new values the
`run_kind` CHECK constraint does not accept yet, and extending it is
itself a SCHEMA_VERSION bump (SQLite cannot `ALTER TABLE ADD` a
multi-value `CHECK` to a populated table, the same constraint C2-01 hit
for the status columns), so this remains a substantial, not-yet-started
implementation task.

### Implementation progress

**SCHEMA_VERSION 23→24 landed** (`grimodex-core/src/lib.rs`,
`grimodex-db/src/migrate.rs`, `grimodex-core/src/workspace_schema.rs`,
`src/db/schema.ts`):

- Two new tables — `narrative_semantic_index_metadata` (Semantic Index
  generation/digest/dirty-cache bookkeeping, `PRIMARY KEY(project_id,
index_key)`) and `narrative_maintenance_repair_leases` (the Repair
  exclusive-claim row: `lease_owner`, `verify_run_id`,
  `repair_plan_digest`, `semantic_epoch_id`, `claimed_at`, `expires_at`,
  `PRIMARY KEY(project_id)` enforcing one active claim per project).
- Two new nullable baseline columns for Verify —
  `narrative_dependency_edge_states.observed_source_revision_token`/
  `observed_source_digest` and
  `narrative_consumer_freshness.dependency_set_digest`.
- `narrative_extraction_runs.run_kind`'s `CHECK` widened from 5 to 7
  values (adds `dependency-verify`/`dependency-repair`) via
  `migrate_run_kind_v24`, the same DROP+CREATE+INSERT+RENAME rebuild
  pattern as C2-01's status migration (SQLite cannot widen a populated
  table's multi-value `CHECK` with `ALTER TABLE ADD`). Fails closed on any
  existing row whose `run_kind` the new `CHECK` would not accept, rather
  than silently coercing it. Idempotent via a compacted-SQL substring
  match on the target `CHECK` clause.
- `has_current_schema_checkpoint_invariants` now gates on
  `SCHEMA_VERSION == 24` and a new `has_v24_run_kind_policy_tables` check
  covering all of the above, so a partially-migrated database cannot look
  current.

Verification: DDL (both new tables, both new columns, and the
`run_kind` CHECK rebuild) was replayed end-to-end against a realistic
v23-shaped seeded SQLite database via Python's bundled `sqlite3` —
row-count preservation, old-value preservation, new-value acceptance,
bad-value rejection, new-column nullability, new-table `CHECK`
enforcement (`generation >= 0`, `dirty_cache_flag IN (0,1)`, one lease per
project), and zero `pragma_foreign_key_check` errors, all confirmed. Rust
`#[cfg(test)]` unit tests were added mirroring this same coverage
(`migrate_run_kind_v24_widens_check_preserves_rows_and_is_idempotent`,
`migrate_run_kind_v24_rejects_unrecognized_run_kind`) plus a
byte-for-byte cross-check that the `workspace_schema.rs` invariant
substrings match real `sqlite_master.sql` output. The committed
`src/db/generated/schema-contract.json` is regenerated at the current
SCHEMA 32 boundary by the canonical schema-contract command; it is not a
hand-edited snapshot.

**`create_system_run` landed** (`narrative_extraction/repository.rs`): a
new `pub(crate)` Run-creation path for the four system Run Kinds
(Backfill/Verify/Rebuild-Derived/Repair), deliberately separate from the
public, IPC-facing `create_run`/`CreateRunPayload` rather than an
extension of it. Two reasons: extending `CreateRunPayload`'s fields would
require updating every one of its ~29 struct-literal construction sites
across 12 files with no working `cargo check` in this environment to
catch a missed one; and system Run Kinds are infrastructure the system
runs on itself, not AI extraction, so they must not gate on
`require_narrative_extraction_allowed` the way `create_run` does — the
"narrative extraction disabled" runtime toggle is about AI reading text,
and per the policy's `duringBackfillProductBehavior`, the system's own
Dependency Graph maintenance is never blocked by it. `create_system_run`
takes `run_kind`/`semantic_epoch_id`/`work_key`/`spec_json`/`spec_digest`
directly and implements `SystemRunWorkKeyReuse`
(`RunningAndCompleted`/`RunningOnly`/`None`) matching each Run Kind's
`sameWorkKeyReuse` policy field, so the workspace-open Backfill request can
fire repeatedly without racing itself. Verified: the exact INSERT/reuse-query SQL
replayed against real SQLite via Python, plus four Rust `#[cfg(test)]`
unit tests against a real `db.migrate()`-shaped database covering kind/
epoch/work_key persistence and all three reuse policies.

**Backfill's Dependency Graph transform landed** (`legacy_backfill.rs`):
the v3 writer now writes one `application`-grained
`narrative_dependency_edges` row per pre-existing
`narrative_projection_dependencies` row, alongside the epoch/Contribution
seeding it already did. Each Edge carries the fresh Backfill Run as
`owning_run_id`; the older `narrative_apply_commits.run_id` remains the
durable lineage C2-ZB uses to re-key v2 Run-shaped evidence. A commit with a
`NULL` `run_id` still emits its v3 Application Edge and increments
`applications_without_run_id` to record the missing migration lineage.
`narrative_projection_dependencies.source_kind` values are drawn from the
exact same vocabulary `source_object_identity_for` already accepts —
confirmed by inspection, since `commit.rs` writes both tables from the same
`SourceBasisRow`s for every post-C2-T1 commit.
Verified: the exact application/dependency/edge-upsert SQL replayed
end-to-end against real SQLite via Python, plus Rust `#[cfg(test)]` unit
tests covering the v3 Application owner, NULL-lineage emission, re-run
idempotency, and the retained-v2 non-reuse boundary, alongside the
pre-existing Contribution-only tests, all against a real
`db.migrate()`-shaped database.

**The Backfill bootstrap and live-authority scheduler are wired**
(`legacy_backfill.rs` and the C2-5B maintenance route registry). On
workspace-open, a durable `dependency-backfill` request is discovered and
dispatched through the serialized maintenance cycle on the pinned
`WorkspaceAuthority` connection; the same route handles durable wake and
bounded retry reasons. This keeps the Backfill's writes on the live
authority and avoids the detached second-writer `SQLITE_BUSY_SNAPSHOT`
failure mode. The Admin IPC
(`retryNarrativeLegacyBackfill`) remains a failure-recovery command, not the
normal scheduler path.

The transform itself is unchanged and still uses three phases, each its
own transaction, so a
transform failure cannot erase the Run record explaining it: (1)
reuse-check (`create_system_run_in_tx`,
`SystemRunWorkKeyReuse::RunningAndCompleted`, matching the ratified
policy's `sameWorkKeyReuse` exactly) + Run creation under a freshly
ensured Semantic Epoch; (2) run
`backfill_project_semantic_build_graph_in_tx`; (3) finalize the Run's
status to `completed`/`failed`, always attempted even on phase 2 failure.
A `failed` Run is not reused by phase 1, so the maintenance phase owner
rediscovers it on the next durable wake/restart and applies the policy's
bounded retry classes; an operator can still invoke the Admin IPC for
failure recovery.
`create_system_run` (previous commit) was split into a
`create_system_run_in_tx` core + a thin `Database`-level wrapper so this
composes atomically in phase 1's transaction instead of nesting a second
`BEGIN IMMEDIATE`.

Interrupted-run recovery is closed by the C2-5B lifecycle owner. On startup
or authority handoff, the recovery ledger identifies the exact project,
epoch, and canonical WorkKey; running rows are terminalized through their
owned Task/Attempt pair, pending compatibility rows are cancelled, and the
phase owner redispatches only the same durable identity. Stale-epoch rows
carry their observed epoch as provenance and cannot be terminalized as a
current cycle. Terminal contract-failure evidence is projected by C2-5B
Lane C into the Maintenance Inbox; current Freshness and Attention remain
separate authorities.

Verified: the full 3-phase reuse/create/finalize sequence replayed
end-to-end against real SQLite via Python, plus three new Rust
`#[cfg(test)]` unit tests (creates-and-completes, automatic-once reuse
across two calls, per-project independence).

**The evaluate→publish wiring gap is closed** (`restore_rebuild.rs`'s new
`build_edge_comparison_input`/`evaluate_edge_from_db`): the piece nothing
in the crate had before -- `evaluator::evaluate_edge` is a pure function
of `EdgeComparisonInput`, but until now nothing ever constructed one from
a live Edge. The stored comparison basis is the Edge's own Producer-time
observation (`read_set_json`'s single recorded token, ADR 005's
Producer-time Dependency Declaration -- immutable until a new Producer
run re-declares the Edge, which is exactly the right invariant: a
Consumer correctly keeps reading Stale until it is actually reproduced,
not until someone merely re-evaluates it again). The current signal is a
fresh read of the Source right now, reusing the same
`source_revision::resolve_current_source_state` resolver
`edge_source_is_missing` already calls, and the same `infer_source_kind`
reverse-mapping already defined in this module. `read_set_overlaps`/
`normalizer_version_matches`/`component_version_matches` are not backed
by any stored per-Edge state anywhere in this crate yet, so this always
reports them healthy (`EdgeComparisonInput::default()`'s baseline) --
`evaluate_edge`'s `ReadSetDrift`/`Unknown` (normalizer/component)
branches are not yet reachable through this builder, only
`SourceMissing`/`Fresh`/`ExactContentRelocated`/`Stale` are. Documented,
not silently pretended otherwise; widening this is future scope, not a
correctness bug in what it does cover. `evaluate_edge_from_db` is
read-only (only `SELECT`s, safe outside a transaction); persisting a
result through `publish_runtime.rs` is left to its caller --
`dependency-rebuild-derived` (next).

Verified: four new Rust `#[cfg(test)]` unit tests (matching stored/current
token → Fresh, outdated stored token → Stale/RebuildRequired, a deleted
Source → SourceMissing/Manual, an unrecognized source-identity shape →
also SourceMissing), covering every branch of `evaluate_edge` this
builder can currently reach, run through a real `db.migrate()`-shaped
database with a real `tree_nodes` scene row.

**The `dependency-rebuild-derived` orchestrator landed**
(`restore_rebuild.rs`'s `rebuild_narrative_derived_state_for_project`):
discards and recomputes every Rebuildable Derived State row this crate
owns today (`narrative_dependency_edge_states`,
`narrative_consumer_freshness`,
`narrative_maintenance_finding_observations`) from the Durable Graph and
current Source state, for every Consumer in the project — never touching
Domain state or the Durable Dependency declarations
(`narrative_dependency_edges`, `narrative_application_contributions`),
which it only ever reads through `evaluate_edge_from_db`. Same 3-phase
shape as the Backfill bootstrap trigger (reuse-check+create / do the
work / finalize status), for the same reason. Phase 1 creates the Run
(`create_system_run_in_tx`, `run_kind = "semantic-index-rebuild"`, the
existing reused column value, `SystemRunWorkKeyReuse::RunningOnly`
matching the ratified policy exactly) under the project's _existing_
current Semantic Epoch — unlike Backfill, this does not mint one:
Rebuild-Derived recomputes state _from_ a Durable Graph expected to
already exist under a real Epoch, so a project with none yet fails
closed (`NEX_REBUILD_DERIVED_NO_EPOCH`) rather than silently minting
one. Phase 2 evaluates and publishes every distinct
`(consumer_kind, consumer_key)` this project's Edges declare, one
transaction per Consumer, so one Consumer's publish failure does not
roll back every other Consumer already rebuilt in this pass.

`publish_runtime.rs`'s `publish_freshness_evaluation_in_tx` was split
into a new `publish_freshness_evaluation_edges_only_in_tx` core (steps
a-c: write Edge States, write the Consumer's rolled-up Freshness, record
Finding Observations) plus the original function as a thin wrapper
adding steps d-e (complete the Run, acknowledge the Change Feed cursor
reservation) — those two steps belong to the live cursor-triggered
Freshness-evaluation flow only; Rebuild-Derived has no single cursor
reservation to acknowledge and evaluates many Consumers under one Run,
not one Consumer completing that Run as a side effect.

Verified: four new Rust `#[cfg(test)]` unit tests (fails closed with no
epoch, a zero-edge project completes as a true no-op pass, two Consumers
with different Freshness outcomes both get evaluated and published
correctly in one Run, and the `RunningOnly` reuse policy — reused while
genuinely `running`, not reused once `completed`).

**6 of the 13 `dependency-verify` checks landed**
(`restore_rebuild.rs`'s new `verify_narrative_dependency_graph_for_project`
/ `DependencyGraphVerifyReport`): a project-wide diagnostic (every
Consumer, not one Run's own Edges like the pre-existing
`rebuild_verify_dependency_edges`, which predates the Run Kind Policy and
stays as-is for its own narrower callers). Covers: the closest available
match to `producer-and-generation-consistency` (this crate has no
separate Producer "generation" concept yet, only "does the Source still
resolve"), `active-edge-duplicates` (defense-in-depth: the `UNIQUE` index
`record_dependency_edge_in_tx` relies on should make this structurally
impossible through this crate's own writers), `cross-project-edge` (a
`RUN_CONSUMER_KIND` Edge whose Run belongs to a different project — the
one place the project boundary could silently slip, since
`source_object_identity` carries no project scope of its own),
`consumer-and-source-key-format`, `edge-state-belongs-to-current-epoch`,
`finding-observation-belongs-to-current-epoch`. `DependencyGraphVerifyReport::is_clean()`
reports whether all 6 covered checks passed — explicitly not a claim
about the other 7.

Not yet implemented, and not silently treated as passing:
`application-revision-artifact-references`, `dependency-set-digest`/
`consumer-freshness-dependency-set-digest` (nothing writes
`narrative_consumer_freshness.dependency_set_digest`/
`narrative_semantic_index_metadata` yet),
`contribution-to-application-commit-correspondence`,
`legacy-mirror-migration-parity`, `cursor-and-feed-head-consistency`,
`semantic-index-generation-correspondence`.

**Real bug found and fixed while building this**: the previous commit's
`dependency-rebuild-derived` orchestrator passed the _Rebuild Run's own_
`run_id` into `evaluate_edge_from_db` for every Edge, but
`source_revision.rs`'s `resolve_snapshot_document` requires the id
embedded in a `snapshot:<runId>` Source key to match the id passed in
exactly — the _owning Consumer's_ run, not whichever Run is doing the
evaluating. Every `snapshot-document`-sourced Edge a Rebuild-Derived pass
touched would have been misclassified `SourceMissing` (caught internally
by `build_edge_comparison_input`'s own `Err` handling, not a crash, but a
silent misclassification) instead of correctly resolving. Fixed by
passing each Edge's own `consumer_key` instead; a regression test
(`rebuild_derived_state_resolves_a_snapshot_document_source_correctly`)
seeds a real sealed-snapshot Run and Edge and asserts it resolves
`Fresh`, not `SourceMissing`.

Verified: all new SQL (duplicate-key, cross-project, stale-epoch queries)
replayed against real SQLite via Python, plus four new
`project_verify_*` Rust `#[cfg(test)]` unit tests and the snapshot-source
regression test above.

**The `dependency-repair` Run Kind landed** (new module,
`narrative_extraction/repair.rs`): the lease/backup/sealed-plan/execution
machinery the ratified policy's `requiredPreconditions` fix, plus one
real, end-to-end repair category.

Scope, stated up front rather than discovered later: the policy's
`allowedRepairs` names six categories; only `deactivate-duplicate-edge`
is implemented, because it is the _only_ one
`verify_narrative_dependency_graph_for_project`'s current 6-of-13 check
coverage can actually surface — the other five all need Verify checks
this crate does not implement yet
(`contribution-to-application-commit-correspondence`,
`application-revision-artifact-references`,
`legacy-mirror-migration-parity`). There is nothing yet to seal a repair
plan _from_ for those five. The safety machinery below is generic and
does not need to change as more categories are added; only
`seal_repair_plan` needs to grow.

- `claim_repair_lease_in_tx`/`release_repair_lease_in_tx` — CAS over
  `narrative_maintenance_repair_leases` (`PRIMARY KEY(project_id)`, one
  row ever). A live (non-expired) lease for a _different_ plan/owner is
  rejected (`NEX_REPAIR_LEASE_HELD`); the _same_ plan/owner re-claims
  idempotently; an expired lease is freely reclaimed by anyone.
- `seal_repair_plan` — deterministic plan sealing: sorts
  `restore_rebuild::duplicate_edge_ids_to_deactivate`'s output (new —
  for each duplicate-key group, every id except the newest, matching
  `record_dependency_edge_in_tx`'s own "most recent Producer declaration
  wins" semantic) into a canonical JSON shape and digests it
  (`sha256:`-prefixed, via `digest_plan`). `RepairPlan::change_count()`
  is the policy's `change-count-preview`.
- `repair_narrative_dependency_declarations_for_project` — the
  orchestrator, three ordered steps: (1) current-Semantic-Epoch match
  (`NEX_REPAIR_EPOCH_MISMATCH` if the plan was sealed against a
  since-rotated Epoch) + lease claim, one transaction; (2) automatic
  backup (`backup_restore::create_persistent_live_safety_artifact`,
  filesystem I/O, outside any DB transaction — a failure here releases
  the lease just claimed and fails closed rather than proceeding without
  a backup); (3) execute the plan
  (`restore_rebuild::rebuild_repair_dependency_edges_in_tx`, pre-existing
  Wave 2 code — `narrative_dependency_edges` has no soft-delete column,
  so "deactivate" is the same hard `DELETE` that function already
  performs) + release the lease, one transaction; on failure the lease is
  explicitly released again in a fresh transaction (the failed
  transaction's own rollback undoes the in-transaction release too), so
  a failed repair never locks the project out of a corrected retry until
  TTL expiry. `explicit_confirmation: bool` has no default — the caller
  must pass `true`. An empty plan (nothing to repair) short-circuits
  before the lease/backup machinery entirely.

**Real bug caught by Python-replaying the lease CAS logic before
committing**: a first draft of the "rejects a second different plan
while active" test used a fixed near-term expiry
(`2026-08-15T00:15:00Z`) that was already in the past relative to this
sandbox's actual wall clock (`julianday('now')` compares against real
time, not the session's fictional "current date") — the lease read as
already-expired, so the intended rejection silently didn't fire. Fixed
by using a deliberately far-future fixed timestamp
(`2099-01-01T00:00:00Z`) instead of "a few minutes from whenever this
test happens to run."

Verified: the lease CAS logic (first claim, rejected second plan,
idempotent re-claim, expired-lease reclaim) and the
duplicate-edge-detection query replayed against real SQLite via Python,
plus seven new Rust `#[cfg(test)]` unit tests against a real, file-backed
(not `:memory:` — the backup step needs a real file to `VACUUM INTO`)
`db.migrate()`-shaped workspace, covering plan sealing, confirmation
requirement, full execute-and-release, epoch-mismatch rejection, and the
lease CAS behavior end-to-end.

**The five new IPC/N-API operations landed**
(`verifyNarrativeDependencyGraph`/`rebuildNarrativeDerivedState`/
`getNarrativeBackfillStatus`/`retryNarrativeLegacyBackfill`/
`repairNarrativeDependencyDeclarations`), closing out the Run Kind
Policy implementation end to end — every function landed across this
policy's commits is now reachable from the renderer.

Wired via `/add-electron-command`, mirroring the freshest precedent
(C2-T1's Attention/Inbox commands) exactly: all five declared `optional`
on `NapiBackendLike` so a stale `.node` build fails closed with
`IPC_BACKEND_UNAVAILABLE` rather than a raw `TypeError`; each has a
`requireXxxPayload` validator in `ipcContract.ts` rejecting unknown
fields and missing required ones before the native call; each
`#[napi]` fn in `lib.rs` deserializes via `from_wire` into a typed DTO
and calls straight into the shared crate. Required promoting several
Wave 1/2/Run-Kind-Policy functions and types from `pub(crate)` to `pub`
(with matching `pub use` re-exports added in `narrative_extraction`'s
`mod.rs`, alongside the pre-existing `pub(crate)` ones so nothing
already relying on crate-internal-only visibility changed) so
`grimodex-node` — a separate crate — could reach them:
`verify_narrative_dependency_graph_for_project`/
`DependencyGraphVerifyReport`,
`rebuild_narrative_derived_state_for_project`/
`RebuildDerivedStateOutcome`/`RebuildDerivedStateSummary`,
`bootstrap_legacy_dependency_backfill_for_project`/
`get_backfill_status_for_project`/`BackfillStatus`/`BackfillSummary`/
`LegacyBackfillBootstrapOutcome`, `seal_repair_plan`/
`repair_narrative_dependency_declarations_for_project`/`RepairPlan`/
`RepairOutcome`, and `get_current_epoch`/`CurrentEpoch` (needed to
resolve the current Semantic Epoch before sealing a Repair plan).
`DependencyGraphVerifyReport`/`RepairPlan`/`RepairOutcome`/
`BackfillStatus` gained `#[derive(Serialize)]` (`camelCase`) so they
round-trip to the wire directly; `RebuildDerivedStateOutcome`/
`LegacyBackfillBootstrapOutcome` (enums with differently-shaped
variants) are converted to JSON by hand in `lib.rs` instead.

`repairNarrativeDependencyDeclarations` folds the preview/apply
two-step into one command rather than two separate IPC names (no
`dryRun` precedent existed in this codebase to follow instead):
`apply: false` (the default) seals and returns a plan preview;
`apply: true` requires `planDigest` (must match the digest a preview
call just returned — binds the confirmation to the exact plan a human
saw, rejected as `NEX_REPAIR_PLAN_DIGEST_MISMATCH` if the Durable Graph
changed in between) and `leaseOwner`, both validated as required by the
TypeScript validator once `apply` is `true`, then re-checked as typed
`NEX_REPAIR_*` errors on the Rust side too (defense in depth, not
trust-the-frontend). The workspace path Repair's automatic backup needs
is never accepted from the renderer — re-derived server-side via
`active_workspace_path(&state.ws)`, matching this codebase's existing
`restore_backup`/`get_active_workspace_path` convention (a
renderer-supplied path is used elsewhere in this codebase only as an
optimistic-concurrency guard, never trusted as the real filesystem
target).

**Also fixed while wiring this**: `NAPI_COMMANDS`' own sorted-keys
coverage test (`ipcContract.test.ts`) was already failing on this
checkout before this commit — the three C2-T1 Attention/Inbox command
names were registered in `NAPI_COMMANDS` but never added to that test's
literal array. Confirmed by running the test before touching anything;
fixed alongside adding this change's own five names, rather than left
to compound further.

Verified: `pnpm exec tsc -p electron/tsconfig.json --noEmit` and the
root `npx tsc --noEmit` both clean; `pnpm test:electron --run` — all
1035 tests across 46 files pass, including 11 new tests for these five
commands (happy path plus malformed-payload/backend-unavailable/
method-unavailable/domain-error-propagation coverage, mirroring the
`narrative_runtime_policy_set` test block) and the two fixed coverage-
list entries; all narrative quality validators still pass; `rustfmt`
clean on every touched Rust file. Same toolchain caveat as every Rust
change this session: `cargo check`/`napi build` cannot run in this
sandbox, so `index.d.ts` was not regenerated and the compiled `.node`
addon does not yet contain these five methods (or the three C2-T1 ones
before them) — inspection plus the TypeScript-side contract tests above
is the best available verification until a working toolchain runs
`napi build`.

This closes every task the ratified Run Kind Policy
(`narrative-run-kind-policy.json`) originally scoped as
not-yet-implemented. Remaining, explicitly out of scope for this pass
and documented at each landing commit above: 7 of the 13
`dependency-verify` checks, five of the six `dependency-repair`
`allowedRepairs` categories (both blocked on Verify checks this crate
does not implement yet), and the crash-recovery gap for a Run stuck
`running` after a terminated process (a Lane B / execution-state-model
concern spanning every Run Kind, not specific to any one of these).

## C2-2 Consumer contract and the Proposal Revision grain

`policies/narrative/narrative-consumer-contract.json` (schema:
`schemas/narrative-consumer-contract.schema.json`, validated by
`scripts/quality/validate-semantic-core-boundary.mjs`'s `schemaContracts`
list, `pnpm test:narrative:semantic-contract`) fixes the first C2-2
deliverable — the canonical `(consumer_kind, consumer_key)` vocabulary —
so the remaining three (Producer-time declaration at the smallest safe
durable unit, Backfill re-keying, reverse lookup) have one registry to be
written against instead of each inventing its own literals. The
per-Consumer dependency digest landed alongside it; see below.

`narrative_extraction/consumer_identity.rs` is the Rust counterpart, and
it is deliberately the _only_ place the pair means anything: a fail-closed
`ConsumerKind`, the `RUN_CONSUMER_KIND` literal (moved there from
`dependency_edges.rs`, which re-exports it), `validate_consumer_identity`
for the shape rules SQLite cannot express, the single
`consumer_finding_key`, and `owning_run_id_for_consumer` — the one seam
that answers "which Run is this Consumer's `snapshot:<runId>` Source
expected to name?". That seam is why the vocabulary landed before any
Producer moved off Run grain: `restore_rebuild.rs` had been passing
`consumer_key` straight through as a `run_id`, and because
`build_edge_comparison_input` collapses every resolver error into
`current_source_exists = false`, a Consumer that stopped being a Run would
have reported `source-missing` for Sources that are present rather than
raising anything.

Every Consumer kind carries a `status` that says what is true today, not
what is planned:

- **`declared`** — a production Producer writes Edges under it now. There
  are three. `proposal-revision` (`consumer_key =
narrative_proposal_revisions.id`) is what `repository.rs` declares every
  Edge under: the grain C2-2 exists to reach, where editing one Scene stales
  the Revisions that actually read it rather than every Proposal from the
  same Run. `narrative-extraction-run` stays declared and is not a legacy
  value — a Run remains a legitimate Consumer of its own Run-wide Sources.
  `application` (`narrative_proposal_applications.id`) is declared by the v3
  Legacy Backfill writer; each such Edge carries the fresh Backfill Run in
  `owning_run_id`.
- **`reserved`** — the roadmap's Consumer class already has a durable row
  that could carry its identity, but nothing declares Edges under it yet:
  `extraction-artifact` (`narrative_extraction_artifacts.id`),
  `application-contribution` (`narrative_application_contributions.id`),
  `derived-projection` (`narrative_temporal_projections.id` — the one
  Projection this codebase recomputes rather than applies directly), and
  `semantic-index` (`narrative_semantic_index_metadata.index_key`; only
  `index_key`, because `narrative_consumer_freshness` already carries
  `project_id` as its own column and a Consumer key must never repeat the
  project scope).
- **`not-yet-modelled`** — the roadmap asks for it and there is no durable
  table to key it from: `narrative-ir-revision` (Interpreter output lives
  inside `payload_json`/`reconciliation_envelope_json`, never as its own
  addressable row), `related-scenes-materialization` and
  `chat-context-materialization` (both computed per query and kept
  nowhere), and `structure-health-diagnostic` (still the Gate C0
  placeholder panel). Each entry says so in its own `notes` rather than
  being quietly omitted: deriving a key for one of these from payload
  content would be exactly the heuristic identity C2-2's exit criteria
  forbid.

`keyFormat` fixes `finding_key = "{consumerKind}:{consumerKey}"` with
`findingKeyParseRule: "split-on-first-colon"` — the shape
`publish_runtime.rs` and `inbox_read_model.rs` already have to agree on
(Lane P caught them disagreeing once, which made every diagnostic Finding
Observation invisible to the Maintenance Inbox). A `consumerKind` may not
contain a colon so the first one is an unambiguous separator; a
`consumerKey` may, because a durable identity can legitimately be a
compound key. Both components forbid the empty string and surrounding
whitespace, since either would let two different Consumers collide on one
`finding_key`.

`freshnessAuthority` restates, in Consumer terms, what
`semantic-core-authorities.json` already fixes: `narrative_consumer_freshness`'s
`(project_id, consumer_kind, consumer_key)` is the one canonical Consumer
Freshness authority and `narrative_projection_freshness` — keyed by
`application_id` alone, so structurally unable to express any other
Consumer kind — is compatibility-only. Before the C2-Z marker it remains the
legacy compatibility read path; after the marker canonical reads use Generic
Consumer Freshness only. In both states it is a mirror, not a second
authority. `dependencySetDigest` fixes
`narrative_consumer_freshness.dependency_set_digest` as a digest over the
set of `source_object_identity` values declared under the Consumer, and
records that `NULL` means "not evaluated since SCHEMA 24 added the
column", never "inconsistent". Verify reports that state separately as
incomplete evidence; it does not disappear into a clean result.

That column now has a writer and a check. Publishing a Freshness
evaluation stamps the digest, and
`verify_narrative_dependency_graph_for_project` gained
`consumer-freshness-dependency-set-digest` — the "is this Consumer still
reading the same things?" question no per-Edge Freshness value can answer,
since a Consumer that stopped depending on a Source has no Edge left to go
stale. Verify coverage is therefore **7 of the 13 named checks**, not 6.
The Semantic Index half of
`dependency-set-digest` is still unimplemented — nothing writes
`narrative_semantic_index_metadata` yet.

Gate C2-2 originally moved `VERIFY_CONTRACT_VERSION` to `"3"` rather than
`"2"` because the report gained three fields in one Gate, not one:
`consumer_keys_with_stale_dependency_set_digest`,
`edge_ids_with_unresolvable_consumer_scope`, and
`orphaned_attention_finding_keys`. `"2"` existed only mid-branch and was
never released.

The current version is `"5"`. It adds the required
`orphaned_attention_rehome_ambiguities` field, which reports every preserved
Attention row for which the material-digest → Observation → Edge mapping was
zero, ambiguous, or collided with an existing target. It also reports
`legacy-identity-unresolved` Attention rows whose old history cannot prove a
stable Edge identity; those rows remain durable but are never considered
applicable by the Inbox. A stored version-`"4"` result lacks this field and
must not be accepted as the new report shape: the workspace must re-run
Verify under contract version 5 before Repair can be sealed.

Attention application additionally requires `finding-identity-resolved`.
Matching the finding key and material-basis digest is insufficient when a
legacy disposition has no provable Edge subject.

The `keyFormat` shape rules are enforced by the typed writers
(`record_dependency_edge_in_tx` and `write_consumer_freshness_in_tx` both
call `validate_consumer_identity`). Registry _membership_ is reported
rather than refused: `ConsumerKind::try_from` fails closed, and Verify
lists Edges under an unregistered kind as
`edge_ids_with_unresolvable_consumer_scope` — deliberately not as
`edge_ids_with_missing_source`, whose Sources are present.
`narrative_dependency_edges.consumer_kind` still carries only a
`length > 0` CHECK at the SQL layer, and the writer still accepts a
reserved kind, which is intentional while those kinds have no readers.
Refusing at the writer is the remaining piece; re-keying the live Producer
off `narrative-extraction-run` is done, and is what SCHEMA 30 below
carries.

The registry is guarded from both sides, because neither side can see the
other's language. `validate-semantic-core-boundary.mjs`'s
`validateConsumerContract` catches what a JSON Schema cannot express — one
`kind` registered twice with contradictory `status` values (`uniqueItems`
only compares whole entries), the loss of the last `declared` entry, and a
`durableIdentitySource` naming a table `migrate.rs` never creates. From
Rust, `consumer_identity.rs` reads this file with `include_str!` (the same
way `protected_writers.rs` reads its own policy) and fails if the
`declared` set and `ConsumerKind` stop naming the same kinds, or if a
`reserved` kind starts being accepted. Renaming the literal on either side
now breaks a test rather than silently splitting the vocabulary in two.

### SCHEMA 30: `owning_run_id`, the re-key, and one atomic block

`narrative_dependency_edges` gained `owning_run_id` — the Run that
declared the Edge — because `owning_run_id_for_consumer` cannot answer
"which Run is this Edge's `snapshot:<runId>` Source expected to name?"
from `consumer_kind` once a Consumer is a Revision. Storing it per Edge
rather than deriving it through `narrative_proposal_revisions →
narrative_proposals → narrative_proposal_sets.run_id` is the same choice
SCHEMA 29 made for Contribution provenance: it is a _provenance_ fact, so
it stays true after the Proposal it came from is deleted. Rows whose
declaring Run cannot be identified keep `NULL` rather than being given a
wrong one.

For a `proposal-revision` Edge, current Producers can always identify that
Run. The writer therefore requires `owning_run_id` to be nonblank and to
name a persisted Run in the same project for every Source kind, not only
`snapshot-document`. Verify applies the same rule to historical/corrupt
rows; Rebuild publishes `unknown` and skips Source evaluation when the
provenance is absent, dangling, or cross-project. Run Consumers retain their
compatibility fallback from `consumer_key` for older rows.

The re-key reads its finer attribution out of
`narrative_revision_source_basis`, which already records, per Revision,
the `(source_kind, source_key, revision_token)` it read. So each Revision
takes exactly the reads its own basis names — no cross-run identity is
invented, which is what C2-2's exit criteria forbid.

Three cases the re-key deliberately does **not** collapse:

- **An Edge with no Source Basis is re-keyed only from exact durable
  Application lineage.** The SCHEMA 32 C2-ZB migration matches
  `Application -> ApplyCommit.run_id -> projection dependency` to the old
  `(Run, Source)` Edge. It refuses unattributed or ambiguous evidence and
  preserves the Edge identity/history when an exact target exists; a fan-out
  without Finding history creates every candidate Application Edge.
- **Durable Attention is re-homed only with exact Finding identity.** The
  historical C2-2 Revision re-key remained conservative when a Run-grained
  Attention could not identify one Revision. SCHEMA 32 C2-ZB now handles the
  separate Legacy Backfill boundary: an old Run Attention moves to the exact
  Application finding key only when its stable identity (or a uniquely mapped
  NULL identity) names one exact old Edge. The migration updates only
  `finding_key`, preserving disposition, identity status, digests, version,
  and all other human fields. Fan-out with history, NULL/ambiguous identity,
  or a conflicting target fails closed; no Attention is broadened to multiple
  Applications. The re-key is precondition evidence for C2-ZC; after its
  durable marker, Generic Consumer Freshness is canonical and this historical
  re-key data remains compatibility evidence only.

Freshness decided against the old Consumer identity _is_ discarded, since
a verdict reached about `(run, sources)` is not a verdict about
`(revision, sources)`; Rebuild-Derived recomputes it.

**The whole Gate C2 step runs inside one savepoint.** `migrate_impl` is
otherwise autocommit, and the block both destroys (three unconditional
DELETEs of derived state, a `DROP`+`RENAME` rebuild, the Run-Edge delete)
and refuses (the SCHEMA 29 rebuild fails closed on an orphaned
Contribution). Without the savepoint, a workspace that cannot complete the
upgrade would still have paid the discard — leaving Consumer Freshness,
the durable Freshness authority, empty on a database nothing can rebuild
until a human repairs the orphan. Two `migrate.rs` tests hold the
invariant from both ends: a refused upgrade and an interrupted one must
each leave every derived table exactly as it was, and the interrupted one
must still upgrade cleanly on the next open.

### An unevaluated Edge is `unknown`, never absent

`worst_edge_state_for_consumer` rolls up the Consumer's Edge States at the
current Semantic Epoch. It used to `JOIN`, so an Edge with no state at
this epoch — which is precisely what C2-1's partial, Change-Feed-driven
publish produces — simply left the rollup. A Consumer could then be
published `fresh` while `dependency_set_digest`, computed over _all_ its
declared Edges, asserted the verdict covered every one of them.

It now `LEFT JOIN`s and treats a missing state as
`EvidenceFreshness::Unknown` with `BuildAction::Manual` and no reason
code. `Unknown` outranks everything except `SourceMissing` in the severity
order, so an unevaluated Edge cannot be quietly outvoted by a fresh one:
"we have not looked at this yet" is reported as the honest answer rather
than absorbed into a clean one.

Wave 2 landed Lanes I (`cursor_reservation.rs`), J (`publish_runtime.rs`),
K (`legacy_backfill.rs`), L (`semantic-state-vocabulary.json`
`contributionTargetStates`/`maintenanceOwnershipStates`), M
(`semantic_index_diagnostics.rs`), N (`restore_rebuild.rs`), O
(`inbox_read_model.rs`), and P
(`tests/narrative_semantic_build_graph_adversarial.rs`, cross-Lane
adversarial coverage). Lane P found and the Integration Owner fixed two
real cross-Lane bugs before they could reach C2-T1: a SQL three-valued-logic
gap in the `narrative_extraction_attempts` `next_attempt_at`/
`retry_disposition` CHECK constraint (a `NULL` disposition silently bypassed
it), and a `finding_key` convention mismatch between Lane J's writer and
Lane O's reader that made every real diagnostic Finding Observation
invisible to the Inbox. Both are now regression-tested.

The earlier C2 lane's environment-specific Rust toolchain block is historical,
not a current dependency for C2-1 or C2-T1. Current implementation evidence is
the production and fixture paths recorded in the status section above.

Wave 1 landed 7 new core Rust modules under
`src-tauri/crates/grimodex-db/src/narrative_extraction/` — Lane A
`semantic_epoch.rs`, Lane B `execution_state.rs` (also adds `"superseded"`
to the TS `NarrativeExtractionRunStatus` union), Lane C
`finding_observation.rs`, Lane D `attention.rs`, Lane E extends
`source_revision.rs` with lazy canonical-text access, Lane F
`evaluator.rs`, Lane G `dependency_edges.rs`, Lane H
`application_contributions.rs`. None of them have an IPC/N-API entrypoint
yet — that is C2-T1's job — so every export is currently reachable only
from its own module's tests (`#[allow(unused_imports)]` on the `mod.rs`
re-exports documents that intentionally). Lane C and Lane F independently
defined the same `EvidenceFreshness`/`FindingReasonCode` pair in parallel;
the Integration Owner collapsed it to a single definition in
`evaluator.rs` during merge, with `finding_observation.rs` importing it.

C2-01 bumps the workspace schema 22→23 and adds, per ADR 005's C2 scope
list only:

- `narrative_semantic_epochs`, `narrative_dependency_edges`,
  `narrative_dependency_edge_states`, `narrative_consumer_freshness`
  (the one durable Freshness authority),
  `narrative_application_contributions`,
  `narrative_maintenance_finding_observations` (epoch-bound rebuildable
  diagnostic history), and `narrative_maintenance_attention` (durable,
  non-epoch-bound, no-backflow, typed-writer-only).
- New `narrative_extraction_runs` columns (`run_kind`, `consumer_id`,
  `semantic_epoch_id`, `work_key`, `terminal_reason_code`,
  `superseded_by_run_id`) and entity-owned SQL `CHECK` constraints on
  Run/Task/Attempt `status`, replacing the previously unconstrained shared
  `status TEXT` column — matching
  `narrative-execution-state.json`. Legacy `failed` Attempts are normalized
  to `NEX_LEGACY_UNCLASSIFIED`/`terminal`/`legacy`; any other unrecognized
  status fails the migration closed instead of silently coercing.
- New `narrative_extraction_attempts` typed-failure columns
  (`failure_code`, `retry_disposition`, `policy_version`,
  `next_attempt_at`), with `next_attempt_at` constrained to only be set
  when `retry_disposition = 'retryable'`.
- `narrative_change_cursors` reservation columns (`semantic_epoch_id`,
  `reserved_through_sequence`, `active_run_id`) — the same existing
  Change-Feed-consumer-cursor table, not a new Run cursor concept; NULL for
  pre-C2 consumers.
- `workspace_schema.rs`'s `has_current_schema_checkpoint_invariants` gates
  on all of the above so a partially-migrated database cannot look
  current.

Historical verification note: the original C2-00 landing used a sandbox
where the Rust toolchain could not build
`libsqlite3-sys` (`cfg_select` unstable-feature error, pre-existing and
reproducible on an unmodified checkout), so `cargo check`/`cargo test`
could not run here. Every `CREATE TABLE`/rebuild statement was instead
extracted verbatim and executed against real SQLite (Python's bundled
`sqlite3`) to confirm the DDL is valid, the rebuild preserves row counts,
legacy-attempt normalization behaves as specified, and every `CHECK`
constraint accepts/rejects exactly the cases above — including a
byte-for-byte cross-check of the `workspace_schema.rs` invariant
substrings against real `sqlite_master.sql` output. `src/db/schema.ts`
type-checks cleanly (`npx tsc --noEmit`, 0 errors). The current branch has
since rerun the focused Rust migration/schema suites and the
`workspace_schema.rs` checkpoint checks. The canonical generator has also
regenerated `src/db/generated/schema-contract.json` at `schemaVersion: 33`;
the artifact is not intentionally stale.

C2-00 added, on top of the existing C1.5 contracts:

- `narrative-execution-state.json` — Run/Task/Attempt each own a separate
  status vocabulary and derived phase/outcome view; no entity shares another
  entity's enum or SQL CHECK constraint.
- `narrative-failure-policy.json` — every C2 failure code is `NEX_`-prefixed
  and carries a `retryDisposition`, `maxAttempts`, `backoffPolicy`,
  `nextAttemptPolicy`, and `policyVersion`; `nextAttemptPolicy` is `"none"`
  if and only if `retryDisposition` is not `"retryable"`. C2-5B additionally
  freezes an exact `findingRoutingMatrix`: manual contract, unclassified, and
  recovery-selector verdicts route to the Maintenance Inbox, while
  `NEX_MAINTENANCE_TRANSIENT` and `NEX_MAINTENANCE_INTERRUPTED` must not
  create Findings.

The C2-5B registrations bind the maintenance lifecycle and Finding routes;
they do not claim completion of deferred Heavy work or any broader runtime
activation. A transient classification permits at most three bounded Attempts
and requeues the same sealed system work; an interrupted classification is
retryable with at most three bounded Attempts and uses
`nextAttemptPolicy: "requeue-new-run-same-sealed-system-work"` after startup
terminalizes the old Run/Task/Attempt; a contract violation is manual-only with
`maxAttempts: 0` and no automatic retry. The `next_attempt_at` retryable-only
invariant remains independent of JavaScript transport retry, and this policy
does not claim runtime activation.
- `narrative-finding-contract.json` — the Finding `reasonCode` registry
  (`fail-closed` on unknown codes) plus the Finding Observation durability
  contract: `rebuildable-derived-state`, epoch-bound, diagnostic-only
  snapshot, current Freshness always read from
  `narrative-consumer-freshness`, never from an Observation row.
- `maintenance-attention-contract.json` — the Attention durability contract:
  `durable-user-state`, not epoch-bound, `backflowPolicy: "forbid"`, written
  only by the Attention typed writer.
- Two new `semantic-core-authorities.json` concerns —
  `maintenance-finding-observation` and `maintenance-attention` — using the
  existing four-field authority-matrix shape (`concern` /
  `canonicalAuthority` / `compatibilityMirror` / `writePolicy`). The matrix's
  `schemaVersion` stays `1`; the durability/epoch dimensions the two new
  concerns need live in the finding/attention contract files above, not as
  new fields bolted onto the C1.5-ratified matrix schema.
- `change-feed-writers.json` gained `operationFragments`
  (`policies/narrative/change-feed-operations/*.json`) and a new
  `non-backflow-invariant` exclusion reason, so each Wave lane owns one
  fragment file instead of editing the ~4500-line root manifest directly.
  A fragment operation must land `coverageStatus: "verified"`; there is no
  interim `"declared"` state for a C2 operation on `master`.
- `scripts/quality/validate-execution-state-authority.mjs`
  (`pnpm test:narrative:execution-state`) checks these four contracts'
  internal consistency, their linkage back into
  `semantic-core-authorities.json`, that ADR 005's C2 start-condition
  checklist is still present and `fixed`, and that the new status
  vocabulary is a superset of the existing
  `NarrativeExtractionRunStatus`/`Task`/`AttemptStatus` TypeScript unions.
  It does not assert that a Rust status enum or SQL CHECK constraint exists
  yet — C2-01 adds the SQL CHECK, Lane B adds the Rust enum and transition
  functions, and C2-T1 adds the stricter cross-artifact parity check.
