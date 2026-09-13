# Narrative Semantic Core / Living Story Bible Roadmap

## Status

- **Lifecycle:** Active mutable roadmap
- **Last updated:** 2026-09-13
- **Current focus:** NIR-1 First Retrieval Vertical Slice; #572 is merged on `master@68516b033f395f24f98c502c9fd2a715d7aec2af` (Tree `04c491c29627ecc840112ebe379a5363e16892ff`) with the typed foundational runtime. R0 merged five proposal/3 contract rows (proposal scope only). PR #579 records the sixth proposal/4 Option B Entity／Relation-only assertion family `typed-revision-material`; the exact user confirmation makes this row explicitly ratified and effective as a contract. The exact ref `nir1-l6-l9-contract-proposal/4#typed-revision-material`, user confirmation, and A2 dependency on A1＋D2a are recorded in the execution-plan ledger. These records do not complete the downstream threat model or activate any runtime or consumer. Production runtime integration/activation and L6-L9 acceptance remain incomplete; the standalone PR-P performance gate is resolved and only Graph-integrated recheck pending/Hold remains.
- **North star:** **本文に追従し、根拠を示し、人間の修正を覚える Living Story Bible**

This document is the canonical **mutable implementation and product roadmap** for Narrative Semantic Core, AI-assisted extraction, incremental maintenance, and the Living Story Bible product surface.

It does not replace architectural decisions or machine-readable policy:

- [ADR 004: Narrative Reconciliation Boundary](../adr/004-narrative-reconciliation-boundary.md) owns semantic assessment, deterministic-core limits, and semantic retraction boundaries.
- [ADR 005: Narrative Semantic Core Boundary](../adr/005-narrative-semantic-core-boundary.md) owns the bounded context, Narrative IR, Semantic Build Graph, Retrieval Engine, and adoption principles.
- [ADR 006: Narrative Mutation Origin and Authority Routes](../adr/006-narrative-mutation-authority-routes.md) owns mutation authority routes.
- [ADR 009: Narrative Scope Relation Contract](../adr/009-narrative-scope-relation-contract.md) owns Scope V2, Scope Relation, capability status, and the independent Scope Disclosure adoption track.
- [ADR 010: Narrative Dependency Role Granularity Contract](../adr/010-narrative-dependency-role-granularity-contract.md) owns Context Set, Dependency Set, Dependency Roles, Selectors, and V1/V2 priority.
- [ADR 011: Narrative IR Revision Semantics Contract](../adr/011-narrative-ir-revision-semantics-contract.md) owns the NIR-0 shared revision semantics.
- [`policies/narrative/`](../../policies/narrative/) owns machine-readable runtime contracts and the current Gate C2 status record.
- Merged pull requests are implementation evidence. Pull request descriptions and chat history are not the roadmap authority.

When this roadmap conflicts with an accepted ADR or validated policy, the ADR or policy wins. A change that alters an architectural invariant requires an ADR amendment before this roadmap is updated to depend on it.

## Product principles

1. The manuscript and explicit author declarations remain primary Sources. Narrative IR never replaces the prose.
2. AI is an Interpretation Producer, not a mutation authority.
3. Review state, Evidence Freshness, and Projection Application state remain separate axes.
4. Source changes may mark dependent Consumers stale or rebuild-required, but may not automatically retract, merge, split, delete, or Apply semantic data.
5. A correction made by the author must become a durable asset and be reusable by later extraction, retrieval, and review.
6. Incremental work must be limited to affected Sources and Consumers; the default must not be a full-project reread.
7. Every semantic result must lead back to Evidence, or explicitly state that Evidence is absent.
8. Raw Text lexical and dense retrieval remain canonical participants alongside Narrative IR and graph retrieval.
9. Human-authored or human-taken-over fields may receive Proposals, but AI may not silently reclaim maintenance ownership.
10. Product surfaces must describe uncertainty honestly. `accepted`, `fresh`, `applied`, and `true` are not synonyms.

## Status legend

| State        | Meaning                                                                           |
| ------------ | --------------------------------------------------------------------------------- |
| **Complete** | Merged implementation satisfies the stated acceptance criteria.                   |
| **Active**   | A concrete branch or pull request is currently implementing the item.             |
| **Partial**  | Earlier lanes are complete, but later lanes or overall acceptance remain open.    |
| **Planned**  | Ordered and scoped here, but implementation has not started.                      |
| **Blocked**  | The item is defined but cannot start safely until a named dependency is complete. |
| **Deferred** | Intentionally outside the current critical path.                                  |

## Current snapshot

