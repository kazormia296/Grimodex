import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: {},
}));

import { invoke } from "@/lib/tauri";
import { searchChatMessages } from "./chatHistoryApi";

const mockInvoke = vi.mocked(invoke);

describe("searchChatMessages", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it("uses the typed chat-history FTS read model and maps its row shape", async () => {
    mockInvoke.mockResolvedValueOnce([
      {
        msg_id: "message-1",
        session_id: "session-1",
        session_title: "Gate notes",
        node_id: "scene-1",
        codex_anchor_id: null,
        snippet_anchor_id: null,
        role: "assistant",
        content: "The moonstone opened the gate.",
        highlighted_content: "The \u0001moonstone\u0002 opened the gate.",
        created_at: "2025-01-01T00:00:00Z",
        session_updated_at: "2025-01-02T00:00:00Z",
      },
    ]);

    await expect(
      searchChatMessages("project-1", "moonstone, gate"),
    ).resolves.toEqual([
      {
        msgId: "message-1",
        sessionId: "session-1",
        sessionTitle: "Gate notes",
        nodeId: "scene-1",
        codexAnchorId: null,
        snippetAnchorId: null,
        role: "assistant",
        content: "The moonstone opened the gate.",
        highlightedContent: "The \u0001moonstone\u0002 opened the gate.",
        createdAt: "2025-01-01T00:00:00Z",
        sessionUpdatedAt: "2025-01-02T00:00:00Z",
      },
    ]);
    expect(mockInvoke).toHaveBeenCalledExactlyOnceWith("fts_search", {
      projectId: "project-1",
      query: "moonstone, gate",
      scope: "chat_history",
      limit: 50,
    });
  });

  it("does not invoke FTS for blank or unmatchable short queries", async () => {
    await expect(searchChatMessages("project-1", "  ")).resolves.toEqual([]);
    await expect(searchChatMessages("project-1", "of")).resolves.toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
