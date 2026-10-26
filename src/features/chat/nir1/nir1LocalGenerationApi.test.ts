import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchInvoke,
  NIR1_LOCAL_MAIN_KEY_VERDICT,
  NIR1_LOCAL_REFUSAL_REASONS,
  type NapiBackendLike,
} from "../../../../electron/shared/ipcContract";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));

import {
  cancelNir1LocalGeneration,
  classifyNir1LocalIpcError,
  continueNir1LocalGeneration,
  createNir1LocalConversation,
  listNir1LocalConversations,
  nir1LocalPurposeOfConversation,
  nir1LocalReasonOf,
  readNir1LocalConversation,
  startNir1LocalGeneration,
} from "./nir1LocalGenerationApi";

// DD-1c (DR-DD1C-3): the renderer sends only DD-1b's argument shapes and
// parses every answer as a closed shape.

const HANDLE = "0123456789abcdef0123456789abcdef";
const CONVERSATION = "nir1-local-writing-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const REVIEW = "nir1-local-review-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const CALLER = {
  profileId: "profile-1",
  callerId: "caller-1",
  callerEpoch: 3,
  senderId: 7,
  workspaceId: "workspace-1",
  sessionId: "session-1",
};

/** Route `invoke` through Main's real validator to a recording backend. */
function throughMain(method: keyof NapiBackendLike, nativeAnswer: unknown) {
  const native = vi.fn().mockResolvedValue(JSON.stringify(nativeAnswer));
  const backend = { [method]: native } as unknown as NapiBackendLike;
  invokeMock.mockImplementation(
    async (command: string, args: Record<string, unknown>) => {
      const dispatched = { ...args };
      Object.defineProperty(dispatched, "callerIdentity", {
        value: CALLER,
        enumerable: false,
      });
      Object.defineProperty(dispatched, NIR1_LOCAL_MAIN_KEY_VERDICT, {
        value: { endpointId: "local-1", keyVerdict: "absent" },
        enumerable: false,
      });
      const envelope = await dispatchInvoke(command, dispatched, {
        backend,
        shell: {} as never,
      });
      if (envelope.ok) return envelope.value;
      throw new Error(envelope.error);
    },
  );
  return native;
}

