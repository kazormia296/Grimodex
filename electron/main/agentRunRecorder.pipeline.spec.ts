import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NapiBackendLike } from "../shared/ipcContract.js";
import { createAgentRunRecorder } from "./agentRunRecorder.js";

vi.mock("electron", () => ({ dialog: {} }));

type NativeBackendInstance = Parameters<
  typeof createAgentRunRecorder
>[0]["backend"] &
  Required<
    Pick<
      NapiBackendLike,
      | "openWorkspace"
      | "dbExecute"
      | "seedSampleWorkspace"
      | "shutdownWorkspaceLifecycle"
    >
  >;

const require = createRequire(import.meta.url);
const { Backend } = require("../native/grimodex-node/grimodex-node.node") as {
  Backend: new (appData: string) => NativeBackendInstance;
};

let root: string | undefined;
let backend: NativeBackendInstance | undefined;

afterEach(async () => {
  try {
    await backend?.shutdownWorkspaceLifecycle();
  } finally {
    if (root) await rm(root, { recursive: true, force: true });
    backend = undefined;
    root = undefined;
  }
});

async function openFixture() {
  root = await mkdtemp(path.join(os.tmpdir(), "grimodex-agentrun-"));
  const appData = path.join(root, "app-data");
  await mkdir(appData);
  const native = new Backend(appData);
  backend = native;
  const { path: workspacePath, projectId } = JSON.parse(
    await native.seedSampleWorkspace(
      "ja",
      '{"preset":"full","toggles":{"chat":true,"bodyWrite":true,"analysis":true,"structureWrite":true,"knowledgeWrite":true}}',
    ),
  ) as { path: string; projectId: string };
  await native.openWorkspace(workspacePath);
  const turn = {
    senderId: 7,
    projectId,
    chatSessionId: "chat",
    operationId: "turn",
    route: "legacy",
    userMessageId: "user-message",
    assistantMessageId: "assistant-message",
    providerId: "fixture-provider",
    modelId: "fixture-model",
    endpointHash: "fixture-endpoint-hash",
  } as const;
  await native.dbExecute(
    "INSERT INTO chat_sessions (id, project_id, title) VALUES (?, ?, ?)",
    [turn.chatSessionId, turn.projectId, "Chat"],
    "run",
  );
  const digest = "a".repeat(64);
  const recorder = createAgentRunRecorder({
    backend: native,
    isEnabled: () => true,
    toolInputDigest: () => digest,
    newRunId: randomUUID,
  });
  const started = await recorder.start(turn);
  if (started.kind !== "recorded") throw new Error("expected a recorded Run");
  const { runId } = started;
  const status = async (): Promise<unknown> =>
    JSON.parse(await native.agentRunGetStatus({ runId }));
  return { native, recorder, turn, digest, runId, status };
}

describe("AgentRun recorder against the real Native addon", () => {
  it("records a response, approves its tool, updates the ledger and finalizes", async () => {
    const { native, recorder, turn, digest, runId, status } =
      await openFixture();
    expect(await status()).toMatchObject({
      runId,
      status: "running",
      version: 0,
      ownedByCaller: true,
    });
    const call = { executionId: "execution", toolCallId: "tool-call" };
    const toolName = "update_fixture";
    expect(
      await recorder.recordResponse({
        ...turn,
        executionId: call.executionId,
        chatMessageId: turn.assistantMessageId,
        model: turn.modelId,
        toolUses: [
          { id: call.toolCallId, name: toolName, input: { title: "Revised" } },
        ],
      }),
    ).toBe("recorded");
    const resolution = recorder.resolveRun({
      ...turn,
      executionId: call.executionId,
    });
    if (resolution.kind !== "recorded")
      throw new Error("expected ledger binding");
    const interactionId = "approval";
    const opened = await resolution.transact((expectedVersion) =>
      recorder.openApproval({
        ...call,
        runId,
        expectedVersion,
        interactionId,
        toolName,
        argsDigest: digest,
        request: "Update the title",
        targetBasis: null,
      }),
    );
    expect(opened).toEqual({
      runId,
      version: 1,
      status: "waiting_approval",
      interactionVersion: 0,
    });
    const pending = await recorder.getPendingApproval(runId);
    expect(pending).toEqual({
      ...call,
      interactionId,
      version: 0,
      toolName,
      argsDigest: digest,
      targetBasis: null,
    });
    const decided = await resolution.transact((expectedVersion) =>
      recorder.decideApproval({
        runId,
        expectedVersion,
        interactionId,
        interactionVersion: opened.interactionVersion,
        decision: "approved",
      }),
    );
    expect(decided).toEqual({ runId, version: 2, status: "running" });
    expect(await recorder.getPendingApproval(runId)).toBeNull();
    await recorder.updateToolCall(runId, call, {
      mainOwnedProvenanceId: "provenance",
      capabilityState: "issued",
    });
    await recorder.updateToolCall(runId, call, {
      capabilityState: "consumed",
      executionState: "committed",
    });
    expect(
      await recorder.beginFinalizing(
        turn,
        "completed",
        turn.assistantMessageId,
      ),
    ).toEqual({
      runId,
      version: 3,
      status: "finalizing",
    });
    for (const [id, role] of [
      [turn.userMessageId, "user"],
      [turn.assistantMessageId, "assistant"],
    ]) {
      await native.dbExecute(
        "INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)",
        [id, turn.chatSessionId, role, "Fixture message"],
        "run",
      );
    }
    expect(await recorder.finishFinalizing(turn)).toEqual({
      runId,
      version: 4,
      status: "completed",
    });
    expect(await status()).toMatchObject({
      status: "completed",
      terminalReason: "completed",
      version: 4,
    });
    expect(
      recorder.resolveRun({ ...turn, executionId: call.executionId }),
    ).toEqual({ kind: "unrecorded" });
  });

  it("recovers finalizing as interrupted when the messages are incomplete", async () => {
    const { recorder, turn, status } = await openFixture();
    await recorder.beginFinalizing(turn, "completed", turn.assistantMessageId);
    await recorder.interruptSender(turn.senderId, "renderer_lost");
    expect(await status()).toMatchObject({
      status: "interrupted",
      interruptReason: "renderer_lost",
      version: 2,
      resumable: true,
    });
  });
});
