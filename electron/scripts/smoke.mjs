/**
 * Playwright `_electron` スモーク（設計書 §8 S8、受け入れ条件 A2/A9 の自動化）。
 *
 * シナリオ（3 回起動、すべて一時 userData / 一時 workspace に隔離）:
 * 1. seed 起動   : app://bundle ロードを確認 → ブリッジ経由で一時 workspace を
 *                  作成（open_workspace = migrate + VACUUM INTO バックアップ）→
 *                  信頼リスト等を global settings へ書いて終了
 * 2. 執筆起動    : lastActiveWorkspace の自動オープン → シーン作成（UI 操作）→
 *                  エディタへ本文入力 → オートセーブ（db_execute_batch 経由）が
 *                  DB へ着弾するまで待って終了
 * 3. 再起動 assert: DB に本文が残存（ブリッジ経由 SELECT）+ UI でシーンを開いて
 *                  エディタに本文が表示されることを確認
 *
 * 実行前提: `pnpm napi:build` と `pnpm electron:build` が済んでいること。
 * 失敗時は一時ディレクトリを残して exit 1（調査用にパスを表示する）。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { _electron } from "playwright";

import { rootDir } from "./build.mjs";
import { closeElectronAppWithDiagnostics } from "./close-electron-app.mjs";
import {
  aggregateAppProcessMemory,
  appMemoryMeasurement,
} from "./process-memory.mjs";
import {
  RUNTIME_PERFORMANCE_RAF_CALIBRATION_SAMPLE_COUNT,
  assertRuntimePerformanceActive,
  buildRuntimePerformanceTimeoutArtifact,
  buildRuntimePerformanceTimeoutArtifactPath,
  captureRafCalibration,
  createRuntimePerformanceCleanupCoordinator,
  finalizeRuntimePerformanceTimeout,
  focusRuntimeWindow,
  readDomForegroundSnapshot,
  readRuntimeWindowSnapshot,
  runRuntimePerformancePhaseSequence,
  snapshotChildProcess,
  snapshotRuntimePerformanceContext,
  terminateOwnedProcessTree,
  writeRuntimePerformanceTimeoutArtifact,
} from "./performance-harness.mjs";
import {
  RUNTIME_PERFORMANCE_INPUT_TEXT,
  RUNTIME_PERFORMANCE_STEADY_INPUT_TEXT,
  buildRuntimePerformanceFixtureForReview,
  buildRuntimeFixtureActualCardinalityQuery,
  buildRuntimeFixtureSeedPayload,
  parseRuntimeFixtureActualCardinality,
} from "./runtime-performance-fixture.mjs";
import {
  extractAutosaveMetrics,
  extractInteractionFrameMetrics,
} from "../../scripts/runtime-performance-budget.mjs";
import { invokeOk, waitUntil } from "./product-journey-harness.mjs";

const require = createRequire(import.meta.url);

// ── 定数 / 前提チェック ──────────────────────────────────────────────────────

const RUNTIME_REVIEW_FIXTURE_ID =
  process.env.GRIMODEX_PERF_REVIEW_FIXTURE ?? null;
const RUNTIME_BENCHMARK_FIXTURE = buildRuntimePerformanceFixtureForReview(
  RUNTIME_REVIEW_FIXTURE_ID,
);
const SMOKE_TEXT = `SMOKE-${Date.now()}-スモーク本文`;
const PERF_INPUT_TEXT = RUNTIME_PERFORMANCE_INPUT_TEXT;
const PERF_STEADY_INPUT_TEXT = RUNTIME_PERFORMANCE_STEADY_INPUT_TEXT;
const PERF_INPUT_ANCHOR_TEXT = RUNTIME_BENCHMARK_FIXTURE.inputAnchorText;
const PERF_AUTOSAVE_SAMPLE_SCENES =
  RUNTIME_BENCHMARK_FIXTURE.autosaveSampleScenes;
const PERF_SCENE_ID = RUNTIME_BENCHMARK_FIXTURE.sceneId;
const PERF_FOLDER_ID = RUNTIME_BENCHMARK_FIXTURE.folderId;
const PERF_SCENE_COUNT = RUNTIME_BENCHMARK_FIXTURE.collectionSceneCount;
const PERF_MAP_NODE_COUNT = RUNTIME_BENCHMARK_FIXTURE.mapNodeCount;
const PERF_TIMELINE_MARKER_LINK_COUNT =
  RUNTIME_BENCHMARK_FIXTURE.timelineMarkerLinkCount;
const PERF_CHRONICLE_EVENT_COUNT =
  RUNTIME_BENCHMARK_FIXTURE.chronicleEventCount;
const PERF_FILTER_TARGET_ID = `grimodex-runtime-perf-scene-${String(
  PERF_SCENE_COUNT - 1,
).padStart(3, "0")}`;
const PERF_FILTER_TARGET_TITLE = `PERF SCENE ${String(
  PERF_SCENE_COUNT,
).padStart(3, "0")}`;
const SCENES_PANEL_TITLE = "シーン"; // ja.json layout.panel.scenes
const CREATE_BUTTON_TITLE = "新規作成"; // ja.json scenes.create
const NEW_SCENE_MENU_ITEM = "New scene"; // ja.json scenes.newScene
const DEFAULT_SCENE_TITLE = "シーン 1"; // ja.json tree.defaultScene + 連番
const LAUNCH_TIMEOUT_MS = 60_000;
const MEMORY_SAMPLE_INTERVAL_MS = 100;
const INTERACTION_FRAME_SAMPLE_COUNT = 120;
const RUNTIME_PERFORMANCE_FOREGROUND_SWITCHES = [
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
];

async function seedRuntimePerformanceFixture(page, profile) {
  if (!runtimePerformanceOwnerToken) {
    throw new Error("runtime performance seed owner token is unavailable");
  }
  return await invokeOk(page, "runtime_performance_seed", {
    ownerToken: runtimePerformanceOwnerToken,
    payload: buildRuntimeFixtureSeedPayload(profile),
  });
}
const WORKSPACE_OPEN_START_MARK = "grimodex.workspaceOpen.start";
const EDITOR_INPUT_READY_MARK = `grimodex.editorInputReady:${encodeURIComponent(
  PERF_SCENE_ID,
)}`;
const GLOBAL_WATCHDOG_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 300_000);

function log(step) {
  console.log(`[electron:smoke] ${step}`);
}

function precondition(cond, message) {
  if (!cond) {
    console.error(`[electron:smoke] ${message}`);
    throw new Error(message);
  }
}

const mainCjs = path.join(rootDir, "dist-electron", "main.cjs");
precondition(
  existsSync(mainCjs),
  "dist-electron/main.cjs がありません。`pnpm electron:build` を先に実行してください。",
);
precondition(
  existsSync(path.join(rootDir, "dist", "index.html")),
  "dist/index.html がありません。`pnpm electron:build` を先に実行してください。",
);
const nodeBinary =
  process.env.GRIMODEX_NODE_PATH ??
  path.join(
    rootDir,
    "electron",
    "native",
    "grimodex-node",
    "grimodex-node.node",
  );
precondition(
  existsSync(nodeBinary),
  `grimodex-node.node がありません: ${nodeBinary}\n\`pnpm napi:build\` を先に実行してください。`,
);

/** EULA 版（src/features/legal/constants.ts が正本）。 */
function readEulaVersion() {
  const src = readFileSync(
    path.join(rootDir, "src", "features", "legal", "constants.ts"),
    "utf8",
  );
  const m = src.match(/EULA_VERSION\s*=\s*"([^"]+)"/);
  precondition(
    m,
    "EULA_VERSION を src/features/legal/constants.ts から読めませんでした",
  );
  return m[1];
}

const eulaVersion = readEulaVersion();
const appVersion = JSON.parse(
  readFileSync(path.join(rootDir, "package.json"), "utf8"),
).version;

// ── ヘルパ ──────────────────────────────────────────────────────────────────

const electronBin = require("electron");

const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "grimodex-smoke-"));
const userDataDir = path.join(tmpRoot, "user-data");
const workspaceDir = path.join(tmpRoot, "workspace");
const performanceOutputPath = process.env.GRIMODEX_PERF_OUTPUT;
const runtimePerformanceOwnerToken = performanceOutputPath
  ? randomUUID()
  : null;
const performanceCpuProfilePath = process.env.GRIMODEX_PERF_CPU_PROFILE
  ? path.resolve(rootDir, process.env.GRIMODEX_PERF_CPU_PROFILE)
  : null;
const performanceMetrics = {
  fixture: {
    id: RUNTIME_BENCHMARK_FIXTURE.id,
    reviewFixtureId: RUNTIME_BENCHMARK_FIXTURE.reviewFixtureId,
    reviewScenario: RUNTIME_BENCHMARK_FIXTURE.reviewScenario,
    reviewCardinalityJson: RUNTIME_BENCHMARK_FIXTURE.reviewCardinalityJson,
    sceneId: RUNTIME_BENCHMARK_FIXTURE.sceneId,
    seededTextChars: RUNTIME_BENCHMARK_FIXTURE.seededTextChars,
    seededBeatCount: RUNTIME_BENCHMARK_FIXTURE.seededBeatCount,
    collectionSceneCount: RUNTIME_BENCHMARK_FIXTURE.collectionSceneCount,
    timelineThreadCount: RUNTIME_BENCHMARK_FIXTURE.timelineThreadCount,
    timelineMarkerLinkCount: RUNTIME_BENCHMARK_FIXTURE.timelineMarkerLinkCount,
    chronicleEventCount: RUNTIME_BENCHMARK_FIXTURE.chronicleEventCount,
    mapNodeCount: RUNTIME_BENCHMARK_FIXTURE.mapNodeCount,
    mapEdgeCount: RUNTIME_BENCHMARK_FIXTURE.mapEdgeCount,
    chatMessageCount: RUNTIME_BENCHMARK_FIXTURE.chatMessageCount,
    chatSessionId: RUNTIME_BENCHMARK_FIXTURE.chatSessionId,
    autosaveSampleSceneIds: PERF_AUTOSAVE_SAMPLE_SCENES.map(
      (scene) => scene.id,
    ),
    editorInputSceneId: null,
    autosaveSceneId: null,
    editorInputTargetVerified: false,
    editorInputParagraphCharsBefore: null,
    actualCardinality: null,
  },
  coldStartMs: null,
  projectOpenMs: null,
  editorInput: null,
  autosave: null,
  memory: {
    platform: process.platform,
    startupBytes: null,
    startupProcessCount: null,
    startupProcesses: null,
    startupFallbackProcessCount: null,
    peakBytes: 0,
    peakProcessCount: null,
    peakProcesses: null,
    peakFallbackProcessCount: null,
    measurement: appMemoryMeasurement(),
    sampleIntervalMs: MEMORY_SAMPLE_INTERVAL_MS,
    samples: [],
    peakByViewBytes: {
      map: null,
      timeline: null,
      linear: null,
      chat: null,
    },
  },
  longTask: null,
  performanceSamples: {
    initialAutosave: [],
    steadyStateAutosave: [],
    postSaveDrain: [],
  },
  interactions: {
    treeFilter: null,
    linearScroll: null,
    timelineDrag: null,
    chroniclePan: null,
    chatScroll: null,
    chatDraft: null,
    mapDrag: null,
  },
  diagnostics: null,
};
const performanceTimeoutArtifactPath =
  buildRuntimePerformanceTimeoutArtifactPath(
    performanceOutputPath ?? path.join(tmpRoot, "runtime-metrics.json"),
  );
const runtimeContext = {
  startedAt: new Date().toISOString(),
  startedAtMonotonic: performance.now(),
  phase: "bootstrap",
  currentInteraction: null,
  app: null,
  page: null,
  memorySampler: null,
  memoryStopPromise: null,
  closePromise: null,
  foreground: null,
  rafCalibration: null,
  partialMetrics: performanceMetrics,
  cleanupCoordinator: createRuntimePerformanceCleanupCoordinator(),
  timeoutSnapshot: null,
  watchdogTriggered: false,
  watchdogPromise: null,
};
const runtimeAbortController = new AbortController();
const runtimeAbortSignal = runtimeAbortController.signal;

function assertRuntimePhaseActive(label) {
  assertRuntimePerformanceActive(runtimeAbortSignal, label);
}

function setRuntimePhase(phase, currentInteraction = null) {
  runtimeContext.phase = phase;
  runtimeContext.currentInteraction = currentInteraction;
}

function setRuntimeInteraction(currentInteraction) {
  runtimeContext.currentInteraction = currentInteraction;
}

async function appMemorySnapshot(app) {
  const processMetrics = await app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      creationTime: metric.creationTime,
      memory: {
        privateBytes: metric.memory?.privateBytes,
        workingSetSize: metric.memory?.workingSetSize,
      },
    })),
  );
  return aggregateAppProcessMemory(processMetrics);
}

function recordMemorySample(sample) {
  if (sample.measurement !== performanceMetrics.memory.measurement) {
    throw new Error(
      `memory measurement changed within benchmark: ${performanceMetrics.memory.measurement} -> ${sample.measurement}`,
    );
  }
  const { processes, ...artifactSample } = sample;
  performanceMetrics.memory.samples.push(artifactSample);
  if (sample.measuredBytes > performanceMetrics.memory.peakBytes) {
    performanceMetrics.memory.peakBytes = sample.measuredBytes;
    performanceMetrics.memory.peakProcessCount = sample.processCount;
    performanceMetrics.memory.peakProcesses = processes;
    performanceMetrics.memory.peakFallbackProcessCount =
      sample.fallbackProcessCount;
  }
  for (const view of sample.views) {
    const current = performanceMetrics.memory.peakByViewBytes[view] ?? 0;
    performanceMetrics.memory.peakByViewBytes[view] = Math.max(
      current,
      sample.measuredBytes,
    );
  }
}

