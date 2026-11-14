/* global window */
// 測定 A・B の launcher の共通部：Vite、隔離した bus、作品×段ごとの別 process の Electron、
// 作品の写し（入れ子 folder）の作成、名簿の登録、後始末。run-inventory.mjs の部品を使う。
// AI は呼ばない（B の送信は run-measure-b.mjs が、別の経路で明示的に許したときだけ行う）。
// 出力は件数・ID・hash・path だけ。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { clearInterval, setInterval } from "node:timers";
import { WORKS, safeErrorSummary, scenesFromWork, scenesTextsForScan } from "./lib.mjs";
import { resolveWorkSource } from "./sources.mjs";
import {
  countAiRows,
  electronEnv,
  ensurePrivateDir,
  precheckEnvironment,
  productVersion,
  sampleEgress,
  startIsolatedBus,
  writePrivateJson,
} from "./run-inventory.mjs";

export const ROOT = path.resolve(import.meta.dirname, "../../..");
export const DEFAULT_OUTPUT = "/home/grimodex/identity-review-load-2026-11";
const require = createRequire(import.meta.url);

/** 偽 AI の env（GRIMODEX_PRODUCT_JOURNEY_*）を、本測定の process に持ち込まないことの検査。 */
export const FORBIDDEN_ENV_PREFIX = "GRIMODEX_PRODUCT_JOURNEY";
export function findForbiddenEnv(env) {
  return Object.keys(env)
    .filter((name) => name.startsWith(FORBIDDEN_ENV_PREFIX))
    .sort();
}
/** 立っていれば [precheck] で止める（値は出さず、名前だけ数える）。 */
export function assertNoFakeAiEnv(env = process.env) {
  const found = findForbiddenEnv(env);
  assert.equal(
    found.length,
    0,
    `[precheck] FAKE_AI_ENV_SET ${found.length} GRIMODEX_PRODUCT_JOURNEY* variables are set`,
  );
}

/** 作品の scenes JSON を読む（件数の検査つき）。 */
export function loadWork(workKey, dataDir = "") {
  const work = JSON.parse(
    readFileSync(resolveWorkSource(workKey, dataDir || null), "utf8"),
  );
  const scenes = scenesFromWork(work);
  assert.equal(
    scenes.length,
    WORKS[workKey],
    "[precheck] SCENE_COUNT_DIFFERS scene count differs from registered",
  );
  return { work, scenes, scenesTexts: scenesTextsForScan(scenes) };
}

/** Vite と隔離 bus を起こし、fn を実行して後始末する。 */
export async function withVite(output, fn) {
  const root = path.resolve(output);
  ensurePrivateDir(root);
  precheckEnvironment(root);
  assertNoFakeAiEnv(process.env);
  ensurePrivateDir(path.join(root, "vite-cache"));
  const bus = await startIsolatedBus(root);
  const { createServer } = await import("vite");
  const vite = await createServer({
    root: ROOT,
    cacheDir: path.join(root, "vite-cache"),
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
    clearScreen: false,
    logLevel: "error",
  });
  await vite.listen();
  try {
    return await fn({ vite, busAddress: bus.address, output: root });
  } finally {
    await vite.close();
    bus.stop();
  }
}

/**
 * 1 つの cell（作品×段）を、別の Electron process・別の workspace で動かす。
 * body({ page, app, userData, workspaceDir, scenes, work }) が測定を行い、値を返す。
 * 返り値に cell の観測（IPC の command 名・AI 行の数・接続先・時間）を付ける。
 * 本文・表記の文字列は載せない。
 */
