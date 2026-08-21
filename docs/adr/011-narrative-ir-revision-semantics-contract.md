# ADR 011: Narrative IR Revision Semantics Contract

## Status

Accepted — 2026-08-21 (NIR-0 contract freeze)

This ADR fixes the shared Narrative IR revision semantics for the NIR-0
contract-adoption milestone. The machine-readable contract is
`policies/narrative/narrative-ir-contract.json`; its JSON Schema is the
corresponding file under `policies/narrative/schemas/`. This ADR is
subordinate to ADR 004's semantic-assessment boundary, ADR 005's Narrative
Semantic Core boundary, ADR 009's Scope contract, and ADR 010's Context Set /
Dependency Role contract.

NIR-0 freezes policy, schema, fixtures, and validators only. It does not add a
database table, persistence migration, runtime writer, production Entry Point,
or product activation.

## Context

Narrative IR must be portable across extractors without becoming a second
semantic or Freshness authority. A root interpretation already has a durable
identity in `narrative_proposal_revisions.id`, while the reserved
`narrative-ir-revision` Consumer has no durable row. Human edits must be able
to refine a Proposal without pretending that an edited field was reinterpreted
by a model or that a stale Source became fresh.

The Chronicle `scene-event@1` pilot also needs one Native/TypeScript boundary:
Scope derivation is initially pure TypeScript, while the Human-derived path is
Native Rust. Independent implementations would otherwise create byte-level
Scope and digest drift.

## Decision

### 1. Identity and authority separation

The Narrative IR `revisionId` is
`narrative_proposal_revisions.id`, and its Consumer kind is
`proposal-revision`. The identity is project-scoped and durable while the
Project exists. Portable references include `projectId`, `revisionId`,
`envelopeDigest`, and `contractVersion`. Heuristic identity derived from
payload content is forbidden. The separate `narrative-ir-revision` Consumer
remains `not-yet-modelled`.

That durability is not guaranteed after physical Project deletion, and the
Revision ID is not a globally permanent external identifier. A portable
Narrative IR export must include the referenced closure and must not assume the
original Project remains available.

The immutable Revision / Envelope, review decision, Evidence Freshness,
Projection Application, Application Contribution, and rebuildable Semantic
Index remain separate authorities. Narrative IR is not a Domain mutation
command, a truth verdict, or a replacement for the manuscript.

### 2. Versioned Envelope and digest domains

NIR-0 uses Envelope V2. The Envelope preserves the root-level Change Intent
exactly, separates Proposal kind/schema from the typed Native payload, and
requires Native recomputation of the payload digest. Assertion Core, Scope,
and combined Assertion digests are domain-separated; Chronicle disclosure
fields `secret` and `revealDocumentRef` are Scope/disclosure inputs, not
Assertion Core fields.

Producer identity (the component that produced an assertion) is distinct from
the actor who requested or accepted a change. ADR 005 remains the semantic
authority for Assertion Modality and Assertion Polarity; ADR 011 binds those
categories to the following machine IDs for Narrative IR interchange:

| ADR 005 category | Machine ID |
| --- | --- |
| 本文での明示 | `modality-explicit-text` |
| Narrator claim | `modality-narrator-claim` |
| 伝聞 | `modality-hearsay` |
| Character belief | `modality-character-belief` |
| Inference | `modality-inference` |
| Hypothesis | `modality-hypothesis` |
| Author declaration | `modality-author-declaration` |
| Imported assertion | `modality-imported-assertion` |

Assertion Polarity uses exactly `affirmative`, `negative`, and
`uncertain`. The `modality-` namespace deliberately avoids collisions with
the imported Producer Kind and Support Class IDs. Their ratified vocabularies
remain owned by their existing contracts; the Narrative IR policy mirrors them
only as a fail-closed compatibility binding and neither redefines their meaning
nor creates a second registry.

The fixed V1 compatibility mapping sets
`producer.kind = reconciler-proposal`, `producer.id = reconcilerId`, and
`producer.version = reconcilerVersion`. Adapters must not reinterpret that
mapping.

The Chronicle `scene-event@1` pilot product-wires only
`changeIntent.changeKind = add`. The shared `revise`, `retract`, `merge`,
and `split` values remain declared or reserved; their presence in the common
vocabulary does not imply product wiring. Existing-Projection revision requires
a separately ratified Proposal kind and Apply path.

### 3. V2 monotonicity and enforcement ownership

Once a Proposal's current Revision is V2, every subsequent Revision must remain
V2. The forbidden transitions are V2 to V1, no envelope, legacy-unbound, and
legacy `inheritReconciliationEnvelope`.

The typed writer is the complete semantic authority. It validates parent/current
Revision CAS, V2 lineage monotonicity, Adapter version, digest recomputation,
derivation invariants, material basis, Change Intent, and Proposal binding.

