import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  loadEntries: vi.fn(),
  entries: [{ id: "snippet-request-1", title: "Excerpt" }],
}));

vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/lib/tauri", () => ({ invoke: h.invoke }));
vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: () => false,
}));
vi.mock("@/features/timelapse/recorder", () => ({
  getRecorderSessionId: () => "session-1",
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "project-1",
}));
vi.mock("@/features/snippets/snippetStore", () => ({
  useSnippetStore: {
    getState: () => ({
      entries: h.entries,
      loadEntries: h.loadEntries,
    }),
  },
}));
vi.mock("@/store/globalHistoryStore", () => ({
  useGlobalHistoryStore: {
    getState: () => ({ isReplaying: true, push: vi.fn() }),
  },
}));
vi.mock("./authorshipSpans", () => ({
  extractAiSpansFromPmJson: () => [],
}));
vi.mock("./codex", () => ({
  markCodexContentAsAi: (content: string) => content,
}));
vi.mock("./undoJournal", () => ({ applyUndoJournal: vi.fn() }));

import { agentCreateSnippet } from "./snippet";

describe("agentCreateSnippet idempotency contract", () => {
  beforeEach(() => {
    h.invoke.mockReset();
    h.loadEntries.mockReset();
    h.invoke.mockResolvedValue({
      entityId: "snippet-request-1",
      version: 1,
      changeEventUid: "change-1",
      undoJournalId: "undo-1",
    });
    h.loadEntries.mockResolvedValue(undefined);
  });

  it("passes a caller-reusable snippetId through the create payload", async () => {
    await agentCreateSnippet({
      requestId: "agent-tool:snippet-request",
      snippetId: "snippet-request-1",
      title: "Excerpt",
    });

    expect(h.invoke).toHaveBeenCalledWith("agent_snippet_create", {
      payload: expect.objectContaining({
        requestId: "agent-tool:snippet-request",
        snippetId: "snippet-request-1",
        projectId: "project-1",
        sessionId: "session-1",
        title: "Excerpt",
      }),
    });
  });
});
