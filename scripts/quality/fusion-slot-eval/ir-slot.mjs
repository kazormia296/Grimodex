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
import { execFileSync, spawn } from "node:child_process";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { appendFileSync } from "node:fs";
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
} from "./raw-fullness.mjs";
import { compareAdmitted, summarizeQueries } from "./ir-classify.mjs";
import { makeKeyFifo, readKeyFromFifo } from "./fifo-key.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// provider ごとの既定の model と key の接頭辞。--provider／--model で選ぶ。
// 2026-11-04：ユーザーの依頼で、評価は Anthropic を優先する（OpenRouter は予備）。
export const PROVIDERS = {
  openrouter: { model: "openai/gpt-6-luna", keyPrefix: "sk-or-" },
  anthropic: { model: "claude-opus-5-5", keyPrefix: "sk-ant-" },
};
const SCENE_TIMEOUT_MS = 15 * 60 * 1000;
const IR_WAIT_MS = 5 * 60 * 1000;
// 費用の外挿に使う単価（model ごと）。cache の割引は数えない。表に無い model は見積もらない。
export const PRICE_ASSUMPTIONS = Object.freeze({
  // 計画 §4 が先行の calibration helper から引いた値で、OpenRouter の現行の単価は未確認。
  "openai/gpt-6-luna": Object.freeze({
    inputUsdPerMillion: 0.25,
    outputUsdPerMillion: 1.5,
    source: "計画 §4 の calibration helper の値（推測。現行の単価は未確認）",
  }),
  // claude-opus-5-5 の Anthropic の公表の単価（2026-11-04 時点の資料）。
  "claude-sonnet-5-5": Object.freeze({
    inputUsdPerMillion: 2,
    outputUsdPerMillion: 10,
    source: "claude-sonnet-5-5 の公表の単価（cache の割引は数えない）",
  }),
  "claude-opus-5-5": Object.freeze({
    inputUsdPerMillion: 4,
    outputUsdPerMillion: 20,
    source: "claude-opus-5-5 の公表の単価（cache の割引は数えない）",
  }),
});
const CUTOVER_WAIT_MS = 180000;

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
    provider: "openrouter",
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
  // 診断（IR の到着の分布）：測定の済んだ run の workspace の写しで query だけを流す。
  // 抽出も key も使わない。結果は評価の証拠にしない（status は latency-diagnostic）。
  if (options["reuse-workspace"]) {
    assert.ok(
      path.isAbsolute(options["reuse-workspace"]),
      "[precheck] --reuse-workspace は絶対 path",
    );
    options.skipExtraction = true;
  }
  assert.ok(
    Object.hasOwn(PROVIDERS, options.provider),
    "[precheck] --provider は openrouter／anthropic",
  );
  options.model ??= PROVIDERS[options.provider].model;
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

/**
 * key を読む。形式は接頭辞と長さだけを確かめる。値・長さの数字は返さない。file は通常の
 * file か、product-key-to-fifo.mjs が書く FIFO（平文をディスクに残さない経路）。
 */
export async function readProviderKey(file, provider) {
  const info = await stat(file);
  assert.equal(info.mode & 0o077, 0, "[precheck] key の file の権限は 600");
  const key = (await readFile(file, "utf8")).trim();
  assert.ok(
    key.startsWith(PROVIDERS[provider].keyPrefix) &&
      key.length >= 40 &&
      key.length <= 300 &&
      !/\s/u.test(key),
    "[precheck] key の形式（接頭辞と長さ）が想定と違う",
  );
  return key;
}

/**
 * 製品（packaged の Grimodex）の profile に safeStorage で保存された key を、復号の script を
 * 子 process で起動して FIFO で受け取る。値は返り値だけに持ち、記録しない。
 */
