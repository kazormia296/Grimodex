// Keep fixture removal synchronous and strict. A Backend can retain its
// SQLite handle until N-API finalization (notably on Windows); exhausting these
// retries must reach the caller, never start an unowned post-exit worker or
// report success before cleanup finishes.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const originalRmSync = fs.rmSync;

fs.rmSync = function rmSyncWithRetries(path, options) {
  if (!options?.recursive) return originalRmSync(path, options);

  return originalRmSync(path, {
    maxRetries: 20,
    retryDelay: 50,
    ...options,
  });
};

// Test files use named ESM imports from node:fs. Refresh those bindings after
// patching the mutable default export above.
syncBuiltinESMExports();
