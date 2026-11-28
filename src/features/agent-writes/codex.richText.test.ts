import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HistoryCommand } from "@/store/globalHistoryStore";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { _resetTimelapseGenesisBarriersForTests } from "@/features/timelapse/genesisBarrier";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";

const {
  mockInvoke,
  mockLoadEntries,
  mockGetCodexEntryVersion,
  mockNotifySameRendererDocumentWrite,
  mockScheduleCodexIndex,
  mockScheduleImeExportRefresh,
  mockEntries,
  history,
  mockApplyUndoJournal,
} = vi.hoisted(() => ({
  history: {
    isReplaying: true,
    push: vi.fn<(command: HistoryCommand) => void>(),
  },
  mockApplyUndoJournal: vi.fn(),
  mockInvoke: vi.fn(),
  mockLoadEntries: vi.fn(),
  mockGetCodexEntryVersion: vi.fn(),
  mockNotifySameRendererDocumentWrite: vi.fn(),
  mockScheduleCodexIndex: vi.fn(),
  mockScheduleImeExportRefresh: vi.fn(),
  mockEntries: [
    {
      id: "entry-1",
      name: "Before",
      type: "character",
      version: 4,
    },
  ],
}));

vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/lib/tauri", () => ({ invoke: mockInvoke }));
vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: () => false,
}));
vi.mock("@/features/timelapse/recorder", () => ({
  getRecorderSessionId: () => "session-1",
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "project-1",
}));
vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: {
    getState: () => ({
      entries: mockEntries,
      loadEntries: mockLoadEntries,
    }),
  },
}));
vi.mock("@/store/globalHistoryStore", () => ({
  useGlobalHistoryStore: {
    getState: () => history,
  },
}));
vi.mock("@/features/attribution/aiAuthorship", () => ({
  aiAuthorshipAttrs: (opts: {
    model?: string | null;
    chatMessageId?: string | null;
    traceId?: string | null;
  }) => ({
    source: "ai",
    timestamp: "2026-07-27T00:00:00.000Z",
    model: opts.model ?? null,
    chatMessageId: opts.chatMessageId ?? null,
    traceId: opts.traceId ?? null,
  }),
}));
vi.mock("./authorshipSpans", () => ({
  extractAiSpansFromPmJson: () => [],
  syntheticAiSpans: () => [],
}));
vi.mock("./undoJournal", () => ({ applyUndoJournal: mockApplyUndoJournal }));
vi.mock("@/features/codex/version", () => ({
  getCodexEntryVersion: mockGetCodexEntryVersion,
}));
vi.mock("@/features/semantic-search/scheduler", () => ({
  scheduleCodexIndex: mockScheduleCodexIndex,
}));
vi.mock("@/features/ime/scheduler", () => ({
  scheduleImeExportRefresh: mockScheduleImeExportRefresh,
}));
vi.mock("@/features/concurrency/documentWriteNotification", () => ({
  notifySameRendererDocumentWrite: mockNotifySameRendererDocumentWrite,
}));

import {
  agentCreateCodexEntry,
  agentUpdateCodexEntry,
  markCodexContentAsAi,
  projectCodexWrite,
} from "./codex";
import { validateAgentProseMirrorJson } from "./richTextInput";

const paragraphDoc = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "正文" }],
    },
  ],
});

describe("markCodexContentAsAi", () => {
  it("normalizes through the editor schema and marks text as AI-authored", () => {
    const marked = markCodexContentAsAi(paragraphDoc, {
      model: "openai/test",
      chatMessageId: "message-1",
      traceId: "trace-1",
    });

    expect(() => validateAgentProseMirrorJson(marked)).not.toThrow();
    const parsed = JSON.parse(marked) as {
      content: Array<{
        content: Array<{
          marks: Array<{ type: string; attrs: Record<string, unknown> }>;
        }>;
      }>;
    };
    expect(parsed.content[0]!.content[0]!.marks).toContainEqual({
      type: "authorship",
      attrs: expect.objectContaining({
        source: "ai",
        model: "openai/test",
        chatMessageId: "message-1",
        traceId: "trace-1",
      }),
    });
  });

  it.each([
    "not-json",
    "{}",
    JSON.stringify({
      type: "doc",
      content: [{ type: "unknown-node" }],
    }),
    JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "x",
              marks: [{ type: "unknown-mark" }],
            },
          ],
        },
      ],
    }),
  ])("rejects malformed or schema-invalid content", (input) => {
    expect(() => markCodexContentAsAi(input)).toThrow();
  });
});

