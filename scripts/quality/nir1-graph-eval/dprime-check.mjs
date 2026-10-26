/* global window */
// CQ-DEFER（D′）の実機の確認 (ii)（`docs/plans/nir1-lane-decisions/cq-deferred-decisions.md`
// §6.8 の 3〜9、DR-CP4-S1C2-24）。CP-4 の測定ではなく、receipt は書かない。
//
//   TMPDIR=<short scratch> node scripts/local-ci-xvfb.mjs node \
//     scripts/quality/nir1-graph-eval/dprime-check.mjs --run <name> \
//     --setup .artifacts/cp4/<setup-run>/setup/setup-receipt.json \
//     --ja-model <pinned> --en-model <pinned> \
//     [--eval-build .artifacts/cp4/eval-build] [--n 30] \
//     [--phases cold,held,two-views] [--two-views-ms 60000] [--views 2]
//
// 起動は 2 回。1 回目（prep）は setup の DB の写しで Raw の vector と Chronicle の
// Index を作って閉じる。2 回目（check）は同じ workspace を開き、最初の操作として
// seed つきの begin を 1 回出す（cold start：embedding の model の初回ロードを
// 含む。§6.8 の 8）。続いて Index を作り直し、seed つきと seed なしの sample を
// AB/BA で各 N 回（§6.8 の 3〜5）、最後に 2 つの表示と連続編集（§6.8 の 9）。
// どの起動も CP-4 の launcher（NC-1 の observer、Xvfb、Wayland／D-Bus の変数の
// 除去）を使う。

import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { admitDevPreview } from "./admission.mjs";
import { loadDevFixture } from "./dev-fixture.mjs";
import { ROOT, bundleObserver } from "./launcher.mjs";
import { buildHarnessRenderer, startStaticServer } from "./renderer-build.mjs";
import {
  distribution,
  measurementSeamEnv,
  quietAtStart,
} from "./run-sample.mjs";
import { HARNESS_PAGE, sha256, startSession } from "./session.mjs";
import {
  openDataVersionProbe,
  readIndexMetadata,
  readRowCounts,
} from "./workspace-db.mjs";

const STATUS_WAIT_MS = 20_000;
const QUIET_WAIT_MS = 5_000;
const GRAPH_READY_WAIT_MS = 3_000;
export const COUNTERS = Object.freeze([
  "begins",
  "pending",
  "cacheHits",
  "preparesStarted",
  "preparesReady",
  "prepareFailures",
  "stamp0Missing",
  "stampFresh",
  "stampStale",
  "stampUnavailable",
  "driftAtQuery",
  "lateCached",
  "deferredReleased",
  "deferredExpired",
  "deferredDropped",
  "staleReadyRetired",
  "quarantines",
  "panics",
]);

