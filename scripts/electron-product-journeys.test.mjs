import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

import { PRODUCT_JOURNEY_CATALOG } from "../electron/scripts/product-journey-catalog.mjs";
import {
  createProductJourneyHarness,
  MAIN_PROCESS_NOISE_ALLOWLIST,
} from "../electron/scripts/product-journey-harness.mjs";
import {
  configureWorkspace,
  PRODUCT_JOURNEYS,
} from "../electron/scripts/product-journeys.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function read(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

function runCommands(job) {
  return job.steps
    .filter((step) => typeof step.run === "string")
    .map((step) => step.run)
    .join("\n");
}

test("package.json exposes the runner and canonical product journey contracts", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  assert.equal(
    packageJson.scripts["electron:product-journeys"],
    "node electron/scripts/product-journeys.mjs",
  );
  assert.ok(
    packageJson.scripts["test:product-journey-contracts"]
      .split(/\s+/)
      .includes("scripts/product-journey-mcp-client.test.mjs"),
    "canonical product journey contracts must include the MCP client tests",
  );
});

test("CI has a dedicated product-journeys gate with native Electron and SQLite", async () => {
  const workflow = yaml.load(await read(".github/workflows/ci.yml"));
  const job = workflow.jobs["electron-product-journeys"];
  const electronJob = workflow.jobs.electron;

  assert.ok(job, "electron-product-journeys job is required");
  assert.equal(job["runs-on"], "ubuntu-24.04");
  const commands = runCommands(job);
  assert.match(commands, /pnpm exec playwright install-deps chromium/);
  assert.match(commands, /pnpm napi:build/);
  assert.match(commands, /pnpm electron:build/);
  assert.match(
    commands,
    /xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" pnpm electron:product-journeys/,
  );

  const upload = job.steps.find(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/upload-artifact@"),
  );
  assert.ok(upload, "product journey failures must upload artifacts");
  assert.equal(upload.if, "always()");
  assert.equal(upload.with.path, ".artifacts/product-journeys");
  assert.equal(upload.with["retention-days"], 14);
  assert.match(
    runCommands(electronJob),
    /scripts\/product-journey-mcp-client\.test\.mjs/,
  );
});

