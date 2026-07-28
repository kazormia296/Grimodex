import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/db/schema", () => ({
  chatSessions: {
    id: "id",
    nodeId: "nodeId",
    codexAnchorId: "codexAnchorId",
    snippetAnchorId: "snippetAnchorId",
    updatedAt: "updatedAt",
    projectId: "projectId",
  },
  chatMessages: { id: "id", sessionId: "sessionId", createdAt: "createdAt" },
  chatMessagePrompts: { messageId: "messageId" },
  codexEntries: { id: "id" },
  chatSessionPinnedCodex: {
    sessionId: "sessionId",
    codexEntryId: "codexEntryId",
    snippetId: "snippetId",
    stickyId: "stickyId",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  desc: vi.fn((col: unknown) => ({ desc: col })),
  inArray: vi.fn((...args: unknown[]) => ({ inArray: args })),
  isNull: vi.fn((col: unknown) => ({ isNull: col })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  isNotNull: vi.fn((col: unknown) => ({ isNotNull: col })),
  asc: vi.fn((col: unknown) => ({ asc: col })),
}));

vi.mock("@/features/semantic-search/scheduler", () => ({
  scheduleChatIndex: vi.fn(),
}));

import { db } from "@/db/client";
const mockDb = vi.mocked(db);
import { scheduleChatIndex } from "@/features/semantic-search/scheduler";
const mockScheduleChatIndex = vi.mocked(scheduleChatIndex);

import {
  listSessions,
  getSessionForProject,
  createSession,
  deleteSession,
  listMessages,
  addMessage,
  updateSessionTitle,
  unpinStickyEntry,
  saveMessagePrompt,
  getMessagePrompt,
  pinCodexEntry,
} from "./chatApi";
import type { ChatSession } from "./chatTypes";

// Helper to set up chained drizzle query mock
function mockSelectChain(rows: Record<string, unknown>[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockResolvedValue(rows),
  };
  mockDb.select.mockReturnValue(chain as never);
  return chain;
}

function mockInsertChain(rows: Record<string, unknown>[]) {
  const chain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(rows),
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
  };
  mockDb.insert.mockReturnValue(chain as never);
  return chain;
}

