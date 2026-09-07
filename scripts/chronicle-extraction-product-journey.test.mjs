import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { URL } from "node:url";
import {
  PRODUCT_CONTRACT_REQUIREMENTS,
  PRODUCT_DOMAIN_RULES,
  PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_COVERAGE_BACKLOG,
} from "../electron/scripts/product-journey-catalog.mjs";
import { selectProductJourneys } from "../electron/scripts/product-journey-impact.mjs";
import { PRODUCT_JOURNEYS } from "../electron/scripts/product-journeys.mjs";
import {
  showChronicleFixturePanel,
  observeChronicleBeforeReview,
  assertChronicleApplied,
  analyzeChronicleAndWaitForProposals,
  readChronicleSynthesisCompanion,
  setupChronicleFixtureApplyPolicy,
  waitForChronicleFixtureWorkspace,
} from "../electron/scripts/chronicle-extraction-product-journey.mjs";
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../electron/shared/productJourneyChronicleFixture.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const DIGEST = `sha256:${"a".repeat(64)}`;

function workspaceReadinessHarness(results) {
  const calls = [];
  const swallowed = [];
  const harness = {
    invokeOk: async (_page, command, args) => {
      calls.push({ command, args });
      assert.equal(command, "db_execute");
      assert.deepEqual(args, {
        sql: "SELECT id, project_id AS projectId FROM tree_nodes WHERE id = ? AND project_id = ? AND node_type = 'scene'",
        params: ["scene-1", "project-1"],
        method: "all",
      });
      const next = results[calls.length - 1];
      if (next instanceof Error) throw next;
      return { rows: next };
    },
    waitUntil: async (predicate, label, timeout) => {
      assert.equal(label, "the exact Chronicle fixture workspace is ready");
      assert.equal(timeout, 30_000);
      for (let index = 0; index < results.length; index += 1) {
        try {
          const outcome = await predicate();
          if (outcome) return outcome;
        } catch (error) {
          swallowed.push(error);
        }
      }
      throw new Error("fixture workspace timeout");
    },
  };
  return { harness, calls, swallowed };
}

test("fixture startup waits through no open workspace, switching, and an absent scene until the exact scene is ready", async () => {
  const { harness, calls, swallowed } = workspaceReadinessHarness([
    new Error("db_execute rejected: No workspace is open"),
    new Error(
      "db_execute rejected: WORKSPACE_SWITCHING: workspace is switching",
    ),
    [],
    [{ id: "scene-1", projectId: "project-1" }],
  ]);
  await waitForChronicleFixtureWorkspace(
    harness,
    {},
    { projectId: "project-1", sceneId: "scene-1" },
  );
  assert.equal(calls.length, 4);
  assert.deepEqual(swallowed, []);
});

