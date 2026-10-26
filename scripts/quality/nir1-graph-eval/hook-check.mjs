/* global window */
// CP-4 H5 の実現可能性の診断（DR-CP4-S1C2-27）。製品の `useNir1RelatedScenes`
// を harness の page に mount し、`graph-ready` の後の再 query（子）が自分の D の
// 窓（子の Raw-ready ＋ 10.84 ms）に Graph を届けるかを測る。CP-4 の測定（S5）
// ではなく、receipt は書かない。freeze の根拠にしない。
//
//   TMPDIR=<short scratch> node scripts/local-ci-xvfb.mjs node \
//     scripts/quality/nir1-graph-eval/hook-check.mjs --run <name> \
//     --setup .artifacts/cp4/<setup-run>/setup/setup-receipt.json \
//     --ja-model <pinned> --en-model <pinned> [--n 30]
//
// 起動は 2 回（dprime-check.mjs と同じ）：prep で query の Scene に seed の pin
// を足し（測定用の写しだけ。DR-CP4-S1C2-26）、Raw の vector と Chronicle の
// Index を作る。check で同じ workspace を開き、Index を作り直してから N 回、
// 各回は D′ の前提（DR-CP4-S1C2-23）を待って hook を mount する。

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { GRAPH_EVAL_D_MS } from "./constants.mjs";
import { admitDevPreview } from "./admission.mjs";
import { loadDevFixture } from "./dev-fixture.mjs";
import {
  buildIndex,
  delta,
  json,
  launch,
  nativeRows,
  openWorkspace,
  waitQuiet,
} from "./dprime-check.mjs";
import { ROOT, bundleObserver } from "./launcher.mjs";
import { buildHarnessRenderer, startStaticServer } from "./renderer-build.mjs";
import { distribution } from "./run-sample.mjs";
import { HARNESS_PAGE, sha256 } from "./session.mjs";
import { readRowCounts } from "./workspace-db.mjs";

// P3-11: D is read from constants.mjs only (the product compares with
// 10.840000000596048; the 6e-7 ms difference is within BOUNDARY_TOLERANCE_MS).
const D_MS = GRAPH_EVAL_D_MS;
const GRAPH_CONTINUE = "related_scenes_graph_continue";

