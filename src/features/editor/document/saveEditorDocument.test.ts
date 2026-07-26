import { describe, expect, it, vi } from "vitest";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { AlreadyNotifiedSaveError } from "./saveErrors";
import {
  saveEditorDocument,
  type EditorDocumentServices,
} from "./saveEditorDocument";
import type { LoadedEditorBinding } from "./types";

function makeDoc(): ProseMirrorNode {
  return {
    toJSON: () => ({ type: "doc", content: [] }),
  } as unknown as ProseMirrorNode;
}

function makeServices(snippetResult = true): EditorDocumentServices & {
  persistSceneBody: ReturnType<typeof vi.fn>;
  updateCodexPhase: ReturnType<typeof vi.fn>;
  updateCodexText: ReturnType<typeof vi.fn>;
  updateSnippet: ReturnType<typeof vi.fn>;
  updateChronicleEvent: ReturnType<typeof vi.fn>;
  serializeSnippet: ReturnType<typeof vi.fn>;
} {
  return {
    persistSceneBody: vi.fn().mockResolvedValue(undefined),
    updateCodexPhase: vi.fn().mockResolvedValue(undefined),
    updateCodexText: vi.fn().mockResolvedValue(undefined),
    updateSnippet: vi.fn().mockResolvedValue(snippetResult),
    updateChronicleEvent: vi.fn().mockResolvedValue(undefined),
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

      await saveEditorDocument(binding, doc, services);

      expect(services.persistSceneBody).toHaveBeenCalledOnce();
      expect(services.persistSceneBody).toHaveBeenCalledWith(binding.id, doc);
      expect(services.updateCodexText).not.toHaveBeenCalled();
      expect(services.updateSnippet).not.toHaveBeenCalled();
    },
  );

  it("routes Codex base content through updateCodexText once", async () => {
    const services = makeServices();
    const binding: LoadedEditorBinding = {
      kind: "codex",
      id: "codex-1",
      phaseId: null,
    };

    await saveEditorDocument(binding, doc, services);

    expect(services.updateCodexText).toHaveBeenCalledOnce();
    expect(services.updateCodexText).toHaveBeenCalledWith("codex-1", {
      content: '{"type":"doc","content":[]}',
    });
    expect(services.updateCodexPhase).not.toHaveBeenCalled();
  });

  it("routes Codex phase content through updateCodexPhase once", async () => {
    const services = makeServices();
    const binding: LoadedEditorBinding = {
      kind: "codex",
      id: "codex-1",
      phaseId: "phase-1",
    };

    await saveEditorDocument(binding, doc, services);

    expect(services.updateCodexPhase).toHaveBeenCalledOnce();
    expect(services.updateCodexPhase).toHaveBeenCalledWith("phase-1", {
      contentOverride: '{"type":"doc","content":[]}',
    });
    expect(services.updateCodexText).not.toHaveBeenCalled();
  });

  it("serializes and updates a snippet once", async () => {
    const services = makeServices();
    const binding: LoadedEditorBinding = {
      kind: "snippet",
      id: "snippet-1",
    };

    await saveEditorDocument(binding, doc, services);

    expect(services.serializeSnippet).toHaveBeenCalledOnce();
    expect(services.updateSnippet).toHaveBeenCalledOnce();
    expect(services.updateSnippet).toHaveBeenCalledWith("snippet-1", {
      content: "<p>snippet</p>",
    });
  });

  it("converts a failed snippet update to AlreadyNotifiedSaveError", async () => {
    const services = makeServices(false);
    const binding: LoadedEditorBinding = {
      kind: "snippet",
      id: "snippet-1",
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
    };

    await saveEditorDocument(binding, doc, services);

    expect(services.updateChronicleEvent).toHaveBeenCalledOnce();
    expect(services.updateChronicleEvent).toHaveBeenCalledWith({
      eventId: "event-1",
      detail: '{"type":"doc","content":[]}',
    });
  });
});