test("CI exposes only all/shadow manually, plans shadow for PR and master before setup, and schedules nightly all", async () => {
  const workflow = yaml.load(await read(".github/workflows/ci.yml"));
  const input = workflow.on.workflow_call.inputs.product_journey_mode;
  const manualInput = workflow.on.workflow_dispatch.inputs.product_journey_mode;
  const job = workflow.jobs["electron-product-journeys"];
  const checkoutIndex = job.steps.findIndex((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  const selectorIndex = job.steps.findIndex(
    (step) => step.id === "product-journey-impact",
  );
  const nativeDependenciesIndex = job.steps.findIndex(
    (step) => step.name === "Native build dependencies",
  );

  assert.deepEqual(input, {
    description: "Product journey selection mode",
    required: false,
    type: "string",
    default: "all",
  });
  assert.deepEqual(manualInput, {
    description: "Product journey selection mode",
    required: true,
    type: "choice",
    default: "all",
    options: ["all", "shadow"],
  });
  assert.deepEqual(workflow.on.schedule, [{ cron: "17 18 * * *" }]);
  assert.ok(checkoutIndex >= 0, "product journey checkout is required");
  assert.equal(job.steps[checkoutIndex].with["fetch-depth"], 0);
  assert.equal(
    selectorIndex,
    checkoutIndex + 1,
    "selector must run immediately after checkout",
  );
  assert.ok(
    selectorIndex < nativeDependenciesIndex,
    "selector must run before native dependency setup",
  );

  const selector = job.steps[selectorIndex];
  assert.match(
    selector.env.PRODUCT_JOURNEY_MODE,
    /inputs\.product_journey_mode/,
  );
  assert.match(
    selector.env.PRODUCT_JOURNEY_MODE,
    /github\.event_name == 'pull_request' && 'shadow'/,
  );
  assert.match(
    selector.env.PRODUCT_JOURNEY_MODE,
    /refs\/heads\/master' && 'shadow'/,
  );
  assert.match(selector.env.PRODUCT_JOURNEY_MODE, /schedule/);
  assert.match(selector.env.PRODUCT_JOURNEY_MODE, /all/);
  assert.match(
    selector.env.PRODUCT_JOURNEY_BASE_SHA,
    /github\.event\.pull_request\.base\.sha/,
  );
  assert.match(selector.env.PRODUCT_JOURNEY_BASE_SHA, /github\.event\.before/);
  assert.match(
    selector.env.PRODUCT_JOURNEY_HEAD_SHA,
    /github\.event\.pull_request\.head\.sha/,
  );
  assert.match(selector.env.PRODUCT_JOURNEY_HEAD_SHA, /github\.sha/);
  assert.match(
    selector.run,
    /node electron\/scripts\/product-journey-impact\.mjs/,
  );
  assert.match(selector.run, /--mode "\$PRODUCT_JOURNEY_MODE"/);
  assert.match(selector.run, /--base "\$PRODUCT_JOURNEY_BASE_SHA"/);
  assert.match(selector.run, /--head "\$PRODUCT_JOURNEY_HEAD_SHA"/);
  assert.match(
    selector.run,
    /--report "\$GRIMODEX_PRODUCT_JOURNEY_ARTIFACT_DIR\/impact\.json"/,
  );

  const gate = job.steps.find((step) => step.name === "Product journey gate");
  const shouldRunCondition =
    "steps.product-journey-impact.outputs.should_run == 'true'";
  const gateIndex = job.steps.indexOf(gate);
  for (const step of job.steps.slice(nativeDependenciesIndex, gateIndex + 1)) {
    if (step.name === "Build selected MCP journey dependency") continue;
    assert.equal(
      step.if,
      shouldRunCondition,
      `${step.name ?? step.uses ?? step.run} must skip expensive setup when no journey is selected`,
    );
  }
  assert.equal(gate.if, shouldRunCondition);
  assert.equal(
    gate.env.GRIMODEX_PRODUCT_JOURNEY_IDS,
    "${{ steps.product-journey-impact.outputs.execution_journey_ids }}",
  );
  assert.equal(
    gate.run,
    'xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" pnpm electron:product-journeys',
  );

  const mcpBuild = job.steps.find(
    (step) => step.name === "Build selected MCP journey dependency",
  );
  assert.ok(mcpBuild, "capability-gated MCP build is required");
  assert.equal(mcpBuild.run, "pnpm mcp:build");
  assert.match(mcpBuild.if, /should_run.*true/);
  assert.match(mcpBuild.if, /execution_capabilities.*mcp/);
});

test("nightly schedule skips every non-product CI job", async () => {
  const workflow = yaml.load(await read(".github/workflows/ci.yml"));
  const productJourneyJobId = "electron-product-journeys";
  const jobEntries = Object.entries(workflow.jobs);

  assert.ok(
    jobEntries.some(([jobId]) => jobId === productJourneyJobId),
    "electron-product-journeys job is required",
  );
  for (const [jobId, job] of jobEntries) {
    if (jobId === productJourneyJobId) continue;
    assert.equal(
      job.if,
      "github.event_name != 'schedule'",
      `${jobId} must skip the product-journey-only nightly schedule`,
    );
  }
  assert.notEqual(
    workflow.jobs[productJourneyJobId].if,
    "github.event_name != 'schedule'",
    "the product journey job must remain enabled for the nightly schedule",
  );
});

test("catalog and runner implementation IDs match in deterministic order", () => {
  assert.deepEqual(
    PRODUCT_JOURNEYS.map((journey) => journey.id),
    PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
  );
});

test("workspace pairs are created in one cold configure session before startup auto-open", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-workspace-pair-"),
  );
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const workspaceA = path.join(temporaryRoot, "workspace-a");
  const workspaceB = path.join(temporaryRoot, "workspace-b");
  const calls = [];
  const app = {};
  const page = {};
  const harness = {
    async launch(phase) {
      calls.push({ kind: "launch", phase });
      return { app, page };
    },
    async invokeOk(_page, command, args) {
      calls.push({ kind: "invoke", command, args });
      if (command === "get_global_settings") {
        return {
          recentWorkspaces: [],
          trustedWorkspaces: [],
          showLauncherOnStartup: true,
        };
      }
      return undefined;
    },
    async close(closedApp, closedPage, phase) {
      calls.push({ kind: "close", closedApp, closedPage, phase });
    },
  };

  await configureWorkspace(harness, workspaceA, {
    appSettings: { "editor.autoSaveDelay": 60_000 },
    additionalWorkspaces: [workspaceB],
  });

  assert.deepEqual(
    calls
      .filter(
        (call) => call.kind === "invoke" && call.command === "open_workspace",
      )
      .map((call) => call.args.path),
    [workspaceA, workspaceB, workspaceA],
    "the secondary DB must be created and authority restored before the cold configure renderer closes",
  );
  assert.equal(
    calls.filter((call) => call.kind === "launch").length,
    1,
    "pair setup must not launch an auto-opening renderer between DB swaps",
  );
  const savedSettings = calls.find(
    (call) => call.kind === "invoke" && call.command === "save_global_settings",
  );
  assert.deepEqual(savedSettings.args.settings.trustedWorkspaces, [
    workspaceA,
    workspaceB,
  ]);
  assert.equal(savedSettings.args.settings.lastActiveWorkspace, workspaceA);
  assert.equal(savedSettings.args.settings.showLauncherOnStartup, false);
});

