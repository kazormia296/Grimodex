import assert from "node:assert/strict";
import test from "node:test";
import {
  collectFontAssetNames,
  collectHtmlEntrypointAssets,
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
