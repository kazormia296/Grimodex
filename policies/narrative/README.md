# Narrative writer protection (Gate B PASS / Gate C1)

`protected-writers.json` is the active Release Gate B writer-authority registry
for Narrative domain tables, shared protected columns, and the Native-owned
runtime policy.

## Enforcement

- `enforcement: "deferred"` — declared only while a future table is waiting for
  its typed Native writer cutover.
- `enforcement: "active"` — Native authorizer denies untrusted mutations and
  `pnpm test:narrative:writers` requires zero production Drizzle / raw-SQL writes.

Gate B2 has passed. All registered Narrative authority tables, including the
four Narrative Change Feed tables, are `active` and remain unavailable to
Renderer and MCP generic SQL.

## Change Feed operation coverage

`change-feed-writers.json` is the Gate C1 operation-level inventory. It does not
replace `protected-writers.json`: the protected writer registry owns table and
column authority, while the Change Feed inventory classifies each mutating
Electron IPC／N-API／MCP／internal operation as:

- `required` — the operation must append a canonical Change Event and its linked
  Narrative Change Feed transaction atomically.
- `delegated` — an existing aggregate workflow owns the linked Feed append.
- `excluded` — the operation has a fixed non-domain reason such as migration,
  database-image replacement, staging, derived state, or untrusted generic SQL.

The manifest's `writerMatrix` is the C1 input contract for the Semantic Build
System. Every row fixes the addressing strategy (`independent-key` or
`aggregate-path`), canonical object-key family, JSON Pointer path vocabulary,
text-impact requirement, allowed cause directions, transaction atomicity,
Undo/Redo coverage, and retry idempotency. Plot and temporal child rows use
independent typed keys. Foreshadow's renderer writer deliberately uses
aggregate-root addressing because its root OCC token owns setup/payoff writes;
its child paths are therefore `/setups/<setupId>` and `/payoffs/<payoffId>`.
Writers that own an independent Foreshadow child table may use the typed child
key, and must declare that strategy in their matrix row. A restore is the
exception: it emits one project-level `project-restored` epoch-reset marker and
asks C2 for a full rebuild instead of replaying every restored row.

`pnpm test:narrative:change-feed-writers` validates the manifest, known public
routes, implementation modules and symbols, active writer IDs, identity
contract, and fixed exclusion reasons. Gate C1 additionally requires
`pnpm test:narrative:change-feed-writers:strict`: every `required` or
`delegated` operation must have `coverageStatus: "verified"`.

Generic Renderer/MCP SQL and `agent_write_bundle` are never Feed authorities.
Staging-only prose accept also stays out of the Feed; the subsequent typed scene
body save records the authoritative `ai-apply` mutation.

Project metadata remains updateable through the existing Renderer API, while
Project INSERT/DELETE is structurally protected. `project_create` publishes the
Project scope and its four builtin Codex types in one trusted transaction; the
builtin catalog is the ordered Feed payload. Bootstrap, sample seed, and scan
staging creation retain their fixed non-user initialization contracts.

Map has an explicit boundary. `map_write_bundle` is the only Canonical Native
Map aggregate writer and owns promotions that create Scene, Snippet, Codex Entry,
or Codex Relation state. Direct Renderer CRUD for board settings, positions,
stickies, user edges, and frames is canvas-layout state only: it is classified
under the `renderer.generic-sql.execute` / `renderer.generic-sql.batch`
`untrusted-generic-sql` exclusion, does not participate in narrative freshness,
and must never create or mutate Scene, Codex, Chronicle, Plot, or Foreshadow
artifacts. Moving a canvas card or editing a visual edge therefore does not claim
a Narrative Change Feed mutation; promoting it into a narrative artifact does.

## Gate status

Gate B2 is **PASS**. Gate C0 established the SCHEMA 21 Feed foundation; Gate C1
advances the contract to SCHEMA 22 and wires Canonical Native Writers so domain
state, Undo Journal where supported, canonical Change Event, idempotency receipt,
and Narrative Change Feed commit or roll back together. Dependency Index,
scheduler, automatic maintenance, and Background AI remain Gate C2+ work and do
not start here.
