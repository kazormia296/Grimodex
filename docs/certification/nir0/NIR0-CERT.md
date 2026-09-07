# NIR0-CERT — Narrative IR add-only pilot

## Status

**Certification verdict: PASS for the bounded Chronicle add-only pilot.** This
certificate becomes the repository's NIR-0 completion record when the closeout
change is merged. It certifies the implementation tree tested by PR #559; the
closeout documentation commit is not substituted for that candidate identity.

| Field | Value |
| --- | --- |
| Certified scope | C2B ScopeOverride materialization + Chronicle V2 `scene-event@1` `add` pilot |
| Contract | `narrative-ir/2` / ADR 011 |
| Candidate base | `f78c008088937134d3c0c080ef694891cca225b0` |
| Candidate head | `daa20f7d605da9d4c2882bb19b8469c481379353` |
| Candidate tree | `1430eeab4c036ab8201dbcf0a8e1192e43152f40` |
| Remote integration | [PR #559](https://github.com/kazormia296/Grimodex/pull/559), squash-merged as `651791655177538ee02bc7e773f7d98c534ea324` |
| Integrated tree | `1430eeab4c036ab8201dbcf0a8e1192e43152f40` — byte-identical to the tested candidate tree |
| Certification date | 2026-08-27 |
| Heavy / live-model status | Explicitly deferred or blocked; no deferred result is counted as PASS evidence |

## Certified boundary

The certified implementation activates only the typed Chronicle
`scene-event@1` `add` route. It includes:

- live project Scope authority and Native ScopeOverride derivation;
- child Scope V2/material sidecar, D1/V1 dependencies, current-Epoch
  Freshness, and final current-pointer CAS in one transaction;
- atomic Envelope V2 ProposalSet persistence with the existing V1 Edge and
  explicit V1 compatibility fallback;
- C1 Stage provenance closure, durable terminal receipts/model bindings, and
  exact Context Set binding in the production coordinator;
- C2B Human-derived Native/N-API/IPC/TypeScript review writing;
- V2 monotonicity, typed-writer ownership, activation policy/schema/validator,
  and exact production-marker agreement;
- durable Chronicle restart and explicit resume/discard behavior without
  implicit new model spend or a second Run identity;
- Workspace-authority, sealed snapshot, and existing-event-catalog CAS at the
  production mutation boundaries.

This certificate does **not** claim Scope Disclosure admission, D2 full V2
authority cutover, a generic public V2 append route, non-`add` Chronicle
semantics, universal Narrative IR coverage, or NIR-1 retrieval.

## Evidence identity and trust boundary

PR #559's local Quick and Full receipts are bound to the exact candidate base,
head, tree, `currentHeadSha`, and a clean worktree. The PR was then squash-merged
onto the same base, and the resulting `master` commit has the same tree as the
tested candidate. The implementation bytes covered by the receipts therefore
match the integrated implementation bytes exactly.

The certification closeout changes documentation status only. It does not
rebind PR #559's receipts to a later documentation tree, invent a new tested
candidate, or turn deferred Heavy evidence into passing evidence. The closeout
PR must still satisfy the repository's ordinary candidate-bound merge checks
for its own documentation change before merge.

## Formal PASS evidence map

| Formal PASS group | Result | Primary evidence |
| --- | --- | --- |
| Contract and identity (1–6) | PASS | [`narrative-ir-contract.json`](../../../policies/narrative/narrative-ir-contract.json), its JSON Schema and semantic validator, ADR 011, project-scoped `proposal-revision` identity, TypeScript/Rust canonical parity fixtures, and fail-closed unknown-vocabulary tests |
| Human derivation (7–15) | PASS | Native-owned payload diff/classification in `human_derivation.rs` and `human_materialization.rs`; mixed `title + secret`, projection-only, ScopeOverride, producer/actor-lineage, unsupported-path, and forged-client-authority regressions |
| Material basis and Freshness (16–22) | PASS | Atomic child Source Basis/Evidence/D1/V1 Edge/current-Epoch Freshness/current-pointer materialization; stale/missing/ambiguous Scope authority, zero-Edge, CAS, rollback, reorder/archive, and Apply-time OCC regressions |
| Monotonicity and activation (23–27) | PASS | Typed V2 writer, structural downgrade trigger, exact `scene-event@1` + `add` activation markers, blocked generic V2 append, explicit V1 fallback, and policy/schema/source-marker bidirectional validation |
| Stage provenance and boundaries (28–34f) | PASS | Per-Stage Run/Task/Attempt identity, independent Observation/Synthesis/Repair receipts, immutable repair lineage, model-binding and receipt digest parity across TypeScript/Rust, C1 closure reachability, AI-audit CAS, interpreter/second-authority scans, and ephemeral full-closure retention boundary |
| Scope adoption (35–38) | PASS for the NIR-0 boundary | Scope V2 structural validation is wired, Scope Relation/Oracle parity is tested, and Disclosure admission remains explicitly declared rather than falsely activated |
| Chronicle journey (39–43) | PASS | Real product start/coordinator path, durable prefix and process-exit resume of the same Run, atomic terminal ProposalSet, Human revision hydration/rematch, `title + secret` flow, and fail-closed negative matrix |

The numbered groups above correspond to §14 of the
[NIR-0 implementation plan](../../plans/narrative-ir-nir0-implementation-plan.md).
NIR-0 retains the existing separation among immutable Revision, Decision,
Freshness, Reconciliation, Build Action, Compatibility, Application, and
Projection execution state.

## Detailed evidence map

| Area | Evidence |
| --- | --- |
| Scope authority | [`nir0-c2b-live-scope-authority-impact-matrix.md`](../../plans/nir0-c2b-live-scope-authority-impact-matrix.md); live-tree resolver, sealed historical companion, restore/rebuild, and Freshness integration tests |
| Empty Folder guard | `liveSceneSubtreeImpact` is emitted by tree create/delete/patch and AI plan apply/undo; empty reorder/archive regressions prove zero affected Edges and no false stale publication |
| C2B materialization | [`human_materialization.rs`](../../../src-tauri/crates/grimodex-db/src/narrative_extraction/human_materialization.rs); positive ScopeOverride, stale/missing/ambiguous authority, reorder/archive, Freshness, CAS, and rollback tests |
| Chronicle V2 | [`chronicleV2Production.ts`](../../../src/application/narrative-extraction/chronicleV2Production.ts), coordinator route, exact nine-Task sealed DAG, production Evidence/source-token binding, atomic Envelope+D1+V1 Edge+Freshness save, and `add`-only negatives |
| Stage durability | Native terminal receipt/model-binding persistence, typed synthesis-output companion, exact task/attempt ownership, durable restart discovery, and same-Run product resume |
| Human review route | [`nativeApi.ts`](../../../src/application/narrative-extraction/nativeApi.ts), [`ipcContract.ts`](../../../electron/shared/ipcContract.ts), N-API binding, schema-version propagation, typed C2B route selection, current-revision hydration, and explicit V1 fallback tests |
| Activation | [`narrative-ir-contract.json`](../../../policies/narrative/narrative-ir-contract.json), Scope policy, JSON Schemas, semantic validators, exact entry-point set, and production-marker scan |
| Change Feed | [`change-feed-writers.json`](../../../policies/narrative/change-feed-writers.json) registers the C2B Human writer as a typed mutation route |
| Restart / authority | Workspace `{authorityId, generation, authorityInstanceId}` binding, Snapshot/catalog drift CAS, blocked Run typed discard, exact cancellation cascade, cache namespace isolation, and restore/scheduler lock-order regressions |

## Negative matrix

| Control | Required and observed boundary |
| --- | --- |
| stale, missing, or ambiguous live Scope authority | fail closed with `NEX_C2B_SCOPE_AUTHORITY_UNAVAILABLE` before DML |
| Scope reorder/archive or authority race | stale validation or CAS failure; no partial child materialization or pointer promotion |
| missing D1 head, missing current Epoch, zero V1 Edge, foreign project, wrong adapter/surface | reject atomically and leave durable state unchanged |
| unsupported Human path or unresolved secret reveal basis | reject; no client-selected derivation or Scope is trusted |
| title-only Human edit | preserve Assertion/material digests and materialize the child basis |
| title + secret Human edit | Native classifies `scope-override`, derives child Scope, and preserves Assertion Core lineage |
| missing C1 synthesis receipt, unowned output, or unresolved Evidence anchor | coordinator/Native writer fails closed; no production V2 ProposalSet is saved |
| malformed second V2 Proposal in one save | whole ProposalSet transaction rolls back |
| direct public V2 append | remains blocked; the typed C2B Human writer is the only V2 review route |
| no AI Stage receipt / compatibility path | explicit V1 fallback remains available without silent V2 downgrade |
| empty Folder reorder/archive | typed subtree impact is zero; aggregate Edge is not selected or published stale |
| activation marker/policy/schema mismatch | semantic validator fails closed |
| process exit after Run creation or during Chronicle DAG | cold discovery exposes only the exact durable candidate; explicit resume or lease-safe discard is required |
| Workspace replacement or live Event Catalog drift | fail before Run/Artifact/Proposal/Application DML at every guarded boundary |
| explicit Run cancellation | Run/active Tasks cancel and all running Attempts terminalize with `NEX_RUN_CANCELLED` in one transaction |

## Candidate validation ledger

The following results belong to candidate
`f78c008088937134d3c0c080ef694891cca225b0..daa20f7d605da9d4c2882bb19b8469c481379353`
and tree `1430eeab4c036ab8201dbcf0a8e1192e43152f40`:

- `pnpm ci:local:quick -- --base origin/master --head HEAD` — PASS; all eight
  selected Light suites passed.
- `pnpm ci:local:verify -- quick --base origin/master --head HEAD` — PASS.
- `pnpm ci:local:full -- --base origin/master --head HEAD` — PASS; all 14/14
  stages passed in 39m10s from stage 1.
- `pnpm ci:local:verify -- full --base origin/master --head HEAD` — PASS,
  including verification after refreshing remote refs.
- Renderer — 13,453 passed / 38 intentionally skipped / 0 failed.
- Browser — 253/253 passed.
- Electron — 1,171/1,171 passed.
- N-API Node — 134/134 passed.
- feature-enabled N-API Rust — 61/61 passed.
- shared Rust unit tests — 1,184 passed / 1 ignored / 0 failed.
- migration-supervisor failpoints — 22/22 passed.
- Electron runtime performance and all registered Electron product journeys —
  PASS, including `c2-5b-restore-verify-rebuild-verify`.
- Focused final regressions — Renderer 7 files / 54 tests, Native restore
  overlap 2/2, and N-API crate 55/55 passed; `cargo check` and
  `cargo fmt --check` passed.

The final Full used an isolated user-runtime temporary root after the host
`/tmp` UID quota failure was identified as SQLite `SQLITE_IOERR_WRITE (778)`.
No product assertion or implementation was weakened to obtain the passing run.
GitHub-hosted PR checks are intentionally absent under the private-repository
policy; candidate-bound local receipts are the canonical CI evidence.

## Deferred and excluded work

The following remain outside this certificate:

- credentialed/live-model Chronicle quality evaluations; missing credentials
  remain `INCOMPLETE` and semantic threshold misses remain `HOLD`;
- the consumed retrieval holdout and other unrelated blocked Heavy evidence;
- Windows NSIS final compilation, retained as release-only/manual coverage;
- D2 full V2 authority cutover and replacement of the existing V1
  Source-grained semantic path (distinct from the accepted C2-ZC cutover in
  PR #564);
- Scope Disclosure production admission and Retrieval connection;
- Chronicle `revise`, `retract`, `merge`, and `split`;
- human Assertion Core edits without an `author-declaration` Source;
- universal Narrative IR coverage, embedding/graph retrieval, and NIR-1;
- direct generic public V2 append;
- the diagnostic-only motif fixture work in merged PR #554 and future
  Evaluation Contract v2/content-aware alignment work.

## Post-certification C2-ZC closeout

NIR0-CERT remains a bounded certificate for the Chronicle `scene-event@1`
`add` pilot and does not retroactively include later authority changes. The
separate C2-ZC work was accepted through [PR #564](https://github.com/kazormia296/Grimodex/pull/564): the main/N-API Freshness wake activates Generic Consumer Freshness only after current-Epoch Verify/Rebuild/parity/no-active-maintenance/liveness gates pass. The accepted candidate is bound to base `201f8968f324bef1341282c625aee3fb164ea401`, head `2c1bc67c749eb90e4d441099bfa9bc7ea6ee950e`, tree `e7dff96286be3f111d9130cf89faf37929b88f17`, merge `0e62b40b622652f203690968d308b837e1481a33`, and Full run `cb03f6fb-b711-4377-bf7b-a5bd23c7ce79`; Quick/verify, Rust 17/17, Verify 13/13, product journeys 26/26 allPassed/allClean, runtime performance, and Sol final passed. The durable marker and canonical no-fallback behavior are therefore accepted. Canonical project births are exactly
`project.create`, `import.session.apply`, and `scan.import.publish`.
`scan.staging-project.create` is a hidden, noncanonical staging allocation and
is not product project-create proof; promotion requires the typed
`scan_staging_project_publish` route. The accepted evidence is recorded in the
[C2-ZC impact
matrix](../plans/narrative-c2zc-canonical-cutover-impact-matrix.md) and its
focused Rust/N-API contract tests. This post-certification acceptance satisfies
the NIR-1 start condition; NIR-1 remains planned and is not part of NIR0-CERT.

## Certification verdict

The tested and integrated implementation satisfies NIR-0 for the bounded
Chronicle `scene-event@1` `add` pilot. NIR-0 is therefore **PASS** when this
closeout record lands. C2-ZC is a separate accepted post-certification
authority boundary; its evidence does not widen NIR0-CERT. NIR-1's start
condition is satisfied, but its retrieval implementation has not started and
is not silently activated by this certificate.
