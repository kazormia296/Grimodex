# NIR-1 C: typed authority for a Graph target Scene body (DRAFT)

Status: **threat-model draft; no implementation, activation, or user confirmation requested**

Scope: a body excerpt for a Graph-added target Scene in Related Scenes. This is separate from the query Scene A3 proof and from the confirmed Option B `nir1.entity-relation@1` material contract.

This draft specifies the only safe composition that can be proposed from current APIs: Native must independently qualify the actual query path and the pinned target Scene body, then bind both to one request-local result. The target-body half cannot currently reach `eligible`: current Scene authority does not own every required body axis. Those source gaps are blockers, not implied `Any` values or fields to infer from Entity/Relation data.

## Proposed contract boundary

The proposed contract name for discussion is `graph-target-scene-body-disclosure/1`. It is not a registered/current contract. It grants no authority until its threat model is explicitly confirmed and the missing source ownership is resolved.

The future Native reader would take only the live query context and exact candidate identities from the C-query owner. It would read the pin, query path, target Scene scope, target Scene body Source, and all required authorities itself under the owner’s bounded read. Renderer-supplied scope, revision, digest, rank, POV, excerpt, or “eligible” claims would never be inputs to an authorization decision.

The intended typed outcome is:

```text
TargetSceneBodyRead =
    Eligible { exact_excerpt, native_request_local_binding }
  | Unavailable { reason }
```

`Eligible` is constructible only when both independent branches below pass:

1. **Query-path branch:** the exact current Option B Revision, existing Human Decision, canonical Freshness, Graph binding, and A3 proof for the actual query Scene. Use `evaluate_nir1_entity_relation_disclosure` and its matching revalidation contract. This proof stays bound to its original query Scene and its own entity/edge Evidence.
2. **Target-body branch:** the current same-project pin locator; live target Scene identity/incarnation; current target Scene scope; canonical project order; exact bounded body Source and anchor; and a complete target-body disclosure decision covering every required axis. The current A1/Source helpers provide only part of this branch.

Neither branch substitutes for the other. A pin locates a Scene; it does not prove a Relation occurred in the body or authorize the body. Entity `ScopeBinding` and its A3 proof cannot be copied onto the target Scene. If any required target-body authority is missing, unresolved, stale, or ambiguous, return `Unavailable` and emit no target-body excerpt. Current Raw/IR admission is unaffected. Graph remains closed under the existing product gate.

No body, closure, or proof is durably copied by this proposal. It does not add a Source kind, Freshness consumer, authority table, pin token, or IPC activation. If the missing body authority requires durable material state, that is a separate material delta with named writers, invalidation, restore, and acceptance obligations; this draft does not choose its schema.

## Actors, trust boundaries, and untrusted inputs

| Actor or source | Trust and responsibility in this proposal |
| --- | --- |
| Native C-query owner | Trusted to bind the active workspace/database identity, lifecycle/caller epoch, query Scene, query ticket, deadline, cancellation owner, and one shared resource budget. It owns the read and request-local proof. |
| Native canonical readers | Trusted to derive current Option B/A3, project Scope authority, target A1 scope, pin locator, and exact body Source from persisted state. They must fail closed on missing, invalid, stale, or unsupported data. |
| Persisted project and Scene writers | Trusted only for the fields their existing contracts own. `tree_nodes` and the project Scope authority own live Scene membership/order; the Scene-scope writer owns the existing A1 binding; Scene-body writers own the saved body Source; pin writers own a locator relationship. No one of these alone owns all target-body disclosure axes. |
| Renderer / Related Scenes UI | Untrusted for authorization. It may display a Native-approved excerpt and ask Native to revalidate before navigation. A click, hidden UI, cached digest, or user-created pin does not grant body access. |
| Model output, extractor output, cached mentions, imported IDs, caller arguments | Untrusted. They cannot establish an identity, semantic relationship, Scope, reveal state, or currentness claim. |
| Other project/workspace/database copies | Outside the authority of this request. Equal project or Scene IDs across copies do not make a proof portable. |

