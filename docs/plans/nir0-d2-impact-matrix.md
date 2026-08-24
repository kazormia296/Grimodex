# NIR-0 D2 Shadow Runtime Impact Matrix

Base: `30718178388fc8ab9860b28bda7666fde1fa775d` (D1 + C2-ZC)

This matrix keeps the V1 dependency-edge / Edge State / Consumer Freshness
path authoritative while adding an in-memory V2 observation path. V2
declarations are read only through the D1 storage boundary and are never
written by D2.

| ID | Flow / variant | Owner / producer | Boundary, contract, transform, validation | Consumer / sink | Preserved invariant | Compatibility / fallback | Verification | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | Incremental Feed, no active V2 head | `incremental_freshness.rs` + V1 `narrative_dependency_edges` | Reserve Feed range; bounded reverse lookup; existing `evaluate_edge`; existing publish transaction | V1 Edge State, Consumer Freshness, Findings, cursor acknowledgement | V1 output and digest semantics remain byte-equivalent | No V2 observation; V1 is the only path | Existing incremental runtime suite and no-head D2 journey | verified |
| P2 | Incremental Feed, active sealed V2 head | D1 `declaration_storage.rs` read + D2 shadow evaluator | Same Feed events/source facts are mapped to ADR 010 Source Change Class; core typed Role/Selector effect registry evaluates each V2 entry; summary remains in memory | Shadow summary only; V1 publication remains canonical | No second Freshness authority; V1 `dependency_set_digest` is not reinterpreted | Corrupt/incomplete head reports a diagnostic and falls back to V1 | Public `run_incremental_freshness_cycle` role/selector, V2-only, and action-summary journeys | verified |
| P3 | Incremental Feed, V2 head/set changes after evaluation | D2 evaluation plan and D1 same-connection guard | Capture affected-source key/state snapshot; before any V1 write, re-run bounded lookup and compare exact head/set state | Retry/requeue path | Atomic publish has no partial V1 rows and no cursor ACK on drift; unrelated heads are excluded | Existing retry policy handles the failure | Existing/new/unrelated head-drift seams | verified |
| P4 | Incremental Feed, corrupt/incomplete V2 rows | D1 verified reader + D2 diagnostics | Head/set coherence, sealed state, entry canonical JSON/digests, and set digest are checked fail-closed | Shadow diagnostic only; V1 runtime proceeds | Corruption cannot suppress or replace V1 evaluation | No valid V2 set means V1 fallback | Corruption journey plus V1 publication assertions | verified |
| P5 | Restore/rebuild verification and Epoch rotation | `restore_rebuild.rs` + D1 verified reader | Project-wide active-head verification resolves each Source through the canonical resolver; snapshot Sources use their producer Run; sidecar is `serde(skip)` and never persisted | In-memory rebuild shadow sidecar/diagnostic only; V1 rebuild rows remain sinks | Epoch rotation remains canonical; no V2 current-Epoch state is persisted | Missing/corrupt V2 is observable and non-blocking for V1 rebuild | Restore/rebuild + epoch rotation, V2-only, snapshot, corrupt-head journeys; declaration row/digest counts unchanged | verified |
| P6 | Activation boundary / policy status | Typed core registry loader + policy contract | Exact repo-relative D2 source paths are typed; state is `shadow`, not `wired`; reserved activation markers remain absent | Contract validator/test suite | Chronicle V2 emission, current-Revision promotion, and UI activation remain disabled | D2 cannot change NIR-0 activation gate | Rust status contract rejects `declared`/`wired`; compatibility boundary scan passes | verified |

## Explicitly out of scope

- New schema or V2 authority tables.
- Changes to `narrative_dependency_edges`, Edge State, Consumer Freshness, or
  `narrative_consumer_freshness.dependency_set_digest` semantics.
- C2A/C2B writers, material-basis initialization, current-Revision promotion,
  renderer/preload/IPC, `commit.rs`, `field_authority.rs`, or roadmap status.
