// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { createBrowserMock, type PersistentBrowserMock } from "./browser-mock";

const PROJECT_ID = "snapshot-loss-notice-project";
const SNAPSHOT_ID = "snapshot-loss-notice-snapshot";

async function seedSnapshot(mock: PersistentBrowserMock): Promise<void> {
  await mock.invoke("db_execute", {
    sql: "INSERT INTO projects (id, title) VALUES (?, ?)",
    params: [PROJECT_ID, "Snapshot loss notice test"],
    method: "run",
  });
  await mock.invoke("project_snapshot_create", {
    payload: {
      projectId: PROJECT_ID,
      snapshotId: SNAPSHOT_ID,
      name: "Loss notice test",
      description: null,
      createdAt: "2026-11-24T00:00:00.000Z",
      treeRows: [],
      codexRows: [],
      snippetRows: [],
      versionIds: [],
    },
  });
}

async function readLosses(mock: PersistentBrowserMock) {
  return mock.invoke<{ lossNotices?: unknown[] }>(
    "project_snapshot_restore_context",
    { projectId: PROJECT_ID, snapshotId: SNAPSHOT_ID, scopes: ["body"] },
  );
}

async function applyRestore(mock: PersistentBrowserMock) {
  return mock.invoke<{
    dropped?: unknown[];
    noOp: boolean;
  }>("project_snapshot_apply_restore", {
    payload: {
      projectId: PROJECT_ID,
      snapshotId: SNAPSHOT_ID,
      requestId: "snapshot-loss-notice-request",
      sessionId: "snapshot-loss-notice-session",
      scopes: ["body"],
      inserts: [],
    },
  });
}

describe("browser mock snapshot loss notice injection", () => {
  const mocks: PersistentBrowserMock[] = [];

  afterEach(() => {
    for (const mock of mocks.splice(0)) mock.close();
  });

  it("defaults to no notices and returns explicitly injected preview and result notices", async () => {
    const emptyMock = await createBrowserMock({
      allowProtectedWriterTestFixtures: true,
    });
    mocks.push(emptyMock);
    await seedSnapshot(emptyMock);
    expect(await readLosses(emptyMock)).toMatchObject({ lossNotices: [] });
    expect(await applyRestore(emptyMock)).toMatchObject({
      dropped: [],
      noOp: true,
    });

    const injectedNotices = [{ kind: "phase_anchor", count: 2 }];
    const injectedMock = await createBrowserMock({
      allowProtectedWriterTestFixtures: true,
      projectSnapshotRestoreLossNoticesForTest: {
        lossNotices: injectedNotices,
        dropped: injectedNotices,
      },
    });
    mocks.push(injectedMock);
    await seedSnapshot(injectedMock);
    expect(await readLosses(injectedMock)).toMatchObject({
      lossNotices: injectedNotices,
    });
    expect(await applyRestore(injectedMock)).toMatchObject({
      dropped: injectedNotices,
      noOp: true,
    });
  });
});