/**
 * Capture short-lived memory peaks. Renderer view detection runs every fifth
 * sample to avoid making the measurement itself a material main-thread load;
 * intervening samples retain the last observed view state.
 */
function startMemorySampler(app, phase, initialPage = null) {
  const startedAt = performance.now();
  let page = initialPage;
  let stopped = false;
  let paused = false;
  let inFlight = null;
  let sampleIndex = 0;
  let lastViews = [];

  const sample = async (forceViewDetection = false) => {
    if (stopped || paused) return null;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const memory = await appMemorySnapshot(app);
        if (page && (forceViewDetection || sampleIndex % 5 === 0)) {
          try {
            lastViews = await page.evaluate(() => {
              const views = [];
              if (document.querySelector('[data-droptarget-id="map-panel"]')) {
                views.push("map");
              }
              if (document.querySelector('[data-testid="timeline-panel"]')) {
                views.push("timeline");
              }
              if (document.querySelector("[data-linear-virtual-row]")) {
                views.push("linear");
              }
              if (document.querySelector('[data-testid="chat-virtual-list"]')) {
                views.push("chat");
              }
              return views;
            });
          } catch {
            lastViews = [];
          }
        }
        const result = {
          phase,
          elapsedMs: performance.now() - startedAt,
          ...memory,
          views: [...lastViews],
        };
        sampleIndex += 1;
        recordMemorySample(result);
        return result;
      } catch {
        // Electron's inspector context can be replaced while a process exits or
        // a lazy panel initializes. Periodic sampling is best-effort; required
        // per-view samples below retry and fail explicitly if none succeeds.
        return null;
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  void sample();
  const timer = setInterval(() => void sample(), MEMORY_SAMPLE_INTERVAL_MS);
  timer.unref?.();

  return {
    setPage(nextPage) {
      page = nextPage;
    },
    sample,
    async pause() {
      paused = true;
      if (inFlight) await inFlight;
    },
    resume() {
      if (stopped || !paused) return;
      paused = false;
      void sample();
    },
    async sampleFresh(forceViewDetection = false) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (inFlight) await inFlight;
        const result = await sample(forceViewDetection);
        if (result) return result;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return null;
    },
    async stop() {
      clearInterval(timer);
      if (inFlight) await inFlight;
      paused = false;
      const finalSample = await sample();
      stopped = true;
      return finalSample;
    },
  };
}

async function stopRuntimeMemorySampler(memorySampler) {
  if (!memorySampler) return null;
  const stopPromise =
    runtimeContext.cleanupCoordinator.stopMemorySampler(memorySampler);
  runtimeContext.memoryStopPromise ??= stopPromise;
  return await stopPromise;
}

async function pauseMemorySamplerForInteraction(memorySampler) {
  const before = await memorySampler.sampleFresh(true);
  if (!before) {
    throw new Error("memory sample failed before interaction measurement");
  }
  await memorySampler.pause();
  let resumed = false;
  return async () => {
    if (resumed) return;
    resumed = true;
    memorySampler.resume();
    const after = await memorySampler.sampleFresh(true);
    if (!after) {
      throw new Error("memory sample failed after interaction measurement");
    }
  };
}

/** アプリを 1 回起動して main window の bridge が生きるまで待つ。 */
async function launchApp(phase, { deferMemorySampler = false } = {}) {
  assertRuntimePhaseActive(`launch ${phase}`);
  setRuntimePhase(phase);
  const env = { ...process.env };
  delete env.ELECTRON_RENDERER_URL; // 本番経路（app://）を強制
  env.GRIMODEX_USER_DATA_DIR = userDataDir;
  if (runtimePerformanceOwnerToken) {
    env.GRIMODEX_RUNTIME_PERFORMANCE_OWNER_TOKEN = runtimePerformanceOwnerToken;
  } else {
    delete env.GRIMODEX_RUNTIME_PERFORMANCE_OWNER_TOKEN;
  }
  const args = [];
  if (performanceOutputPath) {
    // Runtime frame budgets model an active foreground editor. Codex or another
    // host window may cover the benchmark window while automation is running;
    // Chromium otherwise throttles occluded renderer rAF to 1Hz, which measures
    // background policy rather than Timeline/Chronicle frame work.
    args.push(...RUNTIME_PERFORMANCE_FOREGROUND_SWITCHES);
  }
  if (performanceOutputPath && process.platform === "linux") {
    // The CI gate runs under Xvfb. Pin the local measured path to the same
    // backend instead of letting a Wayland host select a different GPU stack.
    args.push("--ozone-platform=x11");
  }
  // Electron parses Chromium switches as executable options only before the
  // application entry. Arguments after main.cjs belong to the application and
  // do not disable renderer/occlusion throttling.
  args.push(mainCjs);

  const app = await _electron.launch({
    executablePath: electronBin,
    args,
    env,
    timeout: LAUNCH_TIMEOUT_MS,
  });
  const cleanupCoordinator = createRuntimePerformanceCleanupCoordinator();
  runtimeContext.cleanupCoordinator = cleanupCoordinator;
  runtimeContext.app = app;
  runtimeContext.page = null;
  runtimeContext.memorySampler = null;
  runtimeContext.memoryStopPromise = null;
  runtimeContext.closePromise = null;
  try {
    assertRuntimePhaseActive(`launch ${phase}`);
  } catch (error) {
    try {
      await cleanupCoordinator.closeApp(
        app,
        null,
        phase,
        closeElectronAppWithDiagnostics,
      );
    } catch {
      await cleanupCoordinator.terminateProcess(() =>
        terminateOwnedProcessTree({
          childProcessSnapshot: snapshotChildProcess(app.process?.()),
          platform: process.platform,
        }),
      );
    }
    throw error;
  }
  const memorySampler =
    performanceOutputPath && !deferMemorySampler
      ? startMemorySampler(app, phase)
      : null;
  runtimeContext.memorySampler = memorySampler;
  // main プロセスの標準出力を prefix 付きで透過（CI 調査用）
  app.process().stdout?.on("data", (d) => {
    process.stdout.write(`  [main] ${String(d)}`);
  });
  app.process().stderr?.on("data", (d) => {
    process.stderr.write(`  [main] ${String(d)}`);
  });

  const page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT_MS });
  runtimeContext.page = page;
  page.on("console", (message) => {
    if (!["warning", "error"].includes(message.type())) return;
    process.stderr.write(`  [renderer:${message.type()}] ${message.text()}\n`);
  });
  page.on("pageerror", (error) => {
    process.stderr.write(`  [renderer:pageerror] ${error.message}\n`);
  });
  if (performanceOutputPath) {
    await ensureBenchmarkPageForeground(page);
  }
  memorySampler?.setPage(page);
  await page.waitForFunction(
    () => globalThis.grimodex?.shell === "electron",
    undefined,
    { timeout: LAUNCH_TIMEOUT_MS },
  );
  if (runtimePerformanceOwnerToken) {
    await page.waitForFunction(
      (ownerToken) =>
        globalThis.grimodex?.runtimePerformance?.ownerToken === ownerToken &&
        typeof globalThis.invokeRuntimePerformanceControl === "function",
      runtimePerformanceOwnerToken,
      { timeout: LAUNCH_TIMEOUT_MS },
    );
  }
  const bridgeMemorySample = await memorySampler?.sampleFresh();
  return {
    app,
    page,
    bridgeMemorySample,
    memorySampler,
  };
}

async function closeAppWithDiagnostics(app, page, phase) {
  const closePromise = runtimeContext.cleanupCoordinator.closeApp(
    app,
    page,
    phase,
    closeElectronAppWithDiagnostics,
  );
  runtimeContext.closePromise ??= closePromise;
  return await closePromise;
}

async function finishRuntimePhase({ app, page, memorySampler, phase }) {
  if (runtimeContext.watchdogTriggered) {
    if (runtimeContext.watchdogPromise) await runtimeContext.watchdogPromise;
    return;
  }
  await stopRuntimeMemorySampler(memorySampler);
  if (runtimeContext.watchdogTriggered) {
    if (runtimeContext.watchdogPromise) await runtimeContext.watchdogPromise;
    return;
  }
  await closeAppWithDiagnostics(app, page, phase);
  if (runtimeContext.watchdogTriggered && runtimeContext.watchdogPromise) {
    await runtimeContext.watchdogPromise;
    return;
  }
  if (runtimeContext.app === app) {
    runtimeContext.app = null;
    runtimeContext.page = null;
    runtimeContext.memorySampler = null;
    runtimeContext.memoryStopPromise = null;
    runtimeContext.closePromise = null;
  }
}

async function ensureBenchmarkPageForeground(page) {
  const requestedNativeWindow = await focusRuntimeWindow(runtimeContext.app);
  await page.bringToFront();
  await page.waitForFunction(
    () =>
      document.visibilityState === "visible" &&
      document.hidden === false &&
      document.hasFocus(),
    undefined,
    { timeout: 10_000 },
  );
  const nativeWindow = await readRuntimeWindowSnapshot(runtimeContext.app);
  const dom = await readDomForegroundSnapshot(page);
  runtimeContext.foreground = { dom, nativeWindow };
  if (
    requestedNativeWindow?.available !== true ||
    nativeWindow?.available !== true ||
    nativeWindow.isFocused !== true ||
    nativeWindow.isVisible !== true ||
    dom?.visibilityState !== "visible" ||
    dom?.documentHidden !== false ||
    dom?.documentHasFocus !== true
  ) {
    throw new Error(
      `runtime performance foreground verification failed: ${JSON.stringify({ dom, nativeWindow, requestedNativeWindow })}`,
    );
  }
}

/** 指定 scene の本文が DB に残っているか（ブリッジ経由 SELECT）。 */
async function sceneContainsTextInDb(page, sceneId, expectedText) {
  const result = await invokeOk(page, "db_execute", {
    sql: "SELECT content FROM tree_nodes WHERE id = ? AND node_type = 'scene'",
    params: [sceneId],
    method: "all",
  });
  return JSON.stringify(result?.rows ?? []).includes(expectedText);
}

async function findSceneByIdInDb(page, sceneId) {
  const result = await invokeOk(page, "db_execute", {
    sql: "SELECT id, title, content FROM tree_nodes WHERE id = ? AND node_type = 'scene'",
    params: [sceneId],
    method: "all",
  });
  return result?.rows?.[0] ?? null;
}

/** UI で作成した smoke scene を、永続化された本文から一意に引き直す。 */
async function findSmokeSceneInDb(page) {
  const result = await invokeOk(page, "db_execute", {
    sql: "SELECT id, title, content FROM tree_nodes WHERE node_type = 'scene'",
    params: [],
    method: "all",
  });
  return (
    (result?.rows ?? []).find((row) =>
      String(row?.content ?? "").includes(SMOKE_TEXT),
    ) ?? null
  );
}

/** シーン一覧パネルのヘッダ（editor ビュー到達の目印に使う）。 */
function scenesPanelHeader(page) {
  return page.locator(
    `[data-panel-header]:has(span[role="heading"]:text-is("${SCENES_PANEL_TITLE}"))`,
  );
}

async function togglePanel(page, panelId) {
  await page.getByTestId("panel-toggle-root").getByRole("button").click();
  // The reorderable menu can be taller than the Electron window, leaving a
  // valid item outside Playwright's coordinate-click viewport. Its accessible
  // keyboard path calls the same layout action without relying on coordinates.
  await page
    .getByTestId(`panel-toggle-item-${panelId}`)
    .evaluate((element) => element.focus());
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
}

async function setPanelActive(page, panelId, active) {
  await page.getByTestId("panel-toggle-root").getByRole("button").click();
  const item = page.getByTestId(`panel-toggle-item-${panelId}`);
  await item.waitFor({ state: "visible", timeout: 5_000 });
  const current = await item.getAttribute("aria-pressed");
  if (current === null) {
    throw new Error(`Panel toggle ${panelId} does not expose aria-pressed`);
  }
  if ((current === "true") !== active) {
    await item.evaluate((element) => element.focus());
    await page.keyboard.press("Enter");
  }
  await page.keyboard.press("Escape");
}

async function showPanel(page, panelId, readyLocator) {
  if (await readyLocator.isVisible()) return;
  // Heavy lazy panels can need more than five seconds to hydrate their full
  // fixture. Observe the toggle's canonical active state so a slow first open
  // is not mistaken for a failed open and immediately toggled closed again.
  await setPanelActive(page, panelId, true);
  await readyLocator.waitFor({ state: "visible", timeout: 30_000 });
}

async function hidePanelIfVisible(page, panelId, readyLocator) {
  const wasVisible = await readyLocator.isVisible();
  await setPanelActive(page, panelId, false);
  if (wasVisible) {
    await readyLocator.waitFor({ state: "hidden", timeout: 30_000 });
  }
}

function activePanelsInPersistedLayout(settings) {
  const active = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.activePanel === "string") {
      active.add(value.activePanel);
    }
    for (const nested of Object.values(value)) visit(nested);
  };
  visit(settings?.layout);
  return active;
}

async function captureViewMemoryWindow(page, memorySampler, view) {
  // Require multiple samples separated by at least the configured interval,
  // rather than accepting one incidental DOM observation.
  for (let index = 0; index < 4; index += 1) {
    const sample = await memorySampler.sampleFresh(true);
    if (!sample?.views.includes(view)) {
      throw new Error(`${view} memory sample did not observe the active view`);
    }
    if (index < 3) await page.waitForTimeout(MEMORY_SAMPLE_INTERVAL_MS);
  }
  const peak = performanceMetrics.memory.peakByViewBytes[view];
  if (!Number.isFinite(peak)) {
    throw new Error(`${view} memory peak was not recorded`);
  }
  log(`  ${view} sampled peak: ${peak} bytes`);
}

