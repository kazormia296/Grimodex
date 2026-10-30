/* global window */
// CP-4 S5-B: SP-P4 の診断の runner（DR-CP4-O-1 (3)(4)、S2 `diagnosticRuns` の
// SP-P4、SP/1 の SP-P4／SP-N7）。Graph arm を含むどの実行よりも前に取る。
//
//   frozen (④、S4 の後):
//   TMPDIR=<short scratch> node scripts/local-ci-xvfb.mjs node \
//     scripts/quality/nir1-graph-eval/diagnostic-runner.mjs --run <name> \
//     --prep-commit <S4> --k62-commit <K6/2> --k64-commit <K6/4> \
//     --product-receipt <standard-build.json> \
//     --ja-model <pinned> --en-model <pinned>
//   dev preview (the integrator only; never a CP-4 record):
//     ... diagnostic-runner.mjs --run <name> --dev-fixture <dev graph case> \
//     --variant base [--warmup 5 --measured 30] --ja-model … --en-model …
//
// For each of the 8 variants: the setup (product `.node`) runs to the step
// before the seed pin step, its closed DB is copied once, and two sides
// continue from the copy to the measurement point — one with the seed pin
// step, one without (`frozen-setup-driver.mjs` branch). Each side is then
// measured on a new copy in its own evaluation session (restricted, product
// maintenance): the Raw vectors and the Chronicle Index the same way on both
// sides, then the product fetch without a seed, warm-up 5 and measured 30,
// with the owner counters before and after each sample. An attempt with a
// non-zero `begins` delta is a setup defect, retaken once; the second is
// `[precheck]`. The sides are compared sample by sample in logical IDs; one
// difference is SP-N7 (`[precheck]`, no Graph-arm run starts).

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  admitDevPreview,
  admitGraphCaseRun,
  collectObservationPrepFacts,
  readK64FreezeHead,
} from "./admission.mjs";
import { FROZEN_FIXTURE_SHA256, GRAPH_EVAL_VARIANTS } from "./constants.mjs";
import { buildIndex, launch, openWorkspace } from "./dprime-check.mjs";
import {
  SP_P4,
  SP_P4_COMPARISON_RULE,
  SP_P4_IR_TIMEOUT_LIMIT,
  assertSpP4WorkspaceStable,
  claimFrozenAttempt,
  frozenAttemptLedger,
  spP4AttemptKey,
  assessSpP4Attempt,
  buildRunHead,
  compareSpP4Variant,
  explainSpP4Instability,
  readDiagnosticPlan,
  readRunHead,
  readTraceFileHeads,
  spP4AttemptOutcome,
  spP4IrDisclosure,
  spP4SampleRecord,
  spP4Schedule,
  spP4Targets,
  summarizeSpP4,
  writeRunHead,
} from "./frozen-diagnostics.mjs";
import {
  SP_P4_BRANCH,
  prepareDevSetupShared,
  prepareFrozenSetupShared,
  setupFrozenVariant,
} from "./frozen-setup-driver.mjs";
import {
  SETUP_STOPS,
  loadDevGraphCasePlans,
  loadFrozenSetupPlans,
} from "./frozen-setup-plan.mjs";
import { DEFAULT_ADDON, ROOT, bundleObserver } from "./launcher.mjs";
import { buildHarnessRenderer, startStaticServer } from "./renderer-build.mjs";
import { finishAttempt } from "./frozen-k64-admission.mjs";
import { loadFrozenSeedPinPlan } from "./seed-pin-setup.mjs";
import { removeSetupMain } from "./setup-main-build.mjs";
import { HARNESS_PAGE, sha256 } from "./session.mjs";

export const SP_P4_RECEIPT_SCHEMA = "nir1-cp4-sp-p4/1";
export const SP_P4_DEV_PREVIEW_PURPOSE = "sp-p4-preview";

/**
 * The receipt's `design` (the rule fields `readSpP4Gate` checks): the
 * comparison rule in force and, DR-CP4-Q-1 (C2), the IR deadline limit fixed
 * before the observation.
 */
