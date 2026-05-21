import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db/client";
import {
  projects,
  codexTypes,
  codexEntries,
  codexDetailDefinitions,
  codexDetailValues,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { listCodexEntries } from "@/features/codex/api";
import { seedCodexTypesFromProject } from "./seedCodexTypes";
import { PROJECT_ID } from "./constants";

const SOURCE = PROJECT_ID;
const TARGET = "seed-target-project";

beforeEach(async () => {
  const now = new Date().toISOString();
  await db.delete(projects);
  await db.insert(projects).values([
    { id: SOURCE, title: "Source", createdAt: now, updatedAt: now },
    { id: TARGET, title: "Target", createdAt: now, updatedAt: now },
  ]);
  await db.insert(codexTypes).values([
    {
      id: "src-type-char",
      projectId: SOURCE,
      slug: "character",
      label: "Characters",
      color: "#111111",
      isBuiltin: 1,
      sortOrder: 0,
    },
    {
      id: "src-type-faction",
      projectId: SOURCE,
      slug: "faction",
      label: "Factions",
      color: "#222222",
      isBuiltin: 0,
      sortOrder: 5,
    },
    {
      id: "tgt-type-char",
      projectId: TARGET,
      slug: "character",
      label: "キャラクター",
      color: "#333333",
      isBuiltin: 1,
      sortOrder: 0,
    },
  ]);
});

describe("seedCodexTypesFromProject", () => {
  it("copies entries and detail values for selected types with remapped ids", async () => {
    await db.insert(codexDetailDefinitions).values({
      id: "def-age",
      projectId: SOURCE,
      typeSlug: "character",
      name: "Age",
      fieldType: "text",
      sortOrder: 0,
      includeInContext: 1,
    });
    await db.insert(codexEntries).values([
      {
        id: "entry-parent",
        projectId: SOURCE,
        type: "character",
        name: "Parent Hero",
        content: "{}",
      },
      {
        id: "entry-child",
        projectId: SOURCE,
        type: "character",
        parentId: "entry-parent",
        name: "Child Hero",
        content: "{}",
      },
    ]);
    await db.insert(codexDetailValues).values({
      id: "val-age",
      entryId: "entry-parent",
      definitionId: "def-age",
      value: "20",
    });

    await seedCodexTypesFromProject(SOURCE, TARGET, ["character"]);

    const targetEntries = await listCodexEntries(TARGET, "character");
    expect(targetEntries).toHaveLength(2);
    expect(targetEntries.map((e) => e.name).sort()).toEqual([
      "Child Hero",
      "Parent Hero",
    ]);
    expect(targetEntries.every((e) => e.projectId === TARGET)).toBe(true);
    expect(
      targetEntries.every(
        (e) => !["entry-parent", "entry-child"].includes(e.id),
      ),
    ).toBe(true);

    const child = targetEntries.find((e) => e.name === "Child Hero");
    const parent = targetEntries.find((e) => e.name === "Parent Hero");
    expect(child?.parentId).toBe(parent?.id);

    const targetDefs = await db
      .select()
      .from(codexDetailDefinitions)
      .where(eq(codexDetailDefinitions.projectId, TARGET));
    expect(targetDefs.some((d) => d.name === "Age")).toBe(true);

    const targetValues = await db
      .select()
      .from(codexDetailValues)
      .where(eq(codexDetailValues.entryId, parent!.id));
    expect(targetValues).toHaveLength(1);
    expect(targetValues[0].value).toBe("20");
  });

  it("copies custom codex types that do not exist on the target project", async () => {
    await db.insert(codexEntries).values({
      id: "entry-faction",
      projectId: SOURCE,
      type: "faction",
      name: "Rebels",
      content: "{}",
    });

    await seedCodexTypesFromProject(SOURCE, TARGET, ["faction"]);

    const targetTypes = await db
      .select()
      .from(codexTypes)
      .where(eq(codexTypes.projectId, TARGET));
    expect(targetTypes.some((t) => t.slug === "faction")).toBe(true);

    const targetEntries = await listCodexEntries(TARGET, "faction");
    expect(targetEntries).toHaveLength(1);
    expect(targetEntries[0].name).toBe("Rebels");
  });

  it("does not copy entries from unselected types", async () => {
    await db.insert(codexEntries).values({
      id: "entry-faction-only",
      projectId: SOURCE,
      type: "faction",
      name: "Hidden Faction",
      content: "{}",
    });

    await seedCodexTypesFromProject(SOURCE, TARGET, ["character"]);

    const factionEntries = await listCodexEntries(TARGET, "faction");
    expect(factionEntries).toHaveLength(0);
  });
});