async function waitForRuntimeEditorIdle(page) {
  // Cold-start owns scene mount and initial analysis cost. Start the steady
  // editor-input window only after delayed mount work and two paint frames have
  // drained, so CI variance cannot reclassify startup work as a typing longtask.
  await page.waitForTimeout(1_000);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const afterIdle = () =>
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        if (typeof requestIdleCallback === "function") {
          requestIdleCallback(afterIdle, { timeout: 2_000 });
        } else {
          afterIdle();
        }
      }),
  );
}

async function drivePointerMoveFrames(
  page,
  {
    startX,
    clientY,
    baseOffset,
    verticalBaseOffset = 0,
    verticalStep = 0,
    button,
    buttons,
  },
) {
  // Reassert foreground immediately before the measured rAF sequence. Large
  // keepalive panels can spend long enough in setup for the desktop compositor
  // to deprioritize the Electron page even though it was foregrounded when the
  // target was acquired.
  await ensureBenchmarkPageForeground(page);
  await page.evaluate(
    async ({
      startX,
      clientY,
      baseOffset,
      verticalBaseOffset,
      verticalStep,
      button,
      buttons,
      frameCount,
    }) => {
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        if (document.visibilityState !== "visible") {
          throw new Error(
            "runtime performance gesture lost foreground visibility",
          );
        }
        document.dispatchEvent(
          new MouseEvent("mousemove", {
            button,
            buttons,
            clientX: startX + baseOffset + (frameIndex % 32),
            clientY: clientY + verticalBaseOffset + frameIndex * verticalStep,
            bubbles: true,
          }),
        );
        // The component registers its preview callback from the move above
        // before this waiter. Continuing from the waiter schedules the next
        // move before the following paint, so each measured component rAF has
        // real dirty transform work rather than an idle clock callback.
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    },
    {
      startX,
      clientY,
      baseOffset,
      verticalBaseOffset,
      verticalStep,
      button,
      buttons,
      frameCount: INTERACTION_FRAME_SAMPLE_COUNT,
    },
  );
}

async function focusRuntimeInputAnchor(
  page,
  anchorText = PERF_INPUT_ANCHOR_TEXT,
) {
  const result = await page.evaluate(async (anchorText) => {
    const paragraphs = Array.from(
      document.querySelectorAll('.ProseMirror[contenteditable="true"] > p'),
    ).filter((paragraph) => paragraph.textContent === anchorText);
    if (paragraphs.length !== 1) {
      return {
        ok: false,
        reason: `expected one input anchor, found ${paragraphs.length}`,
      };
    }

    const paragraph = paragraphs[0];
    const editor = paragraph.parentElement;
    if (!(editor instanceof HTMLElement) || !editor.isContentEditable) {
      return { ok: false, reason: "input anchor editor is not editable" };
    }
    if (paragraph.querySelectorAll(".lint-deco").length !== 0) {
      return { ok: false, reason: "input anchor contains lint decorations" };
    }

    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let textNode = walker.nextNode();
    let lastTextNode = null;
    while (textNode) {
      lastTextNode = textNode;
      textNode = walker.nextNode();
    }
    if (!(lastTextNode instanceof Text)) {
      return { ok: false, reason: "input anchor has no text node" };
    }

    editor.focus({ preventScroll: true });
    const range = document.createRange();
    range.setStart(lastTextNode, lastTextNode.data.length);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));

    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );

    const activeSelection = window.getSelection();
    return {
      ok:
        (document.activeElement === editor ||
          editor.contains(document.activeElement)) &&
        activeSelection?.isCollapsed === true &&
        paragraph.contains(activeSelection.anchorNode) &&
        activeSelection.anchorNode === lastTextNode &&
        activeSelection.anchorOffset === lastTextNode.data.length,
      reason: "selection did not remain at the input anchor end",
      initialChars: paragraph.textContent?.length ?? 0,
    };
  }, anchorText);

  if (!result.ok) {
    throw new Error(`runtime input target is invalid: ${result.reason}`);
  }
  return result;
}

async function assertRuntimeInputLandedInAnchor(
  page,
  anchorText = PERF_INPUT_ANCHOR_TEXT,
  inputText = PERF_INPUT_TEXT,
) {
  const result = await page.evaluate(
    ({ anchorText, inputText }) => {
      const expected = `${anchorText}${inputText}`;
      const matches = Array.from(
        document.querySelectorAll('.ProseMirror[contenteditable="true"] > p'),
      ).filter((paragraph) => paragraph.textContent === expected);
      return {
        ok: matches.length === 1,
        matches: matches.length,
        expectedChars: expected.length,
      };
    },
    {
      anchorText,
      inputText,
    },
  );
  if (!result.ok) {
    throw new Error(
      `runtime input did not land in the anchor paragraph (matches=${result.matches})`,
    );
  }
  return result;
}

async function activateRuntimeAutosaveSample(page, scene) {
  const currentSurface = page.locator(
    `[data-editor-loaded-document-id="${scene.id}"][data-editor-document-loading="false"]`,
  );
  if (!(await currentSurface.isVisible())) {
    await page.locator(`[data-editor-tab-id="${scene.id}"]`).click();
    await currentSurface.waitFor({ state: "visible", timeout: 30_000 });
  }
  const editor = currentSurface
    .locator('.ProseMirror[contenteditable="true"]')
    .first();
  await editor.waitFor({ state: "visible", timeout: 30_000 });
}

async function waitForRuntimePostSaveDrain(page, requireAutoRevision) {
  try {
    await page.waitForFunction(
      (needsAutoRevision) => {
        const counters = globalThis.snapshotPerfSession?.()?.counters ?? {};
        return (
          (counters["editor.postSave.bodyMention.settled"] ?? 0) >= 1 &&
          (counters["editor.postSave.derived.settled"] ?? 0) >= 1 &&
          (counters["editor.postSave.semantic.settled"] ?? 0) >= 1 &&
          (!needsAutoRevision ||
            (counters["editor.postSave.autoRevision.settled"] ?? 0) >= 1)
        );
      },
      requireAutoRevision,
      // rAF polling continuously manufactures foreground frame work while we
      // are explicitly waiting for background-priority lanes. Timer polling
      // observes settlement without starving scheduler.postTask/idle work.
      { polling: 100, timeout: 30_000 },
    );
  } catch (error) {
    const evidence = page.isClosed()
      ? { pageClosed: true }
      : await page.evaluate(() => {
          const snapshot = globalThis.snapshotPerfSession?.();
          return {
            pageClosed: false,
            visibilityState: document.visibilityState,
            documentHidden: document.hidden,
            documentHasFocus: document.hasFocus(),
            counters: snapshot?.counters ?? null,
            topMarks: snapshot?.topMarks ?? null,
          };
        });
    throw new Error(
      `runtime post-save background drain did not settle: ${JSON.stringify(evidence)}`,
      { cause: error },
    );
  }
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const afterIdle = () =>
          requestAnimationFrame(() => requestAnimationFrame(resolve));
        if (typeof requestIdleCallback === "function") {
          requestIdleCallback(afterIdle, { timeout: 2_000 });
        } else {
          afterIdle();
        }
      }),
  );
}

async function measureRuntimeAutosaveSample(
  page,
  {
    sceneId,
    anchorText,
    inputText,
    requireAutoRevision,
    cpuProfilePath = null,
  },
) {
  setRuntimeInteraction("autosave");
  // Each sample is independent evidence. Reassert active-page scheduling just
  // before opening its session so background-priority post-save tasks are not
  // measured under Chromium's occluded-window timer policy.
  await ensureBenchmarkPageForeground(page);
  const inputTarget = await focusRuntimeInputAnchor(page, anchorText);
  await page.evaluate(() => globalThis.startPerfSession?.());
  const cpuProfiler = cpuProfilePath
    ? await page.context().newCDPSession(page)
    : null;
  if (cpuProfiler) {
    await cpuProfiler.send("Profiler.enable");
    await cpuProfiler.send("Profiler.setSamplingInterval", {
      interval: 1_000,
    });
    await cpuProfiler.send("Profiler.start");
  }
  try {
    await page.keyboard.type(inputText, { delay: 10 });
  } finally {
    if (cpuProfiler && cpuProfilePath) {
      const { profile } = await cpuProfiler.send("Profiler.stop");
      await mkdir(path.dirname(cpuProfilePath), { recursive: true });
      await writeFile(cpuProfilePath, `${JSON.stringify(profile)}\n`);
      await cpuProfiler.detach();
      log(`  input CPU profile: ${cpuProfilePath}`);
    }
  }
  await assertRuntimeInputLandedInAnchor(page, anchorText, inputText);
  await page.evaluate(() => globalThis.checkpointPerfSession?.("typing"));
  await waitUntil(
    () => sceneContainsTextInDb(page, sceneId, inputText),
    `${sceneId} autosave reaches tree_nodes.content`,
    30_000,
  );
  await waitForRuntimePostSaveDrain(page, requireAutoRevision);
  await page.evaluate(() =>
    globalThis.checkpointPerfSession?.("postSaveDrain"),
  );
  const session = await page.evaluate(() => globalThis.endPerfSession?.());
  if (!session?.segments?.durableSave || !session?.segments?.postSaveDrain) {
    throw new Error(`${sceneId} performance segment evidence is incomplete`);
  }
  setRuntimeInteraction(null);
  return { inputTarget, session };
}

function aggregateRuntimeLongTaskSamples(samples) {
  return samples.reduce(
    (aggregate, sample) => ({
      count: Math.max(aggregate.count, sample?.longtask?.count ?? 0),
      totalMs: aggregate.totalMs + (sample?.longtask?.totalMs ?? 0),
      maxMs: Math.max(aggregate.maxMs, sample?.longtask?.maxMs ?? 0),
    }),
    { count: 0, totalMs: 0, maxMs: 0 },
  );
}

async function assertTreeAndGridVirtualization(page) {
  setRuntimeInteraction("treeFilter");
  const scenesPanel = page
    .locator('[data-droptarget-id="scenes-panel"]:visible')
    .first();
  await showPanel(page, "scenes", scenesPanel);
  const treeScroller = scenesPanel.locator(
    ".min-h-0.flex-1.overflow-y-auto.overflow-x-hidden",
  );
  // Creating the smoke scene makes VirtualTree reveal the active row near the
  // end of the list. Return to the fixture folder before checking its window.
  await treeScroller.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  const fixtureFolder = scenesPanel.locator(
    `li[data-node-id="${PERF_FOLDER_ID}"]`,
  );
  await fixtureFolder.waitFor({ state: "visible", timeout: 10_000 });
  const initiallyRendered = await scenesPanel
    .locator("li[data-node-id]")
    .count();
  if (initiallyRendered <= 5) {
    await fixtureFolder.locator(`[data-node-row="${PERF_FOLDER_ID}"]`).click();
  }
  const treeRendered = await waitUntil(
    async () => {
      const count = await scenesPanel.locator("li[data-node-id]").count();
      return count > 5 && count < PERF_SCENE_COUNT ? count : false;
    },
    "Tree が fixture folder の仮想windowだけを描画する",
    10_000,
    100,
  );
  log(
    `  Tree virtualization: ${treeRendered} rendered / ${PERF_SCENE_COUNT} fixture scenes`,
  );

  const filterInput = scenesPanel.getByTestId("scenes-filter-input");
  const filterTarget = scenesPanel.locator(
    `li[data-node-id="${PERF_FILTER_TARGET_ID}"]`,
  );
  let treeFilterSession = null;
  let filterTargetVisible = false;
  await page.evaluate(() => globalThis.startPerfSession?.());
  try {
    await filterInput.fill(PERF_FILTER_TARGET_TITLE);
    await filterTarget.waitFor({ state: "visible", timeout: 10_000 });
    filterTargetVisible =
      (await filterTarget.count()) === 1 &&
      (await filterTarget.textContent())?.includes(PERF_FILTER_TARGET_TITLE) ===
        true;
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  } finally {
    treeFilterSession = await page.evaluate(() =>
      globalThis.endPerfSession?.(),
    );
  }
  const derivationCount =
    treeFilterSession?.counters?.["tree.visibility.derive.count"] ?? null;
  const maxNodesVisited =
    treeFilterSession?.counters?.["tree.visibility.maxNodesVisited"] ?? null;
  performanceMetrics.interactions.treeFilter = {
    targetVerified:
      filterTargetVisible &&
      Number.isFinite(derivationCount) &&
      derivationCount >= 1,
    derivationCount,
    maxNodesVisited,
    longTaskCount: treeFilterSession?.longtask?.count ?? null,
    longTaskMaxMs: treeFilterSession?.longtask?.maxMs ?? null,
    longTaskEntries: treeFilterSession?.longTaskEntries ?? [],
  };
  log(
    `  Tree filter: ${derivationCount} derive(s), max ${maxNodesVisited} node visits, ${treeFilterSession?.longtask?.count ?? "missing"} long task(s)`,
  );
  await filterInput.fill("");
  await fixtureFolder.waitFor({ state: "visible", timeout: 10_000 });

  const firstGridRow = page.locator("[data-grid-virtual-row]").first();
  await showPanel(page, "grid", firstGridRow);
  const gridRendered = await page.waitForFunction(
    (totalScenes) => {
      const count = document.querySelectorAll("[data-grid-virtual-row]").length;
      return count > 0 && count < totalScenes ? count : false;
    },
    PERF_SCENE_COUNT,
    { timeout: 30_000 },
  );
  log(
    `  Grid virtualization: ${await gridRendered.jsonValue()} rendered / ${PERF_SCENE_COUNT} fixture scenes`,
  );
  setRuntimeInteraction(null);
}

