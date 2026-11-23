/* global window */
// 同定の review の負荷の測定：作品ごとの 0 回目の目録と、空の名簿での構造抽出（試走 g）。
// AI は呼ばない。出力は件数・ID・hash・path だけ（assertOutputClean が文字列の欄と
// 原稿の shingle を検査する）。作品ごとに別の Electron process・別の workspace。
//
// 範囲：隔離は呼び出し側（dbus-run-session・Wayland 変数の除去・TMPDIR）と、この launcher の
// precheck（それらを検査して違えば止める）の両方で守る。外向き通信の遮断は Chromium の名前解決
// だけで、main の Node・N-API の通信と IP リテラルには効かない。代わりに子孫 process の
// 接続先（loopback 以外）を /proc から採取して記録する（250 ms 周期の標本で、短い接続は漏れうる）。
// 専用 channel（handleWithEnvelope）の IPC は観測の外。AI／外部の command を検知した run、
// AI の行の 0 件を確認できなかった run、loopback 以外の接続先が出た run の出力は採用しない
// （*.rejected.json に状態だけ書く）。
// 表記の hash は塩なしの sha256 の先頭 16 桁で、*.rows.json は repo 外の 0600 に置く。
// repo・records・PR には件数だけを書き、hash は載せない（scan-repo-diff.mjs が hash も走査する）。
//
// 起動例（隔離。unshare -n は使わない）:
//   env -u WAYLAND_DISPLAY -u WAYLAND_SOCKET -u XDG_SESSION_TYPE -u DBUS_SESSION_BUS_ADDRESS \
//     ELECTRON_OZONE_PLATFORM_HINT=x11 TMPDIR=<out>/tmp dbus-run-session -- \
//     node scripts/local-ci-xvfb.mjs node scripts/quality/identity-review-load/run-inventory.mjs \
//       --works m-ja-1,m-ja-2 [--mode inventory|extract-empty]
import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { clearInterval, setInterval, setTimeout } from "node:timers";
import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseIp } from "./egress-policy.mjs";
import { resolveWorkSource } from "./sources.mjs";
import {
  WORKS,
  assertOutputClean,
  findAiCommands,
  safeErrorSummary,
  scenesFromWork,
  scenesTextsForScan,
} from "./lib.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const DEFAULT_OUTPUT = "/home/grimodex/identity-review-load-2026-11";

