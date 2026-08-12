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
    editorStickies,
    treeNodes,
    codexEntries,
    snippets,
    plotThreads,
    plotThreadSceneLinks,
    plotThreadBranches,
  } = await import("@/db/schema");
  await db.delete(editorStickies);
  await db.delete(projectSnapshotEntries);
  await db.delete(projectSnapshotTreeNodes);
  await db.delete(projectSnapshotCodexEntries);
  await db.delete(projectSnapshotSnippets);
  await db.delete(projectSnapshotAux);
  await db.delete(projectSnapshots);
  await db.delete(contentVersions);
  // plot tables child-first (branches/links FK threads + tree_nodes).
  await db.delete(plotThreadBranches);
  await db.delete(plotThreadSceneLinks);
  await db.delete(plotThreads);
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

  it("listProjectSnapshots attributes entryCount to the right snapshot (batched count, no N+1 bleed)", async () => {
    // First snapshot captures one scene → entryCount 1.
    await seedScene('{"type":"doc","content":[{"type":"text","text":"v1"}]}', {
      id: "s1",
      sortOrder: "a0",
    });
    const one = await createProjectSnapshot({ name: "one-scene" });
    expect(one.entryCount).toBe(1);

    // Add a second scene, then a second snapshot → entryCount 2.
    await seedScene('{"type":"doc","content":[{"type":"text","text":"w1"}]}', {
      id: "s2",
      sortOrder: "a1",
    });
    const two = await createProjectSnapshot({ name: "two-scenes" });
    expect(two.entryCount).toBe(2);

    // The batched GROUP BY must map each aggregate count back to its own
    // snapshot; a mis-keyed Map would swap or share these counts.
    const list = await listProjectSnapshots();
    const oneMeta = list.find((s) => s.id === one.id);
    const twoMeta = list.find((s) => s.id === two.id);
    expect(oneMeta?.entryCount).toBe(1);
    expect(twoMeta?.entryCount).toBe(2);
    expect(oneMeta?.isStructural).toBe(true);
    expect(twoMeta?.isStructural).toBe(true);
  });

  it("create→restore preserves scene intent", async () => {
    await seedScene('{"type":"doc","content":[]}');
    const { db } = await import("@/db/client");
    const { treeNodes } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db
      .update(treeNodes)
      .set({ intent: "読者に緊張を与える" })
      .where(eq(treeNodes.id, SCENE_ID));

    const snap = await createProjectSnapshot({ name: "with-intent" });
    await db
      .update(treeNodes)
      .set({ intent: null })
      .where(eq(treeNodes.id, SCENE_ID));

    await restoreProjectSnapshot(snap.id, "with-intent");

    const rows = await db
      .select({ intent: treeNodes.intent })
      .from(treeNodes)
      .where(eq(treeNodes.id, SCENE_ID));
    expect(rows[0]?.intent).toBe("読者に緊張を与える");
  });

  it("create→restore preserves scene chronicle (作中暦日付) fields", async () => {
    await seedScene('{"type":"doc","content":[]}');
    const { db } = await import("@/db/client");
    const { treeNodes } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    // interval 日付 + 時刻 + 粒度 + 確度をシーンに設定。
    await db
      .update(treeNodes)
      .set({
        chronicleStartTime: 1234,
        chronicleStartMinute: 615,
        chronicleStartGranularity: "time",
        chronicleEndTime: 1240,
        chronicleEndMinute: 720,
        chronicleEndGranularity: "day",
        chroniclePrecision: "approx",
      })
      .where(eq(treeNodes.id, SCENE_ID));

    const snap = await createProjectSnapshot({ name: "with-chronicle" });

    // スナップショット後に別状態へ変更（日付を消す）。
    await db
      .update(treeNodes)
      .set({
        chronicleStartTime: null,
        chronicleStartMinute: null,
        chronicleStartGranularity: "none",
        chronicleEndTime: null,
        chronicleEndMinute: null,
        chronicleEndGranularity: "none",
        chroniclePrecision: "exact",
      })
      .where(eq(treeNodes.id, SCENE_ID));

    await restoreProjectSnapshot(snap.id, "with-chronicle");

    const rows = await db
      .select({
        chronicleStartTime: treeNodes.chronicleStartTime,
        chronicleStartMinute: treeNodes.chronicleStartMinute,
        chronicleStartGranularity: treeNodes.chronicleStartGranularity,
        chronicleEndTime: treeNodes.chronicleEndTime,
        chronicleEndMinute: treeNodes.chronicleEndMinute,
        chronicleEndGranularity: treeNodes.chronicleEndGranularity,
        chroniclePrecision: treeNodes.chroniclePrecision,
      })
      .from(treeNodes)
      .where(eq(treeNodes.id, SCENE_ID));
    expect(rows[0]).toEqual({
      chronicleStartTime: 1234,
      chronicleStartMinute: 615,
      chronicleStartGranularity: "time",
      chronicleEndTime: 1240,
      chronicleEndMinute: 720,
      chronicleEndGranularity: "day",
      chroniclePrecision: "approx",
    });
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

  it("skips an editor sticky when a map-only restore excludes its missing body owner", async () => {
    await seedScene('{"type":"doc","content":[]}');
    const { db } = await import("@/db/client");
    const { editorStickies, treeNodes } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");

    await db.insert(editorStickies).values({
      id: "editor-sticky-snapshot",
      projectId: PROJECT_ID,
      documentKey: "tree:database:scene-snapshot-test",
      body: '{"type":"doc","content":[]}',
      paletteId: "post-it-playful",
      colorSlot: 0,
      inlineOffset: 12,
      blockOffset: 24,
      zIndex: 0,
      treeNodeId: SCENE_ID,
    });
    const target = await createProjectSnapshot({ name: "sticky-owner" });

    await db.delete(editorStickies);
    await db.delete(treeNodes).where(eq(treeNodes.id, SCENE_ID));

    const result = await restoreProjectSnapshot(target.id, "sticky-owner", {
      scopes: new Set(["map"]),
    });

    expect(result.skipped.editorStickies).toBe(1);
    expect(await db.select().from(editorStickies)).toEqual([]);
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

  it("every aux capture predicate references real columns (no typos)", async () => {
    // The capture wraps each predicate in try/catch to tolerate tables that
    // the mock DB omits — but that also masks a typo'd column as an empty
    // payload, i.e. silent data loss on restore. Run each predicate (for the
    // tables this DB has) and require it to resolve, so a bad column rejects
    // loudly here instead.
    const { AUX_SCOPES, AUX_TABLE, AUX_PROJECT_FILTER } =
      await import("./projectSnapshotScopes");
    const { invoke } = await import("@/lib/tauri");
    let checked = 0;
    for (const scope of AUX_SCOPES) {
      const table = AUX_TABLE[scope];
      const present = (await invoke("db_execute", {
        sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        params: [table],
        method: "all",
      })) as { rows: unknown[] };
      if (present.rows.length === 0) continue;
      const filter = AUX_PROJECT_FILTER[scope];
      await expect(
        invoke("db_execute", {
          sql: `SELECT * FROM "${table}" WHERE ${filter.where}`,
          params: Array(filter.binds).fill("no-such-project"),
          method: "all",
        }),
      ).resolves.toBeDefined();
      checked++;
    }
    // Sanity: the mock has enough aux tables to make this meaningful.
    expect(checked).toBeGreaterThanOrEqual(10);
  });

  it("scopes map_stickies via its board's project (via-parent subquery)", async () => {
    const { db } = await import("@/db/client");
    const { projects, mapBoards, mapStickies, projectSnapshotAux } =
      await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const now = new Date().toISOString();
    await db
      .insert(projects)
      .values([
        { id: PROJECT_ID, title: "A", createdAt: now, updatedAt: now },
        { id: "proj-b", title: "B", createdAt: now, updatedAt: now },
      ])
      .onConflictDoNothing();
    await db.delete(mapStickies);
    await db.delete(mapBoards);
    await db.insert(mapBoards).values([
      { id: "board-a", projectId: PROJECT_ID, createdAt: now, updatedAt: now },
      { id: "board-b", projectId: "proj-b", createdAt: now, updatedAt: now },
    ]);
    // Raw insert: the mock's map_stickies omits some drizzle columns
    // (e.g. ai_derived), so a full drizzle insert would reject. Seed only the
    // columns the predicate cares about.
    const { invoke } = await import("@/lib/tauri");
    for (const [id, boardId] of [
      ["stk-a", "board-a"],
      ["stk-b", "board-b"],
    ]) {
      await invoke("db_execute", {
        sql: "INSERT INTO map_stickies (id, board_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
        params: [id, boardId, now, now],
        method: "run",
      });
    }

    const snap = await createProjectSnapshot({ name: "map-scoped" });
    const aux = await db
      .select()
      .from(projectSnapshotAux)
      .where(eq(projectSnapshotAux.snapshotId, snap.id));
    const stickies = (
      JSON.parse(
        aux.find((r) => r.scope === "map_stickies")?.payloadJson ??
          '{"rows":[]}',
      ) as { rows: { id: string }[] }
    ).rows.map((r) => r.id);
    expect(stickies).toContain("stk-a");
    expect(stickies).not.toContain("stk-b");

    await db.delete(mapStickies);
    await db.delete(mapBoards);
  });

  it("scopes authorship_spans by its anchor's project (5-way OR)", async () => {
    const { db } = await import("@/db/client");
    const { projects, codexEntries, authorshipSpans, projectSnapshotAux } =
      await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const now = new Date().toISOString();
    await db
      .insert(projects)
      .values([
        { id: PROJECT_ID, title: "A", createdAt: now, updatedAt: now },
        { id: "proj-b", title: "B", createdAt: now, updatedAt: now },
      ])
      .onConflictDoNothing();
    await db.delete(authorshipSpans);
    await db.delete(codexEntries);
    await db.insert(codexEntries).values([
      {
        id: "cx-a",
        projectId: PROJECT_ID,
        type: "character",
        name: "A",
        contextMode: "mentioned",
        childrenBudget: "compact",
        content: "{}",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "cx-b",
        projectId: "proj-b",
        type: "character",
        name: "B",
        contextMode: "mentioned",
        childrenBudget: "compact",
        content: "{}",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    // Anchor one span to A's codex entry, one to B's — exercises the OR's
    // codex_entry_id branch.
    await db.insert(authorshipSpans).values([
      {
        id: "as-a",
        codexEntryId: "cx-a",
        fromPos: 0,
        toPos: 1,
        source: "human",
      },
      {
        id: "as-b",
        codexEntryId: "cx-b",
        fromPos: 0,
        toPos: 1,
        source: "human",
      },
    ]);

    const snap = await createProjectSnapshot({ name: "authorship-scoped" });
    const aux = await db
      .select()
      .from(projectSnapshotAux)
      .where(eq(projectSnapshotAux.snapshotId, snap.id));
    const spans = (
      JSON.parse(
        aux.find((r) => r.scope === "authorship_spans")?.payloadJson ??
          '{"rows":[]}',
      ) as { rows: { id: string }[] }
    ).rows.map((r) => r.id);
    expect(spans).toContain("as-a");
    expect(spans).not.toContain("as-b");

    await db.delete(authorshipSpans);
    await db.delete(codexEntries);
  });

  it("body restore preserves plot-thread markers and branches (regression #1)", async () => {
    const { db } = await import("@/db/client");
    const { treeNodes, plotThreads, plotThreadSceneLinks, plotThreadBranches } =
      await import("@/db/schema");
    const { eq } = await import("drizzle-orm");

    // Two scenes, two threads, a marker on each, and a branch A→B at S1.
    await seedScene('{"type":"doc","content":[]}', {
      id: "s1",
      sortOrder: "a0",
    });
    await seedScene('{"type":"doc","content":[]}', {
      id: "s2",
      sortOrder: "a1",
    });
    await db.insert(plotThreads).values([
      { id: "t-a", projectId: PROJECT_ID, name: "A", sortOrder: "a0" },
      { id: "t-b", projectId: PROJECT_ID, name: "B", sortOrder: "a1" },
    ]);
    await db.insert(plotThreadSceneLinks).values([
      { id: "m-a", threadId: "t-a", nodeId: "s1", phaseType: "develop" },
      { id: "m-b", threadId: "t-b", nodeId: "s2", phaseType: "develop" },
    ]);
    await db.insert(plotThreadBranches).values({
      id: "br-1",
      projectId: PROJECT_ID,
      fromThreadId: "t-a",
      toThreadId: "t-b",
      atNodeId: "s1",
      kind: "branch",
    });

    const snap = await createProjectSnapshot({ name: "plot-checkpoint" });

    // Edit after snapshot: delete s1 → CASCADE removes marker m-a and branch
    // br-1 (both FK tree_nodes). This is the data-loss surface.
    await db.delete(treeNodes).where(eq(treeNodes.id, "s1"));
    expect(
      await db
        .select()
        .from(plotThreadBranches)
        .where(eq(plotThreadBranches.id, "br-1")),
    ).toHaveLength(0);

    // Body restore must bring back the scene AND its plot markers/branches.
    await restoreProjectSnapshot(snap.id, "plot-checkpoint");

    const links = await db.select().from(plotThreadSceneLinks);
    const branches = await db.select().from(plotThreadBranches);
    const threads = await db.select().from(plotThreads);
    expect(threads.map((t) => t.id).sort()).toEqual(["t-a", "t-b"]);
    expect(links.map((l) => l.id).sort()).toEqual(["m-a", "m-b"]);
    expect(branches.map((b) => b.id)).toEqual(["br-1"]);
    expect(branches[0]?.atNodeId).toBe("s1");
  });

  it("registers all five Chronicle tables as body-owned aux scopes (data-loss fix)", async () => {
    const { AUX_SCOPES, AUX_SCOPE_OWNER, AUX_TABLE, AUX_PROJECT_FILTER } =
      await import("./projectSnapshotScopes");
    const chronicle = [
      "events",
      "event_relations",
      "scene_events",
      "event_participants",
      "project_calendar",
    ] as const;
    for (const scope of chronicle) {
      expect(AUX_SCOPES).toContain(scope);
      expect(AUX_SCOPE_OWNER[scope]).toBe("body");
      expect(AUX_TABLE[scope]).toBe(scope);
      // capture predicate must scope to the current project (one bound id).
      expect(AUX_PROJECT_FILTER[scope]?.where).toContain("?");
      expect(AUX_PROJECT_FILTER[scope]?.binds).toBe(1);
    }
    // events must precede its children so restore re-inserts parents first.
    const idx = (s: string) => (AUX_SCOPES as readonly string[]).indexOf(s);
    expect(idx("events")).toBeLessThan(idx("scene_events"));
    expect(idx("events")).toBeLessThan(idx("event_participants"));
    expect(idx("events")).toBeLessThan(idx("event_relations"));
  });

  it("body+codex restore brings back Chronicle events, scene links, relations and calendar (regression)", async () => {
    const { invoke } = await import("@/lib/tauri");
    const { db } = await import("@/db/client");
    const { codexEntries } = await import("@/db/schema");
    const now = new Date().toISOString();

    type Rows<T> = { rows: T[] };
    const run = (sql: string, params: (string | number | null)[] = []) =>
      invoke("db_execute", { sql, params, method: "run" });
    const all = <T>(sql: string, params: (string | number | null)[] = []) =>
      invoke("db_execute", { sql, params, method: "all" }) as Promise<Rows<T>>;

    // browser-mock omits the Chronicle tables; create them here so the
    // capture→restore round-trip exercises the real path (FKs mirror schema.ts).
    await run(`CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      note TEXT,
      ordinal TEXT NOT NULL DEFAULT 'a0',
      primary_codex_id TEXT REFERENCES codex_entries(id) ON DELETE SET NULL,
      location_codex_id TEXT REFERENCES codex_entries(id) ON DELETE SET NULL,
      start_time INTEGER,
      end_time INTEGER,
      precision TEXT NOT NULL DEFAULT 'exact',
      kind TEXT NOT NULL DEFAULT 'generic',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await run(`CREATE TABLE IF NOT EXISTS event_relations (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      cause_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      effect_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      PRIMARY KEY (cause_event_id, effect_event_id)
    )`);
    await run(`CREATE TABLE IF NOT EXISTS scene_events (
      scene_id TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      PRIMARY KEY (scene_id, event_id)
    )`);
    await run(`CREATE TABLE IF NOT EXISTS event_participants (
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      codex_entry_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
      role TEXT,
      PRIMARY KEY (event_id, codex_entry_id)
    )`);
    await run(`CREATE TABLE IF NOT EXISTS project_calendar (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      days_per_year INTEGER NOT NULL DEFAULT 360,
      season_boundaries TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    // Start clean (resetSnapshotTables does not know the Chronicle tables).
    // Child-first so FK CASCADE order is irrelevant.
    for (const t of [
      "scene_events",
      "event_participants",
      "event_relations",
      "project_calendar",
      "events",
    ]) {
      await run(`DELETE FROM ${t}`);
    }

    // Seed: a scene, a codex character, two events (e1 has a codex home lane),
    // a scene↔event link, a participant, a causal edge e1→e2, and a calendar.
    await seedScene('{"type":"doc","content":[]}', {
      id: "s1",
      sortOrder: "a0",
    });
    await db.insert(codexEntries).values({
      id: "cx-1",
      projectId: PROJECT_ID,
      type: "character",
      name: "Hero",
      contextMode: "mentioned",
      childrenBudget: "compact",
      content: "{}",
      createdAt: now,
      updatedAt: now,
    });
    await run(
      "INSERT INTO events (id, project_id, title, note, ordinal, primary_codex_id, location_codex_id, start_time, end_time, precision, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        "e1",
        PROJECT_ID,
        "誕生",
        null,
        "a0",
        "cx-1",
        null,
        0,
        null,
        "exact",
        "birth",
        now,
        now,
      ],
    );
    await run(
      "INSERT INTO events (id, project_id, title, note, ordinal, primary_codex_id, location_codex_id, start_time, end_time, precision, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        "e2",
        PROJECT_ID,
        "旅立ち",
        null,
        "a1",
        null,
        null,
        10,
        null,
        "exact",
        "generic",
        now,
        now,
      ],
    );
    await run("INSERT INTO scene_events (scene_id, event_id) VALUES (?,?)", [
      "s1",
      "e1",
    ]);
    await run(
      "INSERT INTO event_participants (event_id, codex_entry_id, role) VALUES (?,?,?)",
      ["e1", "cx-1", "protagonist"],
    );
    await run(
      "INSERT INTO event_relations (project_id, cause_event_id, effect_event_id) VALUES (?,?,?)",
      [PROJECT_ID, "e1", "e2"],
    );
    await run(
      "INSERT INTO project_calendar (project_id, days_per_year, season_boundaries, version, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      [PROJECT_ID, 400, "[]", 7, now, "2000-01-01T00:00:00.000Z"],
    );

    const snap = await createProjectSnapshot({ name: "chronicle-checkpoint" });

    // Data loss after snapshot: deleting events cascades scene_events /
    // event_participants / event_relations. The live Calendar continues to a
    // later OCC generation before the old body snapshot is restored.
    await run("DELETE FROM events WHERE project_id = ?", [PROJECT_ID]);
    await run(
      "UPDATE project_calendar SET days_per_year = ?, version = ? WHERE project_id = ?",
      [999, 12, PROJECT_ID],
    );
    expect(
      (
        await all<{ id: string }>(
          "SELECT id FROM events WHERE project_id = ?",
          [PROJECT_ID],
        )
      ).rows,
    ).toHaveLength(0);

    // Restore with body (owns Chronicle) + codex (so primary_codex_id is kept).
    await restoreProjectSnapshot(snap.id, "chronicle-checkpoint", {
      scopes: new Set(["body", "codex"]),
    });

    const ev = await all<{ id: string; primary_codex_id: string | null }>(
      "SELECT id, primary_codex_id FROM events WHERE project_id = ? ORDER BY id",
      [PROJECT_ID],
    );
    expect(ev.rows.map((r) => r.id)).toEqual(["e1", "e2"]);
    expect(ev.rows.find((r) => r.id === "e1")?.primary_codex_id).toBe("cx-1");

    const links = await all<{ scene_id: string; event_id: string }>(
      "SELECT scene_id, event_id FROM scene_events WHERE event_id IN (SELECT id FROM events WHERE project_id = ?)",
      [PROJECT_ID],
    );
    expect(links.rows).toEqual([{ scene_id: "s1", event_id: "e1" }]);

    const rels = await all<{ cause_event_id: string; effect_event_id: string }>(
      "SELECT cause_event_id, effect_event_id FROM event_relations WHERE project_id = ?",
      [PROJECT_ID],
    );
    expect(rels.rows).toEqual([
      { cause_event_id: "e1", effect_event_id: "e2" },
    ]);

    const parts = await all<{ event_id: string; codex_entry_id: string }>(
      "SELECT event_id, codex_entry_id FROM event_participants WHERE event_id IN (SELECT id FROM events WHERE project_id = ?)",
      [PROJECT_ID],
    );
    expect(parts.rows).toEqual([{ event_id: "e1", codex_entry_id: "cx-1" }]);

    const cal = await all<{
      days_per_year: number;
      version: number;
      updated_at: string;
    }>(
      "SELECT days_per_year, version, updated_at FROM project_calendar WHERE project_id = ?",
      [PROJECT_ID],
    );
    expect(cal.rows[0]?.days_per_year).toBe(400);
    expect(cal.rows[0]?.version).toBe(13);
    expect(cal.rows[0]?.updated_at).not.toBe("2000-01-01T00:00:00.000Z");

    // Neither the snapshot generation nor the live generation observed just
    // before restore may become valid again after the restore operation.
    await run(
      "UPDATE project_calendar SET days_per_year = 401, version = version + 1 WHERE project_id = ? AND version = ?",
      [PROJECT_ID, 7],
    );
    await run(
      "UPDATE project_calendar SET days_per_year = 402, version = version + 1 WHERE project_id = ? AND version = ?",
      [PROJECT_ID, 12],
    );
    const afterStaleWrites = await all<{
      days_per_year: number;
      version: number;
    }>(
      "SELECT days_per_year, version FROM project_calendar WHERE project_id = ?",
      [PROJECT_ID],
    );
    expect(afterStaleWrites.rows).toEqual([
      { days_per_year: 400, version: 13 },
    ]);

    const calendarAux = await all<{ payload_json: string }>(
      "SELECT payload_json FROM project_snapshot_aux WHERE snapshot_id = ? AND scope = 'project_calendar'",
      [snap.id],
    );
    const malformedCalendarPayload = JSON.parse(
      calendarAux.rows[0]!.payload_json,
    ) as { rows: Array<Record<string, unknown>> };
    for (const malformedVersion of [null, "7"]) {
      malformedCalendarPayload.rows[0]!.version = malformedVersion;
      await run(
        "UPDATE project_snapshot_aux SET payload_json = ? WHERE snapshot_id = ? AND scope = 'project_calendar'",
        [JSON.stringify(malformedCalendarPayload), snap.id],
      );
      await expect(
        restoreProjectSnapshot(snap.id, "chronicle-checkpoint", {
          scopes: new Set(["body", "codex"]),
        }),
      ).rejects.toThrow(/snapshot project_calendar version|snapshot version/);
    }
    const afterMalformedRestore = await all<{
      days_per_year: number;
      version: number;
    }>(
      "SELECT days_per_year, version FROM project_calendar WHERE project_id = ?",
      [PROJECT_ID],
    );
    expect(afterMalformedRestore.rows).toEqual([
      { days_per_year: 400, version: 13 },
    ]);

    // Cleanup (child-first) so other tests / re-runs start fresh.
    for (const t of [
      "scene_events",
      "event_participants",
      "event_relations",
      "project_calendar",
      "events",
    ]) {
      await run(`DELETE FROM ${t}`);
    }
  });

  it("Chronicle scope を持たない古い structural snapshot の body restore は現在の Chronicle を消さない", async () => {
    const { invoke } = await import("@/lib/tauri");
    const now = new Date().toISOString();

    type Rows<T> = { rows: T[] };
    const run = (sql: string, params: (string | number | null)[] = []) =>
      invoke("db_execute", { sql, params, method: "run" });
    const all = <T>(sql: string, params: (string | number | null)[] = []) =>
      invoke("db_execute", { sql, params, method: "all" }) as Promise<Rows<T>>;

    await run(`CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT '',
      note TEXT,
      ordinal TEXT NOT NULL DEFAULT 'a0',
      primary_codex_id TEXT REFERENCES codex_entries(id) ON DELETE SET NULL,
      location_codex_id TEXT REFERENCES codex_entries(id) ON DELETE SET NULL,
      start_time INTEGER,
      end_time INTEGER,
      precision TEXT NOT NULL DEFAULT 'exact',
      kind TEXT NOT NULL DEFAULT 'generic',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await run(`CREATE TABLE IF NOT EXISTS event_relations (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      cause_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      effect_event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      PRIMARY KEY (cause_event_id, effect_event_id)
    )`);
    await run(`CREATE TABLE IF NOT EXISTS scene_events (
      scene_id TEXT NOT NULL REFERENCES tree_nodes(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      PRIMARY KEY (scene_id, event_id)
    )`);
    await run(`CREATE TABLE IF NOT EXISTS event_participants (
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      codex_entry_id TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
      role TEXT,
      PRIMARY KEY (event_id, codex_entry_id)
    )`);
    await run(`CREATE TABLE IF NOT EXISTS project_calendar (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      days_per_year INTEGER NOT NULL DEFAULT 360,
      season_boundaries TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);

    for (const t of [
      "scene_events",
      "event_participants",
      "event_relations",
      "project_calendar",
      "events",
    ]) {
      await run(`DELETE FROM ${t}`);
    }

    await seedScene('{"type":"doc","content":[]}', {
      id: "old-scope-scene",
      sortOrder: "b0",
    });
    const snap = await createProjectSnapshot({ name: "pre-chronicle-struct" });

    // Simulate a structural snapshot created before Chronicle scopes existed:
    // keep other aux rows so the snapshot remains structural, but remove the
    // Chronicle aux rows that old builds could not have captured.
    await run(
      `DELETE FROM project_snapshot_aux
       WHERE snapshot_id = ?
         AND scope IN ('events','event_relations','scene_events','event_participants','project_calendar')`,
      [snap.id],
    );

    await run(
      "INSERT INTO events (id, project_id, title, note, ordinal, primary_codex_id, location_codex_id, start_time, end_time, precision, kind, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [
        "live-after-old-snapshot",
        PROJECT_ID,
        "古いCP後に作った出来事",
        null,
        "z0",
        null,
        null,
        1,
        null,
        "exact",
        "generic",
        now,
        now,
      ],
    );
    await run(
      "INSERT INTO project_calendar (project_id, days_per_year, season_boundaries, created_at, updated_at) VALUES (?,?,?,?,?)",
      [PROJECT_ID, 360, "[]", now, now],
    );

    await restoreProjectSnapshot(snap.id, "pre-chronicle-struct", {
      scopes: new Set(["body"]),
    });

    const ev = await all<{ id: string }>(
      "SELECT id FROM events WHERE project_id = ?",
      [PROJECT_ID],
    );
    expect(ev.rows.map((r) => r.id)).toContain("live-after-old-snapshot");

    for (const t of [
      "scene_events",
      "event_participants",
      "event_relations",
      "project_calendar",
      "events",
    ]) {
      await run(`DELETE FROM ${t}`);
    }
  });
});