describe("agentUpdateCodexEntry document notification", () => {
  beforeEach(() => {
    _resetTimelapseGenesisBarriersForTests();
    publishCurrentProjectId("project-1");
    setCurrentWorkspaceIdentity({
      path: "/workspace/codex-rich-text.test.gdx",
      openRevision: 1,
    });

    mockInvoke.mockReset();
    mockLoadEntries.mockReset();
    mockGetCodexEntryVersion.mockReset();
    mockNotifySameRendererDocumentWrite.mockReset();
    mockScheduleCodexIndex.mockReset();
    mockScheduleImeExportRefresh.mockReset();

    mockInvoke.mockResolvedValue({
      entityId: "entry-1",
      version: 5,
      changeEventUid: "change-1",
      undoJournalId: "undo-1",
    });
    mockLoadEntries.mockResolvedValue(undefined);
    mockGetCodexEntryVersion.mockResolvedValue(4);
  });

  it("notifies the exact base-document key after a successful update", async () => {
    await agentUpdateCodexEntry({ entryId: "entry-1", name: "After" });

    expect(mockNotifySameRendererDocumentWrite).toHaveBeenCalledWith(
      { kind: "codex", id: "entry-1", phaseId: null },
      {
        domain: "codex",
        opType: "entry.update",
        entityId: "entry-1",
      },
    );
  });

  it("passes a caller-reusable entryId through the create payload", async () => {
    await agentCreateCodexEntry({
      requestId: "agent-tool:codex-request",
      entryId: "entry-1",
      type: "character",
      name: "Before",
    });

    expect(mockInvoke).toHaveBeenCalledWith("agent_codex_create", {
      payload: expect.objectContaining({
        requestId: "agent-tool:codex-request",
        entryId: "entry-1",
        projectId: "project-1",
        sessionId: "session-1",
        typeSlug: "character",
        name: "Before",
      }),
    });
  });
});

describe("Native Codex write projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    history.isReplaying = false;
    setCurrentWorkspaceIdentity({ path: "/fixture", openRevision: 3 });
  });

  it.each([
    ["create_codex_entry", true, "codex.store.agentHistoryCreate"],
    ["update_codex_entry", false, "codex.store.agentHistoryUpdate"],
    ["update_codex_entry", true, "codex.store.agentHistoryUpdate"],
  ] as const)(
    "reflects %s with IME refresh %s even outside the active list",
    async (tool, refreshIme, label) => {
      let currentTurn = true;
      await projectCodexWrite(
        tool,
        "project-1",
        "out-of-view",
        "journal",
        refreshIme,
        () => currentTurn,
      );
      expect(mockInvoke).not.toHaveBeenCalled();
      expect(mockScheduleCodexIndex).toHaveBeenCalledWith("out-of-view");
      expect(mockScheduleImeExportRefresh).toHaveBeenCalledTimes(
        refreshIme ? 1 : 0,
      );
      expect(mockNotifySameRendererDocumentWrite).toHaveBeenCalledTimes(
        tool === "update_codex_entry" ? 1 : 0,
      );
      expect(history.push).toHaveBeenCalledWith(
        expect.objectContaining({
          entityId: "out-of-view",
          operationId: "journal",
          label,
          kind: "codex",
        }),
      );
      const [command] = history.push.mock.calls[0]!;
      currentTurn = false;
      await command.undo();
      expect(mockApplyUndoJournal).toHaveBeenCalledWith("journal", "undo");
      setCurrentWorkspaceIdentity({ path: "/fixture", openRevision: 4 });
      await command.redo();
      expect(mockApplyUndoJournal).toHaveBeenCalledTimes(1);
    },
  );

  it("does not notify or schedule in a replacement scope after reload", async () => {
    let current = true;
    mockLoadEntries.mockImplementationOnce(async () => {
      current = false;
    });
    await projectCodexWrite(
      "update_codex_entry",
      "project-1",
      "entry-1",
      "journal",
      true,
      () => current,
    );
    expect(mockNotifySameRendererDocumentWrite).not.toHaveBeenCalled();
    expect(mockScheduleImeExportRefresh).not.toHaveBeenCalled();
    expect(mockScheduleCodexIndex).not.toHaveBeenCalled();
    expect(history.push).toHaveBeenCalledTimes(1);
  });

  it("keeps the confirmed undo journal when reloading fails", async () => {
    const error = new Error("unavailable");
    mockLoadEntries.mockRejectedValueOnce(error);
    await expect(
      projectCodexWrite(
        "create_codex_entry",
        "project-1",
        "new",
        "journal",
        true,
        () => true,
      ),
    ).rejects.toBe(error);
    expect(history.push).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "journal" }),
    );
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
