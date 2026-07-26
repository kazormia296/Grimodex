import { describe, expect, it, vi } from "vitest";
import {
  downloadHostedEditorHandoff,
  type DownloadHostedEditorHandoffDependencies,
} from "./downloadHostedEditorHandoff";

function sqliteBytes(): Uint8Array {
  const bytes = new Uint8Array(100);
  bytes.set(new TextEncoder().encode("SQLite format 3\0"));
  bytes[16] = 0x10;
  bytes[17] = 0x00;
  return bytes;
}

function createHarness(
  overrides: Partial<DownloadHostedEditorHandoffDependencies> = {},
) {
  const calls: string[] = [];
  const exportWorkspace = vi.fn(async () => {
    calls.push("export-workspace");
    return sqliteBytes();
  });
  const saveTextFile = vi.fn(
    async (
      _suggestedName: string,
      _filter: { name: string; extensions: string[] },
      _contents: string,
      _mime?: string,
    ) => {
      calls.push("save-file");
      return "White Lighthouse.grimodex-handoff";
    },
  );
  const dependencies: DownloadHostedEditorHandoffDependencies = {
    flushAllAutoSaves: vi.fn(async () => {
      calls.push("flush-autosaves");
    }),
    registeredSaveHandlerIds: vi.fn(() => ["scene-1", "scene-2"]),
    saveScene: vi.fn(async (sceneId: string) => {
      calls.push(`save-scene:${sceneId}`);
    }),
    awaitAllPendingSceneWrites: vi.fn(async () => {
      calls.push("await-scene-writes");
    }),
    getHostedEditorRuntime: () => ({
      exportWorkspace,
    }),
    getCurrentProjectId: () => "project-1",
    getProject: vi.fn(async () => ({ title: "White Lighthouse" })),
    resolveUiLanguage: () => "en",
    saveTextFile,
    now: () => "2026-07-19T03:04:05.000Z",
    ...overrides,
  };

  return { calls, dependencies, exportWorkspace, saveTextFile };
}

describe("downloadHostedEditorHandoff", () => {
  it("flushes live editors and pending scene writes before exporting the workspace", async () => {
    const harness = createHarness();

    await expect(
      downloadHostedEditorHandoff(harness.dependencies),
    ).resolves.toBe("White Lighthouse.grimodex-handoff");

    expect(harness.calls).toEqual([
      "flush-autosaves",
      "save-scene:scene-1",
      "save-scene:scene-2",
      "await-scene-writes",
      "export-workspace",
      "save-file",
    ]);
    const handoff = JSON.parse(
      harness.saveTextFile.mock.calls[0]![2],
    ) as Record<string, unknown>;
    expect(handoff).toMatchObject({
      schemaVersion: "grimodex/web-editor-workspace-handoff/1",
      sourceMode: "standalone",
      uiLanguage: "en",
      projectId: "project-1",
      title: "White Lighthouse",
    });
  });

  it("does not export or save a file when autosave flushing fails", async () => {
    const failure = new Error("autosave flush failed");
    const harness = createHarness({
      flushAllAutoSaves: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(
      downloadHostedEditorHandoff(harness.dependencies),
    ).rejects.toBe(failure);

    expect(harness.dependencies.saveScene).not.toHaveBeenCalled();
    expect(
      harness.dependencies.awaitAllPendingSceneWrites,
    ).not.toHaveBeenCalled();
    expect(harness.exportWorkspace).not.toHaveBeenCalled();
    expect(harness.saveTextFile).not.toHaveBeenCalled();
  });

  it("does not export or save a file when a dirty live editor cannot be saved", async () => {
    const failure = new Error("scene save failed");
    const harness = createHarness({
      registeredSaveHandlerIds: vi.fn(() => ["scene-1"]),
      saveScene: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(
      downloadHostedEditorHandoff(harness.dependencies),
    ).rejects.toBe(failure);

    expect(
      harness.dependencies.awaitAllPendingSceneWrites,
    ).not.toHaveBeenCalled();
    expect(harness.exportWorkspace).not.toHaveBeenCalled();
    expect(harness.saveTextFile).not.toHaveBeenCalled();
  });
});