| Area                               | State                    | Evidence / next condition                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate B2, C0, C1, C1.5              | **Complete**             | Writer authority, Change Feed, semantic contracts, and authority routes are ratified.                                                                                                                                                                                                                                                                                                                                                                                               |
| Gate C2 foundation                 | **Complete**             | [PR #534](https://github.com/kazormia296/Grimodex/pull/534) landed the shadow Semantic Build Graph, evaluator, publish runtime, maintenance ledger, Verify/Rebuild/Backfill/Repair primitives, and policy contracts.                                                                                                                                                                                                                                                                |
| NIR-0 C2B / Chronicle add-only     | **Complete — NIR0-CERT** | [PR #559](https://github.com/kazormia296/Grimodex/pull/559) supplied the clean candidate-bound Quick/Full receipts and merged the tested tree for ScopeOverride atomic materialization, live Scope authority, Chronicle V2 coordinator/save, C2B Human writer, activation policy, restart durability, and the focused negative matrix.                                                                                                                                              |
| C2 identity normalization          | **Complete**             | [PR #535](https://github.com/kazormia296/Grimodex/pull/535) canonicalized Dependency Edge and Application Contribution identities and repaired stored rows.                                                                                                                                                                                                                                                                                                                         |
| Application Contribution ownership | **Complete**             | [PR #536](https://github.com/kazormia296/Grimodex/pull/536) landed C2 item 4: Contribution provenance, canonical target identities with the SCHEMA rewrite migration, and one-way human ownership behind typed writers.                                                                                                                                                                                                                                                             |
| C2-2 Consumer granularity          | **Complete**             | Producers declare Edges per Proposal Revision, the canonical vocabulary is ratified in [`policies/narrative/narrative-consumer-contract.json`](../../policies/narrative/narrative-consumer-contract.json), SCHEMA 30 records each Edge's declaring Run, and existing Run-grained Edges are re-keyed from the durable per-Revision Source Basis.                                                                                                                                     |
| C2-1 incremental Freshness runtime | **Complete**             | [`incremental_freshness.rs`](../../src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs) owns the bounded Feed range, reverse lookup, evaluation, atomic multi-Consumer publication, replay/recovery, and single acknowledgement; [`narrativeFreshness.ts`](../../electron/main/narrativeFreshness.ts) supplies the main-only single-flight scheduler.                                                                                                    |
| C2-3 Finding identity              | **Complete**             | SCHEMA 31, the versioned Rule Registry, three-layer Finding identity, lifecycle classification, fail-closed Attention re-homing, and later lifecycle hardening are merged through PR #556 and PR #559.                                                                                                                                                                                                                                                                              |
| C2-5A lifecycle foundation         | **Complete**             | Trigger planning, coalescing, per-project serialization, epoch-aware interrupted-run recovery, bounded retry, and execute-safe scheduling are merged and covered by the joined C2-5B suites.                                                                                                                                                                                                                                                                                        |
| C2-5B contract-aware activation    | **Complete**             | Durable Backfill/Verify/Rebuild lifecycle ownership, current-contract evidence, bounded recovery, live-authority dispatch, Maintenance Inbox routing, and product journeys are merged through PR #556 and PR #559.                                                                                                                                                                                                                                                                  |
| C2-ZA cutover preparation          | **Complete**             | SELECT-only legacy/Generic parity measurement, fail-closed per-workspace readiness, and `application` re-key dry-run classification are merged without changing the canonical read authority.                                                                                                                                                                                                                                                                                       |
| C2-ZB Application re-key migration | **Complete**             | SCHEMA 32 performs the schema-owned, all-project preflighted Application re-key, Finding/Attention re-home, derived invalidation, migration Epoch, and final marker atomically. PR #559 closed the remaining ownership, restart, and compatibility findings.                                                                                                                                                                                                                        |
| C2-ZC canonical cutover            | **Complete**             | [PR #564](https://github.com/kazormia296/Grimodex/pull/564) merged the accepted candidate (`base 201f8968f324bef1341282c625aee3fb164ea401`, `head 2c1bc67c749eb90e4d441099bfa9bc7ea6ee950e`, `tree e7dff96286be3f111d9130cf89faf37929b88f17`, merge `0e62b40b622652f203690968d308b837e1481a33`). Quick/verify, Rust 17/17, Verify 13/13, Full run `cb03f6fb-b711-4377-bf7b-a5bd23c7ce79`, product journeys 26/26 allPassed/allClean, runtime performance, and Sol final all passed. |
| First Retrieval Vertical Slice     | **Partial**              | L0〜L5のRelated Scenes、Evidence navigation、失効・復旧は[PR #567](https://github.com/kazormia296/Grimodex/pull/567)で、#572はtyped基盤runtimeまでマージ済み。PR-R0で現在地・24検索case／8 Graph case／12 Packing task・writer／caller／egress・契約別開始判定を固定した。R0はproposal/3の五つのcontract rowをmerge済みで、PR #579はproposal/4 Option B Entity／Relation-only assertion family `typed-revision-material`という第六行を記録する。exact user confirmationによりこのrowは明示批准済み・契約として有効であり、refとユーザー確認、A2のA1＋D2a依存はexecution-plan ledgerに記録する。これらはdownstream threat modelを完了させず、runtime／consumerをactivateしない。standaloneのPR-P固定性能gateは解決済みで、残るのは Graph-integrated recheck pending/Hold（Graph統合再確認）だけであり、L6〜L9のproduction runtime integration・activation・受入れとNIR-1全体受入れは未完了。 |
| Living Story Bible product Epics   | **Planned**              | Correction Memory, live Structure Health, Change Review, reports, graph exploration, and Map proposals are defined below.                                                                                                                                                                                                                                                                                                                                                           |

## Critical path

```text
C2-2: Consumer granularity ── complete
C2-1: Change Feed → reverse lookup → evaluator → publish/ack ── complete
C2-3: Finding identity + Attention re-home ── complete
C2-5A/C2-5B: trigger, activation, and lifecycle ownership ── complete
C2-ZA: parity/readiness/re-key dry-run ── complete
C2-ZB: `application` re-key + Attention re-home migration ── complete
NIR-0: Chronicle `scene-event@1` add-only pilot ── certified
  ↓
C2-ZC: Generic Consumer Freshness becomes canonical ── complete (PR #564)
  ↓
NIR-1 L0〜L5: Related Scenes + Evidence navigation + invalidation/recovery ── complete (PR #567); standalone PR-P performance gate resolved, Graph-integrated recheck pending/Hold remains
  ↓
NIR-1 L6〜L9: execution contract documented; PR-R0 merged five proposal/3 rows ── PR #579 records the sixth proposal/4 Option B Entity／Relation-only assertion family `typed-revision-material`, explicitly ratified and effective by the exact user confirmation; A2 is ready only after A1＋D2a; #572 typed foundational runtime merged; no runtime or consumer activation and L6-L9 acceptance incomplete
  ↓
Codex Entity / Relation projection migration
  ↓
AI Correction Memory + live Structure Health
  ↓
Incremental Re-interpretation + Change Review
  ↓
Readable reports and graph exploration
  ↓
Map draft proposals and later visualization products
```

The ordering after PR #536 remains intentional: **Consumer granularity → Finding identity → lifecycle activation → Application re-key → canonical cutover**. Those joins, including the C2-ZC authority switch, are complete. NIR-1 L0〜L5 are merged in PR #567; the standalone PR-P performance gate is resolved and only Graph-integrated recheck pending/Hold remains. L6〜L9 are the next planned runtime lanes. #572 merged the typed foundational runtime, while production runtime integration/activation for that range and L6〜L9 acceptance remain incomplete. NIR-1 overall acceptance remains incomplete, and its implementation must not reopen C2-ZC or smuggle another authority into NIR-0 certification.

### Parallel branch ownership

The following rules describe the landing discipline used by the now-complete C2 lanes and remain the guide for future maintenance:

- **SCHEMA 31 belonged only to C2-3.** It added Finding identity and Attention resolution state and performed the identity-aware lifecycle baseline/re-home work.
- **C2-5A was schema-less.** It planned and coordinated automatic work before the production adapter and Verify/Rebuild activation joined through C2-5B.
- **C2-ZA was read-only.** It measured parity/readiness and classified a hypothetical re-key without mutating `consumer_kind`, Attention, or the canonical authority.
- The later schema-bearing `application` re-key was serialized after C2-3 and updated Attention in the same atomic migration unit.

---

# Milestone M0 — Complete Gate C2

## C2-4: Application Contribution ownership

**State:** Complete — merged in [PR #536](https://github.com/kazormia296/Grimodex/pull/536)

### Deliverables

- Persist Contribution provenance needed to trace a field back to Application, Proposal, Revision, Operation, and Commit lineage.
- Keep `target_state` and `maintenance_ownership` as separate axes.
- Project non-Application Change Feed writes into `modified` / `missing` state without confusing later Application writes, Undo, or Redo.
- Make human ownership one-way unless an explicit author action changes it.
- Protect the Contribution table behind typed Native writers.

### Exit criteria

- Human edits, Undo/Redo, later Applications, and missing targets produce deterministic Contribution state.
- A later AI Projection cannot silently retake a human-owned field.
- The SCHEMA 29 rebuild is tested against a representative pre-29 schema fixture.

### Follow-up hardening

- **Complete.** `src-tauri/crates/grimodex-db/tests/narrative_c2_upgrade_path.rs` drives `migrate()` and the shadow migration supervisor over a seeded workspace at every marker from SCHEMA 23 to 28. It covers the three hazards only a real upgrade can reach: the Contribution `commit_id` index that a SCHEMA 23–28 workspace cannot carry before the rebuild, the `narrative_c2_schema_29` savepoint unwinding without leaving the scratch rebuild table behind, and `NEX_CONTRIBUTION_ORPHAN` refusing before any step that discards derived state.

## C2-2: Consumer granularity

**State:** Complete

### Goal

Replace Run-grained freshness with durable identities for the actual Consumers that need independent invalidation.

### Required Consumer classes

- Narrative IR Revision
- Extraction Artifact
- Proposal Revision
- Application
- Application Contribution
- Derived Projection
- Semantic Index generation
- Related Scenes candidate materialization
- Chat Context materialization
- Consistency / Structure Health diagnostic

### Deliverables

- **Complete** — Canonical `(consumer_kind, consumer_key)` vocabulary and validation. [`narrative-consumer-contract.json`](../../policies/narrative/narrative-consumer-contract.json) registers every Consumer class with a `status` that states what is true today (`declared` / `reserved` / `not-yet-modelled`) rather than what is planned, fixes the `finding_key` format and its split-on-first-colon parse rule, and names `narrative_consumer_freshness` as the single Freshness authority. `narrative_extraction/consumer_identity.rs` is the Rust counterpart: a fail-closed `ConsumerKind`, one `consumer_finding_key`, and the `owning_run_id_for_consumer` seam.
- **Complete** — Dependency-set digest per Consumer. Publishing writes `narrative_consumer_freshness.dependency_set_digest`, and Verify's `consumer-freshness-dependency-set-digest` check reports drift. NULL keeps meaning "not yet evaluated"; it is not an inconsistency.
- **Complete** — Producer-time declaration of Dependencies at the smallest safe durable unit. `repository.rs`'s `record_revision_dependency_edges_in_tx` keys every Edge under `(proposal-revision, revision_id)`. A Revision is the smallest unit that is already durable and immutable, and it already carries the same Source Basis, so nothing had to be invented to key an Edge to it.
- **Complete** — Migration from Run-grained Edges without fabricating cross-run identity. The C2-2 re-key reads the finer attribution out of `narrative_revision_source_basis`; the later SCHEMA 32 C2-ZB migration reads Legacy Backfill attribution from the durable `Application → ApplyCommit.run_id → projection dependency` chain. Exact matches preserve Edge identity and history, fan-out without history creates every candidate Application Edge, and ambiguous/unattributed evidence fails closed inside one schema-owned savepoint.
- **Complete** — Reverse lookup returns only affected Consumers. C2-1's bounded runtime resolves Feed events to canonical Source identities and wires `dependency_edges::find_edges_by_source` into evaluation and publication. Ratified component-schema and restore/Epoch-reset markers deliberately fan out project-wide because they invalidate compatibility or the prior producer Epoch rather than one Source object; prior-Epoch Edges publish conservative `unknown` until a Producer re-declares them.

### Why the identity seam landed first

Run grain is not merely coarse — it is load-bearing in three places that fail _silently_ rather than loudly when it changes, so re-keying Producers before closing them would have produced plausible, fabricated Findings instead of errors:

- `restore_rebuild` passed `consumer_key` wherever a `run_id` was wanted. `resolve_snapshot_document` requires a `snapshot:<runId>` Source's key to equal that id, and the resolver's error was swallowed into `current_source_exists = false` — so a Consumer that is no longer a Run would have reported `source-missing` for Sources that are present. Both call sites now go through `owning_run_id_for_consumer` and fail closed on `None`; Verify reports such Edges under their own heading rather than as missing Sources.
- Consumer Freshness was rolled up over the Edges the _caller passed_. A partial publish — which is the entire point of C2-1's incremental evaluation — would have dropped the Edges it did not re-evaluate and rolled the Consumer back to `fresh` while their own Edge State still said otherwise. The rollup now reads the Consumer's stored Edge States at the current Semantic Epoch, and an Edge with no state at that epoch counts as `unknown` rather than leaving the rollup: `unknown` outranks everything but `source-missing`, so "we have not looked at this yet" cannot be outvoted by a `fresh` neighbour while `dependency_set_digest` asserts the verdict covered every declared Edge.
- `finding_key` had three implementations (`publish_runtime`, `inbox_read_model`, and SQL in `migrate.rs`). Two of them had already disagreed once, making every diagnostic Finding invisible to the Maintenance Inbox without any error. There is now one function; the frozen migration SQL is pinned to it by test.

### Exit criteria

- **Met** — Editing one Scene can stale one Proposal Revision without staling every Proposal from the same Run. Gated by `saving_proposals_declares_dependency_edges_per_revision_not_per_run`, which replaced the test that pinned the opposite. Index generation is a separate reserved Consumer kind and remains future work.
- **Met** — A Consumer key remains stable across retry and idempotent replay: a Revision id is immutable, and declaration stays an upsert per Source.
- **Met** — Deterministic Core never uses heuristic semantic matching to invent identity. The re-key joins on stored Source Basis keys, and the one shape difference it accounts for is the single prefix `canonical_source_object_identity` ever adds.

### Known consequence: orphaned Attention

`finding_key` is `{consumer_kind}:{consumer_key}`, so re-keying a Consumer changes it and a human's snooze / dismiss / flag stops matching. Those rows are **not** deleted — Attention is durable human state (`epochBinding: none`, `backflowPolicy: forbid`) and the roadmap protects author decisions from silent discard. Re-pointing one Run's disposition at each of its Revisions was rejected as the opposite error: it would _broaden_ a decision, and a real new problem could hide behind it.

Verify reports them as `orphaned_attention_finding_keys` instead, so the state is visible rather than silent. Re-homing them is C2-3's Finding identity work, which has now landed.

## C2-1: Change-Feed-driven incremental Freshness runtime

**State:** Complete

### Canonical path

```text
Narrative Change Feed event
  → reserve cursor range
  → resolve changed Source identities
  → reverse Dependency lookup
  → build current Source comparison inputs
  → evaluate Edge and Consumer Freshness
  → publish Edge State, Consumer Freshness, and Findings
  → acknowledge cursor
```

### Deliverables

- **Complete** — A main-process-only, single-flight scheduler in [`electron/main/narrativeFreshness.ts`](../../electron/main/narrativeFreshness.ts) calls the Native runtime without adding a renderer IPC or preload surface.
- **Complete** — [`incremental_freshness.rs`](../../src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs) reserves at most 32 canonical sequences per cycle, yields the live Database authority between phases, and accelerates only while `hasMore` reports backlog.
- **Complete** — Feed-to-Source resolution and reverse lookup evaluate only affected Edges. Every affected Consumer is published in one transaction, followed by one cursor acknowledgement in that same transaction.
- **Complete** — Publication verifies the Semantic Epoch, Task lease, cursor reservation, evaluated Source state, and Edge declaration by compare-and-swap. Only a still-running work key can be resumed; a completed Run never authorizes acknowledgement of an unacknowledged range, which is reprocessed under a new runtime-owned Run. An acknowledged range becomes idle.
- **Complete** — Source deletion, anchor mismatch, exact relocation, read-set drift, normalizer incompatibility, and component-schema compatibility changes have explicit deterministic comparison paths.
- **Complete** — Expired Attempts are terminalized before a replacement claim; interrupted Runs, Tasks, Attempts, stale-Epoch reservations, and retryable failures retain or recover the same bounded range without skipping it. Retry exhaustion fails the Task and Run after three Attempts, keeps the range reserved without a lease, and waits for a canonical Epoch rotation to release and reprocess it under a new Run.

The existing `incremental-freshness` Run Kind also owns an
`idleCheckpoint` contract for the no-backlog case; it does not add a new Run
Kind. The checkpoint is an exact tagged, zero-width current-Epoch
`freshness-evaluation` Run with one `incremental-freshness-batch` Task, a
clean cursor acknowledged at `feedHead`, and deterministic one-project-per-
wake selection. Missing cursors are accepted only at head 0, and any
current-Epoch Freshness Run in any status suppresses minting. The exact Task
input, spec, and Work Key share the canonical JSON SHA-256 input digest. Its
terminal shape is one completed Task and one completed Attempt with no active
Attempt; the Task is `completed`, its `attempt_count` equals the Attempt row
count, Attempt numbers are contiguous `1..N`, only failed/completed Attempts
are allowed with the completed Attempt last, failed retry history precedes
completion, and malformed `task_kind` values cannot evade the retry cap. Idle writes are limited to
Run/Task/Attempt state and the Freshness cursor; no Change Set, Generic
Consumer Freshness, Edge State, Finding, Attention/Domain, D2 declaration or
shadow, or Semantic Index write is permitted. A completed checkpoint avoids
next-wake churn, but database state alone does not prove scheduler liveness or
C2-ZC cutover, and the normal Feed-backed path remains unchanged.

### Implementation evidence

- Shared runtime: [`src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs`](../../src-tauri/crates/grimodex-db/src/narrative_extraction/incremental_freshness.rs)
- Native entrypoint and Electron scheduler: [`electron/native/grimodex-node/src/lib.rs`](../../electron/native/grimodex-node/src/lib.rs), [`electron/main/narrativeFreshness.ts`](../../electron/main/narrativeFreshness.ts)
- Runtime acceptance fixtures: [`src-tauri/crates/grimodex-db/tests/narrative_incremental_freshness_runtime.rs`](../../src-tauri/crates/grimodex-db/tests/narrative_incremental_freshness_runtime.rs), [`electron/main/narrativeFreshness.test.ts`](../../electron/main/narrativeFreshness.test.ts)

### Scope boundary

C2-1 owns automatic scheduling and lifecycle recovery only for the bounded
`freshness-evaluation` Feed consumer. It does not introduce C2-3's
three-layer Finding identity or re-home orphaned Attention, does not schedule
Backfill / Verify / Rebuild-Derived or provide their shared recovery policy
(C2-5), and does not change the canonical Freshness read authority (C2-Z).

### Exit criteria

- A committed Source mutation reaches the correct Consumers without a manual whole-project Verify.
- Replaying the same Feed range does not duplicate Findings or move Freshness backwards.
- Process interruption cannot leave a permanent `running` Run or an unrecoverable cursor lease.
- The runtime does not reproduce the `SQLITE_BUSY_SNAPSHOT` hazard caused by an independent post-open writer.

## C2-3: Finding three-layer identity

**State:** Complete — merged through PR #556 and hardened by PR #559

### Required identities

1. **Rule identity** — which versioned rule observed the condition.
2. **Observation identity** — what the rule observed in this evaluation.
3. **Material basis identity** — which durable facts make a prior human disposition still applicable.

### Deliverables

- **Complete** — A bundled, versioned, fail-closed Rule Registry for `narrative.consumer-freshness@1`.
- **Complete** — Domain-separated `finding_identity`, `observation_digest`, and rule-declared `material_basis_digest`; transient Run, Epoch, and timestamp data are excluded from durable Finding identity.
- **Complete** — Explicit `new` / `recurring` / `changed` / `resolved` lifecycle state derived from the identity-aware Observation stream.
- **Complete** — Attention applicability bound to an exact resolved Finding identity and material basis. Historyless or ambiguous legacy rows remain durable and visible as `legacy-unresolved`; they are never guessed onto a new Finding.
- **Complete** — SCHEMA 31 migration and representative SCHEMA 30 upgrade fixture, including legacy NULL-Edge Observations and an identity-aware lifecycle baseline.

### Exit criteria

- Dismiss / hold / acknowledge survives a harmless re-run but lapses when the material basis changes.
- Finding identity does not depend on a transient Run id.
- Semantic Epoch rotation does not invalidate non-epoch-bound human disposition without cause.

## C2-5: Automatic triggers and lifecycle recovery

**State:** Complete — C2-5A/C2-5B merged and product-journey verified

### C2-5A foundation boundary

- Schema-less trigger-to-work planning for Migration, Restore, contract change, producer completion, and pre-cutover requests.
- Canonical, Semantic-Epoch-aware work keys; same-key coalescing; one process-wide project claim across automatic Run Kinds.
- Durable ledger decisions that distinguish same-process reuse, startup interruption, stale-Epoch recovery, fresh work, bounded retry, and manual intervention.
- A main-only scheduler contract that preserves project scope for durable `hasMore` wakes and rejects malformed backend responses through the retry path.
- Shadow by default. Execute-safe mode may select Backfill only; Verify and Rebuild-Derived remain explicitly deferred.
- No renderer/preload surface and no route to human-only Repair.

### C2-5B activation boundary

- Connect the live Native adapter and enable Backfill only after its authority and durable wake contract are validated end to end.
- Add Rule/graph-contract-aware completed-Run skip evidence before enabling automatic Verify or Rebuild-Derived.
- Project non-retryable semantic failures into durable Maintenance Inbox Findings using C2-3 identity; logs alone are not completion evidence.

### Deliverables

- Safe automatic scheduling for Backfill, Verify, and Rebuild-Derived according to `narrative-run-kind-policy.json`.
- Trigger coalescing and per-project serialization.
- Interrupted Run recovery shared across Run Kinds.
- Persistent notification for non-retryable contract violations.
- Manual Repair remains separately authorized, previewed, backed up, and confirmed.

### Exit criteria

- Migration and Restore request the required system work without blocking authoring.
- A transient failure retries within bounded policy; a contract failure stops and appears in Maintenance Inbox.
- Background code cannot reach the human-only Repair route.

## C2-Z: Canonical authority cutover

**State:** Complete — PR #564 merged

### C2-ZA read-only preparation

**State:** Complete — merged

- Measure legacy/Generic Freshness and dependency parity without writing either authority.
- Evaluate every per-workspace cutover requirement fail-closed. Evidence unavailable from the database alone, including scheduler liveness, remains `incomplete` rather than passing by assumption.
- Dry-run the Legacy Backfill Edge re-key to `application`, reporting exact, fan-out, unattributed, collision, invalid, and missing-Run cases without changing stored Consumers.

### C2-ZB migration boundary

**State:** Complete — SCHEMA 32 merged and hardened by PR #559

- SCHEMA 32 runs the all-project preflight, re-key, Finding/Attention re-home, derived invalidation, touched-project migration Epoch, and final marker in one schema-owned atomic unit.
- Refuse ambiguous, unattributed, invalid, or colliding candidates; do not manufacture Application identity.

### C2-ZC canonical switch boundary

**State:** Complete — accepted candidate merged by PR #564

Canonical project births are exactly `project.create`,
`import.session.apply`, and `scan.import.publish`. Scan staging allocation is
an explicitly hidden, noncanonical workspace operation and is not product
project-create proof; the typed `scan_staging_project_publish` route is the
only promotion path into the canonical scan import operation.

- The existing main-only Freshness scheduler runs one bounded cycle, revalidates
  the current workspace authority/generation, and mints a capability-bound
  liveness receipt before it attempts cutover.
- The shared-Rust cutover is fail-soft only for the exact
  `NEX_C2ZC_CUTOVER_NOT_READY:` readiness result. Marker, schema, evidence, and
  authority failures surface to the scheduler caller and are retried through
  the normal scheduler error policy.
- Marker persistence and canonical reader/writer selection remain inside the
  shared-Rust/database authority boundary; renderer and preload gain no
  cutover surface.

The accepted candidate binds the complete gate evidence: candidate base
`201f8968f324bef1341282c625aee3fb164ea401`, candidate head
`2c1bc67c749eb90e4d441099bfa9bc7ea6ee950e`, accepted tree
`e7dff96286be3f111d9130cf89faf37929b88f17`, merge commit
`0e62b40b622652f203690968d308b837e1481a33`, Full run
`cb03f6fb-b711-4377-bf7b-a5bd23c7ce79`, Rust 17/17, Verify 13/13, product
journeys 26/26 allPassed/allClean, runtime performance PASS, and Sol final
PASS. C2-ZC is therefore the accepted canonical Freshness cutover and its
start condition for NIR-1 is satisfied.

### Per-Workspace cutover requirements

- Legacy Dependency Backfill completed.
- Current Semantic Epoch Verify passed.
- No unresolved durable graph errors.
- Rebuild-Derived completed for the current contracts.
- Legacy and Generic Freshness parity is within the ratified contract.
- No active Backfill or Repair Run.
- Incremental runtime is live and cursor-consistent.
- All 13 named Verify checks remain required and have production coverage
  13/13; this set may not be reduced.
- The reserved `semantic-index` authority footprint is directly scanned across
  metadata rows, active sealed D1 heads, V1 semantic-index Edges, and
  semantic-index Consumer Freshness. Only an all-zero result passes; any
  non-zero footprint is manual/terminal evidence and is not a Rebuild target.
- The incremental Freshness idle checkpoint, when present, is only durable
  current-Epoch Run/Task/Attempt and cursor evidence. It cannot be a Generic
  Consumer Freshness publisher, and its database checkpoint does not replace
  scheduler-liveness or cutover evidence.

### Exit criteria

The complete C2-ZC gate receipt and the associated product/runtime evidence
exist on the accepted candidate above. These criteria are now recorded as
met; future NIR-1 work must preserve them.

- **Met** — Generic Consumer Freshness is
  the accepted sole canonical Freshness read authority.
- **Met** — Legacy Freshness is
  compatibility-only without silent divergence.
- **Met** — Rollback or recovery never
  creates a second durable Freshness authority, with the product/Full/Sol
  evidence package recorded.

### Reserved Semantic Index status

The following is the C2-ZC acceptance-time snapshot; it remains historical and
does not replace the current NIR-1 status above. At that time,
`semantic-index` was a reserved consumer with no active Narrative dependency
authority. C2-ZC acceptance required an all-zero direct scan of exactly these
four project-scoped surfaces: all project rows in
`narrative_semantic_index_metadata`, and rows with
`consumer_kind = 'semantic-index'` in active sealed D1 declaration heads, V1
`narrative_dependency_edges`, and `narrative_consumer_freshness`. Any
non-zero footprint is manual/terminal and is not a Rebuild-Derived target.

Scene, Codex, Event, and Chat embedding chunk rows may exist as rebuildable
acceleration. They must never be inferred or migrated into a Narrative
dependency authority claim.

The dormant NIR-1 binding algorithm is only a future proposal:

- `metadata.index_key = D1 consumer_key = freshness.consumer_key`;
- `metadata.generation = active sealed D1 head consumer-scoped
producer_generation`;
- `metadata.dependency_set_digest = active sealed D1 set digest`.

Fixed keys, producer registry, Source identities, writers, D1 declarations,
metadata migration, restore invalidation, and `reserved` → `declared`
activation require NIR-1 approval. NIR-1's first candidate may use one shared
producer, but producer granularity, metadata producer identity composition,
dirty/pending semantics, and Codex Source granularity remain unapproved.

---

# Milestone M1 — Shared Narrative IR and First Retrieval Vertical Slice

## NIR-0: Shared contract adoption

**State:** Complete — NIR0-CERT; production scope is the Chronicle add-only pilot

The detailed authority for this work is the [NIR-0 implementation
plan](narrative-ir-nir0-implementation-plan.md), under ADR 011 and the
ADR 009/010 contracts. NIR0-00 supplied the contract freeze; PR #559 completed
the C2B materialization, restart/authority hardening, and typed Chronicle
`scene-event@1` / `add` production route. The
[NIR0-CERT evidence package](../certification/nir0/NIR0-CERT.md) binds the
certified base/head/tree and the byte-identical integrated `master` tree.

### Certified deliverables

- Envelope V2 and project-scoped `proposal-revision` identity at
  `narrative_proposal_revisions.id`; `narrative-ir-revision` remains
  not-yet-modelled.
- Native-verified Human-derived request boundaries, path classes, strongest
  mixed-edit classification, child material-basis ownership, and the split
  between interpretation live-token validation and Human-derived stale-state
  publication.
- Shared versioned Adapter golden requirement for canonical Scope JSON and
  Scope Digest; TypeScript and Rust pass the same corpus.
- C2B ScopeOverride derives live Scope V2, child D1/V1 dependencies,
  current-Epoch Freshness, and the final pointer CAS atomically; stale,
  missing, ambiguous, reorder, archive, and rollback paths fail closed.
- Chronicle production emits only `scene-event@1` with `changeKind=add` when
  the C1 provenance closure and Evidence anchors are complete. The typed C2B
  Human writer is the V2 review route; the existing V1 append path remains an
  explicit fallback.
- Activation is enabled for these entry points and remains bounded to this
  pilot. Disclosure admission, D2 full cutover, revise/retract/merge/split,
  and NIR-1 retrieval remain outside the NIR-0 scope; at the time of this
  NIR-0 acceptance record, NIR-1 was planned/ready but not implemented.
- Durable cold-start discovery, same-Run resume, typed blocked-Run discard,
  Workspace-authority binding, and sealed existing-event-catalog CAS prevent
  restart or authority replacement from fabricating a second execution.

NIR-0 does not add a second Freshness or semantic authority, replace manuscript
text, or imply universal Narrative IR coverage. Credentialed/live-model Heavy
evaluations remain explicitly deferred and were not counted as passing evidence.

### Exit criteria

- **Met** — Policy/schema/fixture/validator and semantic contract checks pass with the exact activated production markers.
- **Met** — The clean implementation candidate passed Quick/Full CI and receipt verification, and its tree is byte-identical to the merged `master` implementation tree.
- **Met** — The Evidence-bound `scene-event@1` add journey, C2B Human journey, live ScopeOverride materialization, Freshness, restart behavior, and negative matrix remain separate and are recorded in NIR0-CERT.

## NIR-1: First Retrieval Vertical Slice

**State:** Partial — L0〜L5 are merged in [PR #567](https://github.com/kazormia296/Grimodex/pull/567), and #572 is merged with the typed foundational runtime (Scope/Entity/Relation/Evidence and request-local primitives). PR-R0 fixes the current-state and evaluation ledger on the #572 base and merged five proposal/3 rows. PR #579 records the sixth proposal/4 Option B Entity／Relation-only assertion family `typed-revision-material`; the exact user confirmation makes this row explicitly ratified and effective as a contract. The exact ref, user confirmation, and A2 dependency on A1＋D2a are recorded in the execution-plan ledger. These records do not complete the downstream threat model or activate any runtime or consumer. The standalone PR-P performance gate is resolved; only Graph-integrated recheck pending/Hold remains, and the remaining L6〜L9 production runtime integration, activation, and acceptance are incomplete. NIR-1 overall acceptance is incomplete.

Integrated execution and approval draft:
[NIR-1 統合実装計画](narrative-ir-nir1-implementation-plan.md) and the
[L6〜L9実行計画](nir1-l6-l9-execution-plan.md). They carry forward
the completed L0〜L5 implementation and the membership, Adapter-fixture and
diagnostic-policy evidence, and defines normal-operation reachability, Related
Scenes, Graph and Context Packing without treating diagnostic approval as
product activation.

NIR-1's start condition was satisfied by the recorded C2-ZC product journey,
clean Full CI with receipt verification, and Sol final, with the complete
Verify set at production coverage 13/13 and the reserved Semantic Index
four-surface scan at all zero. That scan is the C2-ZC acceptance record; the
reserved Semantic Index binding and the producer/data-contract decisions listed
in the C2-ZC reserved-boundary section remain unapproved for L6〜L9. The #572
typed foundational runtime is complete, but no L6〜L9 production runtime
integration, activation, or acceptance is claimed by this readiness state. The execution document adds D2a as the
profile-wide local-only plaintext-publication prerequisite: Graph activation
requires A3+B+C+D2a, and Packing activation requires C+D1+D2a+D2b-1+D2b-2.

### PR-R0 ledger state

PR-R0 is a documentation and quality-contract slice only. It keeps the three existing plan documents as the canonical narrative, traces the existing quality manifest/impact map and contract test, and records #572's typed foundational runtime while leaving production integration incomplete. Its fixed evaluation population is the existing 24 retrieval cases in `evals/nir1-retrieval/manifest.json` (ja/en 12 each) plus planned identifiers G-01〜G-08 and P-01〜P-12; the Packing IDs cover six task classes twice, with G-01/P-12 as the predeclared improvement cases. No Graph/Packing fixture or production runtime activation is added. R0 confirmation state: five proposal/3 contract rows were merged. PR #579 records the sixth proposal/4 Option B Entity／Relation-only assertion family `typed-revision-material`; the exact user confirmation makes this row explicitly ratified and effective as a contract. The exact per-contract refs and user confirmation are recorded in the execution-plan ledger, and A2 is ready only after A1＋D2a. These records do not complete the downstream threat model or activate any runtime or consumer. Future implementation candidates remain subject to the shared merge gate M: a clean candidate must pass Full and immediate verify before merge; earlier static-draft no-run notes do not waive that gate. The standalone PR-P performance gate is resolved; only Graph-integrated recheck pending/Hold remains, and `author-value: not-measured` remains explicit.

### Canonical slice

```text
Scene Source
  → Evidence-bound Assertion
  → IR Embedding / Graph Index
  → Raw Text + IR + Graph candidate fusion
  → Related Scenes / Chat candidate selection
  → Evidence-backed result
```

### Deliverables

- Raw Text lexical retrieval.
- Raw Text dense retrieval.
- Narrative IR dense retrieval.
- Initial Entity / Relation graph traversal.
- Pre-ranking disclosure admission using existing phase, spoiler, scope, knowledge-holder, audience, Timeline, Worldline, and narrative-layer policy.
- Candidate fusion with Authority, Freshness, Scope, and Evidence signals.
- Task-aware Context Packing that retains relevant Raw Text and Evidence excerpts.

### Exit criteria

- Hybrid retrieval is measured against the current Raw Text baseline.
- A reviewed Assertion can improve Related Scenes or Chat selection without semantic re-extraction.
- A result links to Evidence and displays Review and Freshness status.
- Semantic relevance never overrides disclosure policy.
- Prose tasks still receive task-relevant Raw Text.

---

# Milestone M2 — Domain Projection migration

Feature Domain Schemas remain typed and feature-specific. The migration unifies Interpretation, Evidence, Provenance, Review, and Freshness contracts; it does not convert every Aggregate into a generic graph node.

## Default migration order

| Wave | Domain                                   | Reason                                                                                                |
| ---- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| D1   | Codex Entity and Relation                | Unlocks Entity Resolution Memory, identity-aware retrieval, and the most visible extraction workflow. |
| D2   | Chronicle, Timeline, Temporal Constraint | Establishes Event and temporal Evidence reuse.                                                        |
| D3   | Phase, State, State Transition           | Enables longitudinal character and world-state maintenance.                                           |
| D4   | Plot Thread and Foreshadow               | Adds promise, setup, payoff, and plot-structure maintenance after identity and time are stable.       |

Each wave must provide:

- Shared Narrative IR typed payloads.
- Compatibility adapters for released workspaces and saved Artifacts.
- Producer-time Dependency declaration.
- Review and Projection state mapping.
- Feature-specific Structure Health rules.
- Retrieval participation where useful.
- Migration evidence before deleting feature-private summaries or Freshness stores.

The default order may change only when evaluation evidence shows a safer or higher-value bounded slice. Such a change updates this roadmap; it does not silently create a parallel semantic authority.

---

# Milestone M3 — Living Codex Core

## Epic P0-A: AI Correction Memory / Entity Resolution Memory

**State:** Planned

### Product promise

> AIの間違いを一度直せば、次回以降の解析にも反映されます。

A rejected Candidate is not sufficient for this feature. Rejection is scoped to a Revision, Source Basis, and Scope. A durable correction that should constrain future extraction must be an explicit, versioned **author declaration Source**.

### ERM-0: Identity correction contract

Requires an ADR amendment or focused ADR for stable Entity identity and correction precedence.

Minimum typed correction rules:

- `must-link-surface` — a surface must resolve to a specific Codex Entry within its declared scope.
- `cannot-link-entries` — two Entries must not be proposed as the same entity within scope.
- `preferred-binding` — prefer one Entry when several exact candidates exist.
- `preferred-canonical-name` — declare canonical naming and whether the prior name remains an alias.
- `suppressed-merge-candidate` — remember an author-declined merge without turning every future context into a permanent falsehood.

Each rule records author, time, scope, provenance, supersession, and reason.

### ERM-1: Extraction integration

- Apply author correction rules before model confidence or fuzzy ranking.
- Show conflicts rather than selecting an arbitrary winner.
- Reuse rules across Codex extraction, Import, Semantic Search, Related Scenes, Chat Context, and Structure Health.
- Preserve the original model output and layer the correction separately.

### ERM-2: Merge / Split proposals

User actions:

- “この2件は同一人物”
- “この別名はこの人物ではない”
- “今後この表記は必ずこのEntryへ結び付ける”
- “この2件を同一人物として提案しない”
- Canonical-name change with alias-retention choice

Before Apply, show impact on:

- Codex Detail and Relation
- Phase and State
- Chronicle and Timeline
- Plot Thread and Foreshadow
- Map references
- Mention indexes and editor highlights
- Search, retrieval, and packed contexts

Merge / Split is always a Proposal or explicit authoring operation through canonical Typed Writers. Dependency propagation alone may never perform it.

### ERM-3: History and reversal

- Store immutable correction revisions and their application history.
- Reversal creates a new forward decision / application or uses the normal authoring Undo lineage; it does not rewrite old review history.
- Re-running extraction must show which prior correction affected a decision.

### Exit criteria

- A corrected binding is reused by a later extraction run without prompting the author again.
- A cannot-link rule prevents the same false merge proposal in equivalent scope.
- Conflicting rules fail closed and appear in Structure Health.
- Merge / Split impact is previewable and reversible without orphaning dependent data.

## Epic P0-B: Live Structure Health / Evidence Audit Inbox

**State:** Planned; foundation exists in Gate C2

### Foundation rules

- `evidence-stale`
- `source-missing`
- `anchor-mismatch`
- `read-set-drift`
- `stale-projection`
- `dependency-contract-error`
- `semantic-index-dirty`

### Feature rules

- `source-unseen` — AI-derived Entry has neither a matching source mention nor valid Evidence.
- `zero-mentions` — AI-derived Entry has no current Mention.
- `ambiguous-identity` — one surface conflicts across several Entries or correction rules.
- `unsupported-relation` — AI-derived Relation has no valid Evidence.
- `generic-surface` — a generic title, pronoun, or description became a canonical name without explicit author approval.
- `correction-conflict` — durable identity corrections are mutually incompatible.

Rules such as `source-unseen`, `zero-mentions`, and `generic-surface` apply by default only to AI-derived or imported data. A manually created future character with no current appearance is not a hallucination.

### Inbox actions

- Inspect current and prior Evidence.
- Jump to Source.
- Hold, acknowledge, dismiss, or reopen a Finding.
- Request revalidation or re-interpretation.
- Fix binding or create a correction rule.
- Detach an unreconstructible semantic artifact.
- Open a Merge / Split impact preview.

No rule automatically deletes Domain data or retracts semantic meaning.

### Exit criteria

- Live counts come from canonical Consumer Freshness and Finding identity, not placeholder data.
- A Source edit updates only affected Findings.
- Human disposition survives harmless re-evaluation and resets when material basis changes.
- Every automated warning states its provenance and why it applies.

---

# Milestone M4 — Living Story Bible

## Epic P1-A: Incremental Re-interpretation and Change Review

**State:** Blocked on C2-Z, Domain migration, and stable Assertion identity

### Prerequisite contract

Cross-run semantic diff requires a mandatory stable `assertionId` or equivalent Producer-declared identity for the participating Assertion families. Deterministic Core must not guess identity with heuristic matching.

### Canonical path

```text
Changed Source range
  → affected Consumer lookup
  → incremental Interpretation task
  → new immutable Assertion Revisions
  → identity-aware semantic diff
  → Change Review
  → Proposal / Decision / Prepared Commit
```

### Review categories

- Added
- Revised
- Evidence relocated
- Evidence lost
- Scope changed
- Conflict introduced
- Superseded
- Retraction proposed
- No semantic impact

### Review UI

For each change, display:

- Previous accepted or held value
- New Proposal
- Text that caused the change
- Previous and current Evidence
- Review, Freshness, and Projection state
- Affected downstream Artifacts and fields
- Apply / reject / hold / edit / ignore-for-this-basis / create-correction-rule

The UI is named **変更レビュー**, not Auto Sync. It never silently rewrites the Story Bible.

### Exit criteria

- Editing one Scene schedules only affected Interpretation work.
- The author can understand why a semantic item changed.
- Accepted and rejected decisions remain durable across model/provider changes.
- Evidence loss creates a reviewable state rather than automatic deletion.
- Rejected previous interpretations are available as prior review evidence without permanently suppressing materially new Candidates.

## Product claim unlocked

> 本文を書き続けても、設定集・時系列・伏線が根拠付きで追従します。

---

# Milestone M5 — Outputs and exploration

## Epic P1-B: Readable Story Bible / Reviewer Pack export

**State:** Planned; may start after live provenance and Freshness labels are available

### Templates

- **Story Bible** — people, places, organizations, items, concepts, and relationships.
- **Continuity Report** — Timeline, Phase, state changes, contradictions, stale items, and unresolved review.
- **Plot Report** — Plot Threads, Beats, Foreshadow setup/payoff, and unresolved promises.
- **Reviewer Kit** — overview, principal characters, selected sample Scenes, and product-visible structure.
- **AI Handoff Pack** — compact structured Markdown for another model or tool.

### Delivery order

1. Markdown
2. Existing export-compatible structured bundle
3. DOCX / PDF only after layout and provenance presentation are stable

### Required labels

- Human-authored / AI-derived / imported
- Review state
- Evidence Freshness
- Projection state
- Evidence reference or explicit absence

This is distinct from Portable Narrative IR Export. A human-readable report is a presentation product; Portable Narrative IR is a machine interchange contract.

### Exit criteria

- One export can be given to a reviewer without requiring the Grimodex Workspace.
- Stale and unreviewed content cannot masquerade as confirmed fact.
- Report generation does not mutate Domain or semantic state.

## Epic P2: Relation Path Explorer

**State:** Planned after graph retrieval and Relation migration

### Capabilities

- Find paths between two Codex Entries.
- Open every Edge's Evidence.
- Filter by Phase, story time, Timeline, Worldline, viewpoint, knowledge holder, audience, and narrative layer.
- Include only accepted Relations, or optionally label unreviewed AI Candidates.
- Filter by Relation class such as affiliation, kinship, command, treatment, conflict, or location.

### Exit criteria

- Every displayed Edge is backed by an accepted Projection or visibly labelled Candidate.
- Disclosure admission occurs before path ranking.
- The explorer does not infer objective truth from path existence.

---

# Milestone M6 — Future visualization proposals

## Epic F1: Codex-to-Map draft generation

**State:** Deferred

### First scope

- Convert Location-type Codex Entries into Map nodes.
- Convert `contains` into Frames or parent-child placement.
- Convert `adjacent` / `connected-to` into Edges.
- Produce a preview Proposal before touching an existing Map.
- Allow the author to reposition and edit every generated element.

### Explicit non-goals for the first version

- Automatic terrain generation
- Authoritative geography inference
- Automatic character trajectory playback
- Silent replacement of an authored Map

Character trajectory playback waits until Chronicle, Location, and temporal Scope are stable enough to support it with Evidence.

---

# Cross-cutting workstreams

## Evaluation

- Maintain deterministic fixtures for Evidence, Scope, disclosure, identity corrections, Freshness, and semantic diff.
- Compare Hybrid Retrieval against the current Raw Text baseline.
- Measure false merge, duplicate entity, unsupported relation, stale-detection, and reviewer-workload rates.
- Paid model execution is release certification or explicit live evaluation, not continuous ordinary CI.

## Compatibility and migration

- Every new durable identity requires an upgrade-path test from the oldest unreleased schema that can contain the affected rows.
- Released Workspace convergence and saved Artifact compatibility must be proven before deleting adapters.
- Rebuildable indexes may be discarded; Evidence, Review, Decision, Application, correction rules, and audit history may not.

## Observability

Failures must be attributable to one layer:

- Source / Evidence
- Interpreter / Producer
- Narrative IR validation
- Review / authority
- Prepared Commit / Typed Writer
- Dependency / Freshness evaluator
- Index / retrieval
- UI presentation

A generic “AI解析に失敗しました” message is not sufficient for maintainable operation.

## Product language

Prefer user-facing terms that describe the action rather than the mechanism:

| Technical concept                  | Product wording              |
| ---------------------------------- | ---------------------------- |
| Entity Resolution Memory           | AI修正メモリ                 |
| Semantic Build Graph Finding       | 構造ヘルス / 要確認          |
| Incremental Re-interpretation diff | 変更レビュー                 |
| Human-readable semantic export     | Story Bible / レビューパック |
| Graph traversal query              | 関係パス                     |

---

# Whole-roadmap completion criteria

The Living Story Bible roadmap is successful when all of the following are true:

- One reviewed Assertion can be reused by several features without semantic re-extraction.
- One Source edit invalidates and rebuilds only affected Consumers.
- A user correction changes later entity resolution and does not need to be repeated.
- AI-derived content is distinguishable from author-confirmed content in storage, retrieval, UI, and export.
- Every semantic result links to Evidence or explicitly records Evidence absence.
- Stale content is neither treated as fresh nor automatically retracted.
- The author reviews semantic changes before Domain mutation.
- Raw Text and Narrative IR participate in one Hybrid Retrieval path.
- Story Bible, Continuity, Plot, and Reviewer outputs preserve provenance and Freshness labels.
- Derived Indexes can be rebuilt from durable ledgers without rerunning external models when the semantic Artifact already exists.
- No second mutation, Freshness, or semantic-truth authority is introduced.

# Roadmap maintenance protocol

1. Update **Last updated**, the Current snapshot, and the relevant Epic status in the same PR that materially changes roadmap state.
2. Add the implementing issue or PR link before setting an item to Active.
3. Mark an item Complete only after the implementation PR is merged and its exit criteria have evidence.
4. Record sequencing changes and their dependency rationale here; do not leave the only explanation in chat or a PR description.
5. Architectural changes require an ADR amendment. Machine-enforced contract changes require policy/schema/validator updates.
6. Historical chat plans remain useful discussion records, but this document is the mutable roadmap authority.
