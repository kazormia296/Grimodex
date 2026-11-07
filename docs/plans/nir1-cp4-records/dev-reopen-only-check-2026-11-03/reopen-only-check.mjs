/* global window */
// dev の確認（CP-4 に数えない）: g01-negative-preview.mjs の写しから mutation の段だけを
// 外したもの。宣言 → 対照（reached）→ mutation をせずに N2 と同じ開き直し
// （reopenUntilSealed。allowUnchanged: true、readFreshness を注入）→ 同じ sample の query。
// 宣言の状態は 3 地点（宣言の直後／対照の後で閉じる前／開き直しの後）で読み、
// DB の宣言の行（narrative_scene_scope_bindings）と本文の版（tree_nodes）を
// read-only で前後に残す。repo の file は作らず変えない（出力は .artifacts と scratchpad）。

import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const BASE =
  "file:///home/grimodex/worktrees/Grimodex/claude-cp4-s4-5th/scripts/quality/nir1-graph-eval/";
const { admitDevPreview } = await import(`${BASE}admission.mjs`);
const { loadDevFixture } = await import(`${BASE}dev-fixture.mjs`);
const { buildIndex, launch, openWorkspace } = await import(
  `${BASE}dprime-check.mjs`
);
const { assessG01Negative } = await import(`${BASE}frozen-diagnostics.mjs`);
const {
  G01_GRAPH_READY_WAIT_MS,
  G01_SAMPLE_ATTEMPTS,
  askUntilDecided,
  assertG01RetryFixed,
  effectiveAnswerOf,
  g01NegativeLaunchEnv,
  g01NegativeSampleOf,
  graphInputsDigest,
  prepareG01NegativeBeforeDeclaration,
  recheckG01SpP1,
  reopenUntilSealed,
  runG01NegativeControl,
} = await import(`${BASE}g01-negatives.mjs`);
const { a3AtStartOf } = await import(`${BASE}run-sample.mjs`);
const { ROOT, bundleObserver } = await import(`${BASE}launcher.mjs`);
const { buildHarnessRenderer, startStaticServer } = await import(
  `${BASE}renderer-build.mjs`
);
const { HARNESS_PAGE, sha256, startSession } = await import(
  `${BASE}session.mjs`
);
const { captureBodyNonce, runTraceDeclaration } = await import(
  `${BASE}trace-runner.mjs`
);
const {
  readFreshnessFeed,
  readIndexMetadata,
  readQuerySceneSeedPins,
  readWorkspaceRows,
} = await import(`${BASE}workspace-db.mjs`);

const WORKTREE = "/home/grimodex/worktrees/Grimodex/claude-cp4-s4-5th";
const OUT_DIR =
  "/tmp/claude-1000/-home-grimodex-Grimodex/dd1afc24-5546-4b01-b89b-6ba9b38e5b63/scratchpad/s4-5th/reopen-check";
// admission は既存の dev の予告の purpose だけを許す（同じ値を使う）。
const PURPOSE = "g01-negative-preview";

if (ROOT !== WORKTREE)
  throw new Error(`ROOT ${ROOT} is not the worktree ${WORKTREE}`);

function parseArgs(argv) {
  const options = {
    "eval-build": path.join(ROOT, ".artifacts/cp4/eval-build"),
    samples: "3",
  };
  for (let at = 0; at < argv.length; at += 2) {
    if (!argv[at].startsWith("--") || argv[at + 1] === undefined)
      throw new Error("use --name value arguments");
    options[argv[at].slice(2)] = argv[at + 1];
  }
  if (!/^reopen-only-[A-Za-z0-9._-]+$/u.test(options.run ?? ""))
    throw new Error("--run reopen-only-<n> is required");
  for (const name of ["setup", "negative", "ja-model", "en-model"])
    if (!options[name]) throw new Error(`--${name} is required`);
  if (options.negative !== "K24-G01-N2")
    throw new Error("this check mirrors K24-G01-N2 only");
  return options;
}

