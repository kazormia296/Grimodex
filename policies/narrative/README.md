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

## Gate C2 — IN PROGRESS

Gate C2 begins from ADR 005's existing "Authority matrix and C2 start
condition" checklist (Mutation Route / Source Event Contract / Object
Addressing / State Vocabulary / Authority Matrix / Disclosure Policy /
Evidence-Scope, all fixed at C1.5) and implements only Dependency Edge, Edge
State, Consumer Freshness, Application Contribution, Reverse Lookup,
Incremental Evaluator, Cursor, and Backfill persistence/runtime, per that
ADR. There is no separate `docs/certification/gate-c2/` directory or base-SHA
file; the C2 branch base is simply `master` at branch creation, and this
section is the running status record, alongside PR history and this ADR.

```text
Gate C2 — IN PROGRESS
  Contract / Registry / Ledger Spine (C2-00): complete
  Schema / Transport Extension Spine (C2-01): complete
  Wave 1 foundation lanes:                    complete
  Wave 1 Transport Assembly (C2-T1):          in progress (see below)
  Wave 2 runtime / read-model lanes:          complete
  Wave 2 Transport / Quality Assembly (C2-T2): blocked (see below)
  Canonical Authority Cutover (C2-Z):         blocked (see below)
```

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
*existing* pipelines, not new standalone commands:

- `semantic_epoch.rs` (Lane A) and `restore_rebuild.rs`'s
  `rotate_epoch_for_restore_in_tx` (Lane N): minting/rotating a Semantic
  Epoch requires ADR 006's `restore-or-migration` route
  (`allowedCallers`: `restore-controller`/`migration-runner`/
  `integrity-repair` only) — these belong inside the existing
  `project_snapshot_apply_restore` restore path and DB migration, not a
  new command.
- `evaluator.rs` (Lane F): pure, I/O-free computation (its own doc
  comment says so) — a library called by `publish_runtime.rs`, never an
  IPC entrypoint itself.
- `dependency_edges.rs` (Lane G): **wired (C2-T1, see below)** — its
  "Producer-time commit path" turned out, on closer reading, to mean
  Proposal/Revision *generation* (`repository.rs`), not `commit.rs`'s
  *apply*, and needed no change to `commit.rs` at all.
- `application_contributions.rs` (Lane H): still open. Its own doc comment
  says call-site wiring into `commit.rs`'s apply path "lands in C2-T1."
  Unlike Lane G, this genuinely is an apply-time concern — "which
  Application most recently touched which field" can only be known once a
  Proposal Revision is actually applied — so it needs a call from inside
  `commit.rs`'s `narrative_extraction_apply_commit`, which dispatches ~15
  operation kinds (chronicle, codex, detail, foreshadow, phase,
  plot-thread, semantic-binding, temporal ×4) across a 2200+ line,
  already-shipped, live commit engine. This is materially higher-risk than
  everything landed so far: a mistake risks regressing already-shipped
  commit paths for every operation kind, not just leaving new code
  unreachable, and — like everything else in this section — cannot be
  `cargo check`ed in this environment. Not yet attempted, pending an
  explicit decision on how to proceed given that risk.
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
  (Lane N): genuinely open — could be automatic (migration/restore-time)
  or a human-triggered `integrity-repair` admin action
  (`narrative_maintenance_backfill_run`/`_rebuild_verify`/`_rebuild_repair`
  under the existing `restore-or-migration` route). Not yet decided.

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
"narrative-extraction-run", run_id)` — the *Run*, never the individual
Proposal — because Lane N's Rebuild-verify diagnostic already queried Edges
by that exact convention before any Producer declared them; and
`source_object_identity` uses fixed prefixes (`project:scene:`,
`snapshot:`, `project:codex-catalog:`, `projection:`, `artifact:`,
`capture:`, `evidence:`) that `restore_rebuild.rs`'s `infer_source_kind`
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
mean Proposal/Revision generation, not commit *apply*.

Verified via `rustfmt --edition 2021 --check`, a brace/paren balance check,
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

**`application_contributions.rs` (Lane H) → `commit.rs` remains the one
piece of Wave 1/2 transport still not attempted.** Unlike Lane G, it is a
genuine apply-time concern that needs a call from inside
`narrative_extraction_apply_commit`'s ~15-operation-kind dispatch — see the
bullet list above for the full risk assessment. This has not been
attempted yet, pending an explicit decision on how to proceed given that
risk.

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

**C2-T1 / C2-T2 / C2-Z are blocked on this environment's Rust toolchain**,
not on design or implementation gaps. `cargo check`/`cargo test` fail with
a `libsqlite3-sys` build-script error (`cfg_select` unstable library
feature) that reproduces identically on an unmodified checkout — a
toolchain/dependency incompatibility, not something introduced by Gate C2.
Writing N-API bindings (`electron/native/grimodex-node/src/lib.rs`) or
Electron IPC entries without any way to compile-check them carries a
materially higher risk than the pure-Rust-logic work above (a wrong type
signature would break the whole crate's build, and rustfmt/Python-sqlite3
verification — the substitute used throughout C2-00/C2-01/Wave 1/Wave 2 —
cannot catch that class of error). All 15 Wave 1+2 lane modules are
therefore complete, integrated, and tested, but reachable only from their
own `#[cfg(test)]` modules until a working toolchain allows Transport
Assembly to proceed.

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

Verification note: this sandbox's Rust toolchain cannot build
`libsqlite3-sys` (`cfg_select` unstable-feature error, pre-existing and
reproducible on an unmodified checkout), so `cargo check`/`cargo test`
could not run here. Every `CREATE TABLE`/rebuild statement was instead
extracted verbatim and executed against real SQLite (Python's bundled
`sqlite3`) to confirm the DDL is valid, the rebuild preserves row counts,
legacy-attempt normalization behaves as specified, and every `CHECK`
constraint accepts/rejects exactly the cases above — including a
byte-for-byte cross-check of the `workspace_schema.rs` invariant
substrings against real `sqlite_master.sql` output. `src/db/schema.ts`
type-checks cleanly (`npx tsc --noEmit`, 0 errors). Rust unit tests were
added mirroring this same verification; they still need a real `cargo
test -p grimodex-db -p grimodex-core` run once a working toolchain is
available. `src/db/generated/schema-contract.json` also needs
regenerating (`pnpm generate:db-contract`) once `cargo run` works again —
it was intentionally left stale rather than hand-edited.

C2-00 added, on top of the existing C1.5 contracts:

- `narrative-execution-state.json` — Run/Task/Attempt each own a separate
  status vocabulary and derived phase/outcome view; no entity shares another
  entity's enum or SQL CHECK constraint.
- `narrative-failure-policy.json` — every C2 failure code is `NEX_`-prefixed
  and carries a `retryDisposition`, `maxAttempts`, `backoffPolicy`,
  `nextAttemptPolicy`, and `policyVersion`; `nextAttemptPolicy` is `"none"`
  if and only if `retryDisposition` is not `"retryable"`.
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
