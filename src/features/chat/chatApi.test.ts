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
    updatedAt: "updatedAt",
    projectId: "projectId",
  },
  chatMessages: { id: "id", sessionId: "sessionId", createdAt: "createdAt" },
  codexEntries: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  desc: vi.fn((col: unknown) => ({ desc: col })),
  inArray: vi.fn((...args: unknown[]) => ({ inArray: args })),
  isNull: vi.fn((col: unknown) => ({ isNull: col })),
}));

import { db } from "@/db/client";
const mockDb = vi.mocked(db);

import {
  listSessions,
  createSession,
  deleteSession,
  listMessages,
  addMessage,
  updateSessionTitle,
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
  };
  mockDb.insert.mockReturnValue(chain as never);
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

  describe("listSessions", () => {
    it("returns sessions for a given nodeId", async () => {
      const session: ChatSession = {
        id: "session-1",
        projectId: "proj-1",
        nodeId: "node-abc",
        title: "会話1",
        titleManual: 0,
        model: "openrouter/anthropic/claude-sonnet-4.6",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      };
      mockSelectChain([session as unknown as Record<string, unknown>]);

      const result = await listSessions("node-abc");

      expect(mockDb.select).toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("session-1");
      expect(result[0].nodeId).toBe("node-abc");
    });

    it("returns all sessions when no nodeId given", async () => {
      mockSelectChain([]);
      const result = await listSessions();
      expect(result).toHaveLength(0);
    });

    it("returns project-scope sessions when nodeId is null", async () => {
      const session: ChatSession = {
        id: "session-proj",
        projectId: "proj-1",
        nodeId: null,
        title: "プロジェクト会話",
        titleManual: 0,
        model: "openrouter/anthropic/claude-sonnet-4.6",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      };
      mockSelectChain([session as unknown as Record<string, unknown>]);

      const result = await listSessions(null);

      expect(mockDb.select).toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0].nodeId).toBeNull();
    });
  });

  describe("createSession", () => {
    it("creates a session and returns it", async () => {
      const row = {
        id: "new-session-id",
        projectId: "proj-1",
        nodeId: "node-1",
        title: "新しい会話",
        titleManual: 0,
        model: "openrouter/anthropic/claude-sonnet-4.6",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      };
      mockInsertChain([row]);

      const result = await createSession("proj-1", "新しい会話", "node-1");

      expect(mockDb.insert).toHaveBeenCalled();
      expect(result.title).toBe("新しい会話");
      expect(result.nodeId).toBe("node-1");
      expect(result.projectId).toBe("proj-1");
    });

    it("creates a session without nodeId", async () => {
      const row = {
        id: "session-no-node",
        projectId: "proj-1",
        nodeId: null,
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
  });

  describe("updateSessionTitle", () => {
    it("updates the session title", async () => {
      mockUpdateChain();

      await updateSessionTitle("session-1", "新しいタイトル");

      expect(mockDb.update).toHaveBeenCalled();
    });
  });
});
