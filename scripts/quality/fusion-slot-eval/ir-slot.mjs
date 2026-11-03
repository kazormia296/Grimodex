/* global window */
// 融合の枠の評価（段階 2）：PD の原稿の IR をクラウド LLM（OpenRouter）で作り、IR が共通の
// 1 枠を使う割合と、Raw が満杯で枠が閉じていたときの IR 候補の有無を測る launcher と driver。
//
// 段階 1 の `raw-fullness.mjs`（受領書の確認、model の配置、隔離した profile、Vite の
// renderer、Electron の起動）を写して変えた（既存の file は変えない）。違いは次のとおり。
// - 偽の AI の env（GRIMODEX_PRODUCT_JOURNEY_FAKE_AI）は立てない。node 側と main 側の両方で
//   立っていないことを assert する（harness は使わない）。
// - key の経路はデスクトップの keyring：製品の save_api_key（safeStorage）をそのまま使う。
//   起動の外側で DBUS_SESSION_BUS_ADDRESS だけを残す（他の隔離は段階 1 と同じ）。key は
//   repo の外の file から node が読み、形式は接頭辞と長さだけを確かめ、値は表示・記録しない。
//   keyring の項目は秘密以外の property（Attributes／Label／Created／Modified）の digest を
//   起動の前・key の保存の後・終了の後で比べ、既存の項目が変わったら抽出に進まない。
// - 1 つの project に読書順で Scene を足し、地点（25/50/75/100％）ごとに、足した Scene を
//   1 件ずつ抽出し、全提案を非 secret の child にして承認し、IR が使えるまで待って測る。
//   前の地点で probe が admitted にした Scene が、Scene を足した後も残るかを確かめる
//   （計画 §2.5。残らなければ地点ごとに別 project が要る）。
// - 記録は件数・分類・不透明 ID・位置・usage（token 数）だけ。全記録に not-cp4-evidence。
//
// 使い方（隔離は段階 1 と同じく scripts/local-ci-xvfb.mjs の下で。DBUS だけ残す）:
//   env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE -u WAYLAND_SOCKET -u HTTP_PROXY ... \
//     ELECTRON_OZONE_PLATFORM_HINT=x11 TMPDIR=/tmp/gr5 \
//     node scripts/local-ci-xvfb.mjs node scripts/quality/fusion-slot-eval/ir-slot.mjs \
//       --scenes <scenes/<key>.json> --output <runs-ir/ の下の新しい dir> \
//       --build-receipt <receipt> --ja-model <onnx> --en-model <onnx> \
//       [--stop-after key|first-scene|all] [--repeats 3]
//
// 抽出をしない mode（--skip-extraction yes）：LLM に送らず、key も keyring も使わない
// （起動の外側で DBUS_SESSION_BUS_ADDRESS も除く）。承認 0 のまま Scene を入れ、
// buildRaw → waitIrUsable → sampleHybrid → probe → 分類 → 集計の測定側の経路だけを通す。
// 地点は --checkpoints（例 "1" や "0.25,0.5,0.75,1"。既定は全地点）で選ぶ。
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertOutsideRepo } from "./pd-corpus.mjs";
import {
  CHECKPOINTS,
  EVIDENCE_SCOPE,
  assertRunnable,
  checkpointSceneCount,
  opaqueWorkId,
  queryPositions,
} from "./raw-fullness.mjs";
import { compareAdmitted, summarizeQueries } from "./ir-classify.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const PROVIDER = "openrouter";
export const MODEL = "openai/gpt-5.6-luna";
const SCENE_TIMEOUT_MS = 15 * 60 * 1000;
const IR_WAIT_MS = 5 * 60 * 1000;
// 費用の外挿に使う単価（推測）。計画 §4 が先行の calibration helper から引いた値で、
// この model の OpenRouter の現行の単価を確かめたものではない。
export const PRICE_ASSUMPTION = Object.freeze({
  inputUsdPerMillion: 0.25,
  outputUsdPerMillion: 1.5,
  source: "計画 §4 の calibration helper の値（推測。現行の単価は未確認）",
});
const DEFAULT_KEY_FILE = path.join(
  os.homedir(),
  ".config/grimodex-eval/openrouter.key",
);