export async function runCell({
  output,
  vite,
  busAddress,
  cellId,
  workKey,
  dataDir = "",
  passwordStoreBasic = true,
  body,
  keep = false,
}) {
  const workRoot = path.join(output, "run", cellId);
  rmSync(workRoot, { recursive: true, force: true });
  const userData = path.join(workRoot, "user-data");
  const workspaceDir = path.join(workRoot, "workspace");
  const tmpDir = path.join(workRoot, "tmp");
  const xdgDir = path.join(workRoot, "xdg");
  for (const dir of [workRoot, userData, workspaceDir, tmpDir, xdgDir])
    ensurePrivateDir(dir);
  const loaded = loadWork(workKey, dataDir);
  const destinations = new Set();
  let sampleCount = 0;
  let sampler;
  let app;
  const started = Date.now();
  const cell = {
    cellId,
    work: workKey,
    status: "blocked",
    product: productVersion(),
  };
  try {
    writeFileSync(
      path.join(userData, "legacy-keyring-migration-v1.json"),
      JSON.stringify({
        version: 1,
        completedAt: new Date().toISOString(),
        imported: 0,
        skippedExisting: 0,
        fixtureOnly: true,
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(userData, "global-settings.json"),
      JSON.stringify({
        recentWorkspaces: [],
        lastActiveWorkspace: null,
        theme: "system",
        uiLanguage: "en",
        uiScale: 100,
        showLauncherOnStartup: false,
        userPreferences: { "data.autoBackup": "false" },
      }),
      { mode: 0o600 },
    );
    const address = vite.httpServer.address();
    assert.ok(address && typeof address !== "string");
    const rendererUrl = `http://127.0.0.1:${address.port}/scripts/quality/identity-review-load/renderer.html`;
    const main = path.join(ROOT, "dist-electron/main.cjs");
    const native = path.join(
      ROOT,
      "electron/native/grimodex-node/grimodex-node.node",
    );
    const observer = path.join(
      ROOT,
      "scripts/quality/nir1-retrieval/electron-observer.mjs",
    );
    for (const file of [main, native, observer])
      assert.ok(
        existsSync(file),
        `[precheck] missing ${path.relative(ROOT, file)}`,
      );
    const { _electron } = await import("playwright");
    const env = electronEnv({
      ELECTRON_RENDERER_URL: rendererUrl,
      GRIMODEX_USER_DATA_DIR: userData,
      GRIMODEX_NODE_PATH: native,
      GRIMODEX_NIR1_PRODUCTION_MAIN: main,
      TMPDIR: tmpDir,
      XDG_RUNTIME_DIR: xdgDir,
      DBUS_SESSION_BUS_ADDRESS: busAddress,
    });
    assertNoFakeAiEnv(env);
    app = await _electron.launch({
      executablePath: require("electron"),
      args: [
        "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
        ...(passwordStoreBasic ? ["--password-store=basic"] : []),
        observer,
      ],
      cwd: ROOT,
      env,
      timeout: 60000,
    });
    // main の process.env にも偽 AI の env が無いこと（件数だけ）。
    const mainEnvNames = await app.evaluate(() => Object.keys(process.env));
    assertNoFakeAiEnv(Object.fromEntries(mainEnvNames.map((n) => [n, "1"])));
    const rootPid = app.process().pid;
    sampler = setInterval(() => {
      try {
        sampleCount++;
        if (rootPid) sampleEgress(rootPid, destinations);
      } catch {
        // 標本の失敗は run を止めない。
      }
    }, 250);
    const page = await app.firstWindow();
    await page.waitForFunction(
      () => window.identityLoad?.ready === true,
      null,
      { timeout: 120000 },
    );
    cell.electronVersion = await app.evaluate(() => process.versions.electron);

    const projectId = `idl-${workKey}`;
    await page.evaluate((input) => window.identityLoad.openProject(input), {
      workspacePath: path.join(workspaceDir, "ws"),
      projectId,
      title: `IDL ${workKey}`,
      language: "ja",
    });
    const build = await page.evaluate(
      (input) => window.identityLoad.buildNestedWork(input),
      {
        projectId,
        workKey,
        work: {
          scenes: loaded.work.scenes.map((s) => ({
            index: s.index,
            paragraphs: s.paragraphs,
          })),
        },
      },
    );
    assert.equal(
      build.text.mismatched,
      0,
      "[artifact] PERSISTED_TEXT_MISMATCH persisted text differs from scenes JSON",
    );
    for (const check of Object.values(build.folderChecks))
      assert.ok(
        check.derivedMatches && check.storeMatches,
        "[artifact] FOLDER_SCOPE_MISMATCH folder scope mismatch",
      );
    cell.build = {
      sceneCount: build.sceneCount,
      paragraphCount: build.paragraphCount,
      folderSceneCounts: build.folderSceneCounts,
      ruby: build.ruby,
    };

    const value = await body({
      page,
      app,
      projectId,
      userData,
      workspaceDir,
      scenes: loaded.scenes,
      scenesTexts: loaded.scenesTexts,
    });

    const ipc = await app.evaluate(() => globalThis.nir1IpcTrace.calls);
    const names = ipc.map((call) => call.command);
    const counts = {};
    for (const name of names) counts[name] = (counts[name] ?? 0) + 1;
    cell.ipc = {
      callCount: ipc.length,
      failedCallCount: ipc.filter((call) => call.completed && !call.ok).length,
      commandNames: [...new Set(names)].sort(),
      commandCounts: counts,
    };
    cell.aiRows = countAiRows(workspaceDir);
    clearInterval(sampler);
    sampler = undefined;
    sampleEgress(rootPid, destinations);
    cell.egress = {
      sampleCount,
      nonLoopbackDestinationCount: destinations.size,
      nonLoopbackDestinations: [...destinations].sort(),
    };
    cell.elapsedMs = Date.now() - started;
    return { cell, value, scenesTexts: loaded.scenesTexts };
  } catch (error) {
    cell.status = "failed";
    cell.errors = [safeErrorSummary(error)];
    return { cell, value: null, scenesTexts: loaded.scenesTexts };
  } finally {
    if (sampler) clearInterval(sampler);
    if (app) await app.close().catch(() => undefined);
    if (!keep) rmSync(workRoot, { recursive: true, force: true });
  }
}

export { ensurePrivateDir, writePrivateJson };
export function writeJson0600(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}
