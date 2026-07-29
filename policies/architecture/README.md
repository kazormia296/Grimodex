# Renderer persistence policy

`renderer-persistence-debt.json` is a migration ledger, not an allowlist for new
code. Architecture validation rejects both new callsites and stale ceilings
after a callsite is removed.

The renderer follows these ownership rules:

- React components and Zustand stores do not import `src/db/client.ts` or call
  `db_execute` / `db_execute_batch` directly.
- Reads go through a feature repository or query port.
- Writes go through a typed domain command that owns validation, persistence,
  and projection updates.
- Raw SQL belongs in the main-process or shared Rust persistence
  implementation. Existing renderer SQL is tracked separately as read and
  write debt.
- Renderer Drizzle mutations are legacy migration debt even though Drizzle
  ultimately uses the generic SQLite proxy.

The manifest keeps separate ceilings for:

- `renderer-drizzle-mutation`
- `renderer-raw-sql-read`
- `renderer-raw-sql-write`
- `renderer-generic-db-route`
- `tsx-direct-persistence`
- `store-direct-persistence`

When a category shrinks, regenerate the reviewed baseline; never restore a
removed ceiling.
