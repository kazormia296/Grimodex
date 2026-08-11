# Narrative writer protection (Release Gate B Foundation)

`protected-writers.json` is the Release Gate B Foundation registry for Narrative
domain tables, shared protected columns, and the Native-owned runtime policy.

## Enforcement

- `enforcement: "deferred"` — declared for upcoming domain cutovers (#493–#499).
  Untrusted SQL is not blocked yet and CI does not fail on residual Drizzle writes.
- `enforcement: "active"` — Native authorizer denies untrusted mutations and
  `pnpm test:narrative:writers` requires zero production Drizzle / raw-SQL writes.

`narrative_runtime_policy` is **active** from Foundation day one. Domain tables
flip to `active` only after their Native writer cutover lands.

## Gate status

This branch is **Gate B Foundation**, not a full Gate B PASS. Full PASS requires
restack of #493–#501 with typed writers, guard wiring at Apply／Import／Maintenance
entrypoints, and registry flip to `active` for each domain.
