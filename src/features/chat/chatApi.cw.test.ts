// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserMock,
  type PersistentBrowserMock,
} from "@/lib/browser-mock";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { restrictedGenericSql } from "@/lib/d2aRestrictedGenericSql.testSupport";
import { isD2aEgressDenied } from "@/lib/tauri";

// DA-2b CW (K3/2 "chat の書込みの入口" 4〜8, D-11 (a); DR-DA2B-R2): the
// message and session deletions, the clear, the rename and the record use the
// typed Native writers in both modes. Each case runs the renderer function
// against a real SQLite (the browser runtime's writers) in the restricted
// generic-SQL shape and compares the rows with the legacy statement's result
// in the unrestricted shape. The new conversation (`createSession`) stays D.

const { invokeMock, recordDelete, scheduleIndex } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  recordDelete: vi.fn(),
  scheduleIndex: vi.fn(),
}));

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  invoke: invokeMock,
  isTauri: () => false,
}));
vi.mock("@/features/timelapse/captureChat", () => ({
  recordChatMessageAdd: vi.fn(),
  recordChatMessageDelete: recordDelete,
  recordChatMessagesDeleteFrom: vi.fn(),
}));
vi.mock("@/features/semantic-search/scheduler", () => ({
  scheduleChatIndex: scheduleIndex,
}));

import {
  clearProjectChatHistory,
  createSession,
  deleteMessage,
  deleteMessages,
  deleteSession,
  updateMessageMetadata,
} from "./chatApi";
import { updateSessionTitle } from "./chatHistoryApi";

const WORKSPACE = { path: "/workspaces/novel", openRevision: 3 };
const NOW = new Date("2026-10-24T09:00:00.000Z");

let legacy: PersistentBrowserMock;
let typed: PersistentBrowserMock;

async function seed(browser: PersistentBrowserMock): Promise<void> {
  const run = (sql: string, params: unknown[] = []) =>
    browser.invoke("db_execute", { sql, params, method: "run" });
  await run("INSERT INTO projects (id) VALUES ('other-project')");
  for (const [id, project] of [
    ["s1", "default-project"],
    ["s2", "default-project"],
    ["o1", "other-project"],
  ]) {
    await run(
      `INSERT INTO chat_sessions (id, project_id, title, title_manual, model, created_at, updated_at)
       VALUES (?, ?, 'Auto', 0, 'm', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      [id, project],
    );
  }
  const messages: Array<[string, string, string, string | null]> = [
    ["m1", "s1", "user", null],
    ["m2", "s1", "assistant", '{"thinking_blocks":["t"],"ab_adopted":true}'],
    ["m3", "s1", "user", null],
    ["m4", "s1", "assistant", null],
    ["n1", "s2", "user", null],
    ["x1", "o1", "user", null],
  ];
  for (const [index, [id, session, role, metadata]] of messages.entries()) {
    await run(
      `INSERT INTO chat_messages (id, session_id, role, content, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        session,
        role,
        `body ${id}`,
        metadata,
        `2026-01-01T00:00:0${index}.000Z`,
      ],
    );
  }
}

async function dump(browser: PersistentBrowserMock) {
  const all = async (sql: string) =>
    (
      await browser.invoke<{ rows: Record<string, unknown>[] }>("db_execute", {
        sql,
        params: [],
        method: "all",
      })
    ).rows;
  return {
    sessions: await all(
      "SELECT id, project_id, node_id, codex_anchor_id, snippet_anchor_id, title, title_manual, model, created_at, updated_at FROM chat_sessions ORDER BY id",
    ),
    messages: await all(
      "SELECT id, session_id, role, content, metadata, created_at FROM chat_messages ORDER BY id",
    ),
  };
}

/** The renderer's statements before DA-2b, run unrestricted on `legacy`. */
async function legacySql(sql: string, params: unknown[] = []): Promise<void> {
  await legacy.invoke("db_execute", { sql, params, method: "run" });
}

function typedCalls() {
  return invokeMock.mock.calls.filter(([command]) => command !== "db_execute");
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  delete (window as unknown as Record<string, unknown>).grimodex;
  setCurrentWorkspaceIdentity(WORKSPACE);
  legacy = await createBrowserMock({ allowProtectedWriterTestFixtures: true });
  typed = await createBrowserMock({ allowProtectedWriterTestFixtures: true });
  await seed(legacy);
  await seed(typed);
  invokeMock.mockReset();
  invokeMock.mockImplementation(
    restrictedGenericSql((command: string, args?: Record<string, unknown>) =>
      typed.invoke(command, args),
    ),
  );
  recordDelete.mockClear();
  scheduleIndex.mockClear();
});

afterEach(() => {
  legacy.close();
  typed.close();
  setCurrentWorkspaceIdentity(null);
  vi.useRealTimers();
});

