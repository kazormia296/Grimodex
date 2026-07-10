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
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { _electron } from "playwright";

import { rootDir } from "./build.mjs";

const require = createRequire(import.meta.url);

// ── 定数 / 前提チェック ──────────────────────────────────────────────────────

const SMOKE_TEXT = `SMOKE-${Date.now()}-スモーク本文`;
const SCENES_PANEL_TITLE = "シーン"; // ja.json layout.panel.scenes
const CREATE_BUTTON_TITLE = "新規作成"; // ja.json scenes.create
const NEW_SCENE_MENU_ITEM = "New scene"; // ja.json scenes.newScene
const DEFAULT_SCENE_TITLE = "シーン 1"; // ja.json tree.defaultScene + 連番
const LAUNCH_TIMEOUT_MS = 60_000;
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

/** アプリを 1 回起動して main window の bridge が生きるまで待つ。 */
async function launchApp() {
  const env = { ...process.env };
  delete env.ELECTRON_RENDERER_URL; // 本番経路（app://）を強制
  env.GRIMODEX_USER_DATA_DIR = userDataDir;

  const app = await _electron.launch({
    executablePath: electronBin,
    args: [mainCjs],
    env,
    timeout: LAUNCH_TIMEOUT_MS,
  });
  // main プロセスの標準出力を prefix 付きで透過（CI 調査用）
  app.process().stdout?.on("data", (d) => {
    process.stdout.write(`  [main] ${String(d)}`);
  });
  app.process().stderr?.on("data", (d) => {
    process.stderr.write(`  [main] ${String(d)}`);
  });

  const page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT_MS });
  await page.waitForFunction(
    () => globalThis.grimodex?.shell === "electron",
    undefined,
    { timeout: LAUNCH_TIMEOUT_MS },
  );
  return { app, page };
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

// ── フェーズ 1: seed（workspace 作成 + global settings 準備） ─────────────────

async function phaseSeed() {
  log("phase 1/3: seed — 起動して一時 workspace を作成");
  const { app, page } = await launchApp();
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
  } finally {
    await app.close();
  }
}

// ── フェーズ 2: 執筆（シーン作成 → 本文入力 → オートセーブ着弾） ───────────────

async function phaseWrite() {
  log("phase 2/3: write — シーン作成と本文入力");
  const { app, page } = await launchApp();
  try {
    const header = scenesPanelHeader(page);
    await header.waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });
    log("  editor ビュー到達（シーン一覧パネル表示）");

    // 起動直後のlayout hydrationクロスフェードが最終状態へ戻っていること。
    // opacity=0のまま固着するとlocator自体はvisibleでも操作不能になる。
    await page.waitForFunction(
      () => {
        const shell = document.querySelector("[data-layout-shell]");
        return shell !== null && getComputedStyle(shell).opacity === "1";
      },
      undefined,
      { timeout: 5_000 },
    );
    log("  layout crossfade完了（opacity=1）");

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
    const renameInput = page.locator("input:focus");
    await renameInput.waitFor({ state: "visible", timeout: 10_000 });
    await page.keyboard.press("Enter");
    log(`  シーン作成（既定タイトル: ${DEFAULT_SCENE_TITLE}）`);

    // シーンを開いて本文を入力
    await page.getByText(DEFAULT_SCENE_TITLE, { exact: true }).first().click();
    const editor = page.locator('.ProseMirror[contenteditable="true"]').first();
    await editor.waitFor({ state: "visible", timeout: 30_000 });
    await editor.click();
    await page.keyboard.type(SMOKE_TEXT, { delay: 10 });
    log("  本文入力完了 — オートセーブ着弾を待機");

    // オートセーブ（2s debounce → db_execute_batch）の DB 着弾を待つ
    await waitUntil(
      () => sceneContentInDb(page),
      "オートセーブが tree_nodes.content に着弾する",
      30_000,
    );
    log("  DB 着弾確認");
  } finally {
    await app.close();
  }
}

// ── フェーズ 3: 再起動して残存 assert ─────────────────────────────────────────

async function phaseAssertAfterRestart() {
  log("phase 3/3: restart — 再起動後の本文残存 assert");
  const { app, page } = await launchApp();
  try {
    const header = scenesPanelHeader(page);
    await header.waitFor({ state: "visible", timeout: LAUNCH_TIMEOUT_MS });

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