test("product runner keeps the real boundary assertions", async () => {
  const source = await read("electron/scripts/product-journeys.mjs");
  assert.match(source, /open_workspace/);
  assert.match(source, /db_execute/);
  assert.match(source, /workspace-menu-trigger/);
  assert.match(source, /PENDING_SAVE_AUTOSAVE_DELAY_MS\s*=\s*60_000/);
  assert.match(source, /pending-editor-draft/);
  assert.match(source, /workspaceOpenRevision/);
  assert.match(source, /persistedBeforeSwitch/);
  assert.match(source, /leakedIntoWorkspaceB/);
  assert.match(source, /persistedAfterReturn/);
  assert.match(source, /workspace B received workspace A pending editor text/);
  assert.match(source, /clean-external-write-reloaded/);
  assert.match(source, /dirty-external-write-conflict/);
  assert.match(source, /undoHistoryInvalidated/);
  assert.match(source, /external-edit-reload/);
  assert.match(source, /chat-late-chunk-isolated/);
  assert.match(source, /staleChunkInNewScope:\s*false/);
  assert.match(source, /promptSnapshotInNewScope:\s*false/);
  assert.match(source, /sessionMutationInNewScope:\s*false/);
  assert.match(source, /cross-feature-authoring-persisted/);
  assert.match(source, /promptIncludedCodex:\s*true/);
  assert.match(source, /aiAttributionPersisted:\s*true/);
  assert.match(source, /cross-feature-authoring-restored/);
  assert.match(source, /project-chat-stream-drained/);
  assert.match(source, /workspace-chat-stream-drained/);
  assert.match(source, /project-pending-editor-restored/);
  assert.match(source, /mcp-clean-external-write-reloaded/);
  assert.match(source, /mcp-dirty-external-write-conflict/);
  assert.match(source, /agent_chronicle_bulk_mutate/);
  assert.match(source, /chronicle-native-roundtrip-restored/);
  assert.match(source, /lint_term_dictionary_insert/);
  assert.match(source, /lint_term_dictionary_list/);
  assert.match(source, /lint-native-roundtrip-restored/);
  assert.match(source, /map_write_bundle/);
  assert.match(source, /map-native-roundtrip-restored/);
  assert.match(source, /project_snapshot_create/);
  assert.match(source, /project_snapshot_restore_context/);
  assert.match(source, /snapshot-native-roundtrip-restored/);
});

test("product harness enables only the deterministic main-boundary AI provider", async () => {
  const source = await read("electron/scripts/product-journey-harness.mjs");
  assert.match(source, /GRIMODEX_PRODUCT_JOURNEY_FAKE_AI/);
  assert.match(source, /deterministic-v1/);
  assert.match(source, /env\[PRODUCT_JOURNEY_AI_ENV\]/);
});

