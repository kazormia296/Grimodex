import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { eq, getTableName } from "drizzle-orm";
import { projects } from "@/db/schema";
import * as schema from "@/db/schema";

const invokeMock = vi.fn().mockResolvedValue(undefined);
const scheduleImeExportRefreshMock = vi.fn();
const cancelScheduledImeExportsMock = vi.fn();
const removeImeProjectExportWithRetryMock = vi
  .fn()
  .mockResolvedValue(undefined);
const imeWorkspaceIdentity = { path: "/workspaces/a", openRevision: 7 };
vi.mock("@/lib/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@/features/ime/scheduler", () => ({
  scheduleImeExportRefresh: (...args: unknown[]) =>
    scheduleImeExportRefreshMock(...args),
  cancelScheduledImeExports: (...args: unknown[]) =>
    cancelScheduledImeExportsMock(...args),
}));
vi.mock("@/features/ime/api", () => ({
  removeImeProjectExportWithRetry: (...args: unknown[]) =>
    removeImeProjectExportWithRetryMock(...args),
}));
vi.mock("@/features/ime/workspaceScope", () => ({
  getCurrentImeWorkspaceIdentity: () => imeWorkspaceIdentity,
}));

const returningMock = vi.fn().mockResolvedValue([{ id: "p1", language: "en" }]);
vi.mock("@/db/client", () => ({
  db: {
    update: () => ({
      set: () => ({ where: () => ({ returning: returningMock }) }),
    }),
  },
}));

import { deleteProject, updateProject } from "./api";
import { pendingCompletedTurnPersistence } from "@/application/chat/pendingCompletedTurnPersistence";

// In-memory store simulating SQLite via the proxy interface
function createTestDb() {
  return drizzle<typeof schema>(
    async (_sql, _params, _method) => {
      return { rows: [] };
    },
    { schema },
  );
}