function answer(value: unknown) {
  invokeMock.mockResolvedValue(value);
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("the local generation wrapper through Main's validator (DR-DD1B-2)", () => {
  it("start sends the exact intent and returns the opaque handle", async () => {
    const native = throughMain("nir1LocalGenerationStart", {
      status: "started",
      handle: HANDLE,
    });
    await expect(
      startNir1LocalGeneration({
        purpose: "writing",
        conversationId: CONVERSATION,
        sceneId: "scene-1",
      }),
    ).resolves.toEqual({ status: "started", handle: HANDLE });
    expect(invokeMock).toHaveBeenCalledWith("nir1_local_generation_start", {
      purpose: "writing",
      conversationId: CONVERSATION,
      sceneId: "scene-1",
    });
    expect(native.mock.calls[0][0]).toEqual({
      purpose: "writing",
      conversationId: CONVERSATION,
      sceneId: "scene-1",
    });
  });

  it("continue and cancel send the handle only", async () => {
    const native = throughMain("nir1LocalGenerationContinue", {
      status: "ok",
      text: "本文",
      thinking: "",
      state: "running",
      drained: false,
    });
    await expect(continueNir1LocalGeneration(HANDLE)).resolves.toEqual({
      status: "ok",
      text: "本文",
      thinking: "",
      state: "running",
      terminalCode: null,
      drained: false,
    });
    expect(native.mock.calls[0][0]).toEqual({ handle: HANDLE });

    const cancel = throughMain("nir1LocalGenerationCancel", { status: "ok" });
    await expect(cancelNir1LocalGeneration(HANDLE)).resolves.toEqual({
      status: "ok",
    });
    expect(invokeMock).toHaveBeenLastCalledWith(
      "nir1_local_generation_cancel",
      { handle: HANDLE },
    );
    expect(cancel.mock.calls[0][0]).toEqual({ handle: HANDLE });
  });

  it("create, list and read pass Main's checks unchanged", async () => {
    const view = {
      conversationId: CONVERSATION,
      displayName: { purpose: "writing", createdAt: "2026-10-26T01:02:03Z" },
    };
    throughMain("nir1LocalConversationCreate", { status: "created", ...view });
    await expect(
      createNir1LocalConversation({ purpose: "writing", sceneId: "scene-1" }),
    ).resolves.toEqual({
      status: "created",
      conversation: {
        conversationId: CONVERSATION,
        purpose: "writing",
        createdAt: "2026-10-26T01:02:03Z",
      },
    });
    expect(invokeMock).toHaveBeenLastCalledWith(
      "nir1_local_conversation_create",
      { purpose: "writing", sceneId: "scene-1" },
    );

    throughMain("nir1LocalConversationList", {
      status: "ok",
      conversations: [view],
      truncated: false,
    });
    await expect(listNir1LocalConversations()).resolves.toEqual({
      status: "ok",
      conversations: [
        {
          conversationId: CONVERSATION,
          purpose: "writing",
          createdAt: "2026-10-26T01:02:03Z",
        },
      ],
      truncated: false,
    });
    expect(invokeMock).toHaveBeenLastCalledWith(
      "nir1_local_conversation_list",
      {},
    );

    const read = throughMain("nir1LocalConversationRead", {
      status: "ok",
      purpose: "writing",
      rows: [
        {
          messageId: "m1",
          kind: "input",
          createdAtMs: 1,
          text: "入力",
        },
        {
          messageId: "m2",
          kind: "output",
          createdAtMs: 2,
          text: "出力",
          thinking: [{ type: "thinking" }],
          attemptStatus: "succeeded",
        },
        {
          messageId: "m3",
          kind: "output",
          createdAtMs: 3,
          unavailable: "stale",
        },
      ],
      total: 3,
      truncated: false,
    });
    const result = await readNir1LocalConversation({
      conversationId: CONVERSATION,
      offset: 0,
      limit: 64,
    });
    expect(read.mock.calls[0][0]).toEqual({
      conversationId: CONVERSATION,
      offset: 0,
      limit: 64,
    });
    // Every returned row stays, the one Native could not verify included.
    expect(result).toEqual({
      status: "ok",
      purpose: "writing",
      rows: [
        {
          messageId: "m1",
          kind: "input",
          createdAtMs: 1,
          text: "入力",
          thinkingCount: 0,
          attemptStatus: null,
          unavailable: null,
        },
        {
          messageId: "m2",
          kind: "output",
          createdAtMs: 2,
          text: "出力",
          thinkingCount: 1,
          attemptStatus: "succeeded",
          unavailable: null,
        },
        {
          messageId: "m3",
          kind: "output",
          createdAtMs: 3,
          text: null,
          thinkingCount: 0,
          attemptStatus: null,
          unavailable: "stale",
        },
      ],
      total: 3,
      truncated: false,
    });
  });

  it("returns Main's typed refusals with the closed reason", async () => {
    throughMain("nir1LocalGenerationStart", {
      status: "unavailable",
      reason: "NIR1_LOCAL_POLICY_UNREADABLE",
    });
    await expect(
      startNir1LocalGeneration({
        purpose: "review",
        conversationId: REVIEW,
        sceneId: "scene-1",
      }),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "NIR1_LOCAL_POLICY_UNREADABLE",
    });
  });
});

