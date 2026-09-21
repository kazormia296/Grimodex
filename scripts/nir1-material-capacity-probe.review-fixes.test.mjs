import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Exercise the real pure aggregation functions without running the probe's
// CLI main(), creating fixtures, or launching child processes.
const source = readFileSync(new URL("./nir1-material-capacity-probe.mjs", import.meta.url), "utf8");
const start = source.indexOf("function numericValues(");
const end = source.indexOf("\nfunction uniqueNotMeasured(", start);
assert.ok(start >= 0 && end > start, "capacity aggregation boundaries must remain identifiable");
const { summarize } = runInNewContext(`${source.slice(start, end)}\n({ summarize });`, {}, { timeout: 1_000 });

test("missing peaks remain null despite a sampled RSS", () => {
  const summary = summarize([{ process: { totalPeakRssBytes: null, hwmRssBytes: null, ruMaxrssBytes: null, rssBytes: 67108864 } }]);
  assert.equal(summary.medianPeakRssBytes, null);
  assert.equal(summary.maxPeakRssBytes, null);
});

test("a valid high-water sample remains a peak source", () => {
  const summary = summarize([{ process: { totalPeakRssBytes: null, hwmRssBytes: 128, ruMaxrssBytes: null, rssBytes: 32 } }]);
  assert.equal(summary.medianPeakRssBytes, 128);
  assert.equal(summary.maxPeakRssBytes, 128);
});

test("getrusage peak remains available when procfs is absent", () => {
  const summary = summarize([{ process: { totalPeakRssBytes: null, hwmRssBytes: null, ruMaxrssBytes: 256, rssBytes: 32 } }]);
  assert.equal(summary.maxPeakRssBytes, 256);
});

test("current RSS cannot lower the median of genuine peak samples", () => {
  const summary = summarize([
    { process: { totalPeakRssBytes: 100, rssBytes: 1 } },
    { process: { totalPeakRssBytes: null, hwmRssBytes: null, ruMaxrssBytes: null, rssBytes: 1 } },
    { process: { totalPeakRssBytes: 300, rssBytes: 1 } },
  ]);
  assert.equal(summary.medianPeakRssBytes, 200);
  assert.equal(summary.maxPeakRssBytes, 300);
});
