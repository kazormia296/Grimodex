import { describe, it, expect, beforeEach } from "vitest";
import { useTermDictionaryStore } from "./termDictionaryStore";
import { useProjectStore } from "@/features/project/projectStore";

// Exercises the project-scoped term dictionary against the browser-mock
// (in-memory SQLite). lint_term_dictionary gained a project_id column so two
// projects sharing one workspace DB keep independent dictionaries.

const PROJECT_A = "default-project";
const PROJECT_B = "proj-b";

async function reset() {
  const { db } = await import("@/db/client");
  const { projects, lintTermDictionary } = await import("@/db/schema");
  const now = new Date().toISOString();
  await db
    .insert(projects)
    .values([
      { id: PROJECT_A, title: "A", createdAt: now, updatedAt: now },
      { id: PROJECT_B, title: "B", createdAt: now, updatedAt: now },
    ])
    .onConflictDoNothing();
  await db.delete(lintTermDictionary);
  useTermDictionaryStore.setState({
    rows: [],
    isLoaded: false,
    loading: false,
  });
}

function setProject(id: string) {
  useProjectStore.setState({ currentProjectId: id });
}

function clearStoreRows() {
  useTermDictionaryStore.setState({ rows: [], isLoaded: false });
}

beforeEach(reset);

describe("termDictionaryStore project scoping", () => {
  it("keeps each project's dictionary isolated", async () => {
    setProject(PROJECT_A);
    const ra = await useTermDictionaryStore.getState().upsert({
      preferred: "色",
      variants: ["いろ"],
      severity: "warning",
      note: null,
      enabled: true,
    });
    expect(ra.ok).toBe(true);

    setProject(PROJECT_B);
    clearStoreRows();
    const rb = await useTermDictionaryStore.getState().upsert({
      preferred: "夜",
      variants: ["よる"],
      severity: "warning",
      note: null,
      enabled: true,
    });
    expect(rb.ok).toBe(true);

    // Project B loads only its own entry.
    clearStoreRows();
    await useTermDictionaryStore.getState().load();
    expect(
      useTermDictionaryStore.getState().rows.map((r) => r.preferred),
    ).toEqual(["夜"]);

    // Project A loads only its own entry.
    setProject(PROJECT_A);
    clearStoreRows();
    await useTermDictionaryStore.getState().load();
    expect(
      useTermDictionaryStore.getState().rows.map((r) => r.preferred),
    ).toEqual(["色"]);
  });

  it("duplicate stays within the current project", async () => {
    setProject(PROJECT_A);
    const created = await useTermDictionaryStore.getState().upsert({
      preferred: "扉",
      variants: ["とびら"],
      severity: "warning",
      note: null,
      enabled: true,
    });
    expect(created.ok).toBe(true);
    const srcId = created.ok ? created.row.id : "";

    const dup = await useTermDictionaryStore.getState().duplicate(srcId);
    expect(dup).not.toBeNull();

    // Switching to B must not surface either the source or the copy.
    setProject(PROJECT_B);
    clearStoreRows();
    await useTermDictionaryStore.getState().load();
    expect(useTermDictionaryStore.getState().rows).toHaveLength(0);
  });
});
