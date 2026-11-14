/* global window */
// 同定の review の負荷の測定：作品ごとの 0 回目の目録と、空の名簿での構造抽出（試走 g）。
// AI は呼ばない。出力は件数・ID・hash・path だけ（assertOutputClean が文字列の欄と
// 原稿の shingle を検査する）。作品ごとに別の Electron process・別の workspace。
//
// 起動例（隔離。unshare -n は使わない）:
//   env -u WAYLAND_DISPLAY -u WAYLAND_SOCKET -u XDG_SESSION_TYPE -u DBUS_SESSION_BUS_ADDRESS \
//     ELECTRON_OZONE_PLATFORM_HINT=x11 TMPDIR=<out>/tmp dbus-run-session -- \
//     node scripts/local-ci-xvfb.mjs node scripts/quality/identity-review-load/run-inventory.mjs \
//       --works m-ja-1,m-ja-2 [--mode inventory|extract-empty]
import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { createRequire } from "node:module";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  WORKS,
  assertOutputClean,
  expectedSceneText,
  scenesFromWork,
} from "./lib.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const DEFAULT_OUTPUT = "/home/grimodex/identity-review-load-2026-11";
const DATA_DIR = "/home/grimodex/fusion-eval-data/pd-2026-11/scenes";

/** AI／外部通信の command（electron/main/profileEgress.ts の DENIED_COMMANDS と同じ語彙）。 */
const AI_COMMAND =
  /^(send_|codex_app_|start_post_effect_run|.*_cli_|.*_cli$|list_ai_models|test_ai_connection|get_mcp_config|nir1_local_generation|ai_(?!audit_read_snapshot$|audit_verify$)|.*judg|vivliostyle_)/u;
export function findAiCommands(commandNames) {
  return [...new Set(commandNames)]
    .filter((name) => AI_COMMAND.test(name))
    .sort();
}

function parseArgs(args) {
  const options = {
    works: Object.keys(WORKS).join(","),
    mode: "inventory",
    output: DEFAULT_OUTPUT,
    keep: "false",
  };
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(
      args[i].startsWith("--") && args[i + 1] !== undefined,
      "use --name value arguments",
    );
    options[args[i].slice(2)] = args[i + 1];
  }
  assert.ok(
    ["inventory", "extract-empty"].includes(options.mode),
    "[precheck] unknown --mode",
  );
  for (const work of options.works.split(","))
    assert.ok(work in WORKS, `[precheck] unknown work ${work}`);
  return options;
}

/** エラー文は ASCII の識別子の形だけ残して切る（本文・表記が混ざっても残らない）。 */
export function sanitizeError(text) {
  return text.replace(/[^A-Za-z0-9_.:/+=\- ]/gu, "_").slice(0, 400);
}

function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}
function writePrivateJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Electron に渡す env。key・token を持ち込まない（API key に触らない）。 */
function electronEnv(extra) {
  const keep = [
    "PATH",
    "HOME",
    "LANG",
    "DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "TMPDIR",
    "ELECTRON_OZONE_PLATFORM_HINT",
  ];
  const env = {};
  for (const name of keep) if (process.env[name]) env[name] = process.env[name];
  return { ...env, ...extra };
}

/** workspace の DB に AI の行が無いことを、読み取り専用で数える（best effort）。 */
function countAiRows(workspaceDir) {
  const result = { checked: false, tables: {} };
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(db|sqlite|sqlite3)$/u.test(entry.name)) found.push(full);
    }
  };
  if (existsSync(workspaceDir)) walk(workspaceDir);
  result.dbFileCount = found.length;
  for (const file of found) {
    for (const table of ["ai_audit_events", "ai_usage"]) {
      try {
        const out = execFileSync(
          "sqlite3",
          [
            "-readonly",
            `file:${file}?mode=ro`,
            `SELECT COUNT(*) FROM ${table}`,
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
        ).trim();
        result.tables[table] = (result.tables[table] ?? 0) + Number(out);
        result.checked = true;
      } catch {
        // その DB にその table が無い、または開けない。
      }
    }
  }
  return result;
}