export function spP4ReceiptDesign({ targets, warmup, measured }) {
  return {
    variants: targets.map((row) => row.variantKey),
    sides: [...SP_P4.sides],
    warmup,
    measured,
    attemptLimit: SP_P4.attemptLimit,
    d2aMode: SP_P4.d2aMode,
    compareBy: SP_P4.compareBy,
    rule: SP_P4_COMPARISON_RULE,
    irTimeoutLimit: SP_P4_IR_TIMEOUT_LIMIT,
    branch: SP_P4.branch,
    sparse:
      "the product fetchSparseSceneIds on the same saved-body query, read after the fetch (DR-CP4-O-1 (4))",
  };
}

/**
 * The SP-P4 run over its targets (injected setup and measurement; the CLI
 * passes the Electron ones). Returns the variants' records and the summary;
 * stops at the first SP-N7 or at an attempt's `[precheck]` (the records so
 * far are kept in `variants`).
 */
export async function runSpP4({
  targets,
  schedule,
  setupVariant,
  measureSide,
  warmup,
  measured,
  rule = SP_P4_COMPARISON_RULE,
}) {
  const variants = [];
  let stop = null;
  for (const target of targets) {
    const setup = await setupVariant(target);
    const record = { variantKey: target.variantKey, sides: {} };
    variants.push(record);
    for (const side of SP_P4.sides) {
      const attempts = [];
      record.sides[side] = { setup: setup.sides[side].summary, attempts };
      for (let attempt = 1; attempt <= SP_P4.attemptLimit; attempt++) {
        const result = await measureSide({
          target,
          side,
          attempt,
          setup: setup.sides[side],
          schedule,
        });
        const assessment = assessSpP4Attempt({
          samples: result.samples,
          warmup,
          measured,
        });
        const outcome = spP4AttemptOutcome({
          attempt,
          valid: assessment.valid,
        });
        attempts.push({
          side,
          attempt,
          valid: assessment.valid,
          outcome,
          counts: assessment.counts,
          invalidSamples: assessment.invalidSamples,
          // DR-CP4-O-7 (a): the IR deadline's frequency, disclosed only.
          ir: spP4IrDisclosure(result.samples),
          d2aMode: result.d2aMode,
          logicalToRuntime: result.logicalToRuntime,
          session: result.session ?? null,
          samples: result.samples,
        });
        if (outcome === "accepted") break;
        if (outcome === "precheck") {
          stop = `[precheck] SP-P4 ${target.variantKey} ${side}: attempts 1 and 2 both had a non-zero owner begins delta (a setup defect, not SP-N7); the user decides`;
          break;
        }
      }
      if (stop) break;
      const accepted = attempts.find((row) => row.valid);
      // S2 comparison: an unstable workspace stops the run with its records.
      try {
        // DR-CP4-Q-1 (C2): the IR-compared and deadline-excluded counts of
        // the accepted side, disclosed with the record.
        record.sides[side].stability = assertSpP4WorkspaceStable(
          accepted.samples,
          `${target.variantKey}:${side}`,
          { rule },
        );
      } catch (error) {
        stop = String(error?.message ?? error);
        record.sides[side].unstable = true;
        // DR-CP4-O-7 (b): disclosed apart from the [precheck].
        record.sides[side].instability = explainSpP4Instability(
          accepted.samples,
        );
        break;
      }
    }
    if (stop) break;
    const accepted = (side) =>
      record.sides[side].attempts.find((row) => row.valid).samples;
    record.comparison = compareSpP4Variant({
      variantKey: target.variantKey,
      without: accepted("without-seed-pin-step"),
      with: accepted("with-seed-pin-step"),
      rule,
    });
    if (!record.comparison.same) break;
  }
  const summary = summarizeSpP4({ variants });
  return { variants, summary, stop };
}

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
  for (const name of ["ja-model", "en-model"])
    if (!options[name]) throw new Error(`--${name} is required`);
  return options;
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

const json = async (promise) => JSON.parse(await promise);