Attacks in scope include forged/cross-project IDs; stale, moved, deleted, reinserted, or copied pins; Scene ID reuse; hidden, future, or wrong-holder/audience material; missing-axis fallback; Scene edit/restore/import races; stale query/Revision/A3; and stale result or click replay. This contract does not claim that Relation/path Evidence proves the target prose contains the Relation. AI send, extraction, history reuse, export, and external egress remain separate gates and are out of scope.

## Authority and required-check matrix

| Required check | Existing authoritative input and API | Proposed decision | Status / gap |
| --- | --- | --- | --- |
| Query-path identity and approval | `read_nir1_entity_relation_revision`, current decision/Freshness checks, `evaluate_nir1_entity_relation_disclosure`, `revalidate_nir1_entity_relation_disclosure` in `nir1_entity_relation.rs` | Require the exact current reviewed Revision and its existing A3 result for the actual query Scene. Preserve its path Evidence as path Evidence only. | Existing for the path. It does not qualify an arbitrary target Scene body. |
| Project/workspace and query identity | C-query’s active connection/read identity and lifecycle owner; live project rows | Bind query and target checks to this database instance, project, query Scene, and request. Reject another connection epoch, workspace copy, caller epoch, or query. | Existing owner must supply the same binding to the future composition; current `validate_scene_scope` does not establish it. |
| Pin and target membership | Exact `scene_codex_pins` row plus same-project live `tree_nodes` Scene and Codex endpoint; indexed pin reader | Treat pin as locator only. Re-read exact row and both live endpoints; no cache, name, mention, or review-Scene fallback. | Candidate identifies the current row as versionless; use the established request read identity and exact reread. Row identity alone does not prove target-body permission. |
| Target Scene A1 binding | `read_narrative_scene_scope` and `NarrativeSceneScopeBindingV1`; `validate_scene_scope` in `nir1_graph/scenes.rs` | Require explicit compatible target binding; exact project/Scene/incarnation/token; matching timeline, worldline, narrative layer, holder, audience; strict reading-before-query based on Native-derived ranks. | Existing partial check. `validate_scene_scope` explicitly does not load project authority, check reveal, or prove lifecycle/read identity. Its expected ranks are caller inputs to the helper, not authority. |
| Reading position | `load_live_project_scope_authority` over live `tree_nodes`; mappings contain Scene references and `reading_rank` | Resolve both target and query mappings from the same current Native authority and require target rank `<` query rank. Missing/ambiguous identity is unavailable. | Source supports ordering. Existing A3 applies reading-before to typed Entity Scope; no current target-body A3 reader composes this check with body disclosure. |
| Story position | Current project Scope authority mappings derived from `tree_nodes.story_time_order` | Require a resolved target/query comparison whenever the target-body policy requires Story order; never convert unresolved order to “not future.” | Authority supplies order, not a body-level Story material classification. It is insufficient alone to authorize every sentence in the target body. |
| `story` and `auto` material constraints | Confirmed Option B `ScopeBinding` carries `reading`, `story`, `auto`, `phase`, `reveal`, `pov`, and `authorityRevision` for each typed Entity. A3 interprets those fields for those Entities. | Evaluate a target-body-specific constraint for the whole returned body; do not reuse the typed Entity fields as if they described the target Scene. | **Unresolved source gap:** `NarrativeSceneScopeBindingV1` has only timeline/worldline/narrative-layer query identity and material constraints, plus holder/audience. It has no target Scene `story`/`auto` fields. No complete existing body-level owner was found. |
| `phase` | A3’s `load_a3_phases` reads the typed Codex Entity’s base `context_mode` and `codex_entry_phases`; phase resolution is evaluated against the query. | A target-body rule must establish that every part of the returned body is admissible at the query’s current phase. | **Unresolved source gap:** these rows are Entity-owned. No Scene-body phase membership or complete mapping from body text to phase-gated material is present in the current A1 binding. |
| `reveal` / secrecy | A3’s reveal reader checks the typed Entity’s foreshadow/reveal state; `ScopeBinding.reveal` is checked against the existing reserved audience vocabulary. | Require all secrets represented by the whole target body to be revealed for this query and audience. An unknown secret/reveal state denies. | **Unresolved source gap:** Entity foreshadow rows do not classify all prose in a Scene. The current Scene binding has audience but no body-level reveal state or complete prose-to-reveal mapping. |
| POV | A3’s `read_scene_viewpoint` reads the query Scene’s `tree_nodes.pov_character_id` and validates the visible character; A3 compares Entity POV against that query viewpoint. | A target-body decision must check the target’s own current POV against the query’s permitted viewpoint semantics. | **Partial / unresolved:** the query POV reader can address a Scene ID, but current A3 uses it for the query Scene and checks Entity Scope. The contract for applying one Scene POV to the whole target body, including paragraphs/overrides, is not established here. Do not copy query POV onto the target. |
| Timeline, Worldline, layer, holder, audience | Existing A1 `queryIdentity`, `materialConstraint`, `knowledgeHolder`, and `audience`, read from the current Scene-scope authority | Require explicit compatible target state and exact permitted matches; no fallback from missing or unknown values to an unrestricted value. | Existing fields/readers cover these dimensions, subject to the separate full-currentness bracket and lifecycle binding. |
| Exact body Source and anchor | `read_retrieval_scene_source_bounded`; Source key `project:scene:<id>`, revision token, normalizer, storage/canonical digests, UTF-16 length; existing Scene anchor reader | Admit only the exact source revision and exact canonical anchor/range returned by Native. Do not repair drift by searching similar text. A valid Source is necessary, never sufficient authorization. | Existing bounded source reader; its output is not disclosure authority. G-01’s expected one-paragraph Mira range is `[0,78)` and does not itself establish permission. |

