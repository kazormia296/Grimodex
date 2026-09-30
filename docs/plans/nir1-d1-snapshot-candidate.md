# NIR-1 D1 shared snapshot candidate

2026-09-22. Parent candidate: [post-B candidate](nir1-post-b-candidate.md).
Implementation owner: `d1_shared_snapshot`; independent acceptance belongs to the parent.

## Precheck and bounded change

This implements the internal helper extraction in post-B sections 4 and 8 under
`nir1-l6-l9-contract-proposal/4#typed-revision-material`. It preserves the
existing single-Revision wrapper, exact A2/A3 reader, approved family, Decision,
canonical Freshness and Scope authorities. No new schema, IPC, authority,
Graph admission, transport or product activation is added. The confirmed
`native-generation-receipt` contract remains a downstream dependency, not
authorization supplied by this helper.

| Entry / operation | Owner and finite lifecycle | Preserved boundary / check |
| --- | --- | --- |
| Existing single-Revision wrapper | `Database::with_read_transaction` owns begin, result and transaction cleanup | Same request/result shape and single binding; calls pooled helper with one exact Revision |
| Internal pooled read | Caller owns one live read transaction and outer SQL progress owner throughout the call | Helper rejects autocommit; every unique exact Revision is read through A2/A3 in that snapshot |
| Read cancellation / resource stop | Borrowed caller checkpoint; inherited connection progress owner | Check before/after reads and between atomic groups; errors abort the whole result; no nested hook installation/reset |
| Retained candidates / Packing | One caller-owned input-byte counter, one aggregate item preflight, one final selector invocation | Existing `MAX_PACKING_INPUT_BYTES` / `MAX_PACKING_ITEMS`, one total token budget; no per-Revision reset or packed-output concatenation |
| Retained authority bindings | Caller reservation callback sees one cumulative content-byte count before each unique binding is retained | Canonical binding serialization plus the duplicate private Decision omitted from Revision serialization; caller supplies the applicable limit, failure aborts the whole result |
| Duplicate Revision | Request-local borrowed-ID set, released on return/error | Validate and project once in first-seen order; no cross-request cache or authority |
| Return | Caller receives selected items and exact per-Revision authority bindings | Same-snapshot observations only; later return/dispatch currentness must be checked after ending the read transaction |

No async task, subprocess, external egress, pending start, retry, or durable state
exists in this slice. A cancellation error is not a claim about outer cleanup;
the existing connection owner remains responsible for rollback/close, hook
restoration and readmission.

Revision count and aggregate ID bytes are checked against the existing input
envelope before trimming IDs, allocating the dedup set or entering caller read
control. The authority reservation includes arbitrary private Decision content,
even when its small projected atomic groups are omitted from the final context.
The callback receives a cumulative count, so a caller limit cannot reset for
each Revision. The legacy single-Revision wrapper preserves its existing
behavior without imposing an unratified aggregate limit.

The candidate envelope and retained-content reservation are not total
process/SQLite/allocator/transient peak-memory proof. Existing per-Revision
read bounds and caller read controls remain in force. A numerical total D1
retained-memory/read contract has not been invented or borrowed from B capacity
or C query thresholds. All consulted bindings remain observations; final direct
input references must be derived only from selected immutable items.

Raw items preserve the legacy wrapper's diagnostic contract. Their caller text,
label and token claim are not Source-backed generation qualification. A trusted
Source Raw adapter, final system/history/user/context/format/response budget,
Graph material adapter, and final payload/dispatch adapter are unimplemented.
Arbitrary Decision annotations stay in private change-detection bindings and
never enter selected model-visible qualification text.

## Focused validation

The internal `nir1_packing` Rust suite passed 8/8 with `CARGO_BUILD_JOBS=2`.
It covers a canonical two-Revision fixture, pooled token/byte/item limits,
duplicate deduplication, cumulative caller reservation, WAL drift, unchanged
single-wrapper result, and a private Decision canary that stays out of selected
Raw/IR text. This is focused helper evidence, not a final request or Native
dispatch proof. No Quick/Full, commit, product acceptance or completion claim
is implied.
