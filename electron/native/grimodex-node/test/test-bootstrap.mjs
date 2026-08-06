// Native integration fixtures can leave a detached maintenance worker finishing
// its final backup write while process-exit cleanup removes the temporary root.
// Apply the same bounded retry policy used by the backup fixtures to every
// recursive rmSync call in this test process, so a transient ENOTEMPTY/EBUSY
// does not turn an otherwise successful native suite red.
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

// Test files use named ESM imports such as `import { rmSync } from "node:fs"`.
// Refresh those bindings after patching the mutable default export above.
syncBuiltinESMExports();