The full-body requirement matters: an excerpt/anchor is disclosable only if the authority covers every unit in that exact returned range. Entity names, summaries, relation Evidence, a pin, and a matching first-line range do not prove that the rest of the body has no future, secret, wrong-POV, or wrong-audience content.

## Follow-up source audit and minimum options (read-only, 2026-09-23)

This audit traced the current persisted columns, Native readers, and the principal existing writer paths. It narrows the missing-source claim: some temporal/identity checks can be derived from current authority, but none supplies a complete body-wide policy for the required axes.

| Axis or source | Current durable state and reader | What it can establish for a target body | Remaining limit |
| --- | --- | --- | --- |
| Exact Scene body | `tree_nodes.content`, `version`, and `updated_at`; `read_retrieval_scene_source_bounded` returns the exact saved/canonical Source and digests. `save_scene_body_bundle` also records foreshadow anchors and beat-POV IDs. | Exact bytes, canonical range, and current Source identity. The body save refreshes the existing Scene Scope source token in its transaction. | Text identity does not classify the text. Neither a Source token nor a derived sidecar proves whole-body disclosure. |
| Reading / Story position | The live project Scope authority is recomputed from non-archived project-tree rows. Reading rank comes from persisted DFS order; Story rank comes from `tree_nodes.story_time_order` and is unresolved when the current mapping cannot resolve it. | Native can resolve exact target and query mappings and reject missing or unresolved ranks. The existing target helper can compare ranks only when its caller supplies them. | It is an ordering authority, not a body-material classification. The current typed A3 applies reading/story checks to Option B Entity Scope, not to an arbitrary pinned body. |
| Auto axis | `projects.phase_resolution_mode` stores `reading`, `story`, or `auto`. `disclosure_precheck::scene_axis::resolve` selects the temporal axis for a Scene and explicitly says it does not resolve Scope constraints or grant disclosure. Option B `ScopeBinding.auto` is separately interpreted for a typed Entity by A3. | The current project mode and live project mapping can select a temporal comparison axis; unresolved Story coverage can fall back according to the existing axis-choice contract. | Axis selection is not target-body permission. Treating a Scene’s time position as the equivalent of an Entity’s `auto` material binding needs explicit contract semantics; current code does not make that conversion. |
| Phase | `codex_entry_phases` stores phases owned by a Codex entry, including anchor Scene and `context_mode_override`. A3’s `load_a3_phases` and phase resolver read them for each typed Entity. | It can resolve phase eligibility for the relevant Codex Entity in the current A3 path. | No Scene-body phase owner or complete mapping from body text to every referenced Entity/phase is present. `projects.phase_resolution_mode` chooses an ordering axis; it is not a phase assignment for Scene prose. |
| Reveal / secret | `foreshadows` stores `secret`, payoff Scene/range, payoff confirmation, and abandoned state; `foreshadow_setups` stores anchored ranges; `foreshadow_codex_links` links foreshadows to Codex entries. `read_a3_reveal_state` starts from links for the typed Entity. | The existing A3 reader can veto a linked Entity when a saved secret is not yet disclosed. The Scene body writer keeps known anchor rows tied to a body save. | No current reader establishes that every secret-bearing passage in a target body is represented by those rows or linked Entities. No matching mark cannot mean “contains no secret.” A3’s Entity-level reveal result cannot certify a whole body. |
| POV | `tree_nodes.pov_character_id` stores the Scene-level POV. The Scene body save receives beat POV overrides and maintains `scene_beat_pov_cache`. A3’s `read_scene_viewpoint` validates the query Scene’s `pov_character_id`; it does not read target-body or beat POV state. | The persisted Scene-level POV and the existing derived beat-POV cache can be inspected as possible inputs. | There is no typed target-body reader that validates all POV changes in the returned range against the query. The beat cache is derived, and there is no current proof here that it is a complete, current, position-bound disclosure authority. |
| Timeline / Worldline / layer / holder / audience | A1 `NarrativeSceneScopeBindingV1` stores query identity and material constraints for timeline, worldline, and narrative layer, plus knowledge holder and audience. `read_narrative_scene_scope` validates the live Scene and principals; `validate_scene_scope` performs the narrower explicit A1 comparison. | These fields support the existing exact scope/holder/audience checks when the target and query bindings are current. | The binding is `narrative-scene-scope/1`; it contains no target-body reading/story/auto/phase/reveal/POV policy. The Scene helper is not the full live-authority/currentness reader. |

