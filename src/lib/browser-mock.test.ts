// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBrowserMock } from "./browser-mock";

describe("createBrowserMock", () => {
  let mock: Awaited<ReturnType<typeof createBrowserMock>>;

  beforeEach(async () => {
    mock = await createBrowserMock();
  });

  describe("db_execute", () => {
    it("inserts and selects a project", async () => {
      const now = new Date().toISOString();
      await mock.invoke("db_execute", {
        sql: "insert into projects (id, title, language, created_at, updated_at) values (?, ?, ?, ?, ?) returning *",
        params: ["proj-test", "My Novel", "ja", now, now],
        method: "all",
      });

      const result = await mock.invoke<{ rows: Record<string, unknown>[] }>(
        "db_execute",
        {
          sql: "select * from projects where title = ?",
          params: ["My Novel"],
          method: "all",
        },
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toHaveProperty("title", "My Novel");
    });

    it("inserts and selects a tree_node with TEXT primary key", async () => {
      const now = new Date().toISOString();

      // Insert tree_node referencing default-project seed
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      await mock.invoke("db_execute", {
        sql: "insert into tree_nodes (id, project_id, parent_id, node_type, title, sort_order, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?) returning *",
        params: [
          uuid,
          "default-project",
          "default-chapter",
          "scene",
          "冒頭",
          0,
          now,
          now,
        ],
        method: "all",
      });

      const result = await mock.invoke<{ rows: Record<string, unknown>[] }>(
        "db_execute",
        {
          sql: "select * from tree_nodes where node_type = ?",
          params: ["scene"],
          method: "all",
        },
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toHaveProperty("id", uuid);
      expect(result.rows[0]).toHaveProperty("title", "冒頭");
    });

    it("deletes a row", async () => {
      const now = new Date().toISOString();
      await mock.invoke("db_execute", {
        sql: "insert into projects (id, title, language, created_at, updated_at) values (?, ?, ?, ?, ?) returning *",
        params: ["proj-del", "ToDelete", "ja", now, now],
        method: "all",
      });
      await mock.invoke("db_execute", {
        sql: "delete from projects where id = ?",
        params: ["proj-del"],
        method: "run",
      });
      const result = await mock.invoke<{ rows: Record<string, unknown>[] }>(
        "db_execute",
        {
          sql: "select * from projects where id = ?",
          params: ["proj-del"],
          method: "all",
        },
      );
      expect(result.rows).toHaveLength(0);
    });
  });

  describe("content_write / content_read / content_delete", () => {
    it("writes and reads markdown content with metadata", async () => {
      await mock.invoke("content_write", {
        sceneId: "abc-123",
        markdown: "# Hello World",
        title: "プロローグ",
        chapterOrder: 1,
        sceneOrder: 1,
      });
      const result = await mock.invoke<string>("content_read", {
        sceneId: "abc-123",
      });
      expect(result).toBe("# Hello World");
    });

    it("returns empty string for non-existent content", async () => {
      const result = await mock.invoke<string>("content_read", {
        sceneId: "does-not-exist",
      });
      expect(result).toBe("");
    });

    it("deletes content", async () => {
      await mock.invoke("content_write", {
        sceneId: "abc-123",
        markdown: "# To Delete",
        title: "削除対象",
        chapterOrder: 1,
        sceneOrder: 1,
      });
      await mock.invoke("content_delete", { sceneId: "abc-123" });
      const result = await mock.invoke<string>("content_read", {
        sceneId: "abc-123",
      });
      expect(result).toBe("");
    });
  });

  describe("content_rename", () => {
    it("preserves content after rename", async () => {
      await mock.invoke("content_write", {
        sceneId: "rename-test",
        markdown: "# Content",
        title: "旧名",
        chapterOrder: 1,
        sceneOrder: 1,
      });
      await mock.invoke("content_rename", {
        sceneId: "rename-test",
        title: "新名",
        chapterOrder: 1,
        sceneOrder: 2,
      });
      const result = await mock.invoke<string>("content_read", {
        sceneId: "rename-test",
      });
      expect(result).toBe("# Content");
    });
  });

  describe("API key persistence", () => {
    it("persists API key in localStorage across mock instances", async () => {
      await mock.invoke("save_api_key", {
        provider: "openai",
        key: "sk-test-123",
      });

      const key = await mock.invoke<string | null>("get_api_key", {
        provider: "openai",
      });
      expect(key).toBe("sk-test-123");

      // Create a new mock instance — key should survive
      const mock2 = await createBrowserMock();
      const key2 = await mock2.invoke<string | null>("get_api_key", {
        provider: "openai",
      });
      expect(key2).toBe("sk-test-123");
    });

    it("deletes API key from localStorage", async () => {
      await mock.invoke("save_api_key", {
        provider: "anthropic",
        key: "sk-ant",
      });
      await mock.invoke("delete_api_key", { provider: "anthropic" });

      const key = await mock.invoke<string | null>("get_api_key", {
        provider: "anthropic",
      });
      expect(key).toBeNull();
    });
  });

  describe("list_ai_models", () => {
    it("falls back to static list when fetch fails", async () => {
      // fetch will fail because there's no real server — exercises the fallback
      const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
      vi.stubGlobal("fetch", mockFetch);

      const models = await mock.invoke<Array<{ id: string; name: string }>>(
        "list_ai_models",
        {},
      );
      expect(models.length).toBeGreaterThan(0);

      vi.unstubAllGlobals();
    });
  });

  describe("send_chat_message", () => {
    it("returns fallback message when no API key is set", async () => {
      // Ensure no key is stored
      await mock.invoke("delete_api_key", { provider: "openrouter" });

      const result = await mock.invoke<string>("send_chat_message", {
        messages: [{ role: "user", content: "Hello" }],
      });
      expect(result).toContain("AIは未接続です");
    });
  });

  describe("unknown command", () => {
    it("throws for unsupported commands", async () => {
      await expect(mock.invoke("unknown_command", {})).rejects.toThrow();
    });
  });
});
