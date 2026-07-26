import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { projectSettings, projects, treeNodes } from "@/db/schema";
import {
  isBodyMentionIndexReady,
  recordBodyMentionScans,
} from "./bodyMentionIndexState";

const PROJECT_ID = "body-mention-index-state-test";
const entries = [
  {
    id: "entry-1",
    name: "太郎",
    type: "character",
    aliases: null,
    excludedAliases: null,
  },
];

async function insertScene(id: string, version = 1): Promise<void> {
  const updatedAt = `2026-07-13T00:00:0${version}.000Z`;
  await db.insert(treeNodes).values({
    id,
    projectId: PROJECT_ID,
    nodeType: "scene",
    title: id,
    sortOrder: id,
    content: "{}",
    version,
    createdAt: updatedAt,
    updatedAt,
  });
}

beforeEach(async () => {
  await db
    .delete(projectSettings)
    .where(eq(projectSettings.projectId, PROJECT_ID));
  await db.delete(treeNodes).where(eq(treeNodes.projectId, PROJECT_ID));
  await db
    .insert(projects)
    .values({
      id: PROJECT_ID,
      title: PROJECT_ID,
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
});

describe("body mention index state", () => {
  it("treats scanned scenes with zero mention rows as ready", async () => {
    await insertScene("scene-1");
    await insertScene("scene-2");

    await recordBodyMentionScans(PROJECT_ID, entries, [
      {
        sceneId: "scene-1",
        version: 1,
        updatedAt: "2026-07-13T00:00:01.000Z",
      },
      {
        sceneId: "scene-2",
        version: 1,
        updatedAt: "2026-07-13T00:00:01.000Z",
      },
    ]);

    await expect(isBodyMentionIndexReady(PROJECT_ID, entries)).resolves.toBe(
      true,
    );
  });

  it("does not accept an eighty-percent partial scan as complete", async () => {
    for (let i = 1; i <= 5; i += 1) await insertScene(`scene-${i}`);

    await recordBodyMentionScans(
      PROJECT_ID,
      entries,
      [1, 2, 3, 4].map((i) => ({
        sceneId: `scene-${i}`,
        version: 1,
        updatedAt: "2026-07-13T00:00:01.000Z",
      })),
    );

    await expect(isBodyMentionIndexReady(PROJECT_ID, entries)).resolves.toBe(
      false,
    );
  });

  it("invalidates the marker when scene content revision changes", async () => {
    await insertScene("scene-1");
    await recordBodyMentionScans(PROJECT_ID, entries, [
      {
        sceneId: "scene-1",
        version: 1,
        updatedAt: "2026-07-13T00:00:01.000Z",
      },
    ]);

    await db
      .update(treeNodes)
      .set({ version: 2, updatedAt: "2026-07-13T00:00:02.000Z" })
      .where(eq(treeNodes.id, "scene-1"));

    await expect(isBodyMentionIndexReady(PROJECT_ID, entries)).resolves.toBe(
      false,
    );
  });

  it("invalidates the marker when matcher patterns change", async () => {
    await insertScene("scene-1");
    await recordBodyMentionScans(PROJECT_ID, entries, [
      {
        sceneId: "scene-1",
        version: 1,
        updatedAt: "2026-07-13T00:00:01.000Z",
      },
    ]);

    await expect(
      isBodyMentionIndexReady(PROJECT_ID, [
        { ...entries[0], aliases: JSON.stringify(["タロウ"]) },
      ]),
    ).resolves.toBe(false);
  });
});