async function runWork(workKey, options, vite) {
  const output = path.resolve(options.output);
  const workRoot = path.join(output, "run", `${options.mode}-${workKey}`);
  rmSync(workRoot, { recursive: true, force: true });
  const userData = path.join(workRoot, "user-data");
  const workspaceDir = path.join(workRoot, "workspace");
  const tmpDir = path.join(workRoot, "tmp");
  for (const dir of [workRoot, userData, workspaceDir, tmpDir])
    ensurePrivateDir(dir);

  const work = JSON.parse(
    readFileSync(path.join(DATA_DIR, `${workKey}.json`), "utf8"),
  );
  const scenes = scenesFromWork(work);
  assert.equal(
    scenes.length,
    WORKS[workKey],
    `[precheck] scene count differs from registered for ${workKey}`,
  );
  const scenesTexts = scenes.map((scene) =>
    expectedSceneText(scene.paragraphs),
  );

  // keyring を読まない・既定の設定を使う（nir1-retrieval と同じ）。
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
  const started = Date.now();
  let app;
  const result = {
    schemaVersion: "identity-load-inventory/1",
    mode: options.mode,
    work: workKey,
    status: "blocked",
    errors: [],
  };
  try {
    app = await _electron.launch({
      executablePath: require("electron"),
      // 外向きの名前解決を止める（辞書・モデルの取得などの既定の通信を出さない）。localhost だけ通す。
      args: [
        "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
        observer,
      ],
      cwd: ROOT,
      env: electronEnv({
        ELECTRON_RENDERER_URL: rendererUrl,
        GRIMODEX_USER_DATA_DIR: userData,
        GRIMODEX_NODE_PATH: native,
        GRIMODEX_NIR1_PRODUCTION_MAIN: main,
        TMPDIR: tmpDir,
      }),
      timeout: 60000,
    });
    const page = await app.firstWindow();
    await page.waitForFunction(
      () => window.identityLoad?.ready === true,
      null,
      { timeout: 120000 },
    );
    result.electronVersion = await app.evaluate(
      () => process.versions.electron,
    );

    const workspacePath = path.join(workspaceDir, "ws");
    const projectId = `idl-${workKey}`;
    await page.evaluate((input) => window.identityLoad.openProject(input), {
      workspacePath,
      projectId,
      title: `IDL ${workKey}`,
      language: "ja",
    });
    result.build = await page.evaluate(
      (input) => window.identityLoad.buildNestedWork(input),
      {
        projectId,
        workKey,
        work: {
          scenes: work.scenes.map((s) => ({
            index: s.index,
            paragraphs: s.paragraphs,
          })),
        },
      },
    );
    assert.equal(
      result.build.text.mismatched,
      0,
      "[artifact] persisted text differs from scenes JSON",
    );
    for (const [name, check] of Object.entries(result.build.folderChecks))
      assert.ok(
        check.derivedMatches && check.storeMatches,
        `[artifact] folder scope mismatch ${name}`,
      );

    let rows;
    if (options.mode === "inventory") {
      const inventory = await page.evaluate(() =>
        window.identityLoad.inventory({ folderPercent: 100 }),
      );
      rows = {
        seedRows: inventory.seedRows,
        candidateRows: inventory.candidateRows,
      };
      result.inventory = { ...inventory };
      delete result.inventory.seedRows;
      delete result.inventory.candidateRows;
    } else {
      // 空の名簿（Entry 0 件）で構造抽出。F100 に対して 1 回。
      // まず製品の経路（Native へ保存する）。失敗したら理由だけ記録し、live の projection だけを
      // 保存なし（製品の skipNativePersist の seam）で読む。
      let persisted;
      try {
        persisted = await page.evaluate(() =>
          window.identityLoad.extractStructure({
            folderPercent: 100,
            persist: true,
          }),
        );
        result.persistAttempt = { status: "ok" };
      } catch (error) {
        result.persistAttempt = {
          status: "failed",
          error: sanitizeError(
            error instanceof Error ? error.message : "unknown",
          ),
        };
      }
      const extract =
        persisted ??
        (await page.evaluate(() =>
          window.identityLoad.extractStructure({
            folderPercent: 100,
            persist: false,
          }),
        ));
      rows = { proposalRows: extract.rows };
      result.extractEmpty = { ...extract };
      delete result.extractEmpty.rows;
    }

    const ipc = await app.evaluate(() => globalThis.nir1IpcTrace.calls);
    const names = ipc.map((call) => call.command);
    result.ipc = {
      callCount: ipc.length,
      distinctCommandCount: new Set(names).size,
      failedCallCount: ipc.filter((call) => call.completed && !call.ok).length,
      aiCommands: findAiCommands(names),
      commandNames: [...new Set(names)].sort(),
    };
    result.aiRows = countAiRows(workspaceDir);
    result.elapsedMs = Date.now() - started;
    result.status =
      result.ipc.aiCommands.length === 0 &&
      Object.values(result.aiRows.tables).every((n) => n === 0)
        ? "ok"
        : "ai-detected";

    // 書く前に混入を検査する（失敗時は件数だけの Error）。
    assertOutputClean(result, scenesTexts);
    assertOutputClean(rows, scenesTexts);
    const dir = path.join(
      output,
      options.mode === "inventory" ? "inventory" : "extract-empty",
    );
    ensurePrivateDir(dir);
    writePrivateJson(path.join(dir, `${workKey}.json`), result);
    writePrivateJson(path.join(dir, `${workKey}.rows.json`), rows);
  } catch (error) {
    result.errors.push(
      error instanceof Error
        ? sanitizeError(`${error.name}: ${error.message}`)
        : "unknown error",
    );
    // エラー文に本文が混ざりうるので、書く前に検査して落ちるなら件数だけにする。
    try {
      assertOutputClean(result, scenesTexts);
    } catch {
      result.errors = ["error text withheld (unsafe content)"];
    }
    const dir = path.join(
      output,
      options.mode === "inventory" ? "inventory" : "extract-empty",
    );
    ensurePrivateDir(dir);
    writePrivateJson(path.join(dir, `${workKey}.failed.json`), result);
  } finally {
    if (app) await app.close().catch(() => undefined);
    if (options.keep !== "true")
      rmSync(workRoot, { recursive: true, force: true });
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const output = path.resolve(options.output);
  ensurePrivateDir(output);
  ensurePrivateDir(path.join(output, "vite-cache"));
  const { createServer } = await import("vite");
  const vite = await createServer({
    root: ROOT,
    cacheDir: path.join(output, "vite-cache"),
    server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
    clearScreen: false,
    logLevel: "error",
  });
  await vite.listen();
  const summary = [];
  try {
    for (const workKey of options.works.split(",")) {
      const result = await runWork(workKey, options, vite);
      summary.push({
        work: workKey,
        mode: options.mode,
        status: result.status,
        errors: result.errors.length,
      });
      console.log(JSON.stringify(summary.at(-1)));
    }
  } finally {
    await vite.close();
  }
  if (summary.some((s) => s.status !== "ok")) process.exitCode = 1;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  await main();
}
