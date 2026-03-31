import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@/lib/tauri";
const mockInvoke = vi.mocked(invoke);

import {
  listThreads,
  createThread,
  deleteThread,
  listMessages,
  addMessage,
  updateThreadTitle,
} from "./chatApi";
import type { ChatThread } from "./chatTypes";

function mockDbExecute(rows: Record<string, unknown>[]) {
  mockInvoke.mockResolvedValueOnce({ rows });
}

describe("chatApi - thread/message persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("listThreads", () => {
    it("returns threads for a given sceneId", async () => {
      const thread: ChatThread = {
        id: "thread-1",
        title: "会話1",
        sceneId: "scene-abc",
        createdAt: "2025-01-01T00:00:00Z",
        modifiedAt: "2025-01-01T00:00:00Z",
      };
      mockDbExecute([
        {
          id: thread.id,
          title: thread.title,
          scene_id: thread.sceneId,
          created_at: thread.createdAt,
          modified_at: thread.modifiedAt,
        },
      ]);

      const result = await listThreads("scene-abc");

      expect(mockInvoke).toHaveBeenCalledWith(
        "db_execute",
        expect.objectContaining({
          method: "all",
        }),
      );
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("thread-1");
      expect(result[0].sceneId).toBe("scene-abc");
    });

    it("returns all threads when no sceneId given", async () => {
      mockDbExecute([]);
      const result = await listThreads();
      expect(result).toHaveLength(0);
    });
  });

  describe("createThread", () => {
    it("creates a thread and returns it", async () => {
      mockDbExecute([
        {
          id: "new-thread-id",
          title: "新しい会話",
          scene_id: "scene-1",
          created_at: "2025-01-01T00:00:00Z",
          modified_at: "2025-01-01T00:00:00Z",
        },
      ]);

      const result = await createThread("新しい会話", "scene-1");

      expect(mockInvoke).toHaveBeenCalled();
      expect(result.title).toBe("新しい会話");
      expect(result.sceneId).toBe("scene-1");
    });

    it("creates a thread without sceneId", async () => {
      mockDbExecute([
        {
          id: "thread-no-scene",
          title: "フリー会話",
          scene_id: null,
          created_at: "2025-01-01T00:00:00Z",
          modified_at: "2025-01-01T00:00:00Z",
        },
      ]);

      const result = await createThread("フリー会話");
      expect(result.sceneId).toBeNull();
    });
  });

  describe("deleteThread", () => {
    it("deletes a thread by id", async () => {
      mockDbExecute([]);

      await deleteThread("thread-1");

      expect(mockInvoke).toHaveBeenCalledWith(
        "db_execute",
        expect.objectContaining({
          method: "run",
        }),
      );
    });
  });

  describe("listMessages", () => {
    it("returns messages for a thread ordered by createdAt", async () => {
      mockDbExecute([
        {
          id: "msg-1",
          thread_id: "thread-1",
          role: "user",
          content: "こんにちは",
          created_at: "2025-01-01T00:00:00Z",
        },
        {
          id: "msg-2",
          thread_id: "thread-1",
          role: "assistant",
          content: "こんにちは！",
          created_at: "2025-01-01T00:00:01Z",
        },
      ]);

      const result = await listMessages("thread-1");

      expect(result).toHaveLength(2);
      expect(result[0].role).toBe("user");
      expect(result[1].role).toBe("assistant");
    });

    it("returns empty array for thread with no messages", async () => {
      mockDbExecute([]);
      const result = await listMessages("empty-thread");
      expect(result).toEqual([]);
    });
  });

  describe("addMessage", () => {
    it("inserts a message and returns it", async () => {
      // First call: insert message (returning)
      mockDbExecute([
        {
          id: "msg-new",
          thread_id: "thread-1",
          role: "user",
          content: "テストメッセージ",
          created_at: "2025-01-01T00:00:00Z",
        },
      ]);
      // Second call: update thread modified_at
      mockDbExecute([]);

      const result = await addMessage("thread-1", "user", "テストメッセージ");

      expect(result.threadId).toBe("thread-1");
      expect(result.role).toBe("user");
      expect(result.content).toBe("テストメッセージ");
    });
  });

  describe("updateThreadTitle", () => {
    it("updates the thread title", async () => {
      mockDbExecute([]);

      await updateThreadTitle("thread-1", "新しいタイトル");

      expect(mockInvoke).toHaveBeenCalledWith(
        "db_execute",
        expect.objectContaining({
          method: "run",
        }),
      );
    });
  });
});
