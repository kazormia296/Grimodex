// Complete AI-use audit ledger N-API boundary contract.
// Run after `pnpm napi:build`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));

const root = mkdtempSync(join(tmpdir(), "grimodex-node-ai-audit-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const backend = new Backend(join(root, "app-data"));
const projectId = "default-project";

function event(eventId, eventType, timestamp) {
  return {
    eventId,
    executionId: "execution-1",
    operationId: "operation-1",
    parentExecutionId: null,
    pathId: "chat_agent_main",
    eventType,
    timestamp,
    payload: {
      captureState: "complete",
      credentialsExcluded: true,
      request: {
        messages: [{ role: "user", content: `prompt:${eventId}` }],
      },
      appVersion: "2.0.10",
    },
  };
}

test("AI audit N-API exports pin workspace/scope/high-water and round-trip JSON", async () => {
  await assert.rejects(
    backend.aiAuditReadSnapshot(root, projectId, 0, undefined, 10),
    /No workspace is open/,
  );

  const workspace = join(root, "workspace");
  await backend.openWorkspace(workspace);
  const expectedWorkspacePath = realpathSync(workspace);
  const firstBatch = [
    event("event-1", "execution.started", 1),
    event("event-2", "request.prepared", 2),
    event("event-3", "request.dispatched", 3),
  ];

  const first = JSON.parse(
    await backend.aiAuditAppendBatch(
      expectedWorkspacePath,
      projectId,
      firstBatch,
    ),
  );
  assert.deepEqual(
    { insertedCount: first.insertedCount, tailSequence: first.tailSequence },
    { insertedCount: 3, tailSequence: 3 },
  );
  const resent = JSON.parse(
    await backend.aiAuditAppendBatch(
      expectedWorkspacePath,
      projectId,
      firstBatch,
    ),
  );
  assert.equal(resent.insertedCount, 0);

  const firstPage = JSON.parse(
    await backend.aiAuditReadSnapshot(
      expectedWorkspacePath,
      projectId,
      0,
      undefined,
      2,
    ),
  );
  assert.equal(firstPage.scopeId, `project:${projectId}`);
  assert.equal(firstPage.projectId, projectId);
  assert.equal(firstPage.highWaterSequence, 3);
  assert.equal(firstPage.nextAfterSequence, 2);
  assert.equal(firstPage.events[0].payload.appVersion, "2.0.10");

  const terminal = JSON.parse(
    await backend.aiAuditAppendBatch(expectedWorkspacePath, projectId, [
      event("event-4", "response.completed", 4),
      event("event-5", "execution.succeeded", 5),
    ]),
  );
  assert.deepEqual(
    {
      insertedCount: terminal.insertedCount,
      tailSequence: terminal.tailSequence,
    },
    { insertedCount: 2, tailSequence: 5 },
  );
  const pinnedPage = JSON.parse(
    await backend.aiAuditReadSnapshot(
      expectedWorkspacePath,
      projectId,
      firstPage.nextAfterSequence,
      firstPage.highWaterSequence,
      2,
    ),
  );
  assert.deepEqual(
    pinnedPage.events.map((item) => item.eventId),
    ["event-3"],
  );
  assert.equal(pinnedPage.highWaterHash, firstPage.highWaterHash);
  assert.equal(pinnedPage.nextAfterSequence, null);

  const verified = JSON.parse(
    await backend.aiAuditVerify(
      expectedWorkspacePath,
      projectId,
      firstPage.highWaterSequence,
    ),
  );
  assert.deepEqual(
    {
      ok: verified.ok,
      verifiedThroughSequence: verified.verifiedThroughSequence,
      tailHash: verified.tailHash,
    },
    {
      ok: true,
      verifiedThroughSequence: 3,
      tailHash: firstPage.highWaterHash,
    },
  );

  const workspaceAppend = JSON.parse(
    await backend.aiAuditAppendBatch(expectedWorkspacePath, undefined, [
      event("workspace-event-1", "execution.started", 5),
    ]),
  );
  assert.equal(workspaceAppend.tailSequence, 1);
  const workspaceSnapshot = JSON.parse(
    await backend.aiAuditReadSnapshot(
      expectedWorkspacePath,
      undefined,
      0,
      undefined,
      10,
    ),
  );
  assert.equal(workspaceSnapshot.scopeId, "workspace");
  assert.equal(workspaceSnapshot.projectId, null);

  await assert.rejects(
    backend.aiAuditVerify(realpathSync(root), projectId, 3),
    /AI_AUDIT_WORKSPACE_CHANGED/,
  );
});
