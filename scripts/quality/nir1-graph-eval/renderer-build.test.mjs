import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  GRAPH_AVAILABILITY_IMPORTERS,
  GRAPH_AVAILABILITY_MODULE,
  GRAPH_AVAILABILITY_STUB,
  PLUGIN_NAME,
  RELATED_SCENES_API_MODULE,
  RELATED_SCENES_API_REQUIRED_IMPORTERS,
  RELATED_SCENES_API_TIMING_SHIM,
  TIMING_PLUGIN_NAME,
  assertAliasApplied,
  assertTimingShimApplied,
  relatedScenesTimingPlugin,
  assertRendererOutDir,
  bundleIdentity,
  graphAvailabilityAliasPlugin,
  startStaticServer,
  staticRequestPath,
} from "./renderer-build.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const { fetch } = globalThis;

test("D11: the harness build writes only to .artifacts/cp4/<run>/renderer-dist", () => {
  assert.equal(
    assertRendererOutDir(ROOT, ".artifacts/cp4/run-1/renderer-dist"),
    path.join(ROOT, ".artifacts/cp4/run-1/renderer-dist"),
  );
  for (const bad of [
    "dist",
    ".artifacts/cp4/renderer-dist",
    ".artifacts/cp4/run-1/dist",
    ".artifacts/cp4/eval-build/renderer-dist",
    ".artifacts/cp4/run-1/x/renderer-dist",
    ".artifacts/other/run-1/renderer-dist",
    ".artifacts/cp4/../cp4x/run/renderer-dist",
    "/tmp/renderer-dist",
  ])
    assert.throws(() => assertRendererOutDir(ROOT, bad), /\[precheck\]/, bad);
});

function fakeContext(map) {
  return {
    async resolve(source, importer) {
      const id = map[`${importer}|${source}`];
      return id ? { id } : null;
    },
  };
}

test("D11: the alias matches the resolved product path, not the import text", async () => {
  const { plugin, state, target, stub } = graphAvailabilityAliasPlugin({
    root: ROOT,
  });
  assert.equal(plugin.name, PLUGIN_NAME);
  assert.equal(plugin.enforce, "pre");
  const hook = GRAPH_AVAILABILITY_IMPORTERS.map((file) =>
    path.join(ROOT, file),
  );
  const ctx = fakeContext({
    [`${hook[0]}|./nir1GraphAvailability`]: target,
    [`${hook[1]}|./nir1GraphAvailability`]: `${target}?v=1`,
    [`${path.join(ROOT, "src/other/x.ts")}|./nir1GraphAvailability`]: path.join(
      ROOT,
      "src/other/nir1GraphAvailability.ts",
    ),
  });
  assert.equal(
    await plugin.resolveId.call(ctx, "./nir1GraphAvailability", hook[0], {}),
    stub,
  );
  assert.equal(
    await plugin.resolveId.call(ctx, "./nir1GraphAvailability", hook[1], {}),
    stub,
  );
  // Same import text, another file: not redirected.
  assert.equal(
    await plugin.resolveId.call(
      ctx,
      "./nir1GraphAvailability",
      path.join(ROOT, "src/other/x.ts"),
      {},
    ),
    null,
  );
  assert.equal(await plugin.resolveId.call(ctx, "react", hook[0], {}), null);
  assert.equal(
    await plugin.resolveId.call(
      ctx,
      "\0virtual:nir1GraphAvailability",
      hook[0],
      {},
    ),
    null,
  );
  plugin.buildEnd.call({
    getModuleIds: () => [stub, path.join(ROOT, "src/main.tsx"), "\0vite/x"],
  });
  assert.deepEqual(assertAliasApplied({ state, target, stub, root: ROOT }), {
    from: GRAPH_AVAILABILITY_MODULE,
    to: GRAPH_AVAILABILITY_STUB,
    importers: [...GRAPH_AVAILABILITY_IMPORTERS],
  });
});

