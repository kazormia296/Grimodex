import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
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

// scene 本文 writer (saveSceneContent) の version bump と、editor が渡す
// baseVersion の OCC 検査を browser-mock の実 SQLite で検証する。
// baseVersion を省略する headless writer は無条件保存を維持する。
// - beats-only writer も tree_nodes aggregate の OCC version を進める。

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

afterEach(() => {
  vi.useRealTimers();
});

describe("saveSceneContent version bump", () => {
  it("保存のたびに version が +1 される (2回保存 → 2)", async () => {
    const first = await saveSceneContent(SCENE, DOC);
    expect(first.contentVersion).toBe(1);
    await expect(versionOf(SCENE)).resolves.toBe(1);

    const second = await saveSceneContent(SCENE, {
      content: DOC,
      charCount: 0,
    });
    expect(second.contentVersion).toBe(2);
    await expect(versionOf(SCENE)).resolves.toBe(2);
  });

  it("getSceneVersion は現在の version を返す / 不在 scene は 0", async () => {
    await expect(getSceneVersion(SCENE)).resolves.toBe(2);
    await expect(getSceneVersion("no-such-scene")).resolves.toBe(0);
  });

  it("stale baseVersion は本文と version を変更しない", async () => {
    const currentVersion = await getSceneVersion(SCENE);
    await expect(
      saveSceneContent(SCENE, {
        content: "first",
        baseVersion: currentVersion,
      }),
    ).resolves.toMatchObject({ contentVersion: currentVersion + 1 });

    await expect(
      saveSceneContent(SCENE, {
        content: "stale",
        baseVersion: currentVersion,
      }),
    ).rejects.toThrow(/conflict/i);
    await expect(versionOf(SCENE)).resolves.toBe(currentVersion + 1);
  });
});

describe("本文を書かない writer の version 契約", () => {
  it("saveSceneBeatsOnly は OCC version を bump し、preview-only/metadata は bump しない", async () => {
    await saveSceneBeatsOnly(SCENE_NO_BUMP, {
      unplacedBeatsDoc: "[]",
      projectId: PROJECT,
      baseVersion: 0,
    });
    await savePlacedBeatPreviewOnly(SCENE_NO_BUMP, null);
    await updateNode(SCENE_NO_BUMP, { title: "renamed", synopsis: "s" });
    await expect(versionOf(SCENE_NO_BUMP)).resolves.toBe(1);
  });

  it("saveSceneBeatsOnly は stale baseVersion を拒否する", async () => {
    await expect(
      saveSceneBeatsOnly(SCENE_NO_BUMP, {
        unplacedBeatsDoc: "[1]",
        projectId: PROJECT,
        baseVersion: 0,
      }),
    ).rejects.toThrow(/conflict/i);
    await expect(versionOf(SCENE_NO_BUMP)).resolves.toBe(1);
  });

  it("同一millisecondの連続metadata writeにも単調増加するISO OCC tokenを付ける", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2100-01-01T00:00:00.000Z"));

    const first = await updateNode(SCENE_NO_BUMP, { title: "first" });
    const second = await updateNode(SCENE_NO_BUMP, { title: "second" });

    expect(first?.updatedAt).toBe("2100-01-01T00:00:00.000Z");
    expect(second?.updatedAt).toBe("2100-01-01T00:00:00.001Z");
    expect(Number.isNaN(Date.parse(first?.updatedAt ?? ""))).toBe(false);
    expect(Number.isNaN(Date.parse(second?.updatedAt ?? ""))).toBe(false);
  });
});
