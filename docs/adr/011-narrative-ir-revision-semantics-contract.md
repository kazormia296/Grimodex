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
the actor who requested or accepted a change. The contract retains the
versioned vocabularies for Assertion Kind, Change Kind, Producer Kind, and
Support Class.

### 3. Native-verified Human-derived revisions

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

### 4. Material basis and stale validation

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

### 5. Cross-runtime Adapter contract

Chronicle's versioned `chronicle.scene-event` Adapter has one golden fixture
corpus. Initial Scope derivation runs in TypeScript; Human-derived Scope
re-derivation runs in Rust. Both must produce byte-identical canonical Scope
JSON and identical Scope Digest for every supported case. Unsupported paths
must be rejected, not interpreted differently by runtime. The corpus includes
mixed-edit strongest classification, stale validation, activation, and parity
cases.

### 6. Activation and Scope adoption

NIR-0 production activation is disabled: V2 emission, Human-derived V2 UI, and
current-Revision promotion remain blocked until C2B, D1, D2, focused
persistence/Freshness journeys, and atomic implementation-status evidence land.
Pure fixture generation is allowed before activation; existing V1 persistence
remains the fallback.

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
  Human-derived, stale-validation, Adapter, and activation invariants.
- The fixture corpus covers all required Scope, mixed-edit, stale-validation,
  activation, and cross-runtime parity cases.
- ADR 009 capability status and its independent Scope Disclosure track are
  machine-readable and remain declared with empty production entry points.
- No NIR-0 commit changes runtime code or database schema/migrations.