test("performance smoke reuses the product journey boundary helpers", async () => {
  const source = await read("electron/scripts/smoke.mjs");

  assert.match(
    source,
    /import \{ invokeOk, waitUntil \} from "\.\/product-journey-harness\.mjs";/,
  );
  assert.doesNotMatch(source, /async function invokeOk\(/);
  assert.doesNotMatch(source, /async function waitUntil\(/);
});

test("product journey harness closes Electron when firstWindow fails", async (t) => {
  const app = {
    firstWindow: async () => {
      throw new Error("window was never created");
    },
  };
  const closed = [];
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async () => app,
    },
    closeApp: async (launchedApp, page, phase) => {
      closed.push({ launchedApp, page, phase });
    },
  });
  t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

  await assert.rejects(harness.launch("startup"), /window was never created/);
  await harness.dispose({ success: false, name: "startup-failure" });

  assert.deepEqual(closed, [
    {
      launchedApp: app,
      page: null,
      phase: "failure:startup-failure",
    },
  ]);
});

test("product journey harness retains the renderer screenshot before close", async (t) => {
  const artifactRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-artifacts-"),
  );
  let pageClosed = false;
  const events = [];
  const mainStderr = new EventEmitter();
  const page = {
    isClosed: () => pageClosed,
    on: () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async ({ path: screenshotPath }) => {
      events.push("screenshot");
      await writeFile(screenshotPath, "renderer-state");
    },
  };
  const app = {
    firstWindow: async () => page,
    process: () => ({ stdout: null, stderr: mainStderr }),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    artifactRoot,
    electronLauncher: {
      launch: async () => app,
    },
    mainProcessNoiseAllowlist: [
      {
        id: "test-main-noise-only",
        phases: ["editor-persistence/write"],
        reason:
          "Proves a main-only allowance never suppresses renderer errors.",
        expiresOn: "2099-12-31",
        pattern: /lifecycle read failed/,
      },
    ],
    closeApp: async () => {
      events.push("close");
      pageClosed = true;
      mainStderr.emit("end");
    },
  });
  t.after(async () => {
    await rm(harness.tmpRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  });

  const launched = await harness.launch("editor-persistence/write");
  mainStderr.emit("data", "Error: lifecycle read failed\n");
  harness.recordTimeline("test-authority", { workspace: "workspace-a" });
  await harness.close(launched.app, launched.page, "editor-persistence/write");
  await harness.dispose({
    success: false,
    name: "editor-persistence",
  });

  assert.deepEqual(events, ["screenshot", "close"]);
  assert.equal(
    await readFile(
      path.join(artifactRoot, "editor-persistence", "renderer.png"),
      "utf8",
    ),
    "renderer-state",
  );
  const timeline = JSON.parse(
    await readFile(
      path.join(
        artifactRoot,
        "editor-persistence",
        "runtime",
        "diagnostics",
        "authority-timeline.json",
      ),
      "utf8",
    ),
  );
  assert.ok(
    timeline.some(
      (event) =>
        event.event === "test-authority" && event.workspace === "workspace-a",
    ),
  );
  assert.equal(
    await readFile(
      path.join(
        artifactRoot,
        "editor-persistence",
        "runtime",
        "diagnostics",
        "main.log",
      ),
      "utf8",
    ),
    "  [product:editor-persistence/write:main] Error: lifecycle read failed\n",
  );
  assert.equal(
    await readFile(
      path.join(
        artifactRoot,
        "editor-persistence",
        "runtime",
        "diagnostics",
        "renderer.log",
      ),
      "utf8",
    ),
    "",
  );
  const rendererDiagnostics = JSON.parse(
    await readFile(
      path.join(
        artifactRoot,
        "editor-persistence",
        "runtime",
        "diagnostics",
        "renderer-diagnostics.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(
    {
      rendererErrorCount: rendererDiagnostics.rendererErrorCount,
      pageErrors: rendererDiagnostics.pageErrors,
      mainErrorCount: rendererDiagnostics.mainErrorCount,
      unallowedMainErrors: rendererDiagnostics.unallowedMainErrors,
      mainCleanPass: rendererDiagnostics.mainCleanPass,
      cleanPass: rendererDiagnostics.cleanPass,
    },
    {
      rendererErrorCount: 0,
      pageErrors: [],
      mainErrorCount: 1,
      unallowedMainErrors: [],
      mainCleanPass: true,
      cleanPass: true,
    },
  );
  const mainDiagnostics = JSON.parse(
    await readFile(
      path.join(
        artifactRoot,
        "editor-persistence",
        "runtime",
        "diagnostics",
        "main-diagnostics.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(
    mainDiagnostics.map(({ phase, message, classification, allowance }) => ({
      phase,
      message,
      classification,
      allowance,
    })),
    [
      {
        phase: "editor-persistence/write",
        message: "Error: lifecycle read failed\n",
        classification: "error",
        allowance: {
          id: "test-main-noise-only",
          phases: ["editor-persistence/write"],
          reason:
            "Proves a main-only allowance never suppresses renderer errors.",
          expiresOn: "2099-12-31",
          pattern: "/lifecycle read failed/",
        },
      },
    ],
  );
});

test("product journey harness keeps warnings diagnostic but fails closed on close-time renderer errors", async (t) => {
  const listeners = new Map();
  const mainStderr = new EventEmitter();
  const page = {
    isClosed: () => false,
    on: (event, listener) => {
      listeners.set(event, listener);
    },
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
  };
  const app = {
    firstWindow: async () => page,
    process: () => ({ stdout: null, stderr: mainStderr }),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async () => app,
    },
    mainProcessNoiseAllowlist: [
      {
        id: "renderer-is-never-allowlisted",
        phases: ["project-switch"],
        reason: "This allowance applies only to matching main stderr.",
        expiresOn: "2099-12-31",
        pattern: /lifecycle read failed/,
      },
    ],
    closeApp: async () => {
      mainStderr.emit("end");
      setImmediate(() => {
        listeners.get("console")?.({
          type: () => "error",
          text: () => "[Global] unhandled rejection: lifecycle read failed",
          location: () => ({
            url: "app://renderer/main.js",
            lineNumber: 42,
            columnNumber: 7,
          }),
        });
        setImmediate(() => {
          listeners.get("pageerror")?.(
            Object.assign(new Error("lifecycle read failed"), {
              stack: "Error: lifecycle read failed\n    at MessageBadge",
            }),
          );
        });
      });
    },
  });
  t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

  const launched = await harness.launch("project-switch");
  mainStderr.emit("data", "Error: lifecycle read failed\n");
  listeners.get("console")?.({
    type: () => "warning",
    text: () => "optional renderer warning",
    location: () => ({}),
  });
  await harness.close(launched.app, launched.page, "project-switch");

  const error = await harness.finalizeDiagnostics().then(
    () => null,
    (cause) => cause,
  );
  assert.ok(error instanceof Error);
  assert.match(error.message, /renderer diagnostics failed/i);
  assert.deepEqual(error.diagnostics, {
    rendererErrorCount: 1,
    pageErrors: [
      {
        phase: "project-switch",
        name: "Error",
        message: "lifecycle read failed",
        stack: "Error: lifecycle read failed\n    at MessageBadge",
      },
    ],
    mainErrorCount: 1,
    unallowedMainErrors: [],
    mainCleanPass: true,
    cleanPass: false,
  });
});

test("product journey harness reports a clean pass when renderer output contains warnings only", async (t) => {
  const listeners = new Map();
  const page = {
    isClosed: () => false,
    on: (event, listener) => {
      listeners.set(event, listener);
    },
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
  };
  const app = {
    firstWindow: async () => page,
    process: () => ({ stdout: null, stderr: null }),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async () => app,
    },
    closeApp: async () => undefined,
  });
  t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

  const launched = await harness.launch("warning-only");
  listeners.get("console")?.({
    type: () => "warning",
    text: () => "tokenizer heuristic fallback",
    location: () => ({}),
  });
  await harness.close(launched.app, launched.page, "warning-only");

  assert.deepEqual(await harness.finalizeDiagnostics(), {
    rendererErrorCount: 0,
    pageErrors: [],
    mainErrorCount: 0,
    unallowedMainErrors: [],
    mainCleanPass: true,
    cleanPass: true,
  });
  await harness.dispose({ success: true, name: "warning-only" });
});

