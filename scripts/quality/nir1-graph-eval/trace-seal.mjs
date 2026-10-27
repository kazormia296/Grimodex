// CP-4 TR (DR-CP4-TR-9): the B seal at a counted query's start, read on a
// read-only connection of its own (`node:sqlite`, `readOnly: true`, the
// product's process never shares it) through `readIndexMetadata`.
//
// The read never holds up the product: the workspace DB is in WAL mode, so a
// reader neither waits for a writer's transaction (it reads the last commit)
// nor blocks the writer's commit (one short SELECT, then the connection is
// closed). The busy timeout is 0: when the DB is busy (a checkpoint/recovery
// lock, a non-WAL lock) the read fails at once instead of waiting, and the
// query's start seal is `unknown` (trace-record.mjs `startSealOf`; never
// guessed, never in U). Nothing here writes.

import { performance } from "node:perf_hooks";
import { readIndexMetadata } from "./workspace-db.mjs";

/** The read-only connection's busy timeout (ms): never wait. */
export const START_SEAL_BUSY_TIMEOUT_MS = 0;

const pick = (row) =>
  row ? { generation: row.generation, dirty: row.dirty } : null;

/**
 * `{ read: "ok", b, chronicle, durationMs }` (`b`/`chronicle` are
 * `{ generation, dirty }` or null when the project has no such Index row) or
 * `{ read: "failed", error, durationMs }`.
 */
export function readStartSeal(
  file,
  projectId,
  { read = readIndexMetadata } = {},
) {
  const started = performance.now();
  try {
    const metadata = read(file, projectId, {
      timeout: START_SEAL_BUSY_TIMEOUT_MS,
    });
    return {
      read: "ok",
      b: pick(metadata.b),
      chronicle: pick(metadata.chronicle),
      durationMs: performance.now() - started,
    };
  } catch (error) {
    return {
      read: "failed",
      error: String(error?.code ?? "") + ":" + String(error?.message ?? error),
      durationMs: performance.now() - started,
    };
  }
}
