import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockInvoke,
  mockLoadEntries,
  mockGetCodexEntryVersion,
  mockNotifySameRendererDocumentWrite,
  mockScheduleCodexIndex,
  mockScheduleImeExportRefresh,
  mockEntries,
} = vi.hoisted(() => ({
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
    getState: () => ({ isReplaying: true, push: vi.fn() }),
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
vi.mock("./undoJournal", () => ({ applyUndoJournal: vi.fn() }));
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

import { agentUpdateCodexEntry, markCodexContentAsAi } from "./codex";
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
});
