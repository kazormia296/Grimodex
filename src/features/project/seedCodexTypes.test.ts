import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { db } from "@/db/client";
import {
  projects,
  codexTypes,
  codexEntries,
  codexDetailDefinitions,
  codexDetailValues,
  codexTags,
  codexEntryTags,
  narrativeChangeTransactions,
} from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { listCodexEntries } from "@/features/codex/api";
import { seedCodexTypesFromProject } from "./seedCodexTypes";
import { PROJECT_ID } from "./constants";
import { createBrowserMock } from "@/lib/browser-mock";
import { installBrowserMock } from "@/lib/tauri";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";

const SOURCE = PROJECT_ID;
const TARGET = "seed-target-project";

beforeEach(async () => {
  publishCurrentProjectId(TARGET);
  installBrowserMock(
    await createBrowserMock({ allowProtectedWriterTestFixtures: true }),
  );
  const now = new Date().toISOString();
  // This suite intentionally reuses the shared browser database. Clear the
  // fixture's dependent rows explicitly because canonical foreign keys now
  // match the desktop database and do not permit deleting referenced projects.
  await db.delete(codexEntryTags);
  await db.delete(codexDetailValues);
  await db.delete(codexDetailDefinitions);
  await db.delete(codexTags);
  await db.delete(codexEntries);
  await db.delete(codexTypes);
  await db.delete(projects);
  await db.insert(projects).values([
    { id: SOURCE, title: "Source", createdAt: now, updatedAt: now },
    { id: TARGET, title: "Target", createdAt: now, updatedAt: now },
  ]);
  // Project creation seeds the built-in types through the canonical DB
  // trigger. Customize those rows instead of inserting duplicate slugs.
  await db
    .update(codexTypes)
    .set({ label: "Characters", color: "#111111" })
    .where(
      and(eq(codexTypes.projectId, SOURCE), eq(codexTypes.slug, "character")),
    );
  await db
    .update(codexTypes)
    .set({ label: "キャラクター", color: "#333333" })
    .where(
      and(eq(codexTypes.projectId, TARGET), eq(codexTypes.slug, "character")),
    );
  await db.insert(codexTypes).values({
    id: "src-type-faction",
    projectId: SOURCE,
    slug: "faction",
    label: "Factions",
    color: "#222222",
    isBuiltin: 0,
    sortOrder: 5,
  });
});

afterEach(() => {
  publishCurrentProjectId(null);
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

    const importTransactions = await db
      .select({ origin: narrativeChangeTransactions.origin })
      .from(narrativeChangeTransactions)
      .where(eq(narrativeChangeTransactions.projectId, TARGET));
    expect(importTransactions.length).toBeGreaterThan(0);
    expect(importTransactions.every(({ origin }) => origin === "import")).toBe(
      true,
    );
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

  it("copies codex tags and entry-tag links for seeded entries", async () => {
    await db.insert(codexEntries).values({
      id: "entry-tagged",
      projectId: SOURCE,
      type: "character",
      name: "Tagged Hero",
      content: "{}",
    });
    await db.insert(codexTags).values({
      id: "src-tag-pro",
      projectId: SOURCE,
      name: "protagonist",
      color: "#abcabc",
    });
    await db.insert(codexEntryTags).values({
      entryId: "entry-tagged",
      tagId: "src-tag-pro",
    });

    await seedCodexTypesFromProject(SOURCE, TARGET, ["character"]);

    const targetTags = await db
      .select()
      .from(codexTags)
      .where(eq(codexTags.projectId, TARGET));
    const newTag = targetTags.find((t) => t.name === "protagonist");
    expect(newTag).toBeDefined();
    expect(newTag!.id).not.toBe("src-tag-pro");

    const tagged = (await listCodexEntries(TARGET, "character")).find(
      (e) => e.name === "Tagged Hero",
    );
    expect(tagged).toBeDefined();
    const links = await db
      .select()
      .from(codexEntryTags)
      .where(eq(codexEntryTags.entryId, tagged!.id));
    expect(links).toHaveLength(1);
    expect(links[0].tagId).toBe(newTag!.id);
  });

  it("updates an existing target type's appearance from the source", async () => {
    await db.insert(codexEntries).values({
      id: "entry-appearance",
      projectId: SOURCE,
      type: "character",
      name: "Appearance Probe",
      content: "{}",
    });

    await seedCodexTypesFromProject(SOURCE, TARGET, ["character"]);

    const [targetChar] = await db
      .select()
      .from(codexTypes)
      .where(
        and(eq(codexTypes.projectId, TARGET), eq(codexTypes.slug, "character")),
      );
    expect(targetChar.label).toBe("Characters");
    expect(targetChar.color).toBe("#111111");
  });
});
