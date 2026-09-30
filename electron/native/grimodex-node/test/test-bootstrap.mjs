// A Backend keeps its SQLite connection alive until the N-API object is
// finalized. Most integration fixtures intentionally keep that object at
// module scope, so Windows can still report EPERM when an exit hook tries to
// remove the workspace. The handle is released immediately after the worker
// exits.
//
// Keep ordinary rmSync failures strict. Only a root that this process obtained
// from mkdtempSync(tmpdir()/grimodex-*) may be handed to the bounded cleanup
// worker, which retries after this process (and its Backend) has exited.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { execPath } from "node:process";

const originalMkdtempSync = fs.mkdtempSync;
const originalRmSync = fs.rmSync;
const tempRoot = resolve(fs.realpathSync.native(tmpdir()));
const generatedRoots = new Set();
const deferredRoots = new Set();
const RETRYABLE_REMOVE_CODES = new Set([
  "EBUSY",
  "EMFILE",
  "ENFILE",
  "ENOTEMPTY",
  "EPERM",
]);

const cleanupWorkerSource = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const target = path.resolve(process.argv[1]);
const expectedTempRoot = path.resolve(process.argv[2]);
const actualTempRoot = path.resolve(fs.realpathSync.native(os.tmpdir()));
const retryable = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);

if (
  expectedTempRoot !== actualTempRoot ||
  path.dirname(target) !== actualTempRoot ||
  !path.basename(target).startsWith("grimodex-")
) {
  process.exit(2);
}

const deadline = Date.now() + 15_000;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
for (;;) {
  try {
    fs.rmSync(target, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
    process.exit(0);
  } catch (error) {
    if (!retryable.has(error?.code) || Date.now() >= deadline) {
      process.exit(1);
    }
    Atomics.wait(sleeper, 0, 0, 100);
  }
}
`;

function isRegisteredGeneratedRoot(path) {
  const resolvedPath = resolve(path);
  return (
    generatedRoots.has(resolvedPath) &&
    dirname(resolvedPath) === tempRoot &&
    basename(resolvedPath).startsWith("grimodex-")
  );
}

function deferRemoveUntilProcessExit(path) {
  const resolvedPath = resolve(path);
  if (deferredRoots.has(resolvedPath)) return;
  deferredRoots.add(resolvedPath);

  const cleanup = spawn(
    execPath,
    ["-e", cleanupWorkerSource, resolvedPath, tempRoot],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  cleanup.unref();
}

fs.mkdtempSync = function trackedMkdtempSync(prefix, options) {
  const root = originalMkdtempSync(prefix, options);
  const resolvedRoot = resolve(root);
  if (
    dirname(resolvedRoot) === tempRoot &&
    basename(resolvedRoot).startsWith("grimodex-")
  ) {
    generatedRoots.add(resolvedRoot);
  }
  return root;
};

fs.rmSync = function rmSyncWithRetries(path, options) {
  if (!options?.recursive) return originalRmSync(path, options);

  try {
    return originalRmSync(path, {
      maxRetries: 20,
      retryDelay: 50,
      ...options,
    });
  } catch (error) {
    if (
      !RETRYABLE_REMOVE_CODES.has(error?.code) ||
      !isRegisteredGeneratedRoot(path)
    ) {
      throw error;
    }
    deferRemoveUntilProcessExit(path);
    return undefined;
  }
};

// Test files use named ESM imports from node:fs. Refresh those bindings after
// patching the mutable default export above.
syncBuiltinESMExports();