test("D11: a bundle that kept the product module or missed an importer is refused", () => {
  const { state, target, stub } = graphAvailabilityAliasPlugin({ root: ROOT });
  const importers = GRAPH_AVAILABILITY_IMPORTERS.map((importer) => ({
    importer,
    source: "./nir1GraphAvailability",
  }));
  state.redirects.push(...importers);
  state.moduleIds = [stub, target];
  assert.throws(
    () => assertAliasApplied({ state, target, stub, root: ROOT }),
    /product availability module is in the harness bundle/,
  );
  state.moduleIds = [target];
  assert.throws(
    () => assertAliasApplied({ state, target, stub, root: ROOT }),
    /product availability module/,
  );
  state.moduleIds = [stub];
  state.redirects.splice(0, 1);
  assert.throws(
    () => assertAliasApplied({ state, target, stub, root: ROOT }),
    /not the product importers/,
  );
  state.moduleIds = null;
  assert.throws(
    () => assertAliasApplied({ state, target, stub, root: ROOT }),
    /module graph/,
  );
});

test("S1c-2: the timing shim serves every product importer and alone imports the product module", async () => {
  const { plugin, state, target, shim } = relatedScenesTimingPlugin({
    root: ROOT,
  });
  assert.equal(plugin.name, TIMING_PLUGIN_NAME);
  const [fetchHybrid, fetchGraph] = RELATED_SCENES_API_REQUIRED_IMPORTERS.map(
    (file) => path.join(ROOT, file),
  );
  const ctx = fakeContext({
    [`${fetchHybrid}|./nir1RelatedScenesApi`]: target,
    [`${fetchGraph}|./nir1RelatedScenesApi`]: `${target}?v=1`,
    [`${shim}|@/features/related-scenes/nir1RelatedScenesApi`]: target,
    [`${path.join(ROOT, "src/other/x.ts")}|./nir1RelatedScenesApi`]: path.join(
      ROOT,
      "src/other/nir1RelatedScenesApi.ts",
    ),
  });
  assert.equal(
    await plugin.resolveId.call(ctx, "./nir1RelatedScenesApi", fetchHybrid, {}),
    shim,
  );
  assert.equal(
    await plugin.resolveId.call(ctx, "./nir1RelatedScenesApi", fetchGraph, {}),
    shim,
  );
  // The shim's own import of the product module is not redirected.
  assert.equal(
    await plugin.resolveId.call(
      ctx,
      "@/features/related-scenes/nir1RelatedScenesApi",
      shim,
      {},
    ),
    null,
  );
  assert.equal(
    await plugin.resolveId.call(
      ctx,
      "./nir1RelatedScenesApi",
      path.join(ROOT, "src/other/x.ts"),
      {},
    ),
    null,
  );
  plugin.buildEnd.call({
    getModuleIds: () => [shim, target, "\0vite/x"],
    getModuleInfo: (id) => (id === target ? { importers: [shim] } : null),
  });
  assert.deepEqual(
    assertTimingShimApplied({ state, target, shim, root: ROOT }),
    {
      from: RELATED_SCENES_API_MODULE,
      to: RELATED_SCENES_API_TIMING_SHIM,
      importers: [...RELATED_SCENES_API_REQUIRED_IMPORTERS],
    },
  );
  state.targetImporters = [shim, fetchHybrid];
  assert.throws(
    () => assertTimingShimApplied({ state, target, shim, root: ROOT }),
    /imported around the timing shim/,
  );
  state.targetImporters = [shim];
  state.redirects.splice(0, 1);
  assert.throws(
    () => assertTimingShimApplied({ state, target, shim, root: ROOT }),
    /does not serve/,
  );
  state.moduleIds = [target];
  assert.throws(
    () => assertTimingShimApplied({ state, target, shim, root: ROOT }),
    /missing/,
  );
});

test("S1c-2: the timing shim re-exports the product module and wraps only the timed calls", () => {
  const text = readFileSync(
    path.join(ROOT, RELATED_SCENES_API_TIMING_SHIM),
    "utf8",
  );
  assert.match(
    text,
    /export \* from "@\/features\/related-scenes\/nir1RelatedScenesApi";/u,
  );
  const wrapped = [...text.matchAll(/^export const (\w+)/gmu)].map(
    (match) => match[1],
  );
  assert.deepEqual(wrapped.sort(), [
    "beginRelatedScenes",
    "continueRelatedScenesGraph",
    "settleRelatedScenesGraph",
  ]);
  for (const name of wrapped)
    assert.match(text, new RegExp(`product\\.${name}\\(`, "u"), name);
});