async function measureTimelineDrag(page, memorySampler) {
  setRuntimeInteraction("timelineDrag");
  const timelinePanel = page.getByTestId("timeline-panel");
  const axisMode = timelinePanel.locator("select").first();
  if ((await axisMode.inputValue()) !== "story") {
    await axisMode.selectOption("story");
  }
  await page.waitForFunction(() => {
    const target = document.querySelector(
      '[data-testid^="timeline-scene-dot-"]',
    );
    return target?.classList.contains("cursor-grab") === true;
  });
  const dot = page.locator('[data-testid^="timeline-scene-dot-"]').first();
  await dot.waitFor({ state: "visible", timeout: 10_000 });
  await dot.scrollIntoViewIfNeeded();
  const box = await dot.boundingBox();
  if (!box) throw new Error("Timeline drag target has no bounding box");
  const beforeX = box.x + box.width / 2;
  await ensureBenchmarkPageForeground(page);

  let timelineSession = null;
  let afterX = beforeX;
  let dragArmed = false;
  const resumeMemorySampler =
    await pauseMemorySamplerForInteraction(memorySampler);
  let timelineSessionStarted = false;
  try {
    await page.evaluate(() => globalThis.startPerfSession?.());
    timelineSessionStarted = true;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    // Dispatch to the SVG target directly. Coordinate mouse input can land on
    // an overlapping Timeline label even though the circle itself is visible.
    await dot.dispatchEvent("mousedown", {
      button: 0,
      buttons: 1,
      clientX: x,
      clientY: y,
    });
    dragArmed = true;
    await page
      .getByTestId("timeline-scene-drag-ghost")
      .waitFor({ state: "attached", timeout: 10_000 });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(resolve)),
    );
    // Keep the real pointer/imperative presentation path active for enough
    // independently presented frames to make p95 meaningful. One callback
    // duration only measures JavaScript; consecutive rAF timestamp deltas also
    // include style/layout/paint/composite deadline misses.
    await drivePointerMoveFrames(page, {
      startX: x,
      clientY: y,
      baseOffset: 24,
      button: 0,
      buttons: 1,
    });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(resolve)),
    );
    const previewBox = await page
      .getByTestId("timeline-scene-drag-dot-preview")
      .boundingBox();
    afterX = previewBox ? previewBox.x + previewBox.width / 2 : null;
    // Cancel instead of committing a story-order mutation in the smoke fixture.
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    dragArmed = false;
  } finally {
    try {
      if (dragArmed) {
        await page
          .evaluate(() => window.dispatchEvent(new Event("blur")))
          .catch(() => {});
      }
      if (timelineSessionStarted) {
        timelineSession = await page.evaluate(() =>
          globalThis.endPerfSession?.(),
        );
      }
    } finally {
      await resumeMemorySampler();
    }
  }
  const frameMetrics = extractInteractionFrameMetrics(
    timelineSession,
    "timeline.pointerFrame.interval",
    "timeline.pointerFrame.work",
  );
  const timelineRender = timelineSession?.markStats?.find(
    (entry) => entry.label === "timelineViewport.render",
  );
  const timelineRenderCount = timelineRender?.count ?? 0;
  const timelineRenderMaxMs = timelineRender?.maxMs ?? 0;
  performanceMetrics.interactions.timelineDrag = {
    targetVerified:
      Number.isFinite(beforeX) &&
      Number.isFinite(afterX) &&
      beforeX !== afterX &&
      frameMetrics !== null &&
      Number.isFinite(timelineRenderMaxMs),
    gestureLongTaskCount: timelineSession?.longtask?.count ?? null,
    gestureLongTaskMaxMs: timelineSession?.longtask?.maxMs ?? null,
    gestureLongTaskEntries: timelineSession?.longTaskEntries ?? [],
    gestureSlowEvent: timelineSession?.slowEvent ?? null,
    gestureTopMarks: timelineSession?.topMarks ?? [],
    gestureMarkStats: timelineSession?.markStats ?? [],
    // A zero count is the preferred path: scene drag is mounted ahead of time
    // and must not reconcile the 5k-marker Timeline tree on pointer down.
    dragStartRenderCount: timelineRenderCount,
    dragStartRenderMaxMs: timelineRenderMaxMs,
    frameCount: frameMetrics?.frameCount ?? null,
    workFrameCount: frameMetrics?.workFrameCount ?? null,
    workCoverage: frameMetrics?.workCoverage ?? null,
    p50FrameMs: frameMetrics?.p50FrameMs ?? null,
    p95FrameMs: frameMetrics?.p95FrameMs ?? null,
    meanFrameMs: frameMetrics?.meanFrameMs ?? null,
    maxFrameMs: frameMetrics?.maxFrameMs ?? null,
  };
  log(
    `  Timeline drag: ${frameMetrics?.frameCount ?? "missing"} frame(s), p95 ${frameMetrics?.p95FrameMs ?? "missing"} ms, max ${frameMetrics?.maxFrameMs ?? "missing"} ms`,
  );
  setRuntimeInteraction(null);
}

async function measureChroniclePan(page, memorySampler) {
  setRuntimeInteraction("chroniclePan");
  const track = page.locator("#chronicle-track:visible").first();
  await showPanel(page, "chronicle", track);
  await page.waitForFunction(
    (minimumEvents) => {
      const chronicleTrack = document.querySelector("#chronicle-track");
      const totalEvents = Number(
        chronicleTrack?.getAttribute("data-chronicle-total-event-count") ?? 0,
      );
      const renderedMarkers = Number(
        chronicleTrack?.getAttribute("data-chronicle-rendered-marker-count") ??
          0,
      );
      const totalEdges = Number(
        chronicleTrack?.getAttribute("data-chronicle-total-edge-count") ?? 0,
      );
      const renderedEdges = Number(
        chronicleTrack?.getAttribute("data-chronicle-rendered-edge-count") ?? 0,
      );
      return (
        totalEvents >= minimumEvents &&
        renderedMarkers > 0 &&
        renderedMarkers < totalEvents &&
        totalEdges >= Math.min(Math.max(minimumEvents - 1, 0), 1_000) &&
        renderedEdges > 0
      );
    },
    PERF_CHRONICLE_EVENT_COUNT,
    { timeout: 30_000 },
  );
  const markerProjection = await track.evaluate((element) => ({
    totalEventCount: Number(
      element.getAttribute("data-chronicle-total-event-count") ?? 0,
    ),
    renderedMarkerCount: Number(
      element.getAttribute("data-chronicle-rendered-marker-count") ?? 0,
    ),
    totalEdgeCount: Number(
      element.getAttribute("data-chronicle-total-edge-count") ?? 0,
    ),
    renderedEdgeCount: Number(
      element.getAttribute("data-chronicle-rendered-edge-count") ?? 0,
    ),
    renderWindowTop: Number(
      element.getAttribute("data-chronicle-render-window-top") ?? 0,
    ),
    renderedMarkerIds: Array.from(
      element.querySelectorAll("[data-event-id]"),
      (marker) => marker.getAttribute("data-event-id"),
    ).filter(Boolean),
  }));
  const scrollArea = page.getByTestId("chronicle-scroll-area");
  const initialScrollTop = await scrollArea.evaluate(
    (element) => element.scrollTop,
  );
  const scrollViewportHeight = await scrollArea.evaluate(
    (element) => element.clientHeight,
  );
  const projection = page.getByTestId("chronicle-viewport-projection");
  await projection.waitFor({ state: "attached", timeout: 10_000 });
  const graphicsTopology = await track.evaluate((element) => {
    const ambient = document.querySelector("[data-editor-ambient]");
    const shaderSurface = ambient?.querySelector("[data-zen-shader-renderer]");
    const chronicleHost = element.closest("[data-ambient-glass-surface]");
    return {
      ambientBackgroundRenderer:
        ambient?.getAttribute("data-background-renderer") ?? null,
      ambientFallbackReason:
        ambient?.getAttribute("data-background-fallback-reason") ?? null,
      shaderRendererStatus:
        shaderSurface?.getAttribute("data-zen-shader-renderer") ?? null,
      sharedCompositorPresent:
        ambient?.querySelector("[data-zen-glass-compositor]") instanceof
        HTMLElement,
      chronicleHostBackdropFilter:
        chronicleHost instanceof HTMLElement
          ? getComputedStyle(chronicleHost).backdropFilter
          : null,
    };
  });
  const fallbackTopologyVerified =
    graphicsTopology.ambientBackgroundRenderer !== "fallback" ||
    (!graphicsTopology.sharedCompositorPresent &&
      graphicsTopology.chronicleHostBackdropFilter === "none");
  const box = await track.boundingBox();
  if (!box) throw new Error("Chronicle pan target has no bounding box");
  await ensureBenchmarkPageForeground(page);

  let chronicleSession = null;
  let previewTransform = "";
  let finalScrollTop = initialScrollTop;
  let finalRenderedMarkerCount = markerProjection.renderedMarkerCount;
  let finalRenderWindowTop = markerProjection.renderWindowTop;
  let finalRenderedMarkerIds = markerProjection.renderedMarkerIds;
  let pointerHeld = false;
  const resumeMemorySampler =
    await pauseMemorySamplerForInteraction(memorySampler);
  let chronicleSessionStarted = false;
  try {
    const x = box.x + box.width / 2;
    const y = box.y + Math.min(box.height / 2, 80);
    // Target acquisition can trigger marker hover state and the first
    // compositing pass for this large keepalive panel. Those are setup work,
    // not middle-button pan frames. Settle them before opening the scoped
    // session; the session still begins before pointer-down and therefore
    // retains every gesture/preview/paint interval.
    await page.mouse.move(x, y);
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.evaluate(() => globalThis.startPerfSession?.());
    chronicleSessionStarted = true;
    await page.mouse.down({ button: "middle" });
    pointerHeld = true;
    // Playwright `steps` emits one burst, which Chronicle intentionally
    // coalesces into a single rAF. Keep distinct real pointer previews active
    // for a statistically meaningful interval sample rather than measuring
    // driver cadence or one incidental frame.
    await drivePointerMoveFrames(page, {
      startX: x,
      clientY: y,
      baseOffset: 12,
      // Exercise the native vertical scroll and marker-window replacement
      // path as part of the same diagonal pan, rather than benchmarking only
      // a static horizontal world transform.
      verticalBaseOffset: -12,
      // Move beyond one full viewport so the top overscan must be evicted.
      // A fixed 480px gesture could leave the initial projection intact on a
      // tall CI display and would not prove the window listener works.
      verticalStep: -Math.max(
        8,
        Math.ceil(
          (scrollViewportHeight * 1.5) / INTERACTION_FRAME_SAMPLE_COUNT,
        ),
      ),
      button: 1,
      buttons: 4,
    });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    previewTransform = await projection.evaluate(
      (element) => element.style.transform,
    );
    finalScrollTop = await scrollArea.evaluate((element) => element.scrollTop);
    const finalMarkerProjection = await track.evaluate((element) => ({
      renderedMarkerCount: Number(
        element.getAttribute("data-chronicle-rendered-marker-count") ?? 0,
      ),
      renderWindowTop: Number(
        element.getAttribute("data-chronicle-render-window-top") ?? 0,
      ),
      renderedMarkerIds: Array.from(
        element.querySelectorAll("[data-event-id]"),
        (marker) => marker.getAttribute("data-event-id"),
      ).filter(Boolean),
    }));
    finalRenderedMarkerCount = finalMarkerProjection.renderedMarkerCount;
    finalRenderWindowTop = finalMarkerProjection.renderWindowTop;
    finalRenderedMarkerIds = finalMarkerProjection.renderedMarkerIds;
    await page.mouse.up({ button: "middle" });
    pointerHeld = false;
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(resolve)),
    );
  } finally {
    try {
      if (pointerHeld) {
        await page
          .evaluate(() => window.dispatchEvent(new Event("blur")))
          .catch(() => {});
        await page.mouse.up({ button: "middle" }).catch(() => {});
      }
      if (chronicleSessionStarted) {
        chronicleSession = await page.evaluate(() =>
          globalThis.endPerfSession?.(),
        );
      }
    } finally {
      await resumeMemorySampler();
    }
  }
  const frameMetrics = extractInteractionFrameMetrics(
    chronicleSession,
    "chronicle.viewportFrame.interval",
    "chronicle.viewportFrame.work",
  );
  const initialMarkerIdSet = new Set(markerProjection.renderedMarkerIds);
  const finalMarkerIdSet = new Set(finalRenderedMarkerIds);
  const markerWindowReplaced =
    markerProjection.renderedMarkerIds.some(
      (markerId) => !finalMarkerIdSet.has(markerId),
    ) &&
    finalRenderedMarkerIds.some(
      (markerId) => !initialMarkerIdSet.has(markerId),
    );
  performanceMetrics.interactions.chroniclePan = {
    targetVerified:
      fallbackTopologyVerified &&
      previewTransform !== "" &&
      frameMetrics !== null &&
      markerProjection.totalEventCount >= PERF_CHRONICLE_EVENT_COUNT &&
      markerProjection.renderedMarkerCount > 0 &&
      markerProjection.renderedMarkerCount < markerProjection.totalEventCount &&
      markerProjection.totalEdgeCount >=
        Math.min(Math.max(PERF_CHRONICLE_EVENT_COUNT - 1, 0), 1_000) &&
      markerProjection.renderedEdgeCount > 0 &&
      finalScrollTop > initialScrollTop &&
      finalRenderWindowTop > markerProjection.renderWindowTop &&
      markerWindowReplaced &&
      finalRenderedMarkerCount > 0 &&
      finalRenderedMarkerCount < markerProjection.totalEventCount,
    gestureLongTaskCount: chronicleSession?.longtask?.count ?? null,
    gestureLongTaskMaxMs: chronicleSession?.longtask?.maxMs ?? null,
    gestureLongTaskEntries: chronicleSession?.longTaskEntries ?? [],
    gestureSlowEvent: chronicleSession?.slowEvent ?? null,
    gestureTopMarks: chronicleSession?.topMarks ?? [],
    gestureMarkStats: chronicleSession?.markStats ?? [],
    totalEventCount: markerProjection.totalEventCount,
    renderedMarkerCount: markerProjection.renderedMarkerCount,
    finalRenderedMarkerCount,
    totalEdgeCount: markerProjection.totalEdgeCount,
    renderedEdgeCount: markerProjection.renderedEdgeCount,
    horizontalPreviewVerified: previewTransform !== "",
    markerWindowReplaced,
    initialRenderWindowTop: markerProjection.renderWindowTop,
    finalRenderWindowTop,
    initialScrollTop,
    finalScrollTop,
    graphicsTopology: {
      ...graphicsTopology,
      fallbackTopologyVerified,
    },
    frameCount: frameMetrics?.frameCount ?? null,
    workFrameCount: frameMetrics?.workFrameCount ?? null,
    workCoverage: frameMetrics?.workCoverage ?? null,
    p50FrameMs: frameMetrics?.p50FrameMs ?? null,
    p95FrameMs: frameMetrics?.p95FrameMs ?? null,
    meanFrameMs: frameMetrics?.meanFrameMs ?? null,
    maxFrameMs: frameMetrics?.maxFrameMs ?? null,
  };
  log(
    `  Chronicle pan: ${frameMetrics?.frameCount ?? "missing"} frame(s), p95 ${frameMetrics?.p95FrameMs ?? "missing"} ms, max ${frameMetrics?.maxFrameMs ?? "missing"} ms`,
  );

  await togglePanel(page, "chronicle");
  await track.waitFor({ state: "detached", timeout: 10_000 });
  setRuntimeInteraction(null);
}

