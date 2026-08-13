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
    mock = await createBrowserMock({ allowProtectedWriterTestFixtures: true });
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

  describe("map_write_bundle", () => {
    it("persists a renderer SQL-free board aggregate", async () => {
      const now = new Date().toISOString();
      await mock.invoke("map_write_bundle", {
        payload: {
          kind: "create-board",
          requestId: "typed-map-board-request",
          sessionId: "typed-map-board-session",
          eventUid: "typed-map-board-event",
          projectId: "default-project",
          board: {
            id: "typed-map-board",
            projectId: "default-project",
            title: "Typed map",
            sortOrder: 1,
            mode: "free",
            viewportX: 0,
            viewportY: 0,
            viewportZoom: 1,
            showConfig: "{}",
            colorBy: "none",
            createdAt: now,
            updatedAt: now,
          },
          stickies: [],
          positions: [],
          edges: [],
          frames: [],
        },
      });

      const result = await mock.invoke<{ rows: Record<string, unknown>[] }>(
        "db_execute",
        {
          sql: "select id, project_id, title from map_boards where id = ?",
          params: ["typed-map-board"],
          method: "all",
        },
      );
      expect(result.rows).toEqual([
        {
          id: "typed-map-board",
          project_id: "default-project",
          title: "Typed map",
        },
      ]);
    });

    it("frame extraction creates the Codex position in the aggregate transaction", async () => {
      const now = new Date().toISOString();
      const context = {
        requestId: "browser-map-frame-request",
        sessionId: "browser-map-session",
        eventUid: "browser-map-frame-event",
      };
      await mock.invoke("map_write_bundle", {
        payload: {
          kind: "create-board",
          ...context,
          projectId: "default-project",
          board: {
            id: "browser-frame-board",
            projectId: "default-project",
            title: "Frame board",
            sortOrder: 1,
            mode: "free",
            viewportX: 0,
            viewportY: 0,
            viewportZoom: 1,
            showConfig: "{}",
            colorBy: "none",
            createdAt: now,
            updatedAt: now,
          },
          stickies: [],
          positions: [],
          edges: [],
          frames: [
            {
              id: "browser-frame",
              boardId: "browser-frame-board",
              title: "People",
              x: 10,
              y: 20,
              width: 400,
              height: 200,
              background: "transparent",
              borderColor: "currentColor",
              zIndex: -1,
              createdAt: now,
              updatedAt: now,
            },
          ],
        },
      });

      await mock.invoke("map_write_bundle", {
        payload: {
          kind: "extract-frame-to-codex",
          ...context,
          requestId: "browser-map-frame-extract-request",
          eventUid: "browser-map-frame-extract-event",
          projectId: "default-project",
          boardId: "browser-frame-board",
          codexId: "browser-frame-codex",
          codexType: "lore",
          title: "People",
          content: '{"type":"doc","content":[]}',
          frameId: "browser-frame",
          stickyIds: [],
          positions: [
            {
              id: "browser-frame-position",
              boardId: "browser-frame-board",
              nodeRefType: "codex",
              treeNodeId: null,
              codexEntryId: "browser-frame-codex",
              snippetId: null,
              stickyId: null,
              aiBranchId: null,
              x: 210,
              y: 120,
              pinned: 0,
              zIndex: 0,
              createdAt: now,
              updatedAt: now,
            },
          ],
          createdAt: now,
          updatedAt: now,
        },
      });

      const result = await mock.invoke<{ rows: Record<string, unknown>[] }>(
        "db_execute",
        {
          sql: `SELECT position.codex_entry_id, entry.project_id
                  FROM map_node_positions position
                  JOIN codex_entries entry ON entry.id = position.codex_entry_id
                 WHERE position.id = ?`,
          params: ["browser-frame-position"],
          method: "all",
        },
      );
      expect(result.rows).toEqual([
        {
          codex_entry_id: "browser-frame-codex",
          project_id: "default-project",
        },
      ]);
    });

    it("user edge promotion creates the Codex relation and deletes the edge atomically", async () => {
      const now = new Date().toISOString();
      for (const [id, name] of [
        ["browser-codex-a", "Alice"],
        ["browser-codex-b", "Bob"],
      ]) {
        await mock.invoke("db_execute", {
          sql: `INSERT INTO codex_entries
                  (id, project_id, type, name, content, created_at, updated_at)
                VALUES (?, ?, 'character', ?, '{}', ?, ?)`,
          params: [id, "default-project", name, now, now],
          method: "run",
        });
      }
      const context = {
        requestId: "browser-map-relation-board-request",
        sessionId: "browser-map-session",
        eventUid: "browser-map-relation-board-event",
      };
      await mock.invoke("map_write_bundle", {
        payload: {
          kind: "create-board",
          ...context,
          projectId: "default-project",
          board: {
            id: "browser-relation-board",
            projectId: "default-project",
            title: "Relation board",
            sortOrder: 1,
            mode: "free",
            viewportX: 0,
            viewportY: 0,
            viewportZoom: 1,
            showConfig: "{}",
            colorBy: "none",
            createdAt: now,
            updatedAt: now,
          },
          stickies: [],
          positions: [
            {
              id: "browser-position-a",
              boardId: "browser-relation-board",
              nodeRefType: "codex",
              treeNodeId: null,
              codexEntryId: "browser-codex-a",
              snippetId: null,
              stickyId: null,
              aiBranchId: null,
              x: 0,
              y: 0,
              pinned: 0,
              zIndex: 0,
              createdAt: now,
              updatedAt: now,
            },
            {
              id: "browser-position-b",
              boardId: "browser-relation-board",
              nodeRefType: "codex",
              treeNodeId: null,
              codexEntryId: "browser-codex-b",
              snippetId: null,
              stickyId: null,
              aiBranchId: null,
              x: 100,
              y: 0,
              pinned: 0,
              zIndex: 0,
              createdAt: now,
              updatedAt: now,
            },
          ],
          edges: [
            {
              id: "browser-user-edge",
              boardId: "browser-relation-board",
              fromPositionId: "browser-position-a",
              toPositionId: "browser-position-b",
              forwardLabel: "師匠",
              backwardLabel: null,
              labels: "[]",
              style: "solid",
              color: "currentColor",
              direction: "forward",
              createdAt: now,
              updatedAt: now,
            },
          ],
          frames: [],
        },
      });

      await mock.invoke("map_write_bundle", {
        payload: {
          kind: "promote-user-edge-to-codex-relation",
          ...context,
          requestId: "browser-map-relation-promote-request",
          eventUid: "browser-map-relation-promote-event",
          projectId: "default-project",
          boardId: "browser-relation-board",
          edgeId: "browser-user-edge",
          relationId: "browser-relation",
          fromCodexId: "browser-codex-a",
          toCodexId: "browser-codex-b",
          relationType: "mentor",
          label: "師匠",
          reuseExistingRelation: false,
          createdAt: now,
          updatedAt: now,
        },
      });

      const result = await mock.invoke<{ rows: Record<string, unknown>[] }>(
        "db_execute",
        {
          sql: `SELECT relation.id, relation.source_map_edge_id,
                       COUNT(edge.id) AS edge_count
                  FROM codex_relations relation
                  LEFT JOIN map_edges edge ON edge.id = relation.source_map_edge_id
                 WHERE relation.id = ?
                 GROUP BY relation.id, relation.source_map_edge_id`,
          params: ["browser-relation"],
          method: "all",
        },
      );
      expect(result.rows).toEqual([
        {
          id: "browser-relation",
          source_map_edge_id: "browser-user-edge",
          edge_count: 0,
        },
      ]);
    });

    it("AI branch delete/undo/retry/redo preserves Change Feed lineage", async () => {
      const now = new Date().toISOString();
      const baseContext = {
        origin: "human",
        originalTransactionId: null,
        undoJournalId: null,
        sessionId: "browser-map-history-session",
      };
      await mock.invoke("map_write_bundle", {
        payload: {
          kind: "create-board",
          ...baseContext,
          requestId: "browser-map-history-board-request",
          eventUid: "browser-map-history-board-event",
          projectId: "default-project",
          board: {
            id: "browser-map-history-board",
            projectId: "default-project",
            title: "History board",
            sortOrder: 1,
            mode: "free",
            viewportX: 0,
            viewportY: 0,
            viewportZoom: 1,
            showConfig: "{}",
            colorBy: "none",
            createdAt: now,
            updatedAt: now,
          },
          stickies: [],
          positions: [],
          edges: [],
          frames: [],
        },
      });
      await mock.invoke("map_write_bundle", {
        payload: {
          kind: "create-ai-branch",
          ...baseContext,
          requestId: "browser-map-history-create-request",
          eventUid: "browser-map-history-create-event",
          projectId: "default-project",
          branch: {
            id: "browser-map-history-branch",
            boardId: "browser-map-history-board",
            prompt: "Ideas",
            seedNodeIds: "[]",
            sessionId: null,
            model: null,
            tokenUsage: null,
            createdAt: now,
            updatedAt: now,
          },
          branchPosition: {
            id: "browser-map-history-position",
            boardId: "browser-map-history-board",
            nodeRefType: "ai_branch",
            treeNodeId: null,
            codexEntryId: null,
            snippetId: null,
            stickyId: null,
            aiBranchId: "browser-map-history-branch",
            x: 0,
            y: 0,
            pinned: 0,
            zIndex: 0,
            createdAt: now,
            updatedAt: now,
          },
          stickies: [],
          positions: [],
          edges: [],
          spans: [],
        },
      });
      const forward = await mock.invoke<{
        changeEventUid: string;
        maintenanceTransactionId: string;
        undoJournalId: string;
      }>("map_write_bundle", {
        payload: {
          kind: "erase-ai-branch",
          ...baseContext,
          requestId: "browser-map-history-delete-request",
          eventUid: "browser-map-history-delete-event",
          projectId: "default-project",
          branchId: "browser-map-history-branch",
          spanIds: [],
          stickyPositionIds: [],
          stickyIds: [],
        },
      });
      const restorePayload = {
        kind: "restore-ai-branch",
        origin: "undo",
        originalTransactionId: forward.maintenanceTransactionId,
        undoJournalId: forward.undoJournalId,
        requestId: "browser-map-history-undo-request",
        sessionId: "browser-map-history-session",
        eventUid: "browser-map-history-undo-event",
        projectId: "default-project",
        branch: {
          id: "browser-map-history-branch",
          boardId: "browser-map-history-board",
          prompt: "Ideas",
          seedNodeIds: "[]",
          sessionId: null,
          model: null,
          tokenUsage: null,
          createdAt: now,
          updatedAt: now,
        },
        branchPosition: {
          id: "browser-map-history-position",
          boardId: "browser-map-history-board",
          nodeRefType: "ai_branch",
          treeNodeId: null,
          codexEntryId: null,
          snippetId: null,
          stickyId: null,
          aiBranchId: "browser-map-history-branch",
          x: 0,
          y: 0,
          pinned: 0,
          zIndex: 0,
          createdAt: now,
          updatedAt: now,
        },
        stickies: [],
        positions: [],
        edges: [],
        spans: [],
      };
      const undo = await mock.invoke<{
        maintenanceTransactionId: string;
      }>("map_write_bundle", { payload: restorePayload });
      const retry = await mock.invoke<{ maintenanceTransactionId: string }>(
        "map_write_bundle",
        { payload: { ...restorePayload, eventUid: "ignored-on-retry" } },
      );
      expect(retry).toEqual(undo);

      await mock.invoke("map_write_bundle", {
        payload: {
          kind: "erase-ai-branch",
          origin: "redo",
          originalTransactionId: forward.maintenanceTransactionId,
          undoJournalId: forward.undoJournalId,
          requestId: "browser-map-history-redo-request",
          sessionId: "browser-map-history-session",
          eventUid: "browser-map-history-redo-event",
          projectId: "default-project",
          branchId: "browser-map-history-branch",
          spanIds: [],
          stickyPositionIds: [],
          stickyIds: [],
        },
      });

      const result = await mock.invoke<{ rows: Record<string, unknown>[] }>(
        "db_execute",
        {
          sql: `SELECT origin, cause_kind, original_transaction_id,
                       undo_journal_id
                  FROM narrative_change_transactions
                 WHERE request_id IN (?, ?, ?)
                 ORDER BY created_at`,
          params: [
            "browser-map-history-delete-request",
            "browser-map-history-undo-request",
            "browser-map-history-redo-request",
          ],
          method: "all",
        },
      );
      expect(result.rows).toEqual([
        {
          origin: "human",
          cause_kind: "forward",
          original_transaction_id: null,
          undo_journal_id: forward.undoJournalId,
        },
        {
          origin: "undo",
          cause_kind: "undo",
          original_transaction_id: forward.maintenanceTransactionId,
          undo_journal_id: forward.undoJournalId,
        },
        {
          origin: "redo",
          cause_kind: "redo",
          original_transaction_id: forward.maintenanceTransactionId,
          undo_journal_id: forward.undoJournalId,
        },
      ]);
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

    it("keeps Web OpenRouter credentials in session memory", async () => {
      await mock.invoke("save_api_key", {
        provider: "openrouter",
        key: "sk-or-test",
      });
      await expect(
        mock.invoke<boolean>("has_api_key", { provider: "openrouter" }),
      ).resolves.toBe(true);
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
      const auditContext = {
        expectedWorkspacePath: "/dev/workspace",
        projectId: "default-project",
        operationId: "operation-missing-model",
        executionId: "execution-missing-model",
        parentExecutionId: null,
        pathId: "browser_byok_web",
      } as const;
      const event = (eventType: string, sequence: number) => ({
        eventId: `missing-model-${sequence}`,
        executionId: auditContext.executionId,
        operationId: auditContext.operationId,
        parentExecutionId: auditContext.parentExecutionId,
        pathId: auditContext.pathId,
        eventType,
        timestamp: sequence,
        payload: {
          captureState: "complete",
          credentialsExcluded: true,
          request: { messages: [] },
        },
      });
      await mock.invoke("ai_audit_append_batch", {
        expectedWorkspacePath: auditContext.expectedWorkspacePath,
        projectId: auditContext.projectId,
        events: [
          event("execution.started", 1),
          event("request.prepared", 2),
          event("request.dispatched", 3),
        ],
      });

      await expect(
        mock.invoke("send_chat_message", {
          messages: [{ role: "user", content: "Hello" }],
          auditContext,
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
        mock.invoke("semantic_index_scene", {
          expectedWorkspacePath: "/dev/workspace",
          projectId: "default-project",
          sceneId: "scene-1",
        }),
      ).resolves.toBe(0);
      await expect(
        mock.invoke("semantic_index_scene", {
          expectedWorkspacePath: "/different/workspace",
          projectId: "default-project",
          sceneId: "scene-1",
        }),
      ).rejects.toThrow(/AI_AUDIT_WORKSPACE_CHANGED/u);
      await expect(
        mock.invoke("semantic_index_scene", {
          expectedWorkspacePath: "/dev/workspace",
          projectId: "different-project",
          sceneId: "scene-1",
        }),
      ).rejects.toThrow(/SEMANTIC_INDEX_AUTHORITY_MISMATCH/u);
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

    it("preserves a Web OpenRouter setting now that the provider is supported", async () => {
      localStorage.setItem(
        "grimodex:ai-settings",
        JSON.stringify({ provider: "openrouter", model: "vendor/model" }),
      );
      const migratedMock = await createBrowserMock();

      await expect(
        migratedMock.invoke("get_ai_settings", {}),
      ).resolves.toMatchObject({
        provider: "openrouter",
        model: "vendor/model",
      });
      expect(
        JSON.parse(localStorage.getItem("grimodex:ai-settings") ?? "{}"),
      ).toMatchObject({
        provider: "openrouter",
        model: "vendor/model",
      });
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
