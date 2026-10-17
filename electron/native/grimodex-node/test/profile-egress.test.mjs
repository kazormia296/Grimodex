// D2a Native profile gate contract.  This exercises only startup state and
// persistence; AI transport tests remain responsible for provider behavior.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

test("D2a startup stays dormant until explicit activation, then survives restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "grimodex-node-d2a-"));
  const appData = join(root, "app-data");
  try {
    const first = new Backend(appData);
    const initialized = JSON.parse(
      await boundedStartup(
        first.initializeProfileEgress(),
        "first Native startup",
      ),
    );
    assert.equal(initialized.restricted, false);
    assert.equal(initialized.handlesInvalidated, false);
    assert.equal(initialized.inFlightStopped, true);
    assert.equal(initialized.chatStreamsStopped, 0);
    assert.equal(initialized.inlineStreamsStopped, 0);
    assert.equal(initialized.postEffectRunsStopped, 0);
    assert.equal(existsSync(join(appData, "profile-egress.json")), false);

    const activated = JSON.parse(
      await boundedStartup(
        first.activateProfileEgress(),
        "first Native activation",
      ),
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
      // G-2: a restricted profile refuses the legacy entry before looking at
      // the caller (it used to fail on the missing identity).
      /D2A_EGRESS_DENIED:.*provider egress is closed while the profile is restricted/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the retrieval harness's restricted state file starts Native as a restricted, quiesced profile", async () => {
  // NIR-1 DA-1 ST4: `run-nir1-retrieval.mjs --d2a-mode restricted` places this
  // file before Electron starts (it is not an activation). Native must read it
  // as the already restricted profile the R / R+IR parity is measured in.
  const { restrictedProfileEgressState } = await import(
    "../../../../scripts/quality/run-nir1-retrieval.mjs"
  );
  const root = mkdtempSync(join(tmpdir(), "grimodex-node-d2a-harness-"));
  const appData = join(root, "app-data");
  try {
    mkdirSync(appData, { recursive: true });
    const state = restrictedProfileEgressState("harness-profile");
    writeFileSync(join(appData, "profile-egress.json"), JSON.stringify(state));
    const backend = new Backend(appData);
    const status = JSON.parse(
      await boundedStartup(backend.initializeProfileEgress(), "harness startup"),
    );
    assert.equal(status.profileId, "harness-profile");
    assert.equal(status.callerEpoch, state.callerEpoch);
    assert.equal(status.restricted, true);
    assert.equal(status.inFlightStopped, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Retain failed cleanup and its workspace fences; GC is not Native teardown.
let rebindCleanupOwner;

test("D2a accepts one registered identity, persists settings, then rejects it after workspace rebind", async () => {
  if (rebindCleanupOwner) throw new Error("previous rebind cleanup owner is unresolved");
  const root = mkdtempSync(join(tmpdir(), "grimodex-node-d2a-rebind-"));
  const owner = { root, backend: undefined };
  rebindCleanupOwner = owner;
  try {
    const backend = new Backend(join(root, "app-data"));
    owner.backend = backend;
    await backend.initializeProfileEgress();
    const status = JSON.parse(await backend.activateProfileEgress());
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
      // G-2: refused outright, whatever the identity state (it used to fail on
      // the stale identity after the workspace rebind).
      /D2A_EGRESS_DENIED:.*provider egress is closed while the profile is restricted/,
    );
  } finally {
    if (owner.backend) {
      const wire = await owner.backend.shutdownWorkspaceLifecycle();
      assert.equal(JSON.parse(wire).status, "closed", "Native cleanup must prove Closed");
    }
    rmSync(root, { recursive: true, force: true });
    rebindCleanupOwner = undefined;
  }
});
