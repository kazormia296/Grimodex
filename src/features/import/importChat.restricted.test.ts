// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserMock,
  type PersistentBrowserMock,
} from "@/lib/browser-mock";
import { restrictedGenericSql } from "@/lib/d2aRestrictedGenericSql.testSupport";

// Positive (8) / K3/2 "chat の書込みの入口" 9 (DR-DA2B-R7): the conversation
// part of an import adds rows, so it stays closed while restricted (D). It is
// not taken in, the count is returned (and shown), no conversation is tried
// after the first refusal, and nothing else changes unrestricted.

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  invoke: invokeMock,
  isTauri: () => false,
}));

import { importChatSessionsBatch } from "./importApi";
import { chatImportNotice } from "./chatImportNotice";
import type { ParsedChatSession } from "./novelcrafterParser";

const sessions = ["a", "b", "c"].map(
  (id) =>
    ({
      id: `import-${id}`,
      title: `Chat ${id}`,
      titleFromFrontmatter: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      messages: [
        { role: "user", content: `hello ${id}` },
        { role: "assistant", content: `reply ${id}` },
      ],
    }) as unknown as ParsedChatSession,
);

let browser: PersistentBrowserMock;

async function count(table: string): Promise<number> {
  const result = await browser.invoke<{ rows: Record<string, unknown>[] }>(
    "db_execute",
    { sql: `SELECT count(*) AS n FROM ${table}`, params: [], method: "all" },
  );
  return Number(result.rows[0]?.n);
}

beforeEach(async () => {
  delete (window as unknown as Record<string, unknown>).grimodex;
  browser = await createBrowserMock({ allowProtectedWriterTestFixtures: true });
  invokeMock.mockReset();
});

afterEach(() => browser.close());

describe("importChatSessionsBatch", () => {
  it("takes no conversation in while restricted and returns their count", async () => {
    invokeMock.mockImplementation(
      restrictedGenericSql((command: string, args?: Record<string, unknown>) =>
        browser.invoke(command, args),
      ),
    );
    const progress = vi.fn();
    await expect(importChatSessionsBatch(sessions, progress)).resolves.toEqual({
      imported: 0,
      errors: [],
      notImported: 3,
    });
    expect(await count("chat_sessions")).toBe(0);
    // One refused INSERT, then nothing more is tried.
    expect(
      invokeMock.mock.calls.filter(([command]) => command === "db_execute"),
    ).toHaveLength(1);
    expect(progress).toHaveBeenLastCalledWith({
      total: 3,
      done: 3,
      currentName: "",
    });
  });

  it("imports every conversation unrestricted, as before", async () => {
    invokeMock.mockImplementation(
      (command: string, args?: Record<string, unknown>) =>
        browser.invoke(command, args),
    );
    await expect(importChatSessionsBatch(sessions)).resolves.toEqual({
      imported: 3,
      errors: [],
      notImported: 0,
    });
    expect(await count("chat_sessions")).toBe(3);
    expect(await count("chat_messages")).toBe(6);
  });

  it("shows the count without the raw marker or the restriction wording while the constant is off", async () => {
    const notice = await chatImportNotice(3);
    expect(notice).toContain("3");
    expect(notice).not.toContain("D2A_EGRESS_DENIED");
    expect(notice).not.toContain("外部送信");
    // It does not claim the other items succeeded: they may have errors.
    expect(notice).not.toContain("完了");
  });
});
