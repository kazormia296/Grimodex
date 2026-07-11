// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBrowserMock } from "./browser-mock";
import {
  verifyChain,
  type EventForVerify,
} from "@/features/timelapse/hashChain";

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

      // Seed a parent folder first (default-chapter is no longer auto-seeded)
      await mock.invoke("db_execute", {
        sql: "insert into tree_nodes (id, project_id, node_type, title, sort_order, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
        params: [
          "default-chapter",
          "default-project",
          "folder",
          "Part.1",
          "a0",
          now,
          now,
        ],
        method: "run",
      });

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

  describe("timelapse_append_batch", () => {
    it("allocates sequence/hash rows in the browser mock and dedupes resend", async () => {
      const events = [
        {
          eventUid: "uid-1",
          sceneId: null,
          domain: "editor",
          opType: "step",
          entityType: null,
          entityId: null,
          payload: '{"i":1}',
          timestamp: 1700000000000,
        },
        {
          eventUid: "uid-2",
          sceneId: null,
          domain: "chat",
          opType: "chat.message.add",
          entityType: null,
          entityId: null,
          payload: '{"text":"hi"}',
          timestamp: 1700000000001,
        },
      ];

      const first = await mock.invoke<{
        insertedCount: number;
        tailSequence: number;
        tailHash: string;
      }>("timelapse_append_batch", {
        projectId: "default-project",
        sessionId: "session-1",
        events,
      });
      expect(first.insertedCount).toBe(2);
      expect(first.tailSequence).toBe(2);

      const second = await mock.invoke<{
        insertedCount: number;
        tailSequence: number;
      }>("timelapse_append_batch", {
        projectId: "default-project",
        sessionId: "session-1",
        events,
      });
      expect(second.insertedCount).toBe(0);
      expect(second.tailSequence).toBe(2);

      const result = await mock.invoke<{ rows: EventForVerify[] }>(
        "db_execute",
        {
          sql: "select project_id as projectId, scene_id as sceneId, domain, op_type as opType, entity_type as entityType, entity_id as entityId, payload, session_id as sessionId, sequence, timestamp, prev_hash as prevHash, hash from change_events where project_id = ? order by sequence",
          params: ["default-project"],
          method: "all",
        },
      );
      expect(result.rows).toHaveLength(2);
      expect(result.rows.map((r) => r.sequence)).toEqual([1, 2]);
      expect((await verifyChain(result.rows)).ok).toBe(true);
    });
  });

  describe("API key persistence", () => {
    it("persists API key in localStorage across mock instances", async () => {
      await mock.invoke("save_api_key", {
        provider: "openai",
        key: "sk-test-123",
      });

      // has_api_key exposes only presence, never the plaintext key.
      const present = await mock.invoke<boolean>("has_api_key", {
        provider: "openai",
      });
      expect(present).toBe(true);

      // Create a new mock instance — presence should survive
      const mock2 = await createBrowserMock();
      const present2 = await mock2.invoke<boolean>("has_api_key", {
        provider: "openai",
      });
      expect(present2).toBe(true);
    });

    it("deletes API key from localStorage", async () => {
      await mock.invoke("save_api_key", {
        provider: "anthropic",
        key: "sk-ant",
      });
      await mock.invoke("delete_api_key", { provider: "anthropic" });

      const present = await mock.invoke<boolean>("has_api_key", {
        provider: "anthropic",
      });
      expect(present).toBe(false);
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

  describe("schema completeness", () => {
    // Regression: chat_summaries / chat_summary_messages were missing from
    // SCHEMA_DDL, so listSummaries() threw "no such table" and the chat panel
    // surfaced a "メッセージの読み込みに失敗しました" toast during screenshots.
    it("provides the chat summary tables queried by listSummaries", async () => {
      await expect(
        mock.invoke("db_execute", {
          sql: "select * from chat_summaries where session_id = ?",
          params: ["chat-scene-1"],
          method: "all",
        }),
      ).resolves.toBeDefined();

      await expect(
        mock.invoke("db_execute", {
          sql: "select * from chat_summary_messages where summary_id = ?",
          params: ["summary-1"],
          method: "all",
        }),
      ).resolves.toBeDefined();
    });

    it("provides chat_sessions.codex_anchor_id for listSessions queries", async () => {
      await expect(
        mock.invoke("db_execute", {
          sql: "select codex_anchor_id from chat_sessions where id = ?",
          params: ["chat-scene-1"],
          method: "all",
        }),
      ).resolves.toBeDefined();
    });
  });

  describe("screenshot staging", () => {
    afterEach(() => {
      localStorage.removeItem("grimodex:screenshot-mode");
      localStorage.removeItem("grimodex:ai-settings");
    });

    // Regression: nothing seeds grimodex:ai-settings in the screenshot path, so
    // the chat panel rendered "モデル未設定". In staging mode the mock now
    // returns a default model matching the seeded chat-scene-1 session.
    it("returns a default AI model in screenshot staging mode", async () => {
      localStorage.setItem("grimodex:screenshot-mode", "true");
      const stagingMock = await createBrowserMock();
      const settings = await stagingMock.invoke<Record<string, unknown>>(
        "get_ai_settings",
        {},
      );
      expect(settings.model).toBeTruthy();
    });

    it("leaves the AI model unset outside staging mode", async () => {
      const settings = await mock.invoke<Record<string, unknown>>(
        "get_ai_settings",
        {},
      );
      expect(settings.model).toBe("");
    });
  });

  describe("seed data", () => {
    it("does not auto-seed any tree_nodes (workspace starts empty)", async () => {
      const result = await mock.invoke<{ rows: Record<string, unknown>[] }>(
        "db_execute",
        {
          sql: "select * from tree_nodes",
          params: [],
          method: "all",
        },
      );
      expect(result.rows).toHaveLength(0);
    });
  });

  describe("IME export Phase 2", () => {
    it("returns a disabled in-memory status without touching the filesystem", async () => {
      const status = await mock.invoke<{
        rootPath: string;
        consumers: unknown[];
        activeProjectId: string | null;
        exportedProjectCount: number;
        effectiveEnabled: boolean;
      }>("ime_export_get_status", { mode: "auto" });
      expect(status).toEqual({
        rootPath: "",
        consumers: [],
        activeProjectId: null,
        exportedProjectCount: 0,
        effectiveEnabled: false,
      });
    });

    it("accepts all mutation commands as safe no-ops", async () => {
      await expect(
        mock.invoke("ime_export_refresh", {
          projectId: "p1",
          expectedWorkspacePath: "/workspaces/a",
          options: {
            mode: "on",
            excludeHidden: false,
            includeProfile: true,
          },
        }),
      ).resolves.toMatchObject({ rootPath: "" });
      await expect(
        mock.invoke("ime_export_set_active_project", {
          projectId: "p1",
          expectedWorkspacePath: "/workspaces/a",
          mode: "on",
        }),
      ).resolves.toMatchObject({ rootPath: "" });
      await expect(mock.invoke("ime_export_clear_all", {})).resolves.toBeNull();
      await expect(
        mock.invoke("ime_export_remove_project", {
          projectId: "p1",
          expectedWorkspacePath: "/workspaces/a",
        }),
      ).resolves.toBeNull();
    });
  });

  describe("unknown command", () => {
    it("throws for unsupported commands", async () => {
      await expect(mock.invoke("unknown_command", {})).rejects.toThrow();
    });
  });
});
