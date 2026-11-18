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

import { addMessage, listMessages } from "./chatApi";

async function completeAssistantMessage(
  sessionId: string,
  id: string,
  extra: {
    content: string;
    model?: string;
    tokensIn?: number;
    tokensOut?: number;
    metadata?: string;
  },
): Promise<void> {
  const { content, ...rest } = extra;
  await addMessage(sessionId, "assistant", content, {
    ...rest,
    id,
    createdAt: ASSISTANT_AT,
    recordTimelapse: false,
    replaceReservedAssistant: true,
  });
}

const SESSION_ID = "reserved-row-session";
const OTHER_SESSION_ID = "reserved-row-other-session";
const USER_ID = "reserved-row-user";
const ASSISTANT_ID = "reserved-row-assistant";
const USER_AT = "2026-11-18T10:00:00.000Z";
const ASSISTANT_AT = "2026-11-18T10:00:00.001Z";

let browser: PersistentBrowserMock;

async function run(sql: string, params: unknown[] = []): Promise<void> {
  await browser.invoke("db_execute", { sql, params, method: "run" });
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
  for (const id of [SESSION_ID, OTHER_SESSION_ID]) {
    await run(
      "INSERT INTO chat_sessions (id, project_id) VALUES (?, 'default-project')",
      [id],
    );
  }
});

afterEach(() => {
  browser.close();
});

async function reserve(): Promise<void> {
  await addMessage(SESSION_ID, "assistant", "", {
    id: ASSISTANT_ID,
    createdAt: ASSISTANT_AT,
    recordTimelapse: false,
  });
}

describe("assistant row reserved before a source-bearing write tool", () => {
  it("lets a snippet reference the reserved row as its source, and refuses an unsaved id", async () => {
    // 保存前の id は FK で拒否される（再現）。
    await expect(
      run(
        "INSERT INTO snippets (id, project_id, title, source_chat_message_id) VALUES ('s0', 'default-project', 'x', ?)",
        [ASSISTANT_ID],
      ),
    ).rejects.toThrow(/FOREIGN KEY/i);

    await reserve();
    await run(
      "INSERT INTO snippets (id, project_id, title, source_chat_message_id) VALUES ('s1', 'default-project', 'x', ?)",
      [ASSISTANT_ID],
    );
  });

  it("keeps the user/assistant display order when the assistant row is inserted first", async () => {
    await reserve();
    await addMessage(SESSION_ID, "user", "依頼", {
      id: USER_ID,
      createdAt: USER_AT,
      recordTimelapse: false,
    });
    await completeAssistantMessage(SESSION_ID, ASSISTANT_ID, {
      content: "完了",
      model: "m",
      tokensIn: 1,
      tokensOut: 2,
      metadata: JSON.stringify({ a: 1 }),
    });

    const messages = await listMessages(SESSION_ID);
    expect(messages.map((m) => [m.id, m.role, m.content])).toEqual([
      [USER_ID, "user", "依頼"],
      [ASSISTANT_ID, "assistant", "完了"],
    ]);
    expect(messages[1]).toMatchObject({
      model: "m",
      tokensIn: 1,
      tokensOut: 2,
      metadata: JSON.stringify({ a: 1 }),
    });
  });

  it("finalizes idempotently and keeps the row a snippet references", async () => {
    await reserve();
    await run(
      "INSERT INTO snippets (id, project_id, title, source_chat_message_id) VALUES ('s1', 'default-project', 'x', ?)",
      [ASSISTANT_ID],
    );
    const extra = {
      content: "最終",
      metadata: JSON.stringify({ stopped: true }),
    };
    await completeAssistantMessage(SESSION_ID, ASSISTANT_ID, extra);
    await completeAssistantMessage(SESSION_ID, ASSISTANT_ID, extra);

    const messages = await listMessages(SESSION_ID);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("最終");
    // 完了後も同じ id の行が残り、snippet の出典は同じ行を指す。
    const source = await browser.invoke<{ rows: Record<string, unknown>[] }>(
      "db_execute",
      {
        sql: "SELECT source_chat_message_id FROM snippets WHERE id = 's1'",
        params: [],
        method: "all",
      },
    );
    expect(source.rows[0]?.source_chat_message_id).toBe(ASSISTANT_ID);
  });

  it("refuses to overwrite another session's row or a user row", async () => {
    await reserve();
    await expect(
      completeAssistantMessage(OTHER_SESSION_ID, ASSISTANT_ID, {
        content: "x",
      }),
    ).rejects.toThrow(/collision/);
    await addMessage(SESSION_ID, "user", "u", {
      id: USER_ID,
      createdAt: USER_AT,
      recordTimelapse: false,
    });
    await expect(
      completeAssistantMessage(SESSION_ID, USER_ID, { content: "x" }),
    ).rejects.toThrow(/collision/);
    const messages = await listMessages(SESSION_ID);
    expect(messages.find((m) => m.id === USER_ID)?.content).toBe("u");
    expect(messages.find((m) => m.id === ASSISTANT_ID)?.content).toBe("");
  });

  it("inserts the row when none was reserved", async () => {
    await completeAssistantMessage(SESSION_ID, ASSISTANT_ID, {
      content: "新規",
    });
    expect((await listMessages(SESSION_ID)).map((m) => m.content)).toEqual([
      "新規",
    ]);
  });
});
