# NIR0-CERT — Narrative IR add-only pilot

## Status

**Candidate certification.** This document is the evidence ledger for the
NIR-0 completion slice on the local candidate branch. It becomes a final
certificate only after the final clean HEAD has a passing Full receipt and the
remote stacked-PR merge evidence is recorded.

| Field | Value |
| --- | --- |
| Scope | C2B ScopeOverride materialization + Chronicle V2 `scene-event@1` `add` pilot |
| Candidate branch | `codex/nir0-c2b-atomic-materialization` |
| Candidate HEAD | to be filled after the final certification commit |
| CI base | `origin/master` at the exact Full receipt base SHA |
| Remote status | PR #556 and PR #557 remain open; no push, rebase, or merge was performed by this slice |

## Certified boundary

The candidate activates only the typed Chronicle `scene-event@1` `add` route.
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

| Area | Evidence |
| --- | --- |
| Scope authority | [`nir0-c2b-live-scope-authority-impact-matrix.md`](../../plans/nir0-c2b-live-scope-authority-impact-matrix.md); live-tree resolver, restore/rebuild, and Freshness integration tests |
| Empty Folder guard | `liveSceneSubtreeImpact` is emitted by tree create/delete/patch and AI plan apply/undo; empty reorder/archive runtime regression proves zero affected Edges and no false stale |
| C2B materialization | [`human_materialization.rs`](../../../src-tauri/crates/grimodex-db/src/narrative_extraction/human_materialization.rs); positive ScopeOverride, stale/missing/ambiguous authority, reorder/archive, Freshness, CAS, and rollback tests |
| Chronicle V2 | [`chronicleV2Production.ts`](../../../src/application/narrative-extraction/chronicleV2Production.ts), coordinator route, atomic repository save, and `add`-only negative assertions |
| Human review route | [`nativeApi.ts`](../../../src/application/narrative-extraction/nativeApi.ts), [`ipcContract.ts`](../../../electron/shared/ipcContract.ts), N-API binding, and review API fallback tests |
| Activation | [`narrative-ir-contract.json`](../../../policies/narrative/narrative-ir-contract.json), Scope policy, JSON Schemas, semantic validators, and marker scan |
| Change Feed | [`change-feed-writers.json`](../../../policies/narrative/change-feed-writers.json) registers the C2B Human writer as a typed mutation route |

## Negative matrix

| Control | Required result |
| --- | --- |
| stale, missing, or ambiguous live Scope authority | fail closed with `NEX_C2B_SCOPE_AUTHORITY_UNAVAILABLE` before DML |
| Scope reorder/archive or authority race | stale validation or CAS failure; no partial child materialization or pointer promotion |
| missing D1 head, missing current Epoch, zero V1 edge, foreign project, wrong adapter/surface | reject atomically and leave durable state unchanged |
| unsupported Human path or unresolved secret reveal basis | reject; no client-selected derivation or Scope is trusted |
| title-only Human edit | preserve assertion/material digests and still materialize the child basis |
| title + secret Human edit | Native classifies `scope-override`, derives child Scope, and preserves assertion-core lineage |
| missing C1 synthesis receipt or unresolved evidence anchor | coordinator fails closed; no production V2 proposal is saved |
| malformed second V2 proposal in one save | whole ProposalSet transaction rolls back |
| direct public V2 append | remains blocked; typed C2B Human writer is the only V2 review route |
| no AI stage receipt / compatibility path | explicit V1 fallback remains available without silent V2 downgrade |
| empty Folder reorder/archive | typed subtree impact is zero; aggregate Edge is not selected or published stale |
| activation marker/policy/schema mismatch | semantic validator fails closed |

## Verification ledger

Focused evidence already green on this candidate includes:

- semantic boundary: 128 writer operations classified; Narrative IR contract:
  10 golden cases;
- Electron IPC contract suite: 407/407;
- N-API integration suite: 131 passed, 1 intentional fixture skip, 0 failed;
- C2A persistence: 22/22;
- C2B Human request compile/negative matrix: 38/38;
- live Scope authority runtime: 11/11;
- Chronicle production adapter: 3/3; coordinator: 4/4;
- TypeScript and Electron TypeScript checks: passed;
- Rust formatting, focused DB checks, and live Scope Freshness tests: passed.

Final candidate-bound receipts must be appended here after the final commit:

```text
pnpm ci:local:quick -- --base origin/master --head HEAD
pnpm ci:local:verify -- quick --base origin/master --head HEAD
pnpm ci:local:full -- --base origin/master --head HEAD
pnpm ci:local:verify -- full --base origin/master --head HEAD
```

| Receipt | Base SHA | Head SHA | Result | Evidence |
| --- | --- | --- | --- | --- |
| Quick | pending | pending | pending | local receipt generated from the final candidate HEAD |
| Full | pending | pending | pending | local receipt generated from the final candidate HEAD |

## Deferred work

- D2 full V2 authority cutover and any replacement of the existing V1
  Source-grained canonical Freshness path;
- Scope Disclosure production admission and Retrieval connection;
- Chronicle `revise`, `retract`, `merge`, and `split`;
- universal Narrative IR coverage, embedding/graph retrieval, and NIR1;
- direct generic public V2 append; it remains intentionally blocked while the
  typed C2B Human route owns review materialization.

## Remote integration note

The local certificate cannot record merged evidence until the stacked remote
sequence is completed: merge PR #556, retarget/rebase PR #557 onto the latest
`master`, then obtain a new clean Full receipt at the merged head. This task
does not perform that remote mutation.
