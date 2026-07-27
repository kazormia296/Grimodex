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
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { _electron } from "playwright";

import { rootDir } from "./build.mjs";
import { extractAutosaveMetrics } from "../../scripts/runtime-performance-budget.mjs";

const require = createRequire(import.meta.url);

// ── 定数 / 前提チェック ──────────────────────────────────────────────────────

const SMOKE_TEXT = `SMOKE-${Date.now()}-スモーク本文`;
const PERF_SCENE_ID = "grimodex-runtime-perf-seeded-scene";
const PERF_FOLDER_ID = "grimodex-runtime-perf-scenes";
const PERF_BOARD_ID = "grimodex-runtime-perf-board";
const PERF_SCENE_TITLE = "PERF READY SCENE";
const PERF_SCENE_COUNT = 500;
const PERF_SCENE_TEXT = "本文".repeat(25_000);
const PERF_BEAT_COUNT = 20;
const SCENES_PANEL_TITLE = "シーン"; // ja.json layout.panel.scenes
const CREATE_BUTTON_TITLE = "新規作成"; // ja.json scenes.create
const NEW_SCENE_MENU_ITEM = "New scene"; // ja.json scenes.newScene
const DEFAULT_SCENE_TITLE = "シーン 1"; // ja.json tree.defaultScene + 連番
const LAUNCH_TIMEOUT_MS = 60_000;
const MEMORY_SAMPLE_INTERVAL_MS = 100;
const WORKSPACE_OPEN_START_MARK = "grimodex.workspaceOpen.start";
const GLOBAL_WATCHDOG_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 300_000);

function log(step) {
  console.log(`[electron:smoke] ${step}`);
}

function precondition(cond, message) {
  if (!cond) {
    console.error(`[electron:smoke] ${message}`);
    process.exit(1);
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
const performanceMetrics = {
  coldStartMs: null,
  projectOpenMs: null,
  editorInput: null,
  autosave: null,
  memory: {
    startupBytes: null,
    peakBytes: 0,
    measurement: "sumProcessPrivateBytes",
    sampleIntervalMs: MEMORY_SAMPLE_INTERVAL_MS,
    samples: [],
    peakByViewBytes: {
      map: null,
      timeline: null,
      linear: null,
    },
  },
  longTask: null,
};

async function appMemorySnapshot(app) {
  return app.evaluate(({ app: electronApp }) =>
    electronApp.getAppMetrics().reduce(
      (total, metric) => ({
        // Private bytes avoid double-counting shared Chromium pages once for
        // every renderer/GPU/utility process in the app-wide sum.
        privateBytes:
          total.privateBytes +
          Number(
            metric.memory?.private ??
              metric.memory?.privateBytes ??
              metric.memory?.workingSetSize ??
              0,
          ) *
            1_024,
        workingSetBytes:
          total.workingSetBytes +
          Number(
            metric.memory?.residentSet ?? metric.memory?.workingSetSize ?? 0,
          ) *
            1_024,
      }),
      { privateBytes: 0, workingSetBytes: 0 },
    ),
  );
}

function recordMemorySample(sample) {
  performanceMetrics.memory.samples.push(sample);
  performanceMetrics.memory.peakBytes = Math.max(
    performanceMetrics.memory.peakBytes,
    sample.privateBytes,
  );
  for (const view of sample.views) {
    const current = performanceMetrics.memory.peakByViewBytes[view] ?? 0;
    performanceMetrics.memory.peakByViewBytes[view] = Math.max(
      current,
      sample.privateBytes,
    );
  }
}

/**
 * Capture short-lived memory peaks. Renderer view detection runs every fifth
 * sample to avoid making the measurement itself a material main-thread load;
 * intervening samples retain the last observed view state.
 */
function startMemorySampler(app, phase) {
  const startedAt = performance.now();
  let page = null;
  let stopped = false;
  let inFlight = null;
  let sampleIndex = 0;
  let lastViews = [];

  const sample = async (forceViewDetection = false) => {
    if (stopped) return null;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const { privateBytes, workingSetBytes } = await appMemorySnapshot(app);
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
              return views;
            });
          } catch {
            lastViews = [];
          }
        }
        const result = {
          phase,
          elapsedMs: performance.now() - startedAt,
          privateBytes,
          workingSetBytes,
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
      const finalSample = await sample();
      stopped = true;
      return finalSample;
    },
  };
}