test("fixture startup propagates unexpected errors outside the retry predicate without retrying", async () => {
  for (const error of [
    new Error("db_execute rejected: WORKSPACE_SAFE_MODE"),
    new Error("transport failure mentioning WORKSPACE_SWITCHING"),
    new Error("db_execute rejected: No workspace is open: unexpected suffix"),
    new Error("db_execute rejected: No workspace is opened"),
  ]) {
    const { harness, calls, swallowed } = workspaceReadinessHarness([
      error,
      [],
    ]);
    await assert.rejects(
      waitForChronicleFixtureWorkspace(
        harness,
        {},
        { projectId: "project-1", sceneId: "scene-1" },
      ),
      (actual) => actual === error,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(swallowed, []);
  }
});

test("fixture startup rejects a duplicate or mismatched scene instead of accepting workspace readiness", async () => {
  for (const scenes of [
    [
      { id: "scene-1", projectId: "project-1" },
      { id: "scene-1", projectId: "project-1" },
    ],
    [{ id: "other-scene", projectId: "project-1" }],
    [{ id: "scene-1", projectId: "other-project" }],
  ]) {
    const { harness, calls, swallowed } = workspaceReadinessHarness([
      scenes,
      [],
    ]);
    await assert.rejects(
      waitForChronicleFixtureWorkspace(
        harness,
        {},
        { projectId: "project-1", sceneId: "scene-1" },
      ),
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(swallowed, []);
  }
});

function policyFixture(flags = {}) {
  return {
    runtimeMode: "review-only",
    effectiveMode: "review-only",
    version: 3,
    maintenanceEnabled: false,
    genericImportEnabled: false,
    backgroundAiEnabled: false,
    maintenancePreviewAllowed: false,
    ...flags,
  };
}
function policyHarness(before, { readback = {}, setError = null } = {}) {
  const calls = [];
  const after = {
    ...before,
    runtimeMode: "manual-apply",
    effectiveMode: "manual-apply",
    version: before.version + 1,
  };
  const harness = {
    invokeOk: async (_page, command, args) => {
      calls.push({ command, args });
      if (calls.length === 1) {
        assert.equal(command, "narrative_runtime_policy_get");
        assert.deepEqual(args, {});
        return before;
      }
      if (calls.length === 2) {
        assert.equal(command, "narrative_runtime_policy_set");
        if (setError) throw setError;
        return after;
      }
      assert.equal(calls.length, 3, "one readback, no retries");
      assert.equal(command, "narrative_runtime_policy_get");
      assert.deepEqual(args, {});
      return { ...after, ...readback };
    },
  };
  return { harness, calls, after };
}

test("fresh fixture setup uses typed policy CAS and preserves each actual flag", async () => {
  for (const flags of [
    {},
    {
      maintenanceEnabled: true,
      genericImportEnabled: true,
      backgroundAiEnabled: true,
    },
    {
      maintenanceEnabled: false,
      genericImportEnabled: true,
      backgroundAiEnabled: false,
    },
  ]) {
    const before = policyFixture(flags);
    const snapshot = globalThis.structuredClone(before);
    const { harness, calls, after } = policyHarness(before);
    const result = await setupChronicleFixtureApplyPolicy(harness, {});
    assert.deepEqual(
      calls.map((row) => row.command),
      [
        "narrative_runtime_policy_get",
        "narrative_runtime_policy_set",
        "narrative_runtime_policy_get",
      ],
    );
    assert.deepEqual(calls[1].args, {
      payload: {
        expectedVersion: before.version,
        runtimeMode: "manual-apply",
        maintenanceEnabled: before.maintenanceEnabled,
        genericImportEnabled: before.genericImportEnabled,
        backgroundAiEnabled: before.backgroundAiEnabled,
      },
    });
    assert.deepEqual(result.before, snapshot);
    assert.deepEqual(result.after, after);
    assert.equal(result.diagnosticFixtureConfiguration, true);
    assert.equal(result.source, "typed-native-policy-api");
    assert.deepEqual(before, snapshot);
  }
});

test("fixture setup rejects a mismatched policy readback without a retry", async () => {
  for (const readback of [
    { runtimeMode: "review-only" },
    { effectiveMode: "disabled" },
    { version: 9 },
    { maintenanceEnabled: true },
    { genericImportEnabled: true },
    { backgroundAiEnabled: true },
  ]) {
    const { harness, calls } = policyHarness(policyFixture(), { readback });
    await assert.rejects(setupChronicleFixtureApplyPolicy(harness, {}));
    assert.equal(calls.length, 3);
  }
});

test("fixture setup propagates a failed CAS unchanged and does not retry or read back", async () => {
  const setError = new Error(
    "NARRATIVE_RUNTIME_POLICY_CONFLICT: runtime policy version conflict",
  );
  const { harness, calls } = policyHarness(policyFixture(), { setError });
  await assert.rejects(
    setupChronicleFixtureApplyPolicy(harness, {}),
    (error) => error === setError,
  );
  assert.equal(calls.length, 2);
});

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function digest(value) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function analysisHarness(states, counts) {
  const calls = {
    analyze: 0,
    polls: 0,
    reads: [],
    timeline: [],
    swallowedErrors: [],
  };
  const harness = {
    invokeOk: async (_page, command, args) => {
      calls.reads.push({ command, args });
      if (command === "db_execute") {
        assert.deepEqual(args.params, ["project-1", "chronicle.extract"]);
        assert.equal(args.method, "all");
        assert.match(
          args.sql,
          /^SELECT id AS runId FROM narrative_extraction_runs WHERE project_id = \? AND surface_path_id = \?/,
        );
        return {
          rows:
            calls.analyze === 0
              ? [{ runId: "old-run" }]
              : [{ runId: "old-run" }, { runId: "current-run" }],
        };
      }
      assert.equal(command, "narrative_extraction_get_run");
      assert.deepEqual(args.payload, {
        projectId: "project-1",
        runId: "current-run",
      });
      return states[calls.polls++];
    },
    waitUntil: async (predicate, label, timeout) => {
      assert.equal(label, "exactly two actual proposals");
      assert.equal(timeout, 60_000);
      for (let index = 0; index < states.length; index += 1) {
        try {
          const result = await predicate();
          if (result) return result;
        } catch (error) {
          // Match the real harness: throwing inside its predicate is retried.
          calls.swallowedErrors.push(error);
        }
      }
      throw new Error("fake proposal timeout");
    },
    recordTimeline: (event, details) => calls.timeline.push({ event, details }),
  };
  const dialog = {
    getByRole: (role, options) => {
      assert.equal(role, "button");
      assert.deepEqual(options, { name: "解析", exact: true });
      return {
        click: async () => {
          calls.analyze += 1;
        },
      };
    },
    locator: (selector) => {
      assert.equal(selector, '[data-testid^="chronicle-proposal-card-"]');
      return { count: async () => counts[calls.polls - 1] };
    },
  };
  return { harness, dialog, calls };
}

function extractionProjection(status, tasks = []) {
  return {
    run: {
      runId: "current-run",
      projectId: "project-1",
      surfacePathId: "chronicle.extract",
      status,
    },
    tasks,
  };
}

test("Native failure stops the Analyse wait immediately and retains the exact Run/Task error", async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "chronicle-wait-failure-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const errorMessage =
    "invalid args events[0].payload.metadata.citationEvidence.bindingToken for ai_audit_append_batch";
  const task = {
    taskId: "failed-observe",
    taskKind: "chronicle.observe-events@1",
    status: "failed",
    errorMessage,
    attemptCount: 1,
  };
  for (const [status, tasks] of [
    ["failed", [task]],
    ["running", [task]],
    ["failed", []],
  ]) {
    const { harness, dialog, calls } = analysisHarness(
      [extractionProjection(status, tasks)],
      [2],
    );
    await assert.rejects(
      analyzeChronicleAndWaitForProposals({
        harness,
        dialog,
        page: {},
        projectId: "project-1",
        directory,
      }),
      (error) =>
        error.message.includes(
          tasks.length ? errorMessage : "current-run failed",
        ) && error.message.includes("current-run"),
    );
    assert.equal(calls.analyze, 1);
    assert.equal(calls.polls, 1);
    assert.deepEqual(calls.swallowedErrors, []);
    assert.equal(calls.timeline.length, 1);
    const saved = JSON.parse(
      await readFile(path.join(directory, "analysis-failed.json"), "utf8"),
    );
    assert.equal(saved.runId, "current-run");
    assert.equal(saved.projectId, "project-1");
    assert.equal(saved.run.status, status);
    assert.deepEqual(saved.tasks, tasks);
    assert.equal(saved.proposalCount, 2);
    assert.deepEqual(calls.timeline[0].details.tasks, tasks);
    assert.equal(
      calls.timeline[0].details.evidence.path,
      path.join(directory, "analysis-failed.json"),
    );
  }
});

test("Analyse is invoked once and a healthy Run still requires exactly two proposals", async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "chronicle-wait-success-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { harness, dialog, calls } = analysisHarness(
    [
      extractionProjection("running"),
      extractionProjection("running"),
      extractionProjection("completed"),
    ],
    [0, 3, 2],
  );
  assert.deepEqual(
    await analyzeChronicleAndWaitForProposals({
      harness,
      dialog,
      page: {},
      projectId: "project-1",
      directory,
    }),
    { projectId: "project-1", runId: "current-run" },
  );
  assert.equal(calls.analyze, 1);
  assert.equal(calls.polls, 3);
  assert.equal(
    calls.reads.filter((call) => call.command === "db_execute").length,
    2,
  );
  assert.deepEqual(calls.timeline, []);
  assert.deepEqual(calls.swallowedErrors, []);
});