function shouldMeasureReviewScenario(scenario) {
  return (
    RUNTIME_BENCHMARK_FIXTURE.reviewScenario === null ||
    RUNTIME_BENCHMARK_FIXTURE.reviewScenario === scenario
  );
}

async function measureMapView(page, memorySampler) {
  setRuntimeInteraction("mapDrag");
  const mapPanel = page.locator('[data-droptarget-id="map-panel"]');
  await showPanel(page, "map", mapPanel);
  await page.waitForFunction(
    ({ minimumNodes, minimumEdges }) => {
      const map = document.querySelector("[data-map-rendered-node-count]");
      const stateNodes = Number(
        map?.getAttribute("data-map-rendered-node-count") ?? 0,
      );
      const stateEdges = Number(
        map?.getAttribute("data-map-rendered-edge-count") ?? 0,
      );
      const renderedNodes =
        map?.querySelectorAll(".react-flow__node").length ?? 0;
      const renderedEdges =
        map?.querySelectorAll(".react-flow__edge").length ?? 0;
      return (
        stateNodes >= minimumNodes &&
        stateEdges >= minimumEdges &&
        renderedNodes >= minimumNodes &&
        renderedEdges >= minimumEdges
      );
    },
    {
      minimumNodes: PERF_MAP_NODE_COUNT,
      minimumEdges: RUNTIME_BENCHMARK_FIXTURE.mapEdgeCount,
    },
    { timeout: 30_000 },
  );

  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const targetNodeId = await page.evaluate(() => {
    const flow = document.querySelector(".react-flow");
    if (!(flow instanceof HTMLElement)) return null;
    const flowRect = flow.getBoundingClientRect();
    for (const node of document.querySelectorAll(
      '.react-flow__node[data-id^="scene:"]',
    )) {
      const rect = node.getBoundingClientRect();
      const center = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        center.x <= flowRect.left ||
        center.x >= flowRect.right ||
        center.y <= flowRect.top ||
        center.y >= flowRect.bottom
      ) {
        continue;
      }
      const hit = document.elementFromPoint(center.x, center.y);
      if (hit?.closest(".react-flow__node[data-id]") === node) {
        return node.getAttribute("data-id");
      }
    }
    return null;
  });
  if (!targetNodeId?.startsWith("scene:")) {
    throw new Error("Map drag has no visible, hit-testable scene target");
  }
  const targetNode = page.locator(
    `.react-flow__node[data-id="${targetNodeId}"]`,
  );
  await targetNode.waitFor({ state: "visible", timeout: 10_000 });
  const targetTreeNodeId = targetNodeId.slice("scene:".length);
  const readPersistedPosition = async () => {
    const result = await invokeOk(page, "db_execute", {
      sql: `SELECT id, x, y
        FROM map_node_positions
        WHERE board_id = ? AND tree_node_id = ?`,
      params: [RUNTIME_BENCHMARK_FIXTURE.boardId, targetTreeNodeId],
      method: "all",
    });
    return result?.rows?.[0] ?? null;
  };
  const persistedBefore = await readPersistedPosition();
  if (
    !persistedBefore ||
    !Number.isFinite(Number(persistedBefore.x)) ||
    !Number.isFinite(Number(persistedBefore.y))
  ) {
    throw new Error("Map drag target has no persisted position");
  }
  const targetBox = await targetNode.boundingBox();
  const targetTransformBefore = await targetNode.evaluate(
    (element) => element.style.transform,
  );
  if (!targetBox) throw new Error("Map drag target has no bounding box");

  await page.evaluate((draggedNodeId) => {
    const nodes = Array.from(
      document.querySelectorAll(".react-flow__node[data-id]"),
    );
    const unrelated = nodes.filter(
      (node) => node.getAttribute("data-id") !== draggedNodeId,
    );
    const state = {
      draggedNodeId,
      elements: new Map(
        unrelated.map((node) => [node.getAttribute("data-id"), node]),
      ),
      transforms: new Map(
        unrelated.map((node) => [
          node.getAttribute("data-id"),
          node instanceof HTMLElement ? node.style.transform : "",
        ]),
      ),
      childListReplacements: 0,
      attributeMutations: 0,
      observer: null,
    };
    const nodesRoot = document.querySelector(".react-flow__nodes");
    if (!(nodesRoot instanceof HTMLElement)) {
      throw new Error("Map React Flow node container is missing");
    }
    const affectedNodeIds = (node) => {
      if (!(node instanceof Element)) return [];
      const ids = [];
      if (node.matches(".react-flow__node[data-id]")) {
        ids.push(node.getAttribute("data-id"));
      }
      for (const nested of node.querySelectorAll(
        ".react-flow__node[data-id]",
      )) {
        ids.push(nested.getAttribute("data-id"));
      }
      return ids.filter(Boolean);
    };
    state.observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "childList") {
          const changedIds = [
            ...Array.from(record.addedNodes).flatMap(affectedNodeIds),
            ...Array.from(record.removedNodes).flatMap(affectedNodeIds),
          ];
          state.childListReplacements += changedIds.filter(
            (id) => id !== draggedNodeId,
          ).length;
        } else if (record.type === "attributes") {
          const element = record.target;
          const owner =
            element instanceof Element
              ? element.closest(".react-flow__node[data-id]")
              : null;
          const ownerId = owner?.getAttribute("data-id");
          if (ownerId && ownerId !== draggedNodeId) {
            state.attributeMutations += 1;
          }
        }
      }
    });
    state.observer.observe(nodesRoot, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "style", "transform"],
    });
    globalThis.__grimodexMapDragPerfState = state;
  }, targetNodeId);

  const dragStart = {
    x: targetBox.x + targetBox.width / 2,
    y: targetBox.y + targetBox.height / 2,
  };
  let pointerHeld = false;
  let persistedAfter = null;
  let mapDragEvidence = null;
  let mapNodeIdentityEvidence = null;
  let mapNodeIdentityPrepared = false;
  try {
    const preparedIdentity = await page.evaluate(
      ({ ownerToken, nodeId }) => {
        globalThis.startPerfSession?.();
        try {
          return globalThis.invokeRuntimePerformanceControl?.(
            ownerToken,
            "map.dragIdentity",
            { action: "prepare", nodeId },
          );
        } finally {
          globalThis.endPerfSession?.();
        }
      },
      {
        ownerToken: runtimePerformanceOwnerToken,
        nodeId: targetNodeId,
      },
    );
    mapNodeIdentityPrepared = true;
    if (
      preparedIdentity?.unrelatedNodeCount !==
      RUNTIME_BENCHMARK_FIXTURE.mapNodeCount - 1
    ) {
      throw new Error(
        `Map identity control prepared ${preparedIdentity?.unrelatedNodeCount} unrelated nodes`,
      );
    }

    await page.mouse.move(dragStart.x, dragStart.y);
    await page.mouse.down();
    pointerHeld = true;
    await page.mouse.move(dragStart.x + 48, dragStart.y + 32, { steps: 4 });
    await page.mouse.up();
    pointerHeld = false;

    persistedAfter = await waitUntil(
      async () => {
        const position = await readPersistedPosition();
        return position &&
          (Number(position.x) !== Number(persistedBefore.x) ||
            Number(position.y) !== Number(persistedBefore.y))
          ? position
          : false;
      },
      "Map drag persists changed x/y",
      30_000,
      100,
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  } finally {
    if (pointerHeld) {
      await page.mouse.up().catch(() => {});
    }
    mapDragEvidence = await page.evaluate((draggedNodeId) => {
      const state = globalThis.__grimodexMapDragPerfState;
      if (!state) return null;
      const affectedNodeIds = (node) => {
        if (!(node instanceof Element)) return [];
        const ids = [];
        if (node.matches(".react-flow__node[data-id]")) {
          ids.push(node.getAttribute("data-id"));
        }
        for (const nested of node.querySelectorAll(
          ".react-flow__node[data-id]",
        )) {
          ids.push(nested.getAttribute("data-id"));
        }
        return ids.filter(Boolean);
      };
      for (const record of state.observer.takeRecords()) {
        if (record.type === "childList") {
          const changedIds = [
            ...Array.from(record.addedNodes).flatMap(affectedNodeIds),
            ...Array.from(record.removedNodes).flatMap(affectedNodeIds),
          ];
          state.childListReplacements += changedIds.filter(
            (id) => id !== draggedNodeId,
          ).length;
        } else if (record.type === "attributes") {
          const element = record.target;
          const owner =
            element instanceof Element
              ? element.closest(".react-flow__node[data-id]")
              : null;
          const ownerId = owner?.getAttribute("data-id");
          if (ownerId && ownerId !== draggedNodeId) {
            state.attributeMutations += 1;
          }
        }
      }
      state.observer.disconnect();
      const current = new Map(
        Array.from(document.querySelectorAll(".react-flow__node[data-id]")).map(
          (node) => [node.getAttribute("data-id"), node],
        ),
      );
      let identityChanges = 0;
      let transformChanges = 0;
      for (const [id, element] of state.elements) {
        const latest = current.get(id);
        if (latest !== element) identityChanges += 1;
        if (
          latest instanceof HTMLElement &&
          latest.style.transform !== state.transforms.get(id)
        ) {
          transformChanges += 1;
        }
      }
      const target = current.get(draggedNodeId);
      const result = {
        unrelatedNodeCount: state.elements.size,
        unrelatedIdentityChanges: identityChanges,
        unrelatedTransformChanges: transformChanges,
        unrelatedChildListReplacements: state.childListReplacements,
        unrelatedAttributeMutations: state.attributeMutations,
        targetTransform:
          target instanceof HTMLElement ? target.style.transform : null,
      };
      delete globalThis.__grimodexMapDragPerfState;
      return result;
    }, targetNodeId);
    if (mapNodeIdentityPrepared) {
      try {
        mapNodeIdentityEvidence = await page.evaluate(
          ({ ownerToken, nodeId }) => {
            globalThis.startPerfSession?.();
            try {
              return globalThis.invokeRuntimePerformanceControl?.(
                ownerToken,
                "map.dragIdentity",
                { action: "finish", nodeId },
              );
            } finally {
              globalThis.endPerfSession?.();
            }
          },
          {
            ownerToken: runtimePerformanceOwnerToken,
            nodeId: targetNodeId,
          },
        );
      } finally {
        await page.evaluate(
          ({ ownerToken, nodeId }) => {
            globalThis.startPerfSession?.();
            try {
              globalThis.invokeRuntimePerformanceControl?.(
                ownerToken,
                "map.dragIdentity",
                { action: "cleanup", nodeId },
              );
            } finally {
              globalThis.endPerfSession?.();
            }
          },
          {
            ownerToken: runtimePerformanceOwnerToken,
            nodeId: targetNodeId,
          },
        );
      }
    }
  }
  performanceMetrics.interactions.mapDrag = {
    targetVerified:
      persistedAfter !== null &&
      mapDragEvidence !== null &&
      mapDragEvidence.targetTransform !== targetTransformBefore &&
      (Number(persistedAfter.x) !== Number(persistedBefore.x) ||
        Number(persistedAfter.y) !== Number(persistedBefore.y)),
    persistedPositionId: persistedAfter.id ?? null,
    unrelatedNodeCount: mapNodeIdentityEvidence?.unrelatedNodeCount ?? null,
    targetNodeObjectIdentityChanged:
      mapNodeIdentityEvidence?.targetNodeObjectIdentityChanged ?? null,
    targetNodeRenderCount:
      mapNodeIdentityEvidence?.targetNodeRenderCount ?? null,
    unrelatedNodeObjectIdentityChanges:
      mapNodeIdentityEvidence?.unrelatedNodeObjectIdentityChanges ?? null,
    unrelatedNodeRenderCount:
      mapNodeIdentityEvidence?.unrelatedNodeRenderCount ?? null,
    unrelatedRenderedNodeCount:
      mapNodeIdentityEvidence?.unrelatedRenderedNodeCount ?? null,
    unrelatedDomIdentityChanges:
      mapDragEvidence?.unrelatedIdentityChanges ?? null,
    unrelatedTransformChanges:
      mapDragEvidence?.unrelatedTransformChanges ?? null,
    unrelatedChildListReplacements:
      mapDragEvidence?.unrelatedChildListReplacements ?? null,
    unrelatedAttributeMutations:
      mapDragEvidence?.unrelatedAttributeMutations ?? null,
  };
  log(
    `  Map drag: target=${performanceMetrics.interactions.mapDrag.targetNodeRenderCount} render(s), ${performanceMetrics.interactions.mapDrag.unrelatedNodeCount} unrelated nodes, ${performanceMetrics.interactions.mapDrag.unrelatedNodeObjectIdentityChanges} object identity / ${performanceMetrics.interactions.mapDrag.unrelatedNodeRenderCount} render / ${performanceMetrics.interactions.mapDrag.unrelatedChildListReplacements} DOM replacement churn`,
  );
  await captureViewMemoryWindow(page, memorySampler, "map");
  setRuntimeInteraction(null);
}

