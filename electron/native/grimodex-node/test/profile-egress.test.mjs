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

test("D2a profile restriction survives restart without workspace SQLite", async () => {
  const root = mkdtempSync(join(tmpdir(), "grimodex-node-d2a-"));
  const appData = join(root, "app-data");
  try {
    const first = new Backend(appData);
    const activated = JSON.parse(await first.initializeProfileEgress());
    assert.equal(activated.restricted, true);
    assert.equal(activated.handlesInvalidated, true);
    assert.equal(activated.inFlightStopped, true);
    assert.equal(activated.chatStreamsStopped, 0);
    assert.equal(activated.inlineStreamsStopped, 0);

    const statePath = join(appData, "profile-egress.json");
    assert.equal(existsSync(statePath), true);
    const persisted = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(persisted.restricted, true);
    assert.equal(existsSync(join(appData, "global-settings.json")), false);

    const second = new Backend(appData);
    const restarted = JSON.parse(await second.initializeProfileEgress());
    assert.equal(restarted.profileId, activated.profileId);
    assert.ok(restarted.callerEpoch > activated.callerEpoch);
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
