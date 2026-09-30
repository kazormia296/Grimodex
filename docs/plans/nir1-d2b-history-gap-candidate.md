# NIR-1 D2b history gate: mapping and contract gap

This note records the D2b-2-history lane mapping for the post-B candidate. It is
an implementation boundary record; it does not activate history reuse, Graph
qualification, sending, or any AI provider path.

## Existing authority readers

| Authority | Current reader | What it can establish |
| --- | --- | --- |
| A2 Entity/Relation | `narrative_extraction/nir1_entity_relation.rs`: `read_nir1_entity_relation_revision_current_for_revision` and its typed-revision core | The exact current approved Revision, current Decision, live sources/evidence, and canonical Freshness attached to that Revision. |
| A3 disclosure | `narrative_extraction/nir1_entity_relation.rs`: `evaluate_nir1_entity_relation_disclosure` and `revalidate_nir1_entity_relation_disclosure` | Query-scene source/incarnation, live Scope authority, reveal/phase state, material scene proofs, and transient decision/freshness identity tokens for the exact A2 Revision. |
| B Graph | `narrative_extraction/nir1_graph.rs`: `Nir1GraphReader::open`/`register_with_control`/`query`; compatibility `read_nir1_graph` | A registered sealed Graph reader can be queried only through the owned Native/control path. The compatibility reader returns `registration-required`; it is not Graph qualification. |
| Scope | `narrative_extraction/retrieval_admission/query_context.rs`: `read_retrieval_query_context`; `retrieval_admission/scene_source.rs`: `read_retrieval_scene_source`; `scene_scope.rs`: `read_narrative_scene_scope` | Current query-scene source and the current Scope/authority snapshot. A3 also rechecks its live material-scene Scope constraints. |
| Freshness | `narrative_extraction/revision_eligibility.rs`: `read_revision_canonical_freshness`; composed by `retrieval_admission.rs`: `read_revision_retrieval_eligibility` | Current semantic epoch, dependency/declaration digests, feed acknowledgement/head, and canonical consumer/edge/source freshness. It does not itself qualify Index, approval, or scheduler liveness. |

The D2b history turn must re-read these authorities for every candidate and
must reject stale, unknown, incomplete, or inconsistent results. A stored
permission, display row, restore/undo identifier, or legacy history row cannot
promote itself into authority.

## D2b storage references

`nir1_generation.rs` currently stores immutable metadata and references:

- `AttemptBinding` records project/session/profile/caller epochs, workspace
  binding digest, `GenerationPurpose`, Scope/material/D1 digests, route, and
  provider identity.
- `InputReference` targets are `Message`, `Artifact`, `RawSource`,
  `AcceptedRevision`, or `GraphEvidence`.
- `QualificationReference` kinds are `Source`, `Revision`, `Decision`,
  `Freshness`, `Index`, `Scope`, and `D1`.
- Generated message versions retain `parent_attempt_id`; human binding is
  explicit and current-role checked, so arbitrary legacy rows are not
  promotable.
- The storage `ReadBudget` bounds child references and serialized reference
  bytes. `GenerationHistoryReadBudget` now adds caller-owned node, edge, and
  qualification-reference counters, and the same ledger is passed to the
  pure traversal through the crate-private snapshot hook. Retained bytes and
  SQL/body limits are still charged by the storage reader; cancellation is
  checked by the adapter between reads, but the hook has no read-internal
  cancellation/progress callback yet.

No body, thinking text, or transitive closure is copied into a history row.

## Gate verdict

The confirmed `nir1-l6-l9-contract-proposal/3#history-reauthorization` row
already requires the full exact tuple, Scope axes, classifications, and parent
artifact/generation receipt. The disjoint history module now implements the
bounded pure traversal and the storage adapter compiles against the
crate-private same-snapshot reader, but the current D2b rows still do not
preserve enough authority data to qualify a real candidate. This is an
implementation gap against the confirmed contract, not a request for a new
authority or a new approval. The remaining gaps and relevant adapter status are:

1. **Cancellation checkpoints: focused PASS; hard sub-operation latency
   unproven (2026-09-23).** The snapshot callback and typed reader now share the
   participant's stop/deadline control; the SQLite progress handler checks it
   every 1,000 VM steps. Code checkpoints before/after typed attempt, message,
   terminal, and artifact reads; between input/qualification reference fetches
   and JSON deserialization; around attempt-binding and terminal JSON parsing;
   and around MessageVersion/body/metadata materialization. The scoped storage
   validation passed **49/49 generation/history tests** plus **1/1 participant
   control test** [`storage-cancel-final-2.log`](../../.artifacts/nir1-post-b/storage-cancel-final-2.log)
   [`storage-control-regression.log`](../../.artifacts/nir1-post-b/storage-control-regression.log).
   The explicit cancellation cases prove owner-stop observation between typed
   reads and rejection of already-cancelled/expired control before SQL, with a
   reusable connection [`nir1_generation/tests.rs:238-277`](../../src-tauri/crates/grimodex-db/src/nir1_generation/tests.rs)
   [`narrative_maintenance_connection.rs:1464-1505`](../../src-tauri/crates/grimodex-db/src/narrative_maintenance_connection.rs).
   They do not prove a hard response-time bound inside one SQLite operation,
   one JSON parse, or another synchronous sub-operation. The 1,000-step
   progress interval is not a wall-clock latency guarantee; no hard
   per-sub-operation latency claim is made.
