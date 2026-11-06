/* global window */
// PUB-G 前提 #16（DR-CP3A-55 の lease 越しの end-to-end）の実行の入口
// （DR-PUBG-16-1）。CP-4 の測定ではなく、品質の測定でもない。合格基準は
// 「各段に到達したか」だけで、所要時間は記録するだけ。
//
// pin の外の薄い runner：`dprime-check.mjs` の `launch`／`openWorkspace`／
// `buildIndex`、harness の `heldSample`（begin → continue → qualify → click →
// unused settle → graph-ready → 再 begin〔cached〕→ used settle）をそのまま使い、
// dprime-check がしていない「測定 workspace での body の宣言」を heldSample の前に
// 足す（dev-lantern の `declarations`。Graph-only の行は宣言済みの Scene にだけ出る）。
// dprime-check／harness／fixture は変えない。
//
//   --mode reach（既定）：評価 build の実 Native（gate が開く）で到達を見る。
//   --mode not-activated：評価 feature の無い製品の Native（gate は閉じたまま）で、
//     seed つきの begin が `not-activated` になることを見る（DR-CP3A-58）。
//
//   TMPDIR=<short scratch> node scripts/local-ci-xvfb.mjs node \
//     scripts/quality/nir1-graph-eval/pubg16-e2e-run.mjs --run <name> \
//     --setup .artifacts/cp4/<setup-run>/setup/setup-receipt.json \
//     --ja-model <pinned> --en-model <pinned> \
//     [--mode reach|not-activated] [--eval-build .artifacts/cp4/eval-build] \
//     [--product-native <grimodex-node.node>]
//
// 結果は `.artifacts/pubg-16/<run>.json`（status・reason・ms・到達の有無だけ。本文・
// 識別子・query を含まない）。詳しい report は `.artifacts/cp4/<run>/` に残る。

import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { admitDevPreview } from "./admission.mjs";
import {
  buildIndex,
  json,
  launch,
  nativeRows,
  openWorkspace,
  waitQuiet,
} from "./dprime-check.mjs";
import { loadDevFixture } from "./dev-fixture.mjs";
import { ROOT, bundleObserver } from "./launcher.mjs";
import { buildHarnessRenderer, startStaticServer } from "./renderer-build.mjs";
import { measurementSeamEnv } from "./run-sample.mjs";
import { HARNESS_PAGE, sha256, startSession } from "./session.mjs";
import { readIndexMetadata } from "./workspace-db.mjs";

export const RESULT_SCHEMA = "nir1-pubg-16-e2e/1";
export const RESULT_DIR = ".artifacts/pubg-16";
export const MODES = Object.freeze(["reach", "not-activated"]);
export const STAGES = Object.freeze([
  "begin-pending",
  "continue-available-graph-only",
  "click-keep-click",
  "unused-settle",
  "graph-ready",
  "requery-cached",
  "requery-continue-available",
  "used-settle",
  "slot-empty",
]);
const READY_WAIT_MS = 3_000;

export function parseArgs(argv) {
  const options = {
    mode: "reach",
    "eval-build": path.join(ROOT, ".artifacts/cp4/eval-build"),
  };
  for (let at = 0; at < argv.length; at += 2) {
    if (!argv[at].startsWith("--") || argv[at + 1] === undefined)
      throw new Error("use --name value arguments");
    options[argv[at].slice(2)] = argv[at + 1];
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(options.run ?? ""))
    throw new Error("--run <name> is required");
  for (const name of ["setup", "ja-model", "en-model"])
    if (!options[name]) throw new Error(`--${name} is required`);
  if (!MODES.includes(options.mode))
    throw new Error(`--mode is one of ${MODES.join(", ")}`);
  if (options.mode === "not-activated" && !options["product-native"])
    throw new Error("--product-native <grimodex-node.node> is required");
  return options;
}

/**
 * heldSample の出力と Native の記録から、各段の status・reason・ms と到達の有無
 * だけを取り出す（本文・識別子を含まない）。pure で、試験つき。
 */
