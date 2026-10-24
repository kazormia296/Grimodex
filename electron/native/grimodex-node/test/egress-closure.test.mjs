// NIR-1 DA-1 ST2 (K3/2 G-2): the eight legacy provider-egress Native entries
// refuse a restricted profile even when the caller is registered and the
// profile is quiesced. Main never reaches them (its gate refuses first), but a
// restricted-restarted process has no Main participant stop and Main's ledger
// could be misclassified, so Native closes them itself. Native is called
// directly here, without Main, with an identity that satisfies the other gate
// conditions.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { closeMockServer, startMockServer } from "./mock-http.mjs";
import { activateThroughGrant } from "./profile-activation-helper.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));

const roots = [];
process.on("exit", () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const DENIED = /D2A_EGRESS_DENIED:.*provider egress is closed while the profile is restricted/;

function newRoot() {
  const root = mkdtempSync(join(tmpdir(), "grimodex-node-egress-closure-"));
  roots.push(root);
  const appData = join(root, "app-data");
  mkdirSync(appData, { recursive: true });
  return { root, appData };
}

function writeAiSettings(appData, baseUrl) {
  writeFileSync(
    join(appData, "ai-settings.json"),
    JSON.stringify({
      provider: "openai-compatible",
      model: "mock-model",
      ollamaEndpoint: "",
      openaiCompatibleEndpoints: [{ id: "test", baseUrl }],
      activeOpenaiCompatibleEndpointId: "test",
    }),
  );
}

function auditContext(workspace, id) {
  return {
    expectedWorkspacePath: workspace,
    projectId: null,
    operationId: `op-${id}`,
    executionId: `exec-${id}`,
    parentExecutionId: null,
    pathId: `closure-${id}`,
  };
}

/** Every legacy entry, each with the caller identity that Main would register. */
function legacyEntries(backend, settings, identity, workspace) {
  const withAudit = (id, extra = {}) => ({
    ...extra,
    callerIdentity: identity,
    auditContext: auditContext(workspace, id),
  });
  const postEffect = {
    expectedWorkspacePath: workspace,
    callerIdentity: identity,
    sceneId: "scene-1",
  };
  return [
    [
      "startPostEffectRun",
      () => backend.startPostEffectRun(postEffect, settings, "sk-injected", null),
    ],
    [
      "startPostEffectRunMulti",
      () =>
        backend.startPostEffectRunMulti(
          { ...postEffect, sceneIds: ["scene-1"] },
          settings,
          "sk-injected",
          null,
        ),
    ],
    [
      "sendChatMessage",
      () =>
        backend.sendChatMessage(
          withAudit("chat", { messages: [{ role: "user", content: "x" }] }),
          settings,
          "sk-injected",
        ),
    ],
    [
      "sendChatMessageStream",
      () =>
        backend.sendChatMessageStream(
          withAudit("chat-stream", {
            messages: [{ role: "user", content: "x" }],
            streamId: "exec-chat-stream",
          }),
          settings,
          "sk-injected",
        ),
    ],
    [
      "sendInlineAiStream",
      () =>
        backend.sendInlineAiStream(
          withAudit("inline", {
            messages: [{ role: "user", content: "x" }],
            streamId: "exec-inline",
          }),
          settings,
          "sk-injected",
        ),
    ],
    [
      "sendAgentMessage",
      () =>
        backend.sendAgentMessage(
          withAudit("agent", {
            messages: [],
            tools: [],
            resolvedToolProtocol: "native",
          }),
          settings,
          "sk-injected",
        ),
    ],
    [
      "listAiModels",
      () =>
        backend.listAiModels(
          { provider: "openai-compatible", callerIdentity: identity },
          settings,
          "sk-injected",
        ),
    ],
    [
      "testAiConnection",
      () =>
        backend.testAiConnection(
          withAudit("connection", {
            provider: "openai-compatible",
            model: "probe-model",
          }),
          settings,
          "sk-injected",
        ),
    ],
  ];
}

async function registeredIdentity(backend, status, workspace) {
  const identity = {
    profileId: status.profileId,
    callerId: "main-issued-caller",
    callerEpoch: status.callerEpoch,
    senderId: 17,
    workspaceId: workspace,
    sessionId: "main-issued-session",
  };
  // Registration itself requires restricted + quiesced: this is the
  // "registered, stopped" identity of G-2.
  backend.registerProfileEgressCaller(JSON.stringify(identity));
  return identity;
}

async function assertAllEntriesClosed(backend, status, workspace, settings, hits) {
  const identity = await registeredIdentity(backend, status, workspace);
  const entries = legacyEntries(backend, settings, identity, workspace);
  assert.equal(entries.length, 8);
  for (const [name, call] of entries) {
    await assert.rejects(call(), DENIED, `${name} must refuse a restricted profile`);
  }
  assert.equal(hits(), 0, "no provider request may be sent");
}

test("control: an unrestricted profile still reaches the provider through the same Native entry", async () => {
  let hitCount = 0;
  const { server, baseUrl } = await startMockServer((_req, res) => {
    hitCount += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "model-a", name: "Model A" }] }));
  });
  try {
    const { appData } = newRoot();
    writeAiSettings(appData, baseUrl);
    const backend = new Backend(appData);
    const status = JSON.parse(await backend.initializeProfileEgress());
    assert.equal(status.restricted, false);
    const settings = JSON.parse(await backend.getAiSettings());
    const models = JSON.parse(
      await backend.listAiModels({ provider: "openai-compatible" }, settings, ""),
    );
    assert.deepEqual(models, [{ id: "model-a", name: "Model A" }]);
    assert.equal(hitCount, 1);
  } finally {
    await closeMockServer(server);
  }
});

test("G-2: all eight legacy entries refuse after activation, for a registered stopped caller", async () => {
  let hitCount = 0;
  const { server, baseUrl } = await startMockServer((_req, res) => {
    hitCount += 1;
    res.writeHead(500).end();
  });
  try {
    const { root, appData } = newRoot();
    writeAiSettings(appData, baseUrl);
    const backend = new Backend(appData);
    await backend.initializeProfileEgress();
    const status = JSON.parse(await activateThroughGrant(backend));
    assert.equal(status.restricted, true);
    assert.equal(status.inFlightStopped, true);
    const workspace = join(root, "workspace-a");
    await backend.openWorkspace(workspace);
    const settings = JSON.parse(await backend.getAiSettings());
    await assertAllEntriesClosed(backend, status, workspace, settings, () => hitCount);
  } finally {
    await closeMockServer(server);
  }
});

test("G-2: all eight legacy entries refuse in a process restarted on a restricted profile", async () => {
  let hitCount = 0;
  const { server, baseUrl } = await startMockServer((_req, res) => {
    hitCount += 1;
    res.writeHead(500).end();
  });
  try {
    const { root, appData } = newRoot();
    writeAiSettings(appData, baseUrl);
    const first = new Backend(appData);
    await first.initializeProfileEgress();
    await activateThroughGrant(first);

    // A new Backend on the same app data is a restarted process: Main's
    // "stop the external transports" participants never ran for it.
    const restarted = new Backend(appData);
    const status = JSON.parse(await restarted.initializeProfileEgress());
    assert.equal(status.restricted, true);
    assert.equal(status.inFlightStopped, true);
    const workspace = join(root, "workspace-b");
    await restarted.openWorkspace(workspace);
    const settings = JSON.parse(await restarted.getAiSettings());
    await assertAllEntriesClosed(restarted, status, workspace, settings, () => hitCount);
  } finally {
    await closeMockServer(server);
  }
});