function parseArgs(args) {
  const options = {
    works: Object.keys(WORKS).join(","),
    mode: "inventory",
    output: DEFAULT_OUTPUT,
    // 既定は作品ごとの所在（sources.mjs）。渡したときは dir/<key>.json（試験用）。
    "data-dir": "",
    // 製品の保存経路（Native への Run/ProposalSet の保存）も試す。既定では試さない：
    // 保存経路は narrative_extraction_claim_task（DENIED の plaintext-publication route）を呼ぶ。
    "persist-attempt": "false",
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

export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}
export function writePrivateJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Electron に渡す env。key・token を持ち込まない（API key に触らない）。XDG_RUNTIME_DIR は隔離 dir。 */
export function electronEnv(extra) {
  const keep = [
    "PATH",
    "HOME",
    "LANG",
    "DISPLAY",
    "XAUTHORITY",
    "TMPDIR",
    "ELECTRON_OZONE_PLATFORM_HINT",
  ];
  const env = {};
  for (const name of keep) if (process.env[name]) env[name] = process.env[name];
  return { ...env, ...extra };
}

/**
 * 起動前の検査（違えば [precheck] で止める）。隔離を呼び出し側の約束だけにしない。
 * - Wayland の変数が空、XDG_SESSION_TYPE が空か x11 であること（本物の bus・secret service に届かない）
 * - DBUS_SESSION_BUS_ADDRESS が login session の bus（/run/user）でないこと
 * - TMPDIR が出力 dir の下の 0700 であること
 * - sqlite3 が使えること（AI の行の 0 件の確認に要る）
 * - 出力先が短く、どの cell の userData の SingletonSocket も起動できる長さに収まること
 */
export const LONGEST_CELL_DIR_NAME = 20;
export const MAX_SOCKET_PATH_ESTIMATE = 95;
export function precheckEnvironment(output, env = process.env) {
  for (const name of ["WAYLAND_DISPLAY", "WAYLAND_SOCKET"]) {
    assert.ok(!env[name], `[precheck] ${name} must be unset`);
  }
  // local-ci-xvfb.mjs は子に XDG_SESSION_TYPE=x11 を渡す。wayland（login session）は拒む。
  assert.ok(
    !env.XDG_SESSION_TYPE || env.XDG_SESSION_TYPE === "x11",
    "[precheck] XDG_SESSION_TYPE must be unset or x11",
  );
  // launcher 自身が service activation の無い隔離 bus を起こして Electron に渡す。
  // 外側の bus が login session の bus（/run/user）なら、他の子が届かないよう止める。
  const bus = env.DBUS_SESSION_BUS_ADDRESS ?? "";
  assert.ok(
    !/\/run\/user\//u.test(bus),
    "[precheck] DBUS_SESSION_BUS_ADDRESS is a login session bus",
  );
  // Chromium の SingletonSocket（unix socket、sun_path 108）が userData の下に作られる。
  // 長い出力先では Electron が起動しない（Process failed to launch）ので、先に止める。
  // 2026-11-23 の試走：この式の長さが 95 の cell（A-g-ja-3-matrix-L2）は起動し、99 の cell
  // （A-g-ja-3-cumulative-L2）は起動しなかった。旧式は dir に cell の名前を使い、固定の 20 字・
  // 上限 100 で測っていたので、長い名前を拾えなかった。測定 A・B の cell の dir は launcher-common の cellDirName で
  // 16 字以下に固定し、目録の dir（`${mode}-${work}`）は最長 20 字。20 字で測り、上限は起動を確かめた 95。
  // 既定の出力先（DEFAULT_OUTPUT）では 90 になる（試験で固定）。
  const longest = path.join(
    path.resolve(output),
    "run",
    "x".repeat(LONGEST_CELL_DIR_NAME),
    "user-data",
    "SingletonSocket",
  );
  assert.ok(
    longest.length <= MAX_SOCKET_PATH_ESTIMATE,
    "[precheck] OUTPUT_PATH_TOO_LONG output dir path is too long for the userData socket",
  );
  const tmp = env.TMPDIR ?? "";
  assert.ok(tmp.length > 0, "[precheck] TMPDIR must be under the output dir");
  const rel = path.relative(path.resolve(output), path.resolve(tmp));
  assert.ok(
    rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel),
    "[precheck] TMPDIR must be under the output dir",
  );
  assert.ok(
    existsSync(tmp) && (statSync(tmp).mode & 0o077) === 0,
    "[precheck] TMPDIR must exist with mode 0700",
  );
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
  } catch {
    assert.fail("[precheck] sqlite3 is not available");
  }
}

/**
 * service activation の無い session bus を起こす（servicedir を持たない設定）。Electron の
 * portal 経由で secret service（keyring）が起動されないようにする。
 */
export async function startIsolatedBus(output) {
  const dir = path.join(output, "dbus");
  ensurePrivateDir(dir);
  const socket = path.join(dir, "bus");
  rmSync(socket, { force: true });
  const conf = path.join(dir, "isolated-session.conf");
  writeFileSync(
    conf,
    `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:path=${socket}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`,
    { mode: 0o600 },
  );
  const child = spawn("dbus-daemon", ["--config-file", conf, "--nofork"], {
    stdio: "ignore",
  });
  for (let i = 0; i < 50 && !existsSync(socket); i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(
    existsSync(socket),
    "[precheck] BUS_START_FAILED isolated bus did not start",
  );
  return {
    address: `unix:path=${socket}`,
    stop() {
      child.kill();
      rmSync(socket, { force: true });
    },
  };
}

/**
 * workspace の DB に AI の行が無いことを、読み取り専用で数える。fail-closed：
 * DB が 1 つ以上見つかり、ai_audit_events と ai_usage の両方が読めた場合だけ verified。
 */
export function countAiRows(workspaceDir) {
  const result = { verified: false, dbFileCount: 0, tables: {}, unreadable: 0 };
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
      } catch {
        result.unreadable++;
      }
    }
  }
  result.verified =
    result.dbFileCount >= 1 &&
    ["ai_audit_events", "ai_usage"].every(
      (table) => typeof result.tables[table] === "number",
    );
  return result;
}

// ---- 外向き接続の採取（宛先だけ。本文なし） ------------------------------------

