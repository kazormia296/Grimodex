/* global window */
// 融合の枠の評価（段階 1）：PD の原稿で Raw が 8 件満杯になる割合を測る runner。
//
// 既存の L0 の Raw の runner（`scripts/quality/run-nir1-retrieval.mjs`）の raw mode から、
// 標準 build の受領書の確認、model の確認と配置、隔離した profile、Vite で配信する
// renderer、Electron の起動を写した（既存の file は変えない）。違いは次のとおり。
// - 作品ごとに 1 回起動し、読書順の 25％・50％・75％・100％ の地点ごとに、その地点までの
//   Scene だけを入れた別の workspace を作る。
// - 各地点の末尾から最大 10 件の Scene を「今書いている Scene」として、製品の
//   `fetchRelatedPastScenes`（Raw だけ）を呼び、件数（0〜8）を記録する。
// - 記録は件数・地点・作品の不透明 ID（run ごとの salt で hash）・Scene の位置だけ。
//   本文・題名・抜粋は書かない。全記録に evidenceScope: not-cp4-evidence。
// - 本番（role が main）の作品は、確定した事前登録の file とその sha256 が無いと走らせない。
//
// 使い方（隔離は L0 と同じく scripts/local-ci-xvfb.mjs の下で）:
//   node scripts/local-ci-xvfb.mjs node scripts/quality/fusion-slot-eval/raw-fullness.mjs \
//     --scenes <scenes/<key>.json> --output <runs/ の下の新しい dir> \
//     --build-receipt <standard build receipt> --ja-model <onnx> --en-model <onnx>
import assert from "node:assert/strict";
import process from "node:process";
import console from "node:console";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertOutsideRepo } from "./pd-corpus.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const EVIDENCE_SCOPE = "not-cp4-evidence";
export const CHECKPOINTS = Object.freeze([0.25, 0.5, 0.75, 1]);
export const QUERIES_PER_CHECKPOINT = 10;

/** 地点 f での Scene 数：ceil(f × N)。query が 1 件は取れるよう 2 以上にする。 */
export function checkpointSceneCount(fraction, sceneCount) {
  return Math.min(sceneCount, Math.max(2, Math.ceil(fraction * sceneCount)));
}

/** 地点の末尾から最大 10 件。前に Scene が 1 件以上ある位置（2 以上）だけ。 */
export function queryPositions(checkpointCount) {
  const first = Math.max(2, checkpointCount - QUERIES_PER_CHECKPOINT + 1);
  const positions = [];
  for (let p = first; p <= checkpointCount; p++) positions.push(p);
  return positions;
}

export function opaqueWorkId(salt, key) {
  return sha256(`${salt}:${key}`).slice(0, 16);
}

function parseArgs(args) {
  const options = {
    "ja-model": process.env.NIR1_JA_MODEL,
    "en-model": process.env.NIR1_EN_MODEL,
    "build-receipt": process.env.NIR1_BUILD_RECEIPT,
  };
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(
      args[i].startsWith("--") && args[i + 1],
      "--name value の形で渡す",
    );
    options[args[i].slice(2)] = args[i + 1];
  }
  for (const name of [
    "scenes",
    "output",
    "build-receipt",
    "ja-model",
    "en-model",
  ])
    assert.ok(
      options[name] && path.isAbsolute(options[name]),
      `[precheck] --${name} は絶対 path`,
    );
  return options;
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

/** 本番の作品は、確定した（下書きでない）事前登録とその sha256 が揃うときだけ測る。 */
export async function assertRunnable(role, options) {
  if (role === "trial") return { role, preregistration: null };
  assert.equal(role, "main", `[precheck] unknown role: ${role}`);
  const file = options.preregistration;
  const expected = options["preregistration-sha256"];
  assert.ok(
    file && expected,
    "[precheck] 本番の作品は --preregistration と --preregistration-sha256 が要る",
  );
  const bytes = await readFile(file);
  assert.equal(sha256(bytes), expected, "[precheck] 事前登録の sha256 が違う");
  assert.ok(
    !/下書き/.test(bytes.toString("utf8").split("\n")[0]),
    "[precheck] 事前登録が下書きのまま",
  );
  return { role, preregistration: { path: file, sha256: expected } };
}

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
  // build の後に変わってよいのは、この評価の dir の下の新しい file だけ。
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
    // 製品の取得済み model の resolver は検証済みの sidecar を要る。
    await writeFile(path.join(destination, "model_int8.onnx.sha256"), modelSha);
    models[language] = {
      modelId: spec.modelId,
      modelSha256: modelSha,
      tokenizerSha256: spec.tokenizerSha256,
      gateScore: spec.gateScore,
    };
  }
  return models;
}

