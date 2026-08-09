// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db/client";
import { projects, treeNodes } from "@/db/schema";
import {
  listNodes,
  listAllNodes,
  listExpiredArchivedNodeIds,
  listNoteContents,
  listProjectSceneDocuments,
  loadProjectNarrativeSourceRows,
  loadSceneContents,
  saveSceneContent,
  updateNode,
} from "./api";

// H4 projection の回帰テスト (browser-mock = in-memory sql.js 実DB)。
// listNodes / listAllNodes は重い本文列 (content / unplacedBeatsDoc) を
// SELECT しない。本文が要る呼び出し元は listNoteContents / loadSceneContents
// で別途ロードする、という分離を実 DB の行形状で gate する。

const PROJECT_ID = "default-project";

const SCENE_DOC = JSON.stringify({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "scene body" }] },
  ],
});
const SCENE_DOC_2 = JSON.stringify({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "second body" }] },
  ],
});
const NOTE_DOC = JSON.stringify({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "note body" }] },
  ],
});

async function insertNode(
  values: { id: string; nodeType: string } & Partial<
    typeof treeNodes.$inferInsert
  >,
): Promise<void> {
  const now = new Date().toISOString();
  await db.insert(treeNodes).values({
    projectId: PROJECT_ID,
    title: values.id,
    sortOrder: "a0",
    createdAt: now,
    updatedAt: now,
    ...values,
  });
}

beforeEach(async () => {
  await db.delete(treeNodes);
});

describe("listNodes projection", () => {
  it("content / unplacedBeatsDoc を行に含めず、メタ列・preview 列・version は返す", async () => {
    await insertNode({ id: "s1", nodeType: "scene", synopsis: "あらすじ" });
    await saveSceneContent("s1", {
      content: SCENE_DOC,
      unplacedBeatsDoc: "[]",
      charCount: 10,
    });

    const rows = await listNodes(PROJECT_ID);
    expect(rows).toHaveLength(1);
    const row: Record<string, unknown> = rows[0];
    expect("content" in row).toBe(false);
    expect("unplacedBeatsDoc" in row).toBe(false);
    // 除外は 2 列だけ: 他は全部残る
    expect(row.id).toBe("s1");
    expect(row.projectId).toBe(PROJECT_ID);
    expect(row.nodeType).toBe("scene");
    expect(row.synopsis).toBe("あらすじ");
    expect(row.charCount).toBe(10);
    // saveSceneContent は本文保存ごとに version を無条件 bump する (M4 OCC) ため、
    // insert(0) → 1 回の保存で 1 になる。projection に version 列が乗ることの検証。
    expect(row.version).toBe(1);
    expect("unplacedBeatPreview" in row).toBe(true);
    expect("placedBeatPreview" in row).toBe(true);
    expect("createdAt" in row).toBe(true);
    expect("updatedAt" in row).toBe(true);
  });

  it("parentId 指定 (null / 特定 id) の分岐でも同じ projection", async () => {
    await insertNode({ id: "f1", nodeType: "folder" });
    await insertNode({
      id: "s-root",
      nodeType: "scene",
      content: SCENE_DOC,
    });
    await insertNode({
      id: "s-child",
      nodeType: "scene",
      parentId: "f1",
      content: SCENE_DOC,
    });

    const rootRows = await listNodes(PROJECT_ID, null);
    expect(rootRows.map((r) => r.id).sort()).toEqual(["f1", "s-root"]);
    for (const r of rootRows) {
      expect("content" in r).toBe(false);
      expect("unplacedBeatsDoc" in r).toBe(false);
    }

    const childRows = await listNodes(PROJECT_ID, "f1");
    expect(childRows.map((r) => r.id)).toEqual(["s-child"]);
    expect("content" in childRows[0]).toBe(false);
    expect("unplacedBeatsDoc" in childRows[0]).toBe(false);
  });
});

describe("listAllNodes projection", () => {
  it("archived 込みで返しつつ content / unplacedBeatsDoc は含めない", async () => {
    await insertNode({ id: "s1", nodeType: "scene", content: SCENE_DOC });
    await updateNode("s1", { archivedAt: new Date().toISOString() });

    expect(await listNodes(PROJECT_ID)).toHaveLength(0);

    const all = await listAllNodes(PROJECT_ID);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("s1");
    expect(all[0].archivedAt).not.toBeNull();
    expect("content" in all[0]).toBe(false);
    expect("unplacedBeatsDoc" in all[0]).toBe(false);
  });
});

describe("listExpiredArchivedNodeIds", () => {
  it("期限切れの archived row ID だけを DB 側で抽出する", async () => {
    await insertNode({
      id: "expired",
      nodeType: "scene",
      archivedAt: "2026-01-01T00:00:00.000Z",
    });
    await insertNode({
      id: "recent",
      nodeType: "scene",
      archivedAt: "2026-07-01T00:00:00.000Z",
    });
    await insertNode({ id: "live", nodeType: "scene", archivedAt: null });

    await expect(
      listExpiredArchivedNodeIds(PROJECT_ID, "2026-06-01T00:00:00.000Z"),
    ).resolves.toEqual(["expired"]);
    expect((await listAllNodes(PROJECT_ID)).map((node) => node.id)).toEqual(
      expect.arrayContaining(["expired", "recent", "live"]),
    );
  });
});

describe("listNoteContents", () => {
  it("note の content だけを id → content の Map で返す", async () => {
    await insertNode({ id: "s1", nodeType: "scene", content: SCENE_DOC });
    await insertNode({ id: "n1", nodeType: "note", content: NOTE_DOC });
    await insertNode({ id: "f1", nodeType: "folder" });

    const map = await listNoteContents(PROJECT_ID);
    expect(map.size).toBe(1);
    expect(map.get("n1")).toBe(NOTE_DOC);
    expect(map.has("s1")).toBe(false);
    expect(map.has("f1")).toBe(false);
  });
});