The existing durable writer boundary is also narrower than the needed body policy. The Scene Scope row is versioned and source-tokened; `update_narrative_scene_scope` is its Native writer and `narrative_scene_scope_update` is its current typed IPC operation. Body saves, temporal updates, and several restore/bulk paths call `refresh_scene_scope_source_token_in_tx`; that refresh changes the A1 row’s version/token/timestamp but does not assert or invalidate a body-wide semantic classification, because no such classification exists today. The current writer list therefore does not provide an implicit Scene-body A3 source.

### Option A — reuse current sources only

This is the smallest design with no storage or IPC delta:

1. Revalidate the actual query path with the exact existing Option B A2/A3 reader. Never call it with the target substituted for the query or transfer its query proof.
2. Re-read the exact current target pin, target A1 binding, same-project live Scene, and bounded Scene body Source. Derive both Scene ranks from the live project Scope authority; require strict target Reading-before-query. When the fixed policy also needs Story/Auto order, use only resolved current project mappings and the current axis-selection contract; an unresolved or ambiguous comparison denies.
3. Treat current A1 timeline/worldline/layer and holder/audience matches as necessary gates. Read the target Scene-level POV and any known body annotations only as additional veto inputs unless their completeness/currentness is separately proved. Do not interpret missing annotations as unrestricted content.
4. Return `Unavailable` for the target body while phase/reveal/POV coverage across the exact returned range remains unproved.