function mockSelectLimitChain(rows: Record<string, unknown>[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  mockDb.select.mockReturnValue(chain as never);
  return chain;
}

function mockUpdateChain() {
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  mockDb.update.mockReturnValue(chain as never);
  return chain;
}

function mockDeleteChain() {
  const chain = {
    where: vi.fn().mockResolvedValue(undefined),
  };
  mockDb.delete.mockReturnValue(chain as never);
  return chain;
}

describe("chatApi - session/message persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("pinCodexEntry", () => {
    it("promotes a legacy chat mention row when Spotlight is selected", async () => {
      const chain = mockInsertChain([]);

      await pinCodexEntry("session-1", "entry-1", false, "manual", "codex");

      expect(chain.onConflictDoUpdate).toHaveBeenCalledWith({
        target: ["sessionId", "codexEntryId"],
        targetWhere: { isNotNull: "codexEntryId" },
        set: { pinSource: "manual", withChildren: 0 },
      });
      expect(chain.onConflictDoNothing).not.toHaveBeenCalled();
    });

    it("matches the partial snippet pin index when promoting Spotlight", async () => {
      const chain = mockInsertChain([]);

      await pinCodexEntry("session-1", "snippet-1", true, "manual", "snippet");

      expect(chain.onConflictDoUpdate).toHaveBeenCalledWith({
        target: ["sessionId", "snippetId"],
        targetWhere: { isNotNull: "snippetId" },
        set: { pinSource: "manual", withChildren: 1 },
      });
    });
  });

  describe("listSessions", () => {
    it("returns sessions for a given nodeId", async () => {
      const session: ChatSession = {
        id: "session-1",
        projectId: "proj-1",
        nodeId: "node-abc",
        codexAnchorId: null,
        snippetAnchorId: null,
        title: "会話1",
        titleManual: 0,
        model: "openrouter/anthropic/claude-sonnet-4.6",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      };
      mockSelectChain([session as unknown as Record<string, unknown>]);

      const result = await listSessions("proj-1", "node-abc");

      expect(mockDb.select).toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("session-1");
      expect(result[0].nodeId).toBe("node-abc");
    });

    it("returns all sessions when no nodeId given", async () => {
      mockSelectChain([]);
      const result = await listSessions("proj-1");
      expect(result).toHaveLength(0);
    });

    it("returns project-scope sessions when nodeId is null", async () => {
      const session: ChatSession = {
        id: "session-proj",
        projectId: "proj-1",
        nodeId: null,
        codexAnchorId: null,
        snippetAnchorId: null,
        title: "プロジェクト会話",
        titleManual: 0,
        model: "openrouter/anthropic/claude-sonnet-4.6",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      };
      mockSelectChain([session as unknown as Record<string, unknown>]);

      const result = await listSessions("proj-1", null);

      expect(mockDb.select).toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].nodeId).toBeNull();
    });

    it("project scope (nodeId=null) excludes codex- and snippet-anchored sessions", async () => {
      const { isNull } = await import("drizzle-orm");
      mockSelectChain([]);

      await listSessions("proj-1", null);

      const isNullCols = vi.mocked(isNull).mock.calls.map((c) => c[0]);
      expect(isNullCols).toContain("codexAnchorId");
      expect(isNullCols).toContain("snippetAnchorId");
    });

    it("returns snippet-anchored sessions when snippetAnchorId given", async () => {
      const session: ChatSession = {
        id: "session-snip",
        projectId: "proj-1",
        nodeId: null,
        codexAnchorId: null,
        snippetAnchorId: "snip-1",
        title: "Snippet 会話",
        titleManual: 0,
        model: "openrouter/anthropic/claude-sonnet-4.6",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      };
      mockSelectChain([session as unknown as Record<string, unknown>]);

      const result = await listSessions(
        "proj-1",
        undefined,
        undefined,
        "snip-1",
      );

      expect(mockDb.select).toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].snippetAnchorId).toBe("snip-1");
    });
  });

  describe("getSessionForProject", () => {
    const session: ChatSession = {
      id: "session-1",
      projectId: "proj-1",
      nodeId: "node-1",
      codexAnchorId: null,
      snippetAnchorId: null,
      title: "会話1",
      titleManual: 0,
      model: "openrouter/anthropic/claude-sonnet-4.6",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };

    it("constrains the lookup by both session and project authority", async () => {
      const { eq, and } = await import("drizzle-orm");
      const chain = mockSelectLimitChain([
        session as unknown as Record<string, unknown>,
      ]);

      const result = await getSessionForProject("session-1", "proj-1");

      expect(vi.mocked(eq)).toHaveBeenNthCalledWith(1, "id", "session-1");
      expect(vi.mocked(eq)).toHaveBeenNthCalledWith(2, "projectId", "proj-1");
      expect(vi.mocked(and)).toHaveBeenCalledWith(
        { eq: ["id", "session-1"] },
        { eq: ["projectId", "proj-1"] },
      );
      expect(chain.limit).toHaveBeenCalledWith(1);
      expect(result).toEqual(session);
    });

    it("returns null when no session belongs to the project", async () => {
      mockSelectLimitChain([]);

      await expect(
        getSessionForProject("missing-session", "proj-1"),
      ).resolves.toBeNull();
    });

    it("rejects a mismatched row defensively", async () => {
      mockSelectLimitChain([
        { ...session, projectId: "proj-2" } as unknown as Record<
          string,
          unknown
        >,
      ]);

      await expect(
        getSessionForProject("session-1", "proj-1"),
      ).resolves.toBeNull();
    });
  });

  describe("createSession", () => {
    it("creates a session and returns it", async () => {
      const row = {
        id: "new-session-id",
        projectId: "proj-1",
        nodeId: "node-1",
        codexAnchorId: null,
        snippetAnchorId: null,
        title: "新しい会話",
        titleManual: 0,
        model: "openrouter/anthropic/claude-sonnet-4.6",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      };
      const chain = mockInsertChain([row]);

      const result = await createSession("proj-1", "新しい会話", "node-1");

      expect(mockDb.insert).toHaveBeenCalled();
      const values = vi.mocked(chain.values).mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(values).not.toHaveProperty("model");
      expect(result.title).toBe("新しい会話");
      expect(result.nodeId).toBe("node-1");
      expect(result.projectId).toBe("proj-1");
    });

    it("creates a session without nodeId", async () => {
      const row = {
        id: "session-no-node",
        projectId: "proj-1",
        nodeId: null,
        codexAnchorId: null,
        snippetAnchorId: null,
        title: "フリー会話",
        titleManual: 0,
        model: "openrouter/anthropic/claude-sonnet-4.6",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      };
      mockInsertChain([row]);

      const result = await createSession("proj-1", "フリー会話");
      expect(result.nodeId).toBeNull();
    });

    it("persists an explicit empty model instead of using the database default", async () => {
      const row = {
        id: "web-session",
        projectId: "proj-1",
        nodeId: null,
        codexAnchorId: null,
        snippetAnchorId: null,
        title: "Web session",
        titleManual: 0,
        model: "",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      };
      const chain = mockInsertChain([row]);

      await createSession(
        "proj-1",
        "Web session",
        undefined,
        undefined,
        undefined,
        "",
      );

      const values = vi.mocked(chain.values).mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(values).toHaveProperty("model", "");
    });

    it("creates a snippet-anchored session", async () => {
      const row = {
        id: "session-snip",
        projectId: "proj-1",
        nodeId: null,
        codexAnchorId: null,
        snippetAnchorId: "snip-1",
        title: "Snippet 会話",
        titleManual: 0,
        model: "openrouter/anthropic/claude-sonnet-4.6",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      };
      const chain = mockInsertChain([row]);

      const result = await createSession(
        "proj-1",
        "Snippet 会話",
        undefined,
        undefined,
        "snip-1",
      );

      expect(result.snippetAnchorId).toBe("snip-1");
      const values = vi.mocked(chain.values).mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(values.snippetAnchorId).toBe("snip-1");
      expect(values.codexAnchorId).toBeNull();
    });
  });

  describe("deleteSession", () => {
    it("deletes a session by id", async () => {
      mockDeleteChain();

      await deleteSession("session-1");

      expect(mockDb.delete).toHaveBeenCalled();
    });
  });

  describe("listMessages", () => {
    it("returns messages for a session ordered by createdAt", async () => {
      mockSelectChain([
        {
          id: "msg-1",
          sessionId: "session-1",
          role: "user",
          content: "こんにちは",
          model: null,
          tokensIn: null,
          tokensOut: null,
          durationMs: null,
          metadata: null,
          createdAt: "2025-01-01T00:00:00Z",
        },
        {
          id: "msg-2",
          sessionId: "session-1",
          role: "assistant",
          content: "こんにちは！",
          model: null,
          tokensIn: null,
          tokensOut: null,
          durationMs: null,
          metadata: null,
          createdAt: "2025-01-01T00:00:01Z",
        },
      ]);

      const result = await listMessages("session-1");

      expect(result).toHaveLength(2);
      expect(result[0].role).toBe("user");
      expect(result[1].role).toBe("assistant");
    });

    it("returns empty array for session with no messages", async () => {
      mockSelectChain([]);
      const result = await listMessages("empty-session");
      expect(result).toEqual([]);
    });
  });

  describe("addMessage", () => {
    it("inserts a message and returns it", async () => {
      // Mock insert for message
      mockInsertChain([
        {
          id: "msg-new",
          sessionId: "session-1",
          role: "user",
          content: "テストメッセージ",
          model: null,
          tokensIn: null,
          tokensOut: null,
          durationMs: null,
          metadata: null,
          createdAt: "2025-01-01T00:00:00Z",
        },
      ]);
      // Mock update for session updatedAt
      mockUpdateChain();

      const result = await addMessage("session-1", "user", "テストメッセージ");

      expect(result.sessionId).toBe("session-1");
      expect(result.role).toBe("user");
      expect(result.content).toBe("テストメッセージ");
    });

    it("schedules episodic index for a non-empty user/assistant message", async () => {
      mockScheduleChatIndex.mockClear();
      mockInsertChain([{ id: "msg-x", sessionId: "s1", role: "assistant" }]);
      mockUpdateChain();
      await addMessage("s1", "assistant", "覚えておくべき発言", {
        id: "msg-x",
      });
      expect(mockScheduleChatIndex).toHaveBeenCalledWith("msg-x");
    });

    it("does NOT schedule episodic index for system or empty messages", async () => {
      mockScheduleChatIndex.mockClear();
      mockInsertChain([{ id: "sys", sessionId: "s1", role: "system" }]);
      mockUpdateChain();
      await addMessage("s1", "system", "internal", { id: "sys" });
      expect(mockScheduleChatIndex).not.toHaveBeenCalled();

      mockInsertChain([{ id: "blank", sessionId: "s1", role: "user" }]);
      mockUpdateChain();
      await addMessage("s1", "user", "   ", { id: "blank" });
      expect(mockScheduleChatIndex).not.toHaveBeenCalled();
    });
  });

  describe("updateSessionTitle", () => {
    it("updates the session title", async () => {
      mockUpdateChain();

      await updateSessionTitle("session-1", "新しいタイトル");

      expect(mockDb.update).toHaveBeenCalled();
    });
  });

  describe("unpinStickyEntry", () => {
    it("deletes sticky pin row for the session", async () => {
      mockDeleteChain();

      await unpinStickyEntry("session-1", "sticky-abc");

      expect(mockDb.delete).toHaveBeenCalled();
    });
  });
});

