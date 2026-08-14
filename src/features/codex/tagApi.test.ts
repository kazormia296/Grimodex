import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));
vi.mock("@/db/client", () => ({ db: {} }));

import { setEntryTags, setSnippetEntryTags } from "./tagApi";

describe("typed entity tag persistence", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  it("sets Codex tags without sending renderer-authored SQL", async () => {
    await setEntryTags("codex-1", ["tag-2", "tag-1"], {
      projectId: "project-1",
      writeContext: {
        requestId: "tag-request-1",
        sessionId: "tag-session-1",
        eventUid: "tag-event-1",
        origin: "import",
        originalTransactionId: null,
        undoJournalId: null,
      },
    });

    expect(invokeMock).toHaveBeenCalledExactlyOnceWith("entity_tags_set", {
      payload: {
        entityKind: "codex",
        entityId: "codex-1",
        tagIds: ["tag-2", "tag-1"],
        updatedAt: expect.any(String),
        projectId: "project-1",
        requestId: "tag-request-1",
        sessionId: "tag-session-1",
        eventUid: "tag-event-1",
        origin: "import",
        originalTransactionId: null,
        undoJournalId: null,
      },
    });
  });

  it("sets snippet tags through the same typed aggregate", async () => {
    await setSnippetEntryTags("snippet-1", [], { projectId: "project-1" });

    expect(invokeMock).toHaveBeenCalledExactlyOnceWith("entity_tags_set", {
      payload: {
        entityKind: "snippet",
        entityId: "snippet-1",
        tagIds: [],
        updatedAt: null,
        projectId: "project-1",
        requestId: expect.any(String),
        sessionId: expect.any(String),
        eventUid: expect.any(String),
        origin: "human",
        originalTransactionId: null,
        undoJournalId: null,
      },
    });
  });
});
