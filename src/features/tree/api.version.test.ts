import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { projects, treeNodes } from "@/db/schema";
import {
  saveSceneContent,
  saveSceneBeatsOnly,
  savePlacedBeatPreviewOnly,
  updateNode,
  getSceneVersion,
} from "./api";

// scene 本文 writer (saveSceneContent) の無条件 version bump を browser-mock の
// 実 SQLite で検証する (M4: OCC version bump 配線)。
// - bump は set への 1 キー追加のみで、WHERE への version 条件 (OCC 検査) は
//   付けない — 保存 hot path を絶対に落とさない設計判断。
// - 本文を書かない writer (beats のみ / preview のみ / 構造メタ updateNode) は
//   bump しないことも同時に担保する。

const PROJECT = "tree-version-project";
const SCENE = "tree-version-scene";
const SCENE_NO_BUMP = "tree-version-scene-nobump";

const DOC = JSON.stringify({ type: "doc", content: [] });

async function versionOf(id: string): Promise<number | undefined> {
  const rows = await db
    .select({ version: treeNodes.version })
    .from(treeNodes)
    .where(eq(treeNodes.id, id));
  return rows[0]?.version;
}

beforeAll(async () => {
  const now = new Date().toISOString();
  await db
    .insert(projects)
    .values({ id: PROJECT, title: PROJECT, createdAt: now, updatedAt: now });
  await db.insert(treeNodes).values([
    {
      id: SCENE,
      projectId: PROJECT,
      nodeType: "scene",
      title: "bump",
      sortOrder: "a0",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: SCENE_NO_BUMP,
      projectId: PROJECT,
      nodeType: "scene",
      title: "no-bump",
      sortOrder: "a1",
      createdAt: now,
      updatedAt: now,
    },
  ]);
});

describe("saveSceneContent version bump", () => {
  it("保存のたびに version が +1 される (2回保存 → 2)", async () => {
    await saveSceneContent(SCENE, DOC);
    await expect(versionOf(SCENE)).resolves.toBe(1);

    await saveSceneContent(SCENE, { content: DOC, charCount: 0 });
    await expect(versionOf(SCENE)).resolves.toBe(2);
  });

  it("getSceneVersion は現在の version を返す / 不在 scene は 0", async () => {
    await expect(getSceneVersion(SCENE)).resolves.toBe(2);
    await expect(getSceneVersion("no-such-scene")).resolves.toBe(0);
  });
});

describe("本文を書かない writer は version を bump しない", () => {
  it("saveSceneBeatsOnly / savePlacedBeatPreviewOnly / updateNode", async () => {
    await saveSceneBeatsOnly(SCENE_NO_BUMP, { unplacedBeatsDoc: "[]" });
    await savePlacedBeatPreviewOnly(SCENE_NO_BUMP, null);
    await updateNode(SCENE_NO_BUMP, { title: "renamed", synopsis: "s" });
    await expect(versionOf(SCENE_NO_BUMP)).resolves.toBe(0);
  });
});