2. The stored binding has only a coarse `scope_digest` and `GenerationPurpose`.
   It does not preserve the complete per-turn Scope axes (reading order,
   story time, viewpoint, knowledge holder, audience, Timeline, Worldline,
   narrative layer, and scene), input-use classification, or send
   classification. Reconstructing those values from a digest would invent
   authority, so the gate must fail closed until current metadata is exposed.
3. An `Artifact` reference carries only `artifact_id` and `payload_digest`.
   It does not identify the producing attempt/receipt, so full transition
   ancestry through generated artifacts cannot be traversed or bounded.
4. `GraphEvidence` has source/revision identity only. It has no sealed Graph
   Index/Decision/Freshness binding, and the public B reader is unavailable
   until registration/C-query. Graph-derived acceptance therefore remains
   pending C-query.
5. Qualification kinds are opaque identity/version pairs and may be absent;
   storage does not define which authority kinds are required for each input
   target or bind them to the complete Scope/query tuple. A history gate needs
   explicit current validators for A2/A3/B/Scope/Freshness/Index/D1.
6. D1 is represented by a digest only; storage does not expose selected item,
   role, or budget evidence needed to prove current input use.

## Minimal extension for D2b storage review

This remains a review record for the D2b storage owner. The storage owner has
implemented the snapshot hook and shared caller-owned ledger described below;
the full tuple, producer receipt relation, and authority participation remain
unimplemented. This shape does not add an authority, a policy identifier, a
capacity number, a send gate, or a product entry point.

### Full history tuple

Persist one immutable turn binding alongside the existing attempt binding. A
single binding is shared by all adopted history inputs in that turn; the input
ordinal still identifies each input's own qualification refs.

The binding needs these existing-contract values or references:

- project/session and the existing attempt/workspace epoch binding;
- the existing envelope or generation-receipt reference for the adopted turn;
- revision identity/bundle identity for each accepted revision used by an
  adopted input;
- the existing material and D1 references, including the D1 selection/budget
  evidence returned by the current D1 owner;
- the existing Scope reference plus the canonical current values/tokens for
  `readingOrder`, `storyTime`, `viewpoint`, `knowledgeHolder`, `audience`,
  `timeline`, `worldline`, `narrativeLayer`, and `scene`;
- the existing purpose, input-use, and send-classification values, using their
  current allowlists and rejecting unknown values; and
- the existing creation and expiry times.

The stored values are comparison anchors, never authority. On every turn the
history reader must compare them with the current A2/A3, Scope, Freshness,
Index, D1, and receipt readers in the same read snapshot. A missing envelope,
full Scope axis, input-use value, send classification, or D1 selection proof
therefore makes the candidate unavailable. A digest may remain as a compact
identity check, but it cannot replace the referenced current tuple.

### Parent artifact and receipt lineage

Keep the existing `Message` shape for generated messages and require its
`parent_attempt_id` to agree with the immutable `MessageVersion`. In the same
snapshot, resolve that parent attempt, its terminal receipt, and the message
body/version digest before following its direct inputs.

Extend the `Artifact` reference shape for history use with the existing
producer-attempt identity and terminal-receipt identity in addition to
`artifact_id` and `payload_digest`. The reader must resolve the artifact, its
producer attempt, and its receipt as one chain and reject a missing, changed,
cross-project, or mismatched link. An artifact without an existing producer
receipt is not a history ancestor; the reader must not infer one from an
artifact row, session, or display state.

Traversal follows only the parent attempt recorded on an adopted generated
message or artifact. It does not search a session for siblings or infer a
branch from timestamps. Thus a selected `X -> M1 -> M2` chain retains every
transition ancestor of `M2`, while an unselected sibling remains excluded.
No body, thinking text, or closure is copied into the binding.

### Per-input mandatory qualification set

For every input ordinal classified as adopted history, require exactly one
current reference of each existing kind: `Source`, `Revision`, `Decision`,
`Freshness`, `Index`, `Scope`, and `D1`. Each reference identity/version must
match both its direct target and the current authority reader. The turn-level
Scope and D1 refs must also match the input's refs. Duplicate, omitted,
unknown, or target-mismatched kinds are incomplete, never implicitly safe.

The target-specific minimum is:

| adopted target | additional lineage requirement |
| --- | --- |
| Generated `Message` | Immutable message version, exact parent attempt, successful terminal receipt, and body/receipt agreement. |
| `Artifact` | Existing artifact identity/digest, producer attempt, terminal receipt, and producer/body agreement. |
| `AcceptedRevision` | Revision identity/bundle digest agreement with the current A2/A3 readers. |
| `RawSource` | Source/revision identity agreement with the current Source reader; it still needs the full set when classified as history. |
| `GraphEvidence` | The same full set, with `Index` accepted only after the existing C-query/sealed Graph reader proves it. Until then the candidate is pending/unavailable. |