/** アプリを 1 回起動して main window の bridge が生きるまで待つ。 */
async function launchApp(phase) {
  const launchStarted = performance.now();
  const env = { ...process.env };
  delete env.ELECTRON_RENDERER_URL; // 本番経路（app://）を強制
  env.GRIMODEX_USER_DATA_DIR = userDataDir;

  const app = await _electron.launch({
    executablePath: electronBin,
    args: [mainCjs],
    env,
    timeout: LAUNCH_TIMEOUT_MS,
  });
  const memorySampler = performanceOutputPath
    ? startMemorySampler(app, phase)
    : null;
  // main プロセスの標準出力を prefix 付きで透過（CI 調査用）
  app.process().stdout?.on("data", (d) => {
    process.stdout.write(`  [main] ${String(d)}`);
  });
  app.process().stderr?.on("data", (d) => {
    process.stderr.write(`  [main] ${String(d)}`);
  });

  const page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT_MS });
  memorySampler?.setPage(page);
  await page.waitForFunction(
    () => globalThis.grimodex?.shell === "electron",
    undefined,
    { timeout: LAUNCH_TIMEOUT_MS },
  );
  const bridgeMemorySample = await memorySampler?.sampleFresh();
  return {
    app,
    page,
    launchStarted,
    bridgeMemorySample,
    memorySampler,
  };
}

/** ブリッジ invoke（envelope 解封。ok:false は throw）。 */
async function invokeOk(page, cmd, args) {
  const envelope = await page.evaluate(
    ([c, a]) => globalThis.grimodex.invoke(c, a),
    [cmd, args ?? {}],
  );
  if (!envelope.ok) throw new Error(`${cmd} rejected: ${envelope.error}`);
  return envelope.value;
}

function buildRuntimeFixtureStatements() {
  const longContent = [];
  const paragraphSize = 1_000;
  const paragraphCount = Math.ceil(PERF_SCENE_TEXT.length / paragraphSize);
  for (
    let paragraphIndex = 0;
    paragraphIndex < paragraphCount;
    paragraphIndex += 1
  ) {
    const start = paragraphIndex * paragraphSize;
    longContent.push({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: PERF_SCENE_TEXT.slice(start, start + paragraphSize),
        },
      ],
    });
    const beatsThroughThisParagraph = Math.floor(
      ((paragraphIndex + 1) * PERF_BEAT_COUNT) / paragraphCount,
    );
    const beatsThroughPreviousParagraph = Math.floor(
      (paragraphIndex * PERF_BEAT_COUNT) / paragraphCount,
    );
    for (
      let beatIndex = beatsThroughPreviousParagraph;
      beatIndex < beatsThroughThisParagraph;
      beatIndex += 1
    ) {
      longContent.push({
        type: "sceneBeat",
        attrs: {
          id: `runtime-perf-beat-${beatIndex}`,
          collapsed: false,
          beatType: "free",
          pov: null,
        },
        content: [{ type: "text", text: `Beat ${beatIndex}` }],
      });
    }
  }
  const longDocument = JSON.stringify({
    type: "doc",
    content: longContent,
  });
  const statements = [
    {
      sql: `INSERT INTO tree_nodes
        (id, project_id, node_type, title, content, char_count, sort_order)
        VALUES (?, 'default-project', 'scene', ?, ?, ?, 'a0')`,
      params: [
        PERF_SCENE_ID,
        PERF_SCENE_TITLE,
        longDocument,
        PERF_SCENE_TEXT.length,
      ],
      method: "run",
    },
    {
      sql: `INSERT INTO tree_nodes
        (id, project_id, node_type, title, sort_order)
        VALUES (?, 'default-project', 'folder', 'PERF LARGE FIXTURE', 'a1')`,
      params: [PERF_FOLDER_ID],
      method: "run",
    },
    {
      sql: `INSERT INTO map_boards
        (id, project_id, title, sort_order, mode, show_config)
        VALUES (?, 'default-project', 'PERF LARGE BOARD', 0, 'free', '{}')`,
      params: [PERF_BOARD_ID],
      method: "run",
    },
  ];

  const sceneIds = [PERF_SCENE_ID];
  for (let index = 0; index < PERF_SCENE_COUNT; index += 1) {
    const sceneId = `grimodex-runtime-perf-scene-${String(index).padStart(3, "0")}`;
    const sceneText =
      `PERF scene ${String(index + 1).padStart(3, "0")} virtualized body. `.repeat(
        20,
      );
    const sceneDocument = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: sceneText }],
        },
      ],
    });
    sceneIds.push(sceneId);
    statements.push({
      sql: `INSERT INTO tree_nodes
        (id, project_id, parent_id, node_type, title, content, char_count, sort_order, story_time_order)
        VALUES (?, 'default-project', ?, 'scene', ?, ?, ?, 'a0', ?)`,
      params: [
        sceneId,
        PERF_FOLDER_ID,
        `PERF SCENE ${String(index + 1).padStart(3, "0")}`,
        sceneDocument,
        sceneText.length,
        String(index).padStart(4, "0"),
      ],
      method: "run",
    });
  }

  for (let index = 0; index < sceneIds.length; index += 1) {
    const sceneId = sceneIds[index];
    statements.push({
      sql: `INSERT INTO map_node_positions
        (id, board_id, node_ref_type, tree_node_id, x, y, z_index)
        SELECT ? || '-' || id, id, 'scene', ?, ?, ?, ?
        FROM map_boards
        WHERE project_id = 'default-project'`,
      params: [
        `grimodex-runtime-perf-position-${String(index).padStart(3, "0")}`,
        sceneId,
        (index % 18) * 240,
        Math.floor(index / 18) * 140,
        index,
      ],
      method: "run",
    });
  }

  return statements;
}