A future SQLite `BEFORE INSERT` trigger is structural defense only. It aborts
a structural downgrade with
`NEX_REVISION_ENVELOPE_DOWNGRADE_FORBIDDEN`; it does not reproduce Adapter or
digest semantics. The trigger and schema-bearing writer land only after C2-ZB.
NIR-0 freezes this rule but adds no trigger, writer, schema migration, or runtime
Entry Point.

### 4. Native-verified Human-derived revisions

Clients submit only the Proposal identity, expected revision/envelope values,
the edited payload, Adapter identity, and surface identity. Native owns the
canonical old/new diff, path classification, strongest derivation
classification, child Assertion/Scope, material basis, dependency declaration,
Freshness initialization, and all digests. Client-supplied derivation metadata,
Scope, child assertion, and digests are rejected.

Chronicle path classes are:

- projection-only: `/title`, `/note`;
- scope-affecting: `/disclosure/secret`, `/disclosure/revealDocumentRef`;
- assertion-affecting: reserved and currently empty.

Classification precedence is
`assertion-override > scope-override > projection-only`. A mixed edit uses
the strongest class and a scope override carries the cumulative union of
projection-only and scope-affecting paths. Unknown paths and client metadata
fail closed; assertion override is reserved/rejected in NIR-0.

### 5. Material basis and stale validation

A Human-derived child is a first-class `proposal-revision` Consumer with its
own Revision ID. It materializes its own Source Basis, Evidence Set,
Dependency Set, sealed declarations, V1 compatibility Edges, Edge States, and
Consumer Freshness. It never obtains Freshness through hidden root-lineage
lookup, and a zero-edge current Revision is forbidden.

Interpretation saves retain live Source revision-token equality and refuse a
stale read (including `NEX_READ_SET_STALE`). Human-derived saves preserve the
parent's observed tokens, validate internal quote/digest and dependency
consistency, evaluate against current live Source, publish stale/missing/
unknown state immediately, and retain Apply-time OCC. They do not require live
Source-token equality before save.

### 6. Cross-runtime Adapter contract

Chronicle's versioned `chronicle.scene-event` Adapter has one golden fixture
corpus. Initial Scope derivation runs in TypeScript; Human-derived Scope
re-derivation runs in Rust. Both must produce byte-identical canonical Scope
JSON and identical Scope Digest for every supported case. Unsupported paths
must be rejected, not interpreted differently by runtime. The executable
corpus covers initial Scope derivation, Human-derived old/new payload diffs,
mixed-edit strongest classification, unsupported-path refusal, and
cross-runtime canonical/digest parity. The stale-validation split and activation
gate remain contract-level JavaScript tests rather than duplicate golden cases.

### 7. Activation and Scope adoption

NIR-0 production activation is disabled: V2 emission, Human-derived V2 UI, and
current-Revision promotion remain blocked until C2B, D1, D2, focused
persistence/Freshness journeys, and atomic implementation-status evidence land.
Pure fixture generation is allowed before activation; existing V1 persistence
remains the fallback.

The disabled-state validator scans only the configured production roots
`src`, `electron`, and `src-tauri` for the exact reserved activation
markers. Documentation, policy, fixtures, and test files are not activation
evidence. A reserved marker found in production while production Entry Points
remain empty fails the contract.

Scope Disclosure adoption remains an independent ADR 009-owned track. Its
capabilities (structural validation, relation comparison, and disclosure
admission) are declared independently and progress through `declared`,
`shadow`, and `wired`; Narrative IR activation cannot imply Scope cutover.

## Consequences

- Extractors share one versioned, Evidence-bound contract while the existing
  Proposal Revision remains the durable identity.
- Human edits preserve author intent and can publish stale state without
  falsely refreshing Evidence.
- Cross-runtime golden fixtures make canonical Scope output testable before a
  runtime cutover.
- The contract freeze adds no runtime or persistence authority, so production
  behavior remains on the existing V1 path until the explicit activation gate.

The costs are additional native validation, material-basis bookkeeping, golden
fixture maintenance, and explicit future cutover evidence.

## Non-goals

- Adding or migrating a `narrative_ir_revisions` table.
- Enabling Chronicle V2 production writes or a Human-derived V2 UI.
- Making Narrative IR a universal truth graph or replacing raw prose.
- Letting an Interpreter write Domain state or silently mutate review,
  Freshness, or Projection authorities.
- Making `narrative-ir-revision` a second Consumer before it has a durable row.

## Acceptance criteria

- Policy and schema bind to this ADR and validate the exact Envelope, identity,
  V2 monotonicity, Chronicle add-only pilot, Human-derived, stale-validation,
  Adapter, and activation invariants.
- The executable fixture corpus covers Scope derivation, Human-derived
  classification, unsupported-path refusal, and cross-runtime parity; separate
  semantic contract tests cover stale validation and activation.
- ADR 009 capability status and its independent Scope Disclosure track are
  machine-readable and remain declared with empty production entry points.
- No NIR-0 commit changes runtime code or database schema/migrations.