function parseArgs(args) {
  const options = {
    "key-file": DEFAULT_KEY_FILE,
    "stop-after": "all",
    repeats: "3",
    "skip-extraction": "no",
    checkpoints: "all",
  };
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(
      args[i].startsWith("--") && args[i + 1],
      "--name value の形で渡す",
    );
    options[args[i].slice(2)] = args[i + 1];
  }
  assert.ok(
    ["yes", "no"].includes(options["skip-extraction"]),
    "[precheck] --skip-extraction は yes／no",
  );
  options.skipExtraction = options["skip-extraction"] === "yes";
  options.checkpointList =
    options.checkpoints === "all"
      ? CHECKPOINTS
      : options.checkpoints.split(",").map(Number);
  assert.ok(
    options.checkpointList.length > 0 &&
      options.checkpointList.every((f) => CHECKPOINTS.includes(f)),
    "[precheck] --checkpoints は 0.25／0.5／0.75／1 の部分集合",
  );
  options.irWaitMs = Number(options["ir-wait-ms"] ?? IR_WAIT_MS);
  assert.ok(Number.isInteger(options.irWaitMs) && options.irWaitMs > 0);
  for (const name of [
    "scenes",
    "output",
    "build-receipt",
    "ja-model",
    "en-model",
    "key-file",
  ])
    assert.ok(
      options[name] && path.isAbsolute(options[name]),
      `[precheck] --${name} は絶対 path`,
    );
  assert.ok(
    ["key", "first-scene", "all"].includes(options["stop-after"]),
    "[precheck] --stop-after は key／first-scene／all",
  );
  options.repeats = Number(options.repeats);
  assert.ok(Number.isInteger(options.repeats) && options.repeats >= 1);
  return options;
}

/**
 * 起動の環境：偽 AI なし、Xvfb の display、Wayland・proxy なし。keyring の D-Bus は、key を
 * 入れる mode では要り、抽出をしない mode では無いこと（keyring に触れない）を確かめる。
 */
export function assertLaunchEnvironment(env, { keyring = true } = {}) {
  assert.equal(
    env.GRIMODEX_PRODUCT_JOURNEY_FAKE_AI,
    undefined,
    "[precheck] 偽の AI の env が立っている",
  );
  assert.equal(
    env.GRIMODEX_LOCAL_CI_XVFB,
    "1",
    "[precheck] local-ci-xvfb の下で走らせる",
  );
  assert.ok(
    env.DISPLAY && !["", ":0", ":1"].includes(env.DISPLAY),
    "[precheck] ユーザーの display を使わない",
  );
  for (const name of [
    "WAYLAND_DISPLAY",
    "WAYLAND_SOCKET",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ])
    assert.equal(env[name], undefined, `[precheck] ${name} を除いて起動する`);
  assert.equal(
    env.ELECTRON_OZONE_PLATFORM_HINT,
    "x11",
    "[precheck] ozone は x11",
  );
  if (keyring)
    assert.ok(
      env.DBUS_SESSION_BUS_ADDRESS,
      "[precheck] keyring の経路にデスクトップの DBUS_SESSION_BUS_ADDRESS が要る",
    );
  else
    assert.equal(
      env.DBUS_SESSION_BUS_ADDRESS,
      undefined,
      "[precheck] 抽出をしない mode では DBUS_SESSION_BUS_ADDRESS を除いて起動する",
    );
}

/** key を読む。形式は接頭辞と長さだけを確かめる。値・長さの数字は返さない。 */
export async function readOpenRouterKey(file) {
  const info = await stat(file);
  assert.equal(info.mode & 0o077, 0, "[precheck] key の file の権限は 600");
  const key = (await readFile(file, "utf8")).trim();
  assert.ok(
    key.startsWith("sk-or-") &&
      key.length >= 40 &&
      key.length <= 200 &&
      !/\s/u.test(key),
    "[precheck] key の形式（接頭辞と長さ）が想定と違う",
  );
  return key;
}