describe("requests the renderer refuses without IPC", () => {
  it.each([
    [
      "an unknown purpose",
      () =>
        startNir1LocalGeneration({
          purpose: "chat" as never,
          conversationId: CONVERSATION,
          sceneId: "s",
        }),
    ],
    [
      "an untrimmed scene",
      () =>
        startNir1LocalGeneration({
          purpose: "writing",
          conversationId: CONVERSATION,
          sceneId: " s",
        }),
    ],
    [
      "a control character",
      () =>
        createNir1LocalConversation({ purpose: "writing", sceneId: "a\u0007" }),
    ],
    [
      "an over-long id",
      () =>
        createNir1LocalConversation({
          purpose: "writing",
          sceneId: "あ".repeat(86),
        }),
    ],
    ["a malformed handle", () => continueNir1LocalGeneration("XYZ")],
    [
      "an upper-case handle",
      () => cancelNir1LocalGeneration(HANDLE.toUpperCase()),
    ],
    [
      "a limit over 64",
      () =>
        readNir1LocalConversation({
          conversationId: CONVERSATION,
          offset: 0,
          limit: 65,
        }),
    ],
    [
      "a zero limit",
      () =>
        readNir1LocalConversation({
          conversationId: CONVERSATION,
          offset: 0,
          limit: 0,
        }),
    ],
    [
      "a negative offset",
      () =>
        readNir1LocalConversation({
          conversationId: CONVERSATION,
          offset: -1,
          limit: 1,
        }),
    ],
    [
      "an offset over u32",
      () =>
        readNir1LocalConversation({
          conversationId: CONVERSATION,
          offset: 2 ** 32,
          limit: 1,
        }),
    ],
  ])("%s", async (_label, request) => {
    await expect(request()).resolves.toEqual({
      status: "error",
      error: "invalid-request",
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("accepts the boundaries", async () => {
    answer({
      status: "ok",
      purpose: "writing",
      rows: [],
      total: 0,
      truncated: false,
    });
    await readNir1LocalConversation({
      conversationId: CONVERSATION,
      offset: 0xffff_ffff,
      limit: 64,
    });
    await createNir1LocalConversation({
      purpose: "writing",
      sceneId: "a".repeat(256),
    });
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});

describe("closed parsing of the answers", () => {
  it("turns an unknown status into the typed unknown", async () => {
    answer({ status: "paused" });
    await expect(continueNir1LocalGeneration(HANDLE)).resolves.toEqual({
      status: "unknown",
    });
    answer({ status: "queued", handle: HANDLE });
    await expect(
      startNir1LocalGeneration({
        purpose: "writing",
        conversationId: CONVERSATION,
        sceneId: "s",
      }),
    ).resolves.toEqual({ status: "unknown" });
    answer({ status: "ok", rows: [] });
    await expect(
      createNir1LocalConversation({ purpose: "writing", sceneId: "s" }),
    ).resolves.toEqual({ status: "unknown" });
  });

  it("turns a reason outside the closed list into unknown", async () => {
    answer({ status: "refused", reason: "Something went wrong: /home/x" });
    await expect(cancelNir1LocalGeneration(HANDLE)).resolves.toEqual({
      status: "refused",
      reason: "unknown",
    });
    expect(nir1LocalReasonOf("NIR1_LOCAL_SESSION_BUSY")).toBe(
      "NIR1_LOCAL_SESSION_BUSY",
    );
    expect(nir1LocalReasonOf(42)).toBe("unknown");
    for (const reason of NIR1_LOCAL_REFUSAL_REASONS) {
      expect(nir1LocalReasonOf(reason)).toBe(reason);
    }
  });

  it.each([
    ["an extra key", { status: "started", handle: HANDLE, text: "x" }],
    ["a non-hex handle", { status: "started", handle: "z".repeat(32) }],
    [
      "a refusal with an extra key",
      { status: "unavailable", reason: "NIR1_LOCAL_GATE_CLOSED", detail: "x" },
    ],
    ["no status", { handle: HANDLE }],
    ["not an object", "started"],
  ])("rejects a start answer with %s", async (_label, value) => {
    answer(value);
    await expect(
      startNir1LocalGeneration({
        purpose: "writing",
        conversationId: CONVERSATION,
        sceneId: "s",
      }),
    ).resolves.toEqual({ status: "error", error: "invalid-result" });
  });

  it.each([
    ["a text over 64 KiB", { text: "a".repeat(64 * 1024 + 1), thinking: "" }],
    [
      "a thinking over 64 KiB (UTF-8)",
      { text: "", thinking: "あ".repeat(21846) },
    ],
    ["an unknown state", { state: "paused" }],
    ["a free-text reason", { reason: "Error: socket closed" }],
    ["a non-boolean drained", { drained: "yes" }],
    ["an extra key", { messages: [] }],
  ])("rejects a continue answer with %s", async (_label, patch) => {
    answer({
      status: "ok",
      text: "",
      thinking: "",
      state: "running",
      drained: false,
      ...patch,
    });
    await expect(continueNir1LocalGeneration(HANDLE)).resolves.toEqual({
      status: "error",
      error: "invalid-result",
    });
  });

  it("keeps a closed terminal word as a code, not as text", async () => {
    answer({
      status: "ok",
      text: "",
      thinking: "",
      state: "failed",
      reason: "starter-ended",
      drained: true,
    });
    await expect(continueNir1LocalGeneration(HANDLE)).resolves.toMatchObject({
      state: "failed",
      terminalCode: "starter-ended",
      drained: true,
    });
  });

  it("accepts a 64 KiB delta exactly", async () => {
    answer({
      status: "ok",
      text: "a".repeat(64 * 1024),
      thinking: "",
      state: "running",
      drained: false,
    });
    await expect(continueNir1LocalGeneration(HANDLE)).resolves.toMatchObject({
      status: "ok",
    });
  });

  it("uses only the conversation ID of the answer and checks its purpose", async () => {
    answer({
      status: "created",
      conversationId: REVIEW,
      displayName: { purpose: "review", createdAt: null },
    });
    await expect(
      createNir1LocalConversation({ purpose: "writing", sceneId: "s" }),
    ).resolves.toEqual({ status: "error", error: "invalid-result" });
    answer({
      status: "created",
      conversationId: "chat-session-1",
      displayName: { purpose: "writing", createdAt: null },
    });
    await expect(
      createNir1LocalConversation({ purpose: "writing", sceneId: "s" }),
    ).resolves.toEqual({ status: "error", error: "invalid-result" });
    answer({
      status: "created",
      conversationId: CONVERSATION,
      displayName: { purpose: "writing", createdAt: "yesterday" },
    });
    await expect(
      createNir1LocalConversation({ purpose: "writing", sceneId: "s" }),
    ).resolves.toEqual({ status: "error", error: "invalid-result" });
  });

  it.each([
    [
      "more rows than the limit",
      {
        rows: [
          { messageId: "m", kind: "input", createdAtMs: 1, text: "a" },
          { messageId: "n", kind: "input", createdAtMs: 1, text: "b" },
        ],
      },
    ],
    [
      "an unknown row field",
      {
        rows: [
          {
            messageId: "m",
            kind: "input",
            createdAtMs: 1,
            text: "a",
            role: "system",
          },
        ],
      },
    ],
    [
      "a system row",
      { rows: [{ messageId: "m", kind: "system", createdAtMs: 1, text: "a" }] },
    ],
    [
      "thinking on an input",
      {
        rows: [
          {
            messageId: "m",
            kind: "input",
            createdAtMs: 1,
            text: "a",
            thinking: [],
          },
        ],
      },
    ],
    [
      "content on an unavailable row",
      {
        rows: [
          {
            messageId: "m",
            kind: "output",
            createdAtMs: 1,
            text: "a",
            unavailable: "stale",
          },
        ],
      },
    ],
    ["a negative total", { total: -1 }],
    ["an unknown purpose", { purpose: "chat" }],
  ])("rejects a read answer with %s", async (_label, patch) => {
    answer({
      status: "ok",
      purpose: "writing",
      rows: [],
      total: 0,
      truncated: false,
      ...patch,
    });
    await expect(
      readNir1LocalConversation({
        conversationId: CONVERSATION,
        offset: 0,
        limit: 1,
      }),
    ).resolves.toEqual({ status: "error", error: "invalid-result" });
  });

  it("classifies a thrown failure without keeping its text", async () => {
    invokeMock.mockRejectedValue(
      new Error(
        "D2A_EGRESS_DENIED: nir1-restricted-only: route nir1_local_conversation_list is unavailable",
      ),
    );
    const denied = await listNir1LocalConversations();
    expect(denied).toEqual({ status: "error", error: "egress-denied" });
    expect(JSON.stringify(denied)).not.toContain("route");

    expect(
      classifyNir1LocalIpcError(
        new Error("invalid result for command `x`: delta"),
      ),
    ).toBe("invalid-result");
    expect(
      classifyNir1LocalIpcError(new Error("invalid args `handle` for command")),
    ).toBe("invalid-request");
    expect(
      classifyNir1LocalIpcError(
        new Error("IPC_NIR1_LOCAL_CALLER_IDENTITY_REQUIRED: missing"),
      ),
    ).toBe("invalid-request");
    expect(classifyNir1LocalIpcError("boom /home/user/secret")).toBe("failed");
    // Held before Main by the frozen audit export (review fix 2).
    expect(
      classifyNir1LocalIpcError(
        Object.assign(new Error("held"), { code: "IPC_MUTATION_CANCELLED" }),
      ),
    ).toBe("held");
    expect(
      classifyNir1LocalIpcError(
        new Error(
          "IPC_MUTATION_CANCELLED: mutation blocked during frozen AI audit export: nir1_local_generation_continue",
        ),
      ),
    ).toBe("held");
  });
});

describe("conversation ID marks", () => {
  it("reads the purpose from Native's mark only", () => {
    expect(nir1LocalPurposeOfConversation(CONVERSATION)).toBe("writing");
    expect(nir1LocalPurposeOfConversation(REVIEW)).toBe("review");
    expect(nir1LocalPurposeOfConversation("chat-1")).toBeNull();
    expect(nir1LocalPurposeOfConversation(`${CONVERSATION}-x`)).toBeNull();
    expect(nir1LocalPurposeOfConversation(null)).toBeNull();
  });
});