export function parseHexAddress(hex, ipv6) {
  const [addr, port] = hex.split(":");
  const bytes = [];
  for (let i = 0; i < addr.length; i += 2) bytes.push(addr.slice(i, i + 2));
  if (!ipv6) {
    const ip = bytes
      .reverse()
      .map((b) => Number.parseInt(b, 16))
      .join(".");
    return { ip, port: Number.parseInt(port, 16) };
  }
  // IPv6：4 つの 32 bit word がそれぞれ little endian。
  const words = [];
  for (let w = 0; w < 4; w++) {
    const part = bytes.slice(w * 4, w * 4 + 4).reverse();
    words.push(part[0] + part[1], part[2] + part[3]);
  }
  return {
    ip: words.map((x) => x.replace(/^0+(?=.)/u, "")).join(":"),
    port: Number.parseInt(port, 16),
  };
}
/**
 * loopback（127.0.0.0/8・::1）か未指定（0.0.0.0・::）か。IP を解析して判定する（前方一致にしない：
 * 文字列の前方一致は ::ffff:0.127.x.x のような非 loopback を loopback に数える。F3a の m4）。
 * IPv4-mapped IPv6（::ffff:a.b.c.d）は IPv4 として見る（parseIp）。解析できなければ loopback としない（宛先として数える）。
 */
export function isLoopbackOrAny(ip) {
  const parsed = parseIp(ip);
  if (!parsed) return false;
  if (parsed.family === 4)
    return parsed.value === 0n || parsed.value >> 24n === 127n;
  return parsed.value === 0n || parsed.value === 1n;
}
function descendantPids(rootPid) {
  const children = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/u.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(Number(name));
    } catch {
      // process が消えた。
    }
  }
  const out = [rootPid];
  for (let i = 0; i < out.length; i++)
    out.push(...(children.get(out[i]) ?? []));
  return out;
}
/**
 * rootPid の子孫が持つ socket の、loopback 以外の接続先（"tcp ip:port" の形）を sample に足す。
 * 返り値：読めた /proc/net の表の数（tablesRead。0 なら採取が 1 度も成り立っていない）、子孫が持つ socket の数
 * （unix socket を含む）、子孫の fd の inode が /proc/net/tcp・tcp6 の行に一致した socket の数（tcpSocketCount）。
 * tcpSocketCount は LISTEN・loopback も数える（除く前に数える）。「子孫の fd と TCP の表を突き合わせられている」証拠で、
 * Electron の inspector の LISTEN や Vite への loopback 接続も含む（F5 の m-c。unix socket だけでは TCP が見えている証拠にならない）。
 */
export function sampleEgress(rootPid, destinations) {
  const inodes = new Set();
  for (const pid of descendantPids(rootPid)) {
    try {
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        const link = readlinkSync(`/proc/${pid}/fd/${fd}`);
        const m = /^socket:\[(\d+)\]$/u.exec(link);
        if (m) inodes.add(m[1]);
      }
    } catch {
      // 読めない・消えた。
    }
  }
  let tablesRead = 0;
  const tcpInodes = new Set();
  for (const [proto, ipv6] of [
    ["tcp", false],
    ["tcp6", true],
    ["udp", false],
    ["udp6", true],
  ]) {
    let table;
    try {
      table = readFileSync(`/proc/net/${proto}`, "utf8");
      tablesRead++;
    } catch {
      continue;
    }
    for (const line of table.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/u);
      if (cols.length < 10 || !inodes.has(cols[9])) continue;
      if (proto.startsWith("tcp")) tcpInodes.add(cols[9]); // LISTEN・loopback も数える（下で除く前）
      if (proto.startsWith("tcp") && cols[3] === "0A") continue; // LISTEN
      const remote = parseHexAddress(cols[2], ipv6);
      if (remote.port === 0 || isLoopbackOrAny(remote.ip)) continue;
      destinations.add(`${proto.replace("6", "")} ${remote.ip}:${remote.port}`);
    }
  }
  return {
    tablesRead,
    socketCount: inodes.size,
    tcpSocketCount: tcpInodes.size,
  };
}

/**
 * 測定した製品の版（git の HEAD、取り込んだ origin/master の commit、製品の source
 * [src・electron・src-tauri] の未 commit の変更の数）。ID だけで、本文は含まない。
 */
export function productVersion() {
  const git = (args) =>
    execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  const head = git(["rev-parse", "HEAD"]);
  let master = "unknown";
  try {
    master = git(["rev-parse", "refs/remotes/origin/master"]);
  } catch {
    // origin/master が無い。
  }
  const dirty = git([
    "status",
    "--porcelain",
    "--",
    "src",
    "electron",
    "src-tauri",
  ])
    .split("\n")
    .filter(Boolean).length;
  return { head, originMaster: master, productSourceDirtyFiles: dirty };
}

function outputDir(output, mode) {
  return path.join(
    output,
    mode === "inventory" ? "inventory" : "extract-empty",
  );
}

/** 失敗・不採用の状態だけを書く。自由文は載せず、エラーは名前・印・code だけ。 */
function minimalResult(base, errors) {
  return {
    schemaVersion: base.schemaVersion,
    mode: base.mode,
    work: base.work,
    status: base.status,
    errors,
  };
}