This option can safely establish current location, order, selected axis, A1 scope, exact body identity, and some known Entity/annotation vetoes. It cannot produce an eligible whole-body excerpt under the requested story/auto/phase/reveal/POV checks. G-01 consequently remains Hold; this is not a route to PASS through path-only UI or fixture changes.

### Option B — one explicit body-wide authority extension

If the product needs an eligible whole-body excerpt, the smallest persistence candidate is a **versioned extension of the existing Native-owned per-Scene Scope authority**, rather than a second consumer/table or an Entity/Relation Revision. This would be a new contract and storage change, not a clarification of A1 v1. Keep it separate in type and meaning from Option B Entity `ScopeBinding` even if a later approved contract reuses parts of its closed vocabularies.

The proposed authority owner would be the project author making an explicit declaration through a Native-owned Scene Scope write; Native would validate and persist it. This would make a new trust assumption: the reader trusts the author’s declaration as the classification of the whole body, not as proof that the prose or any Entity/Relation assertion is true. That assumption is not approved today.

The extension would be an explicit author-owned declaration that covers the entire bound Scene body, with closed required decisions for the body’s Reading/Story/Auto semantics, phase, reveal/audience, and POV, alongside existing A1 scope/holder/audience. It must bind to the exact current Scene incarnation and exact `project:scene:<id>` body Source revision; it must never silently widen a body’s scope because an axis is absent. A single body-wide profile is eligible only when it safely covers the entire returned range. If a body mixes policies and the contract cannot express their intersection, the whole-body read stays unavailable; a per-span authority would be a larger, separate design.

The mechanics that can be named without inventing current fields are:

| Delta area | Minimum proposed responsibility | Current boundary / decision still needed |
| --- | --- | --- |
| Persisted owner | Extend the existing `narrative_scene_scope_bindings` contract in a new version with a typed body-wide disclosure component and exact body Source binding. Its canonical source token and project Scope extension digest must include this component. | No such component or body Source binding exists. Do not retrofit current explicit v1 rows; legacy/missing v2 disclosure state must be unavailable. If Scene Scope is not accepted as owner for whole-body disclosure, stop and design a separate authority instead. |
| Writer | Extend the Native `update_narrative_scene_scope` transaction and its versioned payload to accept an explicit author declaration, validate references against same-project live authorities where they exist, and persist by OCC version. Reject dimensions whose value domain or authority is still undefined. Model/extractor output cannot write a qualifying declaration. | The current payload only writes A1 v1 axes and holder/audience. Extending it changes persisted contract and `narrative_scene_scope_update` validation/UI. The authorization role of a human whole-body declaration must be confirmed. |
| Body saves and imports | Bind the declaration to the current canonical body Source. On any body edit/save/rename/revision restore/import/backup restore or Scene incarnation change, leave its old bound body Source unmatched so the reader denies it. Requalification requires an explicit declaration against the new current Source, or a single atomic author save that supplies and validates both. | Existing `refresh_scene_scope_source_token_in_tx` must not auto-rebind the disclosure declaration to new text. The complete writer inventory must include `save_scene_body_bundle`, other body/domain writers, revision restore, snapshot/import/restore, and generic protected DB writes. Existing calls refresh A1 state but do not establish new body semantics. |
| Scope and authority mutations | Always resolve target/query Reading/Story/Auto against current project Scope authority; current A1 token/principals must match; source revisions for target POV and any phase/reveal dependencies used by the confirmed semantics must be current. | The contract must choose whether phase/reveal are human-declared whole-body constraints or are derived from exhaustive body-to-Codex/foreshadow links. Existing phase/reveal readers are Entity-specific and cannot be promoted silently. Changes to policy-defining inputs must stale the declaration or fail its exact dependency comparison. |
| Native reader | Add a Native-only target-body disclosure reader that consumes the actual query A3 proof as a separate required gate, the exact current target binding, the body-wide declaration, current target/query mappings, and bounded Source. It returns `Eligible` only after each required axis resolves. | This reader does not exist. It must not manufacture an Entity or Revision to reuse A3. It must not accept renderer-supplied body policy or treat a pin, query A3, body Source, or matching bytes as permission. |
| Persistence lifecycle | Reuse the existing Scene Scope version/source-token/change-feed boundary where possible. Keep the body declaration request-local at read time; persist only the author’s compact scope declaration and exact bound Source identity, never the body or transitive closure. On deletion/reuse/restore, issue a new incarnation or remain unqualified. | The current A1 read/source token must be versioned to include the extension and body binding. Restore/copy semantics and old v1 migration default must be made explicit before implementation. No new Freshness consumer is justified by this proposal. |
| IPC/UI | Prefer a versioned extension to the existing typed Scene Scope update/read boundary if the existing owner is confirmed; Native revalidates and renderer receives only safe status/eligible excerpt. Otherwise add a separate typed command with equivalent main-side validation and workspace binding. | `ipcContract.ts` currently validates only the v1 payload. Adding authorable body policy changes the shared contract and Scope Editor; no IPC is changed here. The renderer never submits a proof or direct excerpt request bypassing Native. |
| Invalidation and return/click | Include the body binding, Scene Scope token/version, project Scope revision, source identity, path proof identity, and active read identity in a request-local binding. Freshly re-read all of them after the build snapshot before return and immediately before click. A changed body, declaration, current axis, or workspace yields no body and requires a new query. | The current candidate has no integrated return/click proof. Existing A3 revalidation applies to the path’s original query Scene only. |
| Acceptance | Positive: a human-declared explicit body-wide binding on the exact fixture Source, independently valid query A3, current target A1 and project authority, and exact expected anchor at both return and click. Negative: absent/legacy/unresolved axes, invalid human writer data, each scope/order/POV/phase/reveal/body mutation, restore/import/ID reuse, stale return/click, and every existing fixed resource/cancellation bound. | This would make the actor trust explicit: the application trusts the human’s whole-body classification after Native checks its references and freshness. Whether that is an acceptable semantic defense must be decided in the threat model. If not, only an exhaustive per-span classification or another equally complete source could replace it; current links/caches do not prove exhaustiveness. |

This extension is a design candidate only. It changes A1 persistence/IPC meaning and cannot be approved as a small code detail. Its concrete field vocabulary, exact phase/reveal semantics, body coverage claim, migration rule, and actor trust are deliberately left open for user review; no current field is claimed to exist for them.

## Return and click currentness

The native request-local binding must tie together the active workspace/database identity and epoch; exact query Scene and query source/scope identity; Graph generation/roster and the exact Revision, Decision, Freshness, and path-A3 identity; pin row observation and both endpoints; target Scene ID/incarnation and current A1 scope version/token; project Scope authority revision and target/query ranks; body Source revision/storage digest/canonical digest/normalizer; and the exact UTF-16 excerpt range and bytes. This is a binding recipe over existing identities, not a new persisted authority or renderer seal.

Before returning an excerpt, close the build snapshot, open the prescribed fresh read identity, and re-read/revalidate every dependency that granted it. Before a click follows the Scene or anchor, perform the same currentness check again against the returned binding. A second SELECT in the old WAL read transaction is not proof that another connection’s commit is visible. Reject changed pin/body/scope/order/phase/reveal/POV/decision/Freshness, workspace switch, restore/import, deletion, ID reuse, or mismatched read identity. Do not rescue an old binding by equal IDs, equal bytes, cached renderer digest, approximate text match, or a new path proof for a different query.