describe("listProjectSceneDocuments", () => {
  it("returns scene identity, title, and content without notes or folders", async () => {
    await insertNode({
      id: "s1",
      title: "Scene",
      nodeType: "scene",
      content: SCENE_DOC,
    });
    await insertNode({ id: "n1", nodeType: "note", content: NOTE_DOC });
    await insertNode({ id: "f1", nodeType: "folder" });

    await expect(listProjectSceneDocuments(PROJECT_ID)).resolves.toEqual([
      { id: "s1", title: "Scene", content: SCENE_DOC },
    ]);
  });
});

describe("loadSceneContents", () => {
  it("id → content の Map を返し、存在しない id は含めない", async () => {
    await insertNode({
      id: "s1",
      nodeType: "scene",
      content: SCENE_DOC,
      unplacedBeatsDoc: '[{"id":"b1"}]',
    });
    await insertNode({ id: "s2", nodeType: "scene", content: SCENE_DOC_2 });

    const map = await loadSceneContents(["s1", "s2", "missing"]);
    expect(map.size).toBe(2);
    expect(map.get("s1")).toBe(SCENE_DOC);
    expect(map.get("s2")).toBe(SCENE_DOC_2);
    expect(map.has("missing")).toBe(false);
  });

  it("空配列では空 Map を返す", async () => {
    const map = await loadSceneContents([]);
    expect(map.size).toBe(0);
  });
});

describe("loadProjectNarrativeSourceRows", () => {
  it("returns the authoritative source projection in requested order with stable orderIndex", async () => {
    await insertNode({ id: "source-folder", nodeType: "folder" });
    await insertNode({
      id: "source-a",
      parentId: "source-folder",
      nodeType: "scene",
      title: "First source",
      content: SCENE_DOC,
      sortOrder: "a1",
      version: 3,
      updatedAt: "2026-08-01T00:00:00.003Z",
      sourceUri: "external-root://drafts/first.md",
    });
    await insertNode({
      id: "source-b",
      parentId: "source-folder",
      nodeType: "scene",
      title: "Second source",
      content: SCENE_DOC_2,
      sortOrder: "a2",
      version: 7,
      updatedAt: "2026-08-01T00:00:00.007Z",
      sourceUri: null,
    });

    await expect(
      loadProjectNarrativeSourceRows(PROJECT_ID, ["source-b", "source-a"]),
    ).resolves.toEqual([
      {
        nodeId: "source-b",
        parentId: "source-folder",
        title: "Second source",
        content: SCENE_DOC_2,
        sortOrder: "a2",
        orderIndex: 0,
        version: 7,
        updatedAt: "2026-08-01T00:00:00.007Z",
        sourceUri: null,
      },
      {
        nodeId: "source-a",
        parentId: "source-folder",
        title: "First source",
        content: SCENE_DOC,
        sortOrder: "a1",
        orderIndex: 1,
        version: 3,
        updatedAt: "2026-08-01T00:00:00.003Z",
        sourceUri: "external-root://drafts/first.md",
      },
    ]);
  });

  it("returns only live scenes owned by the requested project", async () => {
    const otherProjectId = "narrative-source-other-project";
    const now = "2026-08-02T00:00:00.000Z";
    await db
      .insert(projects)
      .values({
        id: otherProjectId,
        title: "Other project",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    await insertNode({ id: "source-live", nodeType: "scene", updatedAt: now });
    await insertNode({
      id: "source-foreign",
      projectId: otherProjectId,
      nodeType: "scene",
      updatedAt: now,
    });
    await insertNode({ id: "source-note", nodeType: "note", updatedAt: now });
    await insertNode({
      id: "source-archived",
      nodeType: "scene",
      archivedAt: "2026-08-01T00:00:00.000Z",
      updatedAt: now,
    });

    const rows = await loadProjectNarrativeSourceRows(PROJECT_ID, [
      "source-missing",
      "source-foreign",
      "source-note",
      "source-archived",
      "source-live",
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      nodeId: "source-live",
      orderIndex: 4,
      version: 0,
      updatedAt: now,
    });
  });

  it("returns an empty array for an empty request", async () => {
    await expect(
      loadProjectNarrativeSourceRows(PROJECT_ID, []),
    ).resolves.toEqual([]);
  });

  it("loads 501 scenes across the SQLite parameter chunk boundary", async () => {
    const now = "2026-08-03T00:00:00.000Z";
    const sceneIds = Array.from(
      { length: 501 },
      (_, index) => `source-chunk-${String(index).padStart(3, "0")}`,
    );
    const inserts = sceneIds.map((id, index) => ({
      id,
      projectId: PROJECT_ID,
      nodeType: "scene",
      title: id,
      content: "{}",
      sortOrder: `a${index}`,
      version: index,
      createdAt: now,
      updatedAt: now,
    }));
    for (let index = 0; index < inserts.length; index += 100) {
      await db.insert(treeNodes).values(inserts.slice(index, index + 100));
    }
    const requestedIds = [...sceneIds].reverse();

    const rows = await loadProjectNarrativeSourceRows(
      PROJECT_ID,
      requestedIds,
    );

    expect(rows).toHaveLength(501);
    expect(rows.map((row) => row.nodeId)).toEqual(requestedIds);
    expect(rows.map((row) => row.orderIndex)).toEqual(
      Array.from({ length: 501 }, (_, index) => index),
    );
    expect(rows[499]).toMatchObject({
      nodeId: requestedIds[499],
      orderIndex: 499,
      version: 1,
    });
    expect(rows[500]).toMatchObject({
      nodeId: requestedIds[500],
      orderIndex: 500,
      version: 0,
    });
  });
});
