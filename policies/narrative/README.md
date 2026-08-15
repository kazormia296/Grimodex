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
five Narrative Change Feed tables, are `active` and remain unavailable to
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
contract, fixed exclusion reasons, and runtime evidence. `coverageStatus:
"verified"` requires a versioned `runtimeEvidence` bundle naming the commands,
regression files, and controls that exercise the declared Native/browser
contract. The bundle is evidence for review; this static validator does not
itself prove every transaction's runtime atomicity. Gate C1 additionally requires
`pnpm test:narrative:change-feed-writers:strict`: every `required` or
`delegated` operation must have `coverageStatus: "verified"`; runtime proof
comes from the Native writer, browser contract, and Journey/quality tests.

Generic Renderer/MCP SQL and `agent_write_bundle` are never Feed authorities.
Staging-only prose accept also stays out of the Feed; the subsequent typed scene
body save records the authoritative `ai-apply` mutation.

Project metadata is published by the typed `project_patch` Native writer. It
uses the previous `updatedAt` as an OCC token and appends the semantic JSON
Pointer paths (including `aiPolicy`) in the same transaction as the domain
update, Undo Journal, canonical Change Event, and Narrative Change Feed.
Project INSERT/DELETE is also structurally protected. `project_create`
publishes the Project scope and its four builtin Codex types in one trusted
transaction; the builtin catalog is the ordered Feed payload. Bootstrap, sample
seed, and scan staging creation retain their fixed non-user initialization
contracts.

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

## Gate C1.5 semantic contract

The C1.5 machine-readable contracts are:

- `mutation-authority-routes.json` — the six Mutation Authority Routes,
  positive fail-closed caller allowlists, diagnostic-only forbidden caller
  lists, route-specific required controls, and Human Direct's conditional
  Field Authority requirement;
- `semantic-state-vocabulary.json` — Review, Evidence Freshness,
  Reconciliation Signal, Build Action, Component Compatibility, and Projection
  Application State as separate axes;
- `semantic-core-authorities.json` — the canonical authority matrix and the
  Semantic Index field allowlist;
- `retrieval-disclosure.json` — pre-admission spoiler, phase, scope, and
  knowledge-holder rules;
- `schemas/*.schema.json` — JSON Schema draft 2020-12 definitions for the four
  policy documents;
- `fixtures/` — route, evidence, and many-to-many Projection contract cases.

`authorityRoute` is required on every C1 operation; operations that share one
typed writer across surfaces may additionally declare `authorityVariants` so
each runtime route has its own controls and caller allowlist. The route is
also carried by the renderer Native write context. Native validation binds the route to an exact
caller allowlist, origin, provenance, and replay lineage, then records the
validated route and runtime evidence in the canonical audit payload. It
complements, and does not replace, the existing low-level `canonical.origin`
audit attribute. The read-only validator
`scripts/quality/validate-semantic-core-boundary.mjs` rejects unknown routes,
missing route controls, false runtime-control claims for untrusted generic SQL,
direct Interpreter/Maintenance imports of Agent Writers, mixed state
vocabulary, and a second Freshness authority. C1.5 keeps workspace SCHEMA 22
and does not create C2 tables. `ai-apply` must carry an explicit authority
route because it is valid for both Interactive Agent Command and Interpreter
Projection; no origin-only fallback is permitted.