async function readProductKey(options) {
  const store = options["product-key-store"];
  assertOutsideRepo(store);
  const { fifo, cleanup } = makeKeyFifo(os.tmpdir());
  const abort = new globalThis.AbortController();
  const lines = [];
  try {
    // 読み手を先に開く（書き手は ENXIO の間待つ）。
    const reading = readKeyFromFifo(fifo, { signal: abort.signal });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      require("electron"),
      [
        path.join(
          ROOT,
          "scripts/quality/fusion-slot-eval/product-key-to-fifo.mjs",
        ),
        "--store",
        store,
        "--service",
        `grimodex-${options.provider}`,
        "--fifo",
        fifo,
        "--prefix",
        PROVIDERS[options.provider].keyPrefix,
      ],
      { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    // 子の出力は [product-key] の行だけ残す（key を出さない作り）。
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        for (const line of chunk.toString().split("\n"))
          if (line.startsWith("[product-key]")) lines.push(line.slice(0, 200));
      });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    exited.then((code) => {
      if (code !== 0) abort.abort();
    });
    const value = await reading;
    const code = await exited;
    assert.equal(
      code,
      0,
      `[key] 復号の script が失敗した（${lines.join(" ")}）`,
    );
    assert.ok(
      value.startsWith(PROVIDERS[options.provider].keyPrefix) &&
        value.length >= 40 &&
        value.length <= 300 &&
        !/\s/u.test(value),
      "[precheck] key の形式（接頭辞と長さ）が想定と違う",
    );
    return {
      key: value,
      status: { source: "product-profile-safeStorage", lines },
    };
  } catch (error) {
    throw new Error(
      `[key] 製品の profile の key を受け取れない（${lines.join(" ") || (error instanceof Error ? error.message : "error")}）`,
      { cause: error },
    );
  } finally {
    cleanup();
  }
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

/**
 * query の位置：その地点で足した Scene 全部（位置 2 以上）。各位置は足した地点で 1 回だけ引く
 * （related は前の Scene しか見ない）。段階 1 の「末尾 10 件」では Raw が 8 件未満の sample が
 * D0 の 200 に届かない見込み（段階 1 の query 238・満杯 190）なので、本測定の前に広げた。
 */
export function addedQueryPositions(previousCount, count) {
  const positions = [];
  for (let p = Math.max(2, previousCount + 1); p <= count; p++)
    positions.push(p);
  return positions;
}

/** 前の Scene の数の層（主指標を層別して出す）。 */
export function priorScenesBucket(position) {
  const prior = position - 1;
  return prior < 8 ? "lt8" : prior <= 30 ? "8to30" : "gt30";
}

