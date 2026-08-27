# NIR-0 Shared Narrative IR Implementation Plan

## Status

- **Lifecycle:** Complete — certified Chronicle add-only pilot
- **Milestone:** NIR-0 — C2B activation and Chronicle add-only certification
- **Last updated:** 2026-08-27
- **Stacked base at creation:** PR #551, `codex/c2-parallel-foundations` at `eb428bd75a3ff08936526eaeb82ae58ff7e76146`
- **Contract PR:** `NIR0-00: Narrative Revision Semantics, Native-Verified Human Derivation, Material-Basis Inheritance, Monotonicity, and Project-Scoped Identity Contract`
- **Pilot:** Chronicle `scene-event@1`
- **Certification subject:** base `f78c008088937134d3c0c080ef694891cca225b0`, head `daa20f7d605da9d4c2882bb19b8469c481379353`, tree `1430eeab4c036ab8201dbcf0a8e1192e43152f40`
- **Remote integration:** PR #559 merged as `651791655177538ee02bc7e773f7d98c534ea324` with the same tree
- **Concurrency limit:** At most three active implementation lanes

This document fixes the implementation order and cross-PR ownership for NIR-0. It is subordinate to accepted ADRs and validated machine-readable policy. In particular:

1. ADR 004 owns semantic assessment, deterministic-core limits, and semantic retraction.
2. ADR 005 owns the Narrative Semantic Core boundary, Narrative IR, authority separation, and the rule that Narrative IR is not a Domain mutation command.
3. ADR 009 owns Narrative Scope V2 and Scope Relation.
4. ADR 010 owns Context Set, Dependency Set, Dependency Roles, Selectors, sealed Declaration Sets, and V1/V2 priority.
5. The Narrative Semantic Core roadmap owns mutable milestone sequencing.
6. This plan owns the detailed NIR-0 work breakdown, activation gates, hot-file ownership, and acceptance criteria.

Pull request descriptions and chat history are implementation evidence, not architectural authority.

NIR0-00 was the contract-only foundation. E2.1 is the explicitly ratified
additive exception for the Chronicle AI-audit stage seam: it may carry durable
audit metadata and an ephemeral request-scoped pure sidecar. The certified
NIR0-CERT slice adds the C2B V2 persistence, Native Human writer, activation
markers, and bounded Chronicle add-only production route described below.
PR #559 supplied the clean candidate-bound Quick/Full receipts and merged the
same tested tree into `master`; the completion ledger records that evidence
without widening the certified scope or treating deferred Heavy work as PASS.

---

## 1. Goal

NIR-0 establishes a shared, versioned, Evidence-bound Narrative IR contract and proves it through one existing extractor without introducing a second semantic authority.

The milestone is complete only when Chronicle can persist and read a validated `scene-event@1` Narrative IR Revision while preserving the existing separations among:

- immutable semantic interpretation,
- human review,
- Evidence Freshness,
- Reconciliation Signal,
- Build Action,
- Component Compatibility,
- Projection Application State,
- Application Contribution target state,
- Maintenance ownership.

NIR-0 does not make Narrative IR a universal truth graph, does not replace raw prose, and does not allow an Interpreter to write Domain state.

---

## 2. Fixed architectural decisions

### 2.1 Storage and revision identity

NIR-0 does **not** add a dedicated `narrative_ir_revisions` table.

The durable representation of a root Narrative IR Revision is:

```text
narrative_proposal_revisions.id
  = Narrative IR revisionId
```

The existing `proposal-revision` Consumer remains the Freshness Consumer for this representation. The separately reserved `narrative-ir-revision` Consumer remains `not-yet-modelled`; NIR-0 must not activate it or derive a second identity from payload content.

`revisionId` durability is project-scoped:

```text
guaranteed:
  within one Workspace while the Project exists

not guaranteed:
  after physical Project deletion
  as a globally permanent external identifier
```

Portable references use at least:

```text
projectId
+ revisionId
+ envelopeDigest
+ contractVersion
```

A future Portable Narrative IR export must include the referenced closure rather than assume the original Project remains available.

### 2.2 No separate Narrative IR authority

The following remain distinct:

```text
Proposal Revision + Narrative Revision Envelope
  immutable interpretation authority

Decision ledger
  review authority

Consumer Freshness
  Evidence Freshness authority

Prepared Commit / Typed Writer
  Projection execution authority

Application / Contribution ledger
  applied lineage and field-level bookkeeping

Semantic Index
  rebuildable acceleration structure
```

No new table, read model, cache, renderer store, or feature-local flag may become a second Freshness or semantic authority.

### 2.3 Existing vocabularies are reused

NIR-0 imports the existing Producer Kind and Support Class vocabularies. It must not redefine them.