test("a proposal timeout retains the last Native status without re-running Analyse", async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "chronicle-wait-timeout-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { harness, dialog, calls } = analysisHarness(
    [extractionProjection("running")],
    [1],
  );
  await assert.rejects(
    analyzeChronicleAndWaitForProposals({
      harness,
      dialog,
      page: {},
      projectId: "project-1",
      directory,
    }),
    /fake proposal timeout/,
  );
  const saved = JSON.parse(
    await readFile(path.join(directory, "analysis-failed.json"), "utf8"),
  );
  assert.equal(saved.proposalCount, 1);
  assert.equal(saved.run.status, "running");
  assert.equal(calls.analyze, 1);
});

function bundleFixture() {
  const observations = fixture.rows.map((row, index) => ({
    localId: `o${index}`,
    payload: { predicate: row.predicate, actuality: row.actuality },
  }));
  const hypotheses = fixture.rows.map((row, index) => ({
    hypothesisId: `h${index}`,
    observationRefs: [`o${index}`],
    actuality: "actual",
  }));
  const artifact = (artifactKind, payloadJson) => ({
    artifactId: artifactKind,
    artifactKind,
    payloadStorage: "inline-json",
    payloadDigest: DIGEST,
    payloadJson,
    taskId: "synthesis-task",
    attemptId: "synthesis-attempt",
  });
  const bundle = {
    projectId: "project-1",
    runId: "run-1",
    proposalSet: { proposalSetId: "set-1" },
    proposals: [0, 4].map((index) => ({
      proposalId: `p${index}`,
      currentRevisionId: `r${index}`,
      originKind: "enveloped",
      reconciliationEnvelopeSchemaVersion: 2,
      reconciliationEnvelopeDigest: DIGEST,
      payloadJson: { actuality: "actual", title: fixture.rows[index].title },
      latestDecision: null,
      application: null,
    })),
    stageReceipts: [
      "narrative_observation_extract",
      "narrative_event_synthesize",
      "narrative_event_synthesize",
    ].map((stageId, index) => ({
      stageExecution: {
        stageId,
        stageExecutionId: `stage-${index}`,
        projectId: "project-1",
        runId: "run-1",
        taskId: "synthesis-task",
        attemptId: "synthesis-attempt",
      },
      parseStatus: "parsed",
      terminalStatus: "succeeded",
      stageExecutionReceiptDigest: DIGEST,
    })),
    artifacts: [
      artifact("chronicle.raw-observations@1", { observations }),
      artifact("chronicle.merged-observations@1", { observations }),
      artifact("chronicle.event-clusters@1", {
        clusters: [
          {
            clusterRef: "cluster-1",
            observationRefs: ["o0", "o1", "o2", "o3"],
          },
          { clusterRef: "cluster-2", observationRefs: ["o4"] },
        ],
      }),
      artifact("chronicle.event-hypotheses@1", { hypotheses }),
      artifact("chronicle.proposal-plan@1", {
        planned: [{}, {}],
        proposals: [{}, {}],
        rejectedHypotheses: [1, 2, 3].map((index) => ({
          hypothesisId: `h${index}`,
          reason: "hypothesis-observation-actuality-mismatch",
        })),
      }),
    ],
  };
  for (const [index, terminal] of companionFixture(
    bundle,
  ).payloadJson.outputs.entries()) {
    bundle.stageReceipts[index + 1].rawObservationsDigest =
      terminal.output.rawObservationsDigest;
    bundle.stageReceipts[index + 1].parsedOutputDigest =
      terminal.output.parsedOutputDigest;
  }
  return bundle;
}

