import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/db/client";
import { projects, codexEntries, snippets } from "@/db/schema";
import { listCodexEntries } from "@/features/codex/api";
import { listSnippets } from "@/features/snippets/api";

// Exercises the real browser-mock in-memory SQLite. Regression guard for the
// pre-Phase-1 bug where listCodexEntries / listSnippets returned rows from
// every Project: with two Projects present, each query must return only the
// rows scoped to the Project id it was given.

const PROJECT_A = "scope-test-a";
const PROJECT_B = "scope-test-b";

beforeAll(async () => {
  const now = new Date().toISOString();
  for (const id of [PROJECT_A, PROJECT_B]) {
    await db
      .insert(projects)
      .values({ id, title: id, createdAt: now, updatedAt: now });
    // The canonical project trigger seeds the character type before entries
    // are inserted, satisfying the composite foreign key.
  }
  await db.insert(codexEntries).values([
    {
      id: "ce-a",
      projectId: PROJECT_A,
      type: "character",
      name: "A character",
    },
    {
      id: "ce-b",
      projectId: PROJECT_B,
      type: "character",
      name: "B character",
    },
  ]);
  await db.insert(snippets).values([
    { id: "sn-a", projectId: PROJECT_A, title: "A snippet", content: "{}" },
    { id: "sn-b", projectId: PROJECT_B, title: "B snippet", content: "{}" },
  ]);
});

describe("project scoping", () => {
  it("listCodexEntries returns only the given Project's entries", async () => {
    const a = (await listCodexEntries(PROJECT_A)).map((e) => e.id);
    expect(a).toContain("ce-a");
    expect(a).not.toContain("ce-b");

    const b = (await listCodexEntries(PROJECT_B)).map((e) => e.id);
    expect(b).toContain("ce-b");
    expect(b).not.toContain("ce-a");
  });

  it("listCodexEntries with a type filter stays within the Project", async () => {
    const a = await listCodexEntries(PROJECT_A, "character");
    expect(a.map((e) => e.id)).toEqual(["ce-a"]);
  });

  it("listSnippets returns only the given Project's snippets", async () => {
    const a = (await listSnippets(PROJECT_A)).map((s) => s.id);
    expect(a).toContain("sn-a");
    expect(a).not.toContain("sn-b");

    const b = (await listSnippets(PROJECT_B)).map((s) => s.id);
    expect(b).toEqual(["sn-b"]);
  });
});
