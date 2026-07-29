import { gzipSync } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DIST_ROOT = path.resolve("dist");
const DIST_DIR = path.resolve("dist/assets");
const INITIAL_JS_MAX_BYTES = 4_250_000;
const INITIAL_JS_MAX_GZIP_BYTES = 1_300_000;
const INITIAL_CSS_MAX_BYTES = 240_000;
const INITIAL_CSS_MAX_GZIP_BYTES = 42_000;
const INITIAL_FONT_MAX_BYTES = 4_250_000;
const TOTAL_FONT_MAX_BYTES = 18_500_000;
const DEFAULT_FONT_CSS_PATTERNS = [
  /^notoSerifJp-[^/]+\.css$/,
  /^mPlus1-[^/]+\.css$/,
];

function assetNameFromUrl(value) {
  const pathname = value.split(/[?#]/, 1)[0];
  const prefix = "/assets/";
  if (!pathname.startsWith(prefix)) return null;
  return pathname.slice(prefix.length);
}

/**
 * Return the files the browser requests from the generated HTML before any
 * application-level dynamic import. Vite emits synchronous shared chunks as
 * modulepreload links, so checking only index-*.js substantially undercounts
 * the startup graph.
 */
export function collectHtmlEntrypointAssets(html) {
  const js = new Set();
  const css = new Set();
  for (const match of html.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const tagName = match[1].toLowerCase();
    const attributes = new Map();
    for (const attribute of match[2].matchAll(
      /([\w:-]+)\s*=\s*(["'])(.*?)\2/g,
    )) {
      attributes.set(attribute[1].toLowerCase(), attribute[3]);
    }
    if (
      tagName === "script" &&
      attributes.get("type") === "module" &&
      attributes.has("src")
    ) {
      const name = assetNameFromUrl(attributes.get("src"));
      if (name?.endsWith(".js")) js.add(name);
    }
    if (tagName !== "link" || !attributes.has("href")) continue;
    const name = assetNameFromUrl(attributes.get("href"));
    if (!name) continue;
    const rel = attributes.get("rel")?.toLowerCase();
    if (rel === "modulepreload" && name.endsWith(".js")) js.add(name);
    if (rel === "stylesheet" && name.endsWith(".css")) css.add(name);
  }
  return { js: Array.from(js), css: Array.from(css) };
}

export function collectFontAssetNames(cssTexts, availableFontFiles) {
  const available = new Set(availableFontFiles);
  return new Set(
    cssTexts
      .flatMap((cssText) =>
        Array.from(
          cssText.matchAll(/url\((?:["']?)([^)"']+\.woff2)/g),
          (match) => path.basename(match[1]),
        ),
      )
      .filter((name) => available.has(name)),
  );
}

function findExactlyOne(pattern, files) {
  const matches = files.filter((file) => pattern.test(file));
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one asset matching ${pattern}, found ${matches.length}`,
    );
  }
  return matches[0];
}

function measureAsset(name) {
  const content = readFileSync(path.join(DIST_DIR, name));
  return {
    rawBytes: content.byteLength,
    gzipBytes: gzipSync(content, { level: 9 }).byteLength,
  };
}

function checkAsset(name, maxBytes, maxGzipBytes) {
  const measured = measureAsset(name);
  if (measured.rawBytes > maxBytes || measured.gzipBytes > maxGzipBytes) {
    throw new Error(
      `${name} exceeds budget: raw=${measured.rawBytes} (max ${maxBytes}), gzip=${measured.gzipBytes} (max ${maxGzipBytes})`,
    );
  }
  console.log(
    `[perf-budget] ${name}: raw=${measured.rawBytes}, gzip=${measured.gzipBytes}`,
  );
  return measured;
}

function checkAssetSet(label, names, maxBytes, maxGzipBytes) {
  const measured = names.reduce(
    (total, name) => {
      const asset = measureAsset(name);
      total.rawBytes += asset.rawBytes;
      total.gzipBytes += asset.gzipBytes;
      return total;
    },
    { rawBytes: 0, gzipBytes: 0 },
  );
  if (measured.rawBytes > maxBytes || measured.gzipBytes > maxGzipBytes) {
    throw new Error(
      `${label} exceeds budget: raw=${measured.rawBytes} (max ${maxBytes}), gzip=${measured.gzipBytes} (max ${maxGzipBytes}), assets=${names.length}`,
    );
  }
  console.log(
    `[perf-budget] ${label}: raw=${measured.rawBytes}, gzip=${measured.gzipBytes}, assets=${names.length}`,
  );
  return measured;
}

const lazyBudgets = [
  [/^SettingsDialog-[^/]+\.js$/, 240_000, 60_000],
  [/^MapPanel-[^/]+\.js$/, 340_000, 100_000],
  [/^GalaxyCanvas-[^/]+\.js$/, 1_500_000, 420_000],
  [/^ChatPanel-[^/]+\.js$/, 240_000, 70_000],
  [/^ChroniclePanel-[^/]+\.js$/, 540_000, 175_000],
  [/^GridPanel-[^/]+\.js$/, 180_000, 55_000],
  [/^TimelinePanel-[^/]+\.js$/, 140_000, 45_000],
];

export function main() {
  const files = readdirSync(DIST_DIR);
  const html = readFileSync(path.join(DIST_ROOT, "index.html"), "utf8");
  const htmlAssets = collectHtmlEntrypointAssets(html);
  checkAssetSet(
    "initial JS graph",
    htmlAssets.js,
    INITIAL_JS_MAX_BYTES,
    INITIAL_JS_MAX_GZIP_BYTES,
  );
  const defaultFontCss = DEFAULT_FONT_CSS_PATTERNS.map((pattern) =>
    findExactlyOne(pattern, files),
  );
  const startupCss = Array.from(
    new Set([...htmlAssets.css, ...defaultFontCss]),
  );
  checkAssetSet(
    "startup CSS graph",
    startupCss,
    INITIAL_CSS_MAX_BYTES,
    INITIAL_CSS_MAX_GZIP_BYTES,
  );

  for (const [pattern, rawBudget, gzipBudget] of lazyBudgets) {
    const asset = findExactlyOne(pattern, files);
    checkAsset(asset, rawBudget, gzipBudget);
    console.log(`[perf-budget] lazy boundary within budget: ${asset}`);
  }

  const fontFiles = files.filter((file) => file.endsWith(".woff2"));
  const totalFontBytes = fontFiles.reduce(
    (total, file) => total + statSync(path.join(DIST_DIR, file)).size,
    0,
  );
  if (totalFontBytes > TOTAL_FONT_MAX_BYTES) {
    throw new Error(
      `font assets exceed distribution budget: total=${totalFontBytes} (max ${TOTAL_FONT_MAX_BYTES})`,
    );
  }

  const startupFontNames = collectFontAssetNames(
    startupCss.map((name) => readFileSync(path.join(DIST_DIR, name), "utf8")),
    fontFiles,
  );
  const startupFontBytes = Array.from(startupFontNames).reduce(
    (total, file) => total + statSync(path.join(DIST_DIR, file)).size,
    0,
  );
  if (startupFontBytes > INITIAL_FONT_MAX_BYTES) {
    throw new Error(
      `startup font assets exceed budget: total=${startupFontBytes} (max ${INITIAL_FONT_MAX_BYTES})`,
    );
  }
  console.log(
    `[perf-budget] fonts: startup=${startupFontBytes} (${startupFontNames.size} files), distribution=${totalFontBytes} (${fontFiles.length} files)`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main();
}
