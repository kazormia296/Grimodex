/* global window */
// CP-4 S1c-2 diagnostic (not a measurement, writes no CP-4 receipt): does a
// commit of another connection during the C-query worker's registration make
// it refuse (`NIR1_C_QUERY_STARTUP_CANONICAL_REGISTRATION_REFUSED`), and does
// the product's own Related Scenes query commit during its begin?
//
//   TMPDIR=<short scratch> node scripts/local-ci-xvfb.mjs node \
//     scripts/quality/nir1-graph-eval/diag-registration.mjs --run <name> \
//     --setup .artifacts/cp4/<setup-run>/setup/setup-receipt.json \
//     --ja-model <pinned> --en-model <pinned>
//
// One measurement-shaped Electron (product main.cjs, evaluation `.node`,
// restricted profile, product maintenance) on a copy of the dev setup DB.
// While the renderer runs a declared load, the product worker binary is
// started on the same workspace as a separate read-only process (as the
// owner starts it: empty env, its own directory as cwd, `<workspace>
// <project>`), and its startup answer (`R` = READY, or the fixed stage line)
// is recorded with the commits other connections made meanwhile
// (`PRAGMA data_version` on a read-only probe connection). Loads:
//   idle          no renderer activity
//   reads         IPC reads only (scene text), no commit expected
//   raw-queries   unseeded Related Scenes queries (product begin: audited
//                 query embedding)
// Then `owner-quiet`: seeded queries after 2 s of quiet, so the owner's own
// prepare starts at a begin with no other activity.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { admitDevPreview } from "./admission.mjs";
import { loadDevFixture } from "./dev-fixture.mjs";
import { ROOT, bundleObserver } from "./launcher.mjs";
import { buildHarnessRenderer, startStaticServer } from "./renderer-build.mjs";
import { measurementSeamEnv } from "./run-sample.mjs";
import { HARNESS_PAGE, sha256, startSession } from "./session.mjs";
import { openDataVersionProbe, readRowCounts } from "./workspace-db.mjs";

const SPAWNS_PER_LOAD = 20;

function parseArgs(argv) {
  const options = {
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
  return options;
}

/** One standalone worker start is bounded (B P3: no hang, no lost error). */
const WORKER_START_TIMEOUT_MS = 30_000;

/** One standalone worker start; resolves with its answer and timing. */
function startWorker(worker, workspace, project) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(worker, [workspace, project], {
      cwd: path.dirname(worker),
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
      timeout: WORKER_START_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    child.on("error", (error) => {
      resolve({
        ready: false,
        readyMs: null,
        exitMs: Number(process.hrtime.bigint() - started) / 1e6,
        code: null,
        stage: `spawn-error:${error?.code ?? "unknown"}`,
      });
    });
    let stdout = "";
    let stderr = "";
    let readyMs = null;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (readyMs === null && stdout.startsWith("R"))
        readyMs = Number(process.hrtime.bigint() - started) / 1e6;
      child.stdin.end();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code) => {
      resolve({
        ready: stdout.startsWith("R"),
        readyMs,
        exitMs: Number(process.hrtime.bigint() - started) / 1e6,
        code,
        stage: stderr.split("\n")[0].slice(0, 80) || null,
      });
    });
  });
}

async function workerSeries({ worker, workspace, project, dataVersion }) {
  const rows = [];
  for (let at = 0; at < SPAWNS_PER_LOAD; at++) {
    const before = dataVersion.read();
    const result = await startWorker(worker, workspace, project);
    const after = dataVersion.read();
    rows.push({ ...result, commitsDuring: after !== before });
    await sleep(150);
  }
  return {
    n: rows.length,
    ready: rows.filter((row) => row.ready).length,
    refused: rows.filter((row) => /REGISTRATION_REFUSED/u.test(row.stage ?? ""))
      .length,
    withCommit: rows.filter((row) => row.commitsDuring).length,
    readyWithCommit: rows.filter((row) => row.ready && row.commitsDuring)
      .length,
    refusedWithoutCommit: rows.filter((row) => !row.ready && !row.commitsDuring)
      .length,
    readyMsP50:
      rows
        .map((row) => row.readyMs)
        .filter(Number.isFinite)
        .sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? null,
    rows,
  };
}

