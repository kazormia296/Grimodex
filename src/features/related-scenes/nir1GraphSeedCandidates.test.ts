import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import {
  readNir1GraphSeedEntryName,
  selectNir1GraphSeedCandidates,
} from "./nir1GraphSeedCandidates";

// 起点の候補（DR-SEEDSUG-2）。DB の用意は `nir1GraphSeed.test.ts` と同じ
// （in-memory の sql.js）。
const P1 = "suggest-project-1";
const P2 = "suggest-project-2";

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

async function entry(id: string, projectId = P1, name = `name ${id}`) {
  await db.insert(codexEntries).values({
    id,
    projectId,
    type: "character",
    name,
    content: "{}",
  });
}

async function mention(
  sceneId: string,
  codexEntryId: string,
  source: string,
  role = "mentioned",
): Promise<void> {
  await db
    .insert(sceneCodexMentions)
    .values({ sceneId, codexEntryId, source, role });
}

async function pin(sceneId: string, entryId: string, createdAt: string) {
  await db.insert(sceneCodexPins).values({ sceneId, entryId, createdAt });
}

const ids = async (sceneId: string, projectId = P1) =>
  (await selectNir1GraphSeedCandidates(projectId, sceneId)).map((candidate) => [
    candidate.entryId,
    candidate.reason,
  ]);

// One in-memory database for the file (a fresh sql.js per test runs out of
// memory); every test empties the tables it uses.
beforeAll(async () => {
  installBrowserMock(
    await createBrowserMock({ allowProtectedWriterTestFixtures: true }),
  );
});