const gdbus = (args) =>
  execFileSync(
    "gdbus",
    ["call", "--session", "--dest", "org.freedesktop.secrets", ...args],
    {
      encoding: "utf8",
      timeout: 10000,
    },
  );

/**
 * keyring の全項目の、秘密以外の property（GetAll：Attributes／Label／Created／Modified／
 * Locked）の digest。秘密の値は読まない。返すのは path → digest と、application 属性だけ。
 */
export function keyringSnapshot() {
  const collections =
    gdbus([
      "--object-path",
      "/org/freedesktop/secrets",
      "--method",
      "org.freedesktop.DBus.Properties.Get",
      "org.freedesktop.Secret.Service",
      "Collections",
    ]).match(/\/org\/freedesktop\/secrets\/collection\/[A-Za-z0-9_]+/gu) ?? [];
  const items = new Map();
  for (const collection of new Set(collections)) {
    const paths =
      gdbus([
        "--object-path",
        collection,
        "--method",
        "org.freedesktop.DBus.Properties.Get",
        "org.freedesktop.Secret.Collection",
        "Items",
      ]).match(new RegExp(`${collection}/[0-9A-Za-z_]+`, "gu")) ?? [];
    for (const item of new Set(paths)) {
      const all = gdbus([
        "--object-path",
        item,
        "--method",
        "org.freedesktop.DBus.Properties.GetAll",
        "org.freedesktop.Secret.Item",
      ]);
      items.set(item, {
        digest: sha256(all),
        application: all.match(/'application': '([^']*)'/u)?.[1] ?? null,
      });
    }
  }
  return items;
}

/** 2 つの snapshot の差。既存の項目の情報は件数だけ、新しい項目は application だけを出す。 */
export function keyringDiff(before, after) {
  let changed = 0;
  let removed = 0;
  for (const [item, value] of before) {
    const now = after.get(item);
    if (!now) removed++;
    else if (now.digest !== value.digest) changed++;
  }
  const added = [...after]
    .filter(([item]) => !before.has(item))
    .map(([, value]) => ({ application: value.application }));
  return { before: before.size, after: after.size, changed, removed, added };
}

async function artifactIdentity(file) {
  const bytes = await readFile(file);
  return { path: file, sha256: sha256(bytes), bytes: (await stat(file)).size };
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

// 段階 1 の raw-fullness.mjs の verifyBuild を写した（export されていないため）。
async function verifyBuild(receiptPath) {
  const identity = await artifactIdentity(receiptPath);
  const built = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(built.status, "passed", "[precheck] build receipt status");
  assert.equal(built.standardBuild, true, "[precheck] standard build");
  assert.equal(built.schemaVersion, "nir1-standard-build/1");
  assert.equal(built.sourceUnchanged, true, "[precheck] source identity");
  const artifacts = {};
  for (const file of [
    "dist-electron/main.cjs",
    "dist-electron/preload.cjs",
    "electron/native/grimodex-node/grimodex-node.node",
  ]) {
    const current = await artifactIdentity(path.join(ROOT, file));
    assert.equal(
      built.artifacts[file],
      current.sha256,
      `[precheck] standard build artifact changed: ${file}`,
    );
    artifacts[file] = current.sha256;
  }
  const manifest = JSON.parse(await readFile(built.sourceManifest, "utf8"));
  assert.equal(
    sha256(await readFile(built.sourceManifest)),
    built.sourceManifestSha256,
  );
  const changed = [];
  for (const [file, digest] of Object.entries(manifest)) {
    const current = await readFile(path.join(ROOT, file)).catch(() => null);
    if (!current || sha256(current) !== digest) changed.push(file);
  }
  assert.deepEqual(changed, [], "[precheck] build 後に source が変わった");
  return {
    receipt: identity,
    builtHead: built.candidate?.resolvedHeadSha ?? null,
    artifacts,
  };
}

// 段階 1 の raw-fullness.mjs の placeModels を写した（export されていないため）。
async function placeModels(userData, options) {
  const manifest = JSON.parse(
    await readFile(
      path.join(ROOT, "evals/nir1-retrieval/manifest.json"),
      "utf8",
    ),
  );
  const models = {};
  for (const language of ["ja", "en"]) {
    const spec = manifest.models[language];
    const modelFile = options[`${language}-model`];
    const tokenizerFile = path.join(
      ROOT,
      "src-tauri/resources/semantic",
      spec.directory,
      "tokenizer.json",
    );
    const modelSha = sha256(await readFile(modelFile));
    assert.equal(modelSha, spec.artifactSha256, `[precheck] ${language} model`);
    assert.equal(
      sha256(await readFile(tokenizerFile)),
      spec.tokenizerSha256,
      `[precheck] ${language} tokenizer`,
    );
    const destination = path.join(userData, "models", spec.directory);
    await mkdir(destination, { recursive: true });
    await cp(modelFile, path.join(destination, "model_int8.onnx"));
    await cp(tokenizerFile, path.join(destination, "tokenizer.json"));
    await writeFile(path.join(destination, "model_int8.onnx.sha256"), modelSha);
    models[language] = { modelId: spec.modelId, modelSha256: modelSha };
  }
  return models;
}

/** profile の中身（相対 path と大きさだけ）。消す前に確かめるため。 */
async function listTree(directory, prefix = "") {
  const entries = [];
  for (const entry of await readdir(path.join(directory, prefix), {
    withFileTypes: true,
  })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory())
      entries.push(...(await listTree(directory, relative)));
    else
      entries.push({
        path: relative,
        bytes: (await stat(path.join(directory, relative))).size,
      });
  }
  return entries;
}

