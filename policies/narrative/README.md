# Narrative writer protection

`protected-writers.json` is the Release Gate B registry for Narrative domain
tables and shared protected columns.

- `enforcement: "deferred"` — declared for upcoming domain cutovers; untrusted
  SQL is not blocked yet and CI does not fail on residual Drizzle writes.
- `enforcement: "active"` — Native authorizer denies untrusted mutations and
  `pnpm test:narrative:writers` requires zero production Drizzle writes.

Domain PRs (#493–#499) flip matching entries to `active` when their Native
writer cutover lands.