function companionFixture(bundle) {
  const observations = bundle.artifacts[0].payloadJson.observations;
  const hypotheses = bundle.artifacts[3].payloadJson.hypotheses;
  const outputs = [[0, 1, 2, 3], [4]].map((indices, index) => {
    const clusterRef = `cluster-${index + 1}`;
    const eventOutput = {
      clusterRef,
      events: indices.map((item) => hypotheses[item]),
    };
    const rawObservations = {
      kind: "chronicle.raw-observations@1",
      version: 1,
      observations: indices.map((item) => observations[item]),
    };
    const output = {
      kind: "chronicle.event-synthesis-output@1",
      observationCount: indices.length,
      eventCount: indices.length,
      observationRefs: indices.map((item) => observations[item].localId),
      rawObservationsDigest: digest(rawObservations),
      eventOutputDigest: digest(eventOutput),
    };
    return {
      clusterRef,
      rootStageExecutionId: `stage-${index + 1}`,
      terminalStageExecutionId: `stage-${index + 1}`,
      disposition: "root-success",
      eventOutput,
      rawObservations,
      output: {
        ...output,
        parsedOutputDigest: digest({
          domain: "chronicle.parsed-output/1",
          ...output,
        }),
      },
    };
  });
  const payloadJson = {
    kind: "chronicle.stage-synthesis-outputs@1",
    version: 1,
    outputs,
  };
  return {
    artifactId: "companion",
    projectId: bundle.projectId,
    runId: bundle.runId,
    taskId: "synthesis-task",
    attemptId: "synthesis-attempt",
    taskKind: "chronicle.synthesize-event@1",
    taskStatus: "completed",
    attemptStatus: "completed",
    attemptCount: 1,
    attemptNumber: 1,
    currentAttemptRows: 1,
    artifactKind: "chronicle.stage-synthesis-outputs@1",
    payloadStorage: "inline-json",
    payloadJson,
    payloadDigest: digest(payloadJson),
  };
}