async function measureTimelineView(page, memorySampler) {
  const timelinePanel = page.getByTestId("timeline-panel");
  await showPanel(page, "timeline", timelinePanel);
  await page.waitForFunction(
    (minimumScenes) =>
      document.querySelectorAll(
        '[data-testid="timeline-panel"] g[data-node-id]',
      ).length >= minimumScenes,
    PERF_SCENE_COUNT + 1,
    { timeout: 30_000 },
  );
  await page.waitForFunction(
    (minimumMarkers) =>
      document.querySelectorAll('[data-testid^="plot-marker-"]').length >=
      minimumMarkers,
    PERF_TIMELINE_MARKER_LINK_COUNT,
    { timeout: 30_000 },
  );
  await measureTimelineDrag(page, memorySampler);
  await captureViewMemoryWindow(page, memorySampler, "timeline");
}

async function measureLinearView(page, memorySampler) {
  setRuntimeInteraction("linearScroll");
  const linearToggle = page.locator(
    'span[title="リニアモード"] > button:not([disabled])',
  );
  await linearToggle.waitFor({ state: "visible", timeout: 10_000 });
  await linearToggle.click();
  await page
    .locator("[data-linear-virtual-row]")
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const row = document.querySelector("[data-linear-virtual-row]");
      const scroller = row?.closest(".overflow-auto");
      return (
        scroller instanceof HTMLElement &&
        scroller.scrollHeight > scroller.clientHeight * 10
      );
    },
    undefined,
    { timeout: 30_000 },
  );
  // Initial active-scene navigation owns scroll detection for at most two
  // seconds. Measure only after that bounded re-anchor phase has settled.
  await page.waitForTimeout(2_100);
  // Phase 1 seeds primary + collection (= selected matrix cardinality).
  // Phase 2 then creates one independent persistence-smoke scene before this
  // interaction, so the actual Linear DOM owns collection + 2 scenes.
  const linearRuntimeSceneCount = PERF_SCENE_COUNT + 2;
  let linearSession = null;
  let linearScrollChanged = false;
  let renderedRows = await page.locator("[data-linear-virtual-row]").count();
  await page.evaluate(() => globalThis.startPerfSession?.());
  try {
    linearScrollChanged = await page.evaluate(() => {
      const row = document.querySelector("[data-linear-virtual-row]");
      const scroller = row?.closest(".overflow-auto");
      if (!(scroller instanceof HTMLElement)) return false;
      const before = scroller.scrollTop;
      const maxScroll = Math.max(
        0,
        scroller.scrollHeight - scroller.clientHeight,
      );
      const target = before > maxScroll / 2 ? 0 : maxScroll;
      scroller.scrollTop = target;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      return scroller.scrollTop !== before;
    });
    await page.waitForFunction(
      () =>
        Number(
          globalThis.snapshotPerfSession?.()?.counters?.[
            "linear.activeDetection.maxVisibleRects"
          ] ?? 0,
        ) > 0,
      undefined,
      { timeout: 5_000 },
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    renderedRows = Math.max(
      renderedRows,
      await page.locator("[data-linear-virtual-row]").count(),
    );
  } finally {
    linearSession = await page.evaluate(() => globalThis.endPerfSession?.());
  }
  const detectionCount =
    linearSession?.counters?.["linear.activeDetection.count"] ?? null;
  const maxVisibleRects =
    linearSession?.counters?.["linear.activeDetection.maxVisibleRects"] ?? null;
  const containerRectReads =
    linearSession?.counters?.["linear.activeDetection.containerRectReads"] ??
    null;
  const sceneRectReads =
    linearSession?.counters?.["linear.activeDetection.sceneRectReads"] ?? null;
  performanceMetrics.interactions.linearScroll = {
    targetVerified:
      linearScrollChanged &&
      renderedRows > 0 &&
      renderedRows < linearRuntimeSceneCount &&
      Number.isFinite(detectionCount) &&
      detectionCount >= 1 &&
      Number.isFinite(maxVisibleRects) &&
      maxVisibleRects > 0 &&
      maxVisibleRects < linearRuntimeSceneCount &&
      containerRectReads === detectionCount &&
      sceneRectReads === 0,
    sceneCount: linearRuntimeSceneCount,
    renderedRows,
    detectionCount,
    maxVisibleRects,
    containerRectReads,
    sceneRectReads,
  };
  log(
    `  Linear scroll: ${renderedRows}/${linearRuntimeSceneCount} rows, ${maxVisibleRects ?? "missing"} visible rect(s), ${sceneRectReads ?? "missing"} scene rect read(s)`,
  );
  await captureViewMemoryWindow(page, memorySampler, "linear");
  await linearToggle.click();
  await page
    .locator("[data-linear-virtual-row]")
    .first()
    .waitFor({ state: "detached", timeout: 10_000 });
  setRuntimeInteraction(null);
}

async function measureChatVirtualization(page, memorySampler) {
  setRuntimeInteraction("chatScroll");
  const virtualList = page.getByTestId("chat-virtual-list");
  await showPanel(page, "chat", virtualList);
  await page.waitForFunction(
    (messageCount) => {
      const list = document.querySelector('[data-testid="chat-virtual-list"]');
      const rows = list?.querySelectorAll('[role="listitem"]') ?? [];
      return (
        list instanceof HTMLElement &&
        rows.length > 0 &&
        rows.length < messageCount &&
        Number(rows[0]?.getAttribute("aria-setsize")) === messageCount
      );
    },
    RUNTIME_BENCHMARK_FIXTURE.chatMessageCount,
    { timeout: 30_000 },
  );

  const result = await page.evaluate((messageCount) => {
    const list = document.querySelector('[data-testid="chat-virtual-list"]');
    const scroller = document.querySelector(
      '[data-testid="chat-scroll-container"]',
    );
    if (!(list instanceof HTMLElement) || !(scroller instanceof HTMLElement)) {
      return null;
    }
    const rows = list.querySelectorAll('[role="listitem"]');
    const before = scroller.scrollTop;
    const maxScroll = Math.max(
      0,
      scroller.scrollHeight - scroller.clientHeight,
    );
    const target = before > maxScroll / 2 ? 0 : maxScroll;
    scroller.scrollTop = target;
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    return {
      messageCount,
      renderedRows: rows.length,
      virtualHeight: list.getBoundingClientRect().height,
      scrollChanged: scroller.scrollTop !== before,
    };
  }, RUNTIME_BENCHMARK_FIXTURE.chatMessageCount);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const renderedAfterScroll = await virtualList
    .locator('[role="listitem"]')
    .count();
  performanceMetrics.interactions.chatScroll = {
    targetVerified:
      result !== null &&
      result.scrollChanged &&
      result.renderedRows > 0 &&
      result.renderedRows < RUNTIME_BENCHMARK_FIXTURE.chatMessageCount &&
      renderedAfterScroll > 0 &&
      renderedAfterScroll < RUNTIME_BENCHMARK_FIXTURE.chatMessageCount,
    messageCount: result?.messageCount ?? null,
    renderedRows: Math.max(result?.renderedRows ?? 0, renderedAfterScroll),
    virtualHeight: result?.virtualHeight ?? null,
  };
  log(
    `  Chat virtualization: ${performanceMetrics.interactions.chatScroll.renderedRows}/${RUNTIME_BENCHMARK_FIXTURE.chatMessageCount} rows`,
  );

  const targetMessageIndex = RUNTIME_BENCHMARK_FIXTURE.chatMessageCount - 1;
  const targetMessageId = `grimodex-runtime-perf-chat-message-${String(
    targetMessageIndex,
  ).padStart(5, "0")}`;
  const targetMessage = page.getByTestId(`chat-message-${targetMessageId}`);
  await page.evaluate(() => {
    const scroller = document.querySelector(
      '[data-testid="chat-scroll-container"]',
    );
    if (scroller instanceof HTMLElement) {
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    }
  });
  await targetMessage.waitFor({ state: "visible", timeout: 10_000 });

  const draftDelta = " RUNTIME-STREAMING-DRAFT-DELTA";
  setRuntimeInteraction("chatDraft");
  let draftSession = null;
  let draftTargetVisible = false;
  let prepared = false;
  try {
    await page.evaluate(
      ({ ownerToken, messageId }) => {
        globalThis.startPerfSession?.();
        try {
          globalThis.invokeRuntimePerformanceControl?.(
            ownerToken,
            "chat.streamingDraft",
            {
              action: "prepare",
              messageId,
              content: "",
            },
          );
        } finally {
          globalThis.endPerfSession?.();
        }
      },
      {
        ownerToken: runtimePerformanceOwnerToken,
        messageId: targetMessageId,
      },
    );
    prepared = true;
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );

    await page.evaluate(() => globalThis.startPerfSession?.());
    try {
      const published = await page.evaluate(
        ({ ownerToken, messageId, delta }) =>
          globalThis.invokeRuntimePerformanceControl?.(
            ownerToken,
            "chat.streamingDraft",
            {
              action: "delta",
              messageId,
              delta,
            },
          ),
        {
          ownerToken: runtimePerformanceOwnerToken,
          messageId: targetMessageId,
          delta: draftDelta,
        },
      );
      if (published !== draftDelta) {
        throw new Error("Chat runtime draft control returned stale content");
      }
      await targetMessage
        .getByText("RUNTIME-STREAMING-DRAFT-DELTA", { exact: false })
        .waitFor({ state: "visible", timeout: 10_000 });
      draftTargetVisible = true;
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
    } finally {
      draftSession = await page.evaluate(() => globalThis.endPerfSession?.());
    }
  } finally {
    if (prepared) {
      await page.evaluate(
        ({ ownerToken, messageId }) => {
          globalThis.startPerfSession?.();
          try {
            globalThis.invokeRuntimePerformanceControl?.(
              ownerToken,
              "chat.streamingDraft",
              {
                action: "cleanup",
                messageId,
              },
            );
          } finally {
            globalThis.endPerfSession?.();
          }
        },
        {
          ownerToken: runtimePerformanceOwnerToken,
          messageId: targetMessageId,
        },
      );
    }
  }
  const chatMessageRender =
    draftSession?.markStats?.find(
      (entry) => entry.label === "chatMessage.render",
    )?.count ?? 0;
  const chatPanelRender =
    draftSession?.markStats?.find((entry) => entry.label === "chatPanel.render")
      ?.count ?? 0;
  performanceMetrics.interactions.chatDraft = {
    targetVerified: draftSession !== null && draftTargetVisible,
    headerCommitCount: draftSession?.counters?.["chat.header.commit"] ?? 0,
    contextBarCommitCount:
      draftSession?.counters?.["chat.contextBar.commit"] ?? 0,
    chatPanelRenderCount: chatPanelRender,
    chatMessageRenderCount: chatMessageRender,
  };
  log(
    `  Chat streaming draft: header ${performanceMetrics.interactions.chatDraft.headerCommitCount}, context ${performanceMetrics.interactions.chatDraft.contextBarCommitCount}, panel ${chatPanelRender}, message ${chatMessageRender} commit(s)`,
  );
  await captureViewMemoryWindow(page, memorySampler, "chat");
  await hidePanelIfVisible(page, "chat", virtualList);
  setRuntimeInteraction(null);
}

async function sampleLargeFixtureViews(page, memorySampler) {
  setRuntimePhase("write.views.calibration", "rafCalibration");
  await ensureBenchmarkPageForeground(page);
  runtimeContext.rafCalibration = await captureRafCalibration(page, {
    sampleCount: RUNTIME_PERFORMANCE_RAF_CALIBRATION_SAMPLE_COUNT,
    onSample: (summary) => {
      runtimeContext.rafCalibration = summary;
    },
  });
  if (!runtimeContext.rafCalibration.complete) {
    throw new Error(
      `runtime performance rAF calibration incomplete: ${JSON.stringify(runtimeContext.rafCalibration)}`,
    );
  }
  log(
    `  rAF calibration: ${runtimeContext.rafCalibration.sampleCount} sample(s), p95 ${runtimeContext.rafCalibration.p95Ms ?? "missing"} ms, max ${runtimeContext.rafCalibration.maxMs ?? "missing"} ms`,
  );
  if (shouldMeasureReviewScenario("map")) {
    setRuntimePhase("write.views.map", "mapDrag");
    await measureMapView(page, memorySampler);
    await hidePanelIfVisible(
      page,
      "map",
      page.locator('[data-droptarget-id="map-panel"]'),
    );
  }
  if (shouldMeasureReviewScenario("timeline")) {
    setRuntimePhase("write.views.timeline", "timelineDrag");
    await measureTimelineView(page, memorySampler);
    await hidePanelIfVisible(
      page,
      "timeline",
      page.getByTestId("timeline-panel"),
    );
  }
  if (shouldMeasureReviewScenario("chronicle")) {
    setRuntimePhase("write.views.chronicle", "chroniclePan");
    await measureChroniclePan(page, memorySampler);
    await hidePanelIfVisible(
      page,
      "chronicle",
      page.locator("#chronicle-track:visible").first(),
    );
  }
  if (shouldMeasureReviewScenario("linear")) {
    setRuntimePhase("write.views.linear", "linearScroll");
    await measureLinearView(page, memorySampler);
  }

  // Restore the minimal editor layout before closing phase 2. Toggling an
  // inactive panel opens it, so only close panels whose own surface is
  // currently visible.
  await hidePanelIfVisible(
    page,
    "timeline",
    page.getByTestId("timeline-panel"),
  );
  await hidePanelIfVisible(
    page,
    "map",
    page.locator('[data-droptarget-id="map-panel"]'),
  );
  await hidePanelIfVisible(
    page,
    "grid",
    page.locator("[data-grid-virtual-row]").first(),
  );
  await scenesPanelHeader(page).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await waitUntil(
    async () => {
      const settings = await invokeOk(page, "get_global_settings", {});
      const active = activePanelsInPersistedLayout(settings);
      return ["timeline", "map", "grid"].every(
        (panelId) => !active.has(panelId),
      );
    },
    "benchmark panels are closed in persisted layout",
    30_000,
    100,
  );
}