Producer Kind:

```text
ai-inference
reconciler-proposal
author-declaration
import-metadata
legacy-migration
```

Support Class:

```text
author-declared
direct-source
reported-source
single-source-inference
multi-source-inference
imported-assertion
unresolved
```

The V1 mapping is fixed as:

```text
reconcilerId / reconcilerVersion
  → producer.kind = reconciler-proposal
  → producer.id = reconcilerId
  → producer.version = reconcilerVersion
```

### 2.4 Chronicle pilot scope

The initial wired Assertion Kind is:

```text
scene-event@1
```

The Chronicle pilot wires only:

```text
changeIntent.changeKind = add
```

`revise`, `retract`, `merge`, and `split` remain declared or reserved in the common contract. They are not product-wired by NIR-0. Existing-Projection revision would require a separately ratified Proposal kind and Apply path and is not implied by the existence of a shared `changeKind` vocabulary.

---

## 3. Narrative Revision Envelope V2

The conceptual persisted shape is:

```ts
interface NarrativeRevisionEnvelopeV2<TPayload> {
  readonly schemaVersion: 2;

  readonly assertion: {
    readonly assertionId: string | null;
    readonly assertionKind: string;

    readonly payloadSchemaRef: {
      readonly id: string;
      readonly version: string;
    };

    readonly payload: TPayload;

    readonly scope: NarrativeScopeV2;
    readonly modality: AssertionModality;
    readonly polarity: AssertionPolarity;
    readonly supportClass: AssertionSupportClass;

    readonly producer: NarrativeAssertionProducer;
    readonly producerConfidence?: number;
  };

  readonly assertionDigests: {
    readonly assertionCoreDigest: string;
    readonly scopeDigest: string;
    readonly assertionDigest: string;
  };

  readonly changeIntent: {
    readonly changeKind: "add" | "revise" | "retract" | "merge" | "split";
    readonly targetProjectionRef?: string;
  };

  readonly effectiveMaterialBasis: {
    readonly sourceBasis: readonly SourceBasisEntry[];
    readonly evidenceSet: readonly EvidenceSetEntry[];
    readonly dependencySet: readonly DependencySetEntry[];
    readonly dependencySetDigest: string;
    readonly materialBasisDigest: string;
  };

  readonly revisionBasis:
    | InterpretationRevisionBasisV2
    | HumanDerivedRevisionBasisV2;

  readonly projectionBinding: {
    /** narrative_proposals.kind */
    readonly proposalKind: string;

    /** Reconciliation / Proposal payload schema */
    readonly proposalSchemaRef: {
      readonly id: string;
      readonly version: string;
    };

    readonly proposalPayloadDigest: string;
    readonly adapterContractId: string;
    readonly adapterContractVersion: string;
  };
}
```

`proposalKind` and `proposalSchemaRef` are different vocabularies.

Chronicle example:

```text
proposalKind:
  chronicle.create-event@1

proposalSchemaRef.id:
  narrative.chronicle-event.create

proposalSchemaRef.version:
  1
```

The Native writer recomputes `proposalPayloadDigest` from the actual `payload_json`. A client-supplied digest is never authoritative.

### 3.1 Change Intent invariants

Native preserves the current V1 constraints:

```text
add
  targetProjectionRef forbidden

retract
  targetProjectionRef required
```

A Human-derived Revision must retain the parent's `changeIntent` exactly. Editing title, note, or Disclosure data cannot change `add` into `revise`, introduce a target, or remove a target.

### 3.2 Assertion digest domains

Digests are domain-separated:

```text
assertionCoreDigest
  assertion kind
  payload schema reference
  typed semantic payload
  modality
  polarity
  support class
  Assertion producer
  producer confidence
  excludes Scope

scopeDigest
  canonical NarrativeScopeV2 only

assertionDigest
  assertionCoreDigest + scopeDigest
```

Disclosure-only fields such as Chronicle `secret` and `revealDocumentRef` must not be duplicated in the `scene-event@1` semantic payload. They affect Scope / disclosure derivation, not Assertion Core. This is required for `scope-override` to preserve `assertionCoreDigest`.

---

## 4. Interpretation and Human-derived Revision union

### 4.1 Interpretation basis

```ts
interface InterpretationRevisionBasisV2 {
  readonly kind: "interpretation";
  readonly runId: string;
  readonly taskId: string;
  readonly producer: InterpretationProducerIdentity;

  readonly contextSet: readonly ContextSetEntry[];
  readonly contextSetDigest: string;

  readonly componentContractDigest: string;
  readonly finalRequestDigest: string;
}
```

Interpretation persistence requires live Source revision token validation before save.

### 4.2 Human-derived request boundary