function parseArgs(argv) {
  const options = {
    "eval-build": path.join(ROOT, ".artifacts/cp4/eval-build"),
    n: "30",
    "limit-ms": "8000",
    "settle-ms": "2500",
    "hold-ms": "300",
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
  return options;
}

const within = (row, from, to) =>
  row.startedAt >= from && (to === null || row.startedAt <= to);

/** 1 つの公開された fetch と、その間の wrapper／transport の行。 */
function fetchView(result, sample) {
  const from = result.timing.tFetchMs;
  const to = result.timing.tReturnMs;
  const api = sample.api.filter(
    (row) => row.calledAt >= from && row.calledAt <= to,
  );
  const bridge = sample.bridge.filter((row) => within(row, from, to));
  const graphApi = api.find(
    (row) => row.cmd === GRAPH_CONTINUE && row.settle === null,
  );
  const graphBridge = bridge.find(
    (row) => row.cmd === GRAPH_CONTINUE && !row.settle,
  );
  const irBridge = bridge.find((row) => row.cmd === "related_scenes_continue");
  const beginBridge = bridge.find((row) => row.cmd === "related_scenes_begin");
  const rawReady = result.timing.tRawReadyMs;
  const windowEnd = rawReady === null ? null : rawReady + D_MS;
  const rel = (value) =>
    value === null || value === undefined || rawReady === null
      ? null
      : value - rawReady;
  return {
    status: result.status,
    graphOutcome: result.graphOutcome,
    completion: result.completion,
    resultKind: result.resultKind,
    irStatus: result.irStatus,
    irReason: result.irReason,
    graph: result.graph,
    sceneCount: result.sceneCount,
    nativeRawReadyElapsedMs: result.timing.native?.rawReadyElapsedMs ?? null,
    tFetchMs: from,
    tRawReadyMs: rawReady,
    tReturnMs: to,
    windowEndMs: windowEnd,
    // 時刻は Raw-ready からの ms（負は Raw-ready より前）。
    beginBridgeMs: beginBridge
      ? beginBridge.endedAt - beginBridge.startedAt
      : null,
    fetchToBeginEndMs: beginBridge ? beginBridge.endedAt - from : null,
    irStartRel: rel(irBridge?.startedAt),
    irEndRel: rel(irBridge?.endedAt),
    irBridgeMs: irBridge ? irBridge.endedAt - irBridge.startedAt : null,
    graphCallRel: rel(graphApi?.calledAt),
    graphStartRel: rel(graphBridge?.startedAt),
    graphEndRel: rel(graphBridge?.endedAt),
    graphResolvedRel: rel(graphApi?.resolvedAt),
    graphQueueMs:
      graphApi && graphBridge
        ? graphBridge.startedAt - graphApi.calledAt
        : null,
    graphBridgeMs: graphBridge
      ? graphBridge.endedAt - graphBridge.startedAt
      : null,
    graphStatus: graphApi?.status ?? null,
    graphReason: graphApi?.reason ?? null,
    graphInWindow:
      graphApi?.resolvedAt != null && windowEnd !== null
        ? graphApi.resolvedAt < windowEnd
        : null,
    returnRel: rel(to),
  };
}

/** sample の時系列を、親・通知・子・commit に分ける。 */
function analyzeSample(sample) {
  const published = [];
  const seen = new Set();
  for (const commit of sample.commits) {
    if (!commit.result) continue;
    const key = commit.result.timing.tFetchMs;
    if (seen.has(key)) continue;
    seen.add(key);
    published.push({ commit, result: commit.result });
  }
  const parent = published[0] ?? null;
  const notice = parent
    ? (sample.notices.find(
        (row) =>
          row.kind === "graph-ready" && row.at >= parent.result.timing.tFetchMs,
      ) ?? null)
    : null;
  const child = notice
    ? (published.find((row) => row.result.timing.tFetchMs > notice.at) ?? null)
    : null;
  const nullCommit = notice
    ? (sample.commits.find((row) => row.at >= notice.at && !row.fetch) ?? null)
    : null;
  const tRaw = parent?.result.timing.tRawReadyMs ?? null;
  const releases = sample.bridge
    .filter((row) => row.cmd === "related_scenes_release" && row.endedAt)
    .map((row) => row.endedAt - row.startedAt);
  const settles = sample.bridge
    .filter((row) => row.cmd === GRAPH_CONTINUE && row.settle && row.endedAt)
    .map((row) => row.endedAt - row.startedAt);
  return {
    stop: sample.stop,
    published: published.length,
    publishedOutcomes: published.map((row) => row.result.graphOutcome),
    graphReadyNotices: sample.notices.filter(
      (row) => row.kind === "graph-ready",
    ).length,
    indexReadyNotices: sample.notices.filter(
      (row) => row.kind === "index-ready",
    ).length,
    mountToParentFetchMs: parent
      ? parent.result.timing.tFetchMs - sample.mountedAt
      : null,
    parent: parent ? fetchView(parent.result, sample) : null,
    parentCommitRel: parent && tRaw !== null ? parent.commit.at - tRaw : null,
    noticeRel: notice && tRaw !== null ? notice.at - tRaw : null,
    noticeAfterParentReturnMs:
      notice && parent ? notice.at - parent.result.timing.tReturnMs : null,
    loadingStartRel: nullCommit && tRaw !== null ? nullCommit.at - tRaw : null,
    noticeToChildFetchMs:
      notice && child ? child.result.timing.tFetchMs - notice.at : null,
    child: child ? fetchView(child.result, sample) : null,
    followReturnRel:
      child && tRaw !== null ? child.result.timing.tReturnMs - tRaw : null,
    followCommitRel: child && tRaw !== null ? child.commit.at - tRaw : null,
    loadingMs: nullCommit && child ? child.commit.at - nullCommit.at : null,
    releaseBridgeMs: releases,
    settleBridgeMs: settles,
    bridgeCmds: [...new Set(sample.bridge.map((row) => row.cmd))].sort(),
  };
}

const finite = (rows, pick) => rows.map(pick).filter(Number.isFinite);

function countBy(rows, key) {
  const out = {};
  for (const row of rows) {
    const value = String(key(row));
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

function summarize(rows) {
  const ok = rows.filter((row) => row.analysis);
  const a = ok.map((row) => row.analysis);
  const children = a.filter((row) => row.child);
  const d = (pick, list = a) => distribution(finite(list, pick));
  return {
    n: rows.length,
    pageErrors: rows.filter((row) => !row.analysis).length,
    stop: countBy(a, (row) => row.stop),
    parentOutcome: countBy(a, (row) => row.parent?.graphOutcome ?? "none"),
    parentCompletion: countBy(
      a,
      (row) => row.parent?.completion?.outcome ?? "none",
    ),
    graphReadyNotices: countBy(a, (row) => row.graphReadyNotices),
    indexReadyNotices: countBy(a, (row) => row.indexReadyNotices),
    publishedOutcomes: countBy(a, (row) => row.publishedOutcomes.join(">")),
    childSceneCountSame: children.filter(
      (row) => row.child.sceneCount === row.parent?.sceneCount,
    ).length,
    childPresent: children.length,
    childOutcome: countBy(a, (row) => row.child?.graphOutcome ?? "no-child"),
    childGraphStatus: countBy(
      children,
      (row) =>
        `${row.child.graphStatus}${row.child.graphReason ? `:${row.child.graphReason}` : ""}`,
    ),
    childGraphInWindow: countBy(children, (row) => row.child.graphInWindow),
    childCompletion: countBy(
      children,
      (row) => row.child.completion?.outcome ?? "none",
    ),
    nativeBegins: countBy(rows, (row) =>
      (row.native ?? []).map((record) => record.begin).join(">"),
    ),
    childCachedAtNative: rows.filter(
      (row) => row.native?.[1]?.begin === "cached",
    ).length,
    tNoticeRel: d((row) => row.noticeRel),
    noticeAfterParentReturnMs: d((row) => row.noticeAfterParentReturnMs),
    loadingStartRel: d((row) => row.loadingStartRel),
    noticeToChildFetchMs: d((row) => row.noticeToChildFetchMs),
    tFollowReturnRel: d((row) => row.followReturnRel),
    tFollowCommitRel: d((row) => row.followCommitRel),
    loadingMs: d((row) => row.loadingMs),
    parentCommitRel: d((row) => row.parentCommitRel),
    mountToParentFetchMs: d((row) => row.mountToParentFetchMs),
    parent: {
      nativeRawReadyElapsedMs: d((row) => row.parent?.nativeRawReadyElapsedMs),
      fetchToBeginEndMs: d((row) => row.parent?.fetchToBeginEndMs),
      irEndRel: d((row) => row.parent?.irEndRel),
      graphResolvedRel: d((row) => row.parent?.graphResolvedRel),
    },
    child: {
      nativeRawReadyElapsedMs: d(
        (row) => row.child.nativeRawReadyElapsedMs,
        children,
      ),
      beginBridgeMs: d((row) => row.child.beginBridgeMs, children),
      fetchToBeginEndMs: d((row) => row.child.fetchToBeginEndMs, children),
      irStartRel: d((row) => row.child.irStartRel, children),
      irEndRel: d((row) => row.child.irEndRel, children),
      irBridgeMs: d((row) => row.child.irBridgeMs, children),
      graphCallRel: d((row) => row.child.graphCallRel, children),
      graphQueueMs: d((row) => row.child.graphQueueMs, children),
      graphStartRel: d((row) => row.child.graphStartRel, children),
      graphBridgeMs: d((row) => row.child.graphBridgeMs, children),
      graphEndRel: d((row) => row.child.graphEndRel, children),
      graphResolvedRel: d((row) => row.child.graphResolvedRel, children),
      returnRel: d((row) => row.child.returnRel, children),
    },
    releaseBridgeMs: distribution(a.flatMap((row) => row.releaseBridgeMs)),
    settleBridgeMs: distribution(a.flatMap((row) => row.settleBridgeMs)),
    notQuietAtStart: rows.filter((row) => !row.quiet.reachedQuiet).length,
    counters: Object.fromEntries(
      Object.keys(rows[0]?.counters ?? {}).map((key) => [
        key,
        rows.reduce((sum, row) => sum + (row.counters?.[key] ?? 0), 0),
      ]),
    ),
  };
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
  const admission = admitDevPreview({
    purpose: "hook-check",
    fixture: loaded,
  });
  if (loaded.sha256 !== setup.fixture.sha256)
    throw new Error("[precheck] the dev fixture changed since its setup");
  const ids = setup.logicalToRuntime;
  const seed = ids.entities[loaded.fixture.graphSeedEntityId];
  const evalDir = path.resolve(options["eval-build"]);
  const workspacePath = path.join(runDir, "workspace");
  await mkdir(workspacePath);
  const dbPath = path.join(workspacePath, "grimodex.db");
  await copyFile(path.join(ROOT, setup.coldDatabase.path), dbPath);
  const report = {
    schema: "nir1-cp4-hook-check/1",
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
    dMs: D_MS,
    n: Number(options.n),
    problems: [],
    sessions: {},
  };
  report.rendererBuild = await buildHarnessRenderer({
    root: ROOT,
    outDir: path.relative(ROOT, path.join(runDir, "renderer-dist")),
    input: {
      index: path.join(ROOT, "index.html"),
      harness: path.join(ROOT, HARNESS_PAGE.slice(1)),
    },
    timingShim: true,
    bridgeTiming: true,
  });
  delete report.rendererBuild.files;
  const server = await startStaticServer({
    dir: path.join(runDir, "renderer-dist"),
  });
  const observer = await bundleObserver({
    outDir: path.join(runDir, "observer"),
  });
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
  const launchOptions = { ...options };
  let session = null;
  try {
    session = await launch({
      label: "prep",
      runDir,
      server,
      observer,
      options: launchOptions,
      admission,
    });
    await openWorkspace(session.page, workspacePath, ids);
    const pinned = await session.page.evaluate(
      (value) => window.cp4Harness.api.upsertScenePin(value),
      { sceneId: ids.querySceneId, entryId: seed },
    );
    report.pinQuerySeed = { ok: pinned.ok, error: pinned.error ?? null };
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
    report.prep = { index: await buildIndex(session.page, ids) };
    await stopSession("prep", session);
    session = null;

    session = await launch({
      label: "check",
      runDir,
      server,
      observer,
      options: launchOptions,
      admission,
    });
    const page = session.page;
    await openWorkspace(page, workspacePath, ids);
    const prepared = await page.evaluate(
      (input) => window.cp4Harness.hook.prepare(input),
      { workspacePath },
    );
    report.prepared = prepared;
    if (!prepared.ok || !prepared.value.bridgeTimingInstalled)
      throw new Error(`hook prepare: ${JSON.stringify(prepared)}`);
    report.checkIndex = await buildIndex(page, ids);
    const rows = [];
    let lastSeededEndedAt = Date.now();
    for (let repeat = 0; repeat < report.n; repeat++) {
      await session.addon("nir1GraphEvalClearSamples");
      const quiet = await waitQuiet(session, lastSeededEndedAt);
      const before = await json(session.addon("nir1GraphEvalDiagnostics"));
      const audit = readRowCounts(dbPath, ["ai_audit_events"]).ai_audit_events;
      const result = await page.evaluate(
        (input) => window.cp4Harness.hook.sample(input),
        {
          projectId: ids.projectId,
          limitMs: Number(options["limit-ms"]),
          settleMs: Number(options["settle-ms"]),
          holdMs: Number(options["hold-ms"]),
        },
      );
      const settled = await waitQuiet(session, null);
      const after = await json(session.addon("nir1GraphEvalDiagnostics"));
      const records = (await json(session.addon("nir1GraphEvalSamples")))
        .records;
      lastSeededEndedAt = Date.now();
      const row = {
        repeat,
        quiet,
        settledSlot: settled.slot,
        native: nativeRows(records),
        counters: delta(after, before),
        auditRowsAdded:
          readRowCounts(dbPath, ["ai_audit_events"]).ai_audit_events - audit,
        error: result.ok ? null : result.error,
        analysis: result.ok ? analyzeSample(result.value) : null,
        raw: result.ok ? result.value : null,
      };
      rows.push(row);
      process.stderr.write(
        `[hook-check] ${repeat}: ${row.analysis?.parent?.graphOutcome} -> ${row.analysis?.child?.graphOutcome ?? "no-child"} (${row.native.map((r) => r.begin).join(">")})\n`,
      );
    }
    report.rows = rows;
    report.summary = summarize(rows);
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
  // B-2: a problem seen at a stop fails the check as much as a thrown error.
  if (report.problems.length > 0) process.exitCode = 1;
  await writeFile(
    path.join(runDir, "hook-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        run: options.run,
        summary: report.summary ?? null,
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
