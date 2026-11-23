// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserMock,
  type PersistentBrowserMock,
} from "@/lib/browser-mock";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";

// DR-SRX-27: a map card is sent to Native as the snapshot has it. The renderer
// no longer clears `tree_node_id` / `codex_entry_id` (a card names exactly one
// thing, so a NULL reference breaks the table's CHECK); Native compares the
// plan with its own canonical plan and then decides what falls away for a
// missing parent. A renderer that cleared the reference, or left the card
// out, would send a plan Native refuses.

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  invoke: invokeMock,
  isTauri: () => false,
}));

import {
  createProjectSnapshot,
  restoreProjectSnapshot,
} from "./projectSnapshotApi";

const PROJECT_ID = "default-project";
const BODY = '{"type":"doc","content":[{"type":"text","text":"v1"}]}';

let browser: PersistentBrowserMock;
let applyPayloads: {
  scopes: string[];
  inserts: { table: string; row: Record<string, unknown> }[];
}[];

async function run(sql: string, params: unknown[] = []): Promise<void> {
  await browser.invoke("db_execute", { sql, params, method: "run" });
}

beforeEach(async () => {
  delete (window as unknown as Record<string, unknown>).grimodex;
  setCurrentWorkspaceIdentity({ path: "/ws", openRevision: 1 });
  browser = await createBrowserMock({ allowProtectedWriterTestFixtures: true });
  applyPayloads = [];
  invokeMock.mockReset();
  invokeMock.mockImplementation(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === "project_snapshot_apply_restore") {
        applyPayloads.push(
          (args as { payload: (typeof applyPayloads)[number] }).payload,
        );
        return { canonicalSequence: 1, noOp: true, dropped: [] };
      }
      return browser.invoke(command, args);
    },
  );
  const now = new Date().toISOString();
  await run(
    `INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order, content)
     VALUES ('s1', ?, 'scene', 's1', 'a0', ?)`,
    [PROJECT_ID, BODY],
  );
  await run(
    `INSERT INTO map_boards (id, project_id, created_at, updated_at)
     VALUES ('board1', ?, ?, ?)`,
    [PROJECT_ID, now, now],
  );
  await run(
    `INSERT INTO map_node_positions (id, board_id, node_ref_type, tree_node_id, x, y)
     VALUES ('pos-s', 'board1', 'scene', 's1', 1, 1)`,
  );
});

afterEach(() => {
  browser.close();
  setCurrentWorkspaceIdentity(null);
});

describe("map restore plan", () => {
  it("sends a card whose scene was deleted with its original reference", async () => {
    const snapshot = await createProjectSnapshot({ name: "with card" });
    await run("DELETE FROM tree_nodes WHERE id = 's1'");

    const result = await restoreProjectSnapshot(snapshot.id, "with card", {
      scopes: new Set(["map"]),
    });

    expect(applyPayloads).toHaveLength(1);
    const cards = applyPayloads[0].inserts.filter(
      (insert) => insert.table === "map_node_positions",
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].row.id).toBe("pos-s");
    expect(cards[0].row.tree_node_id).toBe("s1");
    expect(cards[0].row.codex_entry_id ?? null).toBeNull();
    // The renderer does not count a clearing it no longer does.
    expect(result.skipped).not.toHaveProperty("mapNodePositionsLinkCleared");
  });

  it("sends a card whose Codex entry was deleted with its original reference", async () => {
    const now = new Date().toISOString();
    await run(
      `INSERT INTO codex_entries (id, project_id, type, name, aliases, summary, content, parent_id, version, created_at, updated_at)
       VALUES ('c1', ?, 'character', 'Hero', '[]', 'sum', '{}', NULL, 0, ?, ?)`,
      [PROJECT_ID, now, now],
    );
    await run(
      `INSERT INTO map_node_positions (id, board_id, node_ref_type, codex_entry_id, x, y)
       VALUES ('pos-c', 'board1', 'codex', 'c1', 2, 2)`,
    );
    const snapshot = await createProjectSnapshot({ name: "with codex card" });
    await run("DELETE FROM codex_entries WHERE id = 'c1'");

    await restoreProjectSnapshot(snapshot.id, "with codex card", {
      scopes: new Set(["map"]),
    });

    const cards = applyPayloads[0].inserts.filter(
      (insert) =>
        insert.table === "map_node_positions" && insert.row.id === "pos-c",
    );
    expect(cards).toHaveLength(1);
    expect(cards[0].row.codex_entry_id).toBe("c1");
    expect(cards[0].row.tree_node_id ?? null).toBeNull();
  });
});