test("product journey harness fails closed on unallowed error-class main stderr", async (t) => {
  const mainStderr = new EventEmitter();
  const page = {
    isClosed: () => false,
    on: () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
  };
  const app = {
    firstWindow: async () => page,
    process: () => ({ stdout: null, stderr: mainStderr }),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async () => app,
    },
    mainProcessNoiseAllowlist: [
      {
        id: "known-current-phase",
        phases: ["main-gate"],
        reason: "Known bounded shutdown error in this exact phase.",
        expiresOn: "2099-12-31",
        pattern: /known shutdown error/,
      },
      {
        id: "wrong-phase",
        phases: ["another-phase"],
        reason: "Must not match outside the declared phase.",
        expiresOn: "2099-12-31",
        pattern: /phase mismatch/,
      },
      {
        id: "expired",
        phases: ["main-gate"],
        reason: "Must not match after its expiry.",
        expiresOn: "2000-01-01",
        pattern: /expired allowance/,
      },
      {
        id: "wrong-pattern",
        phases: ["main-gate"],
        reason: "Must not match a different stderr message.",
        expiresOn: "2099-12-31",
        pattern: /a different failure/,
      },
    ],
    closeApp: async () => {
      mainStderr.emit("end");
    },
  });
  t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

  const launched = await harness.launch("main-gate");
  mainStderr.emit(
    "data",
    "Debugger ending on ws://127.0.0.1:9229/session\nFor help, see: https://nodejs.org/\n",
  );
  mainStderr.emit("data", "Error: known shutdown error\n");
  mainStderr.emit("data", "Error: phase mismatch\n");
  mainStderr.emit("data", "Error: expired allowance\n");
  mainStderr.emit("data", "Fatal: unmatched failure\n");
  mainStderr.emit("data", "UnhandledPromiseRejectionWarning: write rejected\n");
  await harness.close(launched.app, launched.page, "main-gate");

  const error = await harness.finalizeDiagnostics().then(
    () => null,
    (cause) => cause,
  );
  assert.equal(error?.name, "MainProcessDiagnosticsError");
  assert.match(error.message, /main-process diagnostics failed/i);
  const { unallowedMainErrors, ...summary } = error.diagnostics;
  assert.deepEqual(summary, {
    rendererErrorCount: 0,
    pageErrors: [],
    mainErrorCount: 5,
    mainCleanPass: false,
    cleanPass: false,
  });
  assert.deepEqual(
    unallowedMainErrors.map(({ phase, message }) => ({ phase, message })),
    [
      { phase: "main-gate", message: "Error: phase mismatch\n" },
      { phase: "main-gate", message: "Error: expired allowance\n" },
      { phase: "main-gate", message: "Fatal: unmatched failure\n" },
      {
        phase: "main-gate",
        message: "UnhandledPromiseRejectionWarning: write rejected\n",
      },
    ],
  );
});

