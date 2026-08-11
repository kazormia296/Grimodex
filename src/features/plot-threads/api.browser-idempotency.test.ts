// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  invoke: invokeMock,
  isTauri: () => false,
}));

import { createBrowserMock } from "@/lib/browser-mock";
import { getCreateResultMetadata } from "@/lib/createResultMetadata";
import {
  createPlotThread,
  createPlotThreadBranch,
  createPlotThreadLink,
  deletePlotThreadSnapshot,
  movePlotMarkerBundle,
  restorePlotThreadSnapshot,
} from "./api";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("plot branch browser durable create", () => {
  beforeEach(async () => {
    delete (window as unknown as Record<string, unknown>).grimodex;
    const browser = await createBrowserMock();
    invokeMock.mockReset();
    invokeMock.mockImplementation(
      (command: string, args?: Record<string, unknown>) =>
        browser.invoke(command, args),
    );
    const run = (sql: string, params: unknown[] = []) =>
      browser.invoke("db_execute", { sql, params, method: "run" });
    await run("INSERT OR IGNORE INTO projects (id) VALUES ('p1')");
    await run(
      "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order) VALUES ('s1', 'p1', 'scene', 'S1', 'a0')",
    );
    await run(
      "INSERT INTO plot_threads (id, project_id, name, sort_order) VALUES ('t1', 'p1', 'T1', 'a0'), ('t2', 'p1', 'T2', 'a1')",
    );
  });

  it("delete 後の同一 request を tombstone replay し branch を復活させない", async () => {
    const payload = {
      id: "browser-branch-request-1",
      projectId: "p1",
      fromThreadId: "t1",
      toThreadId: "t2",
      atNodeId: "s1",
      kind: "branch" as const,
    };
    const first = await createPlotThreadBranch(payload);
    expect(getCreateResultMetadata(first)).toEqual({
      replayed: false,
      entityPresent: true,
    });
    const exact = await createPlotThreadBranch(payload);
    expect(getCreateResultMetadata(exact)).toEqual({
      replayed: true,
      entityPresent: true,
    });
    const ledgerHash = await invokeMock("db_execute", {
      sql: "SELECT payload_hash FROM idempotency_requests WHERE domain = ? AND request_id = ?",
      params: ["plot_thread_branch_create", payload.id],
      method: "get",
    });
    expect(ledgerHash.rows).toEqual([
      {
        payload_hash: await sha256Hex(
          JSON.stringify([
            "plot_thread_branch_create",
            {
              atNodeId: "s1",
              fromThreadId: "t1",
              id: payload.id,
              kind: "branch",
              projectId: "p1",
              toThreadId: "t2",
            },
          ]),
        ),
      },
    ]);

    await invokeMock("db_execute", {
      sql: "DELETE FROM plot_thread_branches WHERE id = ?",
      params: [payload.id],
      method: "run",
    });
    const deletedReplay = await createPlotThreadBranch(payload);
    expect(deletedReplay.id).toBe(payload.id);
    expect(getCreateResultMetadata(deletedReplay)).toEqual({
      replayed: true,
      entityPresent: false,
    });
    const rows = await invokeMock("db_execute", {
      sql: "SELECT id FROM plot_thread_branches WHERE id = ?",
      params: [payload.id],
      method: "all",
    });
    expect(rows.rows).toEqual([]);

    await expect(
      createPlotThreadBranch({ ...payload, kind: "merge" }),
    ).rejects.toThrow("PLOT_THREAD_BRANCH_IDEMPOTENCY_CONFLICT");
    const ledger = await invokeMock("db_execute", {
      sql: "SELECT tombstone_json FROM idempotency_requests WHERE domain = ? AND request_id = ?",
      params: ["plot_thread_branch_create", payload.id],
      method: "get",
    });
    expect(ledger.rows).toEqual([
      { tombstone_json: JSON.stringify({ id: payload.id }) },
    ]);
  });

  it("cross-project references fail without leaving a ledger tombstone", async () => {
    await invokeMock("db_execute", {
      sql: "INSERT INTO projects (id) VALUES ('p2')",
      params: [],
      method: "run",
    });
    await invokeMock("db_execute", {
      sql: "INSERT INTO plot_threads (id, project_id, name, sort_order) VALUES ('foreign-thread', 'p2', 'Foreign', 'a0')",
      params: [],
      method: "run",
    });

    await expect(
      createPlotThreadBranch({
        id: "cross-project-request",
        projectId: "p1",
        fromThreadId: "t1",
        toThreadId: "foreign-thread",
        atNodeId: "s1",
        kind: "branch",
      }),
    ).rejects.toThrow("same project");

    const ledger = await invokeMock("db_execute", {
      sql: "SELECT request_id FROM idempotency_requests WHERE request_id = ?",
      params: ["cross-project-request"],
      method: "all",
    });
    expect(ledger.rows).toEqual([]);
  });

  it("legacy branch ID collision rolls back the ledger claim", async () => {
    const requestId = "legacy-branch-id";
    await invokeMock("db_execute", {
      sql: `INSERT INTO plot_thread_branches
              (id, project_id, from_thread_id, to_thread_id, at_node_id, kind)
            VALUES (?, 'p1', 't1', 't2', 's1', 'branch')`,
      params: [requestId],
      method: "run",
    });

    await expect(
      createPlotThreadBranch({
        id: requestId,
        projectId: "p1",
        fromThreadId: "t2",
        toThreadId: "t1",
        atNodeId: "s1",
        kind: "merge",
      }),
    ).rejects.toThrow();

    const poisonedLedger = await invokeMock("db_execute", {
      sql: "SELECT request_id FROM idempotency_requests WHERE domain = ? AND request_id = ?",
      params: ["plot_thread_branch_create", requestId],
      method: "all",
    });
    expect(poisonedLedger.rows).toEqual([]);

    await invokeMock("db_execute", {
      sql: "DELETE FROM plot_thread_branches WHERE id = ?",
      params: [requestId],
      method: "run",
    });
    await expect(
      createPlotThreadBranch({
        id: requestId,
        projectId: "p1",
        fromThreadId: "t2",
        toThreadId: "t1",
        atNodeId: "s1",
        kind: "merge",
      }),
    ).resolves.toMatchObject({ id: requestId, kind: "merge" });
  });

  it("thread と link も delete 後の exact retry で復活しない", async () => {
    const threadPayload = {
      id: "browser-thread-request",
      projectId: "p1",
      name: "Browser thread",
      color: null,
      description: null,
      sortOrder: "a2",
    };
    const firstThread = await createPlotThread(threadPayload);
    expect(getCreateResultMetadata(firstThread)).toEqual({
      replayed: false,
      entityPresent: true,
    });
    await invokeMock("db_execute", {
      sql: "DELETE FROM plot_threads WHERE id = ?",
      params: [threadPayload.id],
      method: "run",
    });
    const deletedThreadReplay = await createPlotThread(threadPayload);
    expect(getCreateResultMetadata(deletedThreadReplay)).toEqual({
      replayed: true,
      entityPresent: false,
    });

    const linkPayload = {
      id: "browser-link-request",
      threadId: "t1",
      nodeId: "s1",
      phaseType: "develop" as const,
      note: null,
      sortOrder: null,
    };
    const firstLink = await createPlotThreadLink(linkPayload);
    expect(getCreateResultMetadata(firstLink)).toEqual({
      replayed: false,
      entityPresent: true,
    });
    await invokeMock("db_execute", {
      sql: "DELETE FROM plot_thread_scene_links WHERE id = ?",
      params: [linkPayload.id],
      method: "run",
    });
    const deletedLinkReplay = await createPlotThreadLink(linkPayload);
    expect(getCreateResultMetadata(deletedLinkReplay)).toEqual({
      replayed: true,
      entityPresent: false,
    });
  });

  it("snapshot 全体を atomic restore し、削除後の stale replay では復活させない", async () => {
    const snapshot = {
      requestId: "browser-restore-request",
      projectId: "p1",
      thread: {
        id: "restored-thread",
        projectId: "p1",
        name: "Restored",
        color: "#112233",
        description: "full snapshot",
        sortOrder: "a2",
        startNodeId: "s1",
        endNodeId: "s1",
        version: 0,
        createdAt: "2026-07-28T01:00:00.000Z",
        updatedAt: "2026-07-28T01:01:00.000Z",
      },
      links: [
        {
          id: "restored-link",
          threadId: "restored-thread",
          nodeId: "s1",
          phaseType: "turn" as const,
          note: "turning point",
          sortOrder: "a0",
          version: 0,
          createdAt: "2026-07-28T01:02:00.000Z",
          updatedAt: "2026-07-28T01:03:00.000Z",
        },
      ],
      branches: [
        {
          id: "restored-branch",
          projectId: "p1",
          fromThreadId: "t1",
          toThreadId: "restored-thread",
          atNodeId: "s1",
          kind: "branch" as const,
          semanticKey: "t1|restored-thread|s1|branch",
          version: 0,
          createdAt: "2026-07-28T01:04:00.000Z",
          updatedAt: "2026-07-28T01:05:00.000Z",
        },
      ],
    };

    const first = await restorePlotThreadSnapshot(snapshot);
    expect(first).toMatchObject({
      id: snapshot.requestId,
      thread: snapshot.thread,
      links: snapshot.links,
      branches: snapshot.branches,
    });
    expect(getCreateResultMetadata(first)).toEqual({
      replayed: false,
      entityPresent: true,
    });
    const exact = await restorePlotThreadSnapshot(snapshot);
    expect(getCreateResultMetadata(exact)).toEqual({
      replayed: true,
      entityPresent: true,
    });

    await invokeMock("db_execute", {
      sql: "DELETE FROM plot_threads WHERE id = ?",
      params: [snapshot.thread.id],
      method: "run",
    });
    const deletedReplay = await restorePlotThreadSnapshot(snapshot);
    expect(getCreateResultMetadata(deletedReplay)).toEqual({
      replayed: true,
      entityPresent: false,
    });
    const rows = await invokeMock("db_execute", {
      sql: `SELECT id FROM plot_threads WHERE id = ?
            UNION ALL SELECT id FROM plot_thread_scene_links WHERE id = ?
            UNION ALL SELECT id FROM plot_thread_branches WHERE id = ?`,
      params: [
        snapshot.thread.id,
        snapshot.links[0].id,
        snapshot.branches[0].id,
      ],
      method: "all",
    });
    expect(rows.rows).toEqual([]);
  });

  it("snapshot child 検証失敗時に parent と ledger をまとめて rollback する", async () => {
    const requestId = "browser-restore-invalid-child";
    await expect(
      restorePlotThreadSnapshot({
        requestId,
        projectId: "p1",
        thread: {
          id: "rolled-back-thread",
          projectId: "p1",
          name: "Rollback",
          color: null,
          description: null,
          sortOrder: "a2",
          startNodeId: null,
          endNodeId: null,
          version: 0,
          createdAt: "2026-07-28T02:00:00.000Z",
          updatedAt: "2026-07-28T02:01:00.000Z",
        },
        links: [
          {
            id: "invalid-child",
            threadId: "rolled-back-thread",
            nodeId: "missing-scene",
            phaseType: "develop",
            note: null,
            sortOrder: null,
            semanticKey: "",
            version: 0,
            createdAt: "2026-07-28T02:02:00.000Z",
            updatedAt: "2026-07-28T02:03:00.000Z",
          },
        ],
        branches: [],
      }),
    ).rejects.toThrow();

    const rows = await invokeMock("db_execute", {
      sql: `SELECT id FROM plot_threads WHERE id = ?
            UNION ALL
            SELECT request_id AS id FROM idempotency_requests
             WHERE domain = 'plot_thread_restore_snapshot' AND request_id = ?`,
      params: ["rolled-back-thread", requestId],
      method: "all",
    });
    expect(rows.rows).toEqual([]);
  });

  it("marker move と branch transition を一度だけ atomic commit する", async () => {
    await invokeMock("db_execute", {
      sql: `INSERT INTO plot_thread_scene_links
              (id, thread_id, node_id, phase_type, note, sort_order, created_at, updated_at)
            VALUES ('move-link', 't1', 's1', 'turn', 'move me', 'a0', 'c1', 'u1')`,
      params: [],
      method: "run",
    });
    const markerBefore = {
      id: "move-link",
      threadId: "t1",
      nodeId: "s1",
      phaseType: "turn" as const,
      note: "move me",
      sortOrder: "a0",
      version: 0,
      createdAt: "c1",
      updatedAt: "u1",
    };
    const markerAfter = {
      ...markerBefore,
      threadId: "t2",
      updatedAt: "u2",
    };
    const branch = {
      id: "move-branch",
      projectId: "p1",
      fromThreadId: "t1",
      toThreadId: "t2",
      atNodeId: "s1",
      kind: "branch" as const,
      semanticKey: "t1|t2|s1|branch",
      version: 0,
      createdAt: "c2",
      updatedAt: "u2",
    };
    const payload = {
      requestId: "browser-move-request",
      projectId: "p1",
      markerBefore,
      markerAfter,
      branchTransitions: [{ before: null, after: branch }],
    };

    const first = await movePlotMarkerBundle(payload);
    expect(first).toMatchObject({
      id: payload.requestId,
      marker: markerAfter,
      branches: [branch],
      deletedBranchIds: [],
    });
    expect(getCreateResultMetadata(first)).toEqual({
      replayed: false,
      entityPresent: true,
    });

    const exact = await movePlotMarkerBundle(payload);
    expect(getCreateResultMetadata(exact)).toEqual({
      replayed: true,
      entityPresent: true,
    });
    const rows = await invokeMock("db_execute", {
      sql: `SELECT thread_id, updated_at FROM plot_thread_scene_links WHERE id = ?
            UNION ALL
            SELECT from_thread_id AS thread_id, updated_at
              FROM plot_thread_branches WHERE id = ?`,
      params: [markerAfter.id, branch.id],
      method: "all",
    });
    expect(rows.rows).toEqual([
      { thread_id: "t2", updated_at: "u2" },
      { thread_id: "t1", updated_at: "u2" },
    ]);
    const ledger = await invokeMock("db_execute", {
      sql: `SELECT request_id FROM idempotency_requests
             WHERE domain = 'plot_thread_move_marker_bundle'
               AND request_id = ?`,
      params: [payload.requestId],
      method: "all",
    });
    expect(ledger.rows).toEqual([{ request_id: payload.requestId }]);
  });

  it("branch write 失敗時に marker と ledger をまとめて rollback する", async () => {
    await invokeMock("db_execute", {
      sql: `INSERT INTO plot_thread_scene_links
              (id, thread_id, node_id, phase_type, note, sort_order, created_at, updated_at)
            VALUES ('rollback-link', 't1', 's1', 'develop', NULL, NULL, 'c1', 'u1')`,
      params: [],
      method: "run",
    });
    await invokeMock("db_execute", {
      sql: `CREATE TRIGGER reject_move_branch
              BEFORE INSERT ON plot_thread_branches
              WHEN NEW.id = 'rollback-branch'
              BEGIN
                SELECT RAISE(ABORT, 'forced branch failure');
              END`,
      params: [],
      method: "run",
    });
    const markerBefore = {
      id: "rollback-link",
      threadId: "t1",
      nodeId: "s1",
      phaseType: "develop" as const,
      note: null,
      sortOrder: null,
      semanticKey: "",
      version: 0,
      createdAt: "c1",
      updatedAt: "u1",
    };

    await expect(
      movePlotMarkerBundle({
        requestId: "browser-move-rollback",
        projectId: "p1",
        markerBefore,
        markerAfter: {
          ...markerBefore,
          threadId: "t2",
          updatedAt: "u2",
        },
        branchTransitions: [
          {
            before: null,
            after: {
              id: "rollback-branch",
              projectId: "p1",
              fromThreadId: "t1",
              toThreadId: "t2",
              atNodeId: "s1",
              kind: "branch",
              semanticKey: "",
              version: 0,
              createdAt: "c2",
              updatedAt: "u2",
            },
          },
        ],
      }),
    ).rejects.toThrow("forced branch failure");

    const marker = await invokeMock("db_execute", {
      sql: "SELECT thread_id, updated_at FROM plot_thread_scene_links WHERE id = ?",
      params: [markerBefore.id],
      method: "get",
    });
    expect(marker.rows).toEqual([{ thread_id: "t1", updated_at: "u1" }]);
    const leakedRows = await invokeMock("db_execute", {
      sql: `SELECT id FROM plot_thread_branches WHERE id = 'rollback-branch'
            UNION ALL
            SELECT request_id AS id FROM idempotency_requests
             WHERE domain = 'plot_thread_move_marker_bundle'
               AND request_id = 'browser-move-rollback'`,
      params: [],
      method: "all",
    });
    expect(leakedRows.rows).toEqual([]);
  });

  it("marker と依存 branch を atomic delete し、再作成後の replay では消さない", async () => {
    await invokeMock("db_execute", {
      sql: `INSERT INTO plot_thread_scene_links
              (id, thread_id, node_id, phase_type, note, sort_order, created_at, updated_at)
            VALUES ('delete-link', 't2', 's1', 'climax', 'delete me', 'a0', 'c1', 'u1')`,
      params: [],
      method: "run",
    });
    await invokeMock("db_execute", {
      sql: `INSERT INTO plot_thread_branches
              (id, project_id, from_thread_id, to_thread_id, at_node_id, kind, created_at, updated_at)
            VALUES ('delete-branch', 'p1', 't1', 't2', 's1', 'merge', 'c2', 'u2')`,
      params: [],
      method: "run",
    });
    const link = {
      id: "delete-link",
      threadId: "t2",
      nodeId: "s1",
      phaseType: "climax" as const,
      note: "delete me",
      sortOrder: "a0",
      version: 0,
      createdAt: "c1",
      updatedAt: "u1",
    };
    const branch = {
      id: "delete-branch",
      projectId: "p1",
      fromThreadId: "t1",
      toThreadId: "t2",
      atNodeId: "s1",
      kind: "merge" as const,
      semanticKey: "",
      version: 0,
      createdAt: "c2",
      updatedAt: "u2",
    };
    const payload = {
      requestId: "browser-delete-request",
      projectId: "p1",
      link,
      branches: [branch],
    };

    const first = await deletePlotThreadSnapshot(payload);
    expect(first.deleted).toBe(true);
    expect(getCreateResultMetadata(first)).toEqual({
      replayed: false,
      entityPresent: true,
    });
    const exact = await deletePlotThreadSnapshot(payload);
    expect(getCreateResultMetadata(exact)).toEqual({
      replayed: true,
      entityPresent: true,
    });

    await invokeMock("db_execute", {
      sql: `INSERT INTO plot_thread_scene_links
              (id, thread_id, node_id, phase_type, note, sort_order, created_at, updated_at)
            VALUES ('delete-link', 't2', 's1', 'climax', 'recreated', 'a0', 'c3', 'u3')`,
      params: [],
      method: "run",
    });
    await invokeMock("db_execute", {
      sql: `INSERT INTO plot_thread_branches
              (id, project_id, from_thread_id, to_thread_id, at_node_id, kind, created_at, updated_at)
            VALUES ('delete-branch', 'p1', 't1', 't2', 's1', 'merge', 'c4', 'u4')`,
      params: [],
      method: "run",
    });
    const recreatedReplay = await deletePlotThreadSnapshot(payload);
    expect(getCreateResultMetadata(recreatedReplay)).toEqual({
      replayed: true,
      entityPresent: false,
    });
    const rows = await invokeMock("db_execute", {
      sql: `SELECT id FROM plot_thread_scene_links WHERE id = ?
            UNION ALL SELECT id FROM plot_thread_branches WHERE id = ?`,
      params: ["delete-link", "delete-branch"],
      method: "all",
    });
    expect(rows.rows).toEqual([{ id: "delete-link" }, { id: "delete-branch" }]);
  });

  it("marker delete の dependency set 不一致を ledger ごと拒否する", async () => {
    await invokeMock("db_execute", {
      sql: `INSERT INTO plot_thread_scene_links
              (id, thread_id, node_id, phase_type, created_at, updated_at)
            VALUES ('partial-link', 't2', 's1', 'develop', 'c1', 'u1')`,
      params: [],
      method: "run",
    });
    await invokeMock("db_execute", {
      sql: `INSERT INTO plot_thread_branches
              (id, project_id, from_thread_id, to_thread_id, at_node_id, kind, created_at, updated_at)
            VALUES ('partial-branch', 'p1', 't1', 't2', 's1', 'branch', 'c2', 'u2')`,
      params: [],
      method: "run",
    });

    await expect(
      deletePlotThreadSnapshot({
        requestId: "browser-delete-incomplete",
        projectId: "p1",
        link: {
          id: "partial-link",
          threadId: "t2",
          nodeId: "s1",
          phaseType: "develop",
          note: null,
          sortOrder: null,
          semanticKey: "",
          version: 0,
          createdAt: "c1",
          updatedAt: "u1",
        },
        branches: [],
      }),
    ).rejects.toThrow("dependencies");
    const rows = await invokeMock("db_execute", {
      sql: `SELECT id FROM plot_thread_scene_links WHERE id = 'partial-link'
            UNION ALL SELECT id FROM plot_thread_branches WHERE id = 'partial-branch'
            UNION ALL
            SELECT request_id AS id FROM idempotency_requests
             WHERE domain = 'plot_thread_delete_snapshot'
               AND request_id = 'browser-delete-incomplete'`,
      params: [],
      method: "all",
    });
    expect(rows.rows).toEqual([
      { id: "partial-link" },
      { id: "partial-branch" },
    ]);
  });

  it("ledger 未成立 retry は同じ ID の再作成 row を snapshot 不一致で削除しない", async () => {
    const originalLink = {
      id: "recreated-link",
      threadId: "t2",
      nodeId: "s1",
      phaseType: "turn" as const,
      note: "original",
      sortOrder: "a0",
      version: 0,
      createdAt: "c1",
      updatedAt: "u1",
    };
    const originalBranch = {
      id: "recreated-branch",
      projectId: "p1",
      fromThreadId: "t1",
      toThreadId: "t2",
      atNodeId: "s1",
      kind: "branch" as const,
      semanticKey: "",
      version: 0,
      createdAt: "c2",
      updatedAt: "u2",
    };
    await invokeMock("db_execute", {
      sql: `INSERT INTO plot_thread_scene_links
              (id, thread_id, node_id, phase_type, note, sort_order, created_at, updated_at)
            VALUES ('recreated-link', 't2', 's1', 'turn', 'replacement', 'a0', 'c3', 'u3')`,
      params: [],
      method: "run",
    });
    await invokeMock("db_execute", {
      sql: `INSERT INTO plot_thread_branches
              (id, project_id, from_thread_id, to_thread_id, at_node_id, kind, created_at, updated_at)
            VALUES ('recreated-branch', 'p1', 't1', 't2', 's1', 'branch', 'c4', 'u4')`,
      params: [],
      method: "run",
    });

    await expect(
      deletePlotThreadSnapshot({
        requestId: "browser-delete-uncommitted-retry",
        projectId: "p1",
        link: originalLink,
        branches: [originalBranch],
      }),
    ).rejects.toThrow("PLOT_THREAD_DELETE_PRECONDITION_FAILED");
    const rows = await invokeMock("db_execute", {
      sql: `SELECT id FROM plot_thread_scene_links WHERE id = 'recreated-link'
            UNION ALL SELECT id FROM plot_thread_branches WHERE id = 'recreated-branch'
            UNION ALL
            SELECT request_id AS id FROM idempotency_requests
             WHERE domain = 'plot_thread_delete_snapshot'
               AND request_id = 'browser-delete-uncommitted-retry'`,
      params: [],
      method: "all",
    });
    expect(rows.rows).toEqual([
      { id: "recreated-link" },
      { id: "recreated-branch" },
    ]);
  });

  it("BrowserMock の foreshadow typed create も durable tombstone を使う", async () => {
    const payload = {
      id: "browser-foreshadow-request",
      requestId: "browser-foreshadow-request",
      projectId: "p1",
      title: "伏線",
      intent: "意図",
      notes: "全フィールド",
      payoffSceneId: "s1",
      payoffFromPos: 2,
      payoffToPos: 8,
      payoffConfirmed: true,
      abandoned: true,
      secret: false,
      loadBearing: "supporting",
      codexLinkDirtyAt: 1_784_000_000_000,
    };
    const first = await invokeMock("foreshadow_create", { payload });
    expect(first.__idempotency).toEqual({
      replayed: false,
      entityPresent: true,
    });
    const persisted = await invokeMock("db_execute", {
      sql: `SELECT intent, notes, payoff_scene_id, payoff_from_pos,
                   payoff_to_pos, payoff_confirmed, abandoned, secret,
                   load_bearing, codex_link_dirty_at
              FROM foreshadows WHERE id = ?`,
      params: [payload.id],
      method: "get",
    });
    expect(persisted.rows).toEqual([
      {
        intent: "意図",
        notes: "全フィールド",
        payoff_scene_id: "s1",
        payoff_from_pos: 2,
        payoff_to_pos: 8,
        payoff_confirmed: 1,
        abandoned: 1,
        secret: 0,
        load_bearing: "supporting",
        codex_link_dirty_at: 1_784_000_000_000,
      },
    ]);
    await invokeMock("db_execute", {
      sql: "DELETE FROM foreshadows WHERE id = ?",
      params: [payload.id],
      method: "run",
    });
    const deletedReplay = await invokeMock("foreshadow_create", { payload });
    expect(deletedReplay).toMatchObject({
      id: payload.id,
      __idempotency: { replayed: true, entityPresent: false },
    });
    const rows = await invokeMock("db_execute", {
      sql: "SELECT id FROM foreshadows WHERE id = ?",
      params: [payload.id],
      method: "all",
    });
    expect(rows.rows).toEqual([]);
  });

  it("foreshadow requestId-only と id/requestId 欠落を native と同じに扱う", async () => {
    const requestOnly = {
      requestId: "browser-foreshadow-request-only",
      projectId: "p1",
      title: "request only",
      intent: null,
      loadBearing: null,
    };
    const first = await invokeMock("foreshadow_create", {
      payload: requestOnly,
    });
    const replay = await invokeMock("foreshadow_create", {
      payload: requestOnly,
    });
    expect(first).toMatchObject({
      id: requestOnly.requestId,
      __idempotency: { replayed: false, entityPresent: true },
    });
    expect(replay).toMatchObject({
      id: requestOnly.requestId,
      __idempotency: { replayed: true, entityPresent: true },
    });

    const noIdentityPayload = {
      projectId: "p1",
      title: "no request ledger",
      intent: null,
      loadBearing: null,
    };
    const generatedA = await invokeMock("foreshadow_create", {
      payload: noIdentityPayload,
    });
    const generatedB = await invokeMock("foreshadow_create", {
      payload: noIdentityPayload,
    });
    expect(generatedA.id).not.toBe(generatedB.id);
    const ledgers = await invokeMock("db_execute", {
      sql: "SELECT request_id FROM idempotency_requests WHERE domain = 'foreshadow_create' AND request_id IN (?, ?)",
      params: [generatedA.id, generatedB.id],
      method: "all",
    });
    expect(ledgers.rows).toEqual([]);
  });

  it("foreshadow payoff の不正 range / cross-project scene を ledger ごと拒否する", async () => {
    await invokeMock("db_execute", {
      sql: "INSERT INTO projects (id) VALUES ('p2')",
      params: [],
      method: "run",
    });
    await invokeMock("db_execute", {
      sql: "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order) VALUES ('foreign-scene', 'p2', 'scene', 'Foreign', 'a0')",
      params: [],
      method: "run",
    });
    const base = {
      id: "browser-foreshadow-xproj",
      requestId: "browser-foreshadow-xproj",
      projectId: "p1",
      title: "invalid payoff",
      intent: null,
      notes: null,
      payoffSceneId: "foreign-scene",
      payoffFromPos: 1,
      payoffToPos: 2,
      payoffConfirmed: false,
      abandoned: false,
      secret: true,
      loadBearing: null,
      codexLinkDirtyAt: null,
    };
    await expect(
      invokeMock("foreshadow_create", { payload: base }),
    ).rejects.toThrow("same project");
    await expect(
      invokeMock("foreshadow_create", {
        payload: {
          ...base,
          id: "browser-foreshadow-range",
          requestId: "browser-foreshadow-range",
          payoffSceneId: "s1",
          payoffFromPos: 9,
          payoffToPos: 3,
        },
      }),
    ).rejects.toThrow("0 <= from <= to");
    const ledgers = await invokeMock("db_execute", {
      sql: "SELECT request_id FROM idempotency_requests WHERE request_id IN (?, ?)",
      params: [base.requestId, "browser-foreshadow-range"],
      method: "all",
    });
    expect(ledgers.rows).toEqual([]);
  });

  it("変更済み legacy foreshadow を create replay として採用しない", async () => {
    const payload = {
      id: "modified-legacy-foreshadow",
      requestId: "modified-legacy-foreshadow",
      projectId: "p1",
      title: "伏線",
      intent: null,
      loadBearing: "supporting",
    };
    await invokeMock("db_execute", {
      sql: `INSERT INTO foreshadows
              (id, project_id, title, intent, notes, payoff_confirmed,
               abandoned, secret, load_bearing, created_at, updated_at)
            VALUES (?, ?, ?, NULL, 'edited after create', 0, 0, 1, ?, 0, 0)`,
      params: [
        payload.id,
        payload.projectId,
        payload.title,
        payload.loadBearing,
      ],
      method: "run",
    });

    await expect(invokeMock("foreshadow_create", { payload })).rejects.toThrow(
      "FORESHADOW_CREATE_IDEMPOTENCY_CONFLICT",
    );
    const ledger = await invokeMock("db_execute", {
      sql: "SELECT request_id FROM idempotency_requests WHERE domain = ? AND request_id = ?",
      params: ["foreshadow_create", payload.requestId],
      method: "all",
    });
    expect(ledger.rows).toEqual([]);
  });
});