function companionHarness(companions, calls = []) {
  return {
    invokeOk: async (_page, command, args) => {
      calls.push({ command, args });
      assert.equal(command, "db_execute");
      assert.equal(args.method, "all");
      assert.deepEqual(args.params, [
        "run-1",
        "project-1",
        "chronicle.stage-synthesis-outputs@1",
      ]);
      return {
        rows: companions.map((row) => ({
          ...row,
          payloadJson: JSON.stringify(row.payloadJson),
        })),
      };
    },
  };
}

test("persisted synthesis evidence is read separately from the Native review artifact roster", async () => {
  const bundle = bundleFixture();
  const companion = companionFixture(bundle);
  assert.ok(
    !bundle.artifacts.some(
      (row) => row.artifactKind === companion.artifactKind,
    ),
  );
  const before = JSON.stringify(bundle);
  const calls = [];
  const read = await readChronicleSynthesisCompanion(
    companionHarness([companion], calls),
    {},
    bundle,
  );
  assert.deepEqual(read, companion);
  assert.equal(JSON.stringify(bundle), before);
  assert.equal(observeChronicleBeforeReview(bundle, read).hypotheses.length, 5);
  assert.match(
    calls[0].args.sql,
    /attempt\.attempt_number = task\.attempt_count/,
  );
  assert.match(
    calls[0].args.sql,
    /SELECT COUNT\(\*\).*narrative_extraction_attempts current_attempt/,
  );
});

