// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserMock,
  type PersistentBrowserMock,
} from "@/lib/browser-mock";
import {
  D2A_RESTRICTED_DB_EXECUTE_DENIAL,
  restrictedGenericSql,
} from "@/lib/d2aRestrictedGenericSql.testSupport";
import { rootCause } from "@/lib/debugLog";

// DA-2b (Negative (11); DR-DA2B-R5): a turn without a conversation creates one
// before its transport. Restricted, `createSession` (INSERT … RETURNING, D) is
// refused as generic SQL and Drizzle's message is the statement with its
// params. The chat panel's error is the generic text instead.

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri")>()),
  invoke: invokeMock,
  isTauri: () => false,
}));

import { createSession } from "@/features/chat/chatApi";
import { turnErrorText } from "./chatStoreSupport";

let browser: PersistentBrowserMock;

beforeEach(async () => {
  delete (window as unknown as Record<string, unknown>).grimodex;
  browser = await createBrowserMock({ allowProtectedWriterTestFixtures: true });
  invokeMock.mockReset();
  invokeMock.mockImplementation(
    restrictedGenericSql((command: string, args?: Record<string, unknown>) =>
      browser.invoke(command, args),
    ),
  );
});

afterEach(() => {
  browser.close();
});

describe("turnErrorText", () => {
  it("shows the refused new conversation as the generic text, without the statement, params or marker", async () => {
    const error: unknown = await createSession(
      "default-project",
      "New session",
    ).then(
      () => null,
      (reason: unknown) => reason,
    );
    // The precondition: Drizzle's own message carries the statement and params.
    const raw = (error as Error).message;
    expect(raw).toMatch(/^Failed query: insert into "chat_sessions"/);
    expect(raw).toContain("default-project");

    const shown = turnErrorText(error);
    expect(shown).toBe(rootCause(error));
    for (const leaked of [
      "Failed query",
      "chat_sessions",
      "params",
      "default-project",
      "New session",
      "D2A_EGRESS_DENIED",
    ]) {
      expect(shown).not.toContain(leaked);
    }
  });

  it("shows a bare D2a refusal as the generic text too", () => {
    expect(turnErrorText(new Error(D2A_RESTRICTED_DB_EXECUTE_DENIAL))).toBe(
      rootCause(new Error(D2A_RESTRICTED_DB_EXECUTE_DENIAL)),
    );
    expect(
      turnErrorText(new Error(D2A_RESTRICTED_DB_EXECUTE_DENIAL)),
    ).not.toContain("D2A_EGRESS_DENIED");
  });

  it("keeps any other error's message as before", () => {
    expect(turnErrorText(new Error("chat session project mismatch"))).toBe(
      "chat session project mismatch",
    );
    expect(turnErrorText("plain")).toBe("plain");
  });
});
