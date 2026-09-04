import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  loadCodexEntries: vi.fn(),
  loadSnippetEntries: vi.fn(),
  currentProjectId: "project-1",
  codexEntries: [
    {
      id: "entry-1",
      projectId: "project-1",
      type: "character",
      name: "Before",
      version: 4,
    },
    {
      id: "entry-created",
      projectId: "project-1",
      type: "character",
      name: "Created",
      version: 1,
    },
  ],
  snippetEntries: [
    {
      id: "snippet-1",
      projectId: "project-1",
      title: "Snippet",
      version: 1,
    },
  ],
}));

vi.mock("i18next", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: () => false,
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => mocks.currentProjectId,
}));
vi.mock("@/application/project/currentProjectAuthority", () => ({
  getCurrentProjectId: () => mocks.currentProjectId,
}));
vi.mock("@/features/timelapse/recorder", () => ({
  getRecorderSessionId: () => "session-1",
  flushStrict: vi.fn(() => Promise.resolve()),
  claimTimelapseDocStepCoverage: vi.fn(() => null),
  acquireTimelapseReplacementFence: vi.fn(() => ({
    commit: vi.fn(),
    release: vi.fn(),
  })),
}));
vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: {
    getState: () => ({
      entries: mocks.codexEntries,
      loadEntries: mocks.loadCodexEntries,
    }),
  },
}));
vi.mock("@/features/snippets/snippetStore", () => ({
  useSnippetStore: {
    getState: () => ({
      entries: mocks.snippetEntries,
      loadEntries: mocks.loadSnippetEntries,
    }),
  },
}));
vi.mock("@/store/globalHistoryStore", () => ({
  useGlobalHistoryStore: {
    getState: () => ({ isReplaying: true, push: vi.fn() }),
  },
}));
vi.mock("@/features/codex/version", () => ({
  getCodexEntryVersion: () => Promise.resolve(4),
}));
vi.mock("@/features/semantic-search/scheduler", () => ({
  scheduleCodexIndex: vi.fn(),
}));
vi.mock("@/features/ime/scheduler", () => ({
  scheduleImeExportRefresh: vi.fn(),
}));
vi.mock("@/features/concurrency/documentWriteNotification", () => ({
  notifySameRendererDocumentWrite: vi.fn(),
}));
vi.mock("@/features/agent-writes/authorshipSpans", () => ({
  extractAiSpansFromPmJson: () => [],
  syntheticAiSpans: () => [],
}));
vi.mock("@/features/agent-writes/undoJournal", () => ({
  applyUndoJournal: vi.fn(),
}));

import {
  agentCreateCodexEntry,
  agentUpdateCodexEntry,
} from "@/features/agent-writes/codex";
import { agentCreateSnippet } from "@/features/agent-writes/snippet";
import {
  _resetTimelapseGenesisBarriersForTests,
  beginTimelapseGenesisBarrier,
} from "./genesisBarrier";

const body = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "body" }],
    },
  ],
});

const writeCases = [
  {
    label: "agent Codex create",
    command: "agent_codex_create",
    write: () =>
      agentCreateCodexEntry(
        {
          requestId: "request-create",
          entryId: "entry-created",
          type: "character",
          name: "Created",
          content: body,
        },
        null,
        { skipPolicyGate: true },
      ),
  },
  {
    label: "agent Codex update",
    command: "agent_codex_update",
    write: () =>
      agentUpdateCodexEntry(
        {
          requestId: "request-update",
          entryId: "entry-1",
          content: body,
        },
        null,
        { writeOpts: { skipPolicyGate: true } },
      ),
  },
  {
    label: "agent snippet create",
    command: "agent_snippet_create",
    write: () =>
      agentCreateSnippet({
        requestId: "request-snippet",
        snippetId: "snippet-1",
        title: "Snippet",
        content: body,
      }),
  },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  _resetTimelapseGenesisBarriersForTests();
  mocks.currentProjectId = "project-1";
  mocks.invoke.mockImplementation(async (command: string) => ({
    entityId:
      command === "agent_codex_create"
        ? "entry-created"
        : command === "agent_codex_update"
          ? "entry-1"
          : "snippet-1",
    version: command === "agent_codex_update" ? 5 : 1,
    changeEventUid: "change-1",
    undoJournalId: "undo-1",
    maintenanceTransactionId: "maintenance-1",
  }));
  mocks.loadCodexEntries.mockResolvedValue(undefined);
  mocks.loadSnippetEntries.mockResolvedValue(undefined);
});

describe("agent body writers genesis barrier", () => {
  it.each(writeCases)(
    "does not invoke Native for $label while genesis is pending",
    async ({ command, write }) => {
      const genesis = beginTimelapseGenesisBarrier("project-1");
      const task = write();

      await Promise.resolve();
      const callsBeforeRelease = mocks.invoke.mock.calls.length;
      genesis.complete();
      await task;

      expect(callsBeforeRelease).toBe(0);
      expect(mocks.invoke).toHaveBeenCalledTimes(1);
      expect(mocks.invoke).toHaveBeenCalledWith(command, expect.any(Object));
    },
  );

  it.each(writeCases)(
    "fails closed without invoking Native for $label after genesis failure",
    async ({ write }) => {
      const genesis = beginTimelapseGenesisBarrier("project-1");
      const failure = new Error("genesis E1");
      genesis.fail(failure);

      await expect(write()).rejects.toMatchObject({
        name: "TimelapseGenesisBarrierError",
        cause: failure,
      });
      expect(mocks.invoke).not.toHaveBeenCalled();
    },
  );
});
