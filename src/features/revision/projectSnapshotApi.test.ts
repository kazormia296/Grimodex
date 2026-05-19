import { describe, it, expect, beforeEach } from "vitest";
import {
  createProjectSnapshot,
  listProjectSnapshots,
  restoreProjectSnapshot,
} from "./projectSnapshotApi";

// Uses the browser-mock DB (in-memory SQLite via sql.js).

const PROJECT_ID = "default-project";
const SCENE_ID = "scene-snapshot-test";

async function resetSnapshotTables() {
  const { db } = await import("@/db/client");
  const {
    projectSnapshotEntries,
    projectSnapshots,
    contentVersions,
    treeNodes,
  } = await import("@/db/schema");
  await db.delete(projectSnapshotEntries);
  await db.delete(projectSnapshots);
  await db.delete(contentVersions);
  await db.delete(treeNodes);
}

async function seedScene(content: string) {
  const { db } = await import("@/db/client");
  const { treeNodes } = await import("@/db/schema");
  const now = new Date().toISOString();
  await db.insert(treeNodes).values({
    id: SCENE_ID,
    projectId: PROJECT_ID,
    parentId: null,
    nodeType: "scene",
    title: "Snapshot test scene",
    sortOrder: "a0",
    content,
    createdAt: now,
    updatedAt: now,
  });
}

describe("projectSnapshotApi", () => {
  beforeEach(async () => {
    await resetSnapshotTables();
  });

  it("creates a snapshot capturing the current scene content", async () => {
    await seedScene('{"type":"doc","content":[{"type":"text","text":"v1"}]}');

    const snap = await createProjectSnapshot({ name: "draft-1" });

    expect(snap.entryCount).toBe(1);
    const list = await listProjectSnapshots();
    expect(list.find((s) => s.id === snap.id)?.name).toBe("draft-1");
  });

  it("restores a snapshot and writes a safety snapshot", async () => {
    await seedScene('{"type":"doc","content":[{"type":"text","text":"v1"}]}');
    const target = await createProjectSnapshot({ name: "checkpoint" });

    // Mutate the scene so restore actually has work to do
    const { db } = await import("@/db/client");
    const { treeNodes } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db
      .update(treeNodes)
      .set({
        content: '{"type":"doc","content":[{"type":"text","text":"v2"}]}',
      })
      .where(eq(treeNodes.id, SCENE_ID));

    const result = await restoreProjectSnapshot(target.id, "checkpoint");

    expect(result.restoredCount).toBe(1);
    // Safety snapshot was created and is present alongside the target
    const list = await listProjectSnapshots();
    expect(list.some((s) => s.id === result.safetySnapshotId)).toBe(true);

    // Scene reverted to the captured v1 content
    const rows = await db
      .select({ content: treeNodes.content })
      .from(treeNodes)
      .where(eq(treeNodes.id, SCENE_ID));
    expect(rows[0]?.content).toBe(
      '{"type":"doc","content":[{"type":"text","text":"v1"}]}',
    );
  });

  // Regression: the safety snapshot name used to be a fixed string
  // (`Before restore to '<name>'`), so restoring the same snapshot twice
  // tripped UNIQUE(project_id, name) on project_snapshots and the entire
  // restore failed. Each restore must now produce a uniquely-named safety
  // snapshot.
  it("can restore the same snapshot multiple times without UNIQUE violation", async () => {
    await seedScene('{"type":"doc","content":[{"type":"text","text":"v1"}]}');
    const target = await createProjectSnapshot({ name: "checkpoint" });

    const { db } = await import("@/db/client");
    const { treeNodes } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");

    await db
      .update(treeNodes)
      .set({
        content: '{"type":"doc","content":[{"type":"text","text":"v2"}]}',
      })
      .where(eq(treeNodes.id, SCENE_ID));
    const first = await restoreProjectSnapshot(target.id, "checkpoint");

    await db
      .update(treeNodes)
      .set({
        content: '{"type":"doc","content":[{"type":"text","text":"v3"}]}',
      })
      .where(eq(treeNodes.id, SCENE_ID));
    const second = await restoreProjectSnapshot(target.id, "checkpoint");

    expect(first.safetySnapshotId).not.toBe(second.safetySnapshotId);
    expect(second.restoredCount).toBe(1);
    const rows = await db
      .select({ content: treeNodes.content })
      .from(treeNodes)
      .where(eq(treeNodes.id, SCENE_ID));
    expect(rows[0]?.content).toBe(
      '{"type":"doc","content":[{"type":"text","text":"v1"}]}',
    );
  });
});
