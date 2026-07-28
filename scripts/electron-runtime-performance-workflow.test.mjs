import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

import { closeElectronAppWithDiagnostics } from "../electron/scripts/close-electron-app.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const metricsPath =
  ".artifacts/electron-runtime-performance/runtime-metrics.json";

async function read(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

function allRunCommands(job) {
  return job.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
}

test("package.json exposes deterministic Electron runtime performance contracts", async () => {
  const packageJson = JSON.parse(await read("package.json"));

  assert.equal(
    packageJson.scripts["test:electron-perf"],
    "node --test scripts/electron-runtime-performance-workflow.test.mjs scripts/runtime-performance-fixture.test.mjs scripts/runtime-performance-budget.test.mjs",
  );
  assert.equal(
    packageJson.scripts["electron:perf:ci"],
    `node electron/scripts/performance-benchmark.mjs --output ${metricsPath}`,
  );
});

test("CI runs a fixed Linux Electron runtime gate and always publishes its evidence", async () => {
  const workflow = yaml.load(await read(".github/workflows/ci.yml"));
  const job = workflow.jobs["electron-runtime-performance"];

  assert.ok(job, "electron-runtime-performance job is required");
  assert.equal(job.name, "Electron runtime performance (50k chars / 20 Beats)");
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(job["timeout-minutes"], 30);

  const commands = allRunCommands(job);
  assert.match(commands, /pnpm test:electron-perf/);
  assert.match(commands, /pnpm exec playwright install-deps chromium/);
  assert.match(commands, /pnpm napi:build/);
  assert.match(commands, /pnpm electron:build/);
  assert.match(
    commands,
    /xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" pnpm electron:perf:ci/,
  );

  const upload = job.steps.find(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/upload-artifact@"),
  );
  assert.ok(upload, "runtime metrics must be uploaded");
  assert.equal(upload.if, "always()");
  assert.equal(upload.with.path, metricsPath);
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(upload.with["retention-days"], 14);
});

test("runtime frame gate pins active-foreground Chromium timing semantics", async () => {
  const source = await read("electron/scripts/smoke.mjs");
  for (const flag of [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ]) {
    assert.match(source, new RegExp(`"${flag}"`));
  }
  assert.match(
    source,
    /if \(performanceOutputPath\) \{\s+[\s\S]*?args\.push\(\.\.\.RUNTIME_PERFORMANCE_FOREGROUND_SWITCHES\);\s+\}/,
  );
  assert.match(
    source,
    /async function ensureBenchmarkPageForeground\(page\) \{\s+await page\.bringToFront\(\);\s+await page\.waitForFunction\(\s*\(\) =>\s*document\.visibilityState === "visible" &&\s*document\.hidden === false,/,
  );
  assert.equal(
    source.match(/await ensureBenchmarkPageForeground\(page\);/g)?.length,
    3,
    "launch, Timeline, and Chronicle must all establish an active Page",
  );
});

test("Chronicle runtime readiness proves full state with a bounded DOM projection", async () => {
  const source = await read("electron/scripts/smoke.mjs");
  const start = source.indexOf(
    "async function measureChroniclePan(page, memorySampler)",
  );
  const end = source.indexOf("function shouldMeasureReviewScenario", start);
  const measure = source.slice(start, end);

  assert.match(measure, /data-chronicle-total-event-count/);
  assert.match(measure, /data-chronicle-rendered-marker-count/);
  assert.match(measure, /data-chronicle-total-edge-count/);
  assert.match(measure, /data-chronicle-rendered-edge-count/);
  assert.match(measure, /renderedMarkers > 0/);
  assert.match(measure, /renderedMarkers < totalEvents/);
  assert.doesNotMatch(
    measure,
    /querySelectorAll\("#chronicle-track \[data-event-id\]"\)\.length\s*>=/,
  );
});

test("Chronicle frame driver exercises vertical window replacement and verifies it", async () => {
  const source = await read("electron/scripts/smoke.mjs");
  assert.match(source, /scrollViewportHeight \* 1\.5/);
  assert.match(
    source,
    /markerProjection\.totalEdgeCount >=\s+Math\.min\(Math\.max\(PERF_CHRONICLE_EVENT_COUNT - 1, 0\), 1_000\)/,
  );
  assert.doesNotMatch(
    source,
    /Math\.max\(markerProjection\.totalEventCount - 1, 0\)/,
  );
  assert.match(source, /finalScrollTop > initialScrollTop/);
  assert.match(
    source,
    /finalRenderWindowTop > markerProjection\.renderWindowTop/,
  );
  assert.match(source, /markerWindowReplaced/);
  assert.match(
    source,
    /finalRenderedMarkerCount < markerProjection\.totalEventCount/,
  );
});

test("large-view runtime measurements close each panel before opening the next", async () => {
  const source = await read("electron/scripts/smoke.mjs");
  const start = source.indexOf(
    "async function sampleLargeFixtureViews(page, memorySampler)",
  );
  const end = source.indexOf("// ── フェーズ 1:", start);
  const sampleViews = source.slice(start, end);

  const mapMeasure = sampleViews.indexOf(
    "await measureMapView(page, memorySampler);",
  );
  const mapClose = sampleViews.indexOf('"map"', mapMeasure);
  const timelineMeasure = sampleViews.indexOf(
    "await measureTimelineView(page, memorySampler);",
  );
  const timelineClose = sampleViews.indexOf('"timeline"', timelineMeasure);
  const chronicleMeasure = sampleViews.indexOf(
    "await measureChroniclePan(page, memorySampler);",
  );
  const chronicleClose = sampleViews.indexOf('"chronicle"', chronicleMeasure);

  assert.ok(mapMeasure >= 0 && mapClose > mapMeasure);
  assert.ok(timelineMeasure > mapClose && timelineClose > timelineMeasure);
  assert.ok(
    chronicleMeasure > timelineClose && chronicleClose > chronicleMeasure,
  );
});

class FakeElectronProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = 1234;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
  }

  exit(code = 0, signal = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function pendingPromise() {
  return new Promise(() => {});
}

test("Electron close accepts main-process exit even if Playwright close never settles", async () => {
  const childProcess = new FakeElectronProcess();
  const page = {
    isClosed: () => true,
    evaluate: () => {
      throw new Error("closed Page must not be inspected");
    },
  };
  const close = closeElectronAppWithDiagnostics(
    {
      process: () => childProcess,
      close: pendingPromise,
    },
    page,
    "restart",
    { timeoutMs: 50 },
  );

  childProcess.exit();
  await close;
});

test("Electron close waits briefly for process exit after the Page has closed", async () => {
  const childProcess = new FakeElectronProcess();
  let evaluateCalls = 0;
  const close = closeElectronAppWithDiagnostics(
    {
      process: () => childProcess,
      close: pendingPromise,
    },
    {
      isClosed: () => true,
      evaluate: () => {
        evaluateCalls += 1;
      },
    },
    "restart",
    {
      timeoutMs: 5,
      processExitGraceMs: 100,
      pageDiagnosticsTimeoutMs: 5,
    },
  );

  globalThis.setTimeout(() => childProcess.exit(), 20);
  await close;
  assert.equal(evaluateCalls, 0);
});

test("Electron close does not mistake Page closure for process exit", async () => {
  const childProcess = new FakeElectronProcess();
  await assert.rejects(
    closeElectronAppWithDiagnostics(
      {
        process: () => childProcess,
        close: pendingPromise,
      },
      {
        isClosed: () => true,
        evaluate: () => {
          throw new Error("closed Page must not be inspected");
        },
      },
      "restart",
      {
        timeoutMs: 5,
        processExitGraceMs: 5,
        pageDiagnosticsTimeoutMs: 5,
      },
    ),
    (error) => {
      assert.match(error.message, /^restart app close timed out:/);
      assert.match(error.message, /"pageClosed":true/);
      assert.match(error.message, /"pid":1234/);
      assert.match(error.message, /"exitCode":null/);
      return true;
    },
  );
});
