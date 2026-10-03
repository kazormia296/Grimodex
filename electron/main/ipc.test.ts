import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { getSchema } from "@tiptap/core";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";

import type { Envelope, NapiBackendLike } from "../shared/ipcContract.js";
import { IPC } from "../shared/ipcContract.js";
import {
  createNarrativeMaintenanceScheduler,
  NARRATIVE_MAINTENANCE_BACKLOG_DELAY_MS,
  NARRATIVE_MAINTENANCE_FOREGROUND_RELEASE_DELAY_MS,
} from "./narrativeMaintenance.js";
import type { NarrativeMaintenanceCiSeam } from "./narrativeMaintenanceCiSeam.js";
import { createCliAiManager } from "./cliAi.js";
import {
  createProfileEgressGate,
  D2A_EGRESS_DENIED_MARKER,
} from "./profileEgress.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (
      event: { sender: unknown },
      cmd: unknown,
      args: unknown,
    ) => Promise<Envelope>
  >(),
  buildShellCommandHandlers: vi.fn(() => ({})),
  registerShellBridgeHandlers: vi.fn(),
  focusPanelWindow: vi.fn(),
  hasPanelWindow: vi.fn(),
  openPanelWindow: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
  },
  ipcMain: {
    handle: (
      channel: string,
      handler: (
        event: { sender: unknown },
        cmd: unknown,
        args: unknown,
      ) => Promise<Envelope>,
    ) => {
      mocks.handlers.set(channel, handler);
    },
  },
}));

vi.mock("./shellCommands.js", () => ({
  buildShellCommandHandlers: mocks.buildShellCommandHandlers,
  registerShellBridgeHandlers: mocks.registerShellBridgeHandlers,
}));

vi.mock("./windows.js", () => ({
  focusPanelWindow: mocks.focusPanelWindow,
  hasPanelWindow: mocks.hasPanelWindow,
  openPanelWindow: mocks.openPanelWindow,
}));

const {
  applyMainOwnedAuthorshipMarks,
  bindRendererAuthorityForIpc,
  recordRendererHistoryJournalForIpc,
  registerIpcRouter,
} = await import("./ipc.js");

function invokeHandler(): (
  event: { sender: unknown },
  cmd: unknown,
  args: unknown,
) => Promise<Envelope> {
  const handler = mocks.handlers.get(IPC.invoke);
  if (!handler) throw new Error("grim:invoke handler was not registered");
  return handler;
}

const activeNarrativeMaintenanceCiSeam: Extract<
  NarrativeMaintenanceCiSeam,
  { active: true }
> = {
  active: true,
  ownerToken: "c2-5b-product-journey-owner-v1",
  nonce: "test-nonce",
  fault: null,
  trigger: "foreground-workspace-wake",
  setup: null,
  freshness: null,
  freshnessHoldProjectId: null,
  productJourneyBarrierId: "barrier-test",
  correlation: "correlation-test",
};

async function issueAgentCapability(
  toolName: string,
  input: Record<string, unknown>,
  senderId: number,
): Promise<{
  capability: string;
  requestId: string;
  chatMessageId: string;
  executionId: string;
  mainOwnedProvenanceId: string;
  expectedEntityId?: string;
}> {
  const sendAgentMessage = vi.fn(async () =>
    JSON.stringify({
      blocks: [{ type: "tool_use", id: "call-1", name: toolName, input }],
      stopReason: "tool_use",
    }),
  );
  const dbExecute = vi.fn(async () =>
    JSON.stringify({
      rows: [[JSON.stringify({ preset: "full" })]],
    }),
  );
  registerIpcRouter(
    {
      dbExecute,
      getAiSettings: vi.fn(async () =>
        JSON.stringify({ provider: "openai", model: "gpt-test" }),
      ),
      sendAgentMessage,
    } as unknown as NapiBackendLike,
    {},
    {
      resolveApiKeyForRequest: vi.fn(() => "test-key"),
      getApiKeyForRequest: vi.fn(() => null),
    },
  );
  const chatMessageId = `assistant-${toolName}`;
  const executionId = `execution-${toolName}`;
  const envelope = await invokeHandler()(
    { sender: { id: senderId } },
    "send_agent_message",
    {
      messages: [{ role: "user", content: "write" }],
      tools: [{ name: toolName }],
      provider: "openai",
      model: "gpt-test",
      chatMessageId,
      auditContext: {
        expectedWorkspacePath: "/tmp/workspace",
        projectId: "p1",
        operationId: `turn-${toolName}`,
        executionId,
        parentExecutionId: null,
        pathId: "chat_agent_main",
      },
    },
  );
  if (!envelope.ok) throw new Error(envelope.error);
  const grant = (
    envelope.value as {
      agentAuthorityCapabilities: Record<
        string,
        {
          capability: string;
          executionId: string;
          chatMessageId: string;
          mainOwnedProvenanceId: string;
          expectedEntityId?: string;
        }
      >;
    }
  ).agentAuthorityCapabilities["call-1"];
  const requestId = `agent-tool:${createHash("sha256")
    .update(`${toolName}\0p1\0call-1`)
    .digest("hex")}`;
  return { ...grant, requestId };
}

function agentCapabilityPayload(
  grant: Awaited<ReturnType<typeof issueAgentCapability>>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    projectId: "p1",
    requestId: grant.requestId,
    eventUid: `${grant.requestId}:event`,
    origin: "ai-apply",
    chatMessageId: grant.chatMessageId,
    toolCallId: "call-1",
    executionId: grant.executionId,
    mainOwnedProvenanceId: grant.mainOwnedProvenanceId,
    agentAuthorityCapability: grant.capability,
    ...extra,
  };
}

beforeEach(() => {
  mocks.handlers.clear();
  vi.clearAllMocks();
  delete process.env.GRIMODEX_WORKSPACE_OPEN_TRACE;
});

afterEach(() => {
  delete process.env.GRIMODEX_WORKSPACE_OPEN_TRACE;
  vi.restoreAllMocks();
});