Clients do not submit a completed Human-derived basis, `derivationKind`, `changedPaths`, child Scope, or child digests.

They submit:

```ts
interface CreateHumanDerivedRevisionRequest {
  readonly proposalId: string;
  readonly expectedCurrentRevisionId: string;

  readonly parentRevisionId: string;
  readonly expectedParentEnvelopeDigest: string;

  readonly proposalPayload: Readonly<Record<string, unknown>>;

  readonly adapter: {
    readonly id: string;
    readonly version: string;
  };

  readonly surfaceId: string;
}
```

Native owns:

- parent lookup and CAS,
- canonical old/new Proposal payload diff,
- path classification,
- strongest derivation classification,
- child Assertion and Scope derivation,
- Effective Material Basis derivation,
- digest computation,
- Dependency declaration,
- current-Epoch Freshness initialization,
- final Revision persistence.

### 4.3 Persisted Human-derived basis

```ts
interface HumanDerivedRevisionBasisV2 {
  readonly kind: "human-derived";

  readonly parentRevisionId: string;
  readonly expectedParentEnvelopeDigest: string;
  readonly parentAssertionDigest: string;
  readonly rootInterpretationRevisionId: string;

  readonly derivation: {
    readonly adapterId: string;
    readonly adapterVersion: string;
    readonly kind: "projection-only" | "scope-override";
    readonly proposalPayloadChangedPaths: readonly string[];
  };

  readonly revisionActor: {
    readonly kind: "human";
    readonly surfaceId: string;
  };

  readonly derivationContextSet: readonly ContextSetEntry[];
  readonly derivationContextSetDigest: string;
}
```

`parentAssertionDigest` binds the derivation source. It does not claim that parent and child Assertions are identical. Identity is implied only by the `projection-only` invariants.

A Human-derived Revision's own derivation Context entries may use only these
exposures:

```text
deterministic-stage
author-supplied
```

`model-visible` is forbidden for own entries because no model execution
occurred. Contexts copied from the immediate parent Revision are carried
verbatim under the explicit lineage marker `inheritedFromRevisionId`
(which must equal `parentRevisionId`); an inherited entry keeps its original
exposure — `model-visible` included — as audit provenance of the parent
execution, and rewriting it would falsify that provenance (ADR 011 §4.1).

### 4.4 Producer and Revision Actor are separate

`assertion.producer` records the origin of the semantic Assertion.

`revisionBasis.revisionActor` records who created the later Revision derivation.

Therefore:

```text
AI Assertion + human title edit
  assertion.producer remains ai-inference
  revisionActor is human + surfaceId

AI Assertion + human Disclosure correction
  assertion.producer remains ai-inference
  revisionActor records the correction
  revisionBasis lineage explains the change
```

A human change to the semantic Assertion Core is not silently represented as a projection edit. It requires a future `author-declaration` Source and a new Assertion Revision with `producer.kind = author-declaration`.

NIR-0 reserves but does not wire `assertion-override`.

---

## 5. Native derivation classification

### 5.1 Path classes

The Chronicle Human Derivation Adapter registers path classes.

Initial pilot classification:

```text
projection-only:
  /title
  /note

scope-affecting:
  /disclosure/secret
  /disclosure/revealDocumentRef

assertion-affecting:
  none wired in NIR-0
```

Unknown paths fail closed.

### 5.2 Mixed edits use the strongest classification

`derivationKind` is the strongest class present in the complete Native-computed diff.

Precedence:

```text
assertion-override
  > scope-override
  > projection-only
```

Allowed path sets are cumulative:

```text
projection-only
  projection-only paths

scope-override
  projection-only paths
  ∪ scope-affecting paths

assertion-override
  reserved; rejected in NIR-0
```

Therefore a single save that edits both `title` and `secret` is valid and becomes `scope-override`.

### 5.3 Native invariants

For `projection-only`:

```text
child assertionCoreDigest == parent assertionCoreDigest
child scopeDigest == parent scopeDigest
child assertionDigest == parent assertionDigest
all changed paths are projection-only
```

For `scope-override`:

```text
child assertionCoreDigest == parent assertionCoreDigest
child Scope is deterministically re-derived
child scopeDigest may differ
child assertionDigest may differ
all changed paths are in projection-only ∪ scope-affecting
```

Client-declared `derivationKind` or `changedPaths` are never accepted as authority.

### 5.4 Cross-runtime Scope derivation parity

Initial Scope derivation occurs in the pure TypeScript Chronicle adapter. Human-derived Scope re-derivation occurs in the Native Rust adapter.

Both implementations are bound to one versioned Adapter contract and one shared golden fixture corpus.

The golden corpus must cover at least:

- non-secret event,
- secret event with resolved reveal document,
- secret event with unresolved reveal document,
- title-only edit,
- secret-only edit,
- reveal-document-only edit,
- mixed `title + secret` edit,
- mixed `note + revealDocumentRef` edit,
- unsupported path refusal,
- deterministic canonical Scope digest parity.

TypeScript and Rust must produce byte-identical canonical Scope JSON and identical `scopeDigest`. Neither implementation may independently reinterpret the fixture.

---

## 6. Effective Material Basis and Freshness

### 6.1 Human-derived Revisions materialize their own declarations

A Human-derived Revision is a first-class `proposal-revision` Consumer with its own Revision ID.

It does not read Freshness through a hidden lineage lookup. Native materializes the child's own:

- Source Basis,
- Evidence Set,
- Dependency Set,
- V1 compatibility Edges,
- V2 sealed Declaration Set,
- Edge States,
- Consumer Freshness.

This avoids a second lineage-based Freshness authority and preserves C2's Proposal Revision grain.

### 6.2 Projection-only material basis

For `projection-only`:

```text
Source Basis
  identical to parent

Evidence Set
  identical to parent

Dependency Set
  identical to parent

dependencySetDigest
  identical to parent
```

The declarations are persisted under the child Revision ID.

### 6.3 Scope-override material basis

For `scope-override`:

```text
direct-evidence
opaque-model-context
entity-resolution
  inherited when still applicable

scope-resolution
  re-derived by the versioned Adapter

new Scope / Registry / Oracle inputs
  added when required

obsolete Scope dependencies
  removed

dependencySetDigest
  recomputed
```

### 6.4 Stale edit policy

A stale, source-missing, or unknown Proposal may be edited by a human.

The edit:

- does not make Evidence fresh,
- does not replace missing Evidence,
- does not clear required Build Actions,
- does not bypass Apply-time Source Basis OCC,
- does not perform semantic retraction.

Validation branches by Revision Basis:

```text
Interpretation basis
  require live Source revision token equality before save
  retain NEX_READ_SET_STALE-style refusal

Human-derived basis
  do not require parent token equality with current live Source
  preserve the parent's observed tokens in the child material basis
  require internal quote ↔ quoteDigest consistency
  require Source Basis / Evidence / Dependency structural consistency
  evaluate the child immediately against current live Source
  publish the resulting stale / missing / unknown state
```

The Human-derived save path must not reuse Interpretation validation in a way that reintroduces live-token refusal.

### 6.5 Atomic child Freshness initialization

The persistence transaction is:

```text
parent Revision / current Revision / Envelope digest CAS
  → Native derivation
  → Proposal Revision INSERT
  → Source Basis and Evidence persistence
  → V1 compatibility Edge declaration
  → V2 sealed Declaration Set and Head CAS
  → current Semantic Epoch evaluation
  → Edge State and Consumer Freshness publication
  → narrative_proposals.current_revision_id update
  → COMMIT
```

A child Revision must not become current with zero Edges or unevaluated Freshness merely because its basis is Human-derived.

If the current Source is stale or missing, the new Revision may correctly publish stale or missing. It may not publish `unknown` solely because Dependency declarations were omitted.

---

## 7. V2 monotonicity

Once a Proposal's current Revision is V2, every subsequent Revision must remain V2.

Forbidden:

```text
V2 → V1
V2 → no envelope
V2 → legacy-unbound
V2 → legacy inheritReconciliationEnvelope
```

Allowed:

```text
V2 interpretation → V2 interpretation
V2 interpretation → typed V2 human-derived
V2 human-derived → typed V2 human-derived
```

### 7.1 Typed writer enforcement

The repository writer performs complete semantic validation, including:

- parent/current Revision CAS,
- V2 lineage monotonicity,
- Adapter version,
- digest recomputation,
- derivation invariants,
- material basis,
- change intent,
- Proposal binding.

### 7.2 Trigger defense

A SQLite `BEFORE INSERT` trigger provides structural defense in depth:

```text
current Proposal Revision is V2
and next Revision is not structurally V2 enveloped
  → ABORT NEX_REVISION_ENVELOPE_DOWNGRADE_FORBIDDEN
```

The trigger does not reproduce Adapter or digest semantics; those remain typed-writer authority.

The trigger and schema-bearing writer land only after C2-ZB releases schema ownership.

---

## 8. Scope V2 adoption track

Scope implementation status is capability-specific rather than one coarse state.

The contract records separate states for:

```text
structuralValidation
relationComparison
disclosureAdmission
```

Expected NIR-0 completion state:

```text
structuralValidation
  wired for persisted V2 Narrative Revisions

relationComparison
  implemented and golden-tested

disclosureAdmission
  declared; no production admission entry point yet
```

