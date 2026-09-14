// D2a Native profile gate contract.  This exercises only startup state and
// persistence; AI transport tests remain responsible for provider behavior.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));

async function boundedStartup(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded bounded startup window`)),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("D2a profile restriction survives restart without workspace SQLite", async () => {
  const root = mkdtempSync(join(tmpdir(), "grimodex-node-d2a-"));
  const appData = join(root, "app-data");
  try {
    const first = new Backend(appData);
    const activated = JSON.parse(
      await boundedStartup(first.initializeProfileEgress(), "first Native startup"),
    );
    assert.equal(activated.restricted, true);
    assert.equal(activated.handlesInvalidated, true);
    assert.equal(activated.inFlightStopped, true);
    assert.equal(activated.chatStreamsStopped, 0);
    assert.equal(activated.inlineStreamsStopped, 0);
    assert.equal(activated.postEffectRunsStopped, 0);

    const statePath = join(appData, "profile-egress.json");
    assert.equal(existsSync(statePath), true);
    const persisted = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(persisted.schemaVersion, 2);
    assert.equal(persisted.restricted, true);
    assert.equal(persisted.handlesInvalidated, true);
    assert.equal(persisted.inFlightStopped, true);
    assert.equal(existsSync(join(appData, "global-settings.json")), false);

    const second = new Backend(appData);
    const restarted = JSON.parse(
      await boundedStartup(second.initializeProfileEgress(), "restarted Native startup"),
    );
    assert.equal(restarted.profileId, activated.profileId);
    assert.equal(restarted.callerEpoch, activated.callerEpoch);
    assert.equal(restarted.restricted, true);

    await assert.rejects(
      second.sendChatMessage(
        {
          messages: [],
          auditContext: {
            expectedWorkspacePath: "/tmp/not-open",
            projectId: null,
            operationId: "op-1",
            executionId: "exec-1",
            parentExecutionId: null,
            pathId: "d2a-test",
          },
        },
        "{}",
        "",
      ),
      /D2A_EGRESS_DENIED:.*missing/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("D2a accepts one registered identity, persists settings, then rejects it after workspace rebind", async () => {
  const root = mkdtempSync(join(tmpdir(), "grimodex-node-d2a-rebind-"));
  try {
    const backend = new Backend(join(root, "app-data"));
    const status = JSON.parse(await backend.initializeProfileEgress());
    const firstWorkspace = join(root, "workspace-a");
    await backend.openWorkspace(firstWorkspace);
    const identity = {
      profileId: status.profileId,
      callerId: "main-caller",
      callerEpoch: status.callerEpoch,
      senderId: 42,
      workspaceId: firstWorkspace,
      sessionId: "main-session",
    };
    await backend.registerProfileEgressCaller(JSON.stringify(identity));

    const settings = JSON.parse(await backend.getGlobalSettings());
    settings.theme = "dark";
    await backend.saveGlobalSettings(settings);
    assert.equal(
      JSON.parse(await backend.getGlobalSettings()).theme,
      "dark",
    );

    const secondWorkspace = join(root, "workspace-b");
    await backend.openWorkspace(secondWorkspace);
    await assert.rejects(
      backend.sendChatMessage(
        {
          messages: [],
          callerIdentity: identity,
          auditContext: {
            expectedWorkspacePath: secondWorkspace,
            projectId: null,
            operationId: "rebind-operation",
            executionId: "rebind-execution",
            parentExecutionId: null,
            pathId: "d2a-rebind",
          },
        },
        "{}",
        "",
      ),
      /D2A_EGRESS_DENIED:.*stale/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