/** One SP-P4 sample on the open measurement session. */
async function oneSample({ session, ids, scenes, at }) {
  const before = await json(session.addon("nir1GraphEvalDiagnostics"));
  const measure = await session.page.evaluate(
    (input) => window.cp4Harness.measure(input),
    { sceneId: ids.querySceneId, seed: null },
  );
  const sparse = await session.page.evaluate(
    (input) => window.cp4Harness.diagnostic.sparseSceneIds(input),
    { projectId: ids.projectId, sceneId: ids.querySceneId },
  );
  const after = await json(session.addon("nir1GraphEvalDiagnostics"));
  if (!sparse?.ok)
    throw new Error(`[artifact] SP-P4 sparse read: ${sparse?.error}`);
  const begins = (measure.ipc ?? []).filter(
    (row) => row.cmd === "related_scenes_begin",
  );
  if (begins.length !== 1 || !Array.isArray(begins[0].denseHitSceneIds))
    throw new Error(
      `[artifact] SP-P4: ${begins.length} begin rows with dense hits in one seedless fetch`,
    );
  return spP4SampleRecord({
    ...at,
    measure,
    denseHitSceneIds: begins[0].denseHitSceneIds,
    sparseSceneIds: sparse.value,
    before,
    after,
    scenes,
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dev = Boolean(options["dev-fixture"]);
  const runDir = path.join(ROOT, ".artifacts/cp4", options.run);
  await mkdir(runDir, { recursive: false });
  const report = { schema: "nir1-cp4-sp-p4-report/1", problems: [] };
  let setupShared = null;
  let server = null;
  let receiptWritten = false;
  let ledgerClaim = null;
  let claimLedger = null;
  // Review P2-α: "not-started" until a side is measured.
  let finalStatus = "not-started";
  try {
    let plans;
    let selected;
    let admission;
    let head;
    let warmup;
    let measured;
    let targets;
    if (dev) {
      plans = loadDevGraphCasePlans({
        root: ROOT,
        fixturePath: options["dev-fixture"],
        stopsAt: SETUP_STOPS.complete,
      });
      selected = plans.filter((row) => row.variantId === options.variant);
      if (selected.length !== 1)
        throw new Error(`[precheck] no dev variant ${options.variant}`);
      targets = selected.map((plan) => ({
        variantKey: plan.variantKey,
        caseId: plan.caseId,
        variantId: plan.variantId,
        querySceneId: plan.querySceneId,
      }));
      admission = admitDevPreview({
        purpose: SP_P4_DEV_PREVIEW_PURPOSE,
        fixture: null,
      });
      warmup = Number(options.warmup ?? "5");
      measured = Number(options.measured ?? "30");
      head = {
        kind: "sp-p4-preview",
        devFixture: options["dev-fixture"],
        runStartedAtUtc: new Date().toISOString(),
      };
    } else {
      // The K6/4 freeze head first (cheap).
      readK64FreezeHead({ root: ROOT, commit: options["k64-commit"] });
      plans = loadFrozenSetupPlans({
        root: ROOT,
        stopsAt: SETUP_STOPS.complete,
      });
      targets = spP4Targets({
        seedPlan: loadFrozenSeedPinPlan({ root: ROOT }),
      });
      selected = targets.map((target) =>
        plans.find((plan) => plan.variantKey === target.variantKey),
      );
      const record = collectObservationPrepFacts({
        root: ROOT,
        commit: options["prep-commit"],
        candidateHead: "HEAD",
      }).record;
      const plan = readDiagnosticPlan(record);
      warmup = plan.spP4.warmup;
      measured = plan.spP4.measured;
      const evalDir = path.resolve(options["eval-build"]);
      const fixtures = [
        ...new Set(
          GRAPH_EVAL_VARIANTS.filter((row) =>
            SP_P4.variants.includes(row.key),
          ).map((row) => row.fixturePath),
        ),
      ].map((file) => ({ path: file, sha256: FROZEN_FIXTURE_SHA256[file] }));
      admission = admitGraphCaseRun({
        root: ROOT,
        candidateHead: "HEAD",
        prepCommit: options["prep-commit"],
        buildReceipt: JSON.parse(
          readFileSync(path.join(evalDir, "eval-build.json"), "utf8"),
        ),
        productReceipt: JSON.parse(
          readFileSync(path.resolve(options["product-receipt"]), "utf8"),
        ),
        fixtures,
        defaultAddonSha256: sha256(
          readFileSync(path.join(ROOT, DEFAULT_ADDON)),
        ),
        k62Commit: options["k62-commit"],
        k64Commit: options["k64-commit"],
      });
      // Review P3 (e): one ledger claim per frozen attempt (A's ledger),
      // made after the setups, right before head.json and the measurement
      // (review P2-α: a refusal before it uses no attempt).
      claimLedger = () =>
        claimFrozenAttempt({
          kind: "sp-p4",
          key: spP4AttemptKey({
            prepCommit: admission.head.observationPrep.commit,
            candidateCommit: admission.candidateHead,
          }),
          ledger: frozenAttemptLedger({
            root: ROOT,
            candidate: {
              commit: admission.candidateHead,
              tree: git(["rev-parse", `${admission.candidateHead}^{tree}`]),
            },
            s4Commit: admission.head.observationPrep.commit,
            runName: options.run,
            startedAtUtc: new Date().toISOString(),
          }),
        });
      head = buildRunHead({
        kind: "sp-p4",
        k62: admission.head.k62,
        k64: admission.head.k64,
        observationPrep: admission.head.observationPrep,
        traces: readTraceFileHeads({ root: ROOT, traces: record?.traces }),
      });
    }
    const schedule = spP4Schedule({ warmup, measured });
    // Setups first (product `.node`), then the measurements (evaluation).
    setupShared = dev
      ? await prepareDevSetupShared({
          runDir,
          options,
          plans: selected,
          irPlans: plans,
        })
      : await prepareFrozenSetupShared({
          runDir,
          options,
          plans: selected,
          irPlans: plans,
        });
    const setups = new Map();
    for (const plan of selected) {
      const base = path.join(runDir, plan.caseId, plan.variantId);
      const pre = await setupFrozenVariant({
        plan,
        setupDir: path.join(base, "pre-step"),
        shared: setupShared,
        branch: { stage: SP_P4_BRANCH.preStep },
      });
      if (pre.receipt.status !== SP_P4_BRANCH.status["pre-step"])
        throw new Error(
          `[precheck] SP-P4 ${plan.variantKey}: the pre-step setup ended ${pre.receipt.status} (${pre.receipt.precheck?.message ?? pre.receipt.errors[0] ?? ""})`,
        );
      const sides = {};
      for (const side of SP_P4.sides) {
        const result = await setupFrozenVariant({
          plan,
          setupDir: path.join(base, side, "setup"),
          shared: setupShared,
          branch: {
            stage: SP_P4_BRANCH.side,
            side,
            carry: pre.branch.carry,
            preStepDb: pre.branch.preStepDb,
          },
        });
        if (result.receipt.status !== SP_P4_BRANCH.status.side)
          throw new Error(
            `[precheck] SP-P4 ${plan.variantKey} ${side}: the setup ended ${result.receipt.status} (${result.receipt.precheck?.message ?? result.receipt.errors[0] ?? ""})`,
          );
        sides[side] = {
          receipt: result.receipt,
          summary: {
            receipt: path.relative(ROOT, result.receiptPath),
            receiptSha256: sha256(await readFile(result.receiptPath)),
            coldDatabase: result.receipt.coldDatabase,
            seedPin: result.receipt.seedPin,
            seedPinBranch: result.receipt.seedPinBranch,
          },
        };
      }
      setups.set(plan.variantKey, {
        pre: {
          receipt: path.relative(ROOT, pre.receiptPath),
          preStepDbSha256: pre.branch.preStepDb.sha256,
        },
        sides,
      });
    }
    await setupShared.server?.close();
    removeSetupMain(setupShared.setupMain);
    const setupCandidate = setupShared.candidate;
    setupShared = null;

    // The attempt (frozen) and K6/2 事前登録の凍結 2: the head, both before
    // the measurement's first launch.
    if (claimLedger) ledgerClaim = claimLedger();
    const { sha256: headSha256 } = await writeRunHead({ runDir, head });
    // The measurement renderer (timing shim) replaces the setup's in the
    // run's one renderer directory (renderer-build.mjs allows no other), and
    // the evaluation sessions.
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
    const measureSide = async ({ target, side, attempt, setup }) => {
      finalStatus = "measured-stopped";
      const map = setup.receipt.logicalToRuntime;
      const ids = {
        projectId: map.projectId,
        querySceneId: map.scenes[target.querySceneId],
        scenes: map.scenes,
      };
      const dir = path.join(
        runDir,
        target.caseId,
        target.variantId,
        side,
        `attempt-${attempt}`,
      );
      const workspacePath = path.join(dir, "workspace");
      await mkdir(workspacePath, { recursive: true });
      await copyFile(
        path.resolve(ROOT, setup.receipt.coldDatabase.path),
        path.join(workspacePath, "grimodex.db"),
      );
      const session = await launch({
        label: "measure",
        runDir: dir,
        server,
        observer,
        options,
        admission,
      });
      const samples = [];
      let evidence = null;
      try {
        await openWorkspace(session.page, workspacePath, ids);
        const body = await session.page.evaluate(
          (sceneId) => window.cp4Harness.api.sceneText(sceneId),
          ids.querySceneId,
        );
        if (!body?.ok)
          throw new Error(`[artifact] the query Scene body: ${body?.error}`);
        const raw = await session.page.evaluate(
          (input) => window.cp4Harness.buildRaw(input),
          {
            projectId: ids.projectId,
            label: `cp4-${options.run}`,
            sceneIds: Object.values(ids.scenes),
            queryBody: body.value,
          },
        );
        if (!raw.ok || !raw.value.ok)
          throw new Error(
            `[artifact] the Raw index build failed: ${JSON.stringify(raw.ok ? { status: raw.value.status, unsearchable: raw.value.unsearchable } : raw.error).slice(0, 600)}`,
          );
        const index = await buildIndex(session.page, ids);
        for (const at of schedule)
          samples.push(
            await oneSample({ session, ids, scenes: map.scenes, at }),
          );
        evidence = { index };
      } finally {
        const stopped = await session.stop();
        await writeFile(path.join(dir, "main-stderr.log"), session.stderr());
        report.problems.push(
          ...stopped.problems.map(
            (row) => `${target.variantKey}/${side}/${attempt}: ${row}`,
          ),
        );
        evidence = { ...evidence, problems: stopped.problems };
      }
      return {
        samples,
        d2aMode: "restricted",
        logicalToRuntime: {
          scenes: { ...map.scenes },
          projectId: map.projectId,
        },
        session: evidence,
      };
    };
    const result = await runSpP4({
      targets,
      schedule,
      warmup,
      measured,
      setupVariant: async (target) => setups.get(target.variantKey),
      measureSide,
    });
    readRunHead({ runDir, sha256: headSha256 });
    const receipt = {
      schemaVersion: SP_P4_RECEIPT_SCHEMA,
      runKind: SP_P4.runKind,
      preview: dev,
      ...(dev
        ? {
            previewNote:
              "SP-P4 dev preview: seen by the integrator only; never the SP-P4 record of ④",
          }
        : {}),
      runId: options.run,
      head,
      headSha256,
      candidate: {
        commit: git(["rev-parse", "HEAD"]),
        tree: git(["rev-parse", "HEAD^{tree}"]),
        clean: git(["status", "--porcelain", "--untracked-files=all"]) === "",
        setup: setupCandidate,
        nativeSha256: sha256(
          readFileSync(
            realpathSync(
              path.join(
                path.resolve(options["eval-build"]),
                "grimodex-node.node",
              ),
            ),
          ),
        ),
      },
      design: spP4ReceiptDesign({ targets, warmup, measured }),
      setups: Object.fromEntries(
        [...setups].map(([key, value]) => [
          key,
          {
            pre: value.pre,
            sides: Object.fromEntries(
              Object.entries(value.sides).map(([side, row]) => [
                side,
                row.summary,
              ]),
            ),
          },
        ]),
      ),
      variants: result.variants,
      summary: result.summary,
      stop: result.stop,
      problems: report.problems,
    };
    await writeFile(
      path.join(runDir, "sp-p4-receipt.json"),
      `${JSON.stringify(receipt, null, 1)}\n`,
    );
    receiptWritten = true;
    process.stdout.write(
      `${JSON.stringify({ run: options.run, status: result.summary.status, stop: result.stop, variants: result.summary.variants, problems: report.problems.map((row) => row.split("\n")[0]) }, null, 1)}\n`,
    );
    if (result.summary.status !== "passed" || report.problems.length > 0)
      process.exitCode = 1;
    else finalStatus = "completed";
  } catch (error) {
    report.problems.push(error?.stack ?? String(error));
    process.exitCode = 1;
  } finally {
    await setupShared?.server?.close();
    if (setupShared) removeSetupMain(setupShared.setupMain);
    await server?.close();
    // DR-CP4-O-16: the ledger row closed with the outcome (A's ledger).
    if (ledgerClaim)
      finishAttempt({ file: ledgerClaim.file, status: finalStatus });
  }
  await writeFile(
    path.join(runDir, "run-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (!receiptWritten)
    process.stdout.write(
      `${JSON.stringify({ run: options.run, stopped: true, problems: report.problems.map((row) => row.split("\n").slice(0, 3).join(" | ")) })}\n`,
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename)
  await main();
