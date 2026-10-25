// CP-4 S1c-1: the harness-only renderer production build and the loopback
// static server that serves it (TASK D11 (A), §15.6; DR-CP4-S1C1-5).
//
// The build reads the product `vite.config.ts` unchanged and adds one plugin
// that resolves the product module `nir1GraphAvailability.ts` to the harness
// stub, matched on the resolved absolute path (not the import text). The
// output goes only to `.artifacts/cp4/<run>/renderer-dist`. After the build
// the module graph must contain the stub and not the product module, and the
// redirected importers must be exactly the product's two.
//
// The static server binds 127.0.0.1 on a random port, answers GET/HEAD for
// regular files inside the output directory only, never lists a directory
// and records request counts.

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { formatSha256Sums } from "./receipt.mjs";

export const GRAPH_AVAILABILITY_MODULE =
  "src/features/related-scenes/nir1GraphAvailability.ts";
export const GRAPH_AVAILABILITY_STUB =
  "scripts/quality/nir1-graph-eval/renderer/nir1GraphAvailability.eval.ts";
/** The product files that import the module (DR-CP3B-2). */
export const GRAPH_AVAILABILITY_IMPORTERS = Object.freeze([
  "src/features/related-scenes/RelatedScenesSection.tsx",
  "src/features/related-scenes/useNir1RelatedScenes.ts",
]);
export const RENDERER_BUILD_PARENT = ".artifacts/cp4";
export const RENDERER_DIST = "renderer-dist";
export const PLUGIN_NAME = "cp4-graph-availability-alias";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The harness output directory: `<root>/.artifacts/cp4/<run>/renderer-dist`
 * with a plain run name. Anything else (the product `dist/`, outside
 * `.artifacts/cp4`, a nested or traversing path) is refused.
 */
export function assertRendererOutDir(root, outDir) {
  const absolute = path.resolve(root, outDir);
  const relative = path.relative(path.resolve(root), absolute);
  const parts = relative.split(path.sep);
  if (
    parts.length !== 4 ||
    parts[0] !== ".artifacts" ||
    parts[1] !== "cp4" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(parts[2]) ||
    parts[2] === "eval-build" ||
    parts[3] !== RENDERER_DIST
  )
    throw new Error(
      `[precheck] the harness renderer build writes only to ${RENDERER_BUILD_PARENT}/<run>/${RENDERER_DIST} (got ${relative})`,
    );
  return absolute;
}

/**
 * The alias plugin. `state` collects what it redirected and the final module
 * graph so the caller can check the build used the stub and only the stub.
 */
export function graphAvailabilityAliasPlugin({ root }) {
  const target = path.resolve(root, GRAPH_AVAILABILITY_MODULE);
  const stub = path.resolve(root, GRAPH_AVAILABILITY_STUB);
  const state = { redirects: [], moduleIds: null };
  const plugin = {
    name: PLUGIN_NAME,
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || source.startsWith("\0")) return null;
      // Cheap filter; an import that escapes it is caught below because the
      // product module would then appear in the module graph.
      if (!source.includes("nir1GraphAvailability")) return null;
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      if (!resolved) return null;
      if (path.resolve(resolved.id.split("?")[0]) !== target) return null;
      state.redirects.push({
        importer: path.relative(root, importer.split("?")[0]),
        source,
      });
      return stub;
    },
    buildEnd() {
      state.moduleIds = [...this.getModuleIds()]
        .filter((id) => !id.startsWith("\0"))
        .map((id) => path.resolve(id.split("?")[0]));
    },
  };
  return { plugin, state, target, stub };
}

/** Checks the plugin's record after the build (throws `[precheck]`). */
export function assertAliasApplied({ state, target, stub, root }) {
  if (!Array.isArray(state.moduleIds))
    throw new Error("[precheck] the alias plugin did not see the module graph");
  if (state.moduleIds.includes(target))
    throw new Error(
      "[precheck] the product availability module is in the harness bundle",
    );
  if (!state.moduleIds.includes(stub))
    throw new Error("[precheck] the harness stub is not in the harness bundle");
  const importers = [...new Set(state.redirects.map((row) => row.importer))]
    .map((file) => file.split(path.sep).join("/"))
    .sort();
  if (
    JSON.stringify(importers) !== JSON.stringify(GRAPH_AVAILABILITY_IMPORTERS)
  )
    throw new Error(
      `[precheck] the alias redirected ${JSON.stringify(importers)}, not the product importers`,
    );
  return {
    from: GRAPH_AVAILABILITY_MODULE,
    to: path.relative(root, stub).split(path.sep).join("/"),
    importers,
  };
}

