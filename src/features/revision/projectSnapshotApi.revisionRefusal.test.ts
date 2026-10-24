// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserMock,
  type PersistentBrowserMock,
} from "@/lib/browser-mock";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";

// DA-2b M (DR-DA2B-R3): the snapshot's body versions come from the typed
// `revision_create`. A node that stops being the project's while the snapshot
// is captured (Native: `REVISION_WRITE_REFUSED:not-found`) ends the snapshot
// as a workspace change does: a row without its body version would restore
// the node with an empty body. No snapshot row is written.

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  invoke: invokeMock,
  isTauri: () => false,
}));

import { createProjectSnapshot } from "./projectSnapshotApi";

const PROJECT_ID = "default-project";
const BODY = '{"type":"doc","content":[{"type":"text","text":"v1"}]}';

let browser: PersistentBrowserMock;
let onRevisionCreate: (payload: Record<string, unknown>) => void;

async function run(sql: string, params: unknown[] = []): Promise<void> {
  await browser.invoke("db_execute", { sql, params, method: "run" });
}

async function rows(sql: string): Promise<Record<string, unknown>[]> {
  const result = await browser.invoke<{ rows: Record<string, unknown>[] }>(
    "db_execute",
    { sql, params: [], method: "all" },
  );
  return result.rows;
}

beforeEach(async () => {
  delete (window as unknown as Record<string, unknown>).grimodex;
  setCurrentWorkspaceIdentity({ path: "/ws", openRevision: 1 });
  browser = await createBrowserMock({ allowProtectedWriterTestFixtures: true });
  onRevisionCreate = () => {};
  invokeMock.mockReset();
  invokeMock.mockImplementation(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === "revision_create") {
        onRevisionCreate(args?.payload as Record<string, unknown>);
      }
      return browser.invoke(command, args);
    },
  );
  for (const id of ["kept", "vanished"]) {
    await run(
      `INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order, content)
       VALUES (?, ?, 'scene', ?, ?, ?)`,
      [id, PROJECT_ID, id, id === "kept" ? "a0" : "a1", BODY],
    );
  }
});

afterEach(() => {
  browser.close();
  setCurrentWorkspaceIdentity(null);
});

describe("createProjectSnapshot with the typed version writer", () => {
  it("ends the snapshot when a node is refused as not-found during the capture", async () => {
    onRevisionCreate = (payload) => {
      if (payload.entityId === "vanished") {
        throw new Error("REVISION_WRITE_REFUSED:not-found");
      }
    };

    await expect(
      createProjectSnapshot({ name: "during delete" }),
    ).rejects.toThrow(
      "an entity changed while the project snapshot was captured",
    );
    // No snapshot (and no row without its body) is left to restore from.
    expect(await rows("SELECT id FROM project_snapshots")).toEqual([]);
    expect(
      await rows("SELECT snapshot_id FROM project_snapshot_tree_nodes"),
    ).toEqual([]);
    // Only the typed writer recorded versions; no generic SQL touched them.
    const generic = invokeMock.mock.calls.filter(
      ([command, args]) =>
        command === "db_execute" &&
        /content_versions/i.test(String(args?.sql)) &&
        !/^\s*select/i.test(String(args?.sql)),
    );
    expect(generic).toEqual([]);
  });

  it("creates the snapshot with every body version when nothing is refused", async () => {
    const snapshot = await createProjectSnapshot({ name: "plain" });

    const captured = await rows(
      `SELECT node_id, body_version_id FROM project_snapshot_tree_nodes
        WHERE snapshot_id = '${snapshot.id}' ORDER BY node_id`,
    );
    expect(captured).toEqual([
      { node_id: "kept", body_version_id: expect.any(String) },
      { node_id: "vanished", body_version_id: expect.any(String) },
    ]);
  });

  it("ends the snapshot when the workspace changes during the capture", async () => {
    onRevisionCreate = () => {
      setCurrentWorkspaceIdentity({ path: "/other", openRevision: 2 });
    };

    await expect(createProjectSnapshot({ name: "switch" })).rejects.toThrow(
      "workspace changed while the project snapshot was captured",
    );
    expect(await rows("SELECT id FROM project_snapshots")).toEqual([]);
  });
});