beforeEach(async () => {
  publishCurrentProjectId(P1);
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

describe("selectNir1GraphSeedCandidates", () => {
  it("orders the POV character, then beat actors, then body mentions, at most 3", async () => {
    for (const id of ["e-pov", "e-act", "e-body", "e-sem"]) await entry(id);
    await scene("s1", P1, { povCharacterId: "e-pov" });
    await mention("s1", "e-body", "body");
    await mention("s1", "e-act", "beat", "actor");
    await mention("s1", "e-sem", "semantic");

    expect(await ids("s1")).toEqual([
      ["e-pov", "pov"],
      ["e-act", "beat-actor"],
      ["e-body", "body"],
    ]);
    const [first] = await selectNir1GraphSeedCandidates(P1, "s1");
    expect(first?.name).toBe("name e-pov");
  });

  it("breaks ties by entry_id ascending, whatever the insertion order", async () => {
    for (const id of ["e-c", "e-a", "e-b", "b-z", "b-y"]) await entry(id);
    await scene("s1");
    await mention("s1", "e-c", "beat", "actor");
    await mention("s1", "e-a", "beat", "actor");
    await mention("s1", "b-z", "body");
    await mention("s1", "b-y", "semantic");
    await mention("s1", "e-b", "beat", "actor");

    expect(await ids("s1")).toEqual([
      ["e-a", "beat-actor"],
      ["e-b", "beat-actor"],
      ["e-c", "beat-actor"],
    ]);

    await db.delete(sceneCodexMentions);
    await mention("s1", "b-z", "body");
    await mention("s1", "b-y", "semantic");
    expect(await ids("s1")).toEqual([
      ["b-y", "body"],
      ["b-z", "body"],
    ]);
  });

  it("lists an entry once, under its highest rank", async () => {
    for (const id of ["e-pov", "e-act"]) await entry(id);
    await scene("s1", P1, { povCharacterId: "e-pov" });
    await mention("s1", "e-pov", "beat", "actor");
    await mention("s1", "e-pov", "body");
    await mention("s1", "e-act", "beat", "actor");
    await mention("s1", "e-act", "semantic");

    expect(await ids("s1")).toEqual([
      ["e-pov", "pov"],
      ["e-act", "beat-actor"],
    ]);
  });

  it("leaves out beat roles other than actor and the relation source", async () => {
    for (const id of ["e-target", "e-mentioned", "e-relation"]) await entry(id);
    await scene("s1");
    await mention("s1", "e-target", "beat", "target");
    await mention("s1", "e-mentioned", "beat", "mentioned");
    await mention("s1", "e-relation", "relation");

    expect(await ids("s1")).toEqual([]);
  });

  it("never offers an entry of another project, as POV or as a mention", async () => {
    await entry("e-other", P2);
    await entry("e-mine");
    await scene("s1", P1, { povCharacterId: "e-other" });
    await mention("s1", "e-other", "beat", "actor");
    await mention("s1", "e-mine", "body");

    expect(await ids("s1")).toEqual([["e-mine", "body"]]);
  });

  it("offers nothing for an archived scene, a scene of another project or a non-scene node", async () => {
    await entry("e1");
    await entry("e2", P2);
    await scene("s-archived", P1, {
      povCharacterId: "e1",
      archivedAt: "2026-01-01T00:00:00.000Z",
    });
    await scene("s-other", P2, { povCharacterId: "e2" });
    await scene("n1", P1, { nodeType: "note", povCharacterId: "e1" });
    for (const sceneId of ["s-archived", "s-other", "n1"])
      await mention(sceneId, "e1", "body");

    expect(await ids("s-archived")).toEqual([]);
    expect(await ids("s-other")).toEqual([]);
    expect(await ids("n1")).toEqual([]);
    expect(await ids("missing")).toEqual([]);
  });

  it("leaves out an entry already pinned to this scene, not one pinned elsewhere", async () => {
    for (const id of ["e-pov", "e-act", "e-body"]) await entry(id);
    await scene("s1", P1, { povCharacterId: "e-pov" });
    await scene("s2");
    await mention("s1", "e-act", "beat", "actor");
    await mention("s1", "e-body", "body");
    await pin("s1", "e-pov", "2026-01-01T00:00:00.000Z");
    await pin("s2", "e-act", "2026-01-01T00:00:00.000Z");

    expect(await ids("s1")).toEqual([
      ["e-act", "beat-actor"],
      ["e-body", "body"],
    ]);
  });

  it("starts with the beat actors when the scene has no POV, or a POV that is not a Codex entry here", async () => {
    await entry("e-act");
    await entry("e-elsewhere", P2);
    await scene("s-none");
    await scene("s-elsewhere", P1, { povCharacterId: "e-elsewhere" });
    await mention("s-none", "e-act", "beat", "actor");
    await mention("s-elsewhere", "e-act", "beat", "actor");

    expect(await ids("s-none")).toEqual([["e-act", "beat-actor"]]);
    expect(await ids("s-elsewhere")).toEqual([["e-act", "beat-actor"]]);

    // An entry that was deleted: the POV is set to null by the foreign key.
    await entry("e-gone");
    await db
      .update(treeNodes)
      .set({ povCharacterId: "e-gone" })
      .where(eq(treeNodes.id, "s-none"));
    await db.delete(codexEntries).where(eq(codexEntries.id, "e-gone"));
    expect(await ids("s-none")).toEqual([["e-act", "beat-actor"]]);
  });

  it("never offers an id that could not be a seed (blank or over 200 UTF-16)", async () => {
    await entry("   ");
    await entry("x".repeat(201));
    await entry("e-ok");
    await scene("s1", P1, { povCharacterId: "   " });
    await mention("s1", "x".repeat(201), "beat", "actor");
    await mention("s1", "e-ok", "body");

    expect(await ids("s1")).toEqual([["e-ok", "body"]]);
  });

  it("writes nothing", async () => {
    for (const id of ["e-pov", "e-act"]) await entry(id);
    await scene("s1", P1, { povCharacterId: "e-pov" });
    await mention("s1", "e-act", "beat", "actor");
    const before = await db.select().from(sceneCodexPins);

    await selectNir1GraphSeedCandidates(P1, "s1");

    expect(await db.select().from(sceneCodexPins)).toEqual(before);
    expect(before).toEqual([]);
  });
});

describe("readNir1GraphSeedEntryName", () => {
  it("names the seed selectNir1GraphSeed picks, the first of several pins", async () => {
    for (const id of ["e-b", "e-a", "e-c"]) await entry(id);
    await scene("s1");
    await pin("s1", "e-c", "2026-01-02T00:00:00.000Z");
    await pin("s1", "e-b", "2026-01-01T00:00:00.000Z");
    await pin("s1", "e-a", "2026-01-01T00:00:00.000Z");

    const seed = await selectNir1GraphSeed(P1, "s1");
    expect(seed).toBe("e-a");
    expect(await readNir1GraphSeedEntryName(P1, seed!)).toBe("name e-a");
  });

  it("does not name an entry of another project", async () => {
    await entry("e-other", P2);
    expect(await readNir1GraphSeedEntryName(P1, "e-other")).toBeNull();
  });
});