// ── フェーズ 1: seed（workspace 作成 + global settings 準備） ─────────────────

async function phaseSeed() {
  assertRuntimePhaseActive("phase seed");
  setRuntimePhase("seed");
  log("phase 1/3: seed — 起動して一時 workspace を作成");
  const { app, page, memorySampler } = await launchApp("seed");
  try {
    const url = page.url();
    if (!url.startsWith("app://bundle/")) {
      throw new Error(`本番ロード URL ではありません (A9): ${url}`);
    }
    log(`  renderer URL: ${url}`);

    // open_workspace = migrate + VACUUM INTO バックアップ + recent 更新（A2 前半）
    const opened = await invokeOk(page, "open_workspace", {
      path: workspaceDir,
    });
    log(
      `  open_workspace: status=${opened?.status} name=${opened?.workspace?.name ?? opened?.name} isExisting=${opened?.workspace?.isExisting ?? opened?.isExisting}`,
    );

    // 次回起動を editor ビュー直行にする: 信頼リスト + launcher スキップ +
    // 初回系ダイアログ（welcome / EULA / リリースノート）の抑止
    const settings = await invokeOk(page, "get_global_settings", {});
    await invokeOk(page, "save_global_settings", {
      settings: {
        ...settings,
        lastActiveWorkspace: workspaceDir,
        trustedWorkspaces: [workspaceDir],
        showLauncherOnStartup: false,
        hasSeenWelcome: true,
        acceptedEulaVersion: eulaVersion,
        lastSeenReleaseNotesVersion: appVersion,
      },
    });
    log("  global settings seeded");

    // Runtime measurement uses a pre-existing scene so startup/open readiness
    // cannot be satisfied by an empty editor shell. This fixture is separate
    // from the scene created in phase 2 and asserted after restart in phase 3.
    if (performanceOutputPath) {
      await seedRuntimePerformanceFixture(page, RUNTIME_BENCHMARK_FIXTURE);
      const actualCardinalityQuery = buildRuntimeFixtureActualCardinalityQuery(
        RUNTIME_BENCHMARK_FIXTURE,
      );
      const actualCardinalityResult = await invokeOk(
        page,
        "db_execute",
        actualCardinalityQuery,
      );
      performanceMetrics.fixture.actualCardinality =
        parseRuntimeFixtureActualCardinality(
          actualCardinalityResult?.rows ?? [],
        );
      log(
        `  runtime performance fixture ${RUNTIME_BENCHMARK_FIXTURE.id} seeded (${PERF_SCENE_COUNT + RUNTIME_BENCHMARK_FIXTURE.autosaveExtraSceneCount + 1} scenes / ${RUNTIME_BENCHMARK_FIXTURE.timelineThreadCount} threads / ${PERF_TIMELINE_MARKER_LINK_COUNT} marker-links / ${PERF_CHRONICLE_EVENT_COUNT} events / ${PERF_MAP_NODE_COUNT} map nodes + ${RUNTIME_BENCHMARK_FIXTURE.mapEdgeCount} edges / ${RUNTIME_BENCHMARK_FIXTURE.chatMessageCount} chat messages / ${RUNTIME_BENCHMARK_FIXTURE.seededTextChars} chars + ${RUNTIME_BENCHMARK_FIXTURE.seededBeatCount} Beats)`,
      );
    }
  } finally {
    await finishRuntimePhase({ app, page, memorySampler, phase: "seed" });
  }
}

// ── フェーズ 2: 執筆（シーン作成 → 本文入力 → オートセーブ着弾） ───────────────

async function phaseWrite() {
  assertRuntimePhaseActive("phase write");
  setRuntimePhase("write");
  log("phase 2/3: write — シーン作成と本文入力");
  const launched = await launchApp("write", {
    deferMemorySampler: Boolean(performanceOutputPath),
  });
  const { app, page } = launched;
  let { memorySampler } = launched;
  try {
    const header = scenesPanelHeader(page);
    await header.waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });

    // 起動直後の layout hydration が全レイヤーで最終状態になっていること。
    // shell / region / editor のどれかが opacity=0 のまま固着すると、locator
    // 自体は visible でも Playwright と実ユーザーの双方が操作できない。
    await page.waitForFunction(
      () => {
        const layers = Array.from(
          document.querySelectorAll(
            "[data-layout-shell], [data-animated-region], [data-editor-area]",
          ),
        );
        return (
          layers.length > 0 &&
          layers.every((layer) => getComputedStyle(layer).opacity === "1")
        );
      },
      undefined,
      { timeout: 5_000 },
    );
    log("  layout hydration完了（全レイヤー opacity=1）");

    if (performanceOutputPath) {
      // Tree rows are virtualized, so the active Scene can legitimately be
      // outside the visible Tree window. Project-open readiness belongs to the
      // exact loaded Editor surface, not to a sidebar row.
      const perfEditorSurface = page
        .locator(
          `[data-editor-loaded-document-id="${PERF_SCENE_ID}"][data-editor-document-loading="false"]`,
        )
        .first();
      await perfEditorSurface.waitFor({
        state: "visible",
        timeout: LAUNCH_TIMEOUT_MS,
      });
      const projectOpenTiming = await page.evaluate((markName) => {
        const marks = performance.getEntriesByName(markName, "mark");
        const startedAt = marks.at(-1)?.startTime;
        return {
          startedAt: startedAt ?? null,
          editorReadyAt: performance.now(),
        };
      }, WORKSPACE_OPEN_START_MARK);
      if (projectOpenTiming.startedAt == null) {
        throw new Error(
          `workspace open start mark not found: ${WORKSPACE_OPEN_START_MARK}`,
        );
      }
      performanceMetrics.projectOpenMs =
        projectOpenTiming.editorReadyAt - projectOpenTiming.startedAt;
      log("  seed scene の Editor surface を確認（projectOpen完了）");

      const perfEditor = perfEditorSurface
        .locator('.ProseMirror[contenteditable="true"]')
        .filter({ hasText: PERF_INPUT_ANCHOR_TEXT })
        .first();
      await perfEditor.waitFor({ state: "visible", timeout: 30_000 });
      log("  seed scene の canonical editor を確認");
      const editorReadyHandle = await page.waitForFunction(
        (markName) => {
          const mark = performance.getEntriesByName(markName, "mark").at(-1);
          return mark ? { startTime: mark.startTime } : false;
        },
        EDITOR_INPUT_READY_MARK,
        { timeout: 30_000 },
      );
      const editorReadyTiming = await editorReadyHandle.jsonValue();
      if (!Number.isFinite(editorReadyTiming?.startTime)) {
        throw new Error("seed scene editor input-ready mark is invalid");
      }
      performanceMetrics.coldStartMs = editorReadyTiming.startTime;
      log("  seed scene editor が入力可能（coldStart完了）");

      memorySampler = startMemorySampler(app, "write", page);
      runtimeContext.memorySampler = memorySampler;
      runtimeContext.memoryStopPromise = null;
      const startupMemorySample = await memorySampler.sampleFresh(true);
      performanceMetrics.memory.startupBytes =
        startupMemorySample?.measuredBytes ?? null;
      performanceMetrics.memory.startupProcessCount =
        startupMemorySample?.processCount ?? null;
      performanceMetrics.memory.startupProcesses =
        startupMemorySample?.processes ?? null;
      performanceMetrics.memory.startupFallbackProcessCount =
        startupMemorySample?.fallbackProcessCount ?? null;

      await waitForRuntimeEditorIdle(page);
      // Pause process/renderer inspection for the complete interaction window.
      // Memory resumes after autosave; otherwise the benchmark would include
      // its own getAppMetrics/page.evaluate polling in input and long-task data.
      await memorySampler.pause();
      let firstInitialSession = null;
      for (const [index, scene] of PERF_AUTOSAVE_SAMPLE_SCENES.entries()) {
        await activateRuntimeAutosaveSample(page, scene);
        await waitForRuntimeEditorIdle(page);
        const initial = await measureRuntimeAutosaveSample(page, {
          sceneId: scene.id,
          anchorText: PERF_INPUT_ANCHOR_TEXT,
          inputText: PERF_INPUT_TEXT,
          requireAutoRevision: true,
          cpuProfilePath: index === 0 ? performanceCpuProfilePath : null,
        });
        firstInitialSession ??= initial.session;
        performanceMetrics.performanceSamples.initialAutosave.push(
          initial.session,
        );
        performanceMetrics.performanceSamples.postSaveDrain.push(
          initial.session.segments.postSaveDrain,
        );
        if (index === 0) {
          performanceMetrics.fixture.editorInputParagraphCharsBefore =
            initial.inputTarget.initialChars;
          performanceMetrics.fixture.editorInputSceneId = scene.id;
          performanceMetrics.fixture.autosaveSceneId = scene.id;
        }

        const steady = await measureRuntimeAutosaveSample(page, {
          sceneId: scene.id,
          anchorText: `${PERF_INPUT_ANCHOR_TEXT}${PERF_INPUT_TEXT}`,
          inputText: PERF_STEADY_INPUT_TEXT,
          requireAutoRevision: false,
        });
        performanceMetrics.performanceSamples.steadyStateAutosave.push(
          steady.session,
        );
      }
      performanceMetrics.fixture.editorInputTargetVerified = true;
      const inputDispatch =
        firstInitialSession?.segments?.typing?.markStats?.find(
          (entry) => entry.label === "editor.viewDispatch",
        );
      performanceMetrics.editorInput = inputDispatch
        ? {
            p50Ms: inputDispatch.p50Ms,
            p95Ms: inputDispatch.p95Ms,
            p99Ms: inputDispatch.p99Ms,
          }
        : null;
      performanceMetrics.autosave = extractAutosaveMetrics(firstInitialSession);
      performanceMetrics.longTask = aggregateRuntimeLongTaskSamples([
        ...performanceMetrics.performanceSamples.initialAutosave,
        ...performanceMetrics.performanceSamples.steadyStateAutosave,
      ]);
      performanceMetrics.diagnostics = {
        sampleSceneIds: PERF_AUTOSAVE_SAMPLE_SCENES.map((scene) => scene.id),
        initialAutosave: performanceMetrics.performanceSamples.initialAutosave,
        steadyStateAutosave:
          performanceMetrics.performanceSamples.steadyStateAutosave,
      };
      // Restore the canonical root Scene before the independent persistence
      // scenario. The two additional samples live inside the large fixture
      // folder; leaving one active would create the smoke Scene among 500
      // siblings instead of exercising the existing root-level contract.
      await activateRuntimeAutosaveSample(page, PERF_AUTOSAVE_SAMPLE_SCENES[0]);
      memorySampler.resume();
      await memorySampler.sampleFresh(true);
      log(
        `  ${PERF_AUTOSAVE_SAMPLE_SCENES.length} scene × initial/steady autosave metrics を記録`,
      );
      // Chat fixtures are scene-scoped to the seeded editor document. Exercise
      // them before the independent persistence scenario changes activeSceneId.
      if (
        RUNTIME_BENCHMARK_FIXTURE.chatMessageCount > 0 &&
        shouldMeasureReviewScenario("chat")
      ) {
        await measureChatVirtualization(page, memorySampler);
      }
    }

    // A1 相当の最小確認: windowControls ブリッジが応答する
    const maximized = await page.evaluate(() =>
      globalThis.grimodex.windowControls.isMaximized(),
    );
    if (typeof maximized !== "boolean") {
      throw new Error("windowControls.isMaximized がブール値を返しません");
    }

    const loadedDocumentIdsBeforeCreate = await page
      .locator(
        '[data-editor-loaded-document-id][data-editor-document-loading="false"]',
      )
      .evaluateAll((elements) =>
        elements
          .map((element) =>
            element.getAttribute("data-editor-loaded-document-id"),
          )
          .filter(Boolean),
      );

    // シーン作成: パネルヘッダの「＋」→ New scene → インライン rename を Enter で確定
    await header.locator(`button[title="${CREATE_BUTTON_TITLE}"]`).click();
    await page
      .getByRole("menuitem", { name: NEW_SCENE_MENU_ITEM, exact: true })
      .click();
    // Virtualized tree rows can commit the default title before Playwright
    // observes the transient auto-focused rename input. Accept either state:
    // commit it when present, then require the durable titled row.
    const renameInput = page.locator(
      '[data-droptarget-id="scenes-panel"] input:focus',
    );
    const renameVisible = await renameInput
      .waitFor({ state: "visible", timeout: 1_000 })
      .then(() => true)
      .catch(() => false);
    if (renameVisible) await page.keyboard.press("Enter");

    // The newly created Scene becomes the active Editor document even when
    // its virtualized Tree row is outside the mounted viewport. Capture that
    // exact ID from the Editor boundary, then prove the row exists in SQLite.
    const smokeSceneIdHandle = await page.waitForFunction(
      (knownDocumentIds) => {
        const known = new Set(knownDocumentIds);
        const surface = Array.from(
          document.querySelectorAll(
            '[data-editor-loaded-document-id][data-editor-document-loading="false"]',
          ),
        ).find((element) => {
          const id = element.getAttribute("data-editor-loaded-document-id");
          return id && !known.has(id);
        });
        return surface?.getAttribute("data-editor-loaded-document-id") ?? false;
      },
      loadedDocumentIdsBeforeCreate,
      { timeout: 30_000 },
    );
    const smokeSceneId = await smokeSceneIdHandle.jsonValue();
    const smokeEditorSurface = page
      .locator(
        `[data-editor-loaded-document-id="${smokeSceneId}"][data-editor-document-loading="false"]`,
      )
      .first();
    await smokeEditorSurface.waitFor({
      state: "visible",
      timeout: 30_000,
    });
    if (typeof smokeSceneId !== "string" || smokeSceneId.length === 0) {
      throw new Error("新規 Scene の loaded document ID を取得できません");
    }
    const createdSmokeScene = await waitUntil(
      () => findSceneByIdInDb(page, smokeSceneId),
      "新規 Scene が tree_nodes に存在する",
      10_000,
    );
    if (createdSmokeScene.title !== DEFAULT_SCENE_TITLE) {
      throw new Error(
        `新規 Scene の既定タイトルが不正です: ${String(createdSmokeScene.title)}`,
      );
    }
    log(`  シーン作成（既定タイトル: ${DEFAULT_SCENE_TITLE}）`);

    // 新規 Scene の canonical Editor に本文を入力
    const editor = smokeEditorSurface
      .locator('.ProseMirror[contenteditable="true"]')
      .first();
    await editor.waitFor({ state: "visible", timeout: 30_000 });
    await editor.click();
    await page.keyboard.type(SMOKE_TEXT, { delay: 10 });
    log("  本文入力完了 — オートセーブ着弾を待機");

    // オートセーブ（2s debounce → db_execute_batch）の DB 着弾を待つ
    await waitUntil(
      () => findSmokeSceneInDb(page),
      "オートセーブが tree_nodes.content に着弾する",
      30_000,
    );
    log("  DB 着弾確認");

    if (performanceOutputPath && memorySampler) {
      if (shouldMeasureReviewScenario("treeGrid")) {
        await assertTreeAndGridVirtualization(page);
      }
      if (
        RUNTIME_BENCHMARK_FIXTURE.reviewScenario === null ||
        ["map", "timeline", "chronicle", "linear"].includes(
          RUNTIME_BENCHMARK_FIXTURE.reviewScenario,
        )
      ) {
        await sampleLargeFixtureViews(page, memorySampler);
      }
    }
  } finally {
    await finishRuntimePhase({ app, page, memorySampler, phase: "write" });
  }
}