On currentness failure, return `Unavailable` for the Graph body, remove its Graph contribution from the completed result, and require a new query. Keep the existing R+IR result under its existing admission. A body-currentness proof does not by itself authorize additional Scene metadata or a different navigation route.

## Resource, cancellation, and acceptance contract

The composition must share the existing C-query budget end-to-end; no nested helper may reset a counter or install/replace the connection progress hook:

| Bound | Fixed contract retained |
| --- | --- |
| Read/admission | 512 |
| Batch | 16 × 32 |
| SQLite work | 100,000 VM steps, cancellation/deadline checkpoint each 1,000 steps |
| Cumulative bytes | 2 MiB across query, A2/A3, pin, target A1, project Scope authority, body JSON/canonicalization, UTF-16 anchor, retained proof, and serialization |
| Graph time | 8 ms; no reader/busy wait |
| Graph shape | At most 2 hops, 12 discovered Entities, 144 qualified edge expansions, 8 returned Scenes |

These are existing fixed values, not a claim that the proposed composition has met them. Current evidence still leaves simultaneous 2 MiB retention and a production 8 ms successful path unproved. A target-body A3 composition may not add a separate allowance or borrow B’s whole-project build budget. Measure the real integrated success path and peak retained bytes against the existing limits; if it cannot fit, record a Hold rather than changing a limit.

One C-query owner must carry cancellation through queue admission, SQL before the first row, the A3/Scope readers, body-length preflight, parsing/canonicalization, anchor construction, revalidation, and serialization. Use the existing dedicated read-only connection/lifecycle participant; never occupy or interrupt Raw’s connection. On timeout, cancellation, malformed/oversized input, mutation, or any failed authority, produce no partial Graph body and retain ownership until SQL, readers, buffers, and cleanup have actually ended. Do not reuse the connection or publish the late result before cleanup completes.

Acceptance must include:

- A positive fixture where each required axis is explicitly authoritative and current, the query-path A3 proof is for the actual query Scene, the target is separately qualified, the exact expected body anchor is returned, and return/click checks both succeed.
- Negative cases for wrong project/workspace; wrong query or target; absent, stale, moved, deleted, reinserted, or ID-reused pin; cross-project endpoint; non-explicit/unknown/legacy A1; missing/unresolved/future Reading or Story; unresolved Auto fallback; hidden/invalid phase; unrevealed secret; absent or wrong POV; holder/audience/timeline/worldline/layer mismatch; stale decision/Freshness/Revision; source/scope/order mutation; body edit/restore/import; wrong canonical range; and changed authority between build, return, and click.
- Resource and cancellation cases at exact limits and limit+1, including oversized body before allocation, expensive A3 materialization, mutation during the query, cancellation at every processing boundary, Raw non-occupation, and proof that late work is cleaned up before connection reuse.
- The existing fixed G-01/Gold/metrics comparison unchanged. The proposed disclosure path must reach the predeclared Graph-added body expectation under the existing 2 MiB/8 ms bounds; an always-unavailable result, helper-only pass, path-only result, or post-observation fixture/Gold/metric edit is Hold, not G-01 PASS.

No Cargo or test work is requested by this design draft.

## Persistence and IPC implications

Option A adds no database field/table, Scope axis, assertion family, Evidence copy, Freshness consumer, body copy, or IPC command; it remains fail-closed for the target body until the missing semantic authority exists. Its query request still uses the existing typed boundary, and Native resolves all authority rather than trusting renderer claims.

Option B is the versioned A1 storage/IPC delta described above. It would change the current Scene Scope persisted contract and update payload, including old-row handling and every body-save invalidation path. The body declaration is durable; the combined proof stays request-local. Neither option persists the body or transitive closure, creates an independent Freshness consumer, opens a Graph renderer entry, or gives the renderer a replayable authority token. The renderer can receive only a Native-approved safe excerpt and navigation metadata after the still-separate product gate is satisfied.

