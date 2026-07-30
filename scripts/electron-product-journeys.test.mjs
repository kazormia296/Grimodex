import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

import { PRODUCT_JOURNEY_CATALOG } from "../electron/scripts/product-journey-catalog.mjs";
import { createProductJourneyHarness } from "../electron/scripts/product-journey-harness.mjs";
import { PRODUCT_JOURNEYS } from "../electron/scripts/product-journeys.mjs";

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

test("package.json exposes the isolated Electron product journey runner", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  assert.equal(
    packageJson.scripts["electron:product-journeys"],
    "node electron/scripts/product-journeys.mjs",
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

test("CI plans affected product journeys before dependency setup and schedules nightly all", async () => {
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
    options: ["all", "affected", "shadow"],
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
  assert.match(selector.env.PRODUCT_JOURNEY_MODE, /pull_request/);
  assert.match(selector.env.PRODUCT_JOURNEY_MODE, /refs\/heads\/master/);
  assert.match(selector.env.PRODUCT_JOURNEY_MODE, /affected/);
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

test("catalog and runner implementation IDs match in deterministic order", () => {
  assert.deepEqual(
    PRODUCT_JOURNEYS.map((journey) => journey.id),
    PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
  );
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
    process: () => ({ stdout: null, stderr: null }),
  };
  const harness = createProductJourneyHarness({
    mainCjs: "/tmp/fake-main.cjs",
    electronBin: "/tmp/fake-electron",
    artifactRoot,
    electronLauncher: {
      launch: async () => app,
    },
    closeApp: async () => {
      events.push("close");
      pageClosed = true;
    },
  });
  t.after(async () => {
    await rm(harness.tmpRoot, { recursive: true, force: true });
    await rm(artifactRoot, { recursive: true, force: true });
  });

  const launched = await harness.launch("editor-persistence/write");
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
    "",
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
});