test("default main allowances cover only exact expiring Ubuntu Xvfb diagnostics", async (t) => {
  const mainStderr = new EventEmitter();
  const page = {
    isClosed: () => false,
    on: () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
  };
  const app = {
    firstWindow: async () => page,
    process: () => ({ stdout: null, stderr: mainStderr }),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async () => app,
    },
    closeApp: async () => {
      mainStderr.emit("end");
    },
  });
  t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

  assert.equal(MAIN_PROCESS_NOISE_ALLOWLIST.length, 4);
  const launched = await harness.launch("configure");
  mainStderr.emit(
    "data",
    '[6341:0730/134519.105645:ERROR:dbus/bus.cc:405] Failed to connect to the bus: Could not parse server address: Unknown address type (examples of valid types are "tcp" and on UNIX "unix")\n',
  );
  mainStderr.emit(
    "data",
    "[6341:0730/134519.106425:ERROR:dbus/object_proxy.cc:572] Failed to call method: org.freedesktop.DBus.NameHasOwner: object_path= /org/freedesktop/DBus: unknown error type: \n",
  );
  mainStderr.emit(
    "data",
    "[6468:0730/134521.502865:ERROR:gpu/command_buffer/service/context_group.cc:148] ContextResult::kFatalFailure: WebGL2 blocklisted\n",
  );
  mainStderr.emit(
    "data",
    "[8054:0730/135929.157713:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:395] SharedImageManager::ProduceMemory: Trying to Produce a Memory representation from a non-existent mailbox.\n",
  );
  mainStderr.emit("data", "Fatal: database corruption\n");
  await harness.close(launched.app, launched.page, "configure");

  const error = await harness.finalizeDiagnostics().then(
    () => null,
    (cause) => cause,
  );
  assert.equal(error?.name, "MainProcessDiagnosticsError");
  assert.equal(error.diagnostics.mainErrorCount, 5);
  assert.deepEqual(
    error.diagnostics.unallowedMainErrors.map(({ phase, message }) => ({
      phase,
      message,
    })),
    [{ phase: "configure", message: "Fatal: database corruption\n" }],
  );
});