Option B is not selected. It remains a candidate because the current sources cannot establish the required complete target-body axes. Do not infer missing values, extend `NarrativeSceneScopeBindingV1` in place, repurpose Entity `ScopeBinding`, make a pin authoritative, or infer disclosure from body text. Any persistence/writer/IPC change requires the separate confirmation described below.

## GDX-PRECHECK-001 confirmation needed before implementation

This document is not the user-confirmed threat model. GDX-PRECHECK-001 requires explicit confirmation of the exact threat-model ref before security-sensitive implementation; a broad approval of the post-B plan or Option B Entity/Relation contract is not that confirmation. The current source gaps mean this draft is not yet ready for confirmation.

Before asking for that confirmation, the proposal owner must resolve and show:

1. The exact trusted and untrusted actors, including which Native readers/writers own each target-body axis and who may mutate those authorities.
2. The in-scope and out-of-scope attack list, including whether only the exact excerpt or also the Scene locator/title/navigation is disclosed.
3. The exact authoritative rule and source for target-body `story`, `auto`, `phase`, `reveal`, and `POV`, or an explicit fail-closed disposition for any axis the source cannot support. The rule must cover the entire returned range and cannot reuse query A3 or Entity Scope as target permission.
4. Required mutation, restore, import, currentness, resource, cancellation, negative, and positive acceptance outcomes, with the fixed Gold/metrics/2 MiB/8 ms contracts retained.
5. Whether to retain Option A’s fail-closed behavior or adopt Option B’s explicit human-authored body-wide authority extension. Option B means durable state, new writer responsibilities, a schema/contract migration, and an IPC/editor payload change; it cannot be silently included in approval of Option A or the post-B plan.

If Option B is selected, only after those points are concrete should the user be asked to confirm a versioned/ref-addressed threat model for `graph-target-scene-body-disclosure/1`. That confirmation must name the exact draft ref and confirm its actors/boundaries, attack scope, defenses, and acceptance implications. Implementation, Graph activation, and product acceptance remain separate gates even after confirmation.

## References

- `docs/plans/nir1-post-b-execution-plan.md` §§6.3–7
- `docs/plans/nir1-c-scene-body-disclosure-delta-draft.md`
- `docs/plans/nir1-c-scene-connection-candidate.md` §§2–4, 7, 10–11
- `src-tauri/crates/grimodex-core/src/narrative_nir1.rs` (`ScopeBinding`)
- `src-tauri/crates/grimodex-core/src/narrative_scene_scope.rs` (`NarrativeSceneScopeBindingV1`)
- `src-tauri/crates/grimodex-core/src/narrative_project_scope_authority.rs`
- `src-tauri/crates/grimodex-db/src/narrative_extraction/project_scope_authority.rs`
- `src-tauri/crates/grimodex-db/src/narrative_extraction/scene_scope.rs`
- `src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_graph/scenes.rs` (`validate_scene_scope`)
- `src-tauri/crates/grimodex-db/src/narrative_extraction/disclosure_precheck/scene_axis.rs`
- `src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_entity_relation.rs` (A3 evaluate/revalidate, phase, reveal, and query POV readers)
- `src-tauri/crates/grimodex-db/src/narrative_extraction/retrieval_admission/scene_source.rs`
- `src-tauri/crates/grimodex-db/src/scene_body.rs`, `temporal_operations.rs`, `chronicle_bulk.rs`, `revision_restore.rs`, and `project_snapshots.rs` (existing Scene body/order/POV update and Scope refresh paths)
- `src/db/schema.ts` and `src-tauri/crates/grimodex-db/src/migrate.rs` (current Scene, phase, reveal, and A1 persistence)
- `electron/shared/ipcContract.ts` and `src/features/editor/sceneMeta/SceneScopeEditor.tsx` (current A1 IPC/editor contract)
- `policies/quality/iron-laws.md#GDX-PRECHECK-001`