export function judgeReach({ page, native, settledSlot, settles }) {
  const out = page ?? {};
  const rows = native ?? [];
  const begin = out.begin ?? {};
  const graph = out.graph ?? null;
  const click = out.click ?? null;
  const requery = out.requery ?? null;
  const stages = {
    begin: {
      status: begin.graph?.status ?? null,
      reason: begin.graph?.reason ?? null,
      ir: begin.ir ?? null,
      ms: begin.roundTripMs ?? null,
    },
    continue: graph && {
      status: graph.status,
      reason: graph.reason ?? null,
      graphOnly: graph.graphOnly ?? null,
      pathAttachments: graph.pathAttachments ?? null,
      ms: graph.waitMs ?? null,
    },
    click: click && {
      status: click.status,
      reason: click.reason ?? null,
      ms: click.ms ?? null,
    },
    unusedSettle: out.settle ? { status: out.settle.status } : null,
    graphReady: out.graphReady && {
      count: out.graphReady.count,
      afterSettleMs: out.graphReady.afterSettleMs ?? null,
    },
    requery: requery && {
      begin: requery.begin?.graph?.status ?? null,
      beginMs: requery.begin?.roundTripMs ?? null,
      continueStatus: requery.graph?.status ?? null,
      continueReason: requery.graph?.reason ?? null,
    },
    settles: (settles ?? []).map((row) => ({
      settle: row.settle ?? null,
      status: row.status ?? null,
      reason: row.reason ?? null,
      ok: row.ok ?? null,
    })),
    native: rows.map((row) => ({
      begin: row.begin,
      reason: row.reason,
      outcome: row.outcome,
      disposition: row.disposition,
    })),
    settledSlot: settledSlot ?? null,
    errors: (out.errors ?? []).length,
  };
  const reached = {
    "begin-pending": stages.begin.status === "pending",
    "continue-available-graph-only":
      graph?.status === "available" && graph?.graphOnly === true,
    // Graph-only の handle の click の成功は `qualified`（Native の keep_click の
    // entry を引いて再確認できたとき）。
    "click-keep-click": click?.status === "qualified",
    "unused-settle":
      out.settle?.status === "settled" &&
      (settles ?? []).some(
        (row) =>
          row.settle === "unused" &&
          row.ok === true &&
          row.status === "settled",
      ),
    "graph-ready": (out.graphReady?.count ?? 0) > 0,
    "requery-cached": rows.slice(1).some((row) => row.begin === "cached"),
    "requery-continue-available": requery?.graph?.status === "available",
    // used settle の応答の status。renderer の timing shim が settle の応答を
    // `__cp4IpcTiming` に積む（label は settle の値）。settle は失効や未知でも例外を
    // 出さず `unavailable: cancelled` を返すので、`settled` だけを到達とする。
    "used-settle": (settles ?? []).some(
      (row) =>
        row.settle === "used" && row.ok === true && row.status === "settled",
    ),
    // owner の slot。cached の begin は owner の slot を使わないので、これは
    // used settle の根拠ではなく、heldSample が終わって owner が空に戻ったこと。
    "slot-empty": settledSlot === "empty",
  };
  return {
    stages,
    reached,
    allReached: STAGES.every((name) => reached[name] === true),
    firstMissing: STAGES.find((name) => reached[name] !== true) ?? null,
  };
}

/** seed つきの begin が gate の閉じた Native で `not-activated` になったか。 */
export function judgeNotActivated({ page }) {
  const graph = page?.begin?.graph ?? null;
  return {
    stages: {
      begin: {
        status: graph?.status ?? null,
        reason: graph?.reason ?? null,
        ir: page?.begin?.ir ?? null,
      },
      continue: page?.graph ? { status: page.graph.status } : null,
      click: page?.click ? { status: page.click.status } : null,
    },
    notActivated:
      graph?.status === "unavailable" && graph?.reason === "not-activated",
  };
}

const indexPair = (metadata) => ({
  b: {
    generation: metadata?.b?.generation ?? -1,
    dirty: metadata?.b?.dirty ?? true,
  },
  chronicle: {
    generation: metadata?.chronicle?.generation ?? -1,
    dirty: metadata?.chronicle?.dirty ?? true,
  },
});

/** 測定 workspace での body の宣言（trace-runner の runTraceDeclaration と同じ呼出し）。 */
async function declareBody({
  page,
  workspacePath,
  projectId,
  sceneId,
  dbPath,
}) {
  const capture = await page.evaluate(
    ([name, input]) => window.cp4Harness.call(name, input),
    [
      "narrative_extraction_capture_workspace_binding",
      { expectedWorkspacePath: workspacePath },
    ],
  );
  if (!capture?.ok)
    throw new Error(
      `[artifact] the workspace binding capture failed: ${capture?.error}`,
    );
  const scene = { workspacePath, projectId, sceneId };
  const before = indexPair(readIndexMetadata(dbPath, projectId));
  const result = await page.evaluate(
    (input) => window.cp4Harness.declaration.declare(input),
    scene,
  );
  const after = indexPair(readIndexMetadata(dbPath, projectId));
  const state = await page.evaluate(
    (input) => window.cp4Harness.declaration.state(input),
    scene,
  );
  if (!result?.ok)
    throw new Error("[precheck] the body declaration was refused");
  return {
    declared: true,
    effective:
      state?.ok === true &&
      state.snapshot?.state?.kind === "declared" &&
      state.snapshot.state.effective === true,
    indexBefore: before,
    indexAfter: after,
  };
}