test("companion observation rejects absent, duplicate, stale, wrong owner and modified C1 evidence", async () => {
  const bundle = bundleFixture();
  const companion = companionFixture(bundle);
  for (const candidates of [[], [companion, companion]]) {
    await assert.rejects(
      readChronicleSynthesisCompanion(companionHarness(candidates), {}, bundle),
    );
  }
  for (const change of [
    { projectId: "other" },
    { runId: "other" },
    { taskId: "other" },
    { attemptId: "old" },
    { attemptNumber: 0 },
    { currentAttemptRows: 2 },
    { taskStatus: "failed" },
    { payloadDigest: DIGEST },
  ]) {
    await assert.rejects(
      readChronicleSynthesisCompanion(
        companionHarness([{ ...companion, ...change }]),
        {},
        bundle,
      ),
    );
  }
  for (const mutate of [
    (row) => {
      row.payloadJson.outputs[0].rawObservations.observations[1].payload.actuality =
        "actual";
    },
    (row) => {
      row.payloadJson.outputs[0].output.parsedOutputDigest = DIGEST;
    },
    (row) => {
      row.payloadJson.outputs[0].terminalStageExecutionId = "foreign";
    },
    (row) => {
      row.payloadJson.outputs[1].rootStageExecutionId = "stage-1";
    },
  ]) {
    const changed = globalThis.structuredClone(companion);
    mutate(changed);
    changed.payloadDigest = digest(changed.payloadJson);
    await assert.rejects(
      readChronicleSynthesisCompanion(companionHarness([changed]), {}, bundle),
    );
  }
  for (const change of [
    { parsedOutputDigest: DIGEST },
    {
      stageExecution: {
        ...bundle.stageReceipts[1].stageExecution,
        attemptId: "old",
      },
    },
  ]) {
    const changed = globalThis.structuredClone(bundle);
    Object.assign(changed.stageReceipts[1], change);
    await assert.rejects(
      readChronicleSynthesisCompanion(
        companionHarness([companion]),
        {},
        changed,
      ),
    );
  }
});

test("the new limited contract is active while generic Chronicle UI remains in backlog", () => {
  const entry = PRODUCT_JOURNEY_CATALOG.find((row) => row.id === fixture.id);
  assert.deepEqual(entry.contracts, ["chronicle:extract-review-apply-reopen"]);
  assert.deepEqual(entry.capabilities, ["electron", "napi"]);
  assert.deepEqual(entry.domains, ["chronicle-extraction"]);
  assert.ok(
    PRODUCT_JOURNEYS.some(
      (row) => row.id === fixture.id && typeof row.run === "function",
    ),
  );
  assert.ok(
    PRODUCT_CONTRACT_REQUIREMENTS.some((row) => row.id === entry.contracts[0]),
  );
  assert.ok(
    PRODUCT_JOURNEY_COVERAGE_BACKLOG.some(
      (row) =>
        row.id === "chronicle-ui-roundtrip" &&
        row.contracts.includes("ui-roundtrip:chronicle"),
    ),
  );
  assert.equal(
    PRODUCT_JOURNEY_CATALOG.some((row) =>
      row.contracts.includes("ui-roundtrip:chronicle"),
    ),
    false,
  );
});

test("a V2 or extraction UI change selects the limited Journey explicitly", () => {
  for (const changedPath of [
    "src/application/narrative-extraction/chronicleV2Production.ts",
    "src/features/chronicle/ChronicleExtractDialog.tsx",
  ]) {
    const selected = selectProductJourneys({
      catalog: PRODUCT_JOURNEY_CATALOG,
      domainRules: PRODUCT_DOMAIN_RULES,
      changedPaths: [changedPath],
    });
    assert.ok(selected.journeyIds.includes(fixture.id));
    assert.equal(selected.fallback, false);
  }
});