/** fn() が truthy を返すまでポーリング（fn の throw はリトライ扱い）。 */
async function waitUntil(fn, label, timeoutMs = 30_000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      lastError = e;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `timeout waiting for: ${label}` +
          (lastError
            ? `\n  last error: ${lastError.message ?? lastError}`
            : ""),
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** scene 本文が DB に残っているか（ブリッジ経由 SELECT — Tauri と同一ワイヤ）。 */
async function sceneContentInDb(page) {
  const result = await invokeOk(page, "db_execute", {
    sql: "SELECT id, title, content FROM tree_nodes WHERE node_type = 'scene'",
    params: [],
    method: "all",
  });
  return JSON.stringify(result?.rows ?? []).includes(SMOKE_TEXT);
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

async function showPanel(page, panelId, readyLocator) {
  if (await readyLocator.isVisible()) return;
  await togglePanel(page, panelId);
  const becameVisible = await readyLocator
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (becameVisible) return;
  // A panel can remain active while its persisted region is out of view. The
  // first toggle then disables it; a second toggle re-adds it to a visible
  // region. Do not accept either path until the panel's own readiness is seen.
  await togglePanel(page, panelId);
  await readyLocator.waitFor({ state: "visible", timeout: 30_000 });
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

async function assertTreeAndGridVirtualization(page) {
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
}

async function sampleLargeFixtureViews(page, memorySampler) {
  const mapPanel = page.locator('[data-droptarget-id="map-panel"]');
  await showPanel(page, "map", mapPanel);
  await page.waitForFunction(
    (minimumNodes) =>
      Number(
        document
          .querySelector("[data-map-rendered-node-count]")
          ?.getAttribute("data-map-rendered-node-count") ?? 0,
      ) >= minimumNodes,
    PERF_SCENE_COUNT + 1,
    { timeout: 30_000 },
  );
  await captureViewMemoryWindow(page, memorySampler, "map");

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
  await captureViewMemoryWindow(page, memorySampler, "timeline");

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
  await captureViewMemoryWindow(page, memorySampler, "linear");
  await linearToggle.click();
  await page
    .locator("[data-linear-virtual-row]")
    .first()
    .waitFor({ state: "detached", timeout: 10_000 });

  // Restore the minimal editor layout before closing phase 2. Panel enablement
  // is persisted; leaving the three benchmark views active can crowd Scenes
  // out of the next launch and would make the persistence smoke test a layout
  // test instead.
  for (const panelId of ["timeline", "map", "grid"]) {
    await togglePanel(page, panelId);
  }
  await scenesPanelHeader(page).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await page.waitForTimeout(1_000);
}

// ── フェーズ 1: seed（workspace 作成 + global settings 準備） ─────────────────

async function phaseSeed() {
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
      `  open_workspace: name=${opened?.name} isExisting=${opened?.isExisting}`,
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
      await invokeOk(page, "db_execute_batch", {
        statements: buildRuntimeFixtureStatements(),
      });
      log(
        `  runtime performance fixture seeded (${PERF_SCENE_COUNT + 1} scenes / ${PERF_SCENE_COUNT + 1} map nodes / ${PERF_SCENE_TEXT.length} chars + ${PERF_BEAT_COUNT} Beats)`,
      );
    }
  } finally {
    await memorySampler?.stop();
    await app.close();
  }
}

// ── フェーズ 2: 執筆（シーン作成 → 本文入力 → オートセーブ着弾） ───────────────

async function phaseWrite() {
  log("phase 2/3: write — シーン作成と本文入力");
  const { app, page, launchStarted, bridgeMemorySample, memorySampler } =
    await launchApp("write");
  try {
    if (performanceOutputPath) {
      // Preserve startup-memory semantics at bridge readiness. coldStart itself
      // continues through seeded editor input readiness; the 100ms peak sampler
      // captures all memory growth between those two points and during autosave.
      performanceMetrics.memory.startupBytes =
        bridgeMemorySample?.privateBytes ?? null;
    }
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
      const perfScene = page
        .getByText(PERF_SCENE_TITLE, { exact: true })
        .first();
      await perfScene.waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
      const projectOpenTiming = await page.evaluate((markName) => {
        const marks = performance.getEntriesByName(markName, "mark");
        const startedAt = marks.at(-1)?.startTime;
        return {
          startedAt: startedAt ?? null,
          sceneVisibleAt: performance.now(),
        };
      }, WORKSPACE_OPEN_START_MARK);
      if (projectOpenTiming.startedAt == null) {
        throw new Error(
          `workspace open start mark not found: ${WORKSPACE_OPEN_START_MARK}`,
        );
      }
      performanceMetrics.projectOpenMs =
        projectOpenTiming.sceneVisibleAt - projectOpenTiming.startedAt;
      log("  seed scene がシーン一覧に表示（projectOpen完了）");

      await perfScene.click();
      const perfEditor = page
        .locator('.ProseMirror[contenteditable="true"]')
        .first();
      await perfEditor.waitFor({ state: "visible", timeout: 30_000 });
      const perfEditorReady = await perfEditor.evaluate(
        (element) =>
          element.isContentEditable &&
          getComputedStyle(element).pointerEvents !== "none",
      );
      if (!perfEditorReady) {
        throw new Error("seed scene editor is not contenteditable/input-ready");
      }
      await perfEditor.click();
      performanceMetrics.coldStartMs = performance.now() - launchStarted;
      log("  seed scene editor が入力可能（coldStart完了）");
    }

    // A1 相当の最小確認: windowControls ブリッジが応答する
    const maximized = await page.evaluate(() =>
      globalThis.grimodex.windowControls.isMaximized(),
    );
    if (typeof maximized !== "boolean") {
      throw new Error("windowControls.isMaximized がブール値を返しません");
    }

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
    await page
      .getByText(DEFAULT_SCENE_TITLE, { exact: true })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
    log(`  シーン作成（既定タイトル: ${DEFAULT_SCENE_TITLE}）`);

    // シーンを開いて本文を入力
    await page.getByText(DEFAULT_SCENE_TITLE, { exact: true }).first().click();
    const editor = page.locator('.ProseMirror[contenteditable="true"]').first();
    await editor.waitFor({ state: "visible", timeout: 30_000 });
    await editor.click();
    if (performanceOutputPath) {
      await page.evaluate(() => globalThis.startPerfSession?.());
    }
    await page.keyboard.type(SMOKE_TEXT, { delay: 10 });
    log("  本文入力完了 — オートセーブ着弾を待機");

    // オートセーブ（2s debounce → db_execute_batch）の DB 着弾を待つ
    await waitUntil(
      () => sceneContentInDb(page),
      "オートセーブが tree_nodes.content に着弾する",
      30_000,
    );
    log("  DB 着弾確認");

    if (performanceOutputPath && memorySampler) {
      const perfSession = await page.evaluate(() =>
        globalThis.endPerfSession?.(),
      );
      const dispatch = perfSession?.markStats?.find(
        (entry) => entry.label === "editor.viewDispatch",
      );
      performanceMetrics.editorInput = dispatch
        ? {
            p50Ms: dispatch.p50Ms,
            p95Ms: dispatch.p95Ms,
            p99Ms: dispatch.p99Ms,
          }
        : null;
      performanceMetrics.autosave = extractAutosaveMetrics(perfSession);
      performanceMetrics.longTask = perfSession?.longtask ?? null;
      await assertTreeAndGridVirtualization(page);
      await sampleLargeFixtureViews(page, memorySampler);
    }
  } finally {
    await memorySampler?.stop();
    await app.close();
  }
}

