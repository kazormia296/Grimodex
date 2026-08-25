# NIR0-CERT — Narrative IR add-only pilot

## Status

**Candidate certification — local evidence complete; remote integration
pending.** This document is the evidence ledger for the NIR-0 completion slice
on the local candidate branch. The exact candidate/base identities and clean
worktree proof are read from the candidate-bound receipts below. It becomes a
final certificate only after the remote stacked-PR merge evidence is recorded.

| Field            | Value                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------- |
| Scope            | C2B ScopeOverride materialization + Chronicle V2 `scene-event@1` `add` pilot           |
| Candidate branch | `codex/nir0-c2b-atomic-materialization`                                                |
| Candidate HEAD   | exact `candidate.resolvedHeadSha` in the final Quick/Full receipts                     |
| CI base          | exact `candidate.resolvedBaseSha` in the final Quick/Full receipts                     |
| Remote status    | PR #556 and PR #557 remain open; no push, rebase, or merge was performed by this slice |

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

## Verification ledger

Focused evidence already green on this candidate includes:

- semantic boundary: 128 writer operations classified; Narrative IR contract:
  10 golden cases;
- Electron IPC contract suite: 407/407;
- N-API integration suite: 131 passed, 1 intentional fixture skip, 0 failed;
- C2A persistence: 23/23, including public V2 save → Human ScopeOverride;
- C2B Human request compile/negative matrix: 38/38;
- live Scope authority runtime: 11/11;
- Chronicle production adapter: 3/3; coordinator: 4/4; review route/cold-start: 5/5;
- TypeScript and Electron TypeScript checks: passed;
- Rust formatting, focused DB checks, and live Scope Freshness tests: passed.

The final candidate-bound receipt files are the authoritative, machine-readable
ledger. They must have the same resolved base/head, a clean worktree, and
`status: passed`:

```text
pnpm ci:local:quick -- --base origin/master --head HEAD
pnpm ci:local:verify -- quick --base origin/master --head HEAD
pnpm ci:local:full -- --base origin/master --head HEAD
pnpm ci:local:verify -- full --base origin/master --head HEAD
```

| Receipt | Base SHA                    | Head SHA                    | Worktree                        | Evidence                                                                    |
| ------- | --------------------------- | --------------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| Quick   | `candidate.resolvedBaseSha` | `candidate.resolvedHeadSha` | `candidate.worktreeClean: true` | [`.artifacts/local-ci/quick.json`](../../../.artifacts/local-ci/quick.json) |
| Full    | `candidate.resolvedBaseSha` | `candidate.resolvedHeadSha` | `candidate.worktreeClean: true` | [`.artifacts/local-ci/full.json`](../../../.artifacts/local-ci/full.json)   |

The final local run covers 14/14 Full stages. Windows NSIS compilation remains
the explicitly retained release-only/manual item; it is not reclassified as a
local Linux pass.

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