test("shared-image mailbox noise remains gated outside configure and for near matches", async (t) => {
  const mainStderr = new EventEmitter();
  const page = {
    isClosed: () => false,
    on: () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
  };
  const app = {
    firstWindow: async () => page,
    process: () => ({ stdout: null, stderr: mainStderr }),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async () => app,
    },
    closeApp: async () => {
      mainStderr.emit("end");
    },
  });
  t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

  const launched = await harness.launch("chat-stream-project-switch");
  mainStderr.emit(
    "data",
    "[8054:0730/135929.157713:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:395] SharedImageManager::ProduceMemory: Trying to Produce a Memory representation from a non-existent mailbox.\n",
  );
  mainStderr.emit(
    "data",
    "[8054:0730/135929.157830:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:395] SharedImageManager::ProduceSkia: Trying to Produce a Skia representation from a non-existent mailbox.\n",
  );
  await harness.close(
    launched.app,
    launched.page,
    "chat-stream-project-switch",
  );

  const error = await harness.finalizeDiagnostics().then(
    () => null,
    (cause) => cause,
  );
  assert.equal(error?.name, "MainProcessDiagnosticsError");
  assert.equal(error.diagnostics.mainErrorCount, 2);
  assert.deepEqual(
    error.diagnostics.unallowedMainErrors.map(({ phase, message }) => ({
      phase,
      message,
    })),
    [
      {
        phase: "chat-stream-project-switch",
        message:
          "[8054:0730/135929.157713:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:395] SharedImageManager::ProduceMemory: Trying to Produce a Memory representation from a non-existent mailbox.\n",
      },
      {
        phase: "chat-stream-project-switch",
        message:
          "[8054:0730/135929.157830:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:395] SharedImageManager::ProduceSkia: Trying to Produce a Skia representation from a non-existent mailbox.\n",
      },
    ],
  );
});

test("product journey harness frames main stderr lines before applying allowances", async (t) => {
  const mainStderr = new EventEmitter();
  const page = {
    isClosed: () => false,
    on: () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
  };
  const app = {
    firstWindow: async () => page,
    process: () => ({ stdout: null, stderr: mainStderr }),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async () => app,
    },
    mainProcessNoiseAllowlist: [
      {
        id: "known-current-phase",
        phases: ["main-framing"],
        reason: "Only this one complete stderr line is known noise.",
        expiresOn: "2099-12-31",
        pattern: /^Error: known shutdown error\n$/,
      },
    ],
    closeApp: async () => {
      mainStderr.emit("end");
    },
  });
  t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

  const launched = await harness.launch("main-framing");
  mainStderr.emit(
    "data",
    "Error: known shutdown error\nFatal: coalesced database corruption\nErr",
  );
  mainStderr.emit(
    "data",
    "or: split-boundary persistence failure\nTypeError: trailing fragment",
  );
  await harness.close(launched.app, launched.page, "main-framing");

  const error = await harness.finalizeDiagnostics().then(
    () => null,
    (cause) => cause,
  );
  assert.equal(error?.name, "MainProcessDiagnosticsError");
  assert.deepEqual(
    error.diagnostics.unallowedMainErrors.map(({ phase, message }) => ({
      phase,
      message,
    })),
    [
      {
        phase: "main-framing",
        message: "Fatal: coalesced database corruption\n",
      },
      {
        phase: "main-framing",
        message: "Error: split-boundary persistence failure\n",
      },
      {
        phase: "main-framing",
        message: "TypeError: trailing fragment",
      },
    ],
  );
  assert.equal(error.diagnostics.mainErrorCount, 4);
});