// ── フェーズ 3: 再起動して残存 assert ─────────────────────────────────────────

async function phaseAssertAfterRestart() {
  log("phase 3/3: restart — 再起動後の本文残存 assert");
  const { app, page, memorySampler } = await launchApp("restart");
  try {
    const header = scenesPanelHeader(page);
    await showPanel(page, "scenes", header);

    // DB レベル（再オープン = 既存 DB の migrate 経路も踏む）
    await waitUntil(
      () => sceneContentInDb(page),
      "再起動後の DB に本文が残存する",
      30_000,
    );
    log("  DB 残存確認");

    // UI レベル: シーンを開いてエディタに本文が出る
    await page.getByText(DEFAULT_SCENE_TITLE, { exact: true }).first().click();
    await page
      .locator(`.ProseMirror:has-text("${SMOKE_TEXT}")`)
      .first()
      .waitFor({ state: "visible", timeout: 30_000 });
    log("  UI 残存確認（エディタに本文表示）");
  } finally {
    await memorySampler?.stop();
    await app.close();
  }
}

// ── 実行 ────────────────────────────────────────────────────────────────────

const watchdog = setTimeout(() => {
  console.error(
    `[electron:smoke] watchdog timeout (${GLOBAL_WATCHDOG_MS}ms) — 強制終了します`,
  );
  console.error(`[electron:smoke] 一時ディレクトリを残します: ${tmpRoot}`);
  process.exit(1);
}, GLOBAL_WATCHDOG_MS);
watchdog.unref?.();

try {
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(userDataDir, { recursive: true });
  await phaseSeed();
  await phaseWrite();
  await phaseAssertAfterRestart();
  if (performanceOutputPath) {
    await writeFile(
      performanceOutputPath,
      `${JSON.stringify(performanceMetrics, null, 2)}\n`,
      "utf8",
    );
    log(`performance metrics: ${performanceOutputPath}`);
  }
  clearTimeout(watchdog);
  await rm(tmpRoot, { recursive: true, force: true });
  log("PASS — A2/A9 スモーク完了（3 起動、本文残存を確認）");
  process.exit(0);
} catch (e) {
  clearTimeout(watchdog);
  console.error(`[electron:smoke] FAIL: ${e?.stack ?? e}`);
  console.error(`[electron:smoke] 一時ディレクトリを残します: ${tmpRoot}`);
  // 生きの Electron プロセスが残らないよう明示 kill（best-effort）
  spawnSync("pkill", ["-f", mainCjs], { stdio: "ignore" });
  process.exit(1);
}
