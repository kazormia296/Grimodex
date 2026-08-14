import assert from "node:assert/strict";
import test from "node:test";
import {
  collectFontAssetNames,
  collectHtmlEntrypointAssets,
  INITIAL_JS_GRAPH_BUDGET,
  resolveRatchetedBudget,
} from "./check-performance-budgets.mjs";

test("collectHtmlEntrypointAssets includes the full modulepreload graph", () => {
  const assets = collectHtmlEntrypointAssets(`
    <script crossorigin src="/assets/index-entry.js" type="module"></script>
    <link href="/assets/shared-a.js" rel="modulepreload" crossorigin>
    <link rel="modulepreload" href="/assets/shared-b.js">
    <link rel="stylesheet" href="/assets/index.css">
    <link rel="prefetch" href="/assets/lazy.js">
    <script type="module" src="https://example.com/remote.js"></script>
  `);

  assert.deepEqual(assets.js.sort(), [
    "index-entry.js",
    "shared-a.js",
    "shared-b.js",
  ]);
  assert.deepEqual(assets.css, ["index.css"]);
});

test("collectHtmlEntrypointAssets deduplicates repeated preload entries", () => {
  const assets = collectHtmlEntrypointAssets(`
    <script type="module" src="/assets/index.js"></script>
    <link rel="modulepreload" href="/assets/index.js">
  `);

  assert.deepEqual(assets.js, ["index.js"]);
});

test("collectFontAssetNames follows every startup stylesheet", () => {
  const fonts = collectFontAssetNames(
    [
      "@font-face{src:url('./first.woff2') format('woff2')}",
      "@font-face{src:url(/assets/second.woff2) format('woff2')}",
      "@font-face{src:url('./not-emitted.woff2') format('woff2')}",
    ],
    ["first.woff2", "second.woff2"],
  );

  assert.deepEqual(Array.from(fonts).sort(), ["first.woff2", "second.woff2"]);
});

test("initial JS budget allows bounded shared-chunk churn without chasing bytes", () => {
  const budget = resolveRatchetedBudget(INITIAL_JS_GRAPH_BUDGET);

  assert.equal(
    budget.gzipBytes,
    INITIAL_JS_GRAPH_BUDGET.baseline.gzipBytes +
      INITIAL_JS_GRAPH_BUDGET.allowance.gzipBytes,
  );
  assert.equal(
    budget.rawBytes,
    INITIAL_JS_GRAPH_BUDGET.baseline.rawBytes +
      INITIAL_JS_GRAPH_BUDGET.allowance.rawBytes,
  );
});

test("initial JS budget never lets the ratchet cross the absolute ceiling", () => {
  const budget = resolveRatchetedBudget({
    baseline: { rawBytes: 4_200_000, gzipBytes: 1_340_000 },
    allowance: { rawBytes: 100_000, gzipBytes: 100_000 },
    absoluteMax: { rawBytes: 4_250_000, gzipBytes: 1_350_000 },
  });

  assert.deepEqual(budget, { rawBytes: 4_250_000, gzipBytes: 1_350_000 });
  assert.throws(
    () =>
      resolveRatchetedBudget({
        baseline: { rawBytes: 4_300_000, gzipBytes: 1_300_000 },
        allowance: { rawBytes: 0, gzipBytes: 0 },
        absoluteMax: { rawBytes: 4_250_000, gzipBytes: 1_350_000 },
      }),
    /absolute ceiling/,
  );
});
