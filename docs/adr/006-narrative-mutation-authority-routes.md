# ADR 006: Narrative Mutation Origin and Authority Routes

## Status

Accepted — 2026-08-14（Gate C1.5）

Amended — 2026-08-15（Gate C2, C2-T1 Transport Assembly）: added the
`attention-typed-writer` route. See "Attention Typed Writer" below.

This ADR ratifies the mutation authority boundary used by ADR 004 and ADR 005.
It does not change the existing low-level `origin` field or introduce a new
database table. The machine-readable contract is
`policies/narrative/mutation-authority-routes.json`.

Caller authorization is a positive, fail-closed allowlist. Only a route's
`allowedCallers` can grant access; absence from `forbiddenCallers` never grants
access. `forbiddenCallers` is diagnostic-only, and the two lists must be
disjoint.

## Context

The C1 Change Feed records the low-level origin of a mutation:

```text
human | ai-apply | import | undo | redo | restore | migration
```

That audit attribute is not sufficient to describe who was allowed to cross
the mutation boundary. In particular, an explicit author command such as
“create a Codex entry” and a Reconciler projection produced from an
interpretation are both observable as `ai-apply`, but have different review,
provenance, and authority requirements.

## Decision

`origin` and `authorityRoute` are separate concepts. `origin` remains an
immutable, low-level audit attribute. Every canonical C1 operation additionally
declares exactly one `MutationAuthorityRoute`:

```ts
type MutationAuthorityRoute =
  | "human-direct"
  | "interactive-agent-command"
  | "interpreter-projection"
  | "import-apply"
  | "history-replay"
  | "restore-or-migration"
  | "attention-typed-writer";
```

Unknown and unclassified routes fail closed.

### Human Direct Authoring

```text
Human UI
  → Runtime Policy / Actor Context
  → OCC / Field Authority
  → Typed Writer
  → Domain Data
```

Human Direct Authoring does not require a Proposal. It does require the typed
writer, actor context, OCC, the canonical Change Event, and Change Feed
controls.

### Interactive Agent Command

```text
User Turn / Standing knowledgeWrite Authority
  → Agent Tool Policy
  → Typed Writer
  → Domain Data
```

An Interactive Agent Command is an authoring surface, not an Interpreter. It
does not require a Proposal when the user has explicitly authorized the
command, but it always requires:

- `knowledgeWrite` capability;
- stable request identity;
- chat message, tool call, and trace provenance;
- a Typed Writer and OCC;
- Field Authority admission;
- Undo Journal lineage;
- canonical Change Event and Change Feed emission.

Background maintenance, idle schedulers, and Reconcilers may not call this
route. A chat tool executor, an explicitly registered manual wrapper, or a
registered Agent Surface may call it.

### Interpreter Projection

```text
Semantic Interpretation
  → Narrative IR / Proposal Revision
  → Decision
  → Prepared Commit
  → OCC / Field Authority
  → Typed Writer
  → Domain Projection
```

Interpretation-originated mutation may not bypass Proposal, Decision, or
Prepared Commit. A Reconciler never returns SQL, a DB operation, a Prepared
Commit command, or a Typed Writer command as its output.

### Import, History, and System Routes

`import-apply` is the explicit Import application route. AI extraction may not
write Domain Data directly through it.

`history-replay` is reserved for Undo and Redo and requires original
transaction and journal lineage. It is not semantic truth correction.

`restore-or-migration` is reserved for Restore, Migration, and Integrity Repair
operations. These may emit a Semantic Epoch Reset and request a full rebuild;
they do not pretend to be a set of ordinary row-level mutations.

`ai-apply` is intentionally ambiguous between the Interactive Agent Command
and Interpreter Projection routes. Callers must provide `authorityRoute`
explicitly; no canonical writer may infer a route from `ai-apply`.

### Attention Typed Writer

```text
Human UI (Maintenance Inbox)
  → Typed Writer
  → narrative_maintenance_attention
```

None of the six routes above fit a Maintenance Attention disposition
(`policies/narrative/maintenance-attention-contract.json`:
`storageClass: "durable-user-state"`, `epochBinding: "none"`,
`backflowPolicy: "forbid"`). Every existing route either requires OCC plus
the canonical Change Event and Change Feed controls (Human Direct,
Interactive Agent Command, Import, History Replay), the Proposal/Decision/
Prepared Commit pipeline (Interpreter Projection), or is reserved for
Restore/Migration/Integrity Repair. Attention is none of these: it is a
single upsert or delete against one durable, non-epoch-bound row, with no
OCC, no Proposal, and — by contract — no Change Feed emission at all.

`attention-typed-writer` requires only the Typed Writer control. Only a
Human UI caller (the Maintenance Inbox) may use it; Background Maintenance,
the Reconciler, and idle schedulers are forbidden callers, matching
`maintenance-attention-contract.json`'s negative fixture that Run publish,
Finding Observation writes, and epoch rotation must never mutate these rows.

## Invariants

1. `origin` and `authorityRoute` are stored and reasoned about independently.
2. Human Direct Authoring does not require a Proposal.
3. Interactive Agent Command is an explicitly authorized authoring route.
4. Standing authorization is still bounded by Agent Tool Policy and provenance.
5. Background AI, Maintenance AI, Reconciler, and idle scheduler code cannot
   use the Interactive Agent Command route.
6. Semantic Interpretation mutation always uses Proposal, Decision, and
   Prepared Commit.
7. Undo, Redo, Restore, and Migration remain independent system routes.
8. Caller authority comes only from `allowedCallers`; `forbiddenCallers` is
   diagnostic-only, and an unknown caller fails closed.
9. `allowedCallers` and `forbiddenCallers` are disjoint, and each list is
   unique where present.
10. `ai-apply` never receives an implicitly inferred authority route.
11. An unknown or unclassified route is a hard validation error.

## Consequences

The C1 Change Feed manifest is now a complete authority-route inventory. The
route controls are machine-readable and checked by
`scripts/quality/validate-semantic-core-boundary.mjs`. C1.5 does not change
the C1 `origin` vocabulary, add a dependency graph, or bump the workspace
schema (SCHEMA 22 remains unchanged).

The same typed Native Writer may be used by several routes, but the operation
manifest must classify the caller's authority route for each operation. This
keeps shared writer implementation from becoming an implicit authority grant.

## Rejected alternatives

- Treating every `ai-apply` as an Interpreter would incorrectly force explicit
  user commands through a Proposal and obscure their authoring provenance.
- Treating every Agent Writer call as an Interactive Agent Command would allow
  background code to acquire user-turn authority by importing a shared helper.
- Adding a second `origin` enum would mix audit history and authority policy and
  make C1 Change Feed consumers ambiguous.
