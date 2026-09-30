import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
const fixture = JSON.parse(
  readFileSync(
    new URL("../shared/productJourneyChronicleFixture.json", import.meta.url),
    "utf8",
  ),
);
const ID = fixture.id;
const artifactKinds = {
  observations: "chronicle.raw-observations@1",
  merged: "chronicle.merged-observations@1",
  clusters: "chronicle.event-clusters@1",
  hypotheses: "chronicle.event-hypotheses@1",
  plan: "chronicle.proposal-plan@1",
  terminal: "chronicle.stage-synthesis-outputs@1",
};
export async function showChronicleFixturePanel(page) {
  await page
    .locator('[data-layout-shell][data-layout-initialized="true"]')
    .waitFor({ state: "attached" });
  const toggle = page.locator('[data-stripe-icon="chronicle"]');
  await toggle.waitFor({ state: "visible" });
  const state = await toggle.getAttribute("aria-pressed");
  assert.ok(
    state === "true" || state === "false",
    "Chronicle toggle must expose its state",
  );
  if (state === "false") await toggle.click();
  await page
    .getByTitle("AI 抽出", { exact: true })
    .waitFor({ state: "visible" });
}

function exactArtifact(bundle, kind) {
  const candidates = bundle.artifacts.filter(
    (row) => row.artifactKind === kind,
  );
  assert.equal(candidates.length, 1, `one saved artifact for ${kind}`);
  assert.equal(candidates[0].payloadStorage, "inline-json");
  assert.ok(candidates[0].payloadJson);
  assert.ok(candidates[0].payloadDigest);
  return candidates[0].payloadJson;
}
async function rows(harness, page, sql, params = []) {
  return (
    (await harness.invokeOk(page, "db_execute", { sql, params, method: "all" }))
      .rows ?? []
  );
}
export async function waitForChronicleFixtureWorkspace(
  harness,
  page,
  { projectId, sceneId },
) {
  const outcome = await harness.waitUntil(
    async () => {
      try {
        const scenes = await rows(
          harness,
          page,
          "SELECT id, project_id AS projectId FROM tree_nodes WHERE id = ? AND project_id = ? AND node_type = 'scene'",
          [sceneId, projectId],
        );
        if (scenes.length === 0) return false;
        assert.equal(scenes.length, 1, "one exact fixture scene");
        assert.equal(scenes[0].id, sceneId);
        assert.equal(scenes[0].projectId, projectId);
        return { ready: true };
      } catch (error) {
        if (
          error instanceof Error &&
          (error.message === "db_execute rejected: No workspace is open" ||
            /^db_execute rejected: WORKSPACE_SWITCHING(?::|$)/u.test(
              error.message,
            ))
        ) {
          return false;
        }
        // The harness retries thrown predicate errors; preserve fatal failures
        // as a truthy result and throw after leaving that retry boundary.
        return { ready: false, error };
      }
    },
    "the exact Chronicle fixture workspace is ready",
    30_000,
  );
  if (!outcome.ready) throw outcome.error;
}
async function reviewBundle(harness, page, identity) {
  return harness.invokeOk(page, "narrative_extraction_get_run_review_bundle", {
    payload: identity,
  });
}
const policyFlags = [
  "maintenanceEnabled",
  "genericImportEnabled",
  "backgroundAiEnabled",
];
function assertFixtureApplyPolicy(policy, expected) {
  assert.equal(policy.runtimeMode, "manual-apply");
  assert.equal(policy.effectiveMode, "manual-apply");
  assert.equal(policy.version, expected.version);
  assert.equal(typeof policy.maintenancePreviewAllowed, "boolean");
  for (const flag of policyFlags) assert.equal(policy[flag], expected[flag]);
}
export async function setupChronicleFixtureApplyPolicy(harness, page) {
  const before = await harness.invokeOk(
    page,
    "narrative_runtime_policy_get",
    {},
  );
  assert.ok(Number.isSafeInteger(before.version) && before.version >= 0);
  for (const flag of policyFlags) assert.equal(typeof before[flag], "boolean");
  const requested = {
    expectedVersion: before.version,
    runtimeMode: "manual-apply",
    maintenanceEnabled: before.maintenanceEnabled,
    genericImportEnabled: before.genericImportEnabled,
    backgroundAiEnabled: before.backgroundAiEnabled,
  };
  const setResult = await harness.invokeOk(
    page,
    "narrative_runtime_policy_set",
    {
      payload: requested,
    },
  );
  const expected = { ...before, version: before.version + 1 };
  assertFixtureApplyPolicy(setResult, expected);
  const after = await harness.invokeOk(
    page,
    "narrative_runtime_policy_get",
    {},
  );
  assertFixtureApplyPolicy(after, expected);
  assert.deepEqual(after, setResult);
  return {
    diagnosticFixtureConfiguration: true,
    source: "typed-native-policy-api",
    before,
    requested,
    setResult,
    after,
  };
}
async function readFixtureApplyPolicy(harness, page, expected) {
  const policy = await harness.invokeOk(
    page,
    "narrative_runtime_policy_get",
    {},
  );
  assertFixtureApplyPolicy(policy, expected);
  assert.deepEqual(policy, expected);
  return policy;
}
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
function payloadDigest(value) {
  return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}