The current V1 Disclosure evaluator is a contract and fixture implementation, not a wired canonical product admission path. NIR-0 must not describe V2 work as shadowing a production V1 decision that does not exist.

Disclosure adoption remains an independent track:

```text
declared
  → runtime shadow at a real admission Consumer
  → verified cutover
```

NIR-1 pre-ranking disclosure is a likely first Consumer, but it does not own the whole Scope V2 adoption lifecycle.

---

## 9. Chronicle Stage execution provenance

Current Chronicle AI task calls do not carry Run / Task / Attempt identity into the Stage function. NIR-0 adds this only for the Chronicle pilot.

```ts
interface NarrativeStageExecutionContext {
  readonly projectId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly stageId: string;
  readonly stageExecutionId: string;
  readonly parentStageExecutionId?: string;
}
```

Pilot Stage coverage:

- Observation extraction,
- Event synthesis,
- Structured JSON repair.

Structured repair remains an inline fallback inside the same Attempt and is represented as a child Stage execution.

NIR-0 persists:

- Context Set digest,
- Component Contract digest,
- final request digest,
- response digest,
- parse status,
- child repair lineage,
- terminal status.

NIR-0 does **not** claim that raw model response text is currently durable. Default behavior remains:

```text
raw response text
  not retained as a new durable artifact

response digest
  retained

parsed structured result
  retained as the existing Extraction Artifact
```

Full raw-response retention requires a separate privacy, capacity, and audit contract.

### 9.1 E2.1 per-Stage model binding and C1 provenance sidecar

E2.1 ratifies the pure, externally carried provenance contract without thawing
`InterpretationRevisionBasisV2` and without adding a field to the Narrative IR
Envelope. The frozen `revisionBasis.runId + taskId` remains the closure-owner
coordinate. A `ChronicleStageProvenanceBindingV1` sidecar binds that coordinate
to `stageProvenanceClosureDigest` for C1; C2A owns later atomic persistence of
the task output and extraction artifact.

The model-binding digest domain is:

```text
chronicle-stage-model-binding/1
```

Terminal Stage receipts and the v2 Chronicle audit metadata use:

```text
chronicle-stage-terminal-receipt/1
CHRONICLE_STAGE_AUDIT_VERSION = 2
```

The canonical closure domain is:

```text
chronicle-stage-provenance-closure/1
```

`finalRequestDigest` remains request-only and excludes model identity. Model
provider, requested/effective model, endpoint binding ID, API/reasoning mode,
generation mode, and resolution status live in the separately digested model
binding. Endpoint bindings accept only a stable ID or digest; credentials,
origins, and raw URLs are forbidden. Selecting or overriding a provider/model
does not by itself change generation mode: it remains `provider-default` until
a generation-control argument such as thinking, effort, reasoning, or
output-token budget is explicit. Current transport normally records
`requested-only`; it never infers `effectiveModel` as provider-reported.

Each Observation, Event Synthesis, and Structured Repair Stage has its own
binding and terminal receipt. Repair lineage is represented only by the child
Stage's immutable `parentStageExecutionId`; a mutable parent-child pointer is
not closure authority. The C1 closure includes observation and synthesis
receipts from the same Project/Run even when their upstream Task/Attempt differs
from the owner, while a repair parent and child must share Task/Attempt and the
parent must be a failed invalid Observation or Synthesis receipt.

C1 verifies the closure and sidecar against the execution coordinate and the
Envelope's existing `revisionBasis.runId + taskId`. The Envelope remains
unchanged. Model bindings and terminal receipts are durable, non-authoritative
AI-audit metadata; `stage-provenance-closure` is an ephemeral, request-scoped,
non-authoritative application-memory pure sidecar with caller-supplied
membership and no retention. It is not labelled rebuildable until a
deterministic membership selector exists. C2A later owns durable
closure/task-output and extraction-artifact persistence, which is explicitly
deferred here.
Profile/work-profile semantics and Evaluation Contract v2/scorer work remain
out of scope.

---

## 10. C2 sub-gate dependencies

The C2 critical path is:

```text
C2-3 + C2-5A + C2-ZA
  → C2-5B
  → C2-ZB
  → C2-ZC
```

NIR work does not use a single undifferentiated "wait for C2-Z" gate.

### 10.1 D0 — pure Dependency contract work

Starts after PR #551 merges.

Allowed:

- TypeScript and pure Rust Role / Selector types,
- canonicalization,
- effect-rule evaluation,
- fixtures,
- policy validation.

Forbidden:

- schema migration,
- runtime publication,
- canonical Freshness changes.

### 10.2 D1 — sealed Declaration storage

Starts after C2-ZB merges.

