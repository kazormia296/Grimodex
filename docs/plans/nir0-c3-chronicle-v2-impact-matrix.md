# NIR-0 C3 Chronicle V2 / Activation Impact Matrix

This matrix is the implementation boundary for the NIR-0 completion slice after
C2B ScopeOverride materialization. It is intentionally limited to the Chronicle
`add` pilot and the C2B Human review writer. Chronicle revise/retract/merge/split,
Disclosure admission, D2 full cutover, and NIR1 retrieval remain deferred.

| ID | Source / owner | Boundary | Consumer | Contract and invariant | Validation evidence |
| --- | --- | --- | --- | --- | --- |
| C3-1 | `extractionCoordinator.ts` | AI observation/synthesis receipts and final proposal inputs | `chronicleSceneEventAdapter.ts` | Every production V2 add has a complete C1 closure, exact E2 digests, evidence, D1 dependencies, and `changeKind=add` | coordinator V2 route tests; adapter golden/negative tests |
| C3-2 | `proposalRepository.ts` | Proposal plan to Native save | `repository.rs` | Initial V2 Envelope, D1, V1 Edge, and current-Epoch Freshness are persisted in one Native transaction; no partial ProposalSet | Native persistence tests; rollback/OCC tests |
| C3-3 | C2B Human review | Renderer/TS review edits to Native | C2B human materialization facade | Renderer supplies payload plus expected parent/CAS only; Native derives Diff, child Scope, D1, V1 Edge, MaterialBasis, and Freshness | N-API/IPC contract tests; title-only/secret/unsupported negative matrix |
| C3-4 | Legacy review paths | V1 compatibility | Existing append/revise wrappers | V1 remains available only as the explicit compatibility fallback; it cannot silently downgrade a V2 proposal | V1 fallback tests; monotonicity tests |
| C3-5 | Activation policy | Policy/schema/validator/production marker | Rust and TS production entry points | `implementationStatus`, scope override, V2 emission, Human-derived V2 UI, and production markers change atomically | contract/schema/marker scan; production marker negative tests |
| C3-6 | Certification | Migration, persistence, Freshness, Human journey | NIR0-CERT evidence package | Clean candidate HEAD has Quick/Full receipts, focused suites, semantic contract, and deferred-work ledger | `ci:local:full`; `ci:local:verify`; CERT manifest |

## Explicit production boundary

Only `scene-event@1` with `changeKind=add` is enabled by this slice. The
coordinator must fail closed when the C1 provenance bundle or a resolved evidence
anchor is missing. Tests may continue to exercise the fake/V1 path, but the
production AI path cannot use that path after activation.
