import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db/client";
import {
  codexEntries,
  projects,
  sceneCodexMentions,
  sceneCodexPins,
  treeNodes,
} from "@/db/schema";
import { createBrowserMock } from "@/lib/browser-mock";
import { installBrowserMock } from "@/lib/tauri";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { selectNir1GraphSeed } from "./nir1GraphSeed";

// The rule of Native's `read_nir1_graph_seed_in_tx` on the in-memory sql.js
// database (DR-DI1A-6, DR-CP3B-3).
const P1 = "seed-project-1";
const P2 = "seed-project-2";

async function scene(
  id: string,
  projectId = P1,
  extra: Partial<typeof treeNodes.$inferInsert> = {},
): Promise<void> {
  const now = new Date().toISOString();
  await db.insert(treeNodes).values({
    id,
    projectId,
    nodeType: "scene",
    title: id,
    sortOrder: "a0",
    createdAt: now,
    updatedAt: now,
    ...extra,
  });
}

async function entry(id: string, projectId = P1): Promise<void> {
  await db.insert(codexEntries).values({
    id,
    projectId,
    type: "character",
    name: id,
    content: "{}",
  });
}

async function pin(
  sceneId: string,
  entryId: string,
  createdAt: string,
): Promise<void> {
  await db.insert(sceneCodexPins).values({ sceneId, entryId, createdAt });
}

beforeEach(async () => {
  publishCurrentProjectId(P1);
  installBrowserMock(
    await createBrowserMock({ allowProtectedWriterTestFixtures: true }),
  );
  const now = new Date().toISOString();
  await db.delete(sceneCodexMentions);
  await db.delete(sceneCodexPins);
  await db.delete(treeNodes);
  await db.delete(codexEntries);
  await db.delete(projects);
  await db.insert(projects).values([
    { id: P1, title: "One", createdAt: now, updatedAt: now },
    { id: P2, title: "Two", createdAt: now, updatedAt: now },
  ]);
});

describe("selectNir1GraphSeed", () => {
  it("returns no seed when the scene has no pin", async () => {
    await scene("s1");
    await entry("e1");

    expect(await selectNir1GraphSeed(P1, "s1")).toBeNull();
  });

  it("picks the earliest created_at, then the smallest entry_id", async () => {
    await scene("s1");
    for (const id of ["e-b", "e-a", "e-c"]) await entry(id);
    await pin("s1", "e-c", "2026-01-02T00:00:00.000Z");
    await pin("s1", "e-b", "2026-01-01T00:00:00.000Z");
    await pin("s1", "e-a", "2026-01-01T00:00:00.000Z");

    expect(await selectNir1GraphSeed(P1, "s1")).toBe("e-a");
  });

  it("ignores a pin of an archived scene, of a scene in another project, or of an entry in another project", async () => {
    await scene("s-archived", P1, { archivedAt: "2026-01-01T00:00:00.000Z" });
    await scene("s-other", P2);
    await scene("s1");
    await entry("e-mine");
    await entry("e-other", P2);
    await pin("s-archived", "e-mine", "2026-01-01T00:00:00.000Z");
    await pin("s-other", "e-mine", "2026-01-01T00:00:00.000Z");
    await pin("s1", "e-other", "2026-01-01T00:00:00.000Z");

    expect(await selectNir1GraphSeed(P1, "s-archived")).toBeNull();
    expect(await selectNir1GraphSeed(P1, "s-other")).toBeNull();
    expect(await selectNir1GraphSeed(P1, "s1")).toBeNull();

    await pin("s1", "e-mine", "2026-01-03T00:00:00.000Z");
    expect(await selectNir1GraphSeed(P1, "s1")).toBe("e-mine");
  });

  it("ignores a pin on a non-scene node", async () => {
    await scene("n1", P1, { nodeType: "note" });
    await entry("e1");
    await pin("n1", "e1", "2026-01-01T00:00:00.000Z");

    expect(await selectNir1GraphSeed(P1, "n1")).toBeNull();
  });

  it("returns no seed for an empty, blank or over-200-UTF-16 entry id", async () => {
    for (const [sceneId, entryId] of [
      ["s-empty", ""],
      ["s-blank", "   "],
      ["s-long", "x".repeat(201)],
    ] as const) {
      await scene(sceneId);
      await entry(entryId);
      await pin(sceneId, entryId, "2026-01-01T00:00:00.000Z");
      expect(await selectNir1GraphSeed(P1, sceneId)).toBeNull();
    }
    await scene("s-edge");
    await entry("y".repeat(200));
    await pin("s-edge", "y".repeat(200), "2026-01-01T00:00:00.000Z");
    expect(await selectNir1GraphSeed(P1, "s-edge")).toBe("y".repeat(200));
  });

  it("decides on the first pin only and does not fall through to the next one", async () => {
    await scene("s1");
    await entry("   ");
    await entry("e-valid");
    await pin("s1", "   ", "2026-01-01T00:00:00.000Z");
    await pin("s1", "e-valid", "2026-01-02T00:00:00.000Z");

    expect(await selectNir1GraphSeed(P1, "s1")).toBeNull();
  });
});
