import { describe, it, expect, beforeEach } from "vitest";
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
        sql: "insert into projects (title, description, created_at, updated_at) values (?, ?, ?, ?) returning *",
        params: ["My Novel", "", now, now],
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

    it("inserts and selects a scene with TEXT primary key", async () => {
      // Set up parent records
      const now = new Date().toISOString();
      await mock.invoke("db_execute", {
        sql: "insert into projects (title, description, created_at, updated_at) values (?, ?, ?, ?) returning *",
        params: ["P1", "", now, now],
        method: "all",
      });
      await mock.invoke("db_execute", {
        sql: "insert into chapters (project_id, title, sort_order, created_at, updated_at) values (?, ?, ?, ?, ?) returning *",
        params: [1, "Ch1", 0, now, now],
        method: "all",
      });

      // Insert scene with UUID
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      await mock.invoke("db_execute", {
        sql: "insert into scenes (id, chapter_id, title, sort_order, synopsis, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?) returning *",
        params: [uuid, 1, "冒頭", 0, "", now, now],
        method: "all",
      });

      const result = await mock.invoke<{ rows: Record<string, unknown>[] }>(
        "db_execute",
        {
          sql: "select * from scenes where chapter_id = ?",
          params: [1],
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
        sql: "insert into projects (title, description, created_at, updated_at) values (?, ?, ?, ?) returning *",
        params: ["ToDelete", "", now, now],
        method: "all",
      });
      await mock.invoke("db_execute", {
        sql: "delete from projects where title = ?",
        params: ["ToDelete"],
        method: "run",
      });
      const result = await mock.invoke<{ rows: Record<string, unknown>[] }>(
        "db_execute",
        {
          sql: "select * from projects where title = ?",
          params: ["ToDelete"],
          method: "all",
        },
      );
      expect(result.rows).toHaveLength(0);
    });
  });

  describe("content_write / content_read / content_delete", () => {
    it("writes and reads markdown content", async () => {
      await mock.invoke("content_write", {
        sceneId: "abc-123",
        markdown: "# Hello World",
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
      });
      await mock.invoke("content_delete", { sceneId: "abc-123" });
      const result = await mock.invoke<string>("content_read", {
        sceneId: "abc-123",
      });
      expect(result).toBe("");
    });
  });

  describe("unknown command", () => {
    it("throws for unsupported commands", async () => {
      await expect(mock.invoke("unknown_command", {})).rejects.toThrow();
    });
  });
});
