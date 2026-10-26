/**
 * Verify the C-query worker that electron-builder bundles into `resources/bin`
 * (CP-2b P1, docs/plans/nir1-lane-decisions/cp2b-decisions.md DR-CP2B-P1-4).
 *
 * The packaged worker must be the seam-free release build: the
 * `nir1-c-query-test-seam` feature embeds its `NIR1_C_QUERY_TEST_*` env names
 * as byte strings, so their absence is the build-level proof. The lane script
 * (`scripts/nir1-c-query-worker-ci.sh`) writes a seam build to the same
 * `src-tauri/target/release`, which is why `electron:native:release` rebuilds
 * and then checks it before every package.
 *
 * Usage: node electron/scripts/verify-release-graph-worker.mjs [worker path]
 * The default is `src-tauri/target/release/nir1-c-query-worker[.exe]`; P2's
 * packaged smoke may pass the binary inside a package instead.
 */
import { constants } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GRAPH_WORKER_SEAM_MARKER = "NIR1_C_QUERY_TEST_";

const CHUNK_BYTES = 1024 * 1024;

export function graphWorkerName(platform = process.platform) {
  return platform === "win32"
    ? "nir1-c-query-worker.exe"
    : "nir1-c-query-worker";
}

async function containsMarker(file, marker) {
  const needle = Buffer.from(marker, "latin1");
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(CHUNK_BYTES + needle.length - 1);
    let carry = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, carry, CHUNK_BYTES, null);
      if (bytesRead === 0) return false;
      const filled = carry + bytesRead;
      if (buffer.subarray(0, filled).includes(needle)) return true;
      carry = Math.min(needle.length - 1, filled);
      buffer.copy(buffer, 0, filled - carry, filled);
    }
  } finally {
    await handle.close();
  }
}

/**
 * Resolves `{ path }` for a releasable worker; rejects with the reason
 * otherwise. `platform` selects the expected file name and whether the POSIX
 * execute bit is required.
 */
export async function verifyReleaseGraphWorker(
  file,
  platform = process.platform,
) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!path.isAbsolute(file) && !pathApi.isAbsolute(file)) {
    throw new Error(`graph worker path must be absolute: ${file}`);
  }
  if (path.basename(file) !== graphWorkerName(platform)) {
    throw new Error(
      `graph worker name must be ${graphWorkerName(platform)}: ${file}`,
    );
  }
  let metadata;
  try {
    metadata = await stat(file);
  } catch {
    throw new Error(`graph worker not found: ${file}`);
  }
  if (!metadata.isFile()) {
    throw new Error(`graph worker must be a regular file: ${file}`);
  }
  if (platform !== "win32") {
    try {
      await access(file, constants.X_OK);
    } catch {
      throw new Error(`graph worker must be executable: ${file}`);
    }
  }
  if (await containsMarker(file, GRAPH_WORKER_SEAM_MARKER)) {
    throw new Error(
      `graph worker carries the test seam (${GRAPH_WORKER_SEAM_MARKER}*): ${file}`,
    );
  }
  return { path: file };
}

// Windows paths compare case-insensitively (a drive letter may differ in case
// between argv and the module URL); a missed match would skip the check silently.
const sameFile = (left, right) =>
  process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
const invokedDirectly =
  Boolean(process.argv[1]) &&
  sameFile(path.resolve(process.argv[1]), fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const file =
    process.argv[2] ??
    path.join(rootDir, "src-tauri", "target", "release", graphWorkerName());
  try {
    await verifyReleaseGraphWorker(path.resolve(file));
    console.log(`[release-graph-worker] seam-free worker verified: ${file}`);
  } catch (error) {
    console.error(
      `[release-graph-worker] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
