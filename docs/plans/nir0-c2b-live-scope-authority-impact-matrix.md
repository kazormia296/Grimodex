# NIR-0 C2B live project Scope authority impact matrix

This slice adds the current project-tree authority as a computed, typed Source
and wires it into the C2B Human-derived materialization path. It does not add a
mutable authority table/head or replace the sealed historical `snapshot:<runId>`
basis.

| Boundary | Existing authority | Runtime change | Required proof |
| --- | --- | --- | --- |
| Typed semantic contract | Shared canonical JSON and Scope authority axis types | Derive independent Registry, Reading, Story revisions plus one aggregate `narrative-project-scope-authority-revision/1` token from closed Rust inputs | Core axis-separation, UTF-16 order, unresolved Story, invalid-input tests |
| Live tree read | `tree_nodes` in the workspace DB | Read one SQLite snapshot, traverse non-archived Scenes in persisted Reading DFS order, and fail closed on corrupt topology | Real-tree positive, reorder, move, create/delete, empty-project, corrupt-tree tests |
| Source registry | Existing typed Source kind/prefix resolver | Add `project-scope-authority` / `project:scope-authority:<projectId>` with exact project binding and no mutable head | Source-key/project mismatch tests and shared resolver use |
| Change Feed | Typed tree writer events | Route only membership/order/Story/archive structural changes to the aggregate; force `source-content-changed` without incarnation replacement | Real writer Feed tests; title/content/label negative tests; create/delete D2 tests |
| Incremental Freshness | Cursor-bounded V1 and D2 evaluator | Select existing V1/D1 consumers of the aggregate and re-resolve the current token before publish | V1 stale/rebuild and D2 resolve-only integration tests |
| Restore/Rebuild | Current Epoch rebuild over durable edges | Infer the new source kind and resolve it from restored `tree_nodes`, never from cached historical basis | Epoch-rotation plus rebuild integration test |
| C2B Human path | Native auto-classifies ProjectionOnly versus ScopeOverride | ScopeOverride derives live Scope V2, child D1/V1 dependencies, current-Epoch Freshness, and the final pointer CAS in one transaction; the C2B Human IPC route is typed and fail-closed | ScopeOverride positive/negative matrix, stale/missing/ambiguous authority, reorder/archive, Freshness and CAS rollback tests |

Folder structural Feed paths carry a typed before/after
`liveSceneSubtreeImpact`. A folder change reaches the aggregate only when the
before or after live Scene count is non-zero; an empty-folder reorder or
archive therefore cannot publish a false stale result. Populated-folder
changes retain the aggregate route, and the real tree writer plus AI plan
apply/undo paths emit the same metadata.

Static proof is limited to JSON Schema and exact policy cross-field assertions.
Wake-to-evaluation behavior is integration-tested; no source scanner, CFG, alias,
callback, or custom JSON interpreter is added.
