/* global window */
import assert from "node:assert/strict";
import process from "node:process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  nearestRank,
  scoreQuery,
  sha256,
  summarizeQuality,
  summarizeWarm,
  validateRawIpcTrace,
  validateWarmPopulation,
} from "./contract.mjs";

export async function runPaired({
  app,
  page,
  contract,
  options,
  output,
  receipt,
  snapshotHost,
}) {
  assert.ok(
    options["prepared-setups"] && options.budget,
    "[precheck] prepared-setups and frozen budget are required",
  );
  const setupBytes = await readFile(options["prepared-setups"]);
  const setups = JSON.parse(setupBytes);
  const budgetBytes = await readFile(options.budget);
  const budget = JSON.parse(budgetBytes);
  assert.deepEqual(
    setups.contract,
    contract.digests,
    "[precheck] setup corpus differs",
  );
  assert.deepEqual(
    budget.contract,
    contract.digests,
    "[precheck] budget corpus differs",
  );
  assert.equal(budget.status, "fixed-measured-budget");
  assert.equal(
    sha256(await readFile(budget.rawReceipt)),
    budget.rawReceiptSha256,
    "[precheck] fixed Raw receipt changed",
  );
  receipt.schemaVersion = "nir1-paired-retrieval/1";
  receipt.evidenceScope =
    "fixed-corpus actual Electron Raw versus IR comparison; author-value, forbidden cases and full UI journeys are separate gates";
  receipt.setupManifest = {
    path: options["prepared-setups"],
    sha256: sha256(setupBytes),
  };
  receipt.fixedBudget = {
    path: options.budget,
    sha256: sha256(budgetBytes),
    budgetsMs: budget.budgetsMs,
  };
  receipt.warmups = [];
  receipt.qualityCases = [];
  receipt.violations = [];
  receipt.hostDuring = [];
  const diagnostic = Boolean(options["diagnostic-query"]);
  receipt.diagnosticOnly = diagnostic;
  const queries = diagnostic
    ? contract.queries.filter((q) => q.id === options["diagnostic-query"])
    : contract.queries;
  assert.ok(queries.length > 0, "[precheck] unknown diagnostic query");
  const prepare = async (query, relative) => {
    const entry = setups.cases.find((row) => row.queryId === query.id);
    assert.ok(entry, "[precheck] normal setup missing");
    const bytes = await readFile(entry.path);
    assert.equal(
      sha256(bytes),
      entry.sha256,
      "[precheck] normal setup receipt changed",
    );
    const setup = JSON.parse(bytes);
    if (setup.status === undefined) {
      // The first two normal-UI setup receipts predate per-case status. A
      // parent may stop on a later case; only its durably completed case with
      // the same exact setup hash is reusable, never the parent's missing run.
      assert.ok(entry.parentReceipt && entry.parentReceiptSha256);
      const parentBytes = await readFile(entry.parentReceipt);
      assert.equal(sha256(parentBytes), entry.parentReceiptSha256);
      const parent = JSON.parse(parentBytes);
      assert.equal(parent.normalPlannerUi, true);
      assert.deepEqual(parent.contract, contract.digests);
      const matches = parent.cases.filter(
        (row) => row.queryId === query.id && row.setupSha256 === entry.sha256,
      );
      assert.equal(
        matches.length,
        1,
        "[precheck] completed setup case missing",
      );
      assert.equal(
        path.resolve(matches[0].setupPath),
        path.resolve(entry.path),
      );
    } else assert.equal(setup.status, "setup-complete");
    assert.equal(setup.queryId, query.id);
    assert.equal(setup.currentSceneId, query.currentSceneId);
    const db = await readFile(
      path.join(path.dirname(entry.path), "cold-workspace/grimodex.db"),
    );
    assert.equal(
      sha256(db),
      setup.coldDatabaseSha256,
      "[precheck] normal cold DB changed",
    );
    const workspacePath = path.join(output, relative);
    await mkdir(workspacePath, { recursive: true });
    await writeFile(path.join(workspacePath, "grimodex.db"), db, {
      flag: "wx",
    });
    const opened = await page.evaluate(
      (input) => window.nir1Evaluation.openPrepared(input),
      {
        workspacePath,
        projectId: setup.projectId,
        language: query.language,
        query,
        scenes: contract.corpus.languages[query.language].scenes,
      },
    );
    assert.equal(
      opened.indexBefore.indexedChunkCount,
      0,
      "[precheck] build reused Raw vectors",
    );
    return {
      opened,
      setupPath: entry.path,
      setupSha256: entry.sha256,
      coldDatabaseSha256: setup.coldDatabaseSha256,
      normalApprovedChildren: setup.normalApprovedChildren,
    };
  };
  const measure = async (arm) => {
    // Drain the prior release before replacing the transparent observer buffer.
    await page.waitForTimeout(0);
    await app.evaluate(() => {
      globalThis.nir1IpcTrace.calls = [];
    });
    const sample = await page.evaluate(
      (arm) =>
        arm === "raw"
          ? window.nir1Evaluation.measureRaw()
          : window.nir1Evaluation.measureHybrid(),
      arm,
    );
    sample.ipc = await app.evaluate(() => globalThis.nir1IpcTrace.calls);
    try {
      if (arm === "raw") validateRawIpcTrace(sample.ipc);
      else {
        for (const command of [
          "db_execute",
          "related_scenes_begin",
          "fts_search",
        ])
          assert.equal(
            sample.ipc.filter((call) => call.command === command).length,
            1,
            `[artifact] hybrid ${command} dispatch`,
          );
        assert.equal(
          sample.ipc.filter((call) => call.command === "semantic_search")
            .length,
          0,
          "[artifact] hybrid re-embedded query through Raw API",
        );
        assert.ok(
          sample.ipc.every(
            (call) =>
              call.command === "related_scenes_continue" ||
              (call.completed && call.ok),
          ),
          "[artifact] failed Raw transport",
        );
      }
    } catch (error) {
      sample.status = "failed";
      sample.failures.push({ tag: "ipc-observer", message: error.message });
    }
    if (arm === "hybrid")
      sample.evidence = await page.evaluate(() =>
        window.nir1Evaluation.finalizeHybrid(),
      );
    return sample;
  };
  for (const query of queries) {
    const prepared = await prepare(query, `workspaces/${query.id}`);
    const build = await page.evaluate(() =>
      window.nir1Evaluation.buildCombined(),
    );
    const samples = { raw: [], hybrid: [] };
    for (const phase of ["warmup", "measured"]) {
      const count = diagnostic
        ? phase === "warmup"
          ? 1
          : 3
        : phase === "warmup"
          ? 5
          : 30;
      for (let repeat = 0; repeat < count; repeat++) {
        // AB, BA, AB, BA gives the predeclared ABBA paired sequence.
        const arms = repeat % 2 === 0 ? ["raw", "hybrid"] : ["hybrid", "raw"];
        const pair = {};
        for (const arm of arms) {
          const sample = {
            queryId: query.id,
            language: query.language,
            task: query.task,
            arm,
            phase,
            repeat,
            ...(await measure(arm)),
          };
          (phase === "warmup" ? receipt.warmups : receipt.warmCalls).push(
            sample,
          );
          if (phase === "measured") samples[arm].push(sample);
          pair[arm] = sample;
        }
        try {
          assert.deepEqual(
            pair.hybrid.rawScenes,
            pair.raw.results,
            "[artifact] hybrid Raw list differs from identical R",
          );
          if (pair.hybrid.result.kind === "raw")
            assert.deepEqual(
              pair.hybrid.result.scenes,
              pair.raw.results,
              "[artifact] fallback differs from exact R",
            );
          assert.ok(
            pair.hybrid.evidence.every(
              (row) => row.status === "qualified" && row.bindingMatches,
            ),
            "[artifact] returned Evidence failed second consumer validation",
          );
        } catch (error) {
          receipt.violations.push({
            queryId: query.id,
            phase,
            repeat,
            message: error.message,
          });
        }
      }
    }
    for (const arm of ["raw", "hybrid"]) {
      // Score every scheduled sample, including safe fallbacks. A sporadic IR
      // result cannot replace the quality of the other measured calls.
      const scored = samples[arm].map((sample) =>
        scoreQuery(query, sample.results),
      );
      const metrics = {
        recallAt8:
          scored.reduce((sum, x) => sum + x.recallAt8, 0) / scored.length,
        ndcgAt8: scored.reduce((sum, x) => sum + x.ndcgAt8, 0) / scored.length,
        requiredRawPassagesRetained: scored.every(
          (x) => x.requiredRawPassagesRetained,
        ),
      };
      receipt.qualityCases.push({
        queryId: query.id,
        language: query.language,
        task: query.task,
        arm,
        metrics,
        samples: scored,
        irBenefitExpected: query.irBenefitExpected,
      });
    }
    receipt.cases.push({ queryId: query.id, prepared, build });
    receipt.hostDuring.push({ queryId: query.id, ...(await snapshotHost()) });
    await writeFile(
      path.join(output, "receipt.in-progress.json"),
      JSON.stringify(receipt, null, 2),
    );
    process.stdout.write(
      `nir1 paired ${receipt.cases.length}/${queries.length}: ${query.id}\n`,
    );
  }
  if (!diagnostic)
    for (let trial = 0; trial < 5; trial++) {
      const languages = [];
      for (const language of ["ja", "en"]) {
        const query = queries.find((q) => q.language === language);
        const prepared = await prepare(
          query,
          `cold-build/${trial}-${language}`,
        );
        languages.push({
          language,
          prepared,
          ...(await page.evaluate(() => window.nir1Evaluation.buildCombined())),
        });
      }
      receipt.buildTrials.push({
        trial,
        languages,
        durationMs: languages.reduce((sum, x) => sum + x.durationMs, 0),
      });
    }
  receipt.quality = {};
  receipt.warm = {};
  receipt.warmGroups = {};
  for (const arm of ["raw", "hybrid"]) {
    const calls = receipt.warmCalls.filter((row) => row.arm === arm);
    if (!diagnostic)
      validateWarmPopulation(
        calls,
        queries.map((q) => q.id),
        30,
        arm,
      );
    receipt.quality[arm] = summarizeQuality(
      receipt.qualityCases.filter((row) => row.arm === arm),
    );
    receipt.warm[arm] = summarizeWarm(
      calls,
      queries.length * (diagnostic ? 3 : 30),
    );
    receipt.warmGroups[arm] = Object.fromEntries(
      ["ja", "en", "semantic", "raw-prose"].map((group) => {
        const selected = calls.filter(
          (row) => row.language === group || row.task === group,
        );
        const queryCount = queries.filter(
          (row) => row.language === group || row.task === group,
        ).length;
        return [
          group,
          summarizeWarm(selected, queryCount * (diagnostic ? 3 : 30)),
        ];
      }),
    );
  }
  receipt.top1Changes = queries.flatMap((query) => {
    const raw = receipt.qualityCases.find(
      (row) => row.queryId === query.id && row.arm === "raw",
    );
    const hybrid = receipt.qualityCases.find(
      (row) => row.queryId === query.id && row.arm === "hybrid",
    );
    return raw.samples.flatMap((sample, repeat) => {
      const candidate = hybrid.samples[repeat];
      if (sample.top1SceneId === candidate.top1SceneId) return [];
      const rawGrade = query.relevanceGrades[sample.top1SceneId] ?? 0;
      const hybridGrade = query.relevanceGrades[candidate.top1SceneId] ?? 0;
      return [
        {
          queryId: query.id,
          repeat,
          raw: sample.top1SceneId,
          hybrid: candidate.top1SceneId,
          rawGrade,
          hybridGrade,
          regression: hybridGrade < rawGrade,
        },
      ];
    });
  });
  const hybrid = receipt.warmCalls.filter((row) => row.arm === "hybrid");
  const denominators = hybrid.filter(
    (row) =>
      row.initialSnapshot?.indexUsable && row.initialSnapshot?.querySupported,
  );
  const timeout = denominators.filter(
    (row) => row.completion?.timeoutNumerator,
  );
  receipt.availability = {
    scheduled: hybrid.length,
    originalUsableSupported: denominators.length,
    timeoutCount: timeout.length,
    timeoutRate: denominators.length
      ? timeout.length / denominators.length
      : null,
    irReady: hybrid.filter((row) => row.completion?.outcome === "ir-ready")
      .length,
    withIr: hybrid.filter(
      (row) =>
        row.result.kind === "fused" &&
        row.result.scenes.some((scene) => scene.kind !== "raw"),
    ).length,
    availableWithoutDisplayedIr: hybrid.filter(
      (row) =>
        row.result.kind === "fused" &&
        row.result.scenes.every((scene) => scene.kind === "raw"),
    ).length,
    fallback: hybrid.filter((row) => row.result.kind === "raw").length,
    failed: hybrid.filter((row) => row.status === "failed").length,
  };
  const qualityNonregression = Object.keys(receipt.quality.raw).every((group) =>
    ["recallAt8", "ndcgAt8"].every(
      (metric) =>
        receipt.quality.hybrid[group][metric] + 1e-12 >=
        receipt.quality.raw[group][metric],
    ),
  );
  receipt.improvedCases = queries
    .filter((q) => q.irBenefitExpected)
    .filter((q) => {
      const raw = receipt.qualityCases.find(
        (row) => row.queryId === q.id && row.arm === "raw",
      );
      const ir = receipt.qualityCases.find(
        (row) => row.queryId === q.id && row.arm === "hybrid",
      );
      return ir.metrics.ndcgAt8 > raw.metrics.ndcgAt8 + 1e-12;
    })
    .map((q) => q.id);
  const combinedMedian = receipt.buildTrials.length
    ? nearestRank(
        receipt.buildTrials.map((row) => row.durationMs),
        0.5,
      )
    : null;
  receipt.gates = {
    qualityNonregression,
    predeclaredImprovement: receipt.improvedCases.length > 0,
    requiredRawPassages: receipt.qualityCases
      .filter((row) => row.arm === "hybrid")
      .every((row) => row.metrics.requiredRawPassagesRetained),
    completeWarm:
      receipt.warm.hybrid.status === "complete" &&
      receipt.warm.raw.status === "complete",
    hybridLatency:
      receipt.warm.hybrid.finiteP95Ms <= budget.budgetsMs.hybridP95Limit,
    timeoutRate:
      denominators.length > 0 && timeout.length / denominators.length <= 0.01,
    combinedBuild:
      combinedMedian !== null &&
      combinedMedian <= budget.budgetsMs.combinedBuildMedianLimit,
    parityAndEvidence: receipt.violations.length === 0,
  };
  receipt.combinedBuildMedianMs = combinedMedian;
  receipt.status = diagnostic
    ? "diagnostic-complete"
    : Object.values(receipt.gates).every(Boolean)
      ? "paired-gates-passed"
      : "hold";
  return receipt;
}
