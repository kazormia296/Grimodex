// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserMock, type PersistentBrowserMock } from "./browser-mock";
import { withCanonicalWriterTestContext } from "./browser-mock.canonical-test-context";

async function rows(
  mock: PersistentBrowserMock,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  return (
    await mock.invoke<{ rows: Record<string, unknown>[] }>("db_execute", {
      sql,
      params,
      method: "all",
    })
  ).rows;
}

describe("BrowserMock timelapse genesis baselines", () => {
  let mock: PersistentBrowserMock;
  let onDatabaseDirty: ReturnType<typeof vi.fn<() => void>>;
  let onLedgerRead: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    onDatabaseDirty = vi.fn<() => void>();
    onLedgerRead = vi.fn<() => void>();
    mock = withCanonicalWriterTestContext(
      await createBrowserMock({
        workspaceIdentity: "/workspace/novel.gdx",
        onDatabaseDirty,
        allowProtectedWriterTestFixtures: true,
        onTimelapseGenesisLedgerReadForTest: onLedgerRead,
      }),
    );
    const now = "2026-08-31T00:00:00.000Z";
    await mock.invoke("db_execute_batch", {
      statements: ["scene-1", "scene-2", "scene-3"].map((id) => ({
        sql: `INSERT INTO tree_nodes
          (id, project_id, node_type, title, content, sort_order, created_at, updated_at)
          VALUES (?, 'default-project', 'scene', ?, ?, ?, ?, ?)`,
        params: [id, id, `payload-${id}`, id, now, now],
        method: "run",
      })),
    });
    await mock.invoke("db_execute", {
      sql: `INSERT INTO state_snapshots
        (project_id, domain, entity_type, entity_id, anchor_sequence,
         anchor_timestamp, payload, encoding, created_at)
        VALUES ('default-project', 'editor', 'scene', 'scene-1', 12, 1, '{}', 'json', 1)`,
      params: [],
      method: "run",
    });
    await mock.invoke("timelapse_append_batch", {
      projectId: "default-project",
      sessionId: "genesis-test",
      events: [
        {
          eventUid: "scene-2-step",
          sceneId: "scene-2",
          domain: "editor",
          opType: "doc.step",
          entityType: "scene",
          entityId: "scene-2",
          payload: "{}",
          timestamp: 2,
        },
      ],
    });
    onDatabaseDirty.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mock.close();
  });

  it("atomically skips per-entity prior work and resumes without duplicates", async () => {
    const args = {
      expectedWorkspacePath: "/workspace/novel.gdx",
      projectId: "default-project",
      kind: "scene",
      entityIds: ["scene-1", "scene-2", "scene-3"],
      anchorTimestamp: 1_800_000_000_000,
    };

    await expect(
      mock.invoke("timelapse_genesis_baselines_append", args),
    ).resolves.toEqual({
      insertedCount: 1,
      skippedExistingBaselineCount: 1,
      skippedExistingBodyStepCount: 1,
    });
    await expect(
      mock.invoke("timelapse_genesis_baselines_append", args),
    ).resolves.toEqual({
      insertedCount: 0,
      skippedExistingBaselineCount: 2,
      skippedExistingBodyStepCount: 1,
    });

    expect(
      await rows(
        mock,
        `SELECT entity_id, anchor_sequence, payload FROM state_snapshots
          WHERE project_id = 'default-project' AND domain = 'editor'
          ORDER BY entity_id`,
      ),
    ).toEqual([
      { entity_id: "scene-1", anchor_sequence: 12, payload: "{}" },
      {
        entity_id: "scene-3",
        anchor_sequence: 0,
        payload: "payload-scene-3",
      },
    ]);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(1);
  });

  it("does not read the ledger when every requested entity already has a baseline", async () => {
    await mock.invoke("db_execute", {
      sql: `INSERT INTO state_snapshots
        (project_id, domain, entity_type, entity_id, anchor_sequence,
         anchor_timestamp, payload, encoding, created_at)
        VALUES ('default-project', 'editor', 'scene', 'scene-3', 0, 4, '{}', 'json', 4)`,
      params: [],
      method: "run",
    });
    onDatabaseDirty.mockClear();

    await expect(
      mock.invoke("timelapse_genesis_baselines_append", {
        expectedWorkspacePath: "/workspace/novel.gdx",
        projectId: "default-project",
        kind: "scene",
        entityIds: ["scene-1", "scene-3"],
        anchorTimestamp: 55,
      }),
    ).resolves.toEqual({
      insertedCount: 0,
      skippedExistingBaselineCount: 2,
      skippedExistingBodyStepCount: 0,
    });
    expect(onLedgerRead).not.toHaveBeenCalled();
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });

  it("reads the ledger once for multiple unsnapshotted candidates", async () => {
    await expect(
      mock.invoke("timelapse_genesis_baselines_append", {
        expectedWorkspacePath: "/workspace/novel.gdx",
        projectId: "default-project",
        kind: "scene",
        entityIds: ["scene-2", "scene-3"],
        anchorTimestamp: 56,
      }),
    ).resolves.toEqual({
      insertedCount: 1,
      skippedExistingBaselineCount: 0,
      skippedExistingBodyStepCount: 1,
    });
    expect(onLedgerRead).toHaveBeenCalledTimes(1);
  });

  it("does not size-reject oversized content behind an anchor>0 baseline", async () => {
    const realEncoder = new TextEncoder();
    const encode = vi.fn((content: string) =>
      content === "payload-scene-1"
        ? ({ byteLength: 8 * 1024 * 1024 + 1 } as Uint8Array)
        : realEncoder.encode(content),
    );
    vi.stubGlobal(
      "TextEncoder",
      class {
        encode(content: string): Uint8Array {
          return encode(content);
        }
      },
    );

    await expect(
      mock.invoke("timelapse_genesis_baselines_append", {
        expectedWorkspacePath: "/workspace/novel.gdx",
        projectId: "default-project",
        kind: "scene",
        entityIds: ["scene-1", "scene-3"],
        anchorTimestamp: 55,
      }),
    ).resolves.toEqual({
      insertedCount: 1,
      skippedExistingBaselineCount: 1,
      skippedExistingBodyStepCount: 0,
    });
    expect(
      await rows(
        mock,
        "SELECT entity_id, created_at FROM state_snapshots WHERE entity_id = 'scene-3'",
      ),
    ).toEqual([{ entity_id: "scene-3", created_at: 55 }]);
    expect(encode).not.toHaveBeenCalledWith("payload-scene-1");
  });

  it("fails safe by treating an ambiguous legacy domain step as a step for every requested entity", async () => {
    await mock.invoke("timelapse_append_batch", {
      projectId: "default-project",
      sessionId: "legacy-genesis-test",
      events: [
        {
          eventUid: "legacy-null-entity-step",
          sceneId: null,
          domain: "editor",
          opType: "doc.step",
          entityType: "scene",
          entityId: null,
          payload: "{}",
          timestamp: 3,
        },
      ],
    });
    onDatabaseDirty.mockClear();

    await expect(
      mock.invoke("timelapse_genesis_baselines_append", {
        expectedWorkspacePath: "/workspace/novel.gdx",
        projectId: "default-project",
        kind: "scene",
        entityIds: ["scene-2", "scene-3"],
        anchorTimestamp: 56,
      }),
    ).resolves.toEqual({
      insertedCount: 0,
      skippedExistingBaselineCount: 0,
      skippedExistingBodyStepCount: 2,
    });
    expect(
      await rows(
        mock,
        "SELECT entity_id FROM state_snapshots WHERE entity_id = 'scene-3'",
      ),
    ).toEqual([]);
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });

  it("rejects a stale Workspace identity before mutation", async () => {
    await expect(
      mock.invoke("timelapse_genesis_baselines_append", {
        expectedWorkspacePath: "/workspace/replaced.gdx",
        projectId: "default-project",
        kind: "scene",
        entityIds: ["scene-3"],
        anchorTimestamp: 3,
      }),
    ).rejects.toThrow("TIMELAPSE_GENESIS_WORKSPACE_CHANGED");
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });

  it("rolls the whole batch back when any entity is missing or foreign", async () => {
    await expect(
      mock.invoke("timelapse_genesis_baselines_append", {
        expectedWorkspacePath: "/workspace/novel.gdx",
        projectId: "default-project",
        kind: "scene",
        entityIds: ["scene-3", "missing"],
        anchorTimestamp: 4,
      }),
    ).rejects.toThrow("TIMELAPSE_GENESIS_ENTITY_NOT_FOUND");
    expect(
      await rows(
        mock,
        "SELECT entity_id FROM state_snapshots WHERE entity_id = 'scene-3'",
      ),
    ).toEqual([]);
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });
});