D1 owns the next available schema version after the C2-ZB atomic Application re-key and Attention re-home migration.

D1 owns:

- declaration-set tables,
- declaration entries,
- declaration heads,
- typed writer,
- Head version CAS,
- producer-generation monotonicity,
- generated schema contract,
- browser/native schema parity.

### 10.3 D2 — shadow runtime integration

Starts after C2-ZC merges.

D2 owns V2 shadow evaluation in:

- evaluator,
- publish runtime,
- incremental Freshness runtime,
- restore/rebuild verification.

V1 remains canonical unless a later explicit cutover changes the ratified V1/V2 priority.

---

## 11. PR and lane plan

### Wave 0 — contract freeze

#### NIR0-00

**Title:** Narrative Revision Semantics, Native-Verified Human Derivation, Material-Basis Inheritance, Monotonicity, and Project-Scoped Identity Contract

Owns:

- ADR 011,
- ADR 009 capability-status amendment,
- Narrative IR contract policy/schema/fixtures,
- Consumer contract note for `proposal-revision`,
- Human-derived contract,
- mixed-edit strongest classification,
- stale validation split,
- cross-runtime Adapter golden requirement,
- activation rule,
- roadmap authority synchronization with ADR 009/010,
- independent Scope Disclosure adoption track.

No runtime or schema migration.

### Wave 1 — up to three parallel lanes

#### Lane A — Scope and IR kernel

```text
S1 Scope V2 structural core
K0 shared Rust canonical JSON core
K1 Narrative IR registry and TypeScript schema
S2 Scope Relation + ScopeOrderOracle
K2 Rust validator and cross-runtime golden parity
```

#### Lane B — Stage identity and Envelope

```text
E0 Chronicle Stage execution identity
E1 Envelope V2 pure types and V1 adapter
E2 Context-only Prompt Builder and AI Audit binding
E2.1 Per-Stage Model Execution Binding, terminal receipts, and pure C1 closure sidecar
```

#### Lane C — boundaries and pure pilot

```text
G1 Artifact lifecycle / authority classification
G2 Interpreter boundary + second-authority code scan
C1 Chronicle pure scene-event@1 Adapter
```

C1 may start after S1 + K1 + E1. It does not wait for C2-ZB because it is pure TypeScript and performs no persistence.

### Wave 2/3 — completed C2B add-only convergence

The merged implementation contains the required C2B convergence slice:

```text
C2A + D1 + D2 shadow foundations
  → live Scope authority and ScopeOverride adapter
  → atomic child Material Basis / D1 / V1 Edge / Freshness / pointer CAS
  → Chronicle V2 coordinator and atomic proposal-set save
  → C2B Human Native / IPC / review writer
  → bounded activation: scene-event@1 + add only
  → NIR0-CERT
```

### 11.1 Activation gate

Activation is enabled only for the bounded Chronicle `scene-event@1` add pilot.
The active production entry points are the extraction coordinator, atomic
proposal-set save, and the C2B Human-derived revision writer. Direct generic V2
append remains blocked; the existing V1 path is an explicit compatibility
fallback.

The activation update is atomic across policy, schema, validator, and
production markers. It is accepted only with focused migration, persistence,
Freshness, Human title/secret, IPC, and negative-matrix evidence. Disclosure
admission, D2 full V2 authority cutover, and non-add change kinds remain
deferred.

---

## 12. Hot-file ownership

| File or area                                                                | Exclusive owner while active |
| --------------------------------------------------------------------------- | ---------------------------- |
| `docs/plans/narrative-semantic-core-roadmap.md` authority/adoption sections | NIR0-00                      |
| Roadmap C2 status table                                                     | C2-5B / C2-ZB / C2-ZC        |
| Roadmap NIR completion evidence                                             | NIR0-CERT                    |
| ADR 009 and Scope policy/schema                                             | NIR0-00, then Scope lane     |
| `reconciler/types.ts` / Envelope V2 pure contract                           | E1                           |
| shared Rust canonical JSON                                                  | K0                           |
| Narrative IR TS registry/schema                                             | K1                           |
| Narrative IR Rust validator                                                 | K2                           |
| Chronicle pure Adapter                                                      | C1                           |
| Chronicle AI task identity plumbing                                         | E0/E2                        |
| Chronicle review API                                                        | C3                           |
| `migrate.rs` / `workspace_schema.rs`                                        | C2 through ZB, then D1/C2A   |
| `src/db/schema.ts` / generated schema contract                              | D1/C2A                       |
| `repository.rs`                                                             | C2A/C2B                      |
| `reconciliation_envelope.rs`                                                | C2A                          |
| `evaluator.rs`                                                              | D2                           |
| `publish_runtime.rs`                                                        | D2                           |
| `incremental_freshness.rs`                                                  | D2                           |
| `restore_rebuild.rs`                                                        | D2                           |
| semantic boundary validator runtime scans                                   | G2                           |
| central quality/impact manifests                                            | NIR0-CERT                    |