describe("projects schema", () => {
  it("has the correct table name", () => {
    expect(getTableName(projects)).toBe("projects");
  });

  it("has all required columns", () => {
    const columns = Object.keys(projects);
    expect(columns).toContain("id");
    expect(columns).toContain("title");
    expect(columns).toContain("genre");
    expect(columns).toContain("pov");
    expect(columns).toContain("tense");
    expect(columns).toContain("language");
    expect(columns).toContain("styleGuide");
    expect(columns).toContain("aiInstructions");
    expect(columns).toContain("createdAt");
    expect(columns).toContain("updatedAt");
  });

  it("creates a drizzle db instance with sqlite-proxy", () => {
    const db = createTestDb();
    expect(db).toBeDefined();
    expect(db.select).toBeDefined();
    expect(db.insert).toBeDefined();
    expect(db.update).toBeDefined();
    expect(db.delete).toBeDefined();
  });

  it("generates valid select query", async () => {
    const executedQueries: string[] = [];
    const db = drizzle<typeof schema>(
      async (sql, _params, _method) => {
        executedQueries.push(sql);
        return { rows: [] };
      },
      { schema },
    );

    await db.select().from(projects);
    expect(executedQueries.length).toBe(1);
    expect(executedQueries[0]).toContain("select");
    expect(executedQueries[0]).toContain("projects");
  });

  it("generates valid insert query", async () => {
    const executedQueries: { sql: string; params: unknown[] }[] = [];
    const db = drizzle<typeof schema>(
      async (sql, params, _method) => {
        executedQueries.push({ sql, params });
        return { rows: [] };
      },
      { schema },
    );

    await db.insert(projects).values({
      id: "proj-1",
      title: "My Novel",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    expect(executedQueries.length).toBe(1);
    expect(executedQueries[0].sql).toContain("insert");
    expect(executedQueries[0].sql).toContain("projects");
    expect(executedQueries[0].params).toContain("My Novel");
  });

  it("generates valid update query with where clause", async () => {
    const executedQueries: { sql: string; params: unknown[] }[] = [];
    const db = drizzle<typeof schema>(
      async (sql, params, _method) => {
        executedQueries.push({ sql, params });
        return { rows: [] };
      },
      { schema },
    );

    await db
      .update(projects)
      .set({ title: "Updated Title" })
      .where(eq(projects.id, "proj-1"));
    expect(executedQueries.length).toBe(1);
    expect(executedQueries[0].sql).toContain("update");
    expect(executedQueries[0].sql).toContain("projects");
    expect(executedQueries[0].params).toContain("Updated Title");
  });

  it("generates valid delete query with where clause", async () => {
    const executedQueries: { sql: string; params: unknown[] }[] = [];
    const db = drizzle<typeof schema>(
      async (sql, params, _method) => {
        executedQueries.push({ sql, params });
        return { rows: [] };
      },
      { schema },
    );

    await db.delete(projects).where(eq(projects.id, "proj-1"));
    expect(executedQueries.length).toBe(1);
    expect(executedQueries[0].sql).toContain("delete");
    expect(executedQueries[0].sql).toContain("projects");
  });
});

describe("updateProject", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    scheduleImeExportRefreshMock.mockClear();
  });

  it("rebuilds _en FTS when language is in the patch", async () => {
    await updateProject("p1", { language: "en" });
    expect(invokeMock).toHaveBeenCalledWith("fts_rebuild_en");
  });

  it("does not rebuild _en FTS when language is absent", async () => {
    await updateProject("p1", { title: "New Title" });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it.each(["title", "genre", "outline", "language"] as const)(
    "%s changes refresh the IME snapshot",
    async (field) => {
      await updateProject("p1", { [field]: field === "language" ? "ja" : "x" });
      expect(scheduleImeExportRefreshMock).toHaveBeenCalledWith("p1");
    },
  );

  it("unrelated metadata does not refresh the IME snapshot", async () => {
    await updateProject("p1", { pov: "first" });
    expect(scheduleImeExportRefreshMock).not.toHaveBeenCalled();
  });
});

describe("deleteProject", () => {
  beforeEach(() => {
    pendingCompletedTurnPersistence.discard();
    cancelScheduledImeExportsMock.mockClear();
    invokeMock.mockClear();
    removeImeProjectExportWithRetryMock.mockClear();
  });
  afterEach(() => {
    pendingCompletedTurnPersistence.discard();
  });

  it("cancels a pending refresh before deleting and removing its snapshot", async () => {
    await deleteProject("default-project");

    expect(cancelScheduledImeExportsMock).toHaveBeenCalledTimes(2);
    expect(cancelScheduledImeExportsMock).toHaveBeenNthCalledWith(
      1,
      "default-project",
    );
    expect(cancelScheduledImeExportsMock).toHaveBeenNthCalledWith(
      2,
      "default-project",
    );
    expect(invokeMock).toHaveBeenCalledWith("project_delete", {
      payload: { projectId: "default-project" },
    });
    expect(removeImeProjectExportWithRetryMock).toHaveBeenCalledWith(
      "default-project",
      imeWorkspaceIdentity,
    );
    expect(
      cancelScheduledImeExportsMock.mock.invocationCallOrder[1],
    ).toBeLessThan(
      removeImeProjectExportWithRetryMock.mock.invocationCallOrder[0],
    );
  });

  it("does not cascade-delete a Project containing an unresolved Chat turn", async () => {
    await expect(
      pendingCompletedTurnPersistence.persist({
        turnId: "turn-pending",
        workspaceIdentity: imeWorkspaceIdentity,
        projectId: "default-project",
        sessionId: "session-1",
        userMessage: {
          id: "user-1",
          sessionId: "session-1",
          role: "user",
          content: "unsaved question",
          createdAt: "2026-07-30T00:00:00.000Z",
        },
        assistantMessage: {
          id: "assistant-1",
          sessionId: "session-1",
          role: "assistant",
          content: "unsaved answer",
          createdAt: "2026-07-30T00:00:00.001Z",
        },
        retry: vi.fn().mockRejectedValue(new Error("database unavailable")),
      }),
    ).rejects.toThrow("database unavailable");

    await expect(deleteProject("default-project")).rejects.toThrow(
      "still waiting to be saved",
    );
    expect(cancelScheduledImeExportsMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(removeImeProjectExportWithRetryMock).not.toHaveBeenCalled();
  });
});
