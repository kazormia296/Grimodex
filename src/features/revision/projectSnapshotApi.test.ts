import { describe, it, expect, beforeEach } from "vitest";
import {
  createProjectSnapshot,
  listProjectSnapshots,
  restoreProjectSnapshot,
} from "./projectSnapshotApi";
import { RESTORE_SCOPES } from "./projectSnapshotScopes";

// Uses the browser-mock DB (in-memory SQLite via sql.js).

const PROJECT_ID = "default-project";
const SCENE_ID = "scene-snapshot-test";

async function resetSnapshotTables() {
  const { db } = await import("@/db/client");
  const {
    projectSnapshotEntries,
    projectSnapshotTreeNodes,
    projectSnapshotCodexEntries,
    projectSnapshotSnippets,
    projectSnapshotAux,
    projectSnapshots,
    contentVersions,
    treeNodes,
    codexEntries,
    snippets,
  } = await import("@/db/schema");
  await db.delete(projectSnapshotEntries);
  await db.delete(projectSnapshotTreeNodes);
  await db.delete(projectSnapshotCodexEntries);
  await db.delete(projectSnapshotSnippets);
  await db.delete(projectSnapshotAux);
  await db.delete(projectSnapshots);
  await db.delete(contentVersions);
  await db.delete(treeNodes);
  await db.delete(codexEntries);
  await db.delete(snippets);
}

async function seedScene(
  content: string,
  overrides: Partial<{
    id: string;
    title: string;
    parentId: string | null;
    sortOrder: string;
    status: string | null;
  }> = {},
) {
  const { db } = await import("@/db/client");
  const { treeNodes } = await import("@/db/schema");
  const now = new Date().toISOString();
  await db.insert(treeNodes).values({
    id: overrides.id ?? SCENE_ID,
    projectId: PROJECT_ID,
    parentId: overrides.parentId ?? null,
    nodeType: "scene",
    title: overrides.title ?? "Snapshot test scene",
    sortOrder: overrides.sortOrder ?? "a0",
    status: overrides.status ?? null,
    content,
    createdAt: now,
    updatedAt: now,
  });
}