async function withLoad(page, kind, body) {
  let running = true;
  let iterations = 0;
  const loop = (async () => {
    while (running) {
      if (kind === "reads")
        await page.evaluate(
          (id) => window.cp4Harness.api.sceneText(id),
          "cp4-dev-margin",
        );
      else if (kind === "raw-queries")
        await page.evaluate((input) => window.cp4Harness.measure(input), {
          sceneId: "cp4-dev-query",
          seed: null,
        });
      else await sleep(50);
      iterations += 1;
    }
  })();
  try {
    return { ...(await body()), loadIterations: iterations };
  } finally {
    running = false;
    await loop;
  }
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
  const ids = setup.logicalToRuntime;
  const seed = ids.entities[loaded.fixture.graphSeedEntityId];
  const evalDir = path.resolve(options["eval-build"]);
  const nativePath = path.join(evalDir, "grimodex-node.node");
  const worker = path.join(evalDir, "nir1-c-query-worker");
  const workspace = path.join(runDir, "workspace");
  await mkdir(workspace);
  const dbPath = path.join(workspace, "grimodex.db");
  await copyFile(path.join(ROOT, setup.coldDatabase.path), dbPath);
  const report = {
    schema: "nir1-cp4-diag-registration/1",
    diagnosticOnly: true,
    run: options.run,
    setup: path.relative(ROOT, path.resolve(options.setup)),
    workerSha256: sha256(await readFile(worker)),
    phases: {},
    problems: [],
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
  const session = await startSession({
    runDir,
    label: "session",
    server,
    observer,
    nativePath,
    d2aMode: "restricted",
    models: { ja: options["ja-model"], en: options["en-model"] },
    tmpRoot: options.tmp ? path.join(options.tmp, options.run) : null,
    admission: admitDevPreview({
      purpose: "diag-registration",
      fixturePath: loaded.path,
    }),
    extraEnv: measurementSeamEnv({
      bodyNonce: randomUUID(),
      maintenance: "product",
    }),
  });
  let dataVersion;
  try {
    if (session.evidence.problems.length > 0)
      throw new Error(session.evidence.problems.join("; "));
    const page = session.page;
    const opened = await page.evaluate(
      (input) => window.cp4Harness.openWorkspace(input),
      {
        workspacePath: workspace,
        projectId: ids.projectId,
        activeSceneId: ids.querySceneId,
      },
    );
    if (!opened.ok) throw new Error(opened.error);
    const raw = await page.evaluate(
      (input) => window.cp4Harness.buildRaw(input),
      {
        projectId: ids.projectId,
        label: `cp4-${options.run}`,
        sceneIds: Object.keys(ids.scenes),
        queryBody: loaded.fixture.query.body,
      },
    );
    if (!raw.ok || !raw.value.ok) throw new Error("Raw index build failed");
    const index = await page.evaluate(
      (input) => window.cp4Harness.buildIndex(input),
      {
        sceneId: ids.querySceneId,
        limitMs: 60_000,
      },
    );
    if (!index.ok) throw new Error("Chronicle Index build failed");
    dataVersion = openDataVersionProbe(dbPath);
    await sleep(2_000);
    for (const kind of ["idle", "reads", "raw-queries"]) {
      const before = readRowCounts(dbPath, ["ai_audit_events"]);
      report.phases[kind] = await withLoad(page, kind, () =>
        workerSeries({
          worker,
          workspace,
          project: ids.projectId,
          dataVersion,
        }),
      );
      report.phases[kind].auditRowsAdded =
        readRowCounts(dbPath, ["ai_audit_events"]).ai_audit_events -
        before.ai_audit_events;
      await sleep(2_000);
    }
    // The owner's own prepare from a seeded begin after quiet.
    const ownerRows = [];
    for (let at = 0; at < 5; at++) {
      await sleep(2_000);
      const diagBefore = JSON.parse(
        await session.addon("nir1GraphEvalDiagnostics"),
      );
      const dv = dataVersion.read();
      const measure = await page.evaluate(
        (input) => window.cp4Harness.measure(input),
        {
          sceneId: ids.querySceneId,
          seed,
        },
      );
      await sleep(1_500);
      const diagAfter = JSON.parse(
        await session.addon("nir1GraphEvalDiagnostics"),
      );
      ownerRows.push({
        graphOutcome: measure.graphOutcome,
        commitsAroundBegin: dataVersion.read() !== dv,
        preparesStarted: diagAfter.preparesStarted - diagBefore.preparesStarted,
        preparesReady: diagAfter.preparesReady - diagBefore.preparesReady,
        prepareFailures: diagAfter.prepareFailures - diagBefore.prepareFailures,
        driftAtQuery: diagAfter.driftAtQuery - diagBefore.driftAtQuery,
        slot: diagAfter.slot,
      });
    }
    report.phases["owner-quiet"] = { rows: ownerRows };
  } catch (error) {
    report.problems.push(error?.stack ?? String(error));
    process.exitCode = 1;
  } finally {
    dataVersion?.close();
    report.session = await session.stop();
    await server.close();
  }
  report.problems.push(...(report.session?.problems ?? []));
  await writeFile(
    path.join(runDir, "diag-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  const summary = Object.fromEntries(
    Object.entries(report.phases).map(([kind, phase]) => [
      kind,
      phase.rows && !phase.n
        ? phase.rows
        : {
            n: phase.n,
            ready: phase.ready,
            refused: phase.refused,
            withCommit: phase.withCommit,
            readyWithCommit: phase.readyWithCommit,
            refusedWithoutCommit: phase.refusedWithoutCommit,
            readyMsP50: phase.readyMsP50,
            loadIterations: phase.loadIterations,
            auditRowsAdded: phase.auditRowsAdded,
          },
    ]),
  );
  process.stdout.write(
    `${JSON.stringify({ summary, problems: report.problems.map((row) => row.split("\n")[0]), netLog: report.session?.netLog?.nonLoopbackAttempts, stop: report.session?.stop }, null, 1)}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename)
  await main();