test("product journey harness waits for delayed main stderr before finalizing", async (t) => {
  const mainStderr = new EventEmitter();
  const page = {
    isClosed: () => false,
    on: () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
  };
  const app = {
    firstWindow: async () => page,
    process: () => ({ stdout: null, stderr: mainStderr }),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async () => app,
    },
    mainProcessDrainTimeoutMs: 250,
    closeApp: async () => {
      setTimeout(() => {
        mainStderr.emit("data", "Fatal: emitted after process exit\n");
        mainStderr.emit("end");
      }, 20);
    },
  });
  t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

  const launched = await harness.launch("main-delayed");
  await harness.close(launched.app, launched.page, "main-delayed");

  const error = await harness.finalizeDiagnostics().then(
    () => null,
    (cause) => cause,
  );
  assert.equal(error?.name, "MainProcessDiagnosticsError");
  assert.deepEqual(
    error.diagnostics.unallowedMainErrors.map(({ phase, message }) => ({
      phase,
      message,
    })),
    [
      {
        phase: "main-delayed",
        message: "Fatal: emitted after process exit\n",
      },
    ],
  );
});

test("product journey harness fails closed when main stderr never drains", async (t) => {
  const mainStderr = new EventEmitter();
  const page = {
    isClosed: () => false,
    on: () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
  };
  const app = {
    firstWindow: async () => page,
    process: () => ({ stdout: null, stderr: mainStderr }),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async () => app,
    },
    mainProcessDrainTimeoutMs: 20,
    closeApp: async () => undefined,
  });
  t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

  const launched = await harness.launch("main-drain-timeout");
  await harness.close(launched.app, launched.page, "main-drain-timeout");

  const error = await harness.finalizeDiagnostics().then(
    () => null,
    (cause) => cause,
  );
  assert.equal(error?.name, "MainProcessDiagnosticsError");
  assert.deepEqual(
    error.diagnostics.unallowedMainErrors.map(({ phase, message }) => ({
      phase,
      message,
    })),
    [
      {
        phase: "main-drain-timeout",
        message:
          "Main stderr stream did not end or close within 20ms after application close.",
      },
    ],
  );
});

test("product journey harness opts in before launch and reads structured lifecycle events", async (t) => {
  const lifecycleEvents = [
    {
      schemaVersion: 1,
      transitionId: "project:trace",
      sequence: 0,
      timestampMs: 100,
      kind: "project",
      phase: "switch-requested",
      from: { projectId: "a" },
      to: { projectId: "b" },
    },
  ];
  let initScriptConfig = null;
  const page = {
    isClosed: () => false,
    on: () => undefined,
    waitForFunction: async () => undefined,
    screenshot: async () => undefined,
    evaluate: async (_operation, argument) => {
      if (typeof argument === "string") return lifecycleEvents;
      return undefined;
    },
  };
  const app = {
    context: () => ({
      addInitScript: async (_operation, config) => {
        initScriptConfig = config;
      },
    }),
    firstWindow: async () => page,
    process: () => ({ stdout: null, stderr: null }),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    electronLauncher: {
      launch: async () => app,
    },
    closeApp: async () => undefined,
  });
  t.after(() => rm(harness.tmpRoot, { recursive: true, force: true }));

  const launched = await harness.launch("lifecycle-trace");
  assert.equal(
    initScriptConfig.optInKey,
    "__GRIMODEX_PRODUCT_JOURNEY_LIFECYCLE_TRACE__",
  );
  assert.equal(initScriptConfig.eventName, "grimodex:lifecycle-trace");
  assert.deepEqual(
    await harness.readLifecycleTrace(launched.page),
    lifecycleEvents,
  );

  await harness.close(launched.app, launched.page, "lifecycle-trace");
  await harness.dispose({ success: true, name: "lifecycle-trace" });
});