export async function runRawFullness(options) {
  const startedAt = Date.now();
  const output = path.resolve(options.output);
  assertOutsideRepo(output);
  assertOutsideRepo(options.scenes);
  assert.ok(!(await exists(output)), `[precheck] 出力先が既にある: ${output}`);
  const scenesBytes = await readFile(options.scenes);
  const work = JSON.parse(scenesBytes.toString("utf8"));
  assert.equal(work.schemaVersion, "fusion-slot-pd-scenes/1");
  const gate = await assertRunnable(work.role, options);
  await mkdir(output, { recursive: true });
  // salt は run ごと。作品の key との対応は repo の外の run の dir にだけ残す。
  const salt = randomBytes(32).toString("hex");
  await writeFile(path.join(output, "salt.private"), `${salt}\n`, {
    mode: 0o600,
  });
  const records = {
    schemaVersion: "fusion-slot-raw-fullness/1",
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
    rulesSha256: work.rulesSha256,
    design: {
      checkpoints: CHECKPOINTS,
      checkpointSceneCount: "ceil(fraction × N)、2 以上",
      queriesPerCheckpoint: QUERIES_PER_CHECKPOINT,
      queryRule:
        "地点の末尾から最大 10 件。位置 2 以上（前に Scene が 1 件以上）",
      fetch:
        "fetchRelatedPastScenes(sceneId)（Raw だけ、hybrid でない）を 2 回呼び、1 回目を記録",
      top30:
        "同じ query 文字列（buildSemanticRecallQuery）で semanticSearch(limit 30) を別に呼んで数える（再問合せ）",
    },
    errors: [],
    checkpoints: [],
  };
  let app;
  let vite;
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
    records.harness = {
      runner: (await artifactIdentity(import.meta.filename)).sha256,
      renderer: (
        await artifactIdentity(path.join(import.meta.dirname, "renderer.ts"))
      ).sha256,
      rendererHtml: (
        await artifactIdentity(path.join(import.meta.dirname, "renderer.html"))
      ).sha256,
      observer: (
        await artifactIdentity(
          path.join(
            ROOT,
            "scripts/quality/nir1-retrieval/electron-observer.mjs",
          ),
        )
      ).sha256,
    };
    const userData = path.join(output, "user-data");
    await mkdir(userData, { recursive: true });
    records.models = await placeModels(userData, options);
    // この評価用の profile は、ユーザーの旧 key を取り込まない。
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
    const rendererUrl = `http://127.0.0.1:${address.port}/scripts/quality/fusion-slot-eval/renderer.html`;
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
      () => window.fusionSlotEvaluation?.ready === true,
      null,
      { timeout: 120000 },
    );
    records.electronVersion = await app.evaluate(
      () => process.versions.electron,
    );
    for (const fraction of CHECKPOINTS) {
      const count = checkpointSceneCount(fraction, work.scenes.length);
      const label = `p${Math.round(fraction * 100)}`;
      const checkpoint = {
        fraction,
        sceneCount: count,
        queries: [],
      };
      records.checkpoints.push(checkpoint);
      checkpoint.prepared = await page.evaluate(
        (input) => window.fusionSlotEvaluation.prepare(input),
        {
          workspacePath: path.join(output, "workspaces", label),
          projectId: `fusion-slot-${label}`,
          language: work.language,
          scenes: work.scenes.slice(0, count).map((scene) => ({
            position: scene.index,
            paragraphs: scene.paragraphs,
          })),
        },
      );
      checkpoint.index = await page.evaluate(() =>
        window.fusionSlotEvaluation.buildRaw(),
      );
      for (const position of queryPositions(count)) {
        const sample = await page.evaluate(
          (p) => window.fusionSlotEvaluation.measure(p),
          position,
        );
        checkpoint.queries.push({
          evidenceScope: EVIDENCE_SCOPE,
          opaqueWorkId: records.opaqueWorkId,
          checkpoint: fraction,
          position,
          priorSceneCount: position - 1,
          ...sample,
        });
      }
      await writeFile(
        path.join(output, "records.in-progress.json"),
        JSON.stringify(records, null, 2) + "\n",
      );
      process.stdout.write(
        `地点 ${label}：Scene ${count}、query ${checkpoint.queries.length}\n`,
      );
    }
    const all = records.checkpoints.flatMap((c) => c.queries);
    records.status = all.every((q) => q.status === "ok")
      ? "complete"
      : "complete-with-failures";
  } catch (error) {
    records.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (app)
      await app.close().catch((error) => {
        records.status = "blocked";
        records.errors.push(`Electron close: ${error.message}`);
      });
    if (vite) await vite.close();
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
  const records = await runRawFullness(options);
  console.log(
    JSON.stringify({
      status: records.status,
      output: path.resolve(options.output),
      errors: records.errors,
    }),
  );
  if (records.status === "blocked") process.exitCode = 1;
}