An explicitly bound current human message may remain a direct current input
through the existing `bind_human_message` path. It does not satisfy the
history qualification set, and an unbound legacy, imported, restored, or
display-only message cannot be promoted by this extension. Any future
target-specific relaxation of the seven-kind set requires an explicit
contract change; this design does not infer one.

The pure traversal therefore uses two input paths: adopted history inputs
must carry all seven qualification kinds, while an explicitly current-bound
human input is checked by the current binding/qualifier path and does not
inherit a stale historical qualification set. The adapter still rejects a
message whose immutable project, session, parent, origin, or role binding does
not match the attempt.

### Same-transaction traversal hook

The storage owner now exposes one crate-private, read-only snapshot hook to
the history module. The implemented shape follows the existing
`read_attempt_in_tx` and `read_message_version_in_tx` helpers without exposing
raw SQL:

```text
with_generation_history_snapshot(db, &mut caller_budget, |reader, shared_turn_budget| {
  read_snapshot(reader, shared_turn_budget)
})
  -> Result<owned_history_result>
```

The implemented hook starts one caller-owned read transaction and keeps it
open until the callback returns. The typed reader provides exact attempt
metadata, ordered direct refs, message versions/bodies, terminal receipts, and
the existing artifact identity/digest through that same transaction. Artifact
producer links are currently `None`, because the schema has no confirmed
immutable producer receipt relation. It does not call public per-row readers,
open nested transactions, claim an attempt, write an invalidation marker, or
dispatch transport. The callback returns owned data only after the transaction
closes.

The history module owns the traversal algorithm and passes one shared,
caller-supplied turn budget through every ancestor and branch. The budget
tracks the already-required node/edge visits, SQL/read work, reference and
resolved-body bytes, retained memory, wall deadline, and cancellation cleanup;
it has no per-candidate reset and no newly invented default limit. The reader:

1. starts from the explicitly adopted input ordinals;
2. reads each attempt at most once in the snapshot and follows only recorded
   generated-message/artifact parent links;
3. checks every ancestor's tuple and complete qualification set before marking
   it current-qualified;
4. detects missing parents, cycles, invalidated/changed versions, and receipt
   mismatches as candidate exclusions;
5. treats shared read/traversal budget exhaustion, current-authority
   unavailability, and cancellation as request-wide errors, so no earlier
   qualified candidate can escape in a partial success result;
6. propagates an incomplete or stale ancestor to that candidate and all
   affected descendants, while allowing an independently rooted valid branch
   to continue; and
7. shares already-validated snapshot results for common ancestors without
   dropping an ancestor because the model says it was unused.

The current hook does not yet accept A2/A3/B/Scope/Freshness/Index/D1
authority readers against the same database connection. The pure adapter
therefore leaves the stored full tuple as `None`, and `reauthorize_history`
returns candidate-specific incomplete/fail-closed results rather than treating
stored digests as current authority. It never turns an opaque qualification
identity into current authority by itself. This keeps Graph-derived acceptance
pending C-query and leaves dispatch/send outside the history module.

### Coordination and review boundary

The full tuple still needs a D2b-owner decision about placement in the
existing binding JSON or an immutable child reference, plus an exact authority
reader contract. The disjoint
`src-tauri/crates/grimodex-db/src/nir1_generation_history.rs` contains the pure
traversal, a `HistoryBudgetLedger` adapter, and the storage-hook adapter;
the latter deliberately maps the current missing full tuple and absent artifact
producer receipt to `None`, so the real storage path still fails closed.
`lib.rs` now registers the module as crate-private; no product route/export,
migration, provider, or send path is enabled by this module.

Until those implementation gaps are closed, the required semantics remain a
design constraint rather than an enabled path: walk every transition ancestor of an
adopted history, exclude branch siblings, enforce a bounded whole-turn budget,
never promote arbitrary legacy rows, and requalify every ancestor at the
current turn. Any missing parent, cycle, version mismatch, limit, stale
authority must make that candidate incomplete and exclude it with affected
descendants; independent valid branches may continue. A shared limit,
unavailable current authority, or cancellation stops the whole turn.

Focused verification after registration:

- DB crate history filter: `nir1_generation_history::tests`, **15 passed,
  0 failed**, with 1710 unrelated tests filtered out.
- Storage owner’s preceding `nir1_generation` filter: **29 passed, 0 failed**.
- Non-test adapter compile: `cargo check -p grimodex-db --lib` completed
  successfully after fixing the `read_terminal` `Result<Option<_>>` adapter
  shape; only existing/dead-code warnings remain.
- `rustfmt --edition 2021 --check
  src-tauri/crates/grimodex-db/src/nir1_generation_history.rs` passed.

These are focused implementation checks, not full history acceptance. Full
tuple/Scope authority, producer receipt lineage, same-snapshot authority
participation, read-internal cancellation, and Graph/C-query acceptance remain
Hold; product send and history activation remain closed.
