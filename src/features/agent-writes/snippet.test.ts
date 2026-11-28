import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HistoryCommand } from "@/store/globalHistoryStore";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { _resetTimelapseGenesisBarriersForTests } from "@/features/timelapse/genesisBarrier";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  history: {
    isReplaying: true,
    push: vi.fn<(command: HistoryCommand) => void>(),
  },
  applyUndoJournal: vi.fn(),
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
    getState: () => h.history,
  },
}));
vi.mock("./authorshipSpans", () => ({
  extractAiSpansFromPmJson: () => [],
}));
vi.mock("./codex", () => ({
  markCodexContentAsAi: (content: string) => content,
}));
vi.mock("./undoJournal", () => ({ applyUndoJournal: h.applyUndoJournal }));

import { agentCreateSnippet, projectSnippetWrite } from "./snippet";

describe("agentCreateSnippet idempotency contract", () => {
  beforeEach(() => {
    _resetTimelapseGenesisBarriersForTests();
    publishCurrentProjectId("project-1");
    setCurrentWorkspaceIdentity({
      path: "/workspace/snippet.test.gdx",
      openRevision: 1,
    });

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

describe("Native snippet write projection", () => {
  it("keeps the receipt undoable when the current list hides the snippet", async () => {
    vi.clearAllMocks();
    h.history.isReplaying = false;
    setCurrentWorkspaceIdentity({ path: "/fixture", openRevision: 2 });
    await projectSnippetWrite(
      "project-1",
      "filtered",
      "snippet-journal",
      () => true,
    );
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.history.push).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "snippets",
        entityId: "filtered",
        operationId: "snippet-journal",
      }),
    );
    const [command] = h.history.push.mock.calls[0]!;
    await command.undo();
    await command.redo();
    expect(h.applyUndoJournal.mock.calls).toEqual([
      ["snippet-journal", "undo"],
      ["snippet-journal", "redo"],
    ]);
  });
});