async function seedFolder(id: string, title: string) {
  const { db } = await import("@/db/client");
  const { treeNodes } = await import("@/db/schema");
  const now = new Date().toISOString();
  await db.insert(treeNodes).values({
    id,
    projectId: PROJECT_ID,
    parentId: null,
    nodeType: "folder",
    title,
    sortOrder: "a0",
    content: "{}",
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

  it("marks new-format snapshots as structural", async () => {
    await seedScene('{"type":"doc","content":[{"type":"text","text":"v1"}]}');
    const snap = await createProjectSnapshot({ name: "structural-1" });
    const list = await listProjectSnapshots();
    expect(list.find((s) => s.id === snap.id)?.isStructural).toBe(true);
  });

  it("restores a snapshot and writes a safety snapshot", async () => {
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

    const result = await restoreProjectSnapshot(target.id, "checkpoint");

    expect(result.restoredCount).toBeGreaterThanOrEqual(1);
    expect(result.format).toBe("structural");
    const list = await listProjectSnapshots();
    expect(list.some((s) => s.id === result.safetySnapshotId)).toBe(true);

    const rows = await db
      .select({ content: treeNodes.content })
      .from(treeNodes)
      .where(eq(treeNodes.id, SCENE_ID));
    expect(rows[0]?.content).toBe(
      '{"type":"doc","content":[{"type":"text","text":"v1"}]}',
    );
  });

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
    expect(second.restoredCount).toBeGreaterThanOrEqual(1);
    const rows = await db
      .select({ content: treeNodes.content })
      .from(treeNodes)
      .where(eq(treeNodes.id, SCENE_ID));
    expect(rows[0]?.content).toBe(
      '{"type":"doc","content":[{"type":"text","text":"v1"}]}',
    );
  });

  // ── structural restore scenarios ──────────────────────────────

  it("restore brings back a scene deleted after snapshot", async () => {
    await seedScene('{"type":"doc","content":[{"type":"text","text":"v1"}]}');
    const target = await createProjectSnapshot({ name: "checkpoint" });

    const { db } = await import("@/db/client");
    const { treeNodes } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db.delete(treeNodes).where(eq(treeNodes.id, SCENE_ID));

    const before = await db
      .select({ id: treeNodes.id })
      .from(treeNodes)
      .where(eq(treeNodes.id, SCENE_ID));
    expect(before).toHaveLength(0);

    await restoreProjectSnapshot(target.id, "checkpoint");

    const after = await db
      .select({ id: treeNodes.id, content: treeNodes.content })
      .from(treeNodes)
      .where(eq(treeNodes.id, SCENE_ID));
    expect(after).toHaveLength(1);
    expect(after[0]?.content).toBe(
      '{"type":"doc","content":[{"type":"text","text":"v1"}]}',
    );
  });

  it("restore reverts rename / parent move / sort_order changes", async () => {
    await seedFolder("folder-A", "Folder A");
    await seedFolder("folder-B", "Folder B");
    await seedScene('{"type":"doc","content":[{"type":"text","text":"v1"}]}', {
      title: "Original Title",
      parentId: "folder-A",
      sortOrder: "a1",
    });
    const target = await createProjectSnapshot({ name: "checkpoint" });

    const { db } = await import("@/db/client");
    const { treeNodes } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db
      .update(treeNodes)
      .set({
        title: "Renamed Title",
        parentId: "folder-B",
        sortOrder: "z9",
      })
      .where(eq(treeNodes.id, SCENE_ID));

    await restoreProjectSnapshot(target.id, "checkpoint");

    const rows = await db
      .select()
      .from(treeNodes)
      .where(eq(treeNodes.id, SCENE_ID));
    expect(rows[0]?.title).toBe("Original Title");
    expect(rows[0]?.parentId).toBe("folder-A");
    expect(rows[0]?.sortOrder).toBe("a1");
  });

  it("restore removes scenes added after the snapshot", async () => {
    await seedScene('{"type":"doc","content":[{"type":"text","text":"v1"}]}');
    const target = await createProjectSnapshot({ name: "checkpoint" });

    await seedScene("{}", { id: "added-after", title: "added later" });
    await restoreProjectSnapshot(target.id, "checkpoint");

    const { db } = await import("@/db/client");
    const { treeNodes } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const survivors = await db
      .select({ id: treeNodes.id })
      .from(treeNodes)
      .where(eq(treeNodes.projectId, PROJECT_ID));
    const ids = survivors.map((r) => r.id);
    expect(ids).toContain(SCENE_ID);
    expect(ids).not.toContain("added-after");
  });

  it("legacy snapshot (no structural tables) falls back to content-only restore", async () => {
    await seedScene('{"type":"doc","content":[{"type":"text","text":"v1"}]}');
    const target = await createProjectSnapshot({ name: "checkpoint" });

    // Simulate a legacy snapshot by stripping structural data, leaving only
    // the project_snapshot_entries / content_versions pair.
    const { db } = await import("@/db/client");
    const {
      projectSnapshotTreeNodes,
      projectSnapshotCodexEntries,
      projectSnapshotSnippets,
      projectSnapshotAux,
      treeNodes,
    } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db
      .delete(projectSnapshotTreeNodes)
      .where(eq(projectSnapshotTreeNodes.snapshotId, target.id));
    await db
      .delete(projectSnapshotCodexEntries)
      .where(eq(projectSnapshotCodexEntries.snapshotId, target.id));
    await db
      .delete(projectSnapshotSnippets)
      .where(eq(projectSnapshotSnippets.snapshotId, target.id));
    await db
      .delete(projectSnapshotAux)
      .where(eq(projectSnapshotAux.snapshotId, target.id));

    // Mutate scene content, then restore: legacy path UPDATES content.
    await db
      .update(treeNodes)
      .set({
        content: '{"type":"doc","content":[{"type":"text","text":"v2"}]}',
      })
      .where(eq(treeNodes.id, SCENE_ID));
    const result = await restoreProjectSnapshot(target.id, "checkpoint");

    expect(result.format).toBe("legacy");
    const rows = await db
      .select({ content: treeNodes.content })
      .from(treeNodes)
      .where(eq(treeNodes.id, SCENE_ID));
    expect(rows[0]?.content).toBe(
      '{"type":"doc","content":[{"type":"text","text":"v1"}]}',
    );
  });

  it("scope selection: restoring with empty body scope still restores codex if selected", async () => {
    // Seed a codex entry + scene, snapshot, then change codex name. Restore
    // with only `codex` scope.
    const { db } = await import("@/db/client");
    const { codexEntries, treeNodes } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const now = new Date().toISOString();

    await db.insert(codexEntries).values({
      id: "cx-1",
      projectId: PROJECT_ID,
      type: "character",
      name: "Original Name",
      contextMode: "mentioned",
      childrenBudget: "compact",
      content: "{}",
      createdAt: now,
      updatedAt: now,
    });
    await seedScene('{"type":"doc","content":[{"type":"text","text":"v1"}]}');
    const target = await createProjectSnapshot({ name: "checkpoint" });

    // Mutate codex name AND scene content
    await db
      .update(codexEntries)
      .set({ name: "Renamed" })
      .where(eq(codexEntries.id, "cx-1"));
    await db
      .update(treeNodes)
      .set({
        content: '{"type":"doc","content":[{"type":"text","text":"v2"}]}',
      })
      .where(eq(treeNodes.id, SCENE_ID));

    const result = await restoreProjectSnapshot(target.id, "checkpoint", {
      scopes: new Set(["codex"]),
    });
    expect(result.format).toBe("structural");

    const cx = await db
      .select({ name: codexEntries.name })
      .from(codexEntries)
      .where(eq(codexEntries.id, "cx-1"));
    expect(cx[0]?.name).toBe("Original Name");

    // Scene content NOT restored because body scope was excluded
    const scene = await db
      .select({ content: treeNodes.content })
      .from(treeNodes)
      .where(eq(treeNodes.id, SCENE_ID));
    expect(scene[0]?.content).toBe(
      '{"type":"doc","content":[{"type":"text","text":"v2"}]}',
    );
  });

  it("restore preserves original created_at / updated_at instead of writing 'now'", async () => {
    const { db } = await import("@/db/client");
    const { treeNodes } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");

    const ORIGINAL_CREATED = "2024-01-15T10:30:00.000Z";
    const ORIGINAL_UPDATED = "2024-02-20T14:45:00.000Z";
    await db.insert(treeNodes).values({
      id: SCENE_ID,
      projectId: PROJECT_ID,
      parentId: null,
      nodeType: "scene",
      title: "older scene",
      sortOrder: "a0",
      content: '{"type":"doc","content":[{"type":"text","text":"v1"}]}',
      createdAt: ORIGINAL_CREATED,
      updatedAt: ORIGINAL_UPDATED,
    });
    const target = await createProjectSnapshot({ name: "checkpoint" });

    // Delete the scene so restore goes through the INSERT path
    await db.delete(treeNodes).where(eq(treeNodes.id, SCENE_ID));
    await restoreProjectSnapshot(target.id, "checkpoint");

    const rows = await db
      .select()
      .from(treeNodes)
      .where(eq(treeNodes.id, SCENE_ID));
    expect(rows[0]?.createdAt).toBe(ORIGINAL_CREATED);
    expect(rows[0]?.updatedAt).toBe(ORIGINAL_UPDATED);
  });

  it("isStructural detection works for codex-only projects (no tree_nodes)", async () => {
    const { db } = await import("@/db/client");
    const { codexEntries } = await import("@/db/schema");
    const now = new Date().toISOString();
    await db.insert(codexEntries).values({
      id: "cx-only",
      projectId: PROJECT_ID,
      type: "character",
      name: "Solo Codex",
      contextMode: "mentioned",
      childrenBudget: "compact",
      content: "{}",
      createdAt: now,
      updatedAt: now,
    });
    const snap = await createProjectSnapshot({ name: "codex-only" });
    const list = await listProjectSnapshots();
    expect(list.find((s) => s.id === snap.id)?.isStructural).toBe(true);
  });

  it("RESTORE_SCOPES exposes all 7 user-facing scope ids", () => {
    expect(RESTORE_SCOPES).toEqual([
      "body",
      "codex",
      "snippet",
      "map",
      "foreshadow",
      "labels",
      "lint",
    ]);
  });

  it("captures only the current project's aux rows (project-scoped)", async () => {
    const { db } = await import("@/db/client");
    const { labels, projects, projectSnapshotAux } =
      await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db.delete(labels);
    const now = new Date().toISOString();
    // labels.project_id is a FK; both projects must exist in the shared DB.
    await db
      .insert(projects)
      .values([
        { id: PROJECT_ID, title: "A", createdAt: now, updatedAt: now },
        { id: "proj-b", title: "B", createdAt: now, updatedAt: now },
      ])
      .onConflictDoNothing();
    // Two projects share one workspace DB. The snapshot of PROJECT_ID must
    // not vacuum up proj-b's labels (would collide on restore re-INSERT).
    await db.insert(labels).values([
      {
        id: "lbl-a",
        projectId: PROJECT_ID,
        name: "A-label",
        color: "red",
        sortOrder: 0,
        createdAt: now,
      },
      {
        id: "lbl-b",
        projectId: "proj-b",
        name: "B-label",
        color: "blue",
        sortOrder: 0,
        createdAt: now,
      },
    ]);

    const snap = await createProjectSnapshot({ name: "scoped-capture" });

    const auxRows = await db
      .select()
      .from(projectSnapshotAux)
      .where(eq(projectSnapshotAux.snapshotId, snap.id));
    const labelsAux = auxRows.find((r) => r.scope === "labels");
    const captured = (
      JSON.parse(labelsAux?.payloadJson ?? '{"rows":[]}') as {
        rows: { id: string }[];
      }
    ).rows.map((r) => r.id);
    expect(captured).toContain("lbl-a");
    expect(captured).not.toContain("lbl-b");

    await db.delete(labels);
  });

  it("restore leaves another project's aux rows untouched", async () => {
    const { db } = await import("@/db/client");
    const { labels, projects } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db.delete(labels);
    const now = new Date().toISOString();
    await db
      .insert(projects)
      .values([
        { id: PROJECT_ID, title: "A", createdAt: now, updatedAt: now },
        { id: "proj-b", title: "B", createdAt: now, updatedAt: now },
      ])
      .onConflictDoNothing();
    await db.insert(labels).values([
      {
        id: "lbl-a",
        projectId: PROJECT_ID,
        name: "A-label",
        color: "red",
        sortOrder: 0,
        createdAt: now,
      },
      {
        id: "lbl-b",
        projectId: "proj-b",
        name: "B-label",
        color: "blue",
        sortOrder: 0,
        createdAt: now,
      },
    ]);

    const snap = await createProjectSnapshot({ name: "scoped-restore" });
    // Mutate the current project's labels after the snapshot.
    await db.delete(labels).where(eq(labels.id, "lbl-a"));

    await restoreProjectSnapshot(snap.id, "scoped-restore", {
      scopes: new Set(["labels"]),
    });

    const remaining = await db.select().from(labels);
    const ids = remaining.map((r) => r.id);
    // proj-b survived the restore wipe; PROJECT_ID's label came back.
    expect(ids).toContain("lbl-b");
    expect(ids).toContain("lbl-a");

    await db.delete(labels);
  });
});
