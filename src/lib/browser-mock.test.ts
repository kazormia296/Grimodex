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

  afterEach(() => {
    mock.close();
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

    it("supports the argument-free vacuum_database maintenance command", async () => {
      await expect(mock.invoke("vacuum_database")).resolves.toBeUndefined();
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

  describe("API key browser lifetime", () => {
    it("purges keys persisted by older browser-mock builds", async () => {
      localStorage.setItem("grimodex:api-key:openai", "legacy-secret");

      const migratedMock = await createBrowserMock();

      expect(localStorage.getItem("grimodex:api-key:openai")).toBeNull();
      await expect(
        migratedMock.invoke<boolean>("has_api_key", { provider: "openai" }),
      ).resolves.toBe(false);
      migratedMock.close();
    });

    it("keeps an API key only in the active mock and never persists it", async () => {
      await mock.invoke("save_api_key", {
        provider: "openai",
        key: "sk-test-123",
      });

      // has_api_key exposes only presence, never the plaintext key.
      const present = await mock.invoke<boolean>("has_api_key", {
        provider: "openai",
      });
      expect(present).toBe(true);

      expect(localStorage.getItem("grimodex:api-key:openai")).toBeNull();

      // A new runtime represents a reload and must require the key again.
      const mock2 = await createBrowserMock();
      const present2 = await mock2.invoke<boolean>("has_api_key", {
        provider: "openai",
      });
      expect(present2).toBe(false);
      mock2.close();
    });

    it("deletes an API key from the active in-memory store", async () => {
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

    it("rejects Web OpenRouter credentials before storing them", async () => {
      await expect(
        mock.invoke("save_api_key", {
          provider: "openrouter",
          key: "sk-or-test",
        }),
      ).rejects.toThrow(/not supported in browser mode/i);
      expect(localStorage.getItem("grimodex:api-key:openrouter")).toBeNull();
    });
  });

  describe("list_ai_models", () => {
    it("surfaces provider failure instead of presenting a mocked model list", async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error("Network error"));
      vi.stubGlobal("fetch", mockFetch);
      const authorizedMock = await createBrowserMock({
        authorizeAiRequest: vi.fn().mockResolvedValue(undefined),
      });
      await authorizedMock.invoke("save_api_key", {
        provider: "openai",
        key: "disposable-test-key",
      });

      await expect(authorizedMock.invoke("list_ai_models", {})).rejects.toThrow(
        "Network error",
      );

      authorizedMock.close();
      vi.unstubAllGlobals();
    });
  });

  describe("send_chat_message", () => {
    it("fails explicitly instead of returning a fake assistant response", async () => {
      // Ensure no key is stored
      await mock.invoke("delete_api_key", { provider: "ollama" });

      await expect(
        mock.invoke("send_chat_message", {
          messages: [{ role: "user", content: "Hello" }],
        }),
      ).rejects.toThrow(/model.*設定|モデル.*設定/i);
    });
  });

  describe("native-only optional panels", () => {
    it("returns an empty scene lens instead of logging a browser command error", async () => {
      await expect(
        mock.invoke("list_scene_lens_for_project", {
          projectId: "default-project",
        }),
      ).resolves.toEqual([]);
    });

    it("keeps dense semantic commands as explicit no-ops in Hosted Editor", async () => {
      await expect(
        mock.invoke("semantic_index_scene", { sceneId: "scene-1" }),
      ).resolves.toBe(0);
      await expect(
        mock.invoke("semantic_search", {
          projectId: "default-project",
          query: "冒頭",
          limit: 5,
        }),
      ).resolves.toEqual([]);
    });

    it("keeps the sparse related-scene arm available through browser SQL", async () => {
      const now = new Date().toISOString();
      await mock.invoke("db_execute", {
        sql: "insert into tree_nodes (id, project_id, node_type, title, synopsis, content, sort_order, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params: [
          "scene-browser-search",
          "default-project",
          "scene",
          "雨の再会",
          "駅で再会する",
          "{}",
          "a0",
          now,
          now,
        ],
        method: "run",
      });

      await expect(
        mock.invoke("fts_search", {
          projectId: "default-project",
          query: "再会",
          limit: 5,
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          sourceType: "scene",
          id: "scene-browser-search",
          title: "雨の再会",
        }),
      ]);
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

    it("does not imply bundled AI in screenshot staging mode", async () => {
      localStorage.setItem("grimodex:screenshot-mode", "true");
      const stagingMock = await createBrowserMock();
      const settings = await stagingMock.invoke<Record<string, unknown>>(
        "get_ai_settings",
        {},
      );
      expect(settings).toMatchObject({ provider: "ollama", model: "" });
      stagingMock.close();
    });

    it("leaves the AI model unset outside staging mode", async () => {
      const settings = await mock.invoke<Record<string, unknown>>(
        "get_ai_settings",
        {},
      );
      expect(settings).toMatchObject({ provider: "ollama", model: "" });
    });

    it("migrates a legacy Web OpenRouter setting to disconnected Ollama", async () => {
      localStorage.setItem(
        "grimodex:ai-settings",
        JSON.stringify({ provider: "openrouter", model: "vendor/model" }),
      );
      const migratedMock = await createBrowserMock();

      await expect(
        migratedMock.invoke("get_ai_settings", {}),
      ).resolves.toMatchObject({ provider: "ollama", model: "" });
      expect(
        JSON.parse(localStorage.getItem("grimodex:ai-settings") ?? "{}"),
      ).toMatchObject({ provider: "ollama", model: "" });
      migratedMock.close();
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