const withTimeout = (promise, ms, label) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`[timeout] ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

/** 測定：各 query 位置で hybrid を repeats 回、その後に probe を 1 回。 */
async function measurePositions(page, positions, repeats) {
  const queries = [];
  for (const position of positions) {
    const samples = [];
    for (let r = 0; r < repeats; r++)
      samples.push(
        await page.evaluate(
          (p) => window.fusionIrEvaluation.sampleHybrid(p),
          position,
        ),
      );
    const probe = await page
      .evaluate((p) => window.fusionIrEvaluation.probe(p), position)
      .catch(() => ({
        status: "probe-failed",
        reason: null,
        admittedPositions: [],
      }));
    queries.push({ evidenceScope: EVIDENCE_SCOPE, position, samples, probe });
  }
  return queries;
}

/** 抽出の集計：Scene ごとの提案の件数の分布、承認、失敗、時間。件数だけ。 */
export function summarizeExtraction(extraction) {
  const distribution = {};
  for (const e of extraction)
    if (e.status === "completed")
      distribution[e.proposalCount] = (distribution[e.proposalCount] ?? 0) + 1;
  const durations = extraction
    .map((e) => e.durationMs)
    .filter((d) => typeof d === "number");
  const proposals = extraction.flatMap((e) => e.proposals ?? []);
  return {
    scenes: extraction.length,
    completed: extraction.filter((e) => e.status === "completed").length,
    failed: extraction.filter((e) => e.status !== "completed").length,
    failureCodes: extraction.filter((e) => e.errorCode).map((e) => e.errorCode),
    proposalCountDistribution: distribution,
    proposals: proposals.length,
    approved: proposals.filter((p) => p.approved).length,
    proposalErrors: proposals.filter((p) => p.error).map((p) => p.error),
    secretBefore: proposals.filter((p) => p.secretBefore === true).length,
    durationMs: {
      total: durations.reduce((a, b) => a + b, 0),
      max: durations.length ? Math.max(...durations) : null,
    },
  };
}

const probeMap = async (page, positions) => {
  const map = new Map();
  for (const position of positions) {
    const probe = await page
      .evaluate((p) => window.fusionIrEvaluation.probe(p), position)
      .catch(() => null);
    if (probe?.status === "available")
      map.set(
        position,
        probe.admittedPositions.filter((p) => p > 0 && p < position),
      );
  }
  return map;
};

export async function runIrSlot(options) {
  const startedAt = Date.now();
  const output = path.resolve(options.output);
  assertOutsideRepo(output);
  assertOutsideRepo(options.scenes);
  assertOutsideRepo(options["key-file"]);
  assert.ok(!(await exists(output)), `[precheck] 出力先が既にある: ${output}`);
  const scenesBytes = await readFile(options.scenes);
  const work = JSON.parse(scenesBytes.toString("utf8"));
  assert.equal(work.schemaVersion, "fusion-slot-pd-scenes/1");
  // 本番の作品は、下書きでない事前登録とその sha256 が揃うときだけ（段階 1 と同じ gate）。
  const gate = await assertRunnable(work.role, options);
  const skip = options.skipExtraction;
  assertLaunchEnvironment(process.env, { keyring: !skip });
  await mkdir(output, { recursive: true });
  const salt = randomBytes(32).toString("hex");
  await writeFile(path.join(output, "salt.private"), `${salt}\n`, {
    mode: 0o600,
  });
  const records = {
    schemaVersion: "fusion-slot-ir/1",
    evidenceScope: EVIDENCE_SCOPE,
    status: "blocked",
    runId: path.basename(output),
    startedAt: new Date(startedAt).toISOString(),
    role: work.role,
    preregistration: gate.preregistration,
    opaqueWorkId: opaqueWorkId(salt, work.key),
    language: work.language,
    sceneCount: work.scenes.length,
    scenesFileSha256: sha256(scenesBytes),
    stopAfter: options["stop-after"],
    skipExtraction: skip,
    checkpointList: options.checkpointList,
    ai: {
      provider: PROVIDER,
      model: MODEL,
      reasoning:
        "製品の抽出の経路から reasoning を指定できないので、OpenRouter／model の既定のまま",
      keyRoute:
        "デスクトップの keyring：製品の save_api_key（Electron safeStorage）。key は repo の外の file から node が読み、値は記録しない",
    },
    design: {
      condition:
        "IR が最大に出る条件の下での枠の使用率：harness が全提案を reviseChronicleProposal({secret:false}) で child にし、child を承認する（製品の既定では secret のまま承認すると IR に出ない）",
      checkpoints: CHECKPOINTS,
      checkpointSceneCount: "ceil(fraction × N)、2 以上（段階 1 と同じ）",
      queryRule: "地点の末尾から最大 10 件。位置 2 以上（段階 1 と同じ）",
      checkpointConstruction:
        "1 つの project に読書順で Scene を足す（Scene ごとに folder、1 件ずつ抽出）。前の地点の probe の admitted が、足した後も残るかを地点ごとに確かめる",
      repeats: options.repeats,
      fetch:
        "fetchRelatedPastScenes(sceneId, {mode:'hybrid'}) を repeats 回。分類は completion.outcome（計画 §3）",
      probe:
        "release の後に別 operation で begin→continue（deadline なし）→release。query は buildSemanticRecallQuery。continue の列は floor・Scene ごとの最大・上限 8 件を通った後のもので、floor 前の候補は見えない",
      graph: "測定中は Graph を呼ばない（graphSeedEntityId を渡さない）",
      codex:
        "評価の project に Codex は無い。日本語の sparse query は Codex の言及に依存するので、Raw は製品より細く、枠が開きやすく出る可能性がある",
    },
    errors: [],
    keyring: null,
    extraction: [],
    checkpoints: [],
    checkpointConstruction: [],
  };
  let app;
  let vite;
  let key = null;
  const userData = path.join(output, "user-data");
  const writeProgress = () =>
    writeFile(
      path.join(output, "records.in-progress.json"),
      JSON.stringify(records, null, 2) + "\n",
    );
  const log = (line) =>
    process.stdout.write(`[${new Date().toISOString()}] ${line}\n`);
  let keyringBefore = null;
  try {
    records.candidate = {
      head: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: ROOT,
        encoding: "utf8",
      }).trim(),
      statusClean:
        execFileSync("git", ["status", "--porcelain=v1"], {
          cwd: ROOT,
          encoding: "utf8",
        }) === "",
    };
    records.build = await verifyBuild(path.resolve(options["build-receipt"]));
    records.harness = Object.fromEntries(
      await Promise.all(
        [
          ["driver", import.meta.filename],
          ["classify", path.join(import.meta.dirname, "ir-classify.mjs")],
          ["renderer", path.join(import.meta.dirname, "ir-renderer.ts")],
          ["rendererHtml", path.join(import.meta.dirname, "ir-renderer.html")],
          [
            "observer",
            path.join(
              ROOT,
              "scripts/quality/nir1-retrieval/electron-observer.mjs",
            ),
          ],
        ].map(async ([name, file]) => [
          name,
          (await artifactIdentity(file)).sha256,
        ]),
      ),
    );
    if (!skip) {
      key = await readOpenRouterKey(options["key-file"]);
      keyringBefore = keyringSnapshot();
    }
    await mkdir(userData, { recursive: true });
    records.models = await placeModels(userData, options);
    // この評価用の profile は、ユーザーの旧 keyring の key を取り込まない。
    await writeFile(
      path.join(userData, "legacy-keyring-migration-v1.json"),
      JSON.stringify({
        version: 1,
        completedAt: new Date().toISOString(),
        imported: 0,
        skippedExisting: 0,
        fixtureOnly: true,
      }),
    );
    await writeFile(
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
    );
    const { createServer } = await import("vite");
    vite = await createServer({
      root: ROOT,
      cacheDir: path.join(output, "vite-cache"),
      server: { host: "127.0.0.1", port: 0, strictPort: false, open: false },
      clearScreen: false,
      logLevel: "warn",
    });
    await vite.listen();
    const address = vite.httpServer.address();
    assert.ok(address && typeof address !== "string");
    const rendererUrl = `http://127.0.0.1:${address.port}/scripts/quality/fusion-slot-eval/ir-renderer.html`;
    const { _electron } = await import("playwright");
    const env = {
      ...process.env,
      ELECTRON_RENDERER_URL: rendererUrl,
      GRIMODEX_USER_DATA_DIR: userData,
      GRIMODEX_NODE_PATH: path.join(
        ROOT,
        "electron/native/grimodex-node/grimodex-node.node",
      ),
      GRIMODEX_NIR1_PRODUCTION_MAIN: path.join(ROOT, "dist-electron/main.cjs"),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    assertLaunchEnvironment(env, { keyring: !skip });
    app = await _electron.launch({
      executablePath: require("electron"),
      args: [
        path.join(ROOT, "scripts/quality/nir1-retrieval/electron-observer.mjs"),
      ],
      cwd: ROOT,
      env,
      timeout: 60000,
    });
    const page = await app.firstWindow();
    await page.waitForFunction(
      () => window.fusionIrEvaluation?.ready === true,
      null,
      {
        timeout: 120000,
      },
    );
    const mainEnv = await app.evaluate(({ safeStorage }) => ({
      fakeAi: process.env.GRIMODEX_PRODUCT_JOURNEY_FAKE_AI ?? null,
      electron: process.versions.electron,
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      backend: safeStorage.getSelectedStorageBackend(),
    }));
    assert.equal(
      mainEnv.fakeAi,
      null,
      "[precheck] main に偽の AI の env が立っている",
    );
    records.electronVersion = mainEnv.electron;
    records.safeStorage = {
      encryptionAvailable: mainEnv.encryptionAvailable,
      backend: mainEnv.backend,
    };
    log(
      `safeStorage backend=${mainEnv.backend} available=${mainEnv.encryptionAvailable}`,
    );
    if (!skip)
      assert.ok(
        mainEnv.encryptionAvailable &&
          !["basic_text", "unknown"].includes(mainEnv.backend),
        "[key] safeStorage の backend が keyring でない（key の経路が動かない）",
      );
    await page.evaluate((input) => window.fusionIrEvaluation.prepare(input), {
      workspacePath: path.join(output, "workspaces", "ir"),
      projectId: "fusion-ir",
      language: work.language,
    });
    if (!skip) {
      records.aiSettings = await page.evaluate(
        (input) => window.fusionIrEvaluation.configureAi(input),
        { provider: PROVIDER, model: MODEL },
      );
      assert.equal(records.aiSettings.provider, PROVIDER);
      assert.equal(records.aiSettings.model, MODEL);
      records.keyInstall = await page
        .evaluate((value) => window.fusionIrEvaluation.installKey(value), key)
        .catch((error) => {
          // Playwright の error に引数は入らないが、念のため message の先頭の code だけを残す。
          const message = String(error?.message ?? error);
          throw new Error(
            message.match(/\[key\][^\n]*/u)?.[0] ?? "[key] installKey failed",
          );
        });
      key = null;
      assert.equal(
        records.keyInstall.present,
        true,
        "[key] has_api_key が false",
      );
      records.keyring = {
        afterKeySave: keyringDiff(keyringBefore, keyringSnapshot()),
      };
      log(
        `keyring after key save: ${JSON.stringify(records.keyring.afterKeySave)}`,
      );
      assert.equal(
        records.keyring.afterKeySave.changed +
          records.keyring.afterKeySave.removed,
        0,
        "[key] keyring の既存の項目が変わった（抽出に進まない）",
      );
    }
    await writeProgress();
    if (options["stop-after"] === "key") {
      records.status = skip ? "launch-ok-without-key" : "key-route-ok";
      return records;
    }

    const extracted = new Set();
    let previous = null;
    let firstRaw = true;
    for (const fraction of options.checkpointList) {
      const count = checkpointSceneCount(fraction, work.scenes.length);
      const label = `p${Math.round(fraction * 100)}`;
      const checkpoint = {
        fraction,
        sceneCount: count,
        extraction: [],
        queries: [],
      };
      records.checkpoints.push(checkpoint);
      const fresh = work.scenes
        .slice(0, count)
        .filter((scene) => !extracted.has(scene.index));
      checkpoint.added = await page.evaluate(
        (scenes) => window.fusionIrEvaluation.addScenes(scenes),
        fresh.map((scene) => ({
          position: scene.index,
          paragraphs: scene.paragraphs,
        })),
      );
      for (const scene of skip ? [] : fresh) {
        const result = await withTimeout(
          page.evaluate(
            (p) => window.fusionIrEvaluation.extractScene(p),
            scene.index,
          ),
          SCENE_TIMEOUT_MS,
          `extraction of position ${scene.index}`,
        );
        extracted.add(scene.index);
        const summary = {
          evidenceScope: EVIDENCE_SCOPE,
          ...result,
          runId: result.runId
            ? sha256(`${salt}:${result.runId}`).slice(0, 16)
            : null,
          proposalCount: result.proposals.length,
          approvedCount: result.proposals.filter((p) => p.approved).length,
        };
        records.extraction.push(summary);
        checkpoint.extraction.push(scene.index);
        log(
          `${label} 抽出 位置 ${scene.index}: ${result.status} 提案 ${summary.proposalCount} 承認 ${summary.approvedCount} ${Math.round(result.durationMs / 1000)}s${result.errorCode ? ` ${result.errorCode}` : ""}`,
        );
        await writeProgress();
        if (options["stop-after"] === "first-scene") break;
      }
      if (options["stop-after"] === "first-scene") {
        records.usage = await page.evaluate(() =>
          window.fusionIrEvaluation.usage(),
        );
        records.status = "first-scene-done";
        return records;
      }
      checkpoint.raw = await page.evaluate(
        (input) => window.fusionIrEvaluation.buildRaw(input),
        { first: firstRaw },
      );
      firstRaw = false;
      if (skip) for (const scene of fresh) extracted.add(scene.index);
      const positions = queryPositions(count);
      checkpoint.irWait = await page.evaluate(
        (input) => window.fusionIrEvaluation.waitIrUsable(input),
        {
          position: positions[positions.length - 1],
          timeoutMs: options.irWaitMs,
          requireReadyEvent: records.extraction.some(
            (e) => e.approvedCount > 0,
          ),
        },
      );
      log(`${label} IR wait: ${JSON.stringify(checkpoint.irWait)}`);
      // 地点の作り方（§2.5）：前の地点の probe の admitted が、足した後も残るか。
      if (previous) {
        const after = await probeMap(page, previous.positions);
        const comparison = compareAdmitted(previous.admitted, after);
        records.checkpointConstruction.push({
          from: previous.label,
          to: label,
          ...comparison,
        });
        log(
          `${previous.label}→${label} admitted 比較: ${JSON.stringify(comparison)}`,
        );
      }
      checkpoint.queries = await measurePositions(
        page,
        positions,
        options.repeats,
      );
      checkpoint.summary = summarizeQueries(checkpoint.queries);
      previous = {
        label,
        positions,
        admitted: new Map(
          checkpoint.queries
            .filter((q) => q.probe.status === "available")
            .map((q) => [
              q.position,
              q.probe.admittedPositions.filter((p) => p > 0 && p < q.position),
            ]),
        ),
      };
      await writeProgress();
      log(
        `${label}: Scene ${count}、query ${positions.length}、${JSON.stringify(checkpoint.summary.categories)}`,
      );
    }
    records.summary = summarizeQueries(
      records.checkpoints.flatMap((c) => c.queries),
    );
    records.status = skip
      ? "complete-without-extraction"
      : records.extraction.every((e) => e.status === "completed")
        ? "complete"
        : "complete-with-failures";
  } catch (error) {
    key = null;
    records.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    key = null;
    records.extractionSummary = summarizeExtraction(records.extraction);
    if (app) {
      if (!records.usage) {
        try {
          const [page] = app.windows();
          records.usage = await page.evaluate(() =>
            window.fusionIrEvaluation.usage(),
          );
        } catch {
          records.usage = null;
        }
      }
      try {
        const calls = await app.evaluate(() =>
          (globalThis.nir1IpcTrace?.calls ?? []).filter(
            (c) => c.command === "send_chat_message",
          ),
        );
        records.aiCalls = {
          sendChatMessage: calls.length,
          ok: calls.filter((c) => c.ok).length,
          failedOrIncomplete: calls.filter((c) => !c.ok).length,
        };
      } catch {
        records.aiCalls = null;
      }
      await app.close().catch((error) => {
        records.status = "blocked";
        records.errors.push(`Electron close: ${error.message}`);
      });
    }
    if (vite) await vite.close();
    if (records.usage) {
      const { inputTokens, outputTokens } = records.usage;
      records.costEstimateUsd = {
        value:
          (inputTokens * PRICE_ASSUMPTION.inputUsdPerMillion +
            outputTokens * PRICE_ASSUMPTION.outputUsdPerMillion) /
          1e6,
        priceAssumption: PRICE_ASSUMPTION,
      };
    }
    if (keyringBefore) {
      try {
        records.keyring = {
          ...(records.keyring ?? {}),
          afterClose: keyringDiff(keyringBefore, keyringSnapshot()),
        };
      } catch (error) {
        records.errors.push(`keyring snapshot: ${error.message}`);
      }
    }
    // 評価用の profile：消す前に中身（相対 path と大きさ）を確かめて記録し、それから消す。
    if (await exists(userData)) {
      try {
        const contents = await listTree(userData);
        records.profile = {
          files: contents.length,
          aiKeysJsonPresent: contents.some(
            (entry) => entry.path === "ai-keys.json",
          ),
          topLevel: [
            ...new Set(contents.map((entry) => entry.path.split(path.sep)[0])),
          ].sort(),
        };
        await writeFile(
          path.join(output, "profile-contents.json"),
          JSON.stringify(contents, null, 2) + "\n",
        );
        await rm(userData, { recursive: true, force: false });
        records.profile.removed = !(await exists(userData));
      } catch (error) {
        records.errors.push(`profile cleanup: ${error.message}`);
      }
    }
    records.finishedAt = new Date().toISOString();
    records.durationMs = Date.now() - startedAt;
    await writeFile(
      path.join(output, "records.json"),
      JSON.stringify(records, null, 2) + "\n",
    );
  }
  return records;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  const options = parseArgs(process.argv.slice(2));
  const records = await runIrSlot(options);
  console.log(
    JSON.stringify({
      status: records.status,
      output: path.resolve(options.output),
      errors: records.errors,
    }),
  );
  if (records.status === "blocked") process.exitCode = 1;
}