Branches must not edit another active lane's hot files without explicitly re-serializing the dependency graph.

---

## 13. Chronicle Adapter constraints

The existing Chronicle pipeline is nine stages and includes merged Observation processing. The Adapter must consume the complete provenance chain rather than only the lossy Event Hypothesis.

The final `scene-event@1` Adapter input includes:

- Event Hypothesis,
- original and merged Observations,
- Observation references,
- resolved Evidence Anchors,
- attribution,
- narrative frame,
- actuality,
- significance,
- Existing Event match result,
- Source Basis,
- Context manifests,
- Dependency declarations.

Fields currently lost between Observation, Hypothesis, Proposal, and Apply must be explicitly carried into the common typed payload or left as Projection-only metadata according to the registered schema.

The Adapter must not duplicate Disclosure fields into Assertion Core.

---

## 14. Formal PASS

NIR-0 is complete only when all of the following are true.

### Contract and identity

1. `narrative_proposal_revisions.id` is the NIR-0 Revision identity.
2. Project-scoped deletion semantics are documented and tested.
3. No independent `narrative-ir-revision` Consumer is activated.
4. Proposal kind, Proposal schema, payload digest, and Adapter contract are separately bound.
5. TypeScript and Rust canonical JSON / digest output agree.
6. Unknown Assertion Kind, schema version, Producer Kind, Support Class, or Scope contract fails closed.

### Human derivation

7. Clients cannot choose `derivationKind`, `changedPaths`, Scope, child Assertion, or child digests.
8. Native computes the full Proposal payload diff.
9. Mixed `title + secret` edit is accepted as `scope-override`.
10. `scope-override` allows the union of projection-only and scope-affecting paths.
11. `projection-only` preserves all three Assertion digests.
12. `scope-override` preserves `assertionCoreDigest`.
13. TypeScript and Rust Scope derivation pass shared golden fixtures.
14. `assertion-override` is rejected until author-declaration Source support exists.
15. Assertion Producer remains the Assertion origin; human modification provenance is read from Revision Basis lineage.

### Material basis and Freshness

16. Every Human-derived Revision materializes its own Source Basis, Evidence, Dependencies, and Consumer identity.
17. A Human edit cannot create a zero-Edge current Revision.
18. A stale Proposal may be edited.
19. Human-derived validation preserves internal evidence integrity without requiring live token equality.
20. Immediate current-Epoch evaluation retains stale / missing / unknown honestly.
21. Human edit does not clear required Build Actions or bypass Apply-time OCC.
22. No hidden root-lineage Freshness read authority exists.

### Monotonicity and activation

23. V2 cannot downgrade to V1, no-envelope, or legacy-unbound through the typed writer.
24. The structural downgrade trigger rejects non-V2 child insertion after a V2 current Revision.
25. Chronicle production V2 emission is enabled only for the typed
    `scene-event@1` `add` pilot after C2B; other change kinds remain blocked.
26. The Human-derived V2 UI uses the typed C2B writer route; direct generic V2
    append remains blocked and the V1 path is an explicit fallback.
27. Activation changes implementation status, policy/schema state, and
    production entry points atomically.

### Stage provenance and boundaries

28. Every Chronicle pilot AI Stage carries Run / Task / Attempt / Stage identity.
29. Structured repair is a child Stage execution in the same Attempt.
30. Context Set is the only dynamic model-input authority for the pilot.
31. Human-derived Context Set contains no own (non-inherited) `model-visible`
    entry; inherited parent entries keep their exposure under
    `inheritedFromRevisionId` lineage (ADR 011 §4.1).
32. Raw response retention is not falsely claimed.
33. Interpreter modules cannot import or call SQL, DB mutation, Prepared Commit, Typed Writer, Agent Writer, or generic MCP SQL paths.
34. Static validation detects a new unauthorized Freshness authority in code, not only a policy declaration.
    34a. Stage Model Execution Binding V1 fails closed for unresolved, requested-only, provider-reported, and fingerprinted states; endpoint URLs and credentials never enter the binding.
    34b. The v2 Chronicle audit begin and terminal metadata carry the same sealed model binding, model-binding digest, and terminal receipt digest; a Chronicle terminal-hook failure rejects the Stage output.
    34c. Observation, Synthesis, and Repair each emit an independent terminal receipt exactly once; repair lineage is only the child `parentStageExecutionId` and uses the same Task/Attempt as its failed parent.
    34d. A C1 closure is canonical, self-digested, tamper-evident, and reaches the existing Envelope `revisionBasis.runId + taskId` through an external sidecar without changing Envelope V2.
    34e. C1 accepts same-Project/Run upstream Observation and Synthesis receipts with distinct Task/Attempt coordinates, requires both stages, and includes any repair children.
    34f. Model bindings and terminal receipts are durable, non-authoritative AI-audit metadata; `stage-provenance-closure` remains ephemeral, request-scoped, non-authoritative application-memory pure-sidecar material with no retention. It is not rebuildable without a deterministic membership selector. Atomic closure/task-output/artifact persistence is owned by C2A and deferred.

