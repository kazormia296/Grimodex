import { beforeEach, describe, expect, it, vi } from "vitest";
import { exportRecoveryDrafts } from "./exportRecoveryDrafts";
import { createChatTurnRuntime } from "@/application/chat/chatTurnRuntime";
import { createPendingCompletedTurnPersistenceRegistry } from "@/application/chat/pendingCompletedTurnPersistence";
import { discardQuiescenceProviders } from "@/lib/quiescenceProviders";

const saveTextFile = vi.hoisted(() =>
  vi.fn<
    (
      suggestedName: string,
      filter: unknown,
      contents: string,
      mime?: string,
    ) => Promise<string | null>
  >(async () => "/tmp/recovery.json"),
);

vi.mock("@/lib/exportFile", () => ({ saveTextFile }));
vi.mock("@/features/editor/editorSaveRegistry", () => ({
  collectEditorRecoveryDrafts: () => [],
}));

describe("exportRecoveryDrafts", () => {
  beforeEach(() => saveTextFile.mockClear());

  it("does not copy backend error messages into the recovery bundle", async () => {
    await exportRecoveryDrafts([
      {
        stage: "external-write-back",
        error: new Error("secret prose in SQL params"),
        originalError: new Error("secret prose in SQL params"),
      },
    ]);

    const serialized = String(saveTextFile.mock.calls[0]?.[2]);
    expect(serialized).not.toContain("secret prose");
    expect(JSON.parse(serialized).failures).toEqual([
      { stage: "external-write-back", error: "Error" },
    ]);
  });

  it("includes unresolved completed Chat turn bodies in the close recovery bundle", async () => {
    const persistence = createPendingCompletedTurnPersistenceRegistry();
    const runtime = createChatTurnRuntime({
      registerQuiescence: true,
      pendingCompletedTurnPersistence: persistence,
    });
    await expect(
      runtime.persistCompletedTurn({
        turnId: "turn-1",
        workspaceIdentity: {
          path: "/workspaces/novel",
          openRevision: 2,
        },
        projectId: "project-1",
        sessionId: "session-1",
        userMessage: {
          id: "user-1",
          sessionId: "session-1",
          role: "user",
          content: "recoverable question",
          createdAt: "2026-07-30T00:00:00.000Z",
        },
        assistantMessage: {
          id: "assistant-1",
          sessionId: "session-1",
          role: "assistant",
          content: "recoverable answer",
          createdAt: "2026-07-30T00:00:00.001Z",
        },
        retry: vi
          .fn()
          .mockRejectedValue(new Error("secret database failure detail")),
      }),
    ).rejects.toThrow();

    await exportRecoveryDrafts([]);

    const serialized = String(saveTextFile.mock.calls[0]?.[2]);
    const bundle = JSON.parse(serialized) as {
      providers: Array<Record<string, unknown>>;
    };
    expect(bundle.providers).toContainEqual(
      expect.objectContaining({
        kind: "chat-completed-turn",
        projectId: "project-1",
        sessionId: "session-1",
        userMessage: expect.objectContaining({
          content: "recoverable question",
        }),
        assistantMessage: expect.objectContaining({
          content: "recoverable answer",
        }),
      }),
    );
    expect(serialized).not.toContain("secret database failure detail");

    discardQuiescenceProviders();
    expect(runtime.hasPendingTurns()).toBe(false);
  });
});