async function oneHeldSample({ session, page, input }) {
  await session.addon("nir1GraphEvalClearSamples");
  const quiet = await waitQuiet(session, null);
  const result = await page.evaluate(
    (value) => window.cp4Harness.dprime.heldSample(value),
    input,
  );
  const settled = await waitQuiet(session, null);
  const records = (await json(session.addon("nir1GraphEvalSamples"))).records;
  // settle の応答（timing shim の行）。ticket・識別子は含まない。
  const settles = await page.evaluate(() =>
    (globalThis.__cp4IpcTiming ?? [])
      .filter((row) => row.settle !== null)
      .map((row) => ({
        settle: row.settle,
        status: row.status,
        reason: row.reason,
        ok: row.ok,
      })),
  );
  return {
    settles,
    quietAtStart: quiet.reachedQuiet,
    settledSlot: settled.slot,
    page: result.ok ? result.value : { error: result.error },
    native: nativeRows(records),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const productMode = options.mode === "not-activated";
  const runDir = path.join(ROOT, ".artifacts/cp4", options.run);
  await mkdir(runDir, { recursive: false });
  await mkdir(path.join(ROOT, RESULT_DIR), { recursive: true });
  const setup = JSON.parse(await readFile(path.resolve(options.setup)));
  const loaded = loadDevFixture({
    root: ROOT,
    fixturePath: setup.fixture.path,
  });
  if (loaded.sha256 !== setup.fixture.sha256)
    throw new Error("[precheck] the dev fixture changed since its setup");
  const declaration = loaded.fixture.declarations?.[0] ?? null;
  if (!declaration)
    throw new Error("[precheck] the dev fixture declares no Scene");
  const admission = admitDevPreview({
    purpose: "dprime-check",
    fixture: loaded,
  });
  const ids = setup.logicalToRuntime;
  const seed = ids.entities[loaded.fixture.graphSeedEntityId];
  const declaredSceneId = ids.scenes[declaration.sceneId];
  const evalDir = path.resolve(options["eval-build"]);
  const nativePath = productMode
    ? path.resolve(options["product-native"])
    : path.join(evalDir, "grimodex-node.node");
  const workspacePath = path.join(runDir, "workspace");
  await mkdir(workspacePath);
  const dbPath = path.join(workspacePath, "grimodex.db");
  await copyFile(path.join(ROOT, setup.coldDatabase.path), dbPath);
  const report = {
    schema: RESULT_SCHEMA,
    diagnosticOnly: true,
    run: options.run,
    mode: options.mode,
    nodeSha256: sha256(await readFile(nativePath)),
    workerSha256: productMode
      ? null
      : sha256(await readFile(path.join(evalDir, "nir1-c-query-worker"))),
    fixtureSha256: loaded.sha256,
    problems: [],
    sessions: {},
  };
  const launchOptions = {
    ...options,
    "eval-build": evalDir,
    run: options.run,
  };
  await buildHarnessRenderer({
    root: ROOT,
    outDir: path.relative(ROOT, path.join(runDir, "renderer-dist")),
    input: {
      index: path.join(ROOT, "index.html"),
      harness: path.join(ROOT, HARNESS_PAGE.slice(1)),
    },
    timingShim: true,
  });
  const server = await startStaticServer({
    dir: path.join(runDir, "renderer-dist"),
  });
  const observer = await bundleObserver({
    outDir: path.join(runDir, "observer"),
  });
  // 製品の Native（評価 feature なし）は launch の「評価 owner の準備」の確認を
  // 持たないので、同じ session の起動を直接使う。
  const start = async (label) => {
    if (!productMode)
      return launch({
        label,
        runDir,
        server,
        observer,
        options: launchOptions,
        admission,
      });
    return startSession({
      runDir,
      label,
      server,
      observer,
      nativePath,
      d2aMode: "restricted",
      models: { ja: options["ja-model"], en: options["en-model"] },
      tmpRoot: options.tmp ? path.join(options.tmp, options.run) : null,
      admission,
      extraEnv: measurementSeamEnv({
        bodyNonce: randomUUID(),
        maintenance: "product",
      }),
    });
  };
  const stopSession = async (label, session) => {
    if (!session) return;
    const evidence = await session.stop();
    await writeFile(
      path.join(runDir, `${label}-main-stderr.log`),
      session.stderr(),
    );
    report.sessions[label] = {
      problems: evidence.problems,
      netLogNonLoopback: evidence.netLog?.nonLoopbackAttempts ?? null,
      socketViolations: evidence.socketCheck?.violations?.length ?? null,
      remaining: evidence.stop?.remaining ?? null,
    };
    report.problems.push(...evidence.problems.map((row) => `${label}: ${row}`));
  };
  const pinSeed = (page) =>
    page.evaluate((value) => window.cp4Harness.api.upsertScenePin(value), {
      sceneId: ids.querySceneId,
      entryId: seed,
    });
  const buildRaw = (page) =>
    page.evaluate((input) => window.cp4Harness.buildRaw(input), {
      projectId: ids.projectId,
      label: `pubg16-${options.run}`,
      sceneIds: Object.keys(ids.scenes),
      queryBody: loaded.fixture.query.body,
    });
  let session = null;
  try {
    // 1 回目：Raw の vector と Chronicle の Index（seed の pin は製品の API で
    // 測定用の写しにだけ足す。DR-CP4-S1C2-26）。
    session = await start("prep");
    await openWorkspace(session.page, workspacePath, ids);
    report.pinQuerySeed = await pinSeed(session.page);
    const raw = await buildRaw(session.page);
    if (!raw.ok || !raw.value.ok) throw new Error("Raw index build failed");
    report.prepIndex = await buildIndex(session.page, ids);
    await stopSession("prep", session);
    session = null;

    // 2 回目：同じ workspace で、Index → body の宣言 → heldSample。
    session = await start("check");
    const page = session.page;
    await openWorkspace(page, workspacePath, ids);
    report.checkIndex = await buildIndex(page, ids);
    if (!productMode) {
      report.declaration = await declareBody({
        page,
        workspacePath,
        projectId: ids.projectId,
        sceneId: declaredSceneId,
        dbPath,
      });
      // 宣言が Chronicle の Index を dirty にしたら作り直す（記録する）。
      if (report.declaration.indexAfter.chronicle.dirty)
        report.indexRebuiltAfterDeclaration = await buildIndex(page, ids);
    }
    const input = {
      workspacePath,
      projectId: ids.projectId,
      sceneId: ids.querySceneId,
      seed,
      readyWaitMs: READY_WAIT_MS,
    };
    if (productMode) {
      // 製品の Native には評価の entry が無い。heldSample だけを回す。
      const result = await page.evaluate(
        (value) => window.cp4Harness.dprime.heldSample(value),
        input,
      );
      report.sample = {
        page: result.ok ? result.value : { error: result.error },
      };
      report.judgement = judgeNotActivated({ page: report.sample.page });
    } else {
      report.sample = await oneHeldSample({ session, page, input });
      report.judgement = judgeReach(report.sample);
    }
    await sleep(500);
  } catch (error) {
    report.problems.push(error?.stack ?? String(error));
    process.exitCode = 1;
    if (error?.launchedSession)
      await stopSession(error.launchLabel, error.launchedSession).catch(
        (stopError) =>
          report.problems.push(`stop: ${stopError?.stack ?? stopError}`),
      );
  } finally {
    await stopSession("check", session).catch((error) =>
      report.problems.push(`stop: ${error?.stack ?? error}`),
    );
    await server.close();
  }
  if (report.problems.length > 0) process.exitCode = 1;
  await writeFile(
    path.join(runDir, "pubg16-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  // 識別子・本文を含まない結果だけを `.artifacts/pubg-16/` に出す。
  const result = {
    schema: RESULT_SCHEMA,
    run: options.run,
    mode: options.mode,
    nodeSha256: report.nodeSha256,
    workerSha256: report.workerSha256,
    fixtureSha256: report.fixtureSha256,
    declaration: report.declaration
      ? {
          declared: report.declaration.declared,
          effective: report.declaration.effective,
          indexBefore: report.declaration.indexBefore,
          indexAfter: report.declaration.indexAfter,
          indexRebuilt: report.indexRebuiltAfterDeclaration !== undefined,
        }
      : null,
    judgement: report.judgement ?? null,
    quietAtStart: report.sample?.quietAtStart ?? null,
    sessionProblems: report.problems.map((row) => row.split("\n")[0]),
  };
  await writeFile(
    path.join(ROOT, RESULT_DIR, `${options.run}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(result, null, 1)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename)
  await main();
