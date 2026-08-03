import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BindParams } from "sql.js";

const sqliteHarness = vi.hoisted(
  () =>
    ({
      seedSession: undefined,
      reopen: undefined,
    }) as {
      seedSession?: (sessionId: string) => void;
      reopen?: () => void;
    },
);

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@/features/semantic-search/scheduler", () => ({
  scheduleChatIndex: vi.fn(),
}));

vi.mock("@/features/timelapse/captureChat", () => ({
  recordChatMessageAdd: vi.fn(),
  recordChatMessageDelete: vi.fn(),
  recordChatMessagesDeleteFrom: vi.fn(),
}));

vi.mock("@/db/client", async () => {
  const { drizzle } = await import("drizzle-orm/sqlite-proxy");
  const schema = await import("@/db/schema");
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- sql.js/dist/sql-asm.js has no dedicated declarations.
  const initSqlJs = (await import("sql.js/dist/sql-asm.js")).default;
  const SQL = await initSqlJs();
  let sqldb = new SQL.Database();
  sqldb.run(`
    CREATE TABLE chat_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      node_id TEXT,
      codex_anchor_id TEXT,
      snippet_anchor_id TEXT,
      title TEXT NOT NULL DEFAULT 'New session',
      title_manual INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL DEFAULT 'test-model',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      model TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      duration_ms INTEGER,
      metadata TEXT,
      is_starred INTEGER NOT NULL DEFAULT 0,
      is_summarized INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_chat_messages_session
      ON chat_messages(session_id, created_at);
  `);

  sqliteHarness.seedSession = (sessionId) => {
    sqldb.run(
      `INSERT INTO chat_sessions
        (id, project_id, title, created_at, updated_at)
       VALUES (?, 'project-1', 'Session', ?, ?)`,
      [
        sessionId,
        "2026-07-30T00:00:00.000Z",
        "2026-07-30T00:00:00.000Z",
      ] as BindParams,
    );
  };
  sqliteHarness.reopen = () => {
    const bytes = sqldb.export();
    sqldb.close();
    sqldb = new SQL.Database(bytes);
  };

  const db = drizzle<typeof schema>(
    async (sql, params, method) => {
      const statement = sqldb.prepare(sql);
      statement.bind(params as BindParams);
      const rows: unknown[][] = [];
      while (statement.step()) rows.push(statement.get());
      statement.free();
      return { rows: method === "get" ? (rows[0] ?? []) : rows };
    },
    { schema },
  );
  return { db };
});

import { addMessage, listMessages } from "./chatApi";

describe("Chat message retry persistence with real SQLite", () => {
  beforeAll(() => {
    sqliteHarness.seedSession?.("session-order");
  });

  it("reopens with the original turn order after a delayed older insert", async () => {
    await addMessage("session-order", "user", "question 1", {
      id: "user-1",
      createdAt: "2026-07-30T00:00:00.000Z",
      recordTimelapse: false,
    });
    // Reproduce the durable order that existed before the send gate: a later
    // turn reaches SQLite while the older assistant insert is unavailable.
    await addMessage("session-order", "user", "question 2", {
      id: "user-2",
      createdAt: "2026-07-30T00:00:00.002Z",
      recordTimelapse: false,
    });
    await addMessage("session-order", "assistant", "answer 2", {
      id: "assistant-2",
      createdAt: "2026-07-30T00:00:00.003Z",
      recordTimelapse: false,
    });
    await addMessage("session-order", "assistant", "answer 1", {
      id: "assistant-1",
      createdAt: "2026-07-30T00:00:00.001Z",
      recordTimelapse: false,
    });

    sqliteHarness.reopen?.();

    await expect(listMessages("session-order")).resolves.toMatchObject([
      { id: "user-1", role: "user", content: "question 1" },
      { id: "assistant-1", role: "assistant", content: "answer 1" },
      { id: "user-2", role: "user", content: "question 2" },
      { id: "assistant-2", role: "assistant", content: "answer 2" },
    ]);
  });
});