describe("CW typed writers in the restricted generic-SQL shape", () => {
  it("deletes a user row and the rows after it in one all-or-nothing call", async () => {
    await deleteMessages(["m3", "m4"]);
    await legacySql("DELETE FROM chat_messages WHERE id = 'm3'");
    await legacySql("DELETE FROM chat_messages WHERE id = 'm4'");

    expect(typedCalls()).toEqual([
      [
        "chat_messages_delete",
        {
          payload: {
            expectedWorkspacePath: "/workspaces/novel",
            projectId: "default-project",
            sessionId: "s1",
            messageIds: ["m3", "m4"],
          },
        },
      ],
    ]);
    expect(await dump(typed)).toEqual(await dump(legacy));
    expect(recordDelete.mock.calls).toEqual([
      [{ messageId: "m3" }],
      [{ messageId: "m4" }],
    ]);
  });

  it("splits only a list above the writer's bound of 256 ids", async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `gone-${i}`);
    await deleteMessages(["m1", ...ids]);
    expect(
      typedCalls().map(([, args]) => {
        const payload = (args as { payload: { messageIds: string[] } }).payload;
        return payload.messageIds.length;
      }),
    ).toEqual([256, 45]);
  });

  it("deletes one message; an unknown id writes nothing, as the legacy DELETE matched nothing", async () => {
    await deleteMessage("m2");
    await deleteMessage("missing");
    await legacySql("DELETE FROM chat_messages WHERE id = 'm2'");

    expect(typedCalls()).toHaveLength(1);
    expect(await dump(typed)).toEqual(await dump(legacy));
    // The timelapse record is unchanged: one per call, as before.
    expect(recordDelete).toHaveBeenCalledTimes(2);
  });

  it("deletes a session and clears only the project's history", async () => {
    await deleteSession("s2");
    await legacySql("DELETE FROM chat_sessions WHERE id = 's2'");
    expect(await dump(typed)).toEqual(await dump(legacy));

    await clearProjectChatHistory("default-project");
    await legacySql(
      "DELETE FROM chat_sessions WHERE project_id = 'default-project'",
    );
    expect(await dump(typed)).toEqual(await dump(legacy));
    expect((await dump(typed)).sessions.map((row) => row.id)).toEqual(["o1"]);
    expect(typedCalls().map(([command]) => command)).toEqual([
      "chat_session_delete",
      "chat_project_history_clear",
    ]);
  });

  it("renames with title, title_manual and updated_at only", async () => {
    await updateSessionTitle("s1", "手動タイトル");
    await legacySql(
      "UPDATE chat_sessions SET title = ?, title_manual = 1, updated_at = ? WHERE id = 's1'",
      ["手動タイトル", NOW.toISOString()],
    );
    expect(await dump(typed)).toEqual(await dump(legacy));
    expect(typedCalls()).toEqual([
      [
        "chat_session_rename",
        {
          payload: {
            expectedWorkspacePath: "/workspaces/novel",
            projectId: "default-project",
            sessionId: "s1",
            title: "手動タイトル",
          },
        },
      ],
    ]);
  });

  it("records an extraction by merging the record key into the stored metadata", async () => {
    await updateMessageMetadata("m2", { extractedCodex: ["c1"] });
    await legacySql("UPDATE chat_messages SET metadata = ? WHERE id = 'm2'", [
      JSON.stringify({
        thinking_blocks: ["t"],
        ab_adopted: true,
        extractedCodex: ["c1"],
      }),
    ]);
    expect(await dump(typed)).toEqual(await dump(legacy));
    expect(typedCalls()).toEqual([
      [
        "chat_message_metadata_record",
        {
          payload: {
            expectedWorkspacePath: "/workspaces/novel",
            projectId: "default-project",
            messageId: "m2",
            patch: { extractedCodex: ["c1"] },
          },
        },
      ],
    ]);
    expect(scheduleIndex).toHaveBeenCalledWith("m2");
  });

  it("needs the open workspace and sends nothing without it", async () => {
    setCurrentWorkspaceIdentity(null);
    await expect(deleteSession("s1")).rejects.toThrow("No workspace is open");
    expect(typedCalls()).toEqual([]);
  });

  it("keeps the new conversation closed (D): createSession is still the generic INSERT … RETURNING", async () => {
    const error: unknown = await createSession("default-project", "New").then(
      () => null,
      (reason: unknown) => reason,
    );
    // Drizzle wraps the refusal; the marker is on its `cause` chain.
    expect(isD2aEgressDenied(error)).toBe(true);
    expect(typedCalls()).toEqual([]);
    const [, args] = invokeMock.mock.calls.at(-1) as [string, { sql: string }];
    expect(args.sql).toMatch(/^insert into "chat_sessions".*returning/is);
  });
});
