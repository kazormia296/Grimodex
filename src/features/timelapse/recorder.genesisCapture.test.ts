// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, dbSelectMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  dbSelectMock: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));
vi.mock("@/db/client", () => ({
  db: {
    select: dbSelectMock,
  },
}));

import {
  _resetRecorderForTests,
  flushNow,
  initRecorderForProject as initRecorderForProjectImpl,
  recordChangeEvent,
  setRecorderEnabled,
} from "./recorder";
import {
  createLoadedTimelapseDescriptor,
  handleSceneEditorTransaction,
  type SceneEditorTransactionPorts,
} from "@/features/editor/sceneEditorTransactionPipeline";
import { beginTimelapseGenesisBarrier } from "./genesisBarrier";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import {
  getCurrentWorkspaceIdentity,
  setCurrentWorkspaceIdentity,
} from "@/runtime/workspaceIdentity";

const editors: Editor[] = [];

function captureEditorStep(projectId: string, sceneId: string): void {
  const editor = new Editor({
    extensions: [StarterKit],
    content: "<p>body</p>",
  });
  editors.push(editor);
  const ports: SceneEditorTransactionPorts = {
    recordChangeEvent,
    reportTimelapseFailure: vi.fn(),
    getUnplacedBeatStore: () => ({
      getBeats: () => [],
      addBeat: vi.fn(),
      removeBeat: vi.fn(),
    }),
    setNodePreview: vi.fn(),
    markStart: vi.fn(),
    markEnd: vi.fn(),
  };

  handleSceneEditorTransaction(
    {
      transaction: editor.state.tr.insertText("!", 1),
      timelapseDescriptor: createLoadedTimelapseDescriptor(projectId, {
        kind: "tree",
        id: sceneId,
        nodeType: "scene",
        storage: "database",
        loadedVersion: 1,
      }),
      beatSceneId: sceneId,
      isApplyingExternalUpdate: false,
      beatIndexRef: { current: null },
    },
    ports,
  );
}

function setupEmptyTail(): void {
  dbSelectMock.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    }),
  }));
}

async function initRecorderForProject(projectId: string): Promise<boolean> {
  publishCurrentProjectId(projectId);
  if (getCurrentWorkspaceIdentity() === null) {
    setCurrentWorkspaceIdentity({
      path: "/workspace/recorder-genesis-test.gdx",
      openRevision: 1,
    });
  }
  return initRecorderForProjectImpl(projectId);
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  _resetRecorderForTests();
  setupEmptyTail();
  invokeMock.mockResolvedValue({ tailSequence: 1 });
  setRecorderEnabled(true);
  await initRecorderForProject("project-old");
});

afterEach(() => {
  _resetRecorderForTests();
  for (const editor of editors.splice(0)) editor.destroy();
  vi.useRealTimers();
});

describe("recorder genesis capture authority", () => {
  it("retains a transaction carrying the target owner and flushes it exactly once after completion and rebind", async () => {
    const genesis = beginTimelapseGenesisBarrier("project-target");

    captureEditorStep("project-target", "scene-1");
    await Promise.resolve();
    expect(invokeMock).not.toHaveBeenCalled();

    genesis.complete();
    await initRecorderForProject("project-target");
    await flushNow();
    await flushNow();

    expect(invokeMock).toHaveBeenCalledExactlyOnceWith(
      "timelapse_append_batch",
      expect.objectContaining({
        projectId: "project-target",
        events: [
          expect.objectContaining({
            entityId: "scene-1",
            opType: "doc.step",
          }),
        ],
      }),
    );
  });

  it("rejects a transaction carrying the old owner instead of contaminating the target queue", async () => {
    const genesis = beginTimelapseGenesisBarrier("project-target");

    captureEditorStep("project-old", "scene-old");

    genesis.complete();
    await initRecorderForProject("project-target");
    await flushNow();

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("retries a rejected chain-tail bind without discarding target capture", async () => {
    const genesis = beginTimelapseGenesisBarrier("project-target");
    recordChangeEvent({
      domain: "editor",
      opType: "doc.step",
      projectId: "project-target",
      entityType: "scene",
      entityId: "scene-retry",
      payload: { steps: ["retry"] },
    });
    dbSelectMock
      .mockImplementationOnce(() => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => Promise.reject(new Error("tail read E1")),
            }),
          }),
        }),
      }))
      .mockImplementation(() => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: () => Promise.resolve([]) }),
          }),
        }),
      }));

    await expect(initRecorderForProject("project-target")).rejects.toThrow(
      "tail read E1",
    );
    await expect(initRecorderForProject("project-target")).resolves.toBe(true);
    genesis.complete();
    await flushNow();

    expect(invokeMock).toHaveBeenCalledExactlyOnceWith(
      "timelapse_append_batch",
      expect.objectContaining({
        projectId: "project-target",
        events: [expect.objectContaining({ entityId: "scene-retry" })],
      }),
    );
  });
});