test("review evidence must retain all five original claims and three separate rejections", () => {
  const bundle = bundleFixture();
  const companion = companionFixture(bundle);
  assert.equal(
    observeChronicleBeforeReview(bundle, companion).plan.rejectedHypotheses
      .length,
    3,
  );
  const missingRaw = globalThis.structuredClone(bundle);
  missingRaw.artifacts[0].payloadJson.observations.pop();
  assert.throws(() => observeChronicleBeforeReview(missingRaw, companion));
  const missingRejection = globalThis.structuredClone(bundle);
  missingRejection.artifacts.at(-1).payloadJson.rejectedHypotheses.pop();
  assert.throws(() =>
    observeChronicleBeforeReview(missingRejection, companion),
  );
  const rewrittenTerminal = globalThis.structuredClone(companion);
  rewrittenTerminal.payloadJson.outputs[0].rawObservations.observations[1].payload.actuality =
    "actual";
  assert.throws(() => observeChronicleBeforeReview(bundle, rewrittenTerminal));
  const legacy = globalThis.structuredClone(bundle);
  legacy.proposals[0].reconciliationEnvelopeSchemaVersion = 1;
  assert.throws(() => observeChronicleBeforeReview(legacy, companion));
});

test("missing or failed C1 stage receipts cannot masquerade as a real provider journey", () => {
  const bundle = bundleFixture();
  const companion = companionFixture(bundle);
  bundle.stageReceipts[2].terminalStatus = "failed";
  assert.throws(() => observeChronicleBeforeReview(bundle, companion));
  bundle.stageReceipts.pop();
  assert.throws(() => observeChronicleBeforeReview(bundle, companion));
});

test("applied evidence requires two human-approved revision applications and one Native journal", () => {
  const bundle = bundleFixture();
  bundle.proposals.forEach((proposal, index) => {
    proposal.latestDecision = {
      decision: "approved",
      actorKind: "human",
      revisionId: proposal.currentRevisionId,
    };
    proposal.application = {
      commitId: "commit",
      revisionId: proposal.currentRevisionId,
      appliedEntityId: `event-${index}`,
    };
  });
  const state = {
    events: bundle.proposals.map((proposal, index) => ({
      id: `event-${index}`,
      title: proposal.payloadJson.title,
    })),
    applications: bundle.proposals.map((proposal) => proposal.application),
    sceneLinks: [0, 1].map((index) => ({
      sceneId: "scene",
      eventId: `event-${index}`,
    })),
    commits: [{ id: "commit", status: "applied" }],
    journals: [{ id: "journal", commitId: "commit" }],
  };
  assertChronicleApplied(state, bundle, "scene");
  assert.throws(() =>
    assertChronicleApplied({ ...state, journals: [] }, bundle, "scene"),
  );
  bundle.proposals[0].latestDecision.actorKind = "ai";
  assert.throws(() => assertChronicleApplied(state, bundle, "scene"));
});

test("Chronicle journey keeps a restored panel open and opens a hidden panel once", async () => {
  for (const state of ["true", "false"]) {
    const calls = [];
    const page = {
      locator: (selector) => {
        assert.equal(selector, '[data-stripe-icon="chronicle"]');
        return {
          waitFor: async () => calls.push("toggle-ready"),
          getAttribute: async (name) => {
            assert.equal(name, "aria-pressed");
            return state;
          },
          click: async () => calls.push("toggle"),
        };
      },
      getByTitle: (title, options) => {
        assert.equal(title, "AI 抽出");
        assert.deepEqual(options, { exact: true });
        return {
          waitFor: async (options) => {
            assert.deepEqual(options, { state: "visible" });
            calls.push("panel-visible");
          },
        };
      },
    };
    await showChronicleFixturePanel(page);
    assert.deepEqual(
      calls,
      state === "true"
        ? ["toggle-ready", "panel-visible"]
        : ["toggle-ready", "toggle", "panel-visible"],
    );
  }
});
