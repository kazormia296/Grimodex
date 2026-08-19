# Narrative Semantic Core / Living Story Bible Roadmap

## Status

- **Lifecycle:** Active mutable roadmap
- **Last updated:** 2026-08-18
- **Current focus:** Gate C2 completion and canonical Semantic Build Graph cutover
- **North star:** **本文に追従し、根拠を示し、人間の修正を覚える Living Story Bible**

This document is the canonical **mutable implementation and product roadmap** for Narrative Semantic Core, AI-assisted extraction, incremental maintenance, and the Living Story Bible product surface.

It does not replace architectural decisions or machine-readable policy:

- [ADR 004: Narrative Reconciliation Boundary](../adr/004-narrative-reconciliation-boundary.md) owns semantic assessment, deterministic-core limits, and semantic retraction boundaries.
- [ADR 005: Narrative Semantic Core Boundary](../adr/005-narrative-semantic-core-boundary.md) owns the bounded context, Narrative IR, Semantic Build Graph, Retrieval Engine, and adoption principles.
- [ADR 006: Narrative Mutation Origin and Authority Routes](../adr/006-narrative-mutation-authority-routes.md) owns mutation authority routes.
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
| **Planned**  | Ordered and scoped here, but implementation has not started.                      |
| **Blocked**  | The item is defined but cannot start safely until a named dependency is complete. |
| **Deferred** | Intentionally outside the current critical path.                                  |

## Current snapshot

