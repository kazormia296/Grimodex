import { describe, expect, it, vi } from "vitest";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { AlreadyNotifiedSaveError } from "./saveErrors";
import {
  saveEditorDocument,
  type EditorDocumentServices,
} from "./saveEditorDocument";
import type { LoadedEditorBinding } from "./types";
import type { VersionedSaveOutcome } from "@/lib/saveOutcome";

function makeDoc(): ProseMirrorNode {
  return {
    toJSON: () => ({ type: "doc", content: [] }),
  } as unknown as ProseMirrorNode;
}

function makeServices(
  snippetResult: VersionedSaveOutcome = { persisted: true, version: 6 },
): EditorDocumentServices & {
  persistSceneBody: ReturnType<typeof vi.fn>;
  updateCodexPhase: ReturnType<typeof vi.fn>;
  updateCodexText: ReturnType<typeof vi.fn>;
  updateSnippet: ReturnType<typeof vi.fn>;
  updateChronicleEvent: ReturnType<typeof vi.fn>;
  serializeSnippet: ReturnType<typeof vi.fn>;
} {
  return {
    persistSceneBody: vi.fn().mockResolvedValue(undefined),
    updateCodexPhase: vi.fn().mockResolvedValue({ version: 5 }),
    updateCodexText: vi.fn().mockResolvedValue({ persisted: true, version: 4 }),
    updateSnippet: vi.fn().mockResolvedValue(snippetResult),
    updateChronicleEvent: vi.fn().mockResolvedValue({
      entityId: "event-1",
      version: 7,
      changeEventUid: "change-1",
      undoJournalId: "undo-1",
    }),
    serializeSnippet: vi.fn().mockReturnValue("<p>snippet</p>"),
  };
}

describe("saveEditorDocument", () => {
  const doc = makeDoc();

  it.each([
    [
      "scene",
      { kind: "tree", id: "scene-1", nodeType: "scene", storage: "database" },
    ],
    [
      "note",
      { kind: "tree", id: "note-1", nodeType: "note", storage: "database" },
    ],
  ] as const)(
    "routes %s through persistSceneBody once",
    async (_label, binding) => {
      const services = makeServices();

      const result = await saveEditorDocument(binding, doc, services);

      expect(services.persistSceneBody).toHaveBeenCalledOnce();
      expect(services.persistSceneBody).toHaveBeenCalledWith(binding.id, doc);
      expect(services.updateCodexText).not.toHaveBeenCalled();
      expect(services.updateSnippet).not.toHaveBeenCalled();
      expect(result.binding).toEqual(binding);
    },
  );

  it("routes Codex base content through updateCodexText once", async () => {
    const services = makeServices();
    const binding: LoadedEditorBinding = {
      kind: "codex",
      id: "codex-1",
      phaseId: null,
      loadedVersion: 3,
    };

    const result = await saveEditorDocument(binding, doc, services);

    expect(services.updateCodexText).toHaveBeenCalledOnce();
    expect(services.updateCodexText).toHaveBeenCalledWith(
      "codex-1",
      {
        content: '{"type":"doc","content":[]}',
      },
      { baseVersion: 3 },
    );
    expect(services.updateCodexPhase).not.toHaveBeenCalled();
    expect(result.binding).toEqual({ ...binding, loadedVersion: 4 });
  });

  it("routes Codex phase content through updateCodexPhase once", async () => {
    const services = makeServices();
    const binding: LoadedEditorBinding = {
      kind: "codex",
      id: "codex-1",
      phaseId: "phase-1",
      loadedVersion: 4,
    };

    const result = await saveEditorDocument(binding, doc, services);

    expect(services.updateCodexPhase).toHaveBeenCalledOnce();
    expect(services.updateCodexPhase).toHaveBeenCalledWith(
      "phase-1",
      {
        contentOverride: '{"type":"doc","content":[]}',
      },
      { baseVersion: 4 },
    );
    expect(services.updateCodexText).not.toHaveBeenCalled();
    expect(result.binding).toEqual({ ...binding, loadedVersion: 5 });
  });

  it("serializes and updates a snippet once", async () => {
    const services = makeServices();
    const binding: LoadedEditorBinding = {
      kind: "snippet",
      id: "snippet-1",
      loadedVersion: 5,
    };

    const result = await saveEditorDocument(binding, doc, services);

    expect(services.serializeSnippet).toHaveBeenCalledOnce();
    expect(services.updateSnippet).toHaveBeenCalledOnce();
    expect(services.updateSnippet).toHaveBeenCalledWith(
      "snippet-1",
      {
        content: "<p>snippet</p>",
      },
      { baseVersion: 5 },
    );
    expect(result.binding).toEqual({ ...binding, loadedVersion: 6 });
  });

  it("converts a failed snippet update to AlreadyNotifiedSaveError", async () => {
    const services = makeServices({ persisted: false });
    const binding: LoadedEditorBinding = {
      kind: "snippet",
      id: "snippet-1",
      loadedVersion: 5,
    };

    await expect(
      saveEditorDocument(binding, doc, services),
    ).rejects.toBeInstanceOf(AlreadyNotifiedSaveError);
    expect(services.updateSnippet).toHaveBeenCalledOnce();
  });

  it("routes a Chronicle Event through the tracked UI update once", async () => {
    const services = makeServices();
    const binding: LoadedEditorBinding = {
      kind: "chronicle-event",
      id: "event-1",
      loadedVersion: 6,
    };

    const result = await saveEditorDocument(binding, doc, services);

    expect(services.updateChronicleEvent).toHaveBeenCalledOnce();
    expect(services.updateChronicleEvent).toHaveBeenCalledWith({
      eventId: "event-1",
      detail: '{"type":"doc","content":[]}',
      baseVersion: 6,
    });
    expect(result.binding).toEqual({ ...binding, loadedVersion: 7 });
  });

  it.each([
    ["Codex base", "updateCodexText"],
    ["Codex phase", "updateCodexPhase"],
  ] as const)(
    "keeps %s failures non-persistent",
    async (_label, serviceName) => {
      const services = makeServices();
      services[serviceName].mockResolvedValue(
        serviceName === "updateCodexPhase" ? null : { persisted: false },
      );
      const binding: LoadedEditorBinding =
        serviceName === "updateCodexPhase"
          ? {
              kind: "codex",
              id: "codex-1",
              phaseId: "phase-1",
              loadedVersion: 3,
            }
          : {
              kind: "codex",
              id: "codex-1",
              phaseId: null,
              loadedVersion: 3,
            };

      await expect(
        saveEditorDocument(binding, doc, services),
      ).rejects.toBeInstanceOf(AlreadyNotifiedSaveError);
    },
  );
});