test("D11 / T-2: the product source, config and build never reference the stub", () => {
  const tracked = execFileSync(
    "git",
    [
      "ls-files",
      "src",
      "electron",
      "vite.config.ts",
      "index.html",
      "package.json",
    ],
    { cwd: ROOT, encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
  const needles = [
    "nir1GraphAvailability.eval",
    "nir1RelatedScenesApi.timing",
    "nir1-graph-eval/renderer",
    PLUGIN_NAME,
    TIMING_PLUGIN_NAME,
  ];
  for (const file of tracked) {
    let text;
    try {
      text = readFileSync(path.join(ROOT, file), "utf8");
    } catch {
      continue;
    }
    for (const needle of needles)
      assert.ok(!text.includes(needle), `${file} names ${needle}`);
  }
  // The product module itself still ships the closed constant.
  assert.match(
    readFileSync(path.join(ROOT, GRAPH_AVAILABILITY_MODULE), "utf8"),
    /export const NIR1_GRAPH_UI_ENABLED = false as const;/,
  );
  // The importers are the product's (DR-CP3B-2); a new importer needs review.
  const importers = execFileSync(
    "git",
    ["grep", "-l", 'nir1GraphAvailability"', "--", "src"],
    { cwd: ROOT, encoding: "utf8" },
  )
    .split("\n")
    .filter((file) => file && !/\.test\.tsx?$/u.test(file))
    .sort();
  assert.deepEqual(importers, [...GRAPH_AVAILABILITY_IMPORTERS]);
  assert.match(
    readFileSync(path.join(ROOT, GRAPH_AVAILABILITY_STUB), "utf8"),
    /export const NIR1_GRAPH_UI_ENABLED = true as const;/,
  );
});

test("static request paths stay inside the bundle", () => {
  assert.equal(staticRequestPath("/"), "index.html");
  assert.equal(
    staticRequestPath("/assets/index-1.js?x=1"),
    "assets/index-1.js",
  );
  assert.equal(staticRequestPath("/a%20b.txt"), "a b.txt");
  for (const bad of [
    "/../etc/passwd",
    "/assets/%2e%2e/%2e%2e/x",
    "/a%2fb",
    "/a%5cb",
    "/a%00b",
    "/a\\b",
    "/./x",
    "/%E0%A4%A",
  ])
    assert.equal(staticRequestPath(bad), null, bad);
});

test("the static server serves files on 127.0.0.1 only and refuses the rest", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cp4-static-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "cp4-outside-"));
  try {
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><p>ok</p>");
    writeFileSync(path.join(dir, "assets", "a.js"), "export {};");
    writeFileSync(path.join(outside, "secret.txt"), "secret");
    symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "link.txt"));
    const server = await startStaticServer({ dir });
    try {
      assert.match(server.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
      const index = await fetch(server.url("/"));
      assert.equal(index.status, 200);
      assert.match(index.headers.get("content-type"), /text\/html/);
      assert.equal(await index.text(), "<!doctype html><p>ok</p>");
      const js = await fetch(server.url("/assets/a.js"));
      assert.match(js.headers.get("content-type"), /javascript/);
      assert.equal((await fetch(server.url("/link.txt"))).status, 404);
      assert.equal((await fetch(server.url("/assets"))).status, 404);
      assert.equal((await fetch(server.url("/missing"))).status, 404);
      assert.equal(
        (await fetch(server.url("/assets/a.js"), { method: "POST" })).status,
        405,
      );
      assert.equal(server.requests.byStatus["200"], 2);
      assert.equal(server.requests.paths["assets/a.js"], 1);
    } finally {
      await server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("the bundle identity lists every file and digests the list", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cp4-bundle-"));
  try {
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "index.html"), "a");
    writeFileSync(path.join(dir, "assets", "b.js"), "b");
    const first = await bundleIdentity(dir);
    assert.deepEqual(
      first.files.map((row) => row.path),
      ["assets/b.js", "index.html"],
    );
    writeFileSync(path.join(dir, "assets", "b.js"), "c");
    const second = await bundleIdentity(dir);
    assert.notEqual(first.rendererBundleSha256, second.rendererBundleSha256);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
