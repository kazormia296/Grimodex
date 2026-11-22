/* global window */
// 測定 A・B の launcher の共通部：Vite、隔離した bus、作品×段ごとの別 process の Electron、
// 作品の写し（入れ子 folder）の作成、名簿の登録、後始末。run-inventory.mjs の部品を使う。
// AI は呼ばない（B の送信は run-measure-b.mjs が、別の経路で明示的に許したときだけ行う）。
// 出力は件数・ID・hash・path だけ。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { clearInterval, setInterval } from "node:timers";
import {
  assertBuildProvenance,
  provenanceForRecord,
} from "./build-provenance.mjs";
import { createEgressSampler } from "./egress-policy.mjs";
import {
  WORKS,
  safeErrorSummary,
  scenesFromWork,
  scenesTextsForScan,
} from "./lib.mjs";
import { inspectKeyFiles, registerCleanup } from "./cleanup.mjs";
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

/**
 * 本測定の process に持ち込まない env：偽 AI の env（GRIMODEX_PRODUCT_JOURNEY_*）、Rust 側の
 * 送受信の本文を tracing に出す GRIMODEX_AI_WIRE_LOG、trace／debug の RUST_LOG（本文が出うる）。
 * さらに、key を出力しうる debug 系（F3a の M1）：key は page.evaluate の引数で渡るので、Playwright の protocol log
 * （DEBUG=pw:protocol など。PWDEBUG も）・node の内部 log（NODE_DEBUG）・Electron の log／stack dump
 * （ELECTRON_ENABLE_LOGGING・ELECTRON_ENABLE_STACK_DUMPING）・inspector（NODE_OPTIONS の --inspect／--debug）が立っていると、
 * stderr（stdio inherit）などに key が出うる。立っていれば（空でも）止める。
 * 検査は node の process.env と、main の process.env（名前と、値が要るものの値）の両方に同じ集合を使う。
 */
export const FORBIDDEN_ENV_PREFIX = "GRIMODEX_PRODUCT_JOURNEY";
export const FORBIDDEN_ENV_NAMES = Object.freeze([
  "GRIMODEX_AI_WIRE_LOG",
  "DEBUG",
  "PWDEBUG",
  "NODE_DEBUG",
  "NODE_DEBUG_NATIVE",
  "ELECTRON_ENABLE_LOGGING",
  "ELECTRON_ENABLE_STACK_DUMPING",
]);
export function findForbiddenEnv(env) {
  return Object.keys(env)
    .filter(
      (name) =>
        name.startsWith(FORBIDDEN_ENV_PREFIX) ||
        FORBIDDEN_ENV_NAMES.includes(name) ||
        (name === "RUST_LOG" &&
          /\b(trace|debug)\b/iu.test(String(env[name]))) ||
        (name === "NODE_OPTIONS" &&
          /--inspect|--debug/iu.test(String(env[name]))),
    )
    .sort();
}
/** 立っていれば [precheck] で止める（値は出さず、名前だけ数える）。 */
export function assertNoFakeAiEnv(env = process.env) {
  const found = findForbiddenEnv(env);
  assert.equal(
    found.length,
    0,
    `[precheck] FORBIDDEN_ENV_SET ${found.length} forbidden variables are set (fake AI, wire log, trace log or a debug setting that can print the key)`,
  );
}

/**
 * 他の job が動いていないこと。重なりの疑いは測定を始めない（§9）。対象は cargo・rustc と、Grimodex の
 * Electron（args に dist-electron・grimodex・nir1 を含む electron）。この process の子孫（自分の Electron・
 * 復号の helper）は除く。利用者の desktop の electron アプリ（Grimodex の args でないもの）は数えない。
 */
export function findOverlappingJobs(psText, ownPid = process.pid) {
  const rows = [];
  for (const line of String(psText).split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/u.exec(line);
    if (match)
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        comm: match[3],
        args: match[4],
      });
  }
  const own = new Set([Number(ownPid)]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows)
      if (!own.has(row.pid) && own.has(row.ppid)) {
        own.add(row.pid);
        grew = true;
      }
  }
  return rows
    .filter((row) => !own.has(row.pid))
    .filter(
      (row) =>
        row.comm === "cargo" ||
        row.comm === "rustc" ||
        (row.comm === "electron" &&
          /dist-electron|grimodex|nir1/iu.test(row.args)),
    )
    .map((row) => row.comm)
    .sort();
}
export function assertNoOverlappingJobs(
  run = () =>
    execFileSync("ps", ["-eo", "pid,ppid,comm,args"], { encoding: "utf8" }),
) {
  const found = findOverlappingJobs(run());
  assert.equal(
    found.length,
    0,
    `[precheck] OVERLAPPING_JOBS ${found.length} other cargo, rustc or Grimodex electron processes are running`,
  );
}