describe("registerIpcRouter fail-soft logging", () => {
  it("binds Scan staging publication only to the import authority route", () => {
    const bound = bindRendererAuthorityForIpc("scan_staging_project_publish", {
      payload: {
        projectId: "p1",
        requestId: "scan-request-1",
        sessionId: "renderer-session",
        eventUid: "scan-event-1",
        origin: "import",
        originalTransactionId: null,
        undoJournalId: null,
      },
    });

    expect(bound.payload).toMatchObject({
      origin: "import",
      authorityRoute: "import-apply",
      caller: "import-session",
      controls: [
        "import-policy",
        "source-package-evidence",
        "typed-writer",
        "occ",
        "change-event",
        "change-feed",
      ],
      provenance: null,
      writesAuthorityProtectedField: false,
    });

    const forged = bindRendererAuthorityForIpc("scan_staging_project_publish", {
      payload: {
        projectId: "p1",
        requestId: "scan-request-2",
        sessionId: "renderer-session",
        eventUid: "scan-event-2",
        origin: "human",
      },
    });
    expect((forged.payload as { authorityRoute?: string }).authorityRoute).toBe(
      "",
    );
  });

  it("binds strict renderer authority from the main-owned command policy", () => {
    const bound = bindRendererAuthorityForIpc("tree_node_create", {
      payload: {
        projectId: "p1",
        requestId: "request-1",
        sessionId: "session-1",
        eventUid: "event-1",
        origin: "human",
        authorityRoute: "interactive-agent-command",
        caller: "chat-tool-executor",
        controls: ["knowledge-write-policy"],
        provenance: { requestId: "request-1", traceId: "forged" },
        writesAuthorityProtectedField: true,
        originalTransactionId: null,
        undoJournalId: null,
        id: "node-1",
        nodeType: "scene",
        title: "Scene",
        sortOrder: "a0",
      },
    });

    expect(bound.payload).toMatchObject({
      origin: "human",
      authorityRoute: "human-direct",
      caller: "human-ui",
      controls: [
        "runtime-policy",
        "actor-context",
        "typed-writer",
        "occ",
        "change-event",
        "change-feed",
      ],
      provenance: null,
      writesAuthorityProtectedField: false,
    });
  });

  it("keeps writer session correlation separate from sender-bound authority", () => {
    const first = bindRendererAuthorityForIpc(
      "tree_node_create",
      {
        payload: {
          projectId: "p1",
          requestId: "sender-request-1",
          sessionId: "renderer-claimed-a",
          eventUid: "sender-event-1",
          origin: "human",
          id: "node-1",
          nodeType: "scene",
          title: "Scene",
          sortOrder: "a0",
        },
      },
      701,
    );
    const second = bindRendererAuthorityForIpc(
      "tree_node_create",
      {
        payload: {
          projectId: "p1",
          requestId: "sender-request-2",
          sessionId: "renderer-claimed-b",
          eventUid: "sender-event-2",
          origin: "human",
          id: "node-2",
          nodeType: "scene",
          title: "Scene 2",
          sortOrder: "a1",
        },
      },
      701,
    );
    const otherSender = bindRendererAuthorityForIpc(
      "tree_node_create",
      {
        payload: {
          projectId: "p1",
          requestId: "sender-request-3",
          sessionId: "renderer-claimed-c",
          eventUid: "sender-event-3",
          origin: "human",
          id: "node-3",
          nodeType: "scene",
          title: "Scene 3",
          sortOrder: "a2",
        },
      },
      702,
    );

    const firstPayload = first.payload as {
      sessionId: string;
      writerSessionId: string;
      authoritySessionId: string;
    };
    const secondPayload = second.payload as {
      sessionId: string;
      writerSessionId: string;
      authoritySessionId: string;
    };
    const otherSenderPayload = otherSender.payload as {
      sessionId: string;
      writerSessionId: string;
      authoritySessionId: string;
    };
    expect(firstPayload.sessionId).toBe("renderer-claimed-a");
    expect(firstPayload.writerSessionId).toBe(firstPayload.sessionId);
    expect(secondPayload.sessionId).toBe("renderer-claimed-b");
    expect(secondPayload.writerSessionId).toBe(secondPayload.sessionId);
    expect(firstPayload.authoritySessionId).not.toBe(firstPayload.sessionId);
    expect(secondPayload.authoritySessionId).toBe(
      firstPayload.authoritySessionId,
    );
    expect(otherSenderPayload.authoritySessionId).not.toBe(
      firstPayload.authoritySessionId,
    );
  });

  it("derives a nested tree change event from the sender-bound identity", () => {
    const bound = bindRendererAuthorityForIpc(
      "tree_node_patch",
      {
        payload: {
          projectId: "p1",
          requestId: "tree-request-1",
          sessionId: "renderer-claimed",
          eventUid: "tree-event-1",
          origin: "human",
          nodeId: "scene-1",
          patch: { content: "{}" },
          changeEvent: {
            eventUid: "renderer-event",
            sessionId: "renderer-session",
            timestamp: 123,
          },
        },
      },
      703,
    );

    const payload = bound.payload as {
      eventUid: string;
      sessionId: string;
      changeEvent: {
        eventUid: string;
        sessionId: string;
        timestamp: number;
      };
    };
    expect(payload.changeEvent).toEqual({
      eventUid: payload.eventUid,
      sessionId: payload.sessionId,
      timestamp: 123,
    });
  });

  it("rejects a renderer agent writer without a main-issued capability", () => {
    const bound = bindRendererAuthorityForIpc(
      "agent_foreshadow_create",
      {
        payload: {
          projectId: "p1",
          requestId: "agent-tool:forged",
          sessionId: "renderer-claimed",
          eventUid: "agent-event-1",
          origin: "ai-apply",
          chatMessageId: "assistant-1",
          toolCallId: "call-1",
          agentAuthorityCapability: "renderer-forged-capability",
          title: "forged",
        },
      },
      703,
    );

    expect((bound.payload as { authorityRoute?: string }).authorityRoute).toBe(
      "",
    );
  });

  it("rejects an Agent command that forges human origin without a capability", () => {
    const bound = bindRendererAuthorityForIpc(
      "agent_codex_create",
      {
        payload: {
          projectId: "p1",
          requestId: "agent-tool:human-bypass",
          sessionId: "renderer-claimed",
          eventUid: "agent-event-human-bypass",
          origin: "human",
          typeSlug: "character",
          name: "forged",
        },
      },
      704,
    );

    expect((bound.payload as { authorityRoute?: string }).authorityRoute).toBe(
      "",
    );
  });

  it("binds the non-Agent Codex renderer alias to the human route", () => {
    const bound = bindRendererAuthorityForIpc(
      "codex_create",
      {
        payload: {
          projectId: "p1",
          requestId: "renderer-codex-create",
          sessionId: "renderer-session",
          eventUid: "renderer-codex-event",
          origin: "human",
          caller: "renderer-forged-caller",
          controls: [],
          entryId: "entry-1",
          typeSlug: "character",
          name: "正常な作成",
        },
      },
      704,
    );

    expect(bound.payload).toMatchObject({
      authorityRoute: "human-direct",
      origin: "human",
      caller: "human-ui",
      controls: [
        "runtime-policy",
        "actor-context",
        "typed-writer",
        "occ",
        "change-event",
        "change-feed",
      ],
    });
  });

  it("rejects an ambiguous ai-apply origin on a non-Agent renderer command", () => {
    const bound = bindRendererAuthorityForIpc("codex_create", {
      payload: {
        projectId: "p1",
        requestId: "ambiguous-ai-request",
        eventUid: "ambiguous-ai-event",
        origin: "ai-apply",
        entryId: "entry-1",
        typeSlug: "character",
        name: "ambiguous",
      },
    });

    expect((bound.payload as { authorityRoute?: string }).authorityRoute).toBe(
      "",
    );
  });

  it.each([
    "codex_mutate",
    "event_create",
    "event_update",
    "event_delete",
    "chronicle_bulk_mutate",
    "event_participants_set",
    "scene_event_link",
    "scene_event_link_batch",
    "scene_event_unlink",
    "event_relation_add",
    "event_relation_remove",
  ])("binds renderer command %s to the human route", (command) => {
    const bound = bindRendererAuthorityForIpc(
      command,
      {
        payload: {
          projectId: "p1",
          requestId: `renderer-${command}-request`,
          sessionId: "renderer-session",
          eventUid: `renderer-${command}-event`,
          origin: "human",
        },
      },
      705,
    );

    expect((bound.payload as { authorityRoute?: string }).authorityRoute).toBe(
      "human-direct",
    );
    expect((bound.payload as { caller?: string }).caller).toBe("human-ui");
  });

  it.each([
    "agent_event_create",
    "agent_event_update",
    "agent_event_delete",
    "agent_chronicle_bulk_mutate",
    "agent_event_set_participants",
    "agent_scene_event_link",
    "agent_scene_event_link_batch",
    "agent_scene_event_unlink",
    "agent_event_relation_add",
    "agent_event_relation_remove",
  ])("rejects human-origin attempts on Agent command %s", (command) => {
    const bound = bindRendererAuthorityForIpc(
      command,
      {
        payload: {
          projectId: "p1",
          requestId: `agent-${command}-request`,
          sessionId: "renderer-session",
          eventUid: `agent-${command}-event`,
          origin: "human",
        },
      },
      706,
    );

    expect((bound.payload as { authorityRoute?: string }).authorityRoute).toBe(
      "",
    );
  });

  it("issues a tool-scoped capability only for the main chat-agent turn", async () => {
    const sendAgentMessage = vi.fn(async () =>
      JSON.stringify({
        blocks: [
          {
            type: "tool_use",
            id: "call-1",
            name: "create_foreshadow",
            input: { title: "from the model" },
          },
        ],
        stopReason: "tool_use",
      }),
    );
    const getAiSettings = vi.fn(async () =>
      JSON.stringify({ provider: "openai", model: "gpt-test" }),
    );
    const dbExecute = vi.fn(async () =>
      JSON.stringify({
        rows: [[JSON.stringify({ preset: "full", toggles: { chat: true } })]],
      }),
    );
    registerIpcRouter(
      {
        dbExecute,
        getAiSettings,
        sendAgentMessage,
      } as unknown as NapiBackendLike,
      {},
      {
        resolveApiKeyForRequest: vi.fn(() => "test-key"),
        getApiKeyForRequest: vi.fn(() => null),
      },
    );

    const envelope = await invokeHandler()(
      { sender: { id: 704 } },
      "send_agent_message",
      {
        messages: [{ role: "user", content: "write a clue" }],
        tools: [{ name: "create_foreshadow" }],
        provider: "openai",
        chatMessageId: "assistant-1",
        auditContext: {
          expectedWorkspacePath: "/tmp/workspace",
          projectId: "p1",
          operationId: "turn-1",
          executionId: "execution-1",
          parentExecutionId: null,
          pathId: "chat_agent_main",
        },
      },
    );

    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    expect(envelope.value).toMatchObject({
      agentAuthorityCapabilities: {
        "call-1": {
          capability: expect.any(String),
          executionId: "execution-1",
          chatMessageId: "assistant-1",
          mainOwnedProvenanceId: expect.any(String),
          expectedEntityId: expect.any(String),
        },
      },
    });
    expect(dbExecute).toHaveBeenCalledWith(
      "SELECT ai_policy FROM projects WHERE id = ? LIMIT 1",
      ["p1"],
      "get",
    );

    const requestId = `agent-tool:${createHash("sha256")
      .update("create_foreshadow\0p1\0call-1")
      .digest("hex")}`;
    const firstGrant = (
      envelope.value as {
        agentAuthorityCapabilities: Record<
          string,
          {
            capability: string;
            executionId: string;
            chatMessageId: string;
            mainOwnedProvenanceId: string;
            expectedEntityId: string;
          }
        >;
      }
    ).agentAuthorityCapabilities["call-1"];
    const bound = bindRendererAuthorityForIpc(
      "agent_foreshadow_create",
      {
        payload: {
          projectId: "p1",
          requestId,
          eventUid: "agent-event-1",
          origin: "ai-apply",
          title: "from the model",
          chatMessageId: firstGrant.chatMessageId,
          toolCallId: "call-1",
          executionId: firstGrant.executionId,
          mainOwnedProvenanceId: firstGrant.mainOwnedProvenanceId,
          agentAuthorityCapability: firstGrant.capability,
          foreshadowId: firstGrant.expectedEntityId,
        },
      },
      704,
    );
    expect(bound.payload).toMatchObject({
      authorityRoute: "interactive-agent-command",
      provenance: {
        requestId,
        traceId: firstGrant.mainOwnedProvenanceId,
        executionId: firstGrant.executionId,
        mainOwnedProvenanceId: firstGrant.mainOwnedProvenanceId,
        chatMessageId: firstGrant.chatMessageId,
        toolCallId: "call-1",
      },
    });

    const secondEnvelope = await invokeHandler()(
      { sender: { id: 704 } },
      "send_agent_message",
      {
        messages: [{ role: "user", content: "write another clue" }],
        tools: [{ name: "create_foreshadow" }],
        provider: "openai",
        chatMessageId: "assistant-2",
        auditContext: {
          expectedWorkspacePath: "/tmp/workspace",
          projectId: "p1",
          operationId: "turn-2",
          executionId: "execution-2",
          parentExecutionId: null,
          pathId: "chat_agent_main",
        },
      },
    );
    expect(secondEnvelope.ok).toBe(true);
    if (!secondEnvelope.ok) return;
    const secondGrant = (
      secondEnvelope.value as {
        agentAuthorityCapabilities: Record<
          string,
          {
            capability: string;
            executionId: string;
            chatMessageId: string;
            mainOwnedProvenanceId: string;
            expectedEntityId: string;
          }
        >;
      }
    ).agentAuthorityCapabilities["call-1"];
    const retargeted = bindRendererAuthorityForIpc(
      "agent_foreshadow_create",
      {
        payload: {
          projectId: "p1",
          requestId,
          eventUid: "agent-event-2",
          origin: "ai-apply",
          title: "retargeted by renderer",
          chatMessageId: secondGrant.chatMessageId,
          toolCallId: "call-1",
          executionId: secondGrant.executionId,
          mainOwnedProvenanceId: secondGrant.mainOwnedProvenanceId,
          agentAuthorityCapability: secondGrant.capability,
          foreshadowId: secondGrant.expectedEntityId,
        },
      },
      704,
    );
    expect(retargeted.payload).toMatchObject({ authorityRoute: "" });

    const backgroundEnvelope = await invokeHandler()(
      { sender: { id: 704 } },
      "send_agent_message",
      {
        messages: [{ role: "user", content: "background" }],
        tools: [{ name: "create_foreshadow" }],
        provider: "openai",
        auditContext: {
          expectedWorkspacePath: "/tmp/workspace",
          projectId: "p1",
          operationId: "research-1",
          executionId: "execution-research",
          parentExecutionId: null,
          pathId: "agent_research_subagent",
        },
      },
    );
    expect(backgroundEnvelope).toEqual({
      ok: true,
      value: expect.objectContaining({
        blocks: expect.any(Array),
      }),
    });
    if (backgroundEnvelope.ok) {
      expect(backgroundEnvelope.value).not.toHaveProperty(
        "agentAuthorityCapabilities",
      );
    }
  });

  it("rejects Chronicle imports without an Agent capability", () => {
    const bound = bindRendererAuthorityForIpc(
      "agent_event_create",
      {
        payload: {
          projectId: "p1",
          requestId: "import-request-1",
          sessionId: "import-session-1",
          eventUid: "import-event-1",
          origin: "import",
          authorityRoute: "human-direct",
          caller: "human-ui",
          controls: ["runtime-policy"],
          provenance: null,
          writesAuthorityProtectedField: false,
          originalTransactionId: null,
          undoJournalId: null,
          eventId: "event-1",
          title: "Imported event",
        },
      },
      706,
    );

    expect((bound.payload as { authorityRoute?: string }).authorityRoute).toBe(
      "",
    );
  });

  it("binds the main-issued identity for the normal create_event path", async () => {
    const grant = await issueAgentCapability(
      "create_event",
      { title: "Arrival" },
      710,
    );
    expect(grant.expectedEntityId).toEqual(expect.any(String));

    const bound = bindRendererAuthorityForIpc(
      "agent_event_create",
      {
        payload: agentCapabilityPayload(grant, {
          title: "Arrival",
          eventId: grant.expectedEntityId,
        }),
      },
      710,
    );

    expect(bound.payload).toMatchObject({
      authorityRoute: "interactive-agent-command",
      eventId: grant.expectedEntityId,
    });
  });

  it("denies a capability when the renderer adds an unrequested Native field", async () => {
    const grant = await issueAgentCapability(
      "update_codex_entry",
      { id: "entry-1", summary: "model summary" },
      705,
    );
    const bound = bindRendererAuthorityForIpc(
      "agent_codex_update",
      {
        payload: agentCapabilityPayload(grant, {
          entryId: "entry-1",
          baseVersion: 1,
          summary: "model summary",
          contextMode: "always",
        }),
      },
      705,
    );
    expect((bound.payload as { authorityRoute?: string }).authorityRoute).toBe(
      "",
    );
  });

  it("accepts the normal JSON-string projection for Codex alias fields", async () => {
    const grant = await issueAgentCapability(
      "update_codex_entry",
      { id: "entry-1", aliases: ["Hero", "Protagonist"] },
      705,
    );
    const bound = bindRendererAuthorityForIpc(
      "agent_codex_update",
      {
        payload: agentCapabilityPayload(grant, {
          entryId: "entry-1",
          baseVersion: 1,
          aliases: JSON.stringify(["Hero", "Protagonist"]),
        }),
      },
      705,
    );
    expect((bound.payload as { authorityRoute?: string }).authorityRoute).toBe(
      "interactive-agent-command",
    );
  });

  it("binds rich text losslessly and denies link or mark tampering", async () => {
    const linkDocument = (href: string) =>
      JSON.stringify({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "参考資料",
                marks: [
                  {
                    type: "link",
                    attrs: {
                      href,
                      target: "_blank",
                      rel: "noopener noreferrer nofollow",
                      class: null,
                      title: null,
                    },
                  },
                ],
              },
            ],
          },
        ],
      });
    const linkGrant = await issueAgentCapability(
      "update_codex_entry",
      {
        id: "entry-1",
        content: "[参考資料](https://safe.example)",
      },
      706,
    );
    const linkTampered = bindRendererAuthorityForIpc(
      "agent_codex_update",
      {
        payload: agentCapabilityPayload(linkGrant, {
          entryId: "entry-1",
          baseVersion: 1,
          content: linkDocument("https://evil.example"),
        }),
      },
      706,
    );
    expect(
      (linkTampered.payload as { authorityRoute?: string }).authorityRoute,
    ).toBe("");

    const markGrant = await issueAgentCapability(
      "update_codex_entry",
      { id: "entry-1", content: "**参考**" },
      707,
    );
    const markTampered = bindRendererAuthorityForIpc(
      "agent_codex_update",
      {
        payload: agentCapabilityPayload(markGrant, {
          entryId: "entry-1",
          baseVersion: 1,
          content: JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "参考",
                    marks: [{ type: "italic" }],
                  },
                ],
              },
            ],
          }),
        }),
      },
      707,
    );
    expect(
      (markTampered.payload as { authorityRoute?: string }).authorityRoute,
    ).toBe("");
  });

  it("rebuilds main-owned authorship marks for Codex, Snippet, and Event detail", async () => {
    const documentWithForgedAuthorship = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "AI text",
              marks: [
                {
                  type: "authorship",
                  attrs: {
                    source: "human",
                    model: "renderer-model",
                    chatMessageId: "renderer-message",
                    traceId: "renderer-trace",
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    const firstTextNode = (value: unknown) => {
      const document = JSON.parse(String(value)) as {
        content?: Array<{ content?: Array<{ marks?: unknown[] }> }>;
      };
      return document.content?.[0]?.content?.[0];
    };
    const authorshipMark = (value: unknown) =>
      firstTextNode(value)?.marks?.find(
        (mark) =>
          typeof mark === "object" &&
          mark !== null &&
          (mark as { type?: unknown }).type === "authorship",
      ) as { attrs?: Record<string, unknown> } | undefined;

    const codexGrant = await issueAgentCapability(
      "create_codex_entry",
      {
        type: "lore",
        name: "Marked Codex",
        content: "AI text",
      },
      711,
    );
    expect(codexGrant.expectedEntityId).toEqual(expect.any(String));
    const codexBound = bindRendererAuthorityForIpc(
      "agent_codex_create",
      {
        payload: agentCapabilityPayload(codexGrant, {
          typeSlug: "lore",
          name: "Marked Codex",
          entryId: codexGrant.expectedEntityId,
          content: documentWithForgedAuthorship,
        }),
      },
      711,
    );
    expect(
      authorshipMark((codexBound.payload as { content?: unknown }).content)
        ?.attrs,
    ).toMatchObject({
      source: "ai",
      model: "gpt-test",
      chatMessageId: codexGrant.chatMessageId,
      traceId: codexGrant.mainOwnedProvenanceId,
      timestamp: expect.any(String),
    });
    const codexMarkTimestamp = authorshipMark(
      (codexBound.payload as { content?: unknown }).content,
    )?.attrs?.timestamp;
    expect(
      ((
        codexBound.payload as {
          authorshipSpans?: Array<Record<string, unknown>>;
        }
      ).authorshipSpans ?? [])[0]?.timestamp,
    ).toBe(codexMarkTimestamp);

    const snippetGrant = await issueAgentCapability(
      "create_snippet",
      { title: "Marked Snippet", content: "AI text" },
      712,
    );
    expect(snippetGrant.expectedEntityId).toEqual(expect.any(String));
    const snippetBound = bindRendererAuthorityForIpc(
      "agent_snippet_create",
      {
        payload: agentCapabilityPayload(snippetGrant, {
          title: "Marked Snippet",
          snippetId: snippetGrant.expectedEntityId,
          content: documentWithForgedAuthorship,
        }),
      },
      712,
    );
    expect(
      authorshipMark((snippetBound.payload as { content?: unknown }).content)
        ?.attrs,
    ).toMatchObject({
      source: "ai",
      model: "gpt-test",
      chatMessageId: snippetGrant.chatMessageId,
      traceId: snippetGrant.mainOwnedProvenanceId,
    });

    const eventDetail = applyMainOwnedAuthorshipMarks(
      JSON.parse(documentWithForgedAuthorship),
      {
        source: "ai",
        timestamp: "2026-08-15T06:00:00.000Z",
        model: "gpt-test",
        chatMessageId: "event-message",
        traceId: "event-trace",
      },
    );
    expect(authorshipMark(JSON.stringify(eventDetail))?.attrs).toEqual({
      source: "ai",
      timestamp: "2026-08-15T06:00:00.000Z",
      model: "gpt-test",
      chatMessageId: "event-message",
      traceId: "event-trace",
    });
  });

  it("keeps fenced code blocks schema-valid and tracks their authorship spans", async () => {
    const markdown = "```ts\nconst value = 1\n```";
    const grant = await issueAgentCapability(
      "create_codex_entry",
      { type: "lore", name: "Code Block", content: markdown },
      716,
    );
    const bound = bindRendererAuthorityForIpc(
      "agent_codex_create",
      {
        payload: agentCapabilityPayload(grant, {
          typeSlug: "lore",
          name: "Code Block",
          entryId: grant.expectedEntityId,
          content: JSON.stringify({
            type: "doc",
            content: [
              {
                type: "codeBlock",
                attrs: { language: null },
                content: [{ type: "text", text: "const value = 1" }],
              },
            ],
          }),
        }),
      },
      716,
    );
    expect((bound.payload as { authorityRoute?: string }).authorityRoute).toBe(
      "interactive-agent-command",
    );

    const content = JSON.parse(
      String((bound.payload as { content?: unknown }).content),
    ) as {
      content?: Array<{
        type?: string;
        content?: Array<{ marks?: unknown[] }>;
      }>;
    };
    expect(content.content?.[0]?.type).toBe("codeBlock");
    expect(content.content?.[0]?.content?.[0]?.marks ?? []).toEqual([]);

    const document = ProseMirrorNode.fromJSON(
      getSchema([StarterKit.configure()]),
      content,
    );
    document.check();

    expect(
      (bound.payload as { authorshipSpans?: Array<Record<string, unknown>> })
        .authorshipSpans,
    ).toEqual([
      expect.objectContaining({
        fromPos: 0,
        toPos: 15,
        source: "ai",
      }),
    ]);
  });

  it("keeps JSON-looking Markdown as text and rejects PM retargets or unsupported nodes", async () => {
    const jsonLookingMarkdown =
      '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"model"}]}]}';
    const jsonLookingGrant = await issueAgentCapability(
      "update_codex_entry",
      { id: "entry-json-looking", content: jsonLookingMarkdown },
      713,
    );
    const literalDocument = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: jsonLookingMarkdown }],
        },
      ],
    });
    const jsonLookingBound = bindRendererAuthorityForIpc(
      "agent_codex_update",
      {
        payload: agentCapabilityPayload(jsonLookingGrant, {
          entryId: "entry-json-looking",
          baseVersion: 1,
          content: literalDocument,
        }),
      },
      713,
    );
    expect(
      (jsonLookingBound.payload as { authorityRoute?: string }).authorityRoute,
    ).toBe("interactive-agent-command");

    const retargetGrant = await issueAgentCapability(
      "update_codex_entry",
      { id: "entry-retarget", content: "AI text" },
      715,
    );
    const retargeted = bindRendererAuthorityForIpc(
      "agent_codex_update",
      {
        payload: agentCapabilityPayload(retargetGrant, {
          entryId: "entry-retarget",
          baseVersion: 1,
          content: JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "renderer retarget" }],
              },
            ],
          }),
        }),
      },
      715,
    );
    expect(
      (retargeted.payload as { authorityRoute?: string }).authorityRoute,
    ).toBe("");

    const unsupported = await issueAgentCapability(
      "update_codex_entry",
      { id: "entry-unsupported", content: "AI text" },
      714,
    );
    const unsupportedBound = bindRendererAuthorityForIpc(
      "agent_codex_update",
      {
        payload: agentCapabilityPayload(unsupported, {
          entryId: "entry-unsupported",
          baseVersion: 1,
          content: JSON.stringify({
            type: "doc",
            content: [{ type: "unsupported-node" }],
          }),
        }),
      },
      714,
    );
    expect(
      (unsupportedBound.payload as { authorityRoute?: string }).authorityRoute,
    ).toBe("");
  });

  it("accepts the normal tree ops projection and denies changed creates", async () => {
    const ops = [
      {
        op: "create",
        tempId: "tmp:scene",
        parentRef: null,
        nodeType: "scene",
        title: "Opening",
      },
    ];
    const makePayload = (
      grant: Awaited<ReturnType<typeof issueAgentCapability>>,
      title: string,
    ) => ({
      payload: agentCapabilityPayload(grant, {
        kind: "scaffold",
        ops,
        creates: [
          {
            tempId: "tmp:scene",
            id: "scene-1",
            parentId: null,
            nodeType: "scene",
            title,
            sortOrder: "a0",
            synopsis: null,
          },
        ],
        updates: [],
        redo: false,
      }),
    });
    const validGrant = await issueAgentCapability(
      "apply_ai_tree_plan",
      { kind: "scaffold", ops },
      708,
    );
    const valid = bindRendererAuthorityForIpc(
      "ai_tree_plan_apply",
      makePayload(validGrant, "Opening"),
      708,
    );
    expect((valid.payload as { authorityRoute?: string }).authorityRoute).toBe(
      "interactive-agent-command",
    );

    const tamperedGrant = await issueAgentCapability(
      "apply_ai_tree_plan",
      { kind: "scaffold", ops },
      709,
    );
    const tampered = bindRendererAuthorityForIpc(
      "ai_tree_plan_apply",
      makePayload(tamperedGrant, "Renderer retarget"),
      709,
    );
    expect(
      (tampered.payload as { authorityRoute?: string }).authorityRoute,
    ).toBe("");
  });

  it("selects history-replay for an AI tree redo and preserves the event identity", () => {
    const bound = bindRendererAuthorityForIpc("ai_tree_plan_apply", {
      payload: {
        projectId: "p1",
        requestId: "redo-request-1",
        eventUid: "redo-event-1",
        origin: "ai-apply",
        redo: true,
        authorityRoute: "interactive-agent-command",
        caller: "chat-tool-executor",
        controls: ["knowledge-write-policy"],
        provenance: { requestId: "redo-request-1", traceId: "forged" },
      },
    });

    expect(bound.payload).toMatchObject({
      eventUid: "redo-event-1",
      origin: "redo",
      authorityRoute: "history-replay",
      caller: "history-controller",
      controls: [
        "original-transaction",
        "journal-lineage",
        "typed-writer",
        "occ",
        "change-event",
        "change-feed",
      ],
      provenance: null,
    });
  });

  it("binds undo journal replay to the Main-owned history actor and direction", () => {
    const bound = bindRendererAuthorityForIpc("agent_apply_undo_journal", {
      payload: {
        projectId: "p1",
        requestId: "undo-main-binding",
        sessionId: "renderer-session",
        journalId: "journal-1",
        direction: "undo",
        origin: "redo",
        caller: "renderer-forged",
        controls: ["renderer-control"],
      },
    });

    expect(bound.payload).toMatchObject({
      authorityRoute: "history-replay",
      origin: "undo",
      caller: "undo-redo-command",
      controls: [
        "original-transaction",
        "journal-lineage",
        "typed-writer",
        "occ",
        "change-event",
        "change-feed",
      ],
    });
  });

  it("requires a journal issued by the same renderer session for replay", () => {
    const payload = {
      projectId: "p1",
      requestId: "undo-capability-binding",
      sessionId: "renderer-session",
      journalId: "journal-not-issued",
      direction: "undo",
      origin: "undo",
    };
    const denied = bindRendererAuthorityForIpc(
      "agent_apply_undo_journal",
      { payload },
      740,
    );
    expect((denied.payload as { authorityRoute?: string }).authorityRoute).toBe(
      "",
    );

    recordRendererHistoryJournalForIpc(740, "p1", "journal-issued");
    const allowed = bindRendererAuthorityForIpc(
      "agent_apply_undo_journal",
      { payload: { ...payload, journalId: "journal-issued" } },
      740,
    );
    expect(
      (allowed.payload as { authorityRoute?: string }).authorityRoute,
    ).toBe("history-replay");
  });

  it("requires a Main-issued journal for AI tree undo and redo", () => {
    const undoPayload = {
      projectId: "p1",
      requestId: "tree-undo-capability-binding",
      sessionId: "renderer-session",
      undoJournalId: "tree-journal-not-issued",
      originalTransactionId: "tree-transaction",
    };
    const deniedUndo = bindRendererAuthorityForIpc(
      "ai_tree_plan_undo",
      { payload: undoPayload },
      741,
    );
    expect(
      (deniedUndo.payload as { authorityRoute?: string }).authorityRoute,
    ).toBe("");

    const redoPayload = {
      projectId: "p1",
      requestId: "tree-redo-capability-binding",
      sessionId: "renderer-session",
      undoJournalId: "tree-journal-not-issued",
      originalTransactionId: "tree-transaction",
      redo: true,
    };
    const deniedRedo = bindRendererAuthorityForIpc(
      "ai_tree_plan_apply",
      { payload: redoPayload },
      742,
    );
    expect(
      (deniedRedo.payload as { authorityRoute?: string }).authorityRoute,
    ).toBe("");

    recordRendererHistoryJournalForIpc(741, "p1", "tree-journal-issued");
    recordRendererHistoryJournalForIpc(742, "p1", "tree-journal-issued");
    const allowedUndo = bindRendererAuthorityForIpc(
      "ai_tree_plan_undo",
      {
        payload: { ...undoPayload, undoJournalId: "tree-journal-issued" },
      },
      741,
    );
    const allowedRedo = bindRendererAuthorityForIpc(
      "ai_tree_plan_apply",
      {
        payload: { ...redoPayload, undoJournalId: "tree-journal-issued" },
      },
      742,
    );
    expect(
      (allowedUndo.payload as { authorityRoute?: string }).authorityRoute,
    ).toBe("history-replay");
    expect(
      (allowedRedo.payload as { authorityRoute?: string }).authorityRoute,
    ).toBe("history-replay");
  });

  it("rejects renderer routes that are absent from the operation manifest", async () => {
    const agentCodexCreate = vi.fn();
    const snippetUpdate = vi.fn();
    const agentChronicleBulkMutate = vi.fn();
    registerIpcRouter({
      agentCodexCreate,
      snippetUpdate,
      agentChronicleBulkMutate,
    } as unknown as NapiBackendLike);

    const importAuthority = {
      projectId: "p1",
      requestId: "request-1",
      sessionId: "session-1",
      eventUid: "event-1",
      origin: "import",
      authorityRoute: "import-apply",
      caller: "import-session",
      controls: [
        "import-policy",
        "source-package-evidence",
        "typed-writer",
        "occ",
        "change-event",
        "change-feed",
      ],
      provenance: null,
      writesAuthorityProtectedField: false,
      originalTransactionId: null,
      undoJournalId: null,
    };

    const cases = [
      {
        cmd: "agent_codex_create",
        method: agentCodexCreate,
        payload: {
          ...importAuthority,
          entryId: "entry-1",
          typeSlug: "character",
          name: "Imported",
        },
      },
      {
        cmd: "snippet_update",
        method: snippetUpdate,
        payload: {
          ...importAuthority,
          snippetId: "snippet-1",
          baseVersion: 1,
          title: "Imported",
        },
      },
      {
        cmd: "agent_chronicle_bulk_mutate",
        method: agentChronicleBulkMutate,
        payload: {
          ...importAuthority,
          operations: [{ type: "event.create", eventId: "event-1" }],
        },
      },
    ] as const;

    for (const testCase of cases) {
      const envelope = await invokeHandler()(
        { sender: { id: 705 } },
        testCase.cmd,
        {
          payload: testCase.payload,
        },
      );
      expect(envelope.ok).toBe(false);
      expect(String(envelope.ok ? "" : envelope.error)).toMatch(
        /authorityRoute|authority route/,
      );
      expect(testCase.method).not.toHaveBeenCalled();
    }
  });

  it("passes the bound authority to the native strict writer", async () => {
    const agentForeshadowCreate = vi.fn(async () =>
      JSON.stringify({
        entityId: "f1",
        version: 1,
        changeEventUid: "event-1",
        undoJournalId: "journal-1",
      }),
    );
    registerIpcRouter({ agentForeshadowCreate } as unknown as NapiBackendLike);

    const envelope = await invokeHandler()(
      { sender: {} },
      "agent_foreshadow_create",
      {
        payload: {
          projectId: "p1",
          requestId: "request-1",
          sessionId: "session-1",
          eventUid: "event-1",
          origin: "human",
          authorityRoute: "human-direct",
          caller: "human-ui",
          controls: ["runtime-policy"],
          provenance: null,
          writesAuthorityProtectedField: true,
          originalTransactionId: null,
          undoJournalId: null,
          foreshadowId: "f1",
          title: "Scene clue",
        },
      },
    );

    expect(envelope.ok).toBe(true);
    expect(agentForeshadowCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "ai-apply",
        authorityRoute: "interactive-agent-command",
        caller: "chat-tool-executor",
        controls: expect.arrayContaining([
          "knowledge-write-policy",
          "agent-provenance",
          "change-feed",
        ]),
        provenance: { requestId: "request-1", traceId: "request-1" },
        writesAuthorityProtectedField: false,
      }),
    );
  });

  it("fills forward Chronicle bulk lineage before strict dispatch", async () => {
    const agentChronicleBulkMutate = vi.fn(async () =>
      JSON.stringify({
        eventResults: [],
        sceneResults: [],
        changeEventUid: "bulk-event-1",
        undoJournalId: "bulk-journal-1",
      }),
    );
    registerIpcRouter({
      agentChronicleBulkMutate,
    } as unknown as NapiBackendLike);

    const envelope = await invokeHandler()(
      { sender: {} },
      "agent_chronicle_bulk_mutate",
      {
        payload: {
          requestId: "bulk-request-1",
          projectId: "p1",
          sessionId: "session-1",
          surface: "manual",
          operations: [
            { kind: "eventDelete", eventId: "event-1", baseVersion: 0 },
          ],
        },
      },
    );

    expect(envelope.ok).toBe(true);
    expect(agentChronicleBulkMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        eventUid: "bulk-request-1",
        origin: "ai-apply",
        authorityRoute: "interactive-agent-command",
        caller: "chat-tool-executor",
        originalTransactionId: null,
        undoJournalId: null,
      }),
    );
  });

  it("injects the side-effect-free panel existence delegate", () => {
    registerIpcRouter(null);

    expect(mocks.registerShellBridgeHandlers).toHaveBeenCalledWith({
      open: mocks.openPanelWindow,
      focusByLabel: mocks.focusPanelWindow,
      existsByLabel: mocks.hasPanelWindow,
    });
  });

  it("does not copy an unimplemented renderer command into production logs", async () => {
    const sentinel = "SECRET_NOVEL_SENTINEL";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerIpcRouter(null);

    const envelope = await invokeHandler()({ sender: {} }, sentinel, {
      text: "private draft",
    });

    expect(envelope).toMatchObject({
      ok: false,
      error: `IPC_UNIMPLEMENTED: ${sentinel}`,
    });
    expect(warn).toHaveBeenCalledWith("[grim:invoke] IPC_UNIMPLEMENTED");
    expect(warn.mock.calls.flat().join(" ")).not.toContain(sentinel);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("private draft");
    warn.mockRestore();
  });

  it("logs only a fixed outcome when the native backend is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerIpcRouter(null);

    const envelope = await invokeHandler()({ sender: {} }, "db_execute", {
      sql: "SECRET SQL",
      params: [],
      method: "all",
    });

    expect(envelope).toMatchObject({
      ok: false,
      error: "IPC_BACKEND_UNAVAILABLE: db_execute",
    });
    expect(warn).toHaveBeenCalledWith("[grim:invoke] IPC_BACKEND_UNAVAILABLE");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("db_execute");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("SECRET SQL");
    warn.mockRestore();
  });

  it("schedules one delayed exact release only for a successful foreground patch", async () => {
    vi.useFakeTimers();
    try {
      const release = vi.fn(async () => '{"status":"completed"}');
      const claim = vi.fn(async () => '{"status":"claimed","runId":"run-1"}');
      const treeNodePatch = vi.fn(async () => '{"patched":true}');
      registerIpcRouter(
        {
          treeNodePatch,
          claimNarrativeMaintenanceForegroundBarrier: claim,
          releaseNarrativeMaintenanceForegroundBarrier: release,
        } as unknown as NapiBackendLike,
        {},
        undefined,
        undefined,
        activeNarrativeMaintenanceCiSeam,
      );
      const envelope = await invokeHandler()(
        { sender: { id: 888 } },
        "tree_node_patch",
        {
          payload: {
            projectId: "p1",
            requestId: "patch-request-1",
            sessionId: "patch-session-1",
            eventUid: "patch-event-1",
            origin: "human",
            nodeId: "scene-1",
            updatedAt: "2026-08-23T00:00:00.000Z",
            patch: { content: "{}" },
            bumpVersion: true,
            baseVersion: 0,
            changeEvent: {
              eventUid: "patch-event-1",
              sessionId: "patch-session-1",
              timestamp: 1,
            },
          },
        },
      );
      expect(envelope.ok).toBe(true);
      expect(release).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(
        NARRATIVE_MAINTENANCE_FOREGROUND_RELEASE_DELAY_MS - 1,
      );
      expect(release).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      expect(release).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledWith("p1", "run-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("claims the exact project before arming a timer and never releases a wrong project", async () => {
    vi.useFakeTimers();
    try {
      const claim = vi.fn(async (projectId: string) =>
        projectId === "p1"
          ? '{"status":"claimed","runId":"run-1"}'
          : '{"status":"not-held"}',
      );
      const release = vi.fn(async () => '{"status":"completed"}');
      const treeNodePatch = vi.fn(async () => '{"patched":true}');
      registerIpcRouter(
        {
          treeNodePatch,
          claimNarrativeMaintenanceForegroundBarrier: claim,
          releaseNarrativeMaintenanceForegroundBarrier: release,
        } as unknown as NapiBackendLike,
        {},
        undefined,
        undefined,
        activeNarrativeMaintenanceCiSeam,
      );

      const invoke = invokeHandler();
      const patchArgs = (projectId: string, suffix: string) => ({
        payload: {
          projectId,
          requestId: `claim-request-${suffix}`,
          sessionId: `claim-session-${suffix}`,
          eventUid: `claim-event-${suffix}`,
          origin: "human",
          nodeId: "scene-1",
          updatedAt: "2026-08-23T00:00:00.000Z",
          patch: { content: "{}" },
          bumpVersion: true,
          baseVersion: 0,
          changeEvent: {
            eventUid: `claim-event-${suffix}`,
            sessionId: `claim-session-${suffix}`,
            timestamp: 1,
          },
        },
      });
      const wrong = await invoke(
        { sender: { id: 886 } },
        "tree_node_patch",
        patchArgs("wrong-project", "wrong"),
      );
      expect(wrong.ok).toBe(true);
      expect(claim).toHaveBeenCalledWith("wrong-project");
      await vi.runAllTimersAsync();
      expect(release).not.toHaveBeenCalled();

      const exact = await invoke(
        { sender: { id: 886 } },
        "tree_node_patch",
        patchArgs("p1", "exact"),
      );
      expect(exact.ok).toBe(true);
      expect(claim).toHaveBeenLastCalledWith("p1");
      expect(release).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(
        NARRATIVE_MAINTENANCE_FOREGROUND_RELEASE_DELAY_MS,
      );
      await vi.runOnlyPendingTimersAsync();
      expect(release).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledWith("p1", "run-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed on malformed or rejected native claims without arming a timer", async () => {
    vi.useFakeTimers();
    try {
      const claim = vi
        .fn()
        .mockResolvedValueOnce(
          '{"status":"claimed","runId":"run-1","projectId":"p1"}',
        )
        .mockRejectedValueOnce(new Error("workspace swapped"));
      const release = vi.fn();
      const treeNodePatch = vi.fn(async () => '{"patched":true}');
      registerIpcRouter(
        {
          treeNodePatch,
          claimNarrativeMaintenanceForegroundBarrier: claim,
          releaseNarrativeMaintenanceForegroundBarrier: release,
        } as unknown as NapiBackendLike,
        {},
        undefined,
        undefined,
        activeNarrativeMaintenanceCiSeam,
      );
      const invoke = invokeHandler();
      const patchArgs = (suffix: string) => ({
        payload: {
          projectId: "p1",
          requestId: `malformed-request-${suffix}`,
          sessionId: `malformed-session-${suffix}`,
          eventUid: `malformed-event-${suffix}`,
          origin: "human",
          nodeId: "scene-1",
          updatedAt: "2026-08-23T00:00:00.000Z",
          patch: { content: "{}" },
          bumpVersion: true,
          baseVersion: 0,
          changeEvent: {
            eventUid: `malformed-event-${suffix}`,
            sessionId: `malformed-session-${suffix}`,
            timestamp: 1,
          },
        },
      });
      await invoke(
        { sender: { id: 885 } },
        "tree_node_patch",
        patchArgs("first"),
      );
      await invoke(
        { sender: { id: 885 } },
        "tree_node_patch",
        patchArgs("second"),
      );
      await vi.runAllTimersAsync();
      expect(claim).toHaveBeenCalledTimes(2);
      expect(release).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not schedule for an inactive seam", async () => {
    const release = vi.fn();
    const treeNodePatch = vi.fn(async () => '{"patched":true}');
    registerIpcRouter(
      {
        treeNodePatch,
        releaseNarrativeMaintenanceForegroundBarrier: release,
      } as unknown as NapiBackendLike,
      {},
      undefined,
      undefined,
      { active: false },
    );
    const envelope = await invokeHandler()(
      { sender: { id: 887 } },
      "tree_node_patch",
      {
        payload: {
          projectId: "p1",
          requestId: "patch-request-inactive",
          sessionId: "patch-session-inactive",
          eventUid: "patch-event-inactive",
          origin: "human",
          nodeId: "scene-1",
          updatedAt: "2026-08-23T00:00:00.000Z",
          patch: { content: "{}" },
          bumpVersion: true,
          baseVersion: 0,
        },
      },
    );
    expect(envelope.ok).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(release).not.toHaveBeenCalled();
  });

  it("does not schedule for a failed foreground patch", async () => {
    const release = vi.fn();
    const failedPatch = vi.fn(async () => {
      throw new Error("patch failed");
    });
    registerIpcRouter(
      {
        treeNodePatch: failedPatch,
        releaseNarrativeMaintenanceForegroundBarrier: release,
      } as unknown as NapiBackendLike,
      {},
      undefined,
      undefined,
      activeNarrativeMaintenanceCiSeam,
    );
    const failedEnvelope = await invokeHandler()(
      { sender: { id: 889 } },
      "tree_node_patch",
      {
        payload: {
          projectId: "p1",
          requestId: "patch-request-2",
          sessionId: "patch-session-2",
          eventUid: "patch-event-2",
          origin: "human",
          nodeId: "scene-1",
          updatedAt: "2026-08-23T00:00:00.000Z",
          patch: { content: "{}" },
          bumpVersion: true,
          baseVersion: 0,
        },
      },
    );
    expect(failedEnvelope.ok).toBe(false);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(release).not.toHaveBeenCalled();
  });

  it("does not schedule for a successful patch under a non-foreground seam", async () => {
    const release = vi.fn();
    const treeNodePatch = vi.fn(async () => '{"patched":true}');
    registerIpcRouter(
      {
        treeNodePatch,
        releaseNarrativeMaintenanceForegroundBarrier: release,
      } as unknown as NapiBackendLike,
      {},
      undefined,
      undefined,
      {
        ...activeNarrativeMaintenanceCiSeam,
        trigger: "dependency-gap",
      },
    );
    const envelope = await invokeHandler()(
      { sender: { id: 890 } },
      "tree_node_patch",
      {
        payload: {
          projectId: "p1",
          requestId: "patch-request-3",
          sessionId: "patch-session-3",
          eventUid: "patch-event-3",
          origin: "human",
          nodeId: "scene-1",
          updatedAt: "2026-08-23T00:00:00.000Z",
          patch: { content: "{}" },
          bumpVersion: true,
          baseVersion: 0,
        },
      },
    );
    expect(envelope.ok).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(release).not.toHaveBeenCalled();
  });
});

describe("registerIpcRouter workspace-open main trace", () => {
  function backendWithOpenWorkspace(
    openWorkspace: (path: string) => Promise<string>,
  ): NapiBackendLike {
    return { openWorkspace } as unknown as NapiBackendLike;
  }

  it("consumes the trusted Open lifecycle proof before returning to renderer", async () => {
    const value = JSON.stringify({
      status: "ready",
      lifecycle: {
        schemaVersion: 1,
        revision: 6,
        status: "ready",
        bindingToken: "open-token",
        activation: "ready",
      },
    });
    const gate = await createProfileEgressGate(null);
    vi.spyOn(gate, "assertInvoke").mockImplementation(() => undefined);
    const observeWorkspaceOpenResult = vi
      .spyOn(gate, "observeWorkspaceOpenResult")
      .mockImplementation(() => undefined);
    registerIpcRouter(
      backendWithOpenWorkspace(async () => value),
      {},
      undefined,
      undefined,
      undefined,
      gate,
    );
    const envelope = await invokeHandler()({ sender: {} }, "open_workspace", {
      path: "/target",
    });
    expect(envelope.ok).toBe(true);
    expect(observeWorkspaceOpenResult).toHaveBeenCalledExactlyOnceWith(
      JSON.parse(value),
      "/target",
    );
  });

  it("waits for maintenance quiescence before swapping the native workspace", async () => {
    const order: string[] = [];
    let releaseQuiescence!: () => void;
    const quiesced = new Promise<void>((resolve) => {
      releaseQuiescence = resolve;
    });
    const openWorkspace = vi.fn(async () => {
      order.push("open");
      return JSON.stringify({ status: "ready" });
    });
    const quiesceForWorkspaceSwitch = vi.fn(async () => {
      order.push("quiesce");
      await quiesced;
    });
    registerIpcRouter(
      backendWithOpenWorkspace(openWorkspace),
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { quiesceForWorkspaceSwitch },
    );

    const invoke = invokeHandler()({ sender: {} }, "open_workspace", {
      path: "/workspace-next",
    });
    await Promise.resolve();
    expect(quiesceForWorkspaceSwitch).toHaveBeenCalledOnce();
    expect(openWorkspace).not.toHaveBeenCalled();
    releaseQuiescence();
    await expect(invoke).resolves.toMatchObject({ ok: true });
    expect(order).toEqual(["quiesce", "open"]);
  });

  it("resumes the real scheduler after a successful Native workspace swap", async () => {
    vi.useFakeTimers();
    const previousBinding = { authorityId: "authority-before", generation: 1 };
    const nextBinding = { authorityId: "authority-after", generation: 2 };
    let currentBinding = previousBinding;
    const runNarrativeMaintenanceCycle = vi
      .fn()
      .mockResolvedValue({ status: "accepted", hasMore: false });
    const openWorkspace = vi.fn(async () => {
      currentBinding = nextBinding;
      return JSON.stringify({ status: "ready" });
    });
    const backend = {
      getNarrativeMaintenanceWorkspaceBinding: () => currentBinding,
      runNarrativeMaintenanceCycle,
      openWorkspace,
    };
    const scheduler = createNarrativeMaintenanceScheduler(backend);
    scheduler.start();
    registerIpcRouter(
      backend as unknown as NapiBackendLike,
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      scheduler,
    );

    try {
      const envelope = await invokeHandler()({ sender: {} }, "open_workspace", {
        path: "/workspace-next",
      });
      expect(envelope).toMatchObject({ ok: true });
      expect(openWorkspace).toHaveBeenCalledOnce();

      scheduler.requestWithBinding(
        {
          projectId: "project-after-open",
          runKind: "backfill",
          workKey: "backfill:v2",
          reason: "workspace-opened",
        },
        nextBinding,
      );
      await vi.advanceTimersByTimeAsync(NARRATIVE_MAINTENANCE_BACKLOG_DELAY_MS);

      expect(runNarrativeMaintenanceCycle).toHaveBeenCalledOnce();
      expect(runNarrativeMaintenanceCycle.mock.calls[0]?.[0]).toMatchObject({
        workspaceBinding: nextBinding,
      });
    } finally {
      await scheduler.dispose();
      vi.useRealTimers();
    }
  });

  it("joins Freshness then ACKs only the Open target recovery before Native Open", async () => {
    const order: string[] = [];
    let releaseFreshness!: () => void;
    const freshnessDone = new Promise<void>((resolve) => { releaseFreshness = resolve; });
    let releaseAck!: () => void;
    const ackDone = new Promise<void>((resolve) => { releaseAck = resolve; });
    const binding = { authorityId: "target-authority", generation: 1 };
    const reconcileNarrativeMaintenanceRecovery = vi.fn()
      .mockImplementationOnce(async (path: string) => {
        order.push(`recover:${path}`);
        return { status: "reconciled", descriptorId: 81,
          reason: "maintenance-recovery-complete", recoveredBinding: binding,
          activeBinding: binding, reboundBinding: binding };
      })
      .mockResolvedValue({ status: "none" });
    const ackNarrativeMaintenanceRecovery = vi.fn(async () => {
      order.push("ack");
      await ackDone;
      return { status: "acknowledged", descriptorId: 81, acknowledged: true };
    });
    const openWorkspace = vi.fn(async () => {
      order.push("open");
      return JSON.stringify({ status: "ready" });
    });
    const scheduler = createNarrativeMaintenanceScheduler({
      reconcileNarrativeMaintenanceRecovery, ackNarrativeMaintenanceRecovery,
    });
    const freshnessResume = vi.fn();
    registerIpcRouter(backendWithOpenWorkspace(openWorkspace), {}, undefined,
      undefined, undefined, undefined, undefined, scheduler, {
        quiesceForWorkspaceSwitch: async () => {
          order.push("freshness");
          await freshnessDone;
          return { resume: freshnessResume };
        },
      });
    const invoke = invokeHandler()({ sender: {} }, "open_workspace", { path: "/target" });
    await vi.waitFor(() => expect(order).toEqual(["freshness"]));
    expect(reconcileNarrativeMaintenanceRecovery).not.toHaveBeenCalled();
    releaseFreshness();
    await vi.waitFor(() => expect(ackNarrativeMaintenanceRecovery).toHaveBeenCalledOnce());
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(freshnessResume).not.toHaveBeenCalled();
    releaseAck();
    await expect(invoke).resolves.toMatchObject({ ok: true });
    expect(order).toEqual(["freshness", "recover:/target", "ack", "open"]);
    expect(reconcileNarrativeMaintenanceRecovery.mock.calls).toEqual([["/target"], ["/target"]]);
    expect(freshnessResume).toHaveBeenCalledOnce();
  });

  it.each(["recovery", "descriptor-ack"])("does not Open when target %s fails", async (failure) => {
    const binding = { authorityId: "target-authority", generation: 1 };
    const reconcileNarrativeMaintenanceRecovery = vi.fn(async () => {
      if (failure === "recovery") throw new Error("target recovery unavailable");
      return { status: "reconciled", descriptorId: 82,
        reason: "maintenance-recovery-complete", recoveredBinding: binding,
        activeBinding: binding, reboundBinding: binding };
    });
    const ackNarrativeMaintenanceRecovery = vi.fn().mockRejectedValue(new Error("ACK unavailable"));
    const scheduler = createNarrativeMaintenanceScheduler({
      reconcileNarrativeMaintenanceRecovery, ackNarrativeMaintenanceRecovery,
    });
    const openWorkspace = vi.fn();
    registerIpcRouter(backendWithOpenWorkspace(openWorkspace), {}, undefined,
      undefined, undefined, undefined, undefined, scheduler);
    await expect(invokeHandler()({ sender: {} }, "open_workspace", { path: "/target" }))
      .resolves.toMatchObject({ ok: false });
    expect(reconcileNarrativeMaintenanceRecovery).toHaveBeenCalledWith("/target");
    expect(openWorkspace).not.toHaveBeenCalled();
  });

  it("opens W2 without attempting an unavailable unrelated W1 recovery", async () => {
    const reconcileNarrativeMaintenanceRecovery = vi.fn(async (path?: string) => {
      if (path !== "/W2") throw new Error("W1 recovery unavailable");
      return { status: "none" };
    });
    const scheduler = createNarrativeMaintenanceScheduler({ reconcileNarrativeMaintenanceRecovery });
    const openWorkspace = vi.fn(async () => JSON.stringify({ status: "ready" }));
    registerIpcRouter(backendWithOpenWorkspace(openWorkspace), {}, undefined,
      undefined, undefined, undefined, undefined, scheduler);
    await expect(invokeHandler()({ sender: {} }, "open_workspace", { path: "/W2" }))
      .resolves.toMatchObject({ ok: true });
    expect(reconcileNarrativeMaintenanceRecovery.mock.calls).toEqual([["/W2"]]);
    expect(openWorkspace).toHaveBeenCalledWith("/W2");
  });

  it.each([undefined, 42, "", " ", "/target\0invalid"])(
    "rejects invalid Open path %j before quiescence or recovery", async (path) => {
      const quiesceForWorkspaceSwitch = vi.fn();
      const reconcileRecoveryBeforeWorkspaceOpen = vi.fn();
      const openWorkspace = vi.fn();
      registerIpcRouter(backendWithOpenWorkspace(openWorkspace), {}, undefined,
        undefined, undefined, undefined, undefined,
        { quiesceForWorkspaceSwitch, reconcileRecoveryBeforeWorkspaceOpen });
      await expect(invokeHandler()({ sender: {} }, "open_workspace", { path }))
        .resolves.toMatchObject({ ok: false });
      expect(quiesceForWorkspaceSwitch).not.toHaveBeenCalled();
      expect(reconcileRecoveryBeforeWorkspaceOpen).not.toHaveBeenCalled();
      expect(openWorkspace).not.toHaveBeenCalled();
    },
  );

  it("cancels a manual Verify through the scheduler before Native workspace swap", async () => {
    vi.useFakeTimers();
    const binding = { authorityId: "authority-manual", generation: 4 };
    const order: string[] = [];
    let releaseVerify!: () => void;
    const verifyFinished = new Promise<void>((resolve) => {
      releaseVerify = resolve;
    });
    const terminalReceipt = (attemptId: string) =>
      JSON.stringify({
        schemaVersion: 1,
        attemptId,
        state: "interrupted",
        stopReason: "workspace-generation-changed",
        generation: binding.generation,
        workspaceBinding: binding,
        publishedGeneration: null,
        works: [],
        cleanup: { status: "failed", error: "rollback failed" },
        connectionReusable: false,
      });
    let activeAttemptId: string | null = null;
    const verifyNarrativeDependencyGraph = vi.fn(async (payload: unknown) => {
      order.push("verify");
      expect(payload).toMatchObject({
        projectId: "project-manual",
        attemptId: expect.stringMatching(/^manual-ipc-/),
      });
      await verifyFinished;
      return JSON.stringify({ runId: "run-manual", reportDigest: "digest" });
    });
    const cancelNarrativeMaintenanceAttempt = vi.fn(
      async (attemptId: string) => {
        order.push("cancel");
        activeAttemptId = attemptId;
        releaseVerify();
        return terminalReceipt(attemptId);
      },
    );
    const openWorkspace = vi.fn(async () => {
      order.push("open");
      return JSON.stringify({ status: "ready" });
    });
    const backend = {
      getNarrativeMaintenanceWorkspaceBinding: () => binding,
      beginNarrativeMaintenanceAttempt: vi.fn(async (attemptId: string) => {
        activeAttemptId = attemptId;
        return JSON.stringify({
          status: "open",
          attemptId,
          authorityId: binding.authorityId,
          generation: binding.generation,
        });
      }),
      cancelNarrativeMaintenanceAttempt,
      verifyNarrativeDependencyGraph,
      openWorkspace,
    };
    const scheduler = createNarrativeMaintenanceScheduler(backend);
    registerIpcRouter(
      backend as unknown as NapiBackendLike,
      {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      scheduler,
    );

    try {
      const manual = invokeHandler()(
        { sender: {} },
        "verify_narrative_dependency_graph",
        { payload: { projectId: "project-manual", attemptId: "renderer-forged" } },
      );
      for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
      }
      expect(backend.beginNarrativeMaintenanceAttempt).toHaveBeenCalledOnce();
      expect(verifyNarrativeDependencyGraph).toHaveBeenCalledOnce();

      const workspaceSwitch = invokeHandler()(
        { sender: {} },
        "open_workspace",
        { path: "/workspace-manual-next" },
      );
      await expect(workspaceSwitch).resolves.toMatchObject({ ok: true });
      await expect(manual).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("CONNECTION_UNUSABLE"),
      });
      expect(cancelNarrativeMaintenanceAttempt).toHaveBeenCalledWith(
        activeAttemptId,
        "workspace-generation-changed",
      );
      expect(order).toEqual(["verify", "cancel", "open"]);
    } finally {
      await scheduler.dispose();
      vi.useRealTimers();
    }
  });

  it.each([
    {
      command: "open_workspace",
      args: { path: "/workspace-failure" },
      method: "openWorkspace",
    },
    {
      command: "restore_backup",
      args: { fileName: "grimodex-20260711-120000.db" },
      method: "restoreBackup",
    },
    {
      command: "restore_recovery_candidate",
      args: { candidateId: "rc_auto_1" },
      method: "restoreRecoveryCandidate",
    },
  ] as const)(
    "resumes retained maintenance backlog when $command fails",
    async ({ command, args, method }) => {
      const failingOperation = vi.fn(async () => {
        throw new Error(`failure from ${command}`);
      });
      const resume = vi.fn();
      const quiesceForWorkspaceSwitch = vi.fn(async () => ({ resume }));
      registerIpcRouter(
        { [method]: failingOperation } as unknown as NapiBackendLike,
        {},
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { quiesceForWorkspaceSwitch },
      );

      const envelope = await invokeHandler()({ sender: {} }, command, args);

      expect(envelope.ok).toBe(false);
      expect(quiesceForWorkspaceSwitch).toHaveBeenCalledOnce();
      expect(failingOperation).toHaveBeenCalledOnce();
      expect(resume).toHaveBeenCalledOnce();
    },
  );

  it("emits one safe success summary when the dev trace is enabled", async () => {
    process.env.GRIMODEX_WORKSPACE_OPEN_TRACE = "1";
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    registerIpcRouter(
      backendWithOpenWorkspace(async () =>
        JSON.stringify({
          status: "ready",
          workspace: {
            name: "SECRET_WORKSPACE_NAME",
            isExisting: true,
            workspaceId: "SECRET_WORKSPACE_ID",
          },
        }),
      ),
    );

    const envelope = await invokeHandler()({ sender: {} }, "open_workspace", {
      path: "/secret/workspace/path",
    });

    expect(envelope.ok).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toBe("[workspace-open-main]");
    const summary = info.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(summary).sort()).toEqual([
      "durationMs",
      "result",
      "version",
    ]);
    expect(summary).toMatchObject({ version: 1, result: "success" });
    expect(summary.durationMs).toEqual(expect.any(Number));
    expect(Number.isFinite(summary.durationMs)).toBe(true);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(info.mock.calls)).not.toMatch(
      /SECRET|\/secret\/workspace\/path/,
    );
  });

  it("emits one safe failure summary without copying the native error", async () => {
    process.env.GRIMODEX_WORKSPACE_OPEN_TRACE = "1";
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    registerIpcRouter(
      backendWithOpenWorkspace(async () => {
        throw new Error("SECRET_NATIVE_ERROR at /secret/workspace/path");
      }),
    );

    const envelope = await invokeHandler()({ sender: {} }, "open_workspace", {
      path: "/secret/workspace/path",
    });

    expect(envelope.ok).toBe(false);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "[workspace-open-main]",
      expect.objectContaining({
        version: 1,
        result: "failure",
        durationMs: expect.any(Number),
      }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toMatch(
      /SECRET|\/secret\/workspace\/path/,
    );
  });

  it("does not emit a summary when the dev trace is disabled", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    registerIpcRouter(
      backendWithOpenWorkspace(async () =>
        JSON.stringify({
          status: "ready",
          workspace: {
            name: "workspace",
            isExisting: true,
            workspaceId: "workspace-id",
          },
        }),
      ),
    );

    await invokeHandler()({ sender: {} }, "open_workspace", {
      path: "/secret/workspace/path",
    });

    expect(info).not.toHaveBeenCalled();
  });

  it("emits one failure terminal when synchronous handler construction throws", async () => {
    process.env.GRIMODEX_WORKSPACE_OPEN_TRACE = "1";
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const constructionError = new Error("handler construction failed");
    registerIpcRouter(
      backendWithOpenWorkspace(async () => {
        throw new Error("backend must not be reached");
      }),
      () => {
        throw constructionError;
      },
    );

    await expect(
      invokeHandler()({ sender: {} }, "open_workspace", {
        path: "/secret/workspace/path",
      }),
    ).rejects.toBe(constructionError);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "[workspace-open-main]",
      expect.objectContaining({
        version: 1,
        result: "failure",
        durationMs: expect.any(Number),
      }),
    );
  });

  it("preserves the successful envelope when the trace logger throws", async () => {
    process.env.GRIMODEX_WORKSPACE_OPEN_TRACE = "1";
    const info = vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    registerIpcRouter(
      backendWithOpenWorkspace(async () =>
        JSON.stringify({
          status: "ready",
          workspace: {
            name: "workspace",
            isExisting: true,
            workspaceId: "workspace-id",
          },
        }),
      ),
    );

    const envelope = await invokeHandler()({ sender: {} }, "open_workspace", {
      path: "/secret/workspace/path",
    });

    expect(envelope.ok).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);
  });
});