function parseArgs(argv) {
  const options = {
    "eval-build": path.join(ROOT, ".artifacts/cp4/eval-build"),
    n: "30",
    phases: "cold,held,two-views",
    "two-views-ms": "60000",
    "quiet-ms": "20000",
    views: "2",
    "cold-delay-ms": "0",
    "pin-query-seed": "0",
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
  options.phases = new Set(options.phases.split(","));
  return options;
}

export const json = async (promise) => JSON.parse(await promise);

export function delta(after, before) {
  return Object.fromEntries(
    COUNTERS.map((key) => [key, (after[key] ?? 0) - (before[key] ?? 0)]),
  );
}

/** D′ の sample の前提（DR-CP4-S1C2-23）を待つ。runner の `waitQuiet` と同じ。 */
export async function waitQuiet(session, lastSeededEndedAt) {
  const started = Date.now();
  let status;
  let quiet = false;
  let cacheCleared = 0;
  while (Date.now() - started < QUIET_WAIT_MS) {
    status = await json(session.addon("nir1GraphEvalStatus"));
    if (status.owner?.slot === "empty" && status.owner?.cacheOccupied) {
      cacheCleared += (
        await json(session.addon("nir1GraphEvalClearNextQueryCache"))
      ).cleared
        ? 1
        : 0;
      status = await json(session.addon("nir1GraphEvalStatus"));
    }
    quiet = quietAtStart({
      slot: status.owner?.slot ?? null,
      cacheOccupied: status.owner?.cacheOccupied,
      sinceLastSeededMs:
        lastSeededEndedAt === null ? null : Date.now() - lastSeededEndedAt,
    });
    if (quiet) break;
    await sleep(5);
  }
  return {
    waitedMs: Date.now() - started,
    slot: status?.owner?.slot ?? null,
    cacheCleared,
    reachedQuiet: quiet,
  };
}

/** Native の begin の記録を、ID を持たない形に縮める。 */
export function nativeRows(records) {
  return records.map((record) => ({
    begin: record.begin,
    reason: record.reason ?? null,
    busyCause: record.busyCause ?? null,
    startSlot: record.startSlot?.kind ?? null,
    outcome: record.ticket?.outcome ?? null,
    disposition: record.ticket?.disposition ?? null,
    stamp: record.ticket?.freshnessStamp?.result ?? null,
    // 受渡し（`begin_deferred` の probe）から、owner thread の query の時の
    // 2 つ目の stamp の試み（release の後）と決着までの時間（eval の時計）。
    handOverToStampMs:
      record.ticket?.freshnessStamp?.attemptedAtNs != null
        ? (record.ticket.freshnessStamp.attemptedAtNs - record.tBeginNs) / 1e6
        : null,
    handOverToSettledMs:
      record.ticket?.tSettledNs != null
        ? (record.ticket.tSettledNs - record.tBeginNs) / 1e6
        : null,
  }));
}

export async function launch({
  label,
  runDir,
  server,
  observer,
  options,
  admission,
}) {
  const session = await startSession({
    runDir,
    label,
    server,
    observer,
    nativePath: path.join(
      path.resolve(options["eval-build"]),
      "grimodex-node.node",
    ),
    d2aMode: "restricted",
    models: { ja: options["ja-model"], en: options["en-model"] },
    tmpRoot: options.tmp ? path.join(options.tmp, options.run) : null,
    admission,
    extraEnv: measurementSeamEnv({
      bodyNonce: randomUUID(),
      maintenance: "product",
    }),
  });
  if (session.evidence.problems.length > 0)
    throw new Error(session.evidence.problems.join("; "));
  const started = Date.now();
  let status = await json(session.addon("nir1GraphEvalStatus"));
  while (
    Date.now() - started < STATUS_WAIT_MS &&
    !(
      status.registrations === 1 &&
      status.worker?.state === "configured" &&
      status.gateOpened === true
    )
  ) {
    await sleep(100);
    status = await json(session.addon("nir1GraphEvalStatus"));
  }
  if (
    status.registrations !== 1 ||
    status.worker?.state !== "configured" ||
    status.gateOpened !== true ||
    status.owner?.profile?.restricted !== true ||
    status.owner?.profile?.inFlightStopped !== true
  )
    throw new Error(
      `[precheck] V-10: the evaluation owner is not ready: ${JSON.stringify(status)}`,
    );
  return session;
}

export async function openWorkspace(page, workspacePath, ids) {
  const opened = await page.evaluate(
    (input) => window.cp4Harness.openWorkspace(input),
    {
      workspacePath,
      projectId: ids.projectId,
      activeSceneId: ids.querySceneId,
    },
  );
  if (!opened.ok) throw new Error(`open workspace: ${opened.error}`);
}

export async function buildIndex(page, ids) {
  const index = await page.evaluate(
    (input) => window.cp4Harness.buildIndex(input),
    { sceneId: ids.querySceneId, limitMs: 60_000 },
  );
  if (!index.ok) throw new Error("Chronicle Index build failed");
  return { durationMs: index.durationMs, probes: index.probes.length };
}

/** seed つき（または seed なし）の 1 sample と、その前後の Native の記録。 */
async function oneSample({ session, page, input, lastSeededEndedAt, dbPath }) {
  await session.addon("nir1GraphEvalClearSamples");
  const quiet = await waitQuiet(session, input.seed ? lastSeededEndedAt : null);
  const before = await json(session.addon("nir1GraphEvalDiagnostics"));
  const audit = readRowCounts(dbPath, ["ai_audit_events"]).ai_audit_events;
  const result = await page.evaluate(
    (value) => window.cp4Harness.dprime.heldSample(value),
    input,
  );
  // 保留つきの session が終わる（slot が empty に戻る）まで待ってから数える。
  const settled = await waitQuiet(session, null);
  const after = await json(session.addon("nir1GraphEvalDiagnostics"));
  const records = (await json(session.addon("nir1GraphEvalSamples"))).records;
  return {
    seeded: Boolean(input.seed),
    quiet,
    settledSlot: settled.slot,
    page: result.ok ? result.value : { error: result.error },
    native: nativeRows(records),
    counters: delta(after, before),
    auditRowsAdded:
      readRowCounts(dbPath, ["ai_audit_events"]).ai_audit_events - audit,
    endedAt: Date.now(),
  };
}

function summarizeHeld(rows) {
  const seeded = rows.filter((row) => row.seeded);
  const seedless = rows.filter((row) => !row.seeded);
  const sum = (list, key) =>
    list.reduce((total, row) => total + (row.counters[key] ?? 0), 0);
  const firstBegin = (row) => row.native[0] ?? null;
  const cachedRequery = seeded.filter((row) =>
    row.native.slice(1).some((record) => record.begin === "cached"),
  ).length;
  const firstCached = seeded.filter(
    (row) => firstBegin(row)?.begin === "cached",
  ).length;
  return {
    n: seeded.length,
    counters: Object.fromEntries(
      COUNTERS.map((key) => [key, sum(seeded, key)]),
    ),
    firstBeginCached: firstCached,
    firstOutcomes: countBy(
      seeded,
      (row) =>
        firstBegin(row)?.outcome ??
        `begin:${firstBegin(row)?.begin}:${firstBegin(row)?.reason}`,
    ),
    pageGraph: countBy(seeded, (row) =>
      row.page.graph
        ? `${row.page.graph.status}${row.page.graph.reason ? `:${row.page.graph.reason}` : ""}`
        : `begin:${JSON.stringify(row.page.begin?.graph ?? null)}`,
    ),
    graphOnly: seeded.filter((row) => row.page.graph?.graphOnly === true)
      .length,
    clicks: countBy(
      seeded.filter((row) => row.page.click),
      (row) => row.page.click.status,
    ),
    graphReady: seeded.filter((row) => (row.page.graphReady?.count ?? 0) > 0)
      .length,
    requeryCached: cachedRequery,
    requeryGraph: countBy(
      seeded.filter((row) => row.page.requery),
      (row) => row.page.requery.graph?.status ?? "none",
    ),
    notQuietAtStart: seeded.filter((row) => !row.quiet.reachedQuiet).length,
    handOverToStampMs: distribution(
      seeded
        .map((row) => firstBegin(row)?.handOverToStampMs)
        .filter(Number.isFinite),
    ),
    handOverToSettledMs: distribution(
      seeded
        .map((row) => firstBegin(row)?.handOverToSettledMs)
        .filter(Number.isFinite),
    ),
    graphAfterBeginCallMs: distribution(
      seeded
        .map((row) => row.page.graph?.sinceBeginCallMs)
        .filter(Number.isFinite),
    ),
    graphReadyAfterSettleMs: distribution(
      seeded
        .map((row) => row.page.graphReady?.afterSettleMs)
        .filter(Number.isFinite),
    ),
    rawReadyElapsedMs: {
      seeded: distribution(
        seeded
          .map((row) => row.page.begin?.rawReadyElapsedMs)
          .filter(Number.isFinite),
      ),
      seedless: distribution(
        seedless
          .map((row) => row.page.begin?.rawReadyElapsedMs)
          .filter(Number.isFinite),
      ),
    },
    beginRoundTripMs: {
      seeded: distribution(
        seeded
          .map((row) => row.page.begin?.roundTripMs)
          .filter(Number.isFinite),
      ),
      seedless: distribution(
        seedless
          .map((row) => row.page.begin?.roundTripMs)
          .filter(Number.isFinite),
      ),
    },
    auditRowsPerSeededSample: distribution(
      seeded.map((row) => row.auditRowsAdded),
    ),
    pageErrors: rows.filter((row) => row.page.error || row.page.errors?.length)
      .length,
  };
}

function countBy(rows, key) {
  const out = {};
  for (const row of rows) {
    const value = key(row);
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runDir = path.join(ROOT, ".artifacts/cp4", options.run);
  await mkdir(runDir, { recursive: false });
  const setup = JSON.parse(await readFile(path.resolve(options.setup)));
  const loaded = loadDevFixture({
    root: ROOT,
    fixturePath: setup.fixture.path,
  });
  if (loaded.sha256 !== setup.fixture.sha256)
    throw new Error("[precheck] the dev fixture changed since its setup");
  const admission = admitDevPreview({
    purpose: "dprime-check",
    fixturePath: loaded.path,
  });
  const ids = setup.logicalToRuntime;
  const seed = ids.entities[loaded.fixture.graphSeedEntityId];
  const evalDir = path.resolve(options["eval-build"]);
  const workspacePath = path.join(runDir, "workspace");
  await mkdir(workspacePath);
  const dbPath = path.join(workspacePath, "grimodex.db");
  await copyFile(path.join(ROOT, setup.coldDatabase.path), dbPath);
  const report = {
    schema: "nir1-cp4-dprime-check/1",
    diagnosticOnly: true,
    run: options.run,
    setup: path.relative(ROOT, path.resolve(options.setup)),
    evalBuild: path.relative(ROOT, evalDir),
    nodeSha256: sha256(
      await readFile(path.join(evalDir, "grimodex-node.node")),
    ),
    workerSha256: sha256(
      await readFile(path.join(evalDir, "nir1-c-query-worker")),
    ),
    n: Number(options.n),
    phases: [...options.phases],
    problems: [],
    sessions: {},
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
  const stopSession = async (label, session) => {
    if (!session) return;
    const evidence = await session.stop();
    const stderr = session.stderr();
    await writeFile(path.join(runDir, `${label}-main-stderr.log`), stderr);
    report.sessions[label] = {
      problems: evidence.problems,
      registrationRefusedInMainStderr: (
        stderr.match(/REGISTRATION_REFUSED/gu) ?? []
      ).length,
      netLogNonLoopback: evidence.netLog?.nonLoopbackAttempts ?? null,
      socketViolations: evidence.socketCheck?.violations?.length ?? null,
      dictionaries: evidence.dictionaries,
      networkPersistentServers: evidence.networkPersistentServers,
      x11Same:
        JSON.stringify(evidence.x11After) ===
        JSON.stringify(evidence.x11Before),
      remaining: evidence.stop?.remaining ?? null,
      stop: evidence.stop?.method ?? evidence.stop ?? null,
    };
    report.problems.push(...evidence.problems.map((row) => `${label}: ${row}`));
  };
  let session = null;
  let dataVersion = null;
  try {
    // 1 回目：Raw の vector と Chronicle の Index を作る。
    session = await launch({
      label: "prep",
      runDir,
      server,
      observer,
      options,
      admission,
    });
    await openWorkspace(session.page, workspacePath, ids);
    if (options["pin-query-seed"] === "1") {
      // dev fixture の query の Scene には pin が無く、製品の seed の規則
      // （最初の pin）では seed が無い。harness の seed が規則の答えになるよう、
      // 測定用の写しにだけ製品の API で pin を足す（DR-CP4-S1C2-26）。
      const before = readIndexMetadata(dbPath, ids.projectId);
      const pinned = await session.page.evaluate(
        (value) => window.cp4Harness.api.upsertScenePin(value),
        { sceneId: ids.querySceneId, entryId: seed },
      );
      report.pinQuerySeed = {
        ok: pinned.ok,
        error: pinned.error ?? null,
        indexBefore: { b: before.b, chronicle: before.chronicle },
      };
    }
    const raw = await session.page.evaluate(
      (input) => window.cp4Harness.buildRaw(input),
      {
        projectId: ids.projectId,
        label: `cp4-${options.run}`,
        sceneIds: Object.keys(ids.scenes),
        queryBody: loaded.fixture.query.body,
      },
    );
    if (!raw.ok || !raw.value.ok) throw new Error("Raw index build failed");
    report.prep = {
      rawModelWarmupMs: raw.value.modelWarmupMs,
      rawBuildMs: raw.value.buildMs,
      index: await buildIndex(session.page, ids),
    };
    if (report.pinQuerySeed) {
      const after = readIndexMetadata(dbPath, ids.projectId);
      report.pinQuerySeed.indexAfterPrep = {
        b: after.b,
        chronicle: after.chronicle,
      };
    }
    await stopSession("prep", session);
    session = null;

    // 2 回目：最初の操作が seed つきの begin（cold start）。
    session = await launch({
      label: "check",
      runDir,
      server,
      observer,
      options,
      admission,
    });
    const page = session.page;
    const launchedAt = Date.now();
    await openWorkspace(page, workspacePath, ids);
    const input = {
      workspacePath,
      projectId: ids.projectId,
      sceneId: ids.querySceneId,
      seed,
      readyWaitMs: GRAPH_READY_WAIT_MS,
    };
    if (options.phases.has("cold")) {
      // open の後、何も query せずに待つ（Index が query なしで usable になるか）。
      await sleep(Number(options["cold-delay-ms"]));
      const row = await oneSample({
        session,
        page,
        input,
        lastSeededEndedAt: null,
        dbPath,
      });
      report.cold = { sinceLaunchMs: Date.now() - launchedAt, ...row };
    }
    report.checkIndex = await buildIndex(page, ids);
    dataVersion = openDataVersionProbe(dbPath);
    if (options.phases.has("held")) {
      const rows = [];
      const diagBefore = await json(session.addon("nir1GraphEvalDiagnostics"));
      let lastSeededEndedAt = Date.now();
      for (let repeat = 0; repeat < report.n; repeat++) {
        // AB/BA：seed つきと seed なしの順を回ごとに入れ替える。
        const order = repeat % 2 === 0 ? [seed, null] : [null, seed];
        for (const value of order) {
          const dv = dataVersion.read();
          const row = await oneSample({
            session,
            page,
            input: { ...input, seed: value },
            lastSeededEndedAt,
            dbPath,
          });
          row.commitDuringSample = dataVersion.read() !== dv;
          row.repeat = repeat;
          if (value) lastSeededEndedAt = row.endedAt;
          rows.push(row);
        }
      }
      const diagAfter = await json(session.addon("nir1GraphEvalDiagnostics"));
      report.held = {
        rows,
        summary: summarizeHeld(rows),
        countersOverPhase: delta(diagAfter, diagBefore),
        unavailableAfter: diagAfter.unavailable,
        slotAfter: diagAfter.slot,
      };
    }
    if (options.phases.has("two-views")) {
      const editSceneId = Object.keys(ids.scenes).find(
        (sceneId) => sceneId !== ids.querySceneId,
      );
      await sleep(2_000);
      const before = await json(session.addon("nir1GraphEvalDiagnostics"));
      const audit = readRowCounts(dbPath, ["ai_audit_events"]).ai_audit_events;
      const result = await page.evaluate(
        (value) => window.cp4Harness.dprime.twoViews(value),
        {
          projectId: ids.projectId,
          viewSceneId: ids.querySceneId,
          seed,
          editSceneId,
          durationMs: Number(options["two-views-ms"]),
          editEveryMs: 2_000,
          quietMs: Number(options["quiet-ms"]),
          views: Number(options.views),
        },
      );
      const after = await json(session.addon("nir1GraphEvalDiagnostics"));
      report.twoViews = {
        editSceneIsQueryScene: editSceneId === ids.querySceneId,
        page: result.ok ? result.value : { error: result.error },
        counters: delta(after, before),
        auditRowsAdded:
          readRowCounts(dbPath, ["ai_audit_events"]).ai_audit_events - audit,
        unavailableAfter: after.unavailable,
        slotAfter: after.slot,
      };
      // 編集を止めた後の 1 回の seed つきの sample（owner が Suspended に
      // 残るか、Graph が戻るか）。
      await sleep(3_000);
      report.twoViews.afterProbe = await oneSample({
        session,
        page,
        input,
        lastSeededEndedAt: null,
        dbPath,
      });
    }
  } catch (error) {
    report.problems.push(error?.stack ?? String(error));
    process.exitCode = 1;
  } finally {
    dataVersion?.close();
    await stopSession("check", session).catch((error) =>
      report.problems.push(`stop: ${error?.stack ?? error}`),
    );
    await server.close();
  }
  await writeFile(
    path.join(runDir, "dprime-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const twoViews = report.twoViews?.page;
  process.stdout.write(
    `${JSON.stringify(
      {
        run: options.run,
        cold: report.cold
          ? {
              sinceLaunchMs: report.cold.sinceLaunchMs,
              native: report.cold.native,
              page: {
                begin: report.cold.page.begin,
                graph: report.cold.page.graph,
                graphReady: report.cold.page.graphReady,
              },
              counters: report.cold.counters,
            }
          : null,
        held: report.held?.summary ?? null,
        heldCountersOverPhase: report.held?.countersOverPhase ?? null,
        twoViews: report.twoViews
          ? {
              counters: report.twoViews.counters,
              auditRowsAdded: report.twoViews.auditRowsAdded,
              saves: twoViews?.saves?.length,
              savesFailed: twoViews?.saves?.filter((row) => !row.ok).length,
              duringEdits: twoViews?.duringEdits,
              afterEdits: twoViews?.afterEdits,
              error: twoViews?.error,
            }
          : null,
        sessions: report.sessions,
        problems: report.problems.map((row) => row.split("\n")[0]),
      },
      null,
      1,
    )}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename)
  await main();
