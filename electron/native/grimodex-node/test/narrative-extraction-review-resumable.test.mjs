// Exact review-resumability N-API boundary. Shared-Rust integration tests own
// the bounded-list regression; this file proves serde, workspace routing, and
// camelCase JSON serialization through the generated Node binding.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));

const root = mkdtempSync(join(tmpdir(), "grimodex-node-review-resumable-"));
process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
  }
});

const backend = new Backend(join(root, "app-data"));
const payload = {
  runId: "run-review-resumable",
  projectId: "default-project",
  surfacePathId: "chronicle.extract",
};

test("exact Review resumability crosses the N-API boundary without discovery limits", async () => {
  const workspacePath = join(root, "workspace");
  await backend.openWorkspace(workspacePath);
  const workspaceBinding = JSON.parse(
    await backend.narrativeExtractionCaptureWorkspaceBinding(workspacePath),
  );
  await backend.narrativeExtractionCreateRun(
    {
      ...payload,
      scopeJson: {},
      specJson: { kind: "legacy-review-test@1" },
      specDigest: "sha256:test-spec",
      tasks: [],
    },
    workspaceBinding,
  );
  const saved = JSON.parse(
    await backend.narrativeExtractionSaveProposalSet(
      {
        runId: payload.runId,
        projectId: payload.projectId,
        proposalSetId: "set-review-resumable",
        setKind: "chronicle.extract.review@1",
        proposals: [
          {
            proposalId: "proposal-review-resumable",
            proposalKey: "proposal:key",
            kind: "chronicle.create-event@1",
            payloadJson: {},
          },
        ],
      },
      workspaceBinding,
    ),
  );
  const revisionId = saved.proposals[0].revisionId;

  assert.deepEqual(
    JSON.parse(
      await backend.narrativeExtractionIsRunResumableForReview(payload),
    ),
    { ...payload, resumable: true },
  );

  await backend.narrativeExtractionAppendHumanDecision({
    runId: payload.runId,
    projectId: payload.projectId,
    proposalId: "proposal-review-resumable",
    revisionId,
    decision: "rejected",
    decisionJson: { reason: "napi-boundary-test" },
  });
  assert.deepEqual(
    JSON.parse(
      await backend.narrativeExtractionIsRunResumableForReview(payload),
    ),
    { ...payload, resumable: false },
  );
});

test("exact Review resumability rejects unknown fields and scope mismatches", async () => {
  await assert.rejects(
    backend.narrativeExtractionIsRunResumableForReview({
      ...payload,
      unknown: true,
    }),
    /unknown field/u,
  );
  await assert.rejects(
    backend.narrativeExtractionIsRunResumableForReview({
      ...payload,
      projectId: "other-project",
    }),
    /scope mismatch/u,
  );
  await assert.rejects(
    backend.narrativeExtractionIsRunResumableForReview({
      ...payload,
      runId: ` ${payload.runId}`,
    }),
    /non-empty and unpadded/u,
  );
});
