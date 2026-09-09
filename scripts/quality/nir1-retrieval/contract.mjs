import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadRecoveryAcceptance } from "./acceptance-policy.mjs";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateContract(manifest, corpus) {
  assert.equal(manifest.schemaVersion, "nir1-retrieval/1");
  assert.equal(corpus.schemaVersion, "nir1-retrieval-corpus/1");
  const queries = [];
  for (const language of ["ja", "en"]) {
    const section = corpus.languages[language];
    assert.ok(section.scenes.length > manifest.rawRoute.maxScenes);
    const ids = new Set(section.scenes.map((scene) => scene.id));
    assert.equal(ids.size, section.scenes.length, "duplicate scene identity");
    for (const query of section.queries) {
      assert.ok(query.currentBody.length > 0);
      assert.ok(!ids.has(query.currentSceneId));
      assert.deepEqual(new Set(query.eligibleSceneIds), ids);
      assert.deepEqual(new Set(Object.keys(query.relevanceGrades)), ids);
      assert.ok(
        Object.values(query.relevanceGrades).every(
          (g) => Number.isInteger(g) && g >= 0 && g <= 3,
        ),
      );
      assert.ok(Object.values(query.relevanceGrades).some((g) => g > 0));
      for (const scene of section.scenes)
        assert.ok(scene.order < query.currentOrder);
      for (const passage of query.requiredRawPassages) {
        const scene = section.scenes.find(
          (item) => item.id === passage.sceneId,
        );
        assert.ok(
          scene?.body.includes(passage.text),
          "required passage absent from canonical source",
        );
        assert.ok(query.relevanceGrades[passage.sceneId] > 0);
      }
      assert.equal(
        query.requiredRawPassages.length > 0,
        query.task === "raw-prose",
      );
      queries.push({ ...query, language });
    }
    assert.equal(
      section.queries.length,
      manifest.quality.languageCounts[language],
    );
    assert.equal(
      section.queries.filter((q) => q.task === "semantic").length,
      6,
    );
    assert.equal(
      section.queries.filter((q) => q.task === "raw-prose").length,
      6,
    );
    const model = manifest.models[language];
    assert.match(model.artifactSha256, /^[a-f0-9]{64}$/);
    assert.match(model.tokenizerSha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(queries.length, 24);
  assert.equal(new Set(queries.map((q) => q.id)).size, queries.length);
  assert.equal(
    corpus.forbiddenCases.length,
    manifest.quality.forbiddenCaseCount,
  );
  assert.equal(
    new Set(corpus.forbiddenCases.map((q) => q.id)).size,
    corpus.forbiddenCases.length,
  );
  for (const forbidden of corpus.forbiddenCases) {
    assert.ok(queries.some((q) => q.id === forbidden.baseQueryId));
    assert.equal(forbidden.expectedIrContributions, 0);
    if (forbidden.pool === "target-only-ir") {
      assert.equal(forbidden.expectedRaw, "exact-raw");
      assert.ok(forbidden.otherScenes.includes("Raw-only"));
    } else {
      assert.equal(forbidden.pool, "mixed-allowed-and-forbidden-ir");
      assert.ok(forbidden.allowedSceneIds.length > 0);
      assert.ok(forbidden.mustMatchAllowedOnlyControl.includes("slots"));
    }
  }
  assert.equal(
    corpus.forbiddenCases.filter((q) => q.pool === "target-only-ir").length,
    8,
  );
  assert.ok(
    corpus.forbiddenCases.filter(
      (q) => q.pool === "mixed-allowed-and-forbidden-ir",
    ).length >= 2,
  );
  assert.ok(
    queries.some(
      (q) =>
        Object.values(q.relevanceGrades).includes(1) &&
        Object.values(q.relevanceGrades).includes(2),
    ),
  );
  assert.equal(
    queries.filter((q) => q.challenge === "nonlexical-paraphrase").length,
    4,
  );
  assert.ok(queries.some((q) => q.irBenefitExpected));
  assert.equal(manifest.performance.warm.callsPerArm, queries.length * 30);
  assert.equal(manifest.performance.warm.measuredRunsPerQueryPerArm, 30);
  assert.equal(manifest.performance.warm.warmupsPerQueryPerArm, 5);
  assert.equal(
    manifest.evidenceBoundary.artificialVectorsAsQualityProof,
    false,
  );
  assert.equal(
    manifest.evidenceBoundary.existingLockedRerankerHoldoutUsed,
    false,
  );
  assert.equal(
    manifest.evidenceBoundary.sendFixtureManuscriptOrCredentialsExternally,
    false,
  );
  return queries;
}

export function nearestRank(values, percentile) {
  assert.ok(values.length > 0 && percentile > 0 && percentile <= 1);
  assert.ok(values.every((value) => Number.isFinite(value) && value >= 0));
  return [...values].sort((a, b) => a - b)[
    Math.ceil(percentile * values.length) - 1
  ];
}

export function scoreQuery(query, results, k = 8) {
  assert.ok(results.length <= k, "result exceeds the production scene cap");
  const ids = results.map((row) => row.sceneId);
  assert.equal(
    new Set(ids).size,
    ids.length,
    "duplicate scene result cannot inflate quality",
  );
  const eligible = new Set(query.eligibleSceneIds);
  assert.ok(
    ids.every((id) => eligible.has(id)),
    "unknown or ineligible scene result",
  );
  const relevant = Object.entries(query.relevanceGrades).filter(
    ([id, grade]) => eligible.has(id) && grade > 0,
  );
  assert.ok(
    relevant.length > 0,
    "zero-positive safety cases must not enter macro quality",
  );
  const dcg = (grades) =>
    grades.reduce(
      (sum, grade, i) => sum + (2 ** grade - 1) / Math.log2(i + 2),
      0,
    );
  const ideal = dcg(
    relevant
      .map(([, grade]) => grade)
      .sort((a, b) => b - a)
      .slice(0, k),
  );
  return {
    recallAt8:
      ids.filter((id) => query.relevanceGrades[id] > 0).length /
      relevant.length,
    ndcgAt8: dcg(ids.map((id) => query.relevanceGrades[id])) / ideal,
    top1SceneId: ids[0] ?? null,
    relevantRank:
      ids.findIndex((id) => query.relevanceGrades[id] > 0) + 1 || null,
    requiredRawPassagesRetained: query.requiredRawPassages.every((passage) =>
      results
        .slice(0, k)
        .some(
          (row) =>
            row.sceneId === passage.sceneId &&
            row.chunkText.includes(passage.text),
        ),
    ),
  };
}

export function summarizeQuality(cases) {
  assert.ok(cases.length > 0);
  const groups = {
    all: cases,
    semantic: cases.filter((row) => row.task === "semantic"),
    "raw-prose": cases.filter((row) => row.task === "raw-prose"),
    ja: cases.filter((row) => row.language === "ja"),
    en: cases.filter((row) => row.language === "en"),
  };
  return Object.fromEntries(
    Object.entries(groups).map(([name, rows]) => [
      name,
      {
        count: rows.length,
        recallAt8: rows.length
          ? rows.reduce((sum, row) => sum + row.metrics.recallAt8, 0) /
            rows.length
          : null,
        ndcgAt8: rows.length
          ? rows.reduce((sum, row) => sum + row.metrics.ndcgAt8, 0) /
            rows.length
          : null,
      },
    ]),
  );
}

export function summarizeWarm(calls, expectedCalls = 720) {
  const completedStates = new Set(["ok", "completed-safe-fallback"]);
  const failed = calls.filter((call) => !completedStates.has(call.status));
  const finite = calls.filter(
    (call) => Number.isFinite(call.durationMs) && call.durationMs >= 0,
  );
  const complete =
    calls.length === expectedCalls &&
    failed.length === 0 &&
    finite.length === expectedCalls;
  const finiteP95Ms = finite.length
    ? nearestRank(
        finite.map((call) => call.durationMs),
        0.95,
      )
    : null;
  return {
    status: complete ? "complete" : "blocked",
    scheduledCount: calls.length,
    expectedCount: expectedCalls,
    failedCount: failed.length,
    finiteP95Ms,
    B: complete ? finiteP95Ms : null,
    D: complete ? Math.min(100, 0.2 * finiteP95Ms) : null,
  };
}

export function validateWarmPopulation(
  calls,
  queryIds,
  repeats = 30,
  arm = "raw",
) {
  assert.equal(
    new Set(queryIds).size,
    24,
    "expected exactly 24 distinct frozen queries",
  );
  assert.equal(
    calls.length,
    queryIds.length * repeats,
    "wrong total warm population",
  );
  const expected = queryIds.flatMap((queryId) =>
    Array.from(
      { length: repeats },
      (_, repeat) => `${queryId}:${repeat}:${arm}`,
    ),
  );
  const actual = calls.map((call) => {
    assert.equal(call.phase, "measured", "warmup entered measured denominator");
    return `${call.queryId}:${call.repeat}:${call.arm}`;
  });
  assert.deepEqual(
    actual,
    expected,
    "query/arm/repetition order differs from frozen balanced schedule",
  );
}

export function validateRawIpcTrace(calls) {
  assert.ok(
    calls.every((call) => call.completed && call.ok),
    "failed or unfinished Raw IPC was swallowed by fallback",
  );
  for (const command of ["db_execute", "semantic_search", "fts_search"]) {
    assert.equal(
      calls.filter((call) => call.command === command).length,
      1,
      `expected one production ${command} dispatch`,
    );
  }
}

export async function loadContract(root, { requireFreeze = false } = {}) {
  const manifestBytes = await readFile(
    `${root}/evals/nir1-retrieval/manifest.json`,
  );
  const corpusBytes = await readFile(
    `${root}/evals/nir1-retrieval/corpus.json`,
  );
  const manifest = JSON.parse(manifestBytes);
  const corpus = JSON.parse(corpusBytes);
  const queries = validateContract(manifest, corpus);
  const digests = {
    manifestSha256: sha256(manifestBytes),
    corpusSha256: sha256(corpusBytes),
  };
  if (requireFreeze) {
    const freeze = JSON.parse(
      await readFile(`${root}/evals/nir1-retrieval/freeze.json`),
    );
    assert.equal(freeze.status, "frozen-after-independent-expectation-review");
    assert.equal(freeze.manifestSha256, digests.manifestSha256);
    assert.equal(freeze.corpusSha256, digests.corpusSha256);
    assert.ok(freeze.reviewedBy && freeze.reviewReceipt && freeze.frozenAt);
  }
  const activeAcceptance = await loadRecoveryAcceptance(
    root,
    manifest,
    digests,
  );
  return { manifest, corpus, queries, digests, activeAcceptance };
}