describe("NIR-1 router sender binding", () => {
  it("routes every manual license mutation through the main scheduler seam", async () => {
    const runManualOperation = vi.fn(
      (operation: () => Promise<unknown>): Promise<unknown> => operation(),
    );
    const licenseValidation = {
      runManualOperation<T>(operation: () => Promise<T>): Promise<T> {
        return runManualOperation(operation) as Promise<T>;
      },
    };
    const state = JSON.stringify({ status: "license_active" });
    const backend = {
      activateLicense: vi.fn(async () => state),
      revalidateLicense: vi.fn(async () => state),
      deactivateLicense: vi.fn(async () => state),
      getLicenseState: vi.fn(async () => state),
    };
    registerIpcRouter(
      backend as unknown as NapiBackendLike,
      {},
      undefined,
      undefined,
      { active: false },
      undefined,
      licenseValidation,
    );

    for (const [command, args] of [
      ["activate_license", { key: "test-license-key" }],
      ["revalidate_license", {}],
      ["deactivate_license", {}],
    ] as const) {
      const envelope = await invokeHandler()(
        { sender: { id: 42 } },
        command,
        args,
      );
      expect(envelope.ok, command).toBe(true);
    }
    expect(runManualOperation).toHaveBeenCalledTimes(3);

    const stateEnvelope = await invokeHandler()(
      { sender: { id: 42 } },
      "get_license_state",
      {},
    );
    expect(stateEnvelope.ok).toBe(true);
    expect(runManualOperation).toHaveBeenCalledTimes(3);
    expect(backend.getLicenseState).toHaveBeenCalledOnce();
  });

  it("returns a denied egress route as an envelope before Native dispatch", async () => {
    const sendChatMessage = vi.fn();
    const profileEgress = {
      restricted: true,
      unavailable: false,
      issueCallerIdentity: vi.fn(() => ({
        profileId: "profile-1",
        callerId: "main-caller-1",
        callerEpoch: 2,
        senderId: 42,
        workspaceId: null,
        sessionId: "session-1",
      })),
      assertInvoke: vi.fn(() => {
        throw new Error("D2A_EGRESS_DENIED: old-external-ai");
      }),
      assertPlaintextPublication: vi.fn(),
      allowsBackendEvent: vi.fn(() => true),
      assertExternalUrl: vi.fn(),
      registerMainEgressParticipant: vi.fn(),
    };
    registerIpcRouter(
      { sendChatMessage } as unknown as NapiBackendLike,
      {},
      undefined,
      undefined,
      { active: false },
      profileEgress,
    );

    const envelope = await invokeHandler()(
      { sender: { id: 42 } },
      "send_chat_message",
      {},
    );

    expect(envelope).toEqual({
      ok: false,
      error: "D2A_EGRESS_DENIED: old-external-ai",
    });
    expect(sendChatMessage).not.toHaveBeenCalled();
  });

  it("replaces renderer identity with the main-issued caller before Native dispatch", async () => {
    const saveAiSettings = vi.fn(async () => undefined);
    const identity = {
      profileId: "profile-1",
      callerId: "main-caller-1",
      callerEpoch: 2,
      senderId: 42,
      workspaceId: null,
      sessionId: "session-1",
    };
    const profileEgress = {
      restricted: true,
      unavailable: false,
      issueCallerIdentity: vi.fn(() => identity),
      assertInvoke: vi.fn(),
      assertPlaintextPublication: vi.fn(),
      allowsBackendEvent: vi.fn(() => true),
      assertExternalUrl: vi.fn(),
      registerMainEgressParticipant: vi.fn(),
    };
    registerIpcRouter(
      { saveAiSettings } as unknown as NapiBackendLike,
      {},
      undefined,
      undefined,
      { active: false },
      profileEgress,
    );

    const envelope = await invokeHandler()(
      { sender: { id: 42 } },
      "save_ai_settings",
      { settings: {}, callerIdentity: { callerId: "renderer-forged" } },
    );

    expect(envelope.ok).toBe(true);
    expect(profileEgress.issueCallerIdentity).toHaveBeenCalledWith(42);
    expect(profileEgress.assertInvoke).toHaveBeenCalledWith(
      "save_ai_settings",
      expect.objectContaining({ callerIdentity: identity }),
    );
    expect(saveAiSettings).toHaveBeenCalledWith({});
  });

  it("hands a trusted unchanged restore proof to the main profile gate", async () => {
    const outcome = {
      status: "unchanged",
      operationOutcome: "failed",
      contentEffect: "none",
      lifecycle: {
        schemaVersion: 1,
        revision: 3,
        status: "ready",
        bindingToken: "bnd-normal-ready",
        activation: "ready",
      },
    } as const;
    const restoreBackup = vi.fn(async () => JSON.stringify(outcome));
    const observeWorkspaceLifecycleResult = vi.fn();
    const profileEgress = {
      restricted: true,
      unavailable: false,
      issueCallerIdentity: vi.fn(() => ({
        profileId: "profile-1",
        callerId: "main-caller-1",
        callerEpoch: 2,
        senderId: 42,
        workspaceId: "/workspace-normal",
        sessionId: "session-1",
      })),
      assertInvoke: vi.fn(),
      assertPlaintextPublication: vi.fn(),
      allowsBackendEvent: vi.fn(() => true),
      assertExternalUrl: vi.fn(),
      registerMainEgressParticipant: vi.fn(),
      observeWorkspaceLifecycleResult,
    };
    registerIpcRouter(
      { restoreBackup } as unknown as NapiBackendLike,
      {},
      undefined,
      undefined,
      { active: false },
      profileEgress,
    );

    const envelope = await invokeHandler()(
      { sender: { id: 42 } },
      "restore_backup",
      { fileName: "grimodex-test.db" },
    );

    expect(envelope).toEqual({ ok: true, value: outcome });
    expect(observeWorkspaceLifecycleResult).toHaveBeenCalledOnce();
    expect(observeWorkspaceLifecycleResult).toHaveBeenCalledWith(outcome);
  });

  it("runs the dedicated typed cold reader through D2a at entry and return", async () => {
    const identity = {
      profileId: "profile-1",
      callerId: "main-caller-1",
      callerEpoch: 2,
      senderId: 42,
      workspaceId: "/workspace-1",
      sessionId: "session-1",
    };
    const typedRead = vi.fn(async () =>
      JSON.stringify({
        status: "available",
        result: {
          projectId: "project-1",
          revisionId: "revision-1",
          bundle: { entities: [], relations: [] },
        },
      }),
    );
    const assertPlaintextPublication = vi.fn(() => {
      throw new Error("D2A_EGRESS_DENIED: plaintext-publication");
    });
    const profileEgress = {
      restricted: false,
      unavailable: false,
      issueCallerIdentity: vi.fn(() => identity),
      assertInvoke: vi.fn(),
      assertPlaintextPublication,
      allowsBackendEvent: vi.fn(() => true),
      assertExternalUrl: vi.fn(),
      registerMainEgressParticipant: vi.fn(),
    };
    registerIpcRouter(
      {
        nir1EntityRelationRevisionRead: typedRead,
      } as unknown as NapiBackendLike,
      {},
      undefined,
      undefined,
      { active: false },
      profileEgress,
    );

    const envelope = await invokeHandler()(
      { sender: { id: 42 } },
      "nir1_entity_relation_revision_read",
      {
        expectedWorkspacePath: "/workspace-1",
        projectId: "project-1",
        revisionId: "revision-1",
        callerIdentity: { callerId: "renderer-forged" },
      },
    );

    expect(envelope).toEqual({
      ok: false,
      error: "D2A_EGRESS_DENIED: plaintext-publication",
    });
    expect(typedRead).toHaveBeenCalledExactlyOnceWith({
      expectedWorkspacePath: "/workspace-1",
      projectId: "project-1",
      revisionId: "revision-1",
    });
    expect(profileEgress.assertInvoke).toHaveBeenCalledWith(
      "nir1_entity_relation_revision_read",
      expect.objectContaining({ callerIdentity: identity }),
    );
    expect(assertPlaintextPublication).toHaveBeenCalledWith(
      "nir1_entity_relation_revision_read",
      expect.objectContaining({ callerIdentity: identity }),
    );
  });

  it("runs typed prepare and target/current typed reads through D2a at both boundaries", async () => {
    const identity = {
      profileId: "profile-1",
      callerId: "main-caller-1",
      callerEpoch: 2,
      senderId: 42,
      workspaceId: "/workspace-1",
      sessionId: "session-1",
    };
    const prepare = vi.fn(async () =>
      JSON.stringify({
        runId: "run-1",
        status: "draft",
        receipt: {
          proposalSetId: "set-1",
          proposalId: "proposal-1",
          revisionId: "revision-1",
          status: "unreviewed",
        },
      }),
    );
    const readCurrent = vi.fn(async () =>
      JSON.stringify({ status: "draft", result: {} }),
    );
    const restore = vi.fn(async () =>
      JSON.stringify({
        runId: "run-1",
        response: {
          status: "unavailable",
          result: { reason: "source-revision-changed" },
        },
      }),
    );
    const assertPlaintextPublication = vi.fn((command: string) => {
      if (command === "nir1_entity_relation_revision_prepare") return;
      throw new Error("D2A_EGRESS_DENIED: plaintext-publication");
    });
    const profileEgress = {
      restricted: false,
      unavailable: false,
      issueCallerIdentity: vi.fn(() => identity),
      assertInvoke: vi.fn(),
      assertPlaintextPublication,
      allowsBackendEvent: vi.fn(() => true),
      assertExternalUrl: vi.fn(),
      registerMainEgressParticipant: vi.fn(),
    };
    registerIpcRouter(
      {
        nir1EntityRelationRevisionPrepare: prepare,
        nir1EntityRelationRevisionReadCurrent: readCurrent,
        nir1EntityRelationRevisionRestore: restore,
      } as unknown as NapiBackendLike,
      {},
      undefined,
      undefined,
      { active: false },
      profileEgress,
    );

    const workspaceBinding = {
      authorityId: "authority-1",
      generation: 1,
      authorityInstanceId: "1",
    };
    const prepareArgs = {
      payload: {
        projectId: "project-1",
        sceneId: "scene-1",
        entityIds: ["entity-1"],
        relationIds: [],
      },
      workspaceBinding,
    };
    const prepareEnvelope = await invokeHandler()(
      { sender: { id: 42 } },
      "nir1_entity_relation_revision_prepare",
      prepareArgs,
    );
    expect(prepareEnvelope).toEqual({
      ok: true,
      value: {
        runId: "run-1",
        status: "draft",
        receipt: {
          proposalSetId: "set-1",
          proposalId: "proposal-1",
          revisionId: "revision-1",
          status: "unreviewed",
        },
      },
    });
    expect(prepare).toHaveBeenCalledExactlyOnceWith(
      prepareArgs.payload,
      workspaceBinding,
    );

    const currentArgs = {
      expectedWorkspacePath: "/workspace-1",
      projectId: "project-1",
      runId: "run-1",
    };
    const currentEnvelope = await invokeHandler()(
      { sender: { id: 42 } },
      "nir1_entity_relation_revision_read_current",
      currentArgs,
    );
    expect(currentEnvelope).toEqual({
      ok: false,
      error: "D2A_EGRESS_DENIED: plaintext-publication",
    });
    expect(readCurrent).toHaveBeenCalledExactlyOnceWith(currentArgs);
    const restoreArgs = {
      expectedWorkspacePath: "/workspace-1",
      projectId: "project-1",
      entityId: "entity-1",
      relationId: null,
    };
    const restoreEnvelope = await invokeHandler()(
      { sender: { id: 42 } },
      "nir1_entity_relation_revision_restore",
      restoreArgs,
    );
    expect(restoreEnvelope).toEqual({
      ok: false,
      error: "D2A_EGRESS_DENIED: plaintext-publication",
    });
    expect(restore).toHaveBeenCalledExactlyOnceWith(restoreArgs);
    expect(profileEgress.assertInvoke).toHaveBeenNthCalledWith(
      1,
      "nir1_entity_relation_revision_prepare",
      expect.objectContaining({ callerIdentity: identity }),
    );
    expect(profileEgress.assertInvoke).toHaveBeenNthCalledWith(
      2,
      "nir1_entity_relation_revision_read_current",
      expect.objectContaining({ callerIdentity: identity }),
    );
    expect(profileEgress.assertInvoke).toHaveBeenNthCalledWith(
      3,
      "nir1_entity_relation_revision_restore",
      expect.objectContaining({ callerIdentity: identity }),
    );
    expect(assertPlaintextPublication).toHaveBeenNthCalledWith(
      1,
      "nir1_entity_relation_revision_prepare",
      expect.objectContaining({ callerIdentity: identity }),
    );
    expect(assertPlaintextPublication).toHaveBeenNthCalledWith(
      2,
      "nir1_entity_relation_revision_read_current",
      expect.objectContaining({ callerIdentity: identity }),
    );
    expect(assertPlaintextPublication).toHaveBeenNthCalledWith(
      3,
      "nir1_entity_relation_revision_restore",
      expect.objectContaining({ callerIdentity: identity }),
    );
  });

  it("does not return an admitted plaintext read while profile activation drains", async () => {
    const initialStatus = {
      profileId: "profile-1",
      callerEpoch: 4,
      restricted: false,
      handlesInvalidated: false,
      inFlightStopped: true,
      sqlPolicy: {
        version: 1,
        protectedTables: ["narrative_extraction_runs"],
        protectedColumns: [],
      },
    };
    const activatedStatus = {
      ...initialStatus,
      profileId: "profile-activated",
      callerEpoch: 5,
      restricted: true,
      handlesInvalidated: true,
    };
    let resolveReader!: (value: string | PromiseLike<string>) => void;
    const readerResponse = new Promise<string>((resolve) => {
      resolveReader = resolve;
    });
    const narrativeExtractionGetRun = vi.fn(() => readerResponse);
    const activateProfileEgress = vi.fn(async () =>
      JSON.stringify(activatedStatus),
    );
    const backend = {
      initializeProfileEgress: vi.fn(async () => JSON.stringify(initialStatus)),
      activateProfileEgress,
      registerProfileEgressCaller: vi.fn(),
      invalidateProfileEgressCallers: vi.fn(),
      narrativeExtractionGetRun,
    };
    const profileEgress = await createProfileEgressGate(
      backend as unknown as NapiBackendLike,
    );
    let releaseDrain!: () => void;
    const drain = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseDrain = resolve;
        }),
    );
    profileEgress.registerMainEgressParticipant("reader-drain", drain);
    registerIpcRouter(
      backend as unknown as NapiBackendLike,
      {},
      undefined,
      undefined,
      { active: false },
      profileEgress,
    );

    const pendingReader = invokeHandler()(
      { sender: { id: 42 } },
      "narrative_extraction_get_run",
      { payload: { runId: "run-1", projectId: "project-1" } },
    );
    await vi.waitFor(() =>
      expect(narrativeExtractionGetRun).toHaveBeenCalledOnce(),
    );

    const activation = profileEgress.activateFirstRestrictedPublication!();
    await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce());
    expect(profileEgress.restricted).toBe(true);
    expect(activateProfileEgress).not.toHaveBeenCalled();

    resolveReader(JSON.stringify({ secret: "D2A_PLAINTEXT_SENTINEL" }));
    const envelope = await pendingReader;
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error).toMatch(
        /^D2A_EGRESS_DENIED: plaintext-publication/u,
      );
      expect(envelope.error).not.toContain("D2A_PLAINTEXT_SENTINEL");
    }

    releaseDrain();
    await activation;
  });

  it("preserves Native opaque committed receipts for single and batch DB writes", async () => {
    const identity = {
      profileId: "profile-1",
      callerId: "main-caller-1",
      callerEpoch: 2,
      senderId: 42,
      workspaceId: null,
      sessionId: "session-1",
    };
    const assertPlaintextPublication = vi.fn(() => {
      throw new Error("D2A_EGRESS_DENIED: plaintext-publication");
    });
    const profileEgress = {
      restricted: true,
      unavailable: false,
      issueCallerIdentity: vi.fn(() => identity),
      assertInvoke: vi.fn(),
      assertPlaintextPublication,
      allowsBackendEvent: vi.fn(() => true),
      assertExternalUrl: vi.fn(),
      registerMainEgressParticipant: vi.fn(),
    };
    const backend = {
      dbExecute: vi.fn(async () =>
        JSON.stringify({ rows: [], committed: true }),
      ),
      dbExecuteBatch: vi.fn(async () =>
        JSON.stringify({ rows: [], committed: true }),
      ),
    };
    registerIpcRouter(
      backend as unknown as NapiBackendLike,
      {},
      undefined,
      undefined,
      { active: false },
      profileEgress,
    );

    const single = await invokeHandler()({ sender: { id: 42 } }, "db_execute", {
      sql: "UPDATE chat_sessions SET title = ? WHERE id = ?",
      params: ["next", "session-1"],
      method: "run",
    });
    const batch = await invokeHandler()(
      { sender: { id: 42 } },
      "db_execute_batch",
      {
        statements: [
          {
            sql: "UPDATE chat_sessions SET title = ? WHERE id = ?",
            params: ["next", "session-1"],
            method: "run",
          },
        ],
      },
    );

    expect(single).toEqual({
      ok: true,
      value: { rows: [], committed: true },
    });
    expect(batch).toEqual({
      ok: true,
      value: { rows: [], committed: true },
    });
    expect(assertPlaintextPublication).not.toHaveBeenCalled();

    backend.dbExecute.mockResolvedValueOnce(
      JSON.stringify({ rows: [], committed: true, unexpected: true }),
    );
    const malformedReceipt = await invokeHandler()(
      { sender: { id: 42 } },
      "db_execute",
      {
        sql: "UPDATE chat_sessions SET title = ? WHERE id = ?",
        params: ["next", "session-1"],
        method: "run",
      },
    );
    expect(malformedReceipt).toEqual({
      ok: false,
      error: "D2A_EGRESS_DENIED: plaintext-publication",
    });
    expect(assertPlaintextPublication).toHaveBeenCalledOnce();
  });

  it("converts successful Native mutation results to opaque receipts when main closes publication", async () => {
    const identity = {
      profileId: "profile-1",
      callerId: "main-caller-1",
      callerEpoch: 2,
      senderId: 42,
      workspaceId: null,
      sessionId: "session-1",
    };
    const assertPlaintextPublication = vi.fn(() => {
      throw new Error("D2A_EGRESS_DENIED: plaintext-publication");
    });
    const nativeMutation = JSON.stringify({
      rows: [{ secret: "D2A_PLAINTEXT_SENTINEL" }],
      __grimodexDbResultKind: "committed-mutation",
    });
    const profileEgress = {
      restricted: true,
      unavailable: false,
      issueCallerIdentity: vi.fn(() => identity),
      assertInvoke: vi.fn(),
      assertPlaintextPublication,
      allowsBackendEvent: vi.fn(() => true),
      assertExternalUrl: vi.fn(),
      registerMainEgressParticipant: vi.fn(),
    };
    const backend = {
      dbExecute: vi.fn(async () => nativeMutation),
      dbExecuteBatch: vi.fn(async () => nativeMutation),
    };
    registerIpcRouter(
      backend as unknown as NapiBackendLike,
      {},
      undefined,
      undefined,
      { active: false },
      profileEgress,
    );

    const single = await invokeHandler()({ sender: { id: 42 } }, "db_execute", {
      sql: "UPDATE chat_sessions SET title = ? WHERE id = ?",
      params: ["next", "session-1"],
      method: "run",
    });
    const batch = await invokeHandler()(
      { sender: { id: 42 } },
      "db_execute_batch",
      {
        statements: [
          {
            sql: "UPDATE chat_sessions SET title = ? WHERE id = ?",
            params: ["next", "session-1"],
            method: "run",
          },
        ],
      },
    );

    expect(single).toEqual({
      ok: true,
      value: { rows: [], committed: true },
    });
    expect(batch).toEqual({
      ok: true,
      value: { rows: [], committed: true },
    });
    expect(assertPlaintextPublication).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(single)).not.toContain("D2A_PLAINTEXT_SENTINEL");
    expect(JSON.stringify(batch)).not.toContain("D2A_PLAINTEXT_SENTINEL");
  });

  it("strips the Native mutation marker while preserving rows when publication remains allowed", async () => {
    const identity = {
      profileId: "profile-1",
      callerId: "main-caller-1",
      callerEpoch: 2,
      senderId: 42,
      workspaceId: null,
      sessionId: "session-1",
    };
    const assertPlaintextPublication = vi.fn();
    const backend = {
      dbExecute: vi.fn(async () =>
        JSON.stringify({
          rows: [{ id: "created-1" }],
          __grimodexDbResultKind: "committed-mutation",
        }),
      ),
      dbExecuteBatch: vi.fn(async () => JSON.stringify({ rows: [] })),
    };
    registerIpcRouter(
      backend as unknown as NapiBackendLike,
      {},
      undefined,
      undefined,
      { active: false },
      {
        restricted: false,
        unavailable: false,
        issueCallerIdentity: vi.fn(() => identity),
        assertInvoke: vi.fn(),
        assertPlaintextPublication,
        allowsBackendEvent: vi.fn(() => true),
        assertExternalUrl: vi.fn(),
        registerMainEgressParticipant: vi.fn(),
      },
    );

    const envelope = await invokeHandler()(
      { sender: { id: 42 } },
      "db_execute",
      {
        sql: "INSERT INTO app_settings (key, value) VALUES (?, ?) RETURNING key",
        params: ["new-key", "new-value"],
        method: "all",
      },
    );

    expect(envelope).toEqual({
      ok: true,
      value: { rows: [{ id: "created-1" }] },
    });
    expect(assertPlaintextPublication).toHaveBeenCalledOnce();
    expect(JSON.stringify(envelope)).not.toContain("__grimodexDbResultKind");
  });

  it("keeps every legacy AI family at dispatch zero, including route variants", async () => {
    const nativeTransportCalls: string[] = [];
    const nativeTransport = (method: string, result = "{}") =>
      vi.fn(async () => {
        nativeTransportCalls.push(method);
        return result;
      });
    const nativeCalls = {
      initializeProfileEgress: async () =>
        JSON.stringify({
          profileId: "profile-1",
          callerEpoch: 2,
          restricted: true,
          handlesInvalidated: true,
          inFlightStopped: true,
          sqlPolicy: {
            version: 1,
            protectedTables: [
              "ab_comparison_runs",
              "ab_comparisons",
              "ai_audit_events",
              "chat_message_chunks",
              "chat_messages_fts",
              "chat_messages_fts_en",
              "chat_message_prompts",
              "chat_messages",
              "chat_runtime_threads",
              "chat_sessions",
              "chat_summaries",
              "generation_logs",
              "messages",
              "narrative_apply_commits",
              "narrative_apply_operations",
              "narrative_commit_journals",
              "narrative_extraction_artifacts",
              "narrative_extraction_attempts",
              "narrative_extraction_runs",
              "narrative_extraction_tasks",
              "narrative_proposal_decisions",
              "narrative_proposal_revisions",
              "narrative_proposal_sets",
              "narrative_proposals",
              "post_effect_annotation_relations",
              "post_effect_annotations",
              "post_effect_annotations_fts",
              "post_effect_annotations_fts_en",
              "post_effect_runs",
              "impact_review_baselines",
              "scene_lens_data",
              "scene_chunks",
              "codex_chunks",
              "event_chunks",
              "undo_journal",
              "prose_staging",
            ],
            protectedColumns: [
              { table: "change_events", column: "payload" },
              { table: "state_snapshots", column: "payload" },
            ],
          },
        }),
      registerProfileEgressCaller: vi.fn(),
      invalidateProfileEgressCallers: vi.fn(),
      sendChatMessage: nativeTransport("sendChatMessage"),
      sendChatMessageStream: nativeTransport("sendChatMessageStream"),
      sendInlineAiStream: nativeTransport("sendInlineAiStream"),
      sendAgentMessage: nativeTransport("sendAgentMessage"),
      listAiModels: nativeTransport("listAiModels"),
      testAiConnection: nativeTransport("testAiConnection"),
      startPostEffectRun: nativeTransport("startPostEffectRun"),
      startPostEffectRunMulti: nativeTransport("startPostEffectRunMulti"),
      narrativeExtractionGetRunReviewBundle: nativeTransport(
        "narrativeExtractionGetRunReviewBundle",
      ),
      narrativeExtractionClaimTask: nativeTransport(
        "narrativeExtractionClaimTask",
        JSON.stringify({
          claimed: true,
          task: { inputJson: "D2A_TASK_PLAINTEXT_SENTINEL" },
        }),
      ),
      saveGlobalSettings: nativeTransport("saveGlobalSettings"),
    };
    const childDispatches: string[] = [];
    const vivliostyleBuild = vi.fn(async () => "run-id");
    const vivliostylePreviewStart = vi.fn(async () => null);
    const cliManager = createCliAiManager(() => undefined, {
      runner: {
        run: async () => {
          childDispatches.push("run");
          return { exitCode: 0, signal: null, stdout: "", stderr: "" };
        },
        start: () => {
          childDispatches.push("start");
          throw new Error("unexpected CLI child dispatch");
        },
      } as never,
      detectBinary: async () => null,
    });
    const profileEgress = await createProfileEgressGate(
      nativeCalls as unknown as NapiBackendLike,
    );
    registerIpcRouter(
      nativeCalls as unknown as NapiBackendLike,
      {
        ...cliManager.handlers,
        vivliostyle_build: vivliostyleBuild,
        vivliostyle_preview_start: vivliostylePreviewStart,
      },
      undefined,
      undefined,
      { active: false },
      profileEgress,
    );

    const legacyRoutes: Array<[string, Record<string, unknown>]> = [
      ["send_chat_message", { messages: ["old"], apiVariant: "loopback" }],
      [
        "send_chat_message_stream",
        { messages: ["old"], endpointId: "proxy", retry: true },
      ],
      ["send_inline_ai_stream", { messages: ["old"], apiVariant: "redirect" }],
      ["send_agent_message", { messages: ["old"], sessionId: "other" }],
      ["list_ai_models", { provider: "ollama", endpointId: "proxy" }],
      ["test_ai_connection", { provider: "ollama", endpointId: "redirect" }],
      ["start_post_effect_run", { retry: true, sessionId: "old" }],
      ["start_post_effect_run_multi", { retry: true, workspaceId: "other" }],
      ["send_cli_chat_stream", { sessionId: undefined }],
      ["detect_cli_binary", { cli: "codex" }],
      ["test_cli_connection", { endpointId: "proxy" }],
      ["list_cli_models", { retry: true }],
      ["codex_app_start_turn", { sessionId: "old", workspaceId: "other" }],
      ["codex_app_respond_to_request", { requestId: "old" }],
      ["codex_app_get_status", { sessionId: undefined }],
      ["codex_app_list_models", { workspaceId: "other", retry: true }],
      ["codex_app_test_connection", { redirect: true }],
      ["activate_license", { key: "arbitrary-plaintext-license-key" }],
      ["revalidate_license", {}],
      ["deactivate_license", {}],
      [
        "vivliostyle_build",
        { files: [{ path: "sentinel.md", content: "sentinel" }] },
      ],
      ["vivliostyle_preview_start", { url: "https://sentinel.invalid" }],
      [
        "narrative_extraction_claim_task",
        {
          payload: { runId: "run-1", projectId: "project-1" },
          workspaceBinding: { authorityId: "authority-1" },
        },
      ],
      ["narrative_extraction_get_run_review_bundle", { messages: ["old"] }],
      ["project_snapshot_restore_context", { workspaceId: "other" }],
      ["lint_ignore_list", { projectId: "other" }],
      ["lint_ignore_list_scene", { projectId: "other", sessionId: "old" }],
      ["lint_term_dictionary_list", { projectId: "other" }],
    ];

    for (const [command, args] of legacyRoutes) {
      const envelope = await invokeHandler()(
        { sender: { id: 42 } },
        command,
        args,
      );
      expect(envelope.ok, command).toBe(false);
      if (!envelope.ok) {
        expect(envelope.error, command).toMatch(
          new RegExp(`^${D2A_EGRESS_DENIED_MARKER}`),
        );
      }
    }
    for (const call of [
      nativeCalls.sendChatMessage,
      nativeCalls.sendChatMessageStream,
      nativeCalls.sendInlineAiStream,
      nativeCalls.sendAgentMessage,
      nativeCalls.listAiModels,
      nativeCalls.testAiConnection,
      nativeCalls.startPostEffectRun,
      nativeCalls.startPostEffectRunMulti,
      nativeCalls.narrativeExtractionClaimTask,
      nativeCalls.narrativeExtractionGetRunReviewBundle,
    ]) {
      expect(call).not.toHaveBeenCalled();
    }
    expect(nativeTransportCalls).toEqual([]);
    expect(childDispatches).toEqual([]);
    expect(vivliostyleBuild).not.toHaveBeenCalled();
    expect(vivliostylePreviewStart).not.toHaveBeenCalled();

    const save = await invokeHandler()(
      { sender: { id: 42 } },
      "save_global_settings",
      { settings: { theme: "dark" } },
    );
    expect(save.ok).toBe(true);
    expect(nativeTransportCalls).toEqual(["saveGlobalSettings"]);
    cliManager.disposeAll();
  });

  it("uses the Native-backed D2a gate for protected SQL and typed capture outcomes", async () => {
    const status = {
      profileId: "profile-capture-test",
      callerEpoch: 7,
      restricted: true,
      handlesInvalidated: true,
      inFlightStopped: true,
      sqlPolicy: {
        version: 1,
        protectedTables: ["chat_sessions", "chat_messages"],
        protectedColumns: [],
      },
    };
    const responses: string[] = [];
    const captureCurrentChatInput = vi.fn(async () => responses.shift()!);
    const cancelCurrentChatInput = vi.fn(async (request) =>
      JSON.stringify({
        status: "cancelled",
        submissionId: request.submissionId,
        messageId: request.messageId,
      }),
    );
    const dbExecute = vi.fn(async () => JSON.stringify({ rows: [] }));
    const sendChatMessageStream = vi.fn();
    const backend = {
      initializeProfileEgress: vi.fn(async () => JSON.stringify(status)),
      registerProfileEgressCaller: vi.fn(),
      invalidateProfileEgressCallers: vi.fn(),
      captureCurrentChatInput,
      cancelCurrentChatInput,
      dbExecute,
      sendChatMessageStream,
    };
    const profileEgress = await createProfileEgressGate(
      backend as unknown as NapiBackendLike,
    );
    registerIpcRouter(
      backend as unknown as NapiBackendLike,
      {},
      undefined,
      undefined,
      { active: false },
      profileEgress,
    );
    const event = { sender: { id: 42, isDestroyed: () => false } };
    const submission = (submissionId: string) => ({
      submissionId,
      messageId: `message-${submissionId}`,
      chatSessionId: "session-1",
      sceneId: "scene-1",
      content: "local Human input",
      createdAt: "2026-09-29T10:00:00.000Z",
    });
    const acceptedSubmission = submission("accepted-1");
    responses.push(
      JSON.stringify({
        status: "accepted",
        projectId: "project-1",
        chatSessionId: acceptedSubmission.chatSessionId,
        sceneId: acceptedSubmission.sceneId,
        messageId: acceptedSubmission.messageId,
      }),
    );
    const accepted = await invokeHandler()(
      event,
      "capture_current_chat_input",
      { submission: acceptedSubmission },
    );

    const mismatchedSubmission = submission("mismatch-1");
    responses.push(
      JSON.stringify({
        status: "accepted",
        projectId: "project-1",
        chatSessionId: "wrong-session",
        sceneId: mismatchedSubmission.sceneId,
        messageId: mismatchedSubmission.messageId,
      }),
    );
    const mismatch = await invokeHandler()(
      event,
      "capture_current_chat_input",
      { submission: mismatchedSubmission },
    );

    const legacySubmission = submission("legacy-1");
    responses.push(JSON.stringify({ status: "unrestricted" }));
    const legacy = await invokeHandler()(
      event,
      "capture_current_chat_input",
      { submission: legacySubmission },
    );
    const protectedRead = await invokeHandler()(
      event,
      "db_execute",
      {
        sql: "SELECT id FROM chat_sessions WHERE id = ?",
        params: ["session-1"],
        method: "get",
      },
    );
    const legacyStream = await invokeHandler()(
      event,
      "send_chat_message_stream",
      {},
    );

    expect(profileEgress.restricted).toBe(true);
    expect(accepted).toEqual({
      ok: true,
      value: {
        status: "accepted",
        projectId: "project-1",
        chatSessionId: acceptedSubmission.chatSessionId,
        sceneId: acceptedSubmission.sceneId,
        messageId: acceptedSubmission.messageId,
      },
    });
    expect(mismatch).toMatchObject({
      ok: false,
      error: expect.stringContaining("IPC_CAPTURE_RESULT_BINDING_MISMATCH"),
    });
    expect(cancelCurrentChatInput).toHaveBeenCalledWith(
      {
        submissionId: mismatchedSubmission.submissionId,
        messageId: mismatchedSubmission.messageId,
        chatSessionId: mismatchedSubmission.chatSessionId,
        sceneId: mismatchedSubmission.sceneId,
      },
      expect.any(String),
    );
    expect(legacy).toEqual({ ok: true, value: { status: "legacy-only" } });
    expect(protectedRead).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        new RegExp(`^${D2A_EGRESS_DENIED_MARKER} plaintext-publication`),
      ),
    });
    expect(legacyStream).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        new RegExp(`^${D2A_EGRESS_DENIED_MARKER} old-external-ai`),
      ),
    });
    expect(captureCurrentChatInput).toHaveBeenCalledTimes(3);
    expect(dbExecute).not.toHaveBeenCalled();
    expect(sendChatMessageStream).not.toHaveBeenCalled();
  });

  it("binds capture to the actual event sender and strips renderer caller claims", async () => {
    const identity = {
      profileId: "profile-1",
      callerId: "main-caller-1",
      callerEpoch: 2,
      senderId: 42,
      workspaceId: "/workspace-1",
      sessionId: "main-session-1",
    };
    const submission = {
      submissionId: "submission-1",
      messageId: "message-1",
      chatSessionId: "chat-session-1",
      sceneId: "scene-1",
      content: "local text",
      createdAt: "2026-09-28T10:00:00.000Z",
    };
    const captureCurrentChatInput = vi.fn(async () =>
      JSON.stringify({
        status: "accepted",
        projectId: "project-1",
        chatSessionId: submission.chatSessionId,
        sceneId: submission.sceneId,
        messageId: submission.messageId,
      }),
    );
    const profileEgress = {
      restricted: true,
      unavailable: false,
      issueCallerIdentity: vi.fn(() => identity),
      assertInvoke: vi.fn(),
      assertPlaintextPublication: vi.fn(),
      allowsBackendEvent: vi.fn(() => true),
      assertExternalUrl: vi.fn(),
      registerMainEgressParticipant: vi.fn(),
    };
    registerIpcRouter(
      { captureCurrentChatInput } as unknown as NapiBackendLike,
      {},
      undefined,
      undefined,
      { active: false },
      profileEgress,
    );

    const envelope = await invokeHandler()(
      { sender: { id: 42, isDestroyed: () => false } },
      "capture_current_chat_input",
      { submission, callerIdentity: { ...identity, senderId: 999 } },
    );

    expect(envelope.ok).toBe(true);
    expect(profileEgress.issueCallerIdentity).toHaveBeenCalledWith(42);
    expect(profileEgress.assertInvoke).toHaveBeenCalledWith(
      "capture_current_chat_input",
      expect.objectContaining({ callerIdentity: identity }),
    );
    expect(captureCurrentChatInput).toHaveBeenCalledWith(
      submission,
      JSON.stringify(identity),
    );
  });

  it("binds retirement to the actual main caller and forwards only the session selector", async () => {
    const identity = {
      profileId: "profile-1",
      callerId: "main-caller-1",
      callerEpoch: 2,
      senderId: 42,
      workspaceId: "/workspace-1",
      sessionId: "main-session-1",
    };
    const retireCurrentChatInput = vi.fn(async () =>
      JSON.stringify({ status: "retired", chatSessionId: "chat-session-1" }),
    );
    const profileEgress = {
      restricted: true,
      unavailable: false,
      issueCallerIdentity: vi.fn(() => identity),
      assertInvoke: vi.fn(),
      assertPlaintextPublication: vi.fn(),
      allowsBackendEvent: vi.fn(() => true),
      assertExternalUrl: vi.fn(),
      registerMainEgressParticipant: vi.fn(),
    };
    registerIpcRouter(
      { retireCurrentChatInput } as unknown as NapiBackendLike,
      {},
      undefined,
      undefined,
      { active: false },
      profileEgress,
    );

    const envelope = await invokeHandler()(
      { sender: { id: 42, isDestroyed: () => false } },
      "retire_current_chat_input",
      { chatSessionId: "chat-session-1", callerIdentity: { senderId: 999 } },
    );

    expect(envelope.ok).toBe(true);
    expect(profileEgress.issueCallerIdentity).toHaveBeenCalledWith(42);
    expect(profileEgress.assertInvoke).toHaveBeenCalledWith(
      "retire_current_chat_input",
      expect.objectContaining({ callerIdentity: identity }),
    );
    expect(retireCurrentChatInput).toHaveBeenCalledWith(
      { chatSessionId: "chat-session-1" },
      JSON.stringify(identity),
    );
  });

  it("forwards only Native-confirmed unrestricted results and ignores renderer mode claims", async () => {
    const identity = {
      profileId: "profile-1",
      callerId: "main-caller-1",
      callerEpoch: 2,
      senderId: 42,
      workspaceId: null,
      sessionId: "main-session-1",
    };
    const captureCurrentChatInput = vi.fn(async () =>
      JSON.stringify({ status: "unrestricted" }),
    );
    const retireCurrentChatInput = vi.fn(async () =>
      JSON.stringify({ status: "unrestricted" }),
    );
    const profileEgress = {
      restricted: false,
      unavailable: false,
      issueCallerIdentity: vi.fn(() => identity),
      assertInvoke: vi.fn(),
      assertPlaintextPublication: vi.fn(),
      allowsBackendEvent: vi.fn(() => true),
      assertExternalUrl: vi.fn(),
      registerMainEgressParticipant: vi.fn(),
    };
    registerIpcRouter(
      {
        captureCurrentChatInput,
        retireCurrentChatInput,
      } as unknown as NapiBackendLike,
      {},
      undefined,
      undefined,
      { active: false },
      profileEgress,
    );
    const sender = { sender: { id: 42, isDestroyed: () => false } };
    const submission = {
      submissionId: "submission-1",
      messageId: "message-1",
      chatSessionId: "chat-session-1",
      sceneId: "scene-1",
      content: "local text",
      createdAt: "2026-09-28T10:00:00.000Z",
    };

    const capture = await invokeHandler()(
      sender,
      "capture_current_chat_input",
      { submission },
    );
    const retirement = await invokeHandler()(
      sender,
      "retire_current_chat_input",
      { chatSessionId: submission.chatSessionId },
    );
    const forged = await invokeHandler()(sender, "capture_current_chat_input", {
      submission,
      unrestricted: true,
    });

    expect(capture).toEqual({ ok: true, value: { status: "legacy-only" } });
    expect(retirement).toEqual({ ok: true, value: { status: "legacy-only" } });
    expect(forged.ok).toBe(false);
    expect(captureCurrentChatInput).toHaveBeenCalledOnce();
    expect(retireCurrentChatInput).toHaveBeenCalledOnce();
    expect(captureCurrentChatInput).toHaveBeenCalledWith(
      submission,
      JSON.stringify(identity),
    );
    expect(profileEgress.issueCallerIdentity).toHaveBeenCalledTimes(3);
  });

  it("does not terminalize a legacy-only result after sender loss", async () => {
    const identity = {
      profileId: "profile-1",
      callerId: "main-caller-1",
      callerEpoch: 2,
      senderId: 42,
      workspaceId: null,
      sessionId: "main-session-1",
    };
    let destroyed = false;
    const captureCurrentChatInput = vi.fn(async () => {
      destroyed = true;
      return JSON.stringify({ status: "unrestricted" });
    });
    const cancelCurrentChatInput = vi.fn();
    registerIpcRouter(
      {
        captureCurrentChatInput,
        cancelCurrentChatInput,
      } as unknown as NapiBackendLike,
      {},
      undefined,
      undefined,
      { active: false },
      {
        restricted: false,
        unavailable: false,
        issueCallerIdentity: vi.fn(() => identity),
        assertInvoke: vi.fn(),
        assertPlaintextPublication: vi.fn(),
        allowsBackendEvent: vi.fn(() => true),
        assertExternalUrl: vi.fn(),
        registerMainEgressParticipant: vi.fn(),
      },
    );

    const envelope = await invokeHandler()(
      { sender: { id: 42, isDestroyed: () => destroyed } },
      "capture_current_chat_input",
      {
        submission: {
          submissionId: "submission-1",
          messageId: "message-1",
          chatSessionId: "chat-session-1",
          sceneId: "scene-1",
          content: "local text",
          createdAt: "2026-09-28T10:00:00.000Z",
        },
      },
    );

    expect(envelope).toEqual({ ok: true, value: { status: "legacy-only" } });
    expect(cancelCurrentChatInput).not.toHaveBeenCalled();
  });

  it("keeps the actual send gate closed if restriction activates after an unrestricted Native result", async () => {
    const identity = {
      profileId: "profile-1",
      callerId: "main-caller-1",
      callerEpoch: 2,
      senderId: 42,
      workspaceId: null,
      sessionId: "main-session-1",
    };
    let restricted = false;
    const sendChatMessage = vi.fn();
    const captureCurrentChatInput = vi.fn(async () => {
      restricted = true;
      return JSON.stringify({ status: "unrestricted" });
    });
    const profileEgress = {
      get restricted() {
        return restricted;
      },
      unavailable: false,
      issueCallerIdentity: vi.fn(() => identity),
      assertInvoke: vi.fn((command: string) => {
        if (restricted && command === "send_chat_message") {
          throw new Error("D2A_EGRESS_DENIED: old-external-ai");
        }
      }),
      assertPlaintextPublication: vi.fn(),
      allowsBackendEvent: vi.fn(() => true),
      assertExternalUrl: vi.fn(),
      registerMainEgressParticipant: vi.fn(),
    };
    registerIpcRouter(
      {
        captureCurrentChatInput,
        sendChatMessage,
      } as unknown as NapiBackendLike,
      {},
      undefined,
      undefined,
      { active: false },
      profileEgress,
    );
    const event = { sender: { id: 42, isDestroyed: () => false } };
    const capture = await invokeHandler()(event, "capture_current_chat_input", {
      submission: {
        submissionId: "submission-1",
        messageId: "message-1",
        chatSessionId: "chat-session-1",
        sceneId: "scene-1",
        content: "local text",
        createdAt: "2026-09-28T10:00:00.000Z",
      },
    });
    const send = await invokeHandler()(event, "send_chat_message", {});

    expect(capture).toEqual({ ok: true, value: { status: "legacy-only" } });
    expect(send).toMatchObject({
      ok: false,
      error: "D2A_EGRESS_DENIED: old-external-ai",
    });
    expect(sendChatMessage).not.toHaveBeenCalled();
    expect(profileEgress.assertInvoke).toHaveBeenCalledTimes(2);
  });

  it("rejects a destroyed sender before Native starts", async () => {
    const captureCurrentChatInput = vi.fn();
    registerIpcRouter({
      captureCurrentChatInput,
    } as unknown as NapiBackendLike);
    const envelope = await invokeHandler()(
      { sender: { id: 42, isDestroyed: () => true } },
      "capture_current_chat_input",
      { submission: {} },
    );

    expect(envelope).toEqual({
      ok: false,
      error: "IPC_CAPTURE_SENDER_DESTROYED: no capture was started",
    });
    expect(captureCurrentChatInput).not.toHaveBeenCalled();
  });

  it("does not acknowledge sender loss, workspace revocation, or Native timeout", async () => {
    const identity = {
      profileId: "profile-1",
      callerId: "main-caller-1",
      callerEpoch: 2,
      senderId: 42,
      workspaceId: "/workspace-1",
      sessionId: "main-session-1",
    };
    const submission = {
      submissionId: "submission-1",
      messageId: "message-1",
      chatSessionId: "chat-session-1",
      sceneId: "scene-1",
      content: "local text",
      createdAt: "2026-09-28T10:00:00.000Z",
    };
    let destroyed = false;
    const captureCurrentChatInput = vi.fn(async () => {
      destroyed = true;
      return JSON.stringify({
        status: "accepted",
        projectId: "project-1",
        chatSessionId: submission.chatSessionId,
        sceneId: submission.sceneId,
        messageId: submission.messageId,
      });
    });
    const cancelCurrentChatInput = vi.fn(async (request) =>
      JSON.stringify({
        status: "cancelled",
        submissionId: request.submissionId,
        messageId: request.messageId,
      }),
    );
    const profileEgress = {
      restricted: true,
      unavailable: false,
      issueCallerIdentity: vi.fn(() => identity),
      assertInvoke: vi
        .fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => {
          throw new Error("caller workspace changed");
        }),
      assertPlaintextPublication: vi.fn(),
      allowsBackendEvent: vi.fn(() => true),
      assertExternalUrl: vi.fn(),
      registerMainEgressParticipant: vi.fn(),
    };
    registerIpcRouter(
      {
        captureCurrentChatInput,
        cancelCurrentChatInput,
      } as unknown as NapiBackendLike,
      {},
      undefined,
      undefined,
      { active: false },
      profileEgress,
    );
    const sender = { id: 42, isDestroyed: () => destroyed };
    const revoked = await invokeHandler()(
      { sender },
      "capture_current_chat_input",
      { submission },
    );
    expect(revoked).toMatchObject({
      ok: false,
      error: expect.stringContaining("IPC_CAPTURE_OUTCOME_UNKNOWN"),
    });
    expect(cancelCurrentChatInput).toHaveBeenCalledWith(
      {
        submissionId: submission.submissionId,
        messageId: submission.messageId,
        chatSessionId: submission.chatSessionId,
        sceneId: submission.sceneId,
      },
      JSON.stringify(identity),
    );

    let authorizationChecks = 0;
    const workspaceCapture = vi.fn(async () =>
      JSON.stringify({
        status: "accepted",
        projectId: "project-1",
        chatSessionId: submission.chatSessionId,
        sceneId: submission.sceneId,
        messageId: submission.messageId,
      }),
    );
    registerIpcRouter(
      {
        captureCurrentChatInput: workspaceCapture,
        cancelCurrentChatInput,
      } as unknown as NapiBackendLike,
      {},
      undefined,
      undefined,
      { active: false },
      {
        ...profileEgress,
        issueCallerIdentity: vi.fn(() => identity),
        assertInvoke: vi.fn(() => {
          authorizationChecks += 1;
          if (authorizationChecks === 2) throw new Error("workspace changed");
        }),
      },
    );
    const workspaceSwitch = await invokeHandler()(
      { sender: { id: 42, isDestroyed: () => false } },
      "capture_current_chat_input",
      { submission },
    );
    expect(workspaceSwitch).toMatchObject({
      ok: false,
      error: expect.stringContaining("IPC_CAPTURE_OUTCOME_UNKNOWN"),
    });
    expect(workspaceCapture).toHaveBeenCalledOnce();
    expect(cancelCurrentChatInput).toHaveBeenCalledTimes(2);

    const timedOut = vi.fn(async () => {
      throw new Error("NIR1_CAPTURE_TRANSACTION_TIMEOUT");
    });
    registerIpcRouter(
      { captureCurrentChatInput: timedOut } as unknown as NapiBackendLike,
      {},
      undefined,
      undefined,
      { active: false },
      {
        ...profileEgress,
        issueCallerIdentity: vi.fn(() => identity),
        assertInvoke: vi.fn(),
      },
    );
    const timeoutResult = await invokeHandler()(
      { sender: { id: 42, isDestroyed: () => false } },
      "capture_current_chat_input",
      { submission },
    );
    expect(timeoutResult).toMatchObject({
      ok: false,
      error: "NIR1_CAPTURE_TRANSACTION_TIMEOUT",
    });
    expect(timedOut).toHaveBeenCalledOnce();
  });

  it("passes a main owner to Native and prevents a second WebContents from copying it", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const relatedScenesBegin = vi.fn(
      async (request: Record<string, unknown>) => {
        calls.push(request);
        return '{"status":"raw-ready"}';
      },
    );
    registerIpcRouter({ relatedScenesBegin } as unknown as NapiBackendLike);
    const createSender = () => ({
      id: 99,
      isDestroyed: () => false,
      once: vi.fn(),
    });
    const first = createSender();
    const payload = {
      expectedWorkspacePath: "/workspace",
      projectId: "p",
      currentSceneId: "s2",
      query: "tail",
      ownerKey: "forged",
    };
    expect(
      (
        await invokeHandler()(
          { sender: first },
          "related_scenes_begin",
          payload,
        )
      ).ok,
    ).toBe(true);
    const owner = calls[0]?.ownerKey;
    expect(owner).not.toBe("forged");
    expect(typeof owner).toBe("string");
    expect(
      (
        await invokeHandler()(
          { sender: createSender() },
          "related_scenes_begin",
          { ...payload, ownerKey: owner },
        )
      ).ok,
    ).toBe(true);
    expect(calls[1]?.ownerKey).not.toBe(owner);
  });
});
