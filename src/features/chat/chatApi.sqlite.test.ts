// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserMock,
  type PersistentBrowserMock,
} from "@/lib/browser-mock";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  invoke: invokeMock,
  isTauri: () => false,
}));

import { pinCodexEntry } from "./chatApi";

const SESSION_ID = "spotlight-session";
const CODEX_ID = "spotlight-codex";
const SNIPPET_ID = "spotlight-snippet";

let browser: PersistentBrowserMock;

async function run(sql: string, params: unknown[] = []): Promise<void> {
  await browser.invoke("db_execute", { sql, params, method: "run" });
}

async function pinnedRows(
  column: "codex_entry_id" | "snippet_id",
  entryId: string,
): Promise<Record<string, unknown>[]> {
  const result = await browser.invoke<{ rows: Record<string, unknown>[] }>(
    "db_execute",
    {
      sql: `SELECT id, pin_source, with_children
            FROM chat_session_pinned_codex
            WHERE session_id = ? AND ${column} = ?`,
      params: [SESSION_ID, entryId],
      method: "all",
    },
  );
  return result.rows;
}

beforeEach(async () => {
  delete (window as unknown as Record<string, unknown>).grimodex;
  browser = await createBrowserMock({
    allowProtectedWriterTestFixtures: true,
  });
  invokeMock.mockReset();
  invokeMock.mockImplementation(
    (command: string, args?: Record<string, unknown>) =>
      browser.invoke(command, args),
  );

  await run(
    "INSERT INTO chat_sessions (id, project_id) VALUES (?, 'default-project')",
    [SESSION_ID],
  );
  await run(
    "INSERT INTO codex_entries (id, project_id, type, name) VALUES (?, 'default-project', 'character', 'Codex')",
    [CODEX_ID],
  );
  await run(
    "INSERT INTO snippets (id, project_id, title) VALUES (?, 'default-project', 'Snippet')",
    [SNIPPET_ID],
  );
});

afterEach(() => {
  browser.close();
});

describe("pinCodexEntry SQLite partial-index upsert", () => {
  it("promotes a Codex chat mention to one manual Spotlight row", async () => {
    await run(
      `INSERT INTO chat_session_pinned_codex
        (id, session_id, codex_entry_id, snippet_id, sticky_id,
         with_children, pin_source)
       VALUES ('legacy-codex-pin', ?, ?, NULL, NULL, 0, 'chat_mention')`,
      [SESSION_ID, CODEX_ID],
    );

    await pinCodexEntry(SESSION_ID, CODEX_ID, true, "manual", "codex");

    expect(await pinnedRows("codex_entry_id", CODEX_ID)).toEqual([
      {
        id: "legacy-codex-pin",
        pin_source: "manual",
        with_children: 1,
      },
    ]);
  });

  it("promotes a Snippet chat mention to one manual Spotlight row", async () => {
    await run(
      `INSERT INTO chat_session_pinned_codex
        (id, session_id, codex_entry_id, snippet_id, sticky_id,
         with_children, pin_source)
       VALUES ('legacy-snippet-pin', ?, NULL, ?, NULL, 1, 'chat_mention')`,
      [SESSION_ID, SNIPPET_ID],
    );

    await pinCodexEntry(SESSION_ID, SNIPPET_ID, false, "manual", "snippet");

    expect(await pinnedRows("snippet_id", SNIPPET_ID)).toEqual([
      {
        id: "legacy-snippet-pin",
        pin_source: "manual",
        with_children: 0,
      },
    ]);
  });
});