| Area                               | State                 | Evidence / next condition                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gate B2, C0, C1, C1.5              | **Complete**          | Writer authority, Change Feed, semantic contracts, and authority routes are ratified.                                                                                                                                                                                                                                                           |
| Gate C2 foundation                 | **Complete**          | [PR #534](https://github.com/kazormia296/Grimodex/pull/534) landed the shadow Semantic Build Graph, evaluator, publish runtime, maintenance ledger, Verify/Rebuild/Backfill/Repair primitives, and policy contracts.                                                                                                                            |
| C2 identity normalization          | **Complete**          | [PR #535](https://github.com/kazormia296/Grimodex/pull/535) canonicalized Dependency Edge and Application Contribution identities and repaired stored rows.                                                                                                                                                                                     |
| Application Contribution ownership | **Complete**          | [PR #536](https://github.com/kazormia296/Grimodex/pull/536) landed C2 item 4: Contribution provenance, canonical target identities with the SCHEMA rewrite migration, and one-way human ownership behind typed writers.                                                                                                                         |
| C2-2 Consumer granularity          | **Complete**          | Producers declare Edges per Proposal Revision, the canonical vocabulary is ratified in [`policies/narrative/narrative-consumer-contract.json`](../../policies/narrative/narrative-consumer-contract.json), SCHEMA 30 records each Edge's declaring Run, and existing Run-grained Edges are re-keyed from the durable per-Revision Source Basis. |
| Remaining C2-T2 runtime            | **Blocked / Planned** | Reverse lookup wiring, Change-Feed-driven incremental evaluation, Finding identity, and automatic triggers remain.                                                                                                                                                                                                                              |
| C2-Z canonical cutover             | **Blocked**           | Generic Consumer Freshness remains shadow until parity and cutover criteria pass.                                                                                                                                                                                                                                                               |
| First Retrieval Vertical Slice     | **Planned**           | Begins after C2-Z and the minimum shared Narrative IR contract are ready.                                                                                                                                                                                                                                                                       |
| Living Story Bible product Epics   | **Planned**           | Correction Memory, live Structure Health, Change Review, reports, graph exploration, and Map proposals are defined below.                                                                                                                                                                                                                       |

## Critical path

```text
C2-T2: Consumer granularity ───────────────┐
  ↓                                       │
Finding three-layer identity              ├─ in parallel where safe
                                          │
Change Feed → reverse lookup → evaluator ─┘
  ↓
Automatic triggers and interrupted-run recovery
  ↓
C2-Z: Generic Consumer Freshness becomes canonical
  ↓
Shared Narrative IR + First Retrieval Vertical Slice
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

The ordering after PR #536 is intentional: **Consumer granularity → Finding identity**, while the Change-Feed-driven runtime may proceed alongside Consumer granularity once object identity and publish contracts are stable. C2-2 itself is split: the Consumer contract and the identity seams landed first, because the three places Run grain was load-bearing all failed silently rather than loudly (see C2-2 below).

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
- **Complete** — Migration from Run-grained Edges without fabricating cross-run identity. The re-key reads the finer attribution out of `narrative_revision_source_basis`, which stores per Revision the exact `(source_kind, source_key, revision_token)` list each Edge was built from. Edges with no Source Basis row stay under the Run: those are the Legacy Backfill's, which have no Revision to attribute a read to. Re-keying _those_ to the reserved `application` kind is C2-Z's legacy/Generic parity work. An Edge that an Application _also_ declares stays under the Run as well, and the Revision Edges are added beside it — both Producers upsert on the same unique key, so one row could carry two declarations, and deleting it because a Revision matched would silently drop the Application's dependency. The whole step runs inside one savepoint, so a workspace that cannot finish the upgrade is left exactly as it was found rather than stripped of the derived state the block discards on the way in.
- **Planned** — Reverse lookup that returns only affected Consumers. `dependency_edges::find_edges_by_source` exists and is still unwired; C2-1 is what wires it.

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

Verify reports them as `orphaned_attention_finding_keys` instead, so the state is visible rather than silent. Re-homing them is C2-3's Finding identity work, which this roadmap already sequences next.

## C2-1: Change-Feed-driven incremental Freshness runtime

**State:** Planned; may run in parallel with C2-2 after the Consumer contract is fixed

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

- A production trigger owned by one serialized runtime, not a second uncontrolled writer on Workspace open.
- Idempotent cursor reservation, replay, publication, and acknowledgement.
- Epoch and cursor compare-and-swap at publication time.
- Bounded work scheduling and backpressure that never blocks ordinary editing.
- Explicit handling of source deletion, anchor mismatch, exact relocation, read-set drift, and unknown component compatibility.
- Crash recovery for interrupted Runs, Tasks, Attempts, and cursor reservations.

### Exit criteria

- A committed Source mutation reaches the correct Consumers without a manual whole-project Verify.
- Replaying the same Feed range does not duplicate Findings or move Freshness backwards.
- Process interruption cannot leave a permanent `running` Run or an unrecoverable cursor lease.
- The runtime does not reproduce the `SQLITE_BUSY_SNAPSHOT` hazard caused by an independent post-open writer.

## C2-3: Finding three-layer identity

**State:** Blocked on Consumer granularity

### Required identities

1. **Rule identity** — which versioned rule observed the condition.
2. **Observation identity** — what the rule observed in this evaluation.
3. **Material basis identity** — which durable facts make a prior human disposition still applicable.

### Deliverables

- Versioned Rule Registry.
- `observation_digest` independent from material basis.
- Rule-declared material basis digest.
- Correct Attention inheritance across re-evaluation, re-run, and Semantic Epoch rotation.
- Explicit distinction among recurring condition, changed condition, and resolved condition.

### Exit criteria

- Dismiss / hold / acknowledge survives a harmless re-run but lapses when the material basis changes.
- Finding identity does not depend on a transient Run id.
- Semantic Epoch rotation does not invalidate non-epoch-bound human disposition without cause.

## C2-5: Automatic triggers and lifecycle recovery

**State:** Blocked on the incremental runtime and Finding identity

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

**State:** Blocked

### Per-Workspace cutover requirements

- Legacy Dependency Backfill completed.
- Current Semantic Epoch Verify passed.
- No unresolved durable graph errors.
- Rebuild-Derived completed for the current contracts.
- Legacy and Generic Freshness parity is within the ratified contract.
- No active Backfill or Repair Run.
- Incremental runtime is live and cursor-consistent.

### Exit criteria

- Generic Consumer Freshness is the only canonical Freshness read authority.
- Legacy Freshness becomes compatibility-only and can no longer diverge silently.
- Rollback or recovery never creates a second durable Freshness authority.

---

# Milestone M1 — Shared Narrative IR and First Retrieval Vertical Slice

## NIR-0: Shared contract adoption

**State:** Planned

### Deliverables

- Versioned Narrative IR Envelope type shared across feature extractors.
- Assertion Kind, Scope, Modality, Polarity, and Support Class registries.
- Mapping from existing Reconciliation Envelope / Proposal payloads into the shared contract.
- Clear Durable versus Rebuildable storage classification for each Artifact.
- Architecture checks preventing Interpreter output from containing SQL, DB operations, Prepared Commit commands, or Typed Writer commands.

### Exit criteria

- At least one existing extractor emits a validated Evidence-bound Narrative IR Revision without a feature-private authority model.
- Review, Freshness, and Projection state remain separate from the immutable Revision.

## NIR-1: First Retrieval Vertical Slice

**State:** Blocked on C2-Z and NIR-0

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