async function runWork(workKey, options, vite, busAddress) {
  const output = path.resolve(options.output);
  const workRoot = path.join(output, "run", `${options.mode}-${workKey}`);
  rmSync(workRoot, { recursive: true, force: true });
  const userData = path.join(workRoot, "user-data");
  const workspaceDir = path.join(workRoot, "workspace");
  const tmpDir = path.join(workRoot, "tmp");
  const xdgDir = path.join(workRoot, "xdg");
  for (const dir of [workRoot, userData, workspaceDir, tmpDir, xdgDir])
    ensurePrivateDir(dir);
  const dir = outputDir(output, options.mode);
  ensurePrivateDir(dir);
  // 前の run の採用済みの出力を残さない（不採用の run が古い値を残さないように）。
  for (const name of [
    `${workKey}.json`,
    `${workKey}.rows.json`,
    `${workKey}.rejected.json`,
    `${workKey}.failed.json`,
  ])
    rmSync(path.join(dir, name), { force: true });

  const result = {
    schemaVersion: "identity-load-inventory/3",
    mode: options.mode,
    work: workKey,
    status: "blocked",
    errors: [],
    product: productVersion(),
  };
  let scenesTexts = [];
  let app;
  let sampler;
  const destinations = new Set();
  let sampleCount = 0;
  const started = Date.now();
  try {
    const work = JSON.parse(
      readFileSync(
        resolveWorkSource(workKey, options["data-dir"] || null),
        "utf8",
      ),
    );
    const scenes = scenesFromWork(work);
    assert.equal(
      scenes.length,
      WORKS[workKey],
      `[precheck] SCENE_COUNT_DIFFERS scene count differs from registered`,
    );
    scenesTexts = scenesTextsForScan(scenes);

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
    app = await _electron.launch({
      executablePath: require("electron"),
      // 外向きの名前解決を止める（Chromium だけ。main の Node・N-API・IP リテラルには効かない）。
      // password-store=basic：secret service・keyring に触れない。
      args: [
        "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
        "--password-store=basic",
        observer,
      ],
      cwd: ROOT,
      env: electronEnv({
        ELECTRON_RENDERER_URL: rendererUrl,
        GRIMODEX_USER_DATA_DIR: userData,
        GRIMODEX_NODE_PATH: native,
        GRIMODEX_NIR1_PRODUCTION_MAIN: main,
        TMPDIR: tmpDir,
        XDG_RUNTIME_DIR: xdgDir,
        DBUS_SESSION_BUS_ADDRESS: busAddress,
      }),
      timeout: 60000,
    });
    const rootPid = app.process().pid;
    sampler = setInterval(() => {
      try {
        sampleCount++;
        if (rootPid) sampleEgress(rootPid, destinations);
      } catch {
        // 標本の失敗は run を止めない（sampleCount と宛先の有無で判断する）。
      }
    }, 250);
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
      "[artifact] PERSISTED_TEXT_MISMATCH persisted text differs from scenes JSON",
    );
    for (const check of Object.values(result.build.folderChecks))
      assert.ok(
        check.derivedMatches && check.storeMatches,
        `[artifact] FOLDER_SCOPE_MISMATCH folder scope mismatch`,
      );

    let rows;
    let surfaces = null;
    if (options.mode === "inventory") {
      const inventory = await page.evaluate(() =>
        window.identityLoad.inventory({ folderPercent: 100 }),
      );
      assert.equal(
        inventory.canonicalText?.mismatched,
        0,
        "[artifact] CANONICAL_TEXT_MISMATCH snapshot canonical text differs from scenes JSON",
      );
      assert.equal(
        inventory.canonicalText?.missingScenes,
        0,
        "[artifact] SNAPSHOT_SCENES_MISSING snapshot lacks scenes",
      );
      rows = {
        seedRows: inventory.seedRows,
        candidateRows: inventory.candidateRows,
        rubyRows: inventory.rubyRows,
      };
      surfaces = inventory.surfaces;
      result.inventory = { ...inventory };
      delete result.inventory.seedRows;
      delete result.inventory.candidateRows;
      delete result.inventory.rubyRows;
      delete result.inventory.surfaces;
    } else {
      // 空の名簿（Entry 0 件）で構造抽出。F100 に対して 1 回。
      // まず製品の経路（Native へ保存する）。失敗したら理由の code だけ記録し、live の projection
      // だけを保存なし（製品の skipNativePersist の seam）で読む。
      let persisted;
      if (options["persist-attempt"] !== "true") {
        result.persistAttempt = { status: "not-attempted" };
      } else {
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
            ...safeErrorSummary(error),
          };
        }
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

    // --persist-attempt true のときだけ、保存経路が呼ぶ command を不採用の理由にしない（別に記録する）。
    const persistAllowed =
      options["persist-attempt"] === "true"
        ? ["narrative_extraction_claim_task"]
        : [];
    const ipc = await app.evaluate(() => globalThis.nir1IpcTrace.calls);
    const names = ipc.map((call) => call.command);
    result.ipc = {
      callCount: ipc.length,
      distinctCommandCount: new Set(names).size,
      failedCallCount: ipc.filter((call) => call.completed && !call.ok).length,
      aiCommands: findAiCommands(names).filter(
        (name) => !persistAllowed.includes(name),
      ),
      allowedExternalCommands: findAiCommands(names).filter((name) =>
        persistAllowed.includes(name),
      ),
      commandNames: [...new Set(names)].sort(),
    };
    result.aiRows = countAiRows(workspaceDir);
    clearInterval(sampler);
    sampler = undefined;
    sampleEgress(rootPid, destinations);
    result.egress = {
      sampleCount,
      nonLoopbackDestinationCount: destinations.size,
      nonLoopbackDestinations: [...destinations].sort(),
      scope: [
        "chromium-resolver-block-only",
        "sampled-250ms-tcp-udp",
        "dedicated-ipc-channels-unobserved",
      ],
    };
    result.elapsedMs = Date.now() - started;
    const extractVerified =
      options.mode === "inventory" ||
      (result.extractEmpty.observed?.prepass?.status === "complete" &&
        result.extractEmpty.entityProposalCount > 0);
    if (result.ipc.aiCommands.length > 0) result.status = "ai-detected";
    else if (!result.aiRows.verified) result.status = "ai-unverified";
    else if (Object.values(result.aiRows.tables).some((n) => n !== 0))
      result.status = "ai-detected";
    else if (destinations.size > 0) result.status = "egress-detected";
    else if (result.egress.sampleCount === 0)
      result.status = "egress-unverified";
    else if (!extractVerified) result.status = "extract-unverified";
    else result.status = "ok";

    // 書く前に混入を検査する（失敗時は件数だけの Error）。
    assertOutputClean(result, scenesTexts);
    assertOutputClean(rows, scenesTexts);
    if (result.status === "ok") {
      writePrivateJson(path.join(dir, `${workKey}.json`), result);
      writePrivateJson(path.join(dir, `${workKey}.rows.json`), rows);
      if (surfaces) {
        // 走査用（scan-repo-diff.mjs）。repo 外の 0600 の file にだけ置く。検査対象の出力には入れない。
        const surfaceDir = path.join(output, "surfaces");
        ensurePrivateDir(surfaceDir);
        writePrivateJson(path.join(surfaceDir, `${workKey}.json`), surfaces);
      }
    } else {
      // 不採用：状態の要約だけ。rows は書かない。
      writePrivateJson(
        path.join(dir, `${workKey}.rejected.json`),
        minimalResult(result, [
          {
            name: "RunRejected",
            tag: "none",
            codes: [],
            aiCommands: result.ipc.aiCommands,
            destinationCount: destinations.size,
          },
        ]),
      );
    }
  } catch (error) {
    // 自由文は載せない。名前・印・code だけの新しい object に置き換えて書く
    // （成功経路の result の欄は、混入検査に通っていても残さない）。
    result.status = "failed";
    const failed = minimalResult(result, [safeErrorSummary(error)]);
    try {
      assertOutputClean(failed, scenesTexts);
      writePrivateJson(path.join(dir, `${workKey}.failed.json`), failed);
    } catch {
      writePrivateJson(
        path.join(dir, `${workKey}.failed.json`),
        minimalResult(result, [
          { name: "Error", tag: "none", codes: ["OUTPUT_WITHHELD"] },
        ]),
      );
    }
    result.errors = failed.errors;
  } finally {
    if (sampler) clearInterval(sampler);
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
  precheckEnvironment(output);
  ensurePrivateDir(path.join(output, "vite-cache"));
  const bus = await startIsolatedBus(output);
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
      const result = await runWork(workKey, options, vite, bus.address);
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
    bus.stop();
  }
  if (summary.some((s) => s.status !== "ok")) process.exitCode = 1;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    await main();
  } catch (error) {
    // stdout・stderr には、名前・印・code だけの固定形式を出す（例外の自由文は出さない）。
    console.log(
      JSON.stringify({ status: "launcher-failed", ...safeErrorSummary(error) }),
    );
    process.exitCode = 1;
  }
}