### Scope adoption

35. Scope V2 structural validation is wired for persisted V2 Revisions.
36. Scope Relation and `ScopeOrderOracle` are implemented and golden-tested.
37. Disclosure admission remains explicitly declared until connected to a real product Consumer.
38. NIR-1 may consume the Disclosure track but does not silently become its lifecycle authority.

### Chronicle journey

39. Chronicle persists and reads one Evidence-bound `scene-event@1` Revision.
40. The pilot wires `add` only.
41. Positive journey covers `title + secret` in one Human-derived save.
42. Negative journeys cover unsupported paths, client-forged derivation metadata, digest mismatch, downgrade, zero-Edge child, partial Declaration Set, Head CAS conflict, and model-visible Human context.
43. Review, Freshness, Reconciliation, Build Action, Compatibility, and Projection state remain outside the immutable Revision.

---

## 15. Validation

Each lane runs focused tests and a clean Quick receipt.

Before merge of schema/runtime convergence:

```bash
pnpm test:narrative:semantic-contract
pnpm verify:quality
pnpm ci:local:quick -- --base <resolved-base> --head HEAD
pnpm ci:local:verify -- quick --base <resolved-base> --head HEAD
```

Focused Rust suites include:

```bash
cargo test --manifest-path src-tauri/Cargo.toml \
  -p grimodex-core narrative_ir

cargo test --manifest-path src-tauri/Cargo.toml \
  -p grimodex-db \
  --test narrative_ir_envelope

cargo test --manifest-path src-tauri/Cargo.toml \
  -p grimodex-db \
  --test narrative_dependency_declaration_v2

cargo test --manifest-path src-tauri/Cargo.toml \
  -p grimodex-db \
  --test narrative_ir_upgrade_path
```

Convergence additionally requires:

```bash
pnpm napi:build
pnpm ci:local:full -- --base <resolved-base> --head HEAD
pnpm ci:local:verify -- full --base <resolved-base> --head HEAD
```

Local CI receipts are candidate-bound. A stacked PR based on PR #551 must rerun Quick and Full after rebase / retarget to merged `master`.

The completion ledger is [NIR0-CERT](../certification/nir0/NIR0-CERT.md). It
records the certified candidate base/head/tree, focused suite counts, semantic
contract result, candidate-bound Quick/Full receipts, explicit deferred work,
and remote integration. PR #559 supplied the clean implementation evidence;
its tested tree is byte-identical to merge commit
`651791655177538ee02bc7e773f7d98c534ea324`. The closeout documentation PR
must pass its own ordinary candidate-bound merge checks, but it does not replace
or relabel the certified implementation candidate.

---

## 16. Non-goals

NIR-0 does not:

- create a universal truth graph,
- replace manuscript text with Narrative IR,
- create an independent NIR Revision table,
- activate the reserved `narrative-ir-revision` Consumer,
- wire Chronicle `revise`, `retract`, `merge`, or `split`,
- support human Assertion Core edits without an author-declaration Source,
- cut over Dependency V2 to canonical Freshness authority,
- persist raw model responses by default,
- complete Scope V2 Disclosure admission cutover,
- implement Narrative IR embedding or graph retrieval,
- migrate Codex, Chronicle Domain Projection, Phase, Plot, or Foreshadow schemas wholesale.

---

## 17. Plan maintenance

This plan is updated when:

- a merged PR changes the dependency graph,
- an ADR or policy changes an invariant,
- a lane gains or loses a hot file,
- an activation prerequisite changes,
- evaluation evidence requires a different pilot.

Status updates must name merged implementation evidence. A PR under review is `Active`, not `Complete`.

NIR0-00 and NIR0-CERT own the two planned NIR roadmap updates:

```text
NIR0-00
  authority references
  adoption tracks
  detailed plan link

NIR0-CERT
  completion status
  merged evidence
  production entry points
  deferred work
```

NIR0-CERT has now closed the NIR-0 milestone against PR #559's tested and
integrated tree. C2-ZC retains ownership of the next canonical-authority
boundary; future NIR-1 work must not reopen or silently widen this certificate.