describe("chatApi - message prompt snapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saveMessagePrompt upserts the snapshot keyed to the message id", async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
    mockDb.insert.mockReturnValue({ values } as never);

    await saveMessagePrompt("msg-1", {
      systemPrompt: "SYSTEM PROMPT BODY",
      layers: [{ layer: "L1", label: "Project", used: 10 } as never],
      totalTokens: 42,
      model: "openrouter/anthropic/claude-sonnet-4.6",
    });

    expect(mockDb.insert).toHaveBeenCalled();
    const inserted = values.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.messageId).toBe("msg-1");
    expect(inserted.systemPrompt).toBe("SYSTEM PROMPT BODY");
    expect(inserted.totalTokens).toBe(42);
    expect(JSON.parse(inserted.layers as string)).toHaveLength(1);
    // 同一メッセージの再送で最新内容に上書きされる (upsert) こと。
    expect(onConflictDoUpdate).toHaveBeenCalled();
    const conflictArg = onConflictDoUpdate.mock.calls[0][0] as {
      set: Record<string, unknown>;
    };
    expect(conflictArg.set.systemPrompt).toBe("SYSTEM PROMPT BODY");
  });

  it("getMessagePrompt returns the parsed snapshot", async () => {
    const where = vi.fn().mockResolvedValue([
      {
        messageId: "msg-1",
        systemPrompt: "BODY",
        layers: JSON.stringify([{ layer: "L1", label: "Project", used: 5 }]),
        totalTokens: 7,
        model: "m",
      },
    ]);
    const from = vi.fn().mockReturnValue({ where });
    mockDb.select.mockReturnValue({ from } as never);

    const snap = await getMessagePrompt("msg-1");
    expect(snap).not.toBeNull();
    expect(snap?.systemPrompt).toBe("BODY");
    expect(snap?.layers).toHaveLength(1);
    expect(snap?.totalTokens).toBe(7);
    expect(snap?.model).toBe("m");
  });

  it("getMessagePrompt returns null for an unrecorded (pre-feature) message", async () => {
    const where = vi.fn().mockResolvedValue([]);
    const from = vi.fn().mockReturnValue({ where });
    mockDb.select.mockReturnValue({ from } as never);

    const snap = await getMessagePrompt("missing");
    expect(snap).toBeNull();
  });

  it("getMessagePrompt tolerates malformed layers JSON", async () => {
    const where = vi.fn().mockResolvedValue([
      {
        messageId: "msg-1",
        systemPrompt: "BODY",
        layers: "{not json",
        totalTokens: null,
        model: null,
      },
    ]);
    const from = vi.fn().mockReturnValue({ where });
    mockDb.select.mockReturnValue({ from } as never);

    const snap = await getMessagePrompt("msg-1");
    expect(snap?.layers).toEqual([]);
    expect(snap?.totalTokens).toBeNull();
  });
});