async function listFiles(directory, base = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full, base)));
    else if (entry.isFile())
      files.push(path.relative(base, full).split(path.sep).join("/"));
    else
      throw new Error(
        `[artifact] the renderer bundle holds a non-regular file: ${entry.name}`,
      );
  }
  return files.sort();
}

/**
 * The bundle identity: every output file with its sha256, and the sha256 of
 * that list in `SHA256SUMS` form (`rendererBundleSha256`).
 */
export async function bundleIdentity(outDir) {
  const files = [];
  for (const file of await listFiles(outDir))
    files.push({
      path: file,
      sha256: sha256(await readFile(path.join(outDir, file))),
    });
  return {
    files,
    rendererBundleSha256: sha256(Buffer.from(formatSha256Sums(files))),
  };
}

/**
 * Runs the harness renderer build. `input` optionally names the HTML entries
 * (S1c-2's harness page); without it the product `index.html` is built.
 * Returns the receipt fields of the build.
 */
export async function buildHarnessRenderer({ root, outDir, input, vite }) {
  const out = assertRendererOutDir(root, outDir);
  const { build } = vite ?? (await import("vite"));
  const alias = graphAvailabilityAliasPlugin({ root });
  const startedAt = new Date().toISOString();
  await build({
    root,
    configFile: path.join(root, "vite.config.ts"),
    mode: "production",
    logLevel: "warn",
    plugins: [alias.plugin],
    build: {
      outDir: out,
      emptyOutDir: true,
      ...(input ? { rollupOptions: { input } } : {}),
    },
  });
  const aliasRecord = assertAliasApplied({ ...alias, root });
  const identity = await bundleIdentity(out);
  return {
    schema: "nir1-cp4-renderer-build/1",
    outDir: path.relative(root, out).split(path.sep).join("/"),
    startedAt,
    finishedAt: new Date().toISOString(),
    alias: {
      ...aliasRecord,
      stubSha256: sha256(await readFile(alias.stub)),
      pluginSha256: sha256(await readFile(new URL(import.meta.url))),
    },
    viteConfigSha256: sha256(await readFile(path.join(root, "vite.config.ts"))),
    ...identity,
  };
}

const CONTENT_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
});

/**
 * Maps a request path to a file inside `root` (pure, no file access):
 * `/` is `index.html`; `..`, NUL, backslashes and encoded separators are
 * refused.
 */
export function staticRequestPath(rawUrl) {
  // Refuse dot segments in the raw request (the URL parser would silently
  // normalize them away), plain or percent-encoded.
  const rawPath = String(rawUrl).split(/[?#]/u, 1)[0];
  if (/(^|\/)(\.|%2e){1,2}(\/|$)/iu.test(rawPath) || rawPath.includes("\\"))
    return null;
  let pathname;
  try {
    pathname = new URL(rawUrl, "http://127.0.0.1").pathname;
  } catch {
    return null;
  }
  if (/%2f|%5c|%00/iu.test(pathname)) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const parts = decoded.split("/").filter(Boolean);
  if (parts.some((part) => part === ".." || part === ".")) return null;
  return parts.length === 0 ? "index.html" : parts.join("/");
}

/**
 * Serves `dir` on 127.0.0.1 (random port). Returns the origin, the request
 * record and `close()`. The caller owns the server for the run.
 */
export async function startStaticServer({ dir }) {
  const root = await realpath(dir);
  const requests = { total: 0, byStatus: {}, paths: {} };
  const count = (status, file) => {
    requests.total += 1;
    requests.byStatus[status] = (requests.byStatus[status] ?? 0) + 1;
    if (file !== null) requests.paths[file] = (requests.paths[file] ?? 0) + 1;
  };
  const server = http.createServer(async (request, response) => {
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      count(405, null);
      response.writeHead(405, { ...headers, Allow: "GET, HEAD" }).end();
      return;
    }
    const file = staticRequestPath(request.url ?? "/");
    if (file === null) {
      count(400, null);
      response.writeHead(400, headers).end();
      return;
    }
    const full = path.join(root, file);
    try {
      const info = await lstat(full);
      if (!info.isFile()) throw new Error("not a regular file");
      if (!(await realpath(full)).startsWith(root + path.sep))
        throw new Error("outside");
      count(200, file);
      response.writeHead(200, {
        ...headers,
        "Content-Type":
          CONTENT_TYPES[path.extname(file).toLowerCase()] ??
          "application/octet-stream",
        "Content-Length": info.size,
      });
      if (request.method === "HEAD") response.end();
      else createReadStream(full).pipe(response);
    } catch {
      count(404, file);
      response.writeHead(404, headers).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (
    !address ||
    typeof address === "string" ||
    address.address !== "127.0.0.1"
  )
    throw new Error("[artifact] the static server is not on 127.0.0.1");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    port: address.port,
    url: (pathname = "/index.html") => `${origin}${pathname}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