// ── フェーズ 3: 再起動して残存 assert ─────────────────────────────────────────

async function phaseAssertAfterRestart() {
  assertRuntimePhaseActive("phase restart");
  setRuntimePhase("restart");
  log("phase 3/3: restart — 再起動後の本文残存 assert");
  const { app, page, memorySampler } = await launchApp("restart");
  try {
    const header = scenesPanelHeader(page);
    await showPanel(page, "scenes", header);

    // DB レベル（再オープン = 既存 DB の migrate 経路も踏む）
    const persistedSmokeScene = await waitUntil(
      () => findSmokeSceneInDb(page),
      "再起動後の DB に本文が残存する",
      30_000,
    );
    log("  DB 残存確認");

    // Let the startup-selected tab finish its own canonical load before
    // issuing another navigation. Clicking a Tree row while that load is still
    // binding sidecars can manufacture an overlapping switch that no user
    // reaches after the editor becomes interactive.
    const initialEditorPane = page
      .locator(
        '[data-editor-loaded-document-id]:not([data-editor-loaded-document-id=""])[data-editor-document-loading="false"]:visible',
      )
      .first();
    await initialEditorPane.waitFor({ state: "visible", timeout: 30_000 });
    const initialDocumentId = await initialEditorPane.getAttribute(
      "data-editor-loaded-document-id",
    );

    // UI レベル: タイトル文字列の重複やタブ見出しに依存せず、DBで残存を
    // 証明した同じ Scene ID を開いて本文表示を確認する。通常はpersist済みのtabが
    // 直接復元されるため、別文書が復元された場合だけ仮想Treeのfilterを使う。
    let persistedEditorPane = initialEditorPane;
    if (initialDocumentId !== persistedSmokeScene.id) {
      const scenesPanel = page.locator(
        '[data-droptarget-id="scenes-panel"]:visible',
      );
      await scenesPanel
        .getByTestId("scenes-filter-input")
        .fill(String(persistedSmokeScene.title ?? DEFAULT_SCENE_TITLE));
      const persistedSceneRow = page
        .locator(`li[data-node-id="${persistedSmokeScene.id}"]`)
        .first();
      await persistedSceneRow.waitFor({ state: "visible", timeout: 30_000 });
      await persistedSceneRow.click();
      persistedEditorPane = page
        .locator(
          `[data-editor-loaded-document-id="${persistedSmokeScene.id}"][data-editor-document-loading="false"]`,
        )
        .first();
    }
    await persistedEditorPane.waitFor({ state: "visible", timeout: 30_000 });
    await persistedEditorPane
      .getByTestId("editor-content-loading")
      .waitFor({ state: "detached", timeout: 30_000 });
    await persistedEditorPane
      .locator(`.ProseMirror:has-text("${SMOKE_TEXT}")`)
      .first()
      .waitFor({ state: "visible", timeout: 30_000 });
    log("  UI 残存確認（エディタに本文表示）");
  } finally {
    await finishRuntimePhase({
      app,
      page,
      memorySampler,
      phase: "restart",
    });
  }
}

async function collectRuntimeTimeoutDiagnostics(timeoutSnapshot) {
  const dom = await readDomForegroundSnapshot(timeoutSnapshot.page).catch(
    (error) => ({ available: false, error: String(error?.message ?? error) }),
  );
  const nativeWindow = await readRuntimeWindowSnapshot(
    timeoutSnapshot.app,
  ).catch((error) => ({
    available: false,
    error: String(error?.message ?? error),
  }));
  let appMetrics = null;
  if (timeoutSnapshot.app?.evaluate) {
    appMetrics = await timeoutSnapshot.app
      .evaluate(({ app: electronApp }) =>
        electronApp.getAppMetrics().map((metric) => ({
          pid: metric.pid,
          type: metric.type,
          creationTime: metric.creationTime,
          memory: metric.memory ?? null,
          cpu: metric.cpu ?? null,
        })),
      )
      .catch((error) => ({
        available: false,
        error: String(error?.message ?? error),
      }));
  }
  return {
    foreground: { dom, nativeWindow },
    nativeWindow,
    environment: timeoutSnapshot.environment,
    process: {
      node: timeoutSnapshot.process.node,
      electron: timeoutSnapshot.process.electron,
      appMetrics,
    },
  };
}

async function finalizeRuntimePageSession(timeoutSnapshot) {
  if (!timeoutSnapshot.page?.evaluate) return null;
  return await timeoutSnapshot.page
    .evaluate(() => globalThis.endPerfSession?.())
    .catch(() => null);
}

function finalizeRuntimeWatchdog(timeoutSnapshot) {
  if (runtimeContext.watchdogPromise) return runtimeContext.watchdogPromise;
  const artifact = buildRuntimePerformanceTimeoutArtifact({
    reason: "global-watchdog",
    timeoutMs: GLOBAL_WATCHDOG_MS,
    startedAt: timeoutSnapshot.startedAt,
    timedOutAt: timeoutSnapshot.capturedAt,
    elapsedMs: timeoutSnapshot.elapsedMs,
    phase: timeoutSnapshot.phase,
    currentInteraction: timeoutSnapshot.currentInteraction,
    partialMetrics: timeoutSnapshot.partialMetrics,
    rafCalibration: timeoutSnapshot.rafCalibration,
    foreground: timeoutSnapshot.foreground,
    environment: timeoutSnapshot.environment,
    process: timeoutSnapshot.process,
  });
  const cleanupCoordinator = timeoutSnapshot.cleanupCoordinator;
  const stopMemorySampler = () =>
    cleanupCoordinator?.stopMemorySampler(timeoutSnapshot.memorySampler) ??
    timeoutSnapshot.memorySampler?.stop?.();
  const closeApp = () =>
    cleanupCoordinator?.closeApp(
      timeoutSnapshot.app,
      timeoutSnapshot.page,
      timeoutSnapshot.phase,
      closeElectronAppWithDiagnostics,
    ) ??
    (timeoutSnapshot.app
      ? closeElectronAppWithDiagnostics(
          timeoutSnapshot.app,
          timeoutSnapshot.page,
          timeoutSnapshot.phase,
        )
      : null);
  const forceKill = () =>
    cleanupCoordinator?.terminateProcess(() =>
      terminateOwnedProcessTree({
        childProcessSnapshot: timeoutSnapshot.process.electron,
        platform: timeoutSnapshot.process.node.platform ?? process.platform,
      }),
    ) ??
    terminateOwnedProcessTree({
      childProcessSnapshot: timeoutSnapshot.process.electron,
      platform: timeoutSnapshot.process.node.platform ?? process.platform,
    });
  const watchdogPromise = finalizeRuntimePerformanceTimeout({
    timeoutArtifactPath: performanceTimeoutArtifactPath,
    artifact,
    collectDiagnostics: () => collectRuntimeTimeoutDiagnostics(timeoutSnapshot),
    finalizeSession: () => finalizeRuntimePageSession(timeoutSnapshot),
    stopMemorySampler,
    closeApp,
    forceKill,
    writeArtifact: writeRuntimePerformanceTimeoutArtifact,
    hardExit: (exitCode, result) => {
      console.error(
        `[electron:smoke] structured watchdog evidence: ${result.path}`,
      );
      process.exit(exitCode);
    },
  })
    .then((result) => {
      console.error(
        `[electron:smoke] structured watchdog evidence: ${result.path}`,
      );
      process.exitCode = 1;
      return result;
    })
    .catch((error) => {
      console.error(
        `[electron:smoke] watchdog finalization failed: ${error?.stack ?? error}`,
      );
      process.exitCode = 1;
      return null;
    });
  runtimeContext.watchdogPromise = watchdogPromise;
  return watchdogPromise;
}

// ── 実行 ────────────────────────────────────────────────────────────────────

const watchdog = setTimeout(() => {
  console.error(
    `[electron:smoke] watchdog timeout (${GLOBAL_WATCHDOG_MS}ms) — 強制終了します`,
  );
  console.error(`[electron:smoke] 一時ディレクトリを残します: ${tmpRoot}`);
  const timeoutSnapshot = snapshotRuntimePerformanceContext(runtimeContext);
  runtimeContext.timeoutSnapshot = timeoutSnapshot;
  runtimeContext.watchdogTriggered = true;
  runtimeAbortController.abort("global-watchdog");
  void finalizeRuntimeWatchdog(timeoutSnapshot);
}, GLOBAL_WATCHDOG_MS);
watchdog.unref?.();

try {
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(userDataDir, { recursive: true });
  await runRuntimePerformancePhaseSequence({
    signal: runtimeAbortSignal,
    phases: [phaseSeed, phaseWrite, phaseAssertAfterRestart],
  });
  if (runtimeContext.watchdogTriggered) {
    await runtimeContext.watchdogPromise;
    process.exitCode = 1;
  } else {
    if (performanceOutputPath) {
      await writeFile(
        performanceOutputPath,
        `${JSON.stringify(performanceMetrics, null, 2)}\n`,
        "utf8",
      );
      log(`performance metrics: ${performanceOutputPath}`);
    }
    clearTimeout(watchdog);
    if (runtimeContext.watchdogTriggered) {
      await runtimeContext.watchdogPromise;
      process.exitCode = 1;
    } else {
      await rm(tmpRoot, { recursive: true, force: true });
      log("PASS — A2/A9 スモーク完了（3 起動、本文残存を確認）");
      process.exitCode = 0;
    }
  }
} catch (e) {
  clearTimeout(watchdog);
  console.error(`[electron:smoke] FAIL: ${e?.stack ?? e}`);
  console.error(`[electron:smoke] 一時ディレクトリを残します: ${tmpRoot}`);
  if (runtimeContext.watchdogTriggered) {
    if (runtimeContext.watchdogPromise) await runtimeContext.watchdogPromise;
  } else {
    const memorySampler = runtimeContext.memorySampler;
    if (memorySampler) {
      try {
        await stopRuntimeMemorySampler(memorySampler);
      } catch (cleanupError) {
        console.error(
          `[electron:smoke] memory cleanup failed: ${cleanupError?.stack ?? cleanupError}`,
        );
      }
    }
    if (runtimeContext.app) {
      try {
        await closeAppWithDiagnostics(
          runtimeContext.app,
          runtimeContext.page,
          runtimeContext.phase,
        );
      } catch (closeError) {
        console.error(
          `[electron:smoke] app close failed: ${closeError?.stack ?? closeError}`,
        );
        const failureSnapshot =
          snapshotRuntimePerformanceContext(runtimeContext);
        const termination =
          await runtimeContext.cleanupCoordinator.terminateProcess(() =>
            terminateOwnedProcessTree({
              childProcessSnapshot: failureSnapshot.process.electron,
              platform:
                failureSnapshot.process.node.platform ?? process.platform,
            }),
          );
        console.error(
          `[electron:smoke] owned process termination: ${JSON.stringify(termination)}`,
        );
      }
    }
  }
  process.exitCode = 1;
}