async function readSeamReceipt(userData, nonce) {
  if (!nonce) return null;
  const file = path.join(
    userData,
    ".grimodex-body-declaration-ci-receipts",
    sha256(Buffer.from(nonce)),
    "receipt.json",
  );
  if (!existsSync(file)) return null;
  const bytes = await readFile(file);
  return { sha256: sha256(bytes), value: JSON.parse(bytes) };
}

const digest = (value) =>
  value == null
    ? null
    : `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;

/** 宣言の行と本文の版（read-only。本文は digest だけ）。 */
function readDeclarationRow(dbPath, projectId, sceneId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT version, source_token AS sourceToken, updated_at AS updatedAt,
                body_declaration_json AS json, body_declaration_token AS token
           FROM narrative_scene_scope_bindings WHERE project_id = ? AND scene_id = ?`,
      )
      .get(projectId, sceneId);
    const node = db
      .prepare(
        `SELECT version, updated_at AS updatedAt, char_count AS charCount, content
           FROM tree_nodes WHERE project_id = ? AND id = ?`,
      )
      .get(projectId, sceneId);
    let parsed = null;
    try {
      parsed = row?.json ? JSON.parse(row.json) : null;
    } catch {
      parsed = { parseError: true };
    }
    return {
      bindingRow: row
        ? {
            present: true,
            version: Number(row.version),
            sourceToken: row.sourceToken,
            updatedAt: row.updatedAt,
            declarationPresent: row.json != null,
            bodyDeclarationToken: row.token ?? null,
            declarationId: parsed?.declarationId ?? null,
            declaredAt: parsed?.declaredAt ?? null,
            bodySourceToken: parsed?.binding?.bodySource?.sourceToken ?? null,
            canonicalDigest: parsed?.binding?.bodySource?.canonicalDigest ?? null,
          }
        : { present: false },
      sceneBody: node
        ? {
            version: Number(node.version),
            updatedAt: node.updatedAt,
            charCount: node.charCount,
            contentSha256: digest(node.content),
          }
        : null,
    };
  } finally {
    db.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runDir = path.join(ROOT, ".artifacts/cp4", options.run);
  await mkdir(runDir, { recursive: false });
  const report = {
    devCheck: "reopen-only (no mutation); not counted in CP-4",
    run: options.run,
    startedAt: new Date().toISOString(),
    problems: [],
    sessions: [],
  };
  let server = null;
  let current = null;
  const stopCurrent = async () => {
    if (!current) return;
    const value = current;
    current = null;
    const stopped = await value.session.stop().catch((error) => ({
      problems: [`stop: ${error?.stack ?? error}`],
    }));
    await writeFile(
      path.join(runDir, `${value.label}-main-stderr.log`),
      value.session.stderr(),
    );
    report.sessions.push({
      label: value.label,
      problems: stopped.problems ?? [],
    });
    report.problems.push(...(stopped.problems ?? []));
  };
  try {
    const setup = JSON.parse(await readFile(path.resolve(options.setup)));
    const loaded = loadDevFixture({
      root: ROOT,
      fixturePath: setup.fixture.path,
    });
    if (loaded.sha256 !== setup.fixture.sha256)
      throw new Error("[precheck] the dev fixture changed since its setup");
    const fixture = loaded.fixture;
    const declared = fixture.declarations?.[0]?.sceneId;
    const pin = (fixture.pins ?? []).find((row) => row.sceneId === declared);
    if (!declared || !pin)
      throw new Error("[precheck] the dev fixture declares no pinned Scene");
    const admission = admitDevPreview({ purpose: PURPOSE, fixture: loaded });
    const map = setup.logicalToRuntime;
    const ids = {
      projectId: map.projectId,
      querySceneId: map.querySceneId,
      scenes: map.scenes,
      entities: map.entities,
    };
    const target = {
      sceneId: declared,
      entityId: pin.entityId ?? pin.entryId,
      seedEntityId: fixture.graphSeedEntityId,
      querySceneId: fixture.query.sceneId,
    };
    report.target = target;
    const seed = map.entities[target.seedEntityId];
    const materials = Object.values(map.typedRevisions ?? {}).map(
      (row) => row.revisionId,
    );
    const workspacePath = path.join(runDir, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const dbPath = path.join(workspacePath, "grimodex.db");
    await copyFile(path.resolve(ROOT, setup.coldDatabase.path), dbPath);
    await buildHarnessRenderer({
      root: ROOT,
      outDir: path.relative(ROOT, path.join(runDir, "renderer-dist")),
      input: {
        index: path.join(ROOT, "index.html"),
        harness: path.join(ROOT, HARNESS_PAGE.slice(1)),
      },
      timingShim: true,
      fetchTiming: true,
    });
    server = await startStaticServer({
      dir: path.join(runDir, "renderer-dist"),
    });
    const observer = await bundleObserver({
      outDir: path.join(runDir, "observer"),
    });
    const readIndex = () => readIndexMetadata(dbPath, ids.projectId);
    const readGraphInputs = () => readWorkspaceRows(dbPath, ids.projectId);
    const readFreshness = () => readFreshnessFeed(dbPath, ids.projectId);
    const readCounters = async () =>
      JSON.parse(await current.session.addon("nir1GraphEvalDiagnostics"));
    const declaredRuntime = map.scenes[declared];
    const readDeclRow = () =>
      readDeclarationRow(dbPath, ids.projectId, declaredRuntime);
    const readDeclState = () =>
      current.session.page.evaluate(
        (input) => window.cp4Harness.declaration.state(input),
        {
          workspacePath,
          projectId: ids.projectId,
          sceneId: declaredRuntime,
        },
      );
    const open = async (label) => {
      const bodySeam = { nonce: null };
      const session = await launch({
        label,
        runDir,
        server,
        observer,
        options,
        admission,
        start: (args) =>
          captureBodyNonce(
            startSession,
            bodySeam,
          )({
            ...args,
            extraEnv: g01NegativeLaunchEnv({
              nonce: randomUUID(),
              base: args.extraEnv ?? {},
            }),
          }),
      });
      current = { label, session, bodySeam };
      await openWorkspace(session.page, workspacePath, ids);
      return current;
    };
    await open("measure");
    report.seedPin = await current.session.page.evaluate(
      (value) => window.cp4Harness.api.upsertScenePin(value),
      { sceneId: ids.querySceneId, entryId: seed },
    );
    const raw = await current.session.page.evaluate(
      (input) => window.cp4Harness.buildRaw(input),
      {
        projectId: ids.projectId,
        label: `cp4-${options.run}`,
        sceneIds: Object.values(ids.scenes),
        queryBody: fixture.query.body,
      },
    );
    if (!raw.ok || !raw.value.ok)
      throw new Error("[artifact] the Raw index build failed");
    report.index = await buildIndex(current.session.page, ids);
    const id = options.negative;
    const before = await prepareG01NegativeBeforeDeclaration({
      id,
      page: current.session.page,
      ids,
      target,
    });
    report.beforeDeclaration = before;
    if (before.blocked) throw new Error("before-declaration blocked");
    report.declRowBeforeDeclaration = readDeclRow();
    const declaration = await runTraceDeclaration({
      page: current.session.page,
      workspacePath,
      projectId: ids.projectId,
      sceneId: declaredRuntime,
      readIndex,
      readSeam: () =>
        readSeamReceipt(current.session.userData, current.bodySeam.nonce),
      locatorDigest: sha256(Buffer.from(realpathSync(workspacePath))),
    });
    // (a) 宣言の直後
    report.declaration = {
      token: declaration.token,
      bindingDigest: declaration.bindingDigest,
      stateAfter: declaration.stateAfter?.snapshot?.state ?? null,
    };
    report.declRowAfterDeclaration = readDeclRow();
    const control = await runG01NegativeControl({
      page: current.session.page,
      ids,
      target,
      readGraphInputs,
      readCounters,
      readIndex,
    });
    report.control = control;
    report.controlFinalSceneIds = control.answer?.finalSceneIds ?? null;
    // (b) 対照の後・閉じる前（元の session）
    report.declStateBeforeReopen = await readDeclState();
    report.declRowBeforeReopen = readDeclRow();
    // ---- mutation の段を外した。N2 と同じ開き直しだけを行う ----
    const indexBefore = readIndex();
    const feedBeforeReopen = readFreshness();
    report.indexBeforeReopen = indexBefore;
    report.feedBeforeReopen = feedBeforeReopen;
    const reopened = await reopenUntilSealed({
      closeCurrent: stopCurrent,
      openSession: async ({ dirLabel }) => {
        const value = await open(dirLabel);
        return { ...value, close: stopCurrent };
      },
      readIndex,
      before: indexBefore,
      buildChronicle: async (session) =>
        buildIndex(session.session.page, ids).then(
          (value) => ({ ok: true, ...value }),
          (error) => ({ ok: false, error: String(error?.message ?? error) }),
        ),
      allowUnchanged: true,
      readFreshness,
      mutationFeedHead: feedBeforeReopen?.head ?? null,
    });
    const step = {
      id,
      mutation: null,
      indexBefore,
      sealAttempts: reopened.sealAttempts,
      blocked: reopened.ok
        ? null
        : {
            reason: reopened.reason ?? "b-seal-not-published",
            openings: reopened.sealAttempts.length,
          },
    };
    if (reopened.ok) {
      step.spP1Recheck = recheckG01SpP1({
        ids,
        target,
        read: readQuerySceneSeedPins(dbPath, ids.projectId, ids.querySceneId),
      });
      step.graphInputs = graphInputsDigest(readGraphInputs());
    }
    report.step = step;
    report.indexAfterReopen = readIndex();
    report.declRowAfterReopen = readDeclRow();
    const samples = [];
    if (!step.blocked) {
      const page = current.session.page;
      // (c) 開き直しの後
      report.declStateAfterReopen = await readDeclState();
      for (let repeat = 0; repeat < Number(options.samples); repeat++) {
        const a3 = JSON.parse(
          await current.session.addon(
            "nir1GraphEvalReadA3",
            dbPath,
            ids.projectId,
            ids.querySceneId,
            materials,
          ),
        );
        const asked = await askUntilDecided({
          ask: async () => {
            const probed = await page.evaluate(
              (input) => window.cp4Harness.diagnostic.graphProbe(input),
              {
                projectId: ids.projectId,
                sceneId: ids.querySceneId,
                seed,
                readyWaitMs: G01_GRAPH_READY_WAIT_MS,
              },
            );
            return probed?.ok ? probed.value : { error: probed?.error ?? null };
          },
          limit: G01_SAMPLE_ATTEMPTS,
          readCounters,
        });
        const probe = asked.decided
          ? asked.probe
          : {
              parent: { graphOutcome: "graph-late", finalSceneIds: [] },
              child: null,
            };
        const norm = (value) =>
          typeof value === "string" && value.startsWith("graph-unavailable")
            ? "graph-unavailable"
            : value;
        samples.push(
          g01NegativeSampleOf({
            row: {
              phase: "measured",
              repeat,
              arm: "graph",
              seed,
              graph: { outcome: norm(probe.parent.graphOutcome) },
              followUp: {
                parent: { seed },
                child: probe.child
                  ? { outcome: norm(probe.child.graphOutcome) }
                  : null,
              },
              a3AtStart: a3AtStartOf(a3),
              finalSceneIds: effectiveAnswerOf(probe).finalSceneIds,
            },
            ids,
            target,
            control,
            inputsDigest: step.graphInputs,
            retry: { limit: asked.limit, gapMs: asked.gapMs },
          }),
        );
        const answer = effectiveAnswerOf(probe);
        report.graphOutcomes ??= [];
        report.graphOutcomes.push({
          decided: asked.decided,
          graphOutcome: answer.graphOutcome,
          graphOnly: answer.graphOnly ?? null,
          tries: asked.tries,
          a3: a3AtStartOf(a3),
        });
      }
      report.declStateAfterSamples = await readDeclState();
    }
    report.samples = samples;
    assertG01RetryFixed({ control, samples });
    // N2 の意味の判定をそのまま残す（返った＝not-established。語は変えない）。
    report.assessmentAsN2 = assessG01Negative({
      id,
      blocked: step.blocked,
      spP1Recheck: step.spP1Recheck,
      samples,
      target,
    });
  } catch (error) {
    report.problems.push(error?.stack ?? String(error));
    process.exitCode = 1;
  } finally {
    await stopCurrent();
    await server?.close();
  }
  report.finishedAt = new Date().toISOString();
  const tgt = report.target?.sceneId;
  report.summary = {
    run: report.run,
    control: report.control?.status ?? null,
    controlFinalSceneIds: report.controlFinalSceneIds ?? null,
    declStateAfterDeclaration: report.declaration?.stateAfter ?? null,
    declStateBeforeReopen: report.declStateBeforeReopen?.snapshot?.state ?? null,
    declStateAfterReopen: report.declStateAfterReopen?.snapshot?.state ?? null,
    declStateAfterSamples: report.declStateAfterSamples?.snapshot?.state ?? null,
    declRowBeforeReopen: report.declRowBeforeReopen ?? null,
    declRowAfterReopen: report.declRowAfterReopen ?? null,
    sealAttempts:
      report.step?.sealAttempts?.map((row) => ({
        attempt: row.attempt,
        outcome: row.outcome,
        sealBranch: row.sealBranch,
        waitedMs: row.waitedMs,
        b: row.metadata?.b
          ? { generation: row.metadata.b.generation, dirty: row.metadata.b.dirty }
          : null,
        chronicle: row.chronicle?.metadata?.chronicle
          ? {
              generation: row.chronicle.metadata.chronicle.generation,
              dirty: row.chronicle.metadata.chronicle.dirty,
            }
          : null,
        chronicleUsable: row.chronicle?.usable ?? null,
        recheckBranch: row.chronicle?.recheckBranch ?? null,
        freshnessSettled: row.freshnessSettle?.settled ?? null,
      })) ?? null,
    indexBeforeReopen: report.indexBeforeReopen
      ? {
          b: [report.indexBeforeReopen.b?.generation, report.indexBeforeReopen.b?.dirty],
          chronicle: [
            report.indexBeforeReopen.chronicle?.generation,
            report.indexBeforeReopen.chronicle?.dirty,
          ],
        }
      : null,
    indexAfterReopen: report.indexAfterReopen
      ? {
          b: [report.indexAfterReopen.b?.generation, report.indexAfterReopen.b?.dirty],
          chronicle: [
            report.indexAfterReopen.chronicle?.generation,
            report.indexAfterReopen.chronicle?.dirty,
          ],
        }
      : null,
    spP1: report.step?.spP1Recheck?.status ?? null,
    graphInputsSameAsControl:
      report.step?.graphInputs != null
        ? report.step.graphInputs === report.control?.graphInputs
        : null,
    samples:
      report.samples?.map((row, at) => ({
        repeat: row.repeat,
        frameReached: row.frameReached,
        targetReturned: (row.returnedSceneIds ?? []).includes(tgt),
        returnedSceneIds: row.returnedSceneIds,
        graphOutcome: report.graphOutcomes?.[at]?.graphOutcome ?? null,
        decided: report.graphOutcomes?.[at]?.decided ?? null,
        tries: report.graphOutcomes?.[at]?.tries?.length ?? null,
        graphOnlyScene: report.graphOutcomes?.[at]?.graphOnly?.sceneId ?? null,
        a3Eligible: report.graphOutcomes?.[at]?.a3?.eligible ?? null,
      })) ?? null,
    assessmentAsN2: report.assessmentAsN2 ?? null,
    problems: report.problems.map((row) => row.split("\n")[0]),
  };
  const text = `${JSON.stringify({ preview: true, ...report }, null, 1)}\n`;
  await writeFile(path.join(runDir, "reopen-only.json"), text);
  await writeFile(path.join(OUT_DIR, `${options.run}.json`), text);
  await writeFile(
    path.join(OUT_DIR, `${options.run}.summary.json`),
    `${JSON.stringify(report.summary, null, 1)}\n`,
  );
  process.stdout.write(`${JSON.stringify(report.summary)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename)
  await main();