function assertSynthesisCompanion(bundle, companion) {
  const owners = bundle.artifacts.filter(
    (row) => row.artifactKind === artifactKinds.hypotheses,
  );
  assert.equal(owners.length, 1, "one Native-verified hypothesis artifact");
  const owner = owners[0];
  assert.equal(companion.projectId, bundle.projectId);
  assert.equal(companion.runId, bundle.runId);
  assert.ok(owner.taskId && owner.attemptId);
  assert.equal(companion.taskId, owner.taskId);
  assert.equal(companion.attemptId, owner.attemptId);
  assert.equal(companion.taskKind, "chronicle.synthesize-event@1");
  assert.equal(companion.taskStatus, "completed");
  assert.equal(companion.attemptStatus, "completed");
  assert.ok(companion.attemptCount > 0);
  assert.equal(companion.attemptNumber, companion.attemptCount);
  assert.equal(companion.currentAttemptRows, 1);
  assert.equal(companion.artifactKind, artifactKinds.terminal);
  assert.equal(companion.payloadStorage, "inline-json");
  assert.ok(companion.artifactId);
  assert.equal(payloadDigest(companion.payloadJson), companion.payloadDigest);
  const payload = companion.payloadJson;
  assert.equal(payload.kind, artifactKinds.terminal);
  assert.equal(payload.version, 1);
  assert.equal(payload.outputs.length, 2);
  const receipts = bundle.stageReceipts.filter(
    (row) => row.stageExecution.stageId === "narrative_event_synthesize",
  );
  assert.equal(receipts.length, 2);
  assert.equal(new Set(payload.outputs.map((row) => row.clusterRef)).size, 2);
  assert.equal(
    new Set(payload.outputs.map((row) => row.rootStageExecutionId)).size,
    2,
  );
  const clusters = exactArtifact(bundle, artifactKinds.clusters).clusters;
  for (const terminal of payload.outputs) {
    assert.equal(terminal.disposition, "root-success");
    assert.equal(
      terminal.rootStageExecutionId,
      terminal.terminalStageExecutionId,
    );
    const matches = receipts.filter(
      (row) =>
        row.stageExecution.stageExecutionId ===
        terminal.terminalStageExecutionId,
    );
    assert.equal(matches.length, 1, "one exact C1 terminal receipt");
    const receipt = matches[0];
    for (const key of ["projectId", "runId", "taskId", "attemptId"]) {
      assert.equal(receipt.stageExecution[key], companion[key]);
    }
    assert.equal(receipt.parseStatus, "parsed");
    assert.equal(receipt.terminalStatus, "succeeded");
    assert.match(receipt.stageExecutionReceiptDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(terminal.rawObservations.kind, artifactKinds.observations);
    assert.equal(terminal.rawObservations.version, 1);
    assert.equal(terminal.eventOutput.clusterRef, terminal.clusterRef);
    const raw = terminal.rawObservations.observations;
    const refs = raw.map((row) => row.localId);
    const matchingClusters = clusters.filter(
      (row) => row.clusterRef === terminal.clusterRef,
    );
    assert.equal(matchingClusters.length, 1);
    assert.deepEqual(refs, matchingClusters[0].observationRefs);
    const output = terminal.output;
    assert.equal(output.kind, "chronicle.event-synthesis-output@1");
    assert.equal(output.observationCount, raw.length);
    assert.equal(output.eventCount, terminal.eventOutput.events.length);
    assert.deepEqual(output.observationRefs, refs);
    assert.equal(
      output.rawObservationsDigest,
      payloadDigest(terminal.rawObservations),
    );
    assert.equal(output.eventOutputDigest, payloadDigest(terminal.eventOutput));
    assert.equal(
      output.parsedOutputDigest,
      payloadDigest({
        domain: "chronicle.parsed-output/1",
        kind: output.kind,
        observationCount: raw.length,
        eventCount: terminal.eventOutput.events.length,
        observationRefs: refs,
        rawObservationsDigest: output.rawObservationsDigest,
        eventOutputDigest: output.eventOutputDigest,
      }),
    );
    assert.equal(receipt.rawObservationsDigest, output.rawObservationsDigest);
    assert.equal(receipt.parsedOutputDigest, output.parsedOutputDigest);
  }
}

export async function readChronicleSynthesisCompanion(harness, page, bundle) {
  // The review API intentionally returns only Native-verified DAG artifacts.
  // Observe the persisted companion separately, bound to that verified owner.
  const candidates = await rows(
    harness,
    page,
    `SELECT artifact.id AS artifactId, artifact.run_id AS runId,
            run.project_id AS projectId, artifact.task_id AS taskId,
            artifact.attempt_id AS attemptId, artifact.artifact_kind AS artifactKind,
            artifact.payload_storage AS payloadStorage,
            artifact.payload_json AS payloadJson, artifact.payload_digest AS payloadDigest,
            task.task_kind AS taskKind, task.status AS taskStatus,
            task.attempt_count AS attemptCount, attempt.status AS attemptStatus,
            attempt.attempt_number AS attemptNumber,
            (SELECT COUNT(*) FROM narrative_extraction_attempts current_attempt
              WHERE current_attempt.task_id = task.id
                AND current_attempt.attempt_number = task.attempt_count) AS currentAttemptRows
       FROM narrative_extraction_artifacts artifact
       JOIN narrative_extraction_runs run ON run.id = artifact.run_id
       JOIN narrative_extraction_tasks task ON task.id = artifact.task_id AND task.run_id = run.id
       JOIN narrative_extraction_attempts attempt ON attempt.id = artifact.attempt_id
         AND attempt.task_id = task.id AND attempt.attempt_number = task.attempt_count
      WHERE run.id = ? AND run.project_id = ? AND artifact.artifact_kind = ?
        AND task.task_kind = 'chronicle.synthesize-event@1'
        AND task.status = 'completed' AND attempt.status = 'completed'`,
    [bundle.runId, bundle.projectId, artifactKinds.terminal],
  );
  assert.equal(
    candidates.length,
    1,
    "one persisted current-attempt synthesis companion",
  );
  const companion = {
    ...candidates[0],
    payloadJson: JSON.parse(candidates[0].payloadJson),
  };
  assertSynthesisCompanion(bundle, companion);
  return companion;
}
async function saveEvidence(directory, name, value) {
  await mkdir(directory, { recursive: true });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const target = path.join(directory, `${name}.json`);
  await writeFile(target, bytes, "utf8");
  return {
    path: target,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: Buffer.byteLength(bytes),
  };
}

export async function analyzeChronicleAndWaitForProposals({
  harness,
  page,
  dialog,
  projectId,
  directory,
}) {
  const runSql =
    "SELECT id AS runId FROM narrative_extraction_runs WHERE project_id = ? AND surface_path_id = ? ORDER BY created_at, id";
  let diagnostic = {
    projectId,
    runId: null,
    expectedProposalCount: 2,
    proposalCount: null,
    run: null,
    tasks: [],
  };
  try {
    const previousIds = new Set(
      (await rows(harness, page, runSql, [projectId, "chronicle.extract"])).map(
        (run) => run.runId,
      ),
    );
    await dialog.getByRole("button", { name: "解析", exact: true }).click();
    let identity;
    const outcome = await harness.waitUntil(
      async () => {
        if (!identity) {
          const current = (
            await rows(harness, page, runSql, [projectId, "chronicle.extract"])
          ).filter((run) => !previousIds.has(run.runId));
          if (current.length === 0) return false;
          if (current.length !== 1) {
            diagnostic = {
              ...diagnostic,
              unexpectedRunIds: current.map((run) => run.runId),
            };
            return {
              failed: true,
              message: "multiple new Chronicle extraction Runs",
            };
          }
          identity = { projectId, runId: current[0].runId };
        }
        const projection = await harness.invokeOk(
          page,
          "narrative_extraction_get_run",
          {
            payload: identity,
          },
        );
        assert.equal(projection.run.runId, identity.runId);
        assert.equal(projection.run.projectId, projectId);
        assert.equal(projection.run.surfacePathId, "chronicle.extract");
        const proposalCount = await dialog
          .locator('[data-testid^="chronicle-proposal-card-"]')
          .count();
        diagnostic = {
          ...diagnostic,
          ...identity,
          proposalCount,
          run: {
            status: projection.run.status,
            outcomeSummaryJson: projection.run.outcomeSummaryJson,
            startedAt: projection.run.startedAt,
            completedAt: projection.run.completedAt,
          },
          tasks: projection.tasks.map((task) => ({
            taskId: task.taskId,
            taskKind: task.taskKind,
            status: task.status,
            errorMessage: task.errorMessage,
            attemptCount: task.attemptCount,
          })),
        };
        const failedTask = diagnostic.tasks.find(
          (task) => task.status === "failed",
        );
        if (
          failedTask ||
          projection.run.status === "failed" ||
          projection.run.status === "cancelled"
        ) {
          // waitUntil retries thrown predicate errors, so return a terminal result
          // and throw outside it after preserving the Native failure evidence.
          return {
            failed: true,
            message: `Chronicle Run ${identity.runId} ${projection.run.status}${failedTask ? `; Task ${failedTask.taskId} (${failedTask.taskKind}): ${failedTask.errorMessage ?? "failed"}` : ""}`,
          };
        }
        return proposalCount === 2 ? { failed: false, identity } : false;
      },
      "exactly two actual proposals",
      60_000,
    );
    if (outcome.failed) throw new Error(outcome.message);
    return outcome.identity;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const evidence = await saveEvidence(directory, "analysis-failed", {
      ...diagnostic,
      errorMessage,
    });
    harness.recordTimeline(`${ID}/analysis-failed`, {
      ...diagnostic,
      errorMessage,
      evidence,
    });
    throw error;
  }
}
export function observeChronicleBeforeReview(
  bundle,
  persistedSynthesisCompanion,
) {
  assertSynthesisCompanion(bundle, persistedSynthesisCompanion);
  assert.equal(bundle.proposals.length, 2);
  assert.ok(bundle.proposalSet?.proposalSetId);
  assert.deepEqual(
    bundle.stageReceipts.map((row) => row.stageExecution.stageId).sort(),
    [
      "narrative_event_synthesize",
      "narrative_event_synthesize",
      "narrative_observation_extract",
    ],
  );
  assert.equal(
    new Set(
      bundle.stageReceipts.map((row) => row.stageExecution.stageExecutionId),
    ).size,
    3,
  );
  assert.ok(
    bundle.stageReceipts.every(
      (row) =>
        row.parseStatus === "parsed" &&
        row.terminalStatus === "succeeded" &&
        row.stageExecutionReceiptDigest?.startsWith("sha256:"),
    ),
  );
  const original = exactArtifact(
    bundle,
    artifactKinds.observations,
  ).observations;
  const merged = exactArtifact(bundle, artifactKinds.merged).observations;
  const clusters = exactArtifact(bundle, artifactKinds.clusters).clusters;
  const hypotheses = exactArtifact(bundle, artifactKinds.hypotheses).hypotheses;
  const plan = exactArtifact(bundle, artifactKinds.plan);
  const outputs = persistedSynthesisCompanion.payloadJson.outputs;
  const counts = (observations) =>
    observations
      .map((row) => `${row.payload.predicate}:${row.payload.actuality}`)
      .sort();
  assert.deepEqual(
    counts(original),
    fixture.rows.map((row) => `${row.predicate}:${row.actuality}`).sort(),
  );
  assert.deepEqual(counts(merged), counts(original));
  assert.equal(hypotheses.length, 5);
  assert.ok(hypotheses.every((row) => row.actuality === "actual"));
  assert.deepEqual(
    clusters.map((row) => row.observationRefs.length).sort(),
    [1, 4],
  );
  assert.equal(outputs.length, 2);
  assert.equal(
    outputs.reduce((total, row) => total + row.eventOutput.events.length, 0),
    5,
  );
  assert.equal(
    outputs.reduce(
      (total, row) => total + row.rawObservations.observations.length,
      0,
    ),
    5,
  );
  assert.deepEqual(
    counts(outputs.flatMap((row) => row.rawObservations.observations)),
    counts(original),
  );
  assert.ok(
    outputs.every((row) =>
      row.eventOutput.events.every((event) => event.actuality === "actual"),
    ),
  );
  assert.ok(
    outputs.every(
      (row) =>
        row.output.rawObservationsDigest && row.output.parsedOutputDigest,
    ),
  );
  assert.equal(plan.planned.length, 2);
  assert.equal(plan.proposals.length, 2);
  assert.equal(plan.rejectedHypotheses.length, 3);
  assert.ok(
    plan.rejectedHypotheses.every(
      (row) => row.reason === fixture.expectedRejectedHypothesisReason,
    ),
  );
  const byId = new Map(merged.map((row) => [row.localId, row]));
  const byHypothesisId = new Map(
    hypotheses.map((row) => [row.hypothesisId, row]),
  );
  assert.deepEqual(
    plan.rejectedHypotheses
      .map((row) => {
        const hypothesis = byHypothesisId.get(row.hypothesisId);
        assert.equal(hypothesis.observationRefs.length, 1);
        return byId.get(hypothesis.observationRefs[0]).payload.actuality;
      })
      .sort(),
    ["dreamed", "planned", "rumored"],
  );
  for (const proposal of bundle.proposals) {
    assert.equal(proposal.originKind, "enveloped");
    assert.equal(proposal.reconciliationEnvelopeSchemaVersion, 2);
    assert.ok(proposal.reconciliationEnvelopeDigest?.startsWith("sha256:"));
    assert.ok(proposal.currentRevisionId);
    assert.equal(proposal.payloadJson.actuality, "actual");
    assert.equal(proposal.latestDecision, null);
    assert.equal(proposal.application ?? null, null);
  }
  assert.deepEqual(
    bundle.proposals.map((row) => row.payloadJson.title).sort(),
    ["門が開いた", "鐘が鳴った"].sort(),
  );
  return { original, merged, clusters, hypotheses, plan, outputs };
}
async function inspectNative(harness, page, bundle, sceneId) {
  const proposalIds = bundle.proposals.map((row) => row.proposalId);
  const revisionRows = await rows(
    harness,
    page,
    "SELECT id, proposal_id AS proposalId, reconciliation_envelope_json AS envelopeJson, reconciliation_envelope_digest AS envelopeDigest FROM narrative_proposal_revisions WHERE proposal_id IN (?, ?) ORDER BY proposal_id, id",
    proposalIds,
  );
  const envelopes = revisionRows.map((row) => ({
    ...row,
    envelope: JSON.parse(row.envelopeJson),
  }));
  assert.equal(envelopes.length, 2);
  const mixed = envelopes.find(
    (row) =>
      row.envelope.revisionBasis.contextSet.filter((context) =>
        context.inputRef.startsWith("observation:"),
      ).length === 4,
  );
  assert.ok(
    mixed,
    "actual subset of the full mixed synthesis cluster passed real V2",
  );
  assert.equal(mixed.envelope.assertion.payload.observationRefs.length, 1);
  assert.equal(mixed.envelope.assertion.payload.actuality, "actual");
  const savedMixedCluster = exactArtifact(
    bundle,
    artifactKinds.clusters,
  ).clusters.find((row) => row.observationRefs.length === 4);
  const savedMixedActual = exactArtifact(
    bundle,
    artifactKinds.merged,
  ).observations.find(
    (row) =>
      row.payload.predicate === "門を開ける" &&
      row.payload.actuality === "actual",
  );
  assert.deepEqual(mixed.envelope.assertion.payload.observationRefs, [
    savedMixedActual.localId,
  ]);
  assert.deepEqual(
    mixed.envelope.revisionBasis.contextSet
      .filter((row) => row.inputRef.startsWith("observation:"))
      .map((row) => row.inputRef)
      .sort(),
    savedMixedCluster.observationRefs.map((ref) => `observation:${ref}`).sort(),
  );
  for (const ref of savedMixedCluster.observationRefs)
    assert.ok(
      mixed.envelope.effectiveMaterialBasis.dependencySet.some(
        (row) =>
          row.inputRef === `observation:${ref}` &&
          row.role === "opaque-model-context",
      ),
    );
  for (const row of envelopes) {
    const proposal = bundle.proposals.find(
      (proposal) => proposal.proposalId === row.proposalId,
    );
    assert.equal(row.id, proposal.currentRevisionId);
    assert.equal(row.envelope.schemaVersion, 2);
    assert.equal(row.envelopeDigest, proposal.reconciliationEnvelopeDigest);
  }
  const events = await rows(
    harness,
    page,
    "SELECT id, title FROM events WHERE project_id = ? ORDER BY id",
    [bundle.projectId],
  );
  const sceneLinks = await rows(
    harness,
    page,
    "SELECT scene_id AS sceneId, event_id AS eventId FROM scene_events WHERE scene_id = ? ORDER BY event_id",
    [sceneId],
  );
  const applications = bundle.proposals
    .map((row) => row.application)
    .filter(Boolean);
  const commitIds = [...new Set(applications.map((row) => row.commitId))];
  const commits = commitIds.length
    ? await rows(
        harness,
        page,
        "SELECT id, status, receipt_json AS receiptJson FROM narrative_apply_commits WHERE id = ?",
        [commitIds[0]],
      )
    : [];
  const journals = commitIds.length
    ? await rows(
        harness,
        page,
        "SELECT id, commit_id AS commitId, after_json AS afterJson FROM narrative_commit_journals WHERE commit_id = ?",
        [commitIds[0]],
      )
    : [];
  return { envelopes, events, sceneLinks, applications, commits, journals };
}
export function assertChronicleApplied(state, bundle, sceneId) {
  assert.equal(state.events.length, 2);
  assert.deepEqual(
    state.events.map((row) => row.title).sort(),
    ["門が開いた", "鐘が鳴った"].sort(),
  );
  assert.equal(state.applications.length, 2);
  assert.equal(new Set(state.applications.map((row) => row.commitId)).size, 1);
  assert.equal(state.commits.length, 1);
  assert.equal(state.commits[0].status, "applied");
  assert.equal(state.journals.length, 1);
  assert.deepEqual(
    state.applications.map((row) => row.appliedEntityId).sort(),
    state.events.map((row) => row.id).sort(),
  );
  assert.deepEqual(
    state.sceneLinks.map((row) => row.eventId).sort(),
    state.events.map((row) => row.id).sort(),
  );
  assert.ok(state.sceneLinks.every((row) => row.sceneId === sceneId));
  assert.ok(
    bundle.proposals.every(
      (row) =>
        row.latestDecision?.decision === "approved" &&
        row.latestDecision?.actorKind === "human" &&
        row.latestDecision?.revisionId === row.currentRevisionId &&
        row.application?.revisionId === row.currentRevisionId,
    ),
  );
}
async function createNode(harness, page, projectId, node) {
  return harness.invokeOk(page, "tree_node_create", {
    payload: {
      projectId,
      requestId: randomUUID(),
      sessionId: randomUUID(),
      eventUid: randomUUID(),
      origin: "human",
      originalTransactionId: null,
      undoJournalId: null,
      status: "draft",
      ...node,
    },
  });
}
export function createChronicleExtractionJourney({
  configureWorkspace,
  evidenceDirectory,
}) {
  return {
    id: ID,
    run: async (harness) => {
      const directory = path.join(evidenceDirectory, ID);
      const workspace = harness.workspacePath(ID);
      await configureWorkspace(harness, workspace, { deterministicAi: true });
      const seed = await harness.launch(`${ID}/seed`);
      let projectId;
      let fixtureApplyPolicy;
      const folderId = randomUUID();
      const sceneId = randomUUID();
      try {
        projectId = await harness.waitUntil(
          async () =>
            (
              await rows(
                harness,
                seed.page,
                "SELECT id FROM projects ORDER BY created_at, id LIMIT 1",
              )
            )[0]?.id,
          "fixture project",
        );
        // This workspace was freshly created by this isolated harness above.
        fixtureApplyPolicy = await setupChronicleFixtureApplyPolicy(
          harness,
          seed.page,
        );
        harness.recordTimeline(`${ID}/fixture-policy-setup`, {
          diagnosticFixtureConfiguration: true,
          evidence: await saveEvidence(
            directory,
            "fixture-policy-setup",
            fixtureApplyPolicy,
          ),
        });
        await createNode(harness, seed.page, projectId, {
          id: folderId,
          parentId: null,
          nodeType: "folder",
          title: "実在性の比較",
          sortOrder: "a0",
          content: null,
        });
        await createNode(harness, seed.page, projectId, {
          id: sceneId,
          parentId: folderId,
          nodeType: "scene",
          title: "門と鐘",
          sortOrder: "a0",
          content: JSON.stringify({
            type: "doc",
            content: fixture.rows.map((row) => ({
              type: "paragraph",
              content: [{ type: "text", text: row.text }],
            })),
          }),
        });
      } finally {
        await harness.close(seed.app, seed.page, `${ID}/seed`);
      }
      const review = await harness.launch(`${ID}/extract-review-apply`);
      let identity;
      let appliedSnapshot;
      let artifactDigests;
      let stageReceiptDigests;
      let initialSynthesisCompanion;
      try {
        await waitForChronicleFixtureWorkspace(harness, review.page, {
          projectId,
          sceneId,
        });
        await readFixtureApplyPolicy(
          harness,
          review.page,
          fixtureApplyPolicy.after,
        );
        await showChronicleFixturePanel(review.page);
        await review.page.getByTitle("AI 抽出", { exact: true }).click();
        const dialog = review.page.getByRole("dialog");
        await dialog.locator("select").selectOption(folderId);
        identity = await analyzeChronicleAndWaitForProposals({
          harness,
          page: review.page,
          dialog,
          projectId,
          directory,
        });
        const initial = await reviewBundle(harness, review.page, identity);
        initialSynthesisCompanion = await readChronicleSynthesisCompanion(
          harness,
          review.page,
          initial,
        );
        const contract = observeChronicleBeforeReview(
          initial,
          initialSynthesisCompanion,
        );
        const before = await inspectNative(
          harness,
          review.page,
          initial,
          sceneId,
        );
        assert.equal(before.events.length, 0);
        assert.equal(before.applications.length, 0);
        artifactDigests = initial.artifacts
          .map((row) => [row.artifactId, row.payloadDigest])
          .sort();
        stageReceiptDigests = initial.stageReceipts
          .map((row) => [
            row.stageExecution.stageExecutionId,
            row.stageExecutionReceiptDigest,
          ])
          .sort();
        harness.recordTimeline(`${ID}/initial`, {
          ...identity,
          sceneId,
          proposalSetId: initial.proposalSet.proposalSetId,
          observationCount: 5,
          hypothesisCount: 5,
          rejectedCount: 3,
          proposalCount: 2,
          evidence: await saveEvidence(directory, "initial", {
            bundle: initial,
            persistedSynthesisCompanion: initialSynthesisCompanion,
            native: before,
            contract,
          }),
        });
        for (const proposal of initial.proposals) {
          const card = dialog.getByTestId(
            `chronicle-proposal-card-${proposal.proposalId}`,
          );
          await card.getByRole("button").first().click();
          const quotePane = dialog.getByTestId("chronicle-evidence-pane");
          await quotePane.waitFor({ state: "visible" });
          const expectedQuote = fixture.rows.find(
            (row) => row.title === proposal.payloadJson.title,
          ).text;
          assert.ok((await quotePane.textContent()).includes(expectedQuote));
          assert.ok((await quotePane.textContent()).includes(sceneId));
          assert.ok(
            !(await quotePane.textContent()).includes("断片（適用不可）"),
          );
          await card.getByRole("button", { name: "承認", exact: true }).click();
          await harness.waitUntil(
            async () =>
              (
                await reviewBundle(harness, review.page, identity)
              ).proposals.find((row) => row.proposalId === proposal.proposalId)
                ?.latestDecision?.decision === "approved",
            "durable human approval",
          );
        }
        const approved = await reviewBundle(harness, review.page, identity);
        const approvedNative = await inspectNative(
          harness,
          review.page,
          approved,
          sceneId,
        );
        assert.equal(approvedNative.events.length, 0);
        assert.equal(approvedNative.applications.length, 0);
        assert.ok(
          approved.proposals.every(
            (row) => row.latestDecision?.actorKind === "human",
          ),
        );
        const approvedSynthesisCompanion =
          await readChronicleSynthesisCompanion(harness, review.page, approved);
        assert.deepEqual(approvedSynthesisCompanion, initialSynthesisCompanion);
        harness.recordTimeline(`${ID}/approved`, {
          ...identity,
          evidence: await saveEvidence(directory, "approved", {
            bundle: approved,
            persistedSynthesisCompanion: approvedSynthesisCompanion,
            native: approvedNative,
          }),
        });
        const applyPolicy = await readFixtureApplyPolicy(
          harness,
          review.page,
          fixtureApplyPolicy.after,
        );
        harness.recordTimeline(`${ID}/fixture-policy-before-apply`, {
          diagnosticFixtureConfiguration: true,
          evidence: await saveEvidence(
            directory,
            "fixture-policy-before-apply",
            applyPolicy,
          ),
        });
        await dialog
          .getByRole("button", { name: "取り込む", exact: true })
          .click();
        const applied = await harness.waitUntil(
          async () => {
            const bundle = await reviewBundle(harness, review.page, identity);
            return bundle.proposals.every((row) => row.application)
              ? bundle
              : null;
          },
          "real Native Prepare/Apply committed",
          60_000,
        );
        appliedSnapshot = await inspectNative(
          harness,
          review.page,
          applied,
          sceneId,
        );
        assertChronicleApplied(appliedSnapshot, applied, sceneId);
        const appliedSynthesisCompanion = await readChronicleSynthesisCompanion(
          harness,
          review.page,
          applied,
        );
        assert.deepEqual(appliedSynthesisCompanion, initialSynthesisCompanion);
        assert.deepEqual(
          applied.artifacts
            .map((row) => [row.artifactId, row.payloadDigest])
            .sort(),
          artifactDigests,
        );
        assert.deepEqual(
          applied.stageReceipts
            .map((row) => [
              row.stageExecution.stageExecutionId,
              row.stageExecutionReceiptDigest,
            ])
            .sort(),
          stageReceiptDigests,
        );
        harness.recordTimeline(`${ID}/applied`, {
          ...identity,
          evidence: await saveEvidence(directory, "applied", {
            bundle: applied,
            persistedSynthesisCompanion: appliedSynthesisCompanion,
            native: appliedSnapshot,
          }),
        });
      } finally {
        await harness.close(
          review.app,
          review.page,
          `${ID}/extract-review-apply`,
        );
      }
      const reopened = await harness.launch(`${ID}/reopen`);
      try {
        await waitForChronicleFixtureWorkspace(harness, reopened.page, {
          projectId,
          sceneId,
        });
        const reopenedPolicy = await readFixtureApplyPolicy(
          harness,
          reopened.page,
          fixtureApplyPolicy.after,
        );
        const bundle = await reviewBundle(harness, reopened.page, identity);
        const reopenedSynthesisCompanion =
          await readChronicleSynthesisCompanion(harness, reopened.page, bundle);
        assert.deepEqual(reopenedSynthesisCompanion, initialSynthesisCompanion);
        const restored = await inspectNative(
          harness,
          reopened.page,
          bundle,
          sceneId,
        );
        assertChronicleApplied(restored, bundle, sceneId);
        assert.deepEqual(restored.events, appliedSnapshot.events);
        assert.deepEqual(restored.applications, appliedSnapshot.applications);
        assert.deepEqual(restored.envelopes, appliedSnapshot.envelopes);
        assert.deepEqual(restored.journals, appliedSnapshot.journals);
        assert.deepEqual(
          bundle.artifacts
            .map((row) => [row.artifactId, row.payloadDigest])
            .sort(),
          artifactDigests,
        );
        assert.deepEqual(
          bundle.stageReceipts
            .map((row) => [
              row.stageExecution.stageExecutionId,
              row.stageExecutionReceiptDigest,
            ])
            .sort(),
          stageReceiptDigests,
        );
        await showChronicleFixturePanel(reopened.page);
        for (const title of ["門が開いた", "鐘が鳴った"])
          await reopened.page
            .getByText(title, { exact: true })
            .first()
            .waitFor({ state: "visible" });
        await reopened.page.getByTitle("AI 抽出", { exact: true }).click();
        const dialog = reopened.page.getByRole("dialog");
        assert.equal(
          await dialog
            .locator('[data-testid^="chronicle-proposal-card-"]')
            .count(),
          0,
        );
        const resumable = await harness.invokeOk(
          reopened.page,
          "narrative_extraction_is_run_resumable_for_review",
          { payload: { ...identity, surfacePathId: "chronicle.extract" } },
        );
        assert.equal(resumable.resumable, false);
        harness.recordTimeline(`${ID}/reopened`, {
          ...identity,
          eventCount: 2,
          applicationCount: 2,
          commitCount: 1,
          duplicateCount: 0,
          evidence: await saveEvidence(directory, "reopened", {
            bundle,
            fixtureRuntimePolicy: reopenedPolicy,
            persistedSynthesisCompanion: reopenedSynthesisCompanion,
            native: restored,
          }),
        });
      } finally {
        await harness.close(reopened.app, reopened.page, `${ID}/reopen`);
      }
    },
  };
}
