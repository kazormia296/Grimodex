import { afterEach, describe, expect, it, vi } from "vitest";

import {
  captureChatContextPreparationSnapshot,
  isChatContextPreparationAuthorityCurrent,
  prepareChatContext,
  registerChatContextPreparation,
  type ChatContextPreparationInput,
  type ChatContextPreparationPort,
  type PreparedChatContext,
} from "./chatContextPreparation";

const input = (): ChatContextPreparationInput => ({
  requestId: "request-1",
  purpose: "send",
  privacy: "private",
  projectId: "project-1",
  sessionId: "session-1",
  effectiveSceneId: "scene-1",
  activeSceneId: "scene-1",
  activeProjectId: "project-1",
  chatScope: "scene",
  scopeAnchorId: null,
  threadFocus: null,
  mode: "chat",
  agentToolsAvailable: false,
  route: null,
  budget: { contextWindow: 16_384, deliveryMode: "plain" },
  messages: [
    {
      id: "message-1",
      sessionId: "session-1",
      role: "user",
      content: "hello",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  outgoingUserMessage: "hello",
  mentionedSceneIds: ["scene-2"],
  mentionedCodexIds: ["codex-1"],
  inputPinnedEntryIds: [],
  excludedAutoEntryIds: [],
  sessionStableCodexIds: [],
  sessionStableContextInitialized: false,
  includeBodies: true,
  includeMapBoard: false,
  mapBoardId: null,
  trackRecallPromote: true,
  allowSceneRecallSeedFallback: false,
});

const result = (): PreparedChatContext =>
  ({
    privacy: "private",
    prompt: "prompt",
    totalTokens: 1,
    layers: [],
    contextPlan: {
      requestId: "request-1",
      items: [],
      decisions: [],
      usage: {
        candidateTokens: 0,
        selectedTokens: 0,
        trimmedTokens: 0,
        budgetTokens: null,
      },
      digest: "ctx-test",
    },
    detectedEntries: [],
    alwaysEntries: [],
    fullyInjectedIds: [],
    stableContextIds: [],
    recalledMessages: [],
    scopeAnchor: null,
    projectOutline: undefined,
    chapterOutlines: [],
    authority: { chronicleRevision: 1 },
  }) as PreparedChatContext;

let restoreRegistration: (() => void) | null = null;

afterEach(() => {
  restoreRegistration?.();
  restoreRegistration = null;
});

describe("chatContextPreparation", () => {
  it("deep-snapshots the input before invoking the registered port", async () => {
    const prepare = vi.fn(async (captured: ChatContextPreparationInput) => {
      expect(Object.isFrozen(captured)).toBe(true);
      expect(Object.isFrozen(captured.messages)).toBe(true);
      expect(Object.isFrozen(captured.messages[0])).toBe(true);
      expect(Object.isFrozen(captured.mentionedSceneIds)).toBe(true);
      return result();
    });
    const port: ChatContextPreparationPort = {
      prepare,
      isAuthorityCurrent: () => true,
    };
    restoreRegistration = registerChatContextPreparation(port);
    const mutable = input();

    const preparing = prepareChatContext(mutable);
    (mutable.messages[0] as { content: string }).content = "changed";
    (mutable.mentionedSceneIds as string[]).push("scene-3");
    await preparing;

    expect(prepare.mock.calls[0]?.[0].messages[0]?.content).toBe("hello");
    expect(prepare.mock.calls[0]?.[0].mentionedSceneIds).toEqual(["scene-2"]);
  });

  it("delegates opaque authority checks to the same registered port", () => {
    const isAuthorityCurrent = vi.fn(() => false);
    restoreRegistration = registerChatContextPreparation({
      prepare: async () => result(),
      isAuthorityCurrent,
    });
    const authority = { chronicleRevision: 4 };

    expect(isChatContextPreparationAuthorityCurrent(authority)).toBe(false);
    expect(isAuthorityCurrent).toHaveBeenCalledWith(authority);
  });

  it("routes live, preview, copy, send, and Agent initial through one registered prepare entrypoint", async () => {
    const prepare = vi.fn(async (_input: ChatContextPreparationInput) =>
      result(),
    );
    restoreRegistration = registerChatContextPreparation({
      prepare,
      isAuthorityCurrent: () => true,
    });
    const surfaces = [
      { label: "live", purpose: "live", mode: "chat" },
      { label: "preview", purpose: "preview", mode: "chat" },
      { label: "copy", purpose: "copy", mode: "chat" },
      { label: "send", purpose: "send", mode: "chat" },
      { label: "Agent initial", purpose: "send", mode: "agent" },
    ] as const;

    for (const surface of surfaces) {
      await prepareChatContext({
        ...input(),
        requestId: "surface-parity-request",
        purpose: surface.purpose,
        mode: surface.mode,
      });
    }

    expect(prepare).toHaveBeenCalledTimes(surfaces.length);
    expect(
      prepare.mock.calls.map(([captured]) => ({
        requestId: captured.requestId,
        purpose: captured.purpose,
        mode: captured.mode,
        projectId: captured.projectId,
        sceneId: captured.effectiveSceneId,
        outgoing: captured.outgoingUserMessage,
      })),
    ).toEqual(
      surfaces.map((surface) => ({
        requestId: "surface-parity-request",
        purpose: surface.purpose,
        mode: surface.mode,
        projectId: "project-1",
        sceneId: "scene-1",
        outgoing: "hello",
      })),
    );
  });

  it("captures and reuses an opaque snapshot through the registered port", async () => {
    const snapshot = { value: { captured: true } };
    const capture = vi.fn(() => snapshot);
    const prepare = vi.fn(async () => result());
    restoreRegistration = registerChatContextPreparation({
      capture,
      prepare,
      isAuthorityCurrent: () => true,
    });
    const request = input();
    const captured = captureChatContextPreparationSnapshot({
      privacy: request.privacy,
      projectId: request.projectId,
      effectiveSceneId: request.effectiveSceneId,
      activeSceneId: request.activeSceneId,
      activeProjectId: request.activeProjectId,
      chatScope: request.chatScope,
      scopeAnchorId: request.scopeAnchorId,
      threadFocus: request.threadFocus,
      includeMapBoard: request.includeMapBoard,
      mapBoardId: request.mapBoardId,
    });

    await prepareChatContext(request, captured);

    expect(capture).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledWith(expect.any(Object), snapshot);
  });
});
