import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { getSchema } from "@tiptap/core";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";

import type { Envelope, NapiBackendLike } from "../shared/ipcContract.js";
import { IPC } from "../shared/ipcContract.js";

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
    expect(
      (bound.payload as { authorityRoute?: string }).authorityRoute,
    ).toBe("interactive-agent-command");

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
});

describe("registerIpcRouter workspace-open main trace", () => {
  function backendWithOpenWorkspace(
    openWorkspace: (path: string) => Promise<string>,
  ): NapiBackendLike {
    return { openWorkspace } as unknown as NapiBackendLike;
  }

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
