import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { eq } from "drizzle-orm";
import { snippets } from "@/db/schema";
import * as schema from "@/db/schema";

const snippetApiHarness = vi.hoisted(() => ({
  db: {
    select: vi.fn(),
  },
  invoke: vi.fn(),
  runTimelapseBodyReplacement: vi.fn(),
  runTimelapseBodyWrite: vi.fn(),
  runTimelapseMutation: vi.fn(),
  persisted: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@/db/client", () => ({ db: snippetApiHarness.db }));
vi.mock("@/lib/tauri", () => ({ invoke: snippetApiHarness.invoke }));
vi.mock("@/features/timelapse/bodyWriteMode", () => ({
  runTimelapseBodyReplacement: snippetApiHarness.runTimelapseBodyReplacement,
  runTimelapseBodyWrite: snippetApiHarness.runTimelapseBodyWrite,
  runTimelapseMutation: snippetApiHarness.runTimelapseMutation,
}));

import { updateSnippet } from "./api";

function createQueryCapture() {
  const queries: { sql: string; params: unknown[]; method: string }[] = [];
  const db = drizzle<typeof schema>(
    async (sql, params, method) => {
      queries.push({ sql, params, method });
      return { rows: [] };
    },
    { schema },
  );
  return { db, queries };
}

describe("snippet API query generation", () => {
  it("lists all snippets", async () => {
    const { db, queries } = createQueryCapture();
    await db.select().from(snippets);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("snippets");
  });

  it("lists snippets filtered by scene_id", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .select()
      .from(snippets)
      .where(eq(snippets.sceneId, "scene-uuid-1"));
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("snippets");
    expect(queries[0].sql).toContain("scene_id");
  });

  it("creates a snippet with required fields", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .insert(snippets)
      .values({
        id: "snippet-1",
        projectId: "project-1",
        title: "伏線メモ",
        content: "第3章で回収する伏線の詳細。",
        tagsCache: '["伏線","第3章"]',
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      })
      .returning();
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("insert");
    expect(queries[0].params).toContain("伏線メモ");
  });

  it("creates a snippet with optional scene_id and sourceChatMessageId", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .insert(snippets)
      .values({
        id: "snippet-2",
        projectId: "project-1",
        title: "シーン固有メモ",
        content: "このシーンの雰囲気について。",
        tagsCache: '["雰囲気"]',
        sceneId: "scene-uuid-2",
        sourceChatMessageId: "chat-msg-002",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      })
      .returning();
    expect(queries[0].params).toContain("scene-uuid-2");
    expect(queries[0].params).toContain("chat-msg-002");
  });

  it("updates a snippet", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .update(snippets)
      .set({ title: "更新されたタイトル", content: "更新された内容" })
      .where(eq(snippets.id, "snippet-1"))
      .returning();
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("update");
    expect(queries[0].params).toContain("更新されたタイトル");
  });

  it("deletes a snippet by id", async () => {
    const { db, queries } = createQueryCapture();
    await db.delete(snippets).where(eq(snippets.id, "snippet-1"));
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("delete");
    expect(queries[0].sql).toContain("snippets");
  });
});

function configureSnippetUpdateHarness(): void {
  snippetApiHarness.persisted = {
    id: "snippet-1",
    projectId: "project-1",
    title: "元のタイトル",
    content: "元の内容",
    tagsCache: null,
    contentSource: null,
    sceneId: null,
    sourceChatMessageId: null,
    usageCount: 0,
    version: 4,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };
  snippetApiHarness.db.select.mockImplementation(() => ({
    from: () => ({
      where: async () =>
        snippetApiHarness.persisted ? [snippetApiHarness.persisted] : [],
    }),
  }));
  snippetApiHarness.invoke.mockImplementation(
    async (_command: string, request: { payload: Record<string, unknown> }) => {
      const payload = request.payload;
      const current = snippetApiHarness.persisted;
      if (!current) throw new Error("missing snippet fixture");
      const version = Number(payload.baseVersion) + 1;
      snippetApiHarness.persisted = {
        ...current,
        ...(typeof payload.title === "string" ? { title: payload.title } : {}),
        ...(typeof payload.content === "string"
          ? { content: payload.content }
          : {}),
        version,
      };
      return {
        entityId: payload.snippetId,
        version,
        changeEventUid: "snippet-change-event-1",
        maintenanceTransactionId: "snippet-maintenance-transaction-1",
        undoJournalId: "snippet-undo-journal-1",
      };
    },
  );
  snippetApiHarness.runTimelapseBodyReplacement.mockImplementation(
    async (
      _input: unknown,
      callbacks: {
        commit: () => Promise<unknown>;
        project: (committed: unknown) => Promise<unknown>;
      },
    ) => callbacks.project(await callbacks.commit()),
  );
  snippetApiHarness.runTimelapseBodyWrite.mockImplementation(
    async (
      _input: unknown,
      callbacks: {
        commit: (coverage: unknown) => Promise<unknown>;
        project: (committed: unknown) => Promise<unknown>;
      },
    ) => callbacks.project(await callbacks.commit(undefined)),
  );
  snippetApiHarness.runTimelapseMutation.mockImplementation(
    async (_projectId: string, operation: () => Promise<unknown>) =>
      operation(),
  );
}

describe("snippet update timelapse admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureSnippetUpdateHarness();
  });

  it("forwards a preexisting-draft permit for body-content updates", async () => {
    await updateSnippet(
      "project-1",
      "snippet-1",
      { content: "本文の更新" },
      { baseVersion: 4, preexistingDraft: true },
    );

    expect(snippetApiHarness.runTimelapseBodyReplacement).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        preexistingDraft: true,
      }),
      expect.any(Object),
    );
  });

  it("forwards a preexisting-draft permit for title-only mutations", async () => {
    await updateSnippet(
      "project-1",
      "snippet-1",
      { title: "タイトルの更新" },
      { baseVersion: 4, preexistingDraft: true },
    );

    expect(snippetApiHarness.runTimelapseMutation).toHaveBeenCalledWith(
      "project-1",
      expect.any(Function),
      { preexistingDraft: true },
    );
  });

  it("does not add a permit when body-content updates are ordinary saves", async () => {
    await updateSnippet(
      "project-1",
      "snippet-1",
      { content: "通常の本文更新" },
      { baseVersion: 4 },
    );

    const [input] = snippetApiHarness.runTimelapseBodyReplacement.mock.calls[0];
    expect(input).not.toHaveProperty("preexistingDraft");
  });

  it("does not add a permit when title-only mutations are ordinary saves", async () => {
    await updateSnippet(
      "project-1",
      "snippet-1",
      { title: "通常のタイトル更新" },
      { baseVersion: 4 },
    );

    expect(snippetApiHarness.runTimelapseMutation).toHaveBeenCalledWith(
      "project-1",
      expect.any(Function),
      undefined,
    );
  });
});
