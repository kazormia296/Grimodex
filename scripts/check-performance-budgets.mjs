import { gzipSync } from "node:zlib";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const DIST_DIR = path.resolve("dist/assets");
const INITIAL_JS_MAX_BYTES = 1_350_000;
const INITIAL_JS_MAX_GZIP_BYTES = 400_000;

function findExactlyOne(pattern, files) {
  const matches = files.filter((file) => pattern.test(file));
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one asset matching ${pattern}, found ${matches.length}`,
    );
  }
  return matches[0];
}

function checkAsset(name, maxBytes, maxGzipBytes) {
  const content = readFileSync(path.join(DIST_DIR, name));
  const gzipBytes = gzipSync(content, { level: 9 }).byteLength;
  if (content.byteLength > maxBytes || gzipBytes > maxGzipBytes) {
    throw new Error(
      `${name} exceeds budget: raw=${content.byteLength} (max ${maxBytes}), gzip=${gzipBytes} (max ${maxGzipBytes})`,
    );
  }
  console.log(
    `[perf-budget] ${name}: raw=${content.byteLength}, gzip=${gzipBytes}`,
  );
}

const files = readdirSync(DIST_DIR);
const initial = findExactlyOne(/^index-[^/]+\.js$/, files);
checkAsset(initial, INITIAL_JS_MAX_BYTES, INITIAL_JS_MAX_GZIP_BYTES);

for (const required of [
  /^SettingsDialog-[^/]+\.js$/,
  /^MapPanel-[^/]+\.js$/,
  /^GalaxyCanvas-[^/]+\.js$/,
]) {
  const asset = findExactlyOne(required, files);
  if (statSync(path.join(DIST_DIR, asset)).size === 0) {
    throw new Error(`${asset} is empty`);
  }
  console.log(`[perf-budget] lazy boundary present: ${asset}`);
}
