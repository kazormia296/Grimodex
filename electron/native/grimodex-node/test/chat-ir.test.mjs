// chat IR S1-A (DR-CHATIR-S1-27): `chatAgentIrSelect` through the real addon.
// The route is closed: the Native gate refuses before the payload is read, and
// nothing in the product opens it.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));

const REQUEST = {
  query: "a query",
  projectId: "project-1",
  expectedWorkspacePath: "/nonexistent-workspace",
  currentSceneId: "scene-1",
};

const STATUSES = new Set([
  "available",
  "none-above-threshold",
  "timeout",
  "connection-busy",
  "embedder-cold",
  "busy",
  "ledger-full",
  "index-unavailable",
  "unsupported",
  "no-current-scene",
  "project-unavailable",
  "project-changed",
  "workspace-unavailable",
  "workspace-changed",
  "query-invalid",
  "inference-failed",
  "internal",
]);

function rig() {
  const root = mkdtempSync(join(tmpdir(), "grimodex-chat-ir-"));
  const backend = new Backend(join(root, "app-data"));
  return {
    backend,
    close: async () => {
      await backend.shutdownWorkspaceLifecycle();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("the command is declared and exported", () => {
  const declarations = readFileSync(join(here, "..", "index.d.ts"), "utf8");
  assert.match(declarations, /chatAgentIrSelect\(payload: any\): Promise<string>/);
  assert.equal(typeof Backend.prototype.chatAgentIrSelect, "function");
});

test("the closed Native gate refuses before the payload is read", async () => {
  const r = rig();
  try {
    for (const payload of [REQUEST, "not an object", { extra: 1 }, null]) {
      await assert.rejects(
        r.backend.chatAgentIrSelect(payload),
        /CHAT_IR_GATE_CLOSED/,
      );
    }
  } finally {
    await r.close();
  }
});

test("an open gate still refuses a request of the wrong shape, and every answer is a closed status", async () => {
  const r = rig();
  try {
    // Only this test's own Backend; nothing in the product does this.
    r.backend.mainOpenPrePublicationGate("chat-agent-ir");
    await assert.rejects(
      r.backend.chatAgentIrSelect({ ...REQUEST, extra: true }),
      /CHAT_IR_INVALID_REQUEST/,
    );
    const refused = JSON.parse(
      await r.backend.chatAgentIrSelect({ ...REQUEST, query: "x".repeat(501) }),
    );
    assert.equal(refused.status, "query-invalid");
    assert.equal(refused.success, false);
    // No workspace is open: the call ends in a status of the closed set.
    const answer = JSON.parse(await r.backend.chatAgentIrSelect(REQUEST));
    assert.ok(STATUSES.has(answer.status), answer.status);
    assert.equal(answer.success, false);
    assert.deepEqual(answer.items, []);
  } finally {
    await r.close();
  }
});