/** 測定：各 query 位置で hybrid を repeats 回、その後に probe を 1 回。 */
async function measurePositions(page, positions, repeats, count) {
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
    queries.push({
      evidenceScope: EVIDENCE_SCOPE,
      position,
      priorScenes: position - 1,
      priorScenesBucket: priorScenesBucket(position),
      // 段階 1 と並べるための部分集合：引いた地点の末尾 10 件に入るか。
      tail10: position > count - 10,
      samples,
      probe,
    });
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
      provider: options.provider,
      model: options.model,
      reasoning:
        "製品の抽出の経路から reasoning を指定できないので、製品の既定のまま（provider／model と製品の設定の既定）",
      keyRoute:
        options.provider === "anthropic"
          ? "製品（packaged の Grimodex）の profile に safeStorage で保存された key を、app 名 Grimodex の Electron で復号して FIFO で渡し、評価用の profile に製品の save_api_key で入れる。平文はディスクに残さず、値は記録しない"
          : "デスクトップの keyring：製品の save_api_key（Electron safeStorage）。key は repo の外の file から node が読み、値は記録しない",
    },
    design: {
      condition:
        "IR が最大に出る条件の下での枠の使用率：harness が全提案を reviseChronicleProposal({secret:false}) で child にし、child を承認する（製品の既定では secret のまま承認すると IR に出ない）",
      checkpoints: CHECKPOINTS,
      checkpointSceneCount: "ceil(fraction × N)、2 以上（段階 1 と同じ）",
      queryRule:
        "その地点で足した Scene 全部（位置 2 以上）。各位置は足した地点で 1 回だけ引く。前の Scene の数（<8／8〜30／>30）で層別し、引いた地点の末尾 10 件（tail10）の部分集合も別に集計する",
      scope:
        "案 B（製品の既定、SDEF #791・#793）：project を作成画面と同じ option（sceneScopeDefault: main-line）で作り、足した Scene が既定（本筋の exact、holder と audience は reader、marker は explicit）を受け継いだかを読んで確かめる。harness は scope を書かない",
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
    if (!skip && options["product-key-store"]) {
      // 製品の profile の key：keyring の snapshot を先に取り、harness が作った FIFO に復号の
      // script（app 名 Grimodex）が 1 回だけ書く。script が keyring を変えても前後の比較で分かる。
      keyringBefore = keyringSnapshot();
      const result = await readProductKey(options);
      key = result.key;
      records.productKey = result.status;
    } else if (!skip) {
      key = await readProviderKey(options["key-file"], options.provider);
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
    // 抽出の途中で workspace の authority が差し替わる件（試運転の位置 15）の発生源を追うため、
    // main と renderer の出力のうち workspace／authority／recovery／restore／rollback の行だけを
    // run の dir に残す（1 行 400 字まで）。測定の値には使わない。
    const traceFile = path.join(output, "workspace-trace.log");
    const TRACE_PATTERN = /workspace|authority|recovery|restore|rollback/i;
    const traceLine = (source, line) => {
      if (TRACE_PATTERN.test(line))
        appendFileSync(
          traceFile,
          `[${new Date().toISOString()}] ${source} ${line.slice(0, 400)}\n`,
        );
    };
    for (const [source, stream] of [
      ["main:stdout", app.process().stdout],
      ["main:stderr", app.process().stderr],
    ]) {
      let pending = "";
      stream?.on("data", (chunk) => {
        pending += chunk.toString();
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) traceLine(source, line);
      });
    }
    const page = await app.firstWindow();
    page.on("console", (message) => traceLine("renderer", message.text()));
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
    const reuse = options["reuse-workspace"];
    if (reuse) {
      const sourceRecords = JSON.parse(
        await readFile(path.join(reuse, "records.json"), "utf8"),
      );
      const source = sourceRecords.checkpoints
        .filter((c) => (c.queries ?? []).length > 0)
        .at(-1);
      assert.ok(source, "[precheck] reuse: query のある地点が無い");
      await cp(
        path.join(reuse, "workspaces", "ir"),
        path.join(output, "workspaces", "ir"),
        { recursive: true, errorOnExist: true, force: false },
      );
      records.reuse = {
        sourceRunId: sourceRecords.runId,
        sourceFraction: source.fraction,
        positions: source.queries.map((q) => q.position),
      };
    }
    records.prepare = await page.evaluate(
      (input) => window.fusionIrEvaluation.prepare(input),
      {
        workspacePath: path.join(output, "workspaces", "ir"),
        projectId: "fusion-ir",
        language: work.language,
        attach: Boolean(reuse),
      },
    );
    if (reuse) {
      log(`reuse prepare: ${JSON.stringify(records.prepare)}`);
      records.irTap = await page.evaluate(() =>
        window.fusionIrEvaluation.installIrArrivalTap(),
      );
      log(`IR tap: ${JSON.stringify(records.irTap)}`);
      records.canonicalCutover = await page.evaluate(
        (input) => window.fusionIrEvaluation.waitCanonicalCutover(input),
        { timeoutMs: CUTOVER_WAIT_MS },
      );
      log(`canonical cutover: ${JSON.stringify(records.canonicalCutover)}`);
      const positions = records.reuse.positions;
      const checkpoint = {
        fraction: records.reuse.sourceFraction,
        sceneCount: records.prepare.scenes,
        queries: [],
      };
      records.checkpoints.push(checkpoint);
      checkpoint.raw = await page.evaluate(
        (input) => window.fusionIrEvaluation.buildRaw(input),
        { first: true },
      );
      checkpoint.irWait = await page.evaluate(
        (input) => window.fusionIrEvaluation.waitIrUsable(input),
        {
          position: positions.at(-1),
          timeoutMs: options.irWaitMs,
          requireReadyEvent: true,
        },
      );
      log(`reuse IR wait: ${JSON.stringify(checkpoint.irWait)}`);
      assert.ok(
        checkpoint.irWait.usable,
        "[artifact] reuse: IR が usable にならない",
      );
      checkpoint.queries = await measurePositions(
        page,
        positions,
        options.repeats,
        records.prepare.scenes,
      );
      checkpoint.summary = summarizeQueries(checkpoint.queries);
      log(`reuse: ${JSON.stringify(checkpoint.summary.categories)}`);
      records.status = "latency-diagnostic";
      return records;
    }
    // 保守の cutover（Generic Freshness の正本への切り替え）が済む前に書き込みを始めると、
    // IR の build が入口ではじかれ続ける。済むまで待ってから Scene を足す。
    records.canonicalCutover = await page.evaluate(
      (input) => window.fusionIrEvaluation.waitCanonicalCutover(input),
      { timeoutMs: CUTOVER_WAIT_MS },
    );
    log(`canonical cutover: ${JSON.stringify(records.canonicalCutover)}`);
    assert.ok(
      records.canonicalCutover.done,
      "[artifact] 保守の canonical cutover が済まない（IR が作れない）",
    );
    if (!skip) {
      records.aiSettings = await page.evaluate(
        (input) => window.fusionIrEvaluation.configureAi(input),
        { provider: options.provider, model: options.model },
      );
      assert.equal(records.aiSettings.provider, options.provider);
      assert.equal(records.aiSettings.model, options.model);
      records.keyInstall = await page
        .evaluate((input) => window.fusionIrEvaluation.installKey(input), {
          provider: options.provider,
          key,
        })
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
    let previousCount = 0;
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
      // 案 B（製品の既定）：抽出の前に、足した Scene が本筋の既定を受け継いだかを確かめる。
      checkpoint.scope = await page.evaluate(
        (positions) => window.fusionIrEvaluation.verifyMainScope(positions),
        fresh.map((scene) => scene.index),
      );
      log(`${label} scope: ${JSON.stringify(checkpoint.scope)}`);
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
      const positions = addedQueryPositions(previousCount, count);
      previousCount = count;
      checkpoint.irWait = await page.evaluate(
        (input) => window.fusionIrEvaluation.waitIrUsable(input),
        {
          position: positions.at(-1) ?? count,
          timeoutMs: options.irWaitMs,
          requireReadyEvent: records.extraction.some(
            (e) => e.approvedCount > 0,
          ),
        },
      );
      log(`${label} IR wait: ${JSON.stringify(checkpoint.irWait)}`);
      if (!checkpoint.irWait.usable) {
        // IR が使えないまま測っても主指標に使えない（D1）。抽出の費用を使い続けないよう、
        // cutover の状態を記録してこの作品を打ち切る（finally の後片付けは通る）。
        checkpoint.canonicalCutoverDone = await page.evaluate(() =>
          window.fusionIrEvaluation.canonicalCutoverDone(),
        );
        throw new Error(
          `[artifact] ${label} で IR が usable にならない（cutover ${checkpoint.canonicalCutoverDone ? "済み" : "未了"}）`,
        );
      }
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
        count,
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
    const allQueries = records.checkpoints.flatMap((c) => c.queries);
    records.summary = summarizeQueries(allQueries);
    records.summaryByPriorScenes = Object.fromEntries(
      ["lt8", "8to30", "gt30"].map((bucket) => [
        bucket,
        summarizeQueries(
          allQueries.filter((q) => q.priorScenesBucket === bucket),
        ),
      ]),
    );
    records.summaryTail10 = summarizeQueries(
      allQueries.filter((q) => q.tail10),
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
      const price = PRICE_ASSUMPTIONS[options.model] ?? null;
      records.costEstimateUsd = price
        ? {
            value:
              (inputTokens * price.inputUsdPerMillion +
                outputTokens * price.outputUsdPerMillion) /
              1e6,
            model: options.model,
            priceAssumption: price,
          }
        : { value: null, model: options.model, reason: "単価の表に無い model" };
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
