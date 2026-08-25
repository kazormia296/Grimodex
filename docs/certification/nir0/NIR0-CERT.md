# NIR0-CERT — Narrative IR add-only pilot

## Status

**Not certified — remediation and fresh evidence required.** The former
candidate record predates the merge of #556 and #557 into `master` and contains
placeholder receipt identities. It must not be treated as evidence for the
current implementation or as a completed certification.

| Field | Value |
| --- | --- |
| Scope | C2B ScopeOverride materialization + Chronicle V2 `scene-event@1` `add` pilot |
| Historical baseline | `f78c008088937134d3c0c080ef694891cca225b0` (`master` after #556/#557) |
| Candidate | Not yet created for the remediation set |
| Certification evidence | Missing: a clean, candidate-bound Quick and Full receipt with exact base/head |
| Remote status | #556 and #557 are merged; no remediation PR or certification has been created by this document |

## Intended boundary after remediation

The remediation candidate may activate only the typed Chronicle
`scene-event@1` `add` route after all listed controls and fresh evidence pass.
It includes:

- live project Scope authority and Native ScopeOverride derivation;
- child Scope V2/material sidecar, D1/V1 dependencies, current-Epoch
  Freshness, and final current-pointer CAS in one transaction;
- atomic Envelope V2 proposal-set persistence with the existing V1 Edge and
  V1 fallback;
- C1 stage provenance closure and exact Context Set binding in the production
  coordinator;
- C2B Human-derived Native/N-API/IPC/preload/TypeScript review writing;
- activation policy, schema, validator, and production-marker agreement.

The candidate does not claim Disclosure admission, D2 full V2 authority
cutover, or non-add Chronicle semantics.

## Evidence map

| Area                | Evidence                                                                                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scope authority     | [`nir0-c2b-live-scope-authority-impact-matrix.md`](../../plans/nir0-c2b-live-scope-authority-impact-matrix.md); live-tree resolver, restore/rebuild, and Freshness integration tests                                                             |
| Empty Folder guard  | `liveSceneSubtreeImpact` is emitted by tree create/delete/patch and AI plan apply/undo; empty reorder/archive runtime regression proves zero affected Edges and no false stale                                                                   |
| C2B materialization | [`human_materialization.rs`](../../../src-tauri/crates/grimodex-db/src/narrative_extraction/human_materialization.rs); positive ScopeOverride, stale/missing/ambiguous authority, reorder/archive, Freshness, CAS, and rollback tests            |
| Chronicle V2        | [`chronicleV2Production.ts`](../../../src/application/narrative-extraction/chronicleV2Production.ts), coordinator route, production evidence/source-token binding, atomic Envelope+D1+V1 Edge+Freshness save, and `add`-only negative assertions |
| Human review route  | [`nativeApi.ts`](../../../src/application/narrative-extraction/nativeApi.ts), [`ipcContract.ts`](../../../electron/shared/ipcContract.ts), N-API binding, schema-version propagation, typed C2B route selection, and explicit V1 fallback tests  |
| Activation          | [`narrative-ir-contract.json`](../../../policies/narrative/narrative-ir-contract.json), Scope policy, JSON Schemas, semantic validators, and marker scan                                                                                         |
| Change Feed         | [`change-feed-writers.json`](../../../policies/narrative/change-feed-writers.json) registers the C2B Human writer as a typed mutation route                                                                                                      |

## Negative matrix

| Control                                                                                      | Required result                                                                               |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| stale, missing, or ambiguous live Scope authority                                            | fail closed with `NEX_C2B_SCOPE_AUTHORITY_UNAVAILABLE` before DML                             |
| Scope reorder/archive or authority race                                                      | stale validation or CAS failure; no partial child materialization or pointer promotion        |
| missing D1 head, missing current Epoch, zero V1 edge, foreign project, wrong adapter/surface | reject atomically and leave durable state unchanged                                           |
| unsupported Human path or unresolved secret reveal basis                                     | reject; no client-selected derivation or Scope is trusted                                     |
| title-only Human edit                                                                        | preserve assertion/material digests and still materialize the child basis                     |
| title + secret Human edit                                                                    | Native classifies `scope-override`, derives child Scope, and preserves assertion-core lineage |
| missing C1 synthesis receipt or unresolved evidence anchor                                   | coordinator fails closed; no production V2 proposal is saved                                  |
| malformed second V2 proposal in one save                                                     | whole ProposalSet transaction rolls back                                                      |
| direct public V2 append                                                                      | remains blocked; typed C2B Human writer is the only V2 review route                           |
| no AI stage receipt / compatibility path                                                     | explicit V1 fallback remains available without silent V2 downgrade                            |
| empty Folder reorder/archive                                                                 | typed subtree impact is zero; aggregate Edge is not selected or published stale               |
| activation marker/policy/schema mismatch                                                     | semantic validator fails closed                                                               |

## Required verification ledger

The former suite counts and placeholder receipt values are historical notes,
not current evidence. A remediation candidate must run the focused regressions
and the following candidate-bound commands on a clean, committed HEAD. The
receipt files are authoritative only when their resolved base/head match that
candidate and their status is `passed`:

```text
pnpm ci:local:quick -- --base origin/master --head HEAD
pnpm ci:local:verify -- quick --base origin/master --head HEAD
pnpm ci:local:full -- --base origin/master --head HEAD
pnpm ci:local:verify -- full --base origin/master --head HEAD
```

| Receipt | Required identity | Required worktree | Evidence |
| --- | --- | --- | --- |
| Quick | exact committed remediation base/head | clean | [`.artifacts/local-ci/quick.json`](../../../.artifacts/local-ci/quick.json) |
| Full | same exact committed remediation base/head | clean | [`.artifacts/local-ci/full.json`](../../../.artifacts/local-ci/full.json) |

Windows NSIS compilation remains an explicitly retained release-only/manual
item; it is not reclassified as a local Linux pass.

## Deferred work

- D2 full V2 authority cutover and any replacement of the existing V1
  Source-grained canonical Freshness path;
- Scope Disclosure production admission and Retrieval connection;
- Chronicle `revise`, `retract`, `merge`, and `split`;
- universal Narrative IR coverage, embedding/graph retrieval, and NIR1;
- direct generic public V2 append; it remains intentionally blocked while the
  typed C2B Human route owns review materialization.

## Remote integration note

#556 and #557 are already merged into the historical baseline above. The next
remediation must use a new branch/PR and attach a fresh clean Full receipt at
its exact candidate head before this document can be promoted to a certificate.