/**
 * 測定の Electron の env を組む（純関数）。bus・runtime dir は隔離したもの（busAddress・xdgDir）だけで、
 * 起動した人の本物の session の env（key の復号の helper にだけ渡す。real-env.mjs）は入れない。
 * plainTextRunRoot を渡したとき（本測定の B）に限り、safeStorage の basic_text を認める上書き
 * （electron-observer-b.mjs）の条件の env を立てる。
 */
export function buildMeasureElectronEnv({
  rendererUrl,
  userData,
  native,
  main,
  tmpDir,
  xdgDir,
  busAddress,
  plainTextRunRoot = "",
}) {
  return electronEnv({
    ELECTRON_RENDERER_URL: rendererUrl,
    GRIMODEX_USER_DATA_DIR: userData,
    GRIMODEX_NODE_PATH: native,
    GRIMODEX_NIR1_PRODUCTION_MAIN: main,
    TMPDIR: tmpDir,
    XDG_RUNTIME_DIR: xdgDir,
    DBUS_SESSION_BUS_ADDRESS: busAddress,
    ...(plainTextRunRoot
      ? {
          GRIMODEX_IDL_PLAIN_TEXT_KEYSTORE: "1",
          GRIMODEX_IDL_RUN_ROOT: plainTextRunRoot,
        }
      : {}),
  });
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
 * cell の後始末と検査（keep でないとき）。key を含みうる file（ai-keys.json など）が userData に残っていないこと
 * （delete_api_key の後に entry が 0）を、削除の前に見て、workRoot を消し、消えたことを確かめる。
 * 数だけ cell.keyCleanup に記録し（内容は読まない）、残っていれば cell を failed にする（以後の cell は launcher が止める）。
 */
export function finishCellCleanup(cell, { userData, workRoot }) {
  const residue = inspectKeyFiles(userData);
  try {
    rmSync(workRoot, { recursive: true, force: true });
  } catch {
    // 消せなかった事実は下の existsSync で見る。
  }
  const removed = !existsSync(workRoot);
  cell.keyCleanup = {
    keyFilesBeforeRemoval: residue.files,
    keyFilesWithEntries: residue.withEntries,
    workRootRemoved: removed,
  };
  if (residue.withEntries > 0 || !removed) {
    cell.status = "failed";
    cell.errors = [
      ...(cell.errors ?? []),
      safeErrorSummary(
        new Error(
          `[artifact] KEY_RESIDUE_AFTER_CELL entries=${residue.withEntries} workRootRemoved=${removed ? 1 : 0}`,
        ),
      ),
    ];
  }
  return cell;
}

/**
 * 1 つの cell（作品×段）を、別の Electron process・別の workspace で動かす。
 * body({ page, app, userData, workspaceDir, scenes, work }) が測定を行い、値を返す。
 * 返り値に cell の観測（IPC の command 名・AI 行の数・接続先・時間）を付ける。
 * 本文・表記の文字列は載せない。
 */
/**
 * cell の作業 dir の名前（cell の名前と切り離した短い固定長）。Chromium の SingletonSocket の path の
 * 長さが cell の名前で変わらないようにする（2026-11-23 の試走で、長い名前の cell だけが起動しなかった）。
 * 後始末（cleanup.mjs の findKeyResidue）は `B-`（`B-dry-` を除く）で key を持ちうる cell を見分けるので、
 * その接頭辞は残す。最長は `B-dry-` ＋ 10 桁の 16 字で、run-inventory の LONGEST_CELL_DIR_NAME（20）に収まる。
 */
export function cellDirName(cellId) {
  assert.ok(
    /^(A|B)-/u.test(cellId),
    "[precheck] CELL_ID_PREFIX cell id must start with A- or B-",
  );
  const hash = createHash("sha256").update(cellId).digest("hex").slice(0, 10);
  if (cellId.startsWith("B-dry-")) return `B-dry-${hash}`;
  return `${cellId.slice(0, 2)}${hash}`;
}

/**
 * runCell が差し替えられる部品（試験用の注入。本番は既定のまま）：出所の照合・作品の読み込み・Electron の起動・
 * 製品の root・製品の版。本番で渡さなければ、F2 の guard は常に動く。
 */
async function defaultLaunchElectron(options) {
  const { _electron } = await import("playwright");
  return _electron.launch({ executablePath: require("electron"), ...options });
}

/**
 * cell の出所の照合結果を比べる（head・build 物・guard の file の sha256 がすべて同じか）。
 * 起動の直前の再照合と、cell の後の照合が使う。
 */
export function sameBuildProvenance(a, b) {
  return (
    a?.head === b?.head &&
    JSON.stringify(a?.files) === JSON.stringify(b?.files) &&
    JSON.stringify(a?.guardFiles) === JSON.stringify(b?.guardFiles)
  );
}

export async function runCell({
  output,
  vite,
  busAddress,
  cellId,
  workKey,
  dataDir = "",
  passwordStoreBasic = true,
  plainTextKeyStore = false,
  egressPolicy = null,
  body,
  keep = false,
  deps = {},
}) {
  const d = {
    assertBuildProvenance,
    loadWork,
    launchElectron: defaultLaunchElectron,
    root: ROOT,
    productVersion,
    ...deps,
  };
  const runRoot = path.join(output, "run");
  const workRoot = path.join(runRoot, cellDirName(cellId));
  rmSync(workRoot, { recursive: true, force: true });
  const userData = path.join(workRoot, "user-data");
  const workspaceDir = path.join(workRoot, "workspace");
  const tmpDir = path.join(workRoot, "tmp");
  const xdgDir = path.join(workRoot, "xdg");
  for (const dir of [workRoot, userData, workspaceDir, tmpDir, xdgDir])
    ensurePrivateDir(dir);
  const loaded = d.loadWork(workKey, dataDir);
  // 宛先の標本（Electron の起動後に作る）。egressPolicy（実測定の許可リスト）があれば許可リスト以外を、
  // 無ければ loopback 以外をすべて数える。
  let egressSampler = null;
  let firstProvenance = null;
  let sampler;
  let app;
  const started = Date.now();
  // kill されたとき（finally が走らない）も、隔離 userData の key と workRoot を消す。
  assert.ok(
    !(plainTextKeyStore && keep),
    "[precheck] KEEP_FORBIDDEN a cell that may hold a key on disk must be deleted at its end",
  );
  const unregisterCleanup = registerCleanup(() => {
    try {
      app?.process().kill("SIGKILL");
    } catch {
      // 既に終わっている。
    }
    rmSync(workRoot, { recursive: true, force: true });
  });
  const cell = {
    cellId,
    work: workKey,
    status: "blocked",
    product: d.productVersion(),
  };
  try {
    // build 物の出所が今の HEAD の source と一致すること（F2 の R2）。満たさなければ Electron を起動しない。
    // 照合の結果の全体（guard の file の path を含む）は比べるためだけに持ち、records には件数と digest だけを残す。
    firstProvenance = d.assertBuildProvenance({ root: d.root });
    cell.buildProvenance = provenanceForRecord(firstProvenance);
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
    const main = path.join(d.root, "dist-electron/main.cjs");
    const native = path.join(
      d.root,
      "electron/native/grimodex-node/grimodex-node.node",
    );
    // 本測定の B（plainTextKeyStore）だけ、basic_text の safeStorage を認める上書き（§17.6）を包んだ起動 script を使う。
    const observer = plainTextKeyStore
      ? path.join(import.meta.dirname, "electron-observer-b.mjs")
      : path.join(
          d.root,
          "scripts/quality/nir1-retrieval/electron-observer.mjs",
        );
    for (const file of [main, native, observer])
      assert.ok(
        existsSync(file),
        `[precheck] missing ${path.relative(d.root, file)}`,
      );
    // 起動の直前にもう一度照合する（cell の準備の間に build 物・guard の file が差し替わっても、別の物を起動しない）。
    const beforeLaunch = d.assertBuildProvenance({ root: d.root });
    assert.ok(
      sameBuildProvenance(beforeLaunch, firstProvenance),
      "[precheck] BUILD_PROVENANCE_CHANGED_DURING_CELL_SETUP build artifacts changed after the first check",
    );
    const env = buildMeasureElectronEnv({
      rendererUrl,
      userData,
      native,
      main,
      tmpDir,
      xdgDir,
      busAddress,
      plainTextRunRoot: plainTextKeyStore ? runRoot : "",
    });
    assertNoFakeAiEnv(env);
    app = await d.launchElectron({
      args: [
        "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
        ...(passwordStoreBasic || plainTextKeyStore
          ? ["--password-store=basic"]
          : []),
        observer,
      ],
      cwd: d.root,
      env,
      timeout: 60000,
    });
    // main の process.env にも偽 AI の env が無いこと（件数だけ）。
    const mainEnv = await app.evaluate(() => ({
      names: Object.keys(process.env),
      rustLog: process.env.RUST_LOG ?? "",
      nodeOptions: process.env.NODE_OPTIONS ?? "",
    }));
    assertNoFakeAiEnv({
      ...Object.fromEntries(mainEnv.names.map((n) => [n, "1"])),
      ...(mainEnv.names.includes("RUST_LOG")
        ? { RUST_LOG: mainEnv.rustLog }
        : {}),
      ...(mainEnv.names.includes("NODE_OPTIONS")
        ? { NODE_OPTIONS: mainEnv.nodeOptions }
        : {}),
    });
    const rootPid = app.process().pid;
    // rootPid が取れなければ標本を採れないので、採取の失敗として数える（採取 0 回＝未確認で不採用）。
    const sampleOf = rootPid
      ? sampleEgress
      : () => {
          throw new Error("no root pid");
        };
    egressSampler = createEgressSampler({
      rootPid,
      policy: egressPolicy,
      sample: sampleOf,
    });
    sampler = setInterval(() => egressSampler.tick(), 250);
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
      workRoot,
      runRoot,
      keep,
      // 許可リスト以外の宛先の観測（標本は 250 ms ごと）。測定 B は cell の頭と各送信の直前に見て、あれば止める。
      // 送信の直前の観測：同期で 1 回 tick してから返す（直近の標本が古くならない）。違反が無いだけでなく、観測が成り立っている
      // 証拠（成功した標本・socket の数）も渡す（evaluateSendPreconditions が、無ければ止める。F3a の B1）。
      egressObservation: () => {
        egressSampler.tick();
        return egressSampler.observation();
      },
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
    // cell の後にも出所を照合する（cell の間に build 物・guard の file・入力が差し替わっていないか。F3a の m5）。
    // 例外にはせず、records に残す（realCellStatus が不採用にする）。
    let afterCell = null;
    try {
      afterCell = d.assertBuildProvenance({ root: d.root });
    } catch {
      // 照合できなければ不安定として扱う。
    }
    cell.buildProvenance = {
      ...cell.buildProvenance,
      stableAfterCell: sameBuildProvenance(afterCell, firstProvenance),
    };
    cell.aiRows = countAiRows(workspaceDir);
    clearInterval(sampler);
    sampler = undefined;
    egressSampler.tick();
    cell.egress = egressSampler.snapshot();
    cell.elapsedMs = Date.now() - started;
    // 初期値の "blocked" を書き換える。採用の可否（ok など）は呼び出し側が最終の status として書き戻す。
    cell.status = "completed";
    return { cell, value, scenesTexts: loaded.scenesTexts };
  } catch (error) {
    cell.status = "failed";
    cell.errors = [safeErrorSummary(error)];
    // 失敗した cell にも、そこまでの宛先の標本を残す（宛先が原因の失敗の宛先が記録から消えないように）。
    if (egressSampler) {
      egressSampler.tick();
      cell.egress = egressSampler.snapshot();
    }
    return { cell, value: null, scenesTexts: loaded.scenesTexts };
  } finally {
    if (sampler) clearInterval(sampler);
    if (app) await app.close().catch(() => undefined);
    if (!keep) finishCellCleanup(cell, { userData, workRoot });
    unregisterCleanup();
  }
}

export { ensurePrivateDir, writePrivateJson };
export function writeJson0600(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}
