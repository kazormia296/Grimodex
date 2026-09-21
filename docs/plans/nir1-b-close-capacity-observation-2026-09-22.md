# NIR-1 B-close capacity diagnostic observation — 2026-09-22

## Status and claim boundary

This is a diagnostic observation for the first B-close measurement stage. It is
not a numeric supported-capacity ratification, a B-close acceptance receipt, or
an activation record.

- `capacityDecision`: `unratified`
- `supportedCapacityClaim`: `false`
- Graph query activation: `not-activated`
- product dispatch: `not-activated`
- local/external AI dispatch: unchanged and not enabled by this work

The run used an uncommitted working tree, so it is not a candidate-bound
Quick/Full receipt and must not be reused after the implementation changes.

## Bound inputs

| Input | Value |
|---|---|
| branch base | `origin/master` at `6217e0155f53c9f8d267ed3c17e3952bc2f8f986` |
| branch | `codex/nir1-post-b-implementation` |
| OS | Linux `7.2.6-arch2-1`, x86_64 |
| Node | `v24.18.0` |
| Rust | `rustc 1.96.1 (31fca3adb 2026-06-26)` |
| release diagnostic binary SHA-256 | `d0a336fdf7206be3af30671c104a4095b12859f0982224ad39a630609a1829cd` |
| manifest SHA-256 | `3c6b1d21935c92def21e486d2f6269acd99f0be6c99c495f67d455b99af92c9c` |
| schema SHA-256 | `7819cbaa66a17dafd6c3b54ec0f29f61a7fc14fab8b91fafa998dd0ba3fb1565` |
| probe SHA-256 | `5c2f0b66f3e4e46c4e447c060ef55932cc3c208ae3f2f7b52915621a6d1e26e7` |
| ordered fixture-hash list SHA-256 | `7d55cf53d3731225083d5a78017af2200d0d6f295b31ac481575de6db60cc440` |

## Protocol and result

The canonical manifest selected 19 paths. Each path used one warmup and five
measured runs; every child received a fresh copy of the same preseeded
file-backed fixture and ran in a fresh process. Child timeout was overridden to
an unratified 180-second safety cap because the existing 30-second diagnostic
default was below observed valid workloads.

- paths: 19/19
- child executions: 114/114
- measured executions: 95/95, all `status=measured`
- Rust requested-heap high-water: 114/114 children
- shared Graph-prepare cancel probe: 114/114 children
- shared Graph-prepare foreground handoff probe: 114/114 children
- wall time for the matrix: 2,796.485 seconds

Artifacts (ignored local diagnostics):

- `.artifacts/nir1-capacity/b-close-2026-09-22/matrix-scoped-interruptions-v3/capacity-report.json`
  - SHA-256: `0075f64978989ee2c89f13e645ec331ee3984bc9de2817667191682d383d6e05`
- `.artifacts/nir1-capacity/b-close-2026-09-22/matrix-scoped-interruptions-v3/summary.json`
  - SHA-256: `3b766d21107edd516b5a35d09425ebc66ada7ff3cc6d395b9e0c0f2bd0c795dc`

## Selected observations

| Observation | Value | Path |
|---|---:|---|
| maximum primary elapsed time | 91,318.64 ms | `Q8176/R16` restore |
| maximum requested Rust heap high-water | 249,673,709 bytes | `Q8176/R16` full-build |
| maximum whole-process peak RSS | 320,442,368 bytes | `Q8176/R16` restore |
| maximum conservative SQL VM-step upper bound | 396,802,475 | `Q2044/R1022` full-build |
| maximum shared Graph-prepare cancel latency | 1.24737 ms | probe attached to `Q8176/R16` coverage child |
| maximum shared Graph-prepare foreground wait | 1.106333 ms | probe attached to `Q8176/R16` full-build child |

The allocator metric covers requested Rust allocations from fresh-child start
through primary path completion. It excludes allocator metadata and non-Rust
allocators; total peak RSS and SQLite high-water remain separate whole-process
signals. The SQL value is a conservative upper bound because reused statement
counters are cumulative; it is not an exact VM-step count.

The interruption values exercise the real shared maintenance owner with a real
whole-project Graph prepare, trigger after the first SQL progress callback, and
verify rollback/cleanup plus connection reuse. They do **not** establish cancel
or foreground-wait latency for each selected Source/registration/coverage/
Restore/cold-reopen operation. The report records this scope and uncertainty.

## Remaining blockers

A numeric whole-project capacity or deadline is intentionally not selected.
The report keeps these material gaps explicit:

- SQLite temporary bytes are not measured; write bytes are not relabeled as a
  temp-byte measurement.
- selected-mode cancel latency is not measured for all six operations.
- selected-mode foreground wait is not measured for all six operations.
- exact lifecycle VM steps remain unavailable; the reported value is an upper
  bound.

Path-inapplicable values such as report counts for fixtures/modes that do not
produce reports, Graph serialization bytes for Source-only re-resolution, and
publish hold for Source-only re-resolution also remain explicit rather than
being filled with zero.

Selecting supported work size, memory, SQL, or deadline values requires a
separate contract delta and explicit confirmation. Until then, B-close and
Graph/product activation remain incomplete.

## Retained failure evidence

The first full matrix stopped at `Q8176/R16` Restore with SQLite
`SQLITE_IOERR_WRITE`. The same Restore path passed 6/6 in isolation. The probe
was retaining every disposable child DB until the end of the matrix, causing
unbounded temp accumulation. It now removes each child state immediately after
capturing its terminal digest and source-stability evidence; a regression child
rejects any retained predecessor DB. The failed run remains at
`.artifacts/nir1-capacity/b-close-2026-09-22/matrix-rust-heap-v1/` and was not
overwritten.

## Validation boundary

Focused Rust binary, fixture, schema, and JavaScript orchestration tests pass.
The canonical quality-model and selected Light suites are run against the final
working tree after this document is written; their result belongs to the
working-tree handoff, not to this measurement receipt. Quick/Full, Heavy
evaluations, commit, push, PR, and merge are outside this diagnostic checkpoint.
