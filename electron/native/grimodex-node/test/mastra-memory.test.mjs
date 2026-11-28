import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));
const root = mkdtempSync(join(tmpdir(), "grimodex-node-mastra-memory-"));
const backend = new Backend(join(root, "app-data"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

after(async () => {
  assert.equal(JSON.parse(await backend.shutdownWorkspaceLifecycle()).status, "closed");
});

test("all typed Mastra memory commands roundtrip through the main-only N-API", async () => {
  await backend.openWorkspace(join(root, "workspace"));

  const resource = { id: "mp7b4-resource", projectId: "default-project" };
  const threadId = "mp7b4-thread";
  const messageId = "mp7b4-message";
  const indexName = "mp7b4-index";
  const wire = (value) => JSON.parse(value);

  assert.ok(wire(await backend.memoryResourceWrite({
    operation: "save", ...resource, workingMemory: "memory", metadata: {},
  })));
  assert.ok(wire(await backend.memoryResourceRead({
    operation: "get", projectId: resource.projectId,
  })));
  await backend.memoryThreadWrite({
    operation: "save",
    thread: { id: threadId, resourceId: resource.id, title: "test" },
  });
  assert.ok(wire(await backend.memoryThreadRead({
    operation: "get", threadId, resourceId: resource.id,
  })));
  await backend.memoryMessageWrite({
    operation: "save",
    messages: [{
      id: messageId,
      threadId,
      role: "user",
      createdAt: "2026-11-27T00:00:00.000Z",
      content: { text: "hello" },
    }],
  });
  assert.equal(wire(await backend.memoryMessageRead({
    operation: "byId", messageIds: [messageId],
  })).messages.length, 1);

  await backend.memoryVectorCreateIndex(indexName, 3);
  await backend.memoryVectorUpsert(indexName, [{
    id: "v1", vector: [1, 0, 0], metadata: { messageId }, messageId, projectId: resource.projectId,
  }, {
    id: "v2", vector: [0, 1, 0], metadata: { messageId }, messageId, projectId: resource.projectId,
  }]);
  assert.equal(wire(await backend.memoryVectorQuery(indexName, [1, 0, 0], 1)).length, 1);
  assert.ok(wire(await backend.memoryVectorListIndexes()).includes(indexName));
  assert.equal(wire(await backend.memoryVectorDescribeIndex(indexName)).dimension, 3);
  await backend.memoryVectorUpdate(indexName, "v1", [0, 0, 1], { messageId });
  await backend.memoryVectorDeleteMany(indexName, ["v2"]);
  await backend.memoryVectorDelete(indexName, "v1");
  await backend.memoryVectorDeleteIndex(indexName);

  assert.ok(wire(await backend.memoryObservationalMemoryRead({
    operation: "get", threadId, resourceId: resource.id,
  })) === null);
  await backend.memoryObservationalMemoryWrite({
    operation: "clear", threadId, resourceId: resource.id,
  });
  await backend.memoryMessageDelete({ messageIds: [messageId] });
  await backend.memoryThreadDelete({ threadId });
});
