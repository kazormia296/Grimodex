import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  currentProjectId: "project-1",
  lastCommand: null as string | null,
}));

vi.mock("@/lib/tauri", () => ({ invoke: mocks.invoke }));
vi.mock("@/application/project/currentProjectAuthority", () => ({
  getCurrentProjectId: () => mocks.currentProjectId,
}));
vi.mock("@/features/semantic-search/scheduler", () => ({
  scheduleCodexIndex: vi.fn(),
}));
vi.mock("@/features/ime/scheduler", () => ({
  scheduleImeExportRefresh: vi.fn(),
}));
vi.mock("@/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () =>
          Promise.resolve(
            mocks.lastCommand === "codex_create"
              ? [
                  {
                    id: "codex-1",
                    projectId: "project-1",
                    type: "character",
                    name: "Codex 1",
                    content: '{"type":"doc","content":[]}',
                    version: 1,
                  },
                ]
              : mocks.lastCommand === "snippet_create"
                ? [
                    {
                      id: "snippet-1",
                      projectId: "project-1",
                      title: "Snippet 1",
                      content: '{"type":"doc","content":[]}',
                      version: 1,
                    },
                  ]
                : [],
          ),
      }),
    }),
  },
}));

import { createCodexEntry } from "@/features/codex/api";
import { createSnippet } from "@/features/snippets/api";
import { createNode } from "@/features/tree/api";
import {
  _resetTimelapseGenesisBarriersForTests,
  beginTimelapseGenesisBarrier,
} from "./genesisBarrier";

const createCases = [
  {
    label: "tree scene",
    command: "tree_node_create",
    create: () =>
      createNode({
        id: "scene-1",
        projectId: "project-1",
        nodeType: "scene",
        title: "Scene 1",
        sortOrder: "a0",
        content: '{"type":"doc","content":[]}',
      }),
  },
  {
    label: "Codex entry",
    command: "codex_create",
    create: () =>
      createCodexEntry(
        {
          id: "codex-1",
          projectId: "project-1",
          type: "character",
          name: "Codex 1",
          content: '{"type":"doc","content":[]}',
        },
        { suppressImeExport: true },
      ),
  },
  {
    label: "snippet",
    command: "snippet_create",
    create: () =>
      createSnippet({
        id: "snippet-1",
        projectId: "project-1",
        title: "Snippet 1",
        content: '{"type":"doc","content":[]}',
      }),
  },
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  _resetTimelapseGenesisBarriersForTests();
  mocks.currentProjectId = "project-1";
  mocks.lastCommand = null;
  mocks.invoke.mockImplementation(async (command: string) => {
    mocks.lastCommand = command;
    if (command === "tree_node_create") {
      return {
        id: "scene-1",
        projectId: "project-1",
        nodeType: "scene",
        title: "Scene 1",
        sortOrder: "a0",
        version: 1,
      };
    }
    return {
      entityId: command === "codex_create" ? "codex-1" : "snippet-1",
      version: 1,
      changeEventUid: "change-1",
      maintenanceTransactionId: "maintenance-1",
      undoJournalId: "undo-1",
    };
  });
});

describe("body create writers genesis barrier", () => {
  it.each(createCases)(
    "does not invoke Native for $label while genesis is pending",
    async ({ command, create }) => {
      const genesis = beginTimelapseGenesisBarrier("project-1");
      const task = create();

      await Promise.resolve();
      const callsBeforeRelease = mocks.invoke.mock.calls.length;
      genesis.complete();
      await task;

      expect(callsBeforeRelease).toBe(0);
      expect(mocks.invoke).toHaveBeenCalledTimes(1);
      expect(mocks.invoke).toHaveBeenCalledWith(command, expect.any(Object));
    },
  );

  it.each(createCases)(
    "fails closed without invoking Native for $label after genesis failure",
    async ({ create }) => {
      const genesis = beginTimelapseGenesisBarrier("project-1");
      const failure = new Error("genesis E1");
      genesis.fail(failure);

      await expect(create()).rejects.toMatchObject({
        name: "TimelapseGenesisBarrierError",
        cause: failure,
      });
      expect(mocks.invoke).not.toHaveBeenCalled();
    },
  );
});
