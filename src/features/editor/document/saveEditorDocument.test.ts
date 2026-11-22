import { afterEach, describe, expect, it, vi } from "vitest";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { AlreadyNotifiedSaveError } from "./saveErrors";
import {
  saveEditorDocument,
  type EditorDocumentServices,
} from "./saveEditorDocument";
import type { LoadedEditorBinding } from "./types";
import type { VersionedSaveOutcome } from "@/lib/saveOutcome";
import {
  _inspectOwnSaveCapturesForTests,
  _resetRecorderForTests,
} from "@/features/timelapse/recorder";
import type { TimelapseDocumentIdentity } from "@/features/timelapse/documentCoverage";

const persistedSceneBody = {
  contentJson: '{"type":"doc","content":[]}',
  contentVersion: 9,
  contentUpdatedAt: "2026-07-31T00:00:00.000Z",
};

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
    persistSceneBody: vi.fn().mockResolvedValue(persistedSceneBody),
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
      {
        kind: "tree",
        id: "scene-1",
        nodeType: "scene",
        storage: "database",
        loadedVersion: 8,
      },
    ],
    [
      "note",
      {
        kind: "tree",
        id: "note-1",
        nodeType: "note",
        storage: "database",
        loadedVersion: 3,
      },
    ],
  ] as const)(
    "routes %s through persistSceneBody once",
    async (_label, binding) => {
      const services = makeServices();

      const result = await saveEditorDocument(binding, doc, services);

      expect(services.persistSceneBody).toHaveBeenCalledOnce();
      // editor の保存は「自分の autosave」の判別子を付ける（EAR-1）。
      expect(services.persistSceneBody).toHaveBeenCalledWith(binding.id, doc, {
        baseVersion: binding.loadedVersion,
        writer: "editor-autosave",
      });
      expect(services.updateCodexText).not.toHaveBeenCalled();
      expect(services.updateSnippet).not.toHaveBeenCalled();
      expect(result.binding).toEqual({
        ...binding,
        loadedVersion: persistedSceneBody.contentVersion,
      });
      expect(result.persistedSceneBody).toEqual(persistedSceneBody);
    },
  );

  it("forwards the preexisting-draft permit to scene persistence", async () => {
    const services = makeServices();
    const binding: LoadedEditorBinding = {
      kind: "tree",
      id: "scene-1",
      nodeType: "scene",
      storage: "database",
      loadedVersion: 8,
    };

    await saveEditorDocument(binding, doc, services, {
      preexistingDraft: true,
    });

    expect(services.persistSceneBody).toHaveBeenCalledWith("scene-1", doc, {
      baseVersion: 8,
      preexistingDraft: true,
      writer: "editor-autosave",
    });
  });

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
    expect(services.updateCodexText.mock.calls[0]?.[2]).not.toHaveProperty(
      "preexistingDraft",
    );
    expect(services.updateCodexPhase).not.toHaveBeenCalled();
    expect(result.binding).toEqual({ ...binding, loadedVersion: 4 });
  });

  it("forwards the preexisting-draft permit to Codex base content", async () => {
    const services = makeServices();
    const binding: LoadedEditorBinding = {
      kind: "codex",
      id: "codex-1",
      phaseId: null,
      loadedVersion: 3,
    };

    await saveEditorDocument(binding, doc, services, {
      preexistingDraft: true,
    });

    expect(services.updateCodexText).toHaveBeenCalledWith(
      "codex-1",
      {
        content: '{"type":"doc","content":[]}',
      },
      { baseVersion: 3, preexistingDraft: true },
    );
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
      { baseVersion: 4, onFailure: expect.any(Function) },
    );
    expect(services.updateCodexPhase.mock.calls[0]?.[2]).not.toHaveProperty(
      "preexistingDraft",
    );
    expect(services.updateCodexText).not.toHaveBeenCalled();
    expect(result.binding).toEqual({ ...binding, loadedVersion: 5 });
  });

  it("forwards the preexisting-draft permit to Codex phase content", async () => {
    const services = makeServices();
    const binding: LoadedEditorBinding = {
      kind: "codex",
      id: "codex-1",
      phaseId: "phase-1",
      loadedVersion: 4,
    };

    await saveEditorDocument(binding, doc, services, {
      preexistingDraft: true,
    });

    expect(services.updateCodexPhase).toHaveBeenCalledWith(
      "phase-1",
      {
        contentOverride: '{"type":"doc","content":[]}',
      },
      {
        baseVersion: 4,
        preexistingDraft: true,
        onFailure: expect.any(Function),
      },
    );
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
    expect(services.updateSnippet.mock.calls[0]?.[2]).not.toHaveProperty(
      "preexistingDraft",
    );
    expect(result.binding).toEqual({ ...binding, loadedVersion: 6 });
  });

  it("forwards the preexisting-draft permit to snippet content", async () => {
    const services = makeServices();
    const binding: LoadedEditorBinding = {
      kind: "snippet",
      id: "snippet-1",
      loadedVersion: 5,
    };

    await saveEditorDocument(binding, doc, services, {
      preexistingDraft: true,
    });

    expect(services.updateSnippet).toHaveBeenCalledWith(
      "snippet-1",
      {
        content: "<p>snippet</p>",
      },
      { baseVersion: 5, preexistingDraft: true },
    );
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
    expect(services.updateChronicleEvent.mock.calls[0]).toHaveLength(1);
    expect(result.binding).toEqual({ ...binding, loadedVersion: 7 });
  });

  it("forwards the preexisting-draft permit to a Chronicle Event", async () => {
    const services = makeServices();
    const binding: LoadedEditorBinding = {
      kind: "chronicle-event",
      id: "event-1",
      loadedVersion: 6,
    };

    await saveEditorDocument(binding, doc, services, {
      preexistingDraft: true,
    });

    expect(services.updateChronicleEvent).toHaveBeenCalledWith(
      {
        eventId: "event-1",
        detail: '{"type":"doc","content":[]}',
        baseVersion: 6,
      },
      { preexistingDraft: true },
    );
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
  describe("store が握りつぶした失敗の cause を AlreadyNotifiedSaveError に載せる", () => {
    const quarantined = Object.assign(
      new Error("WORKSPACE_QUARANTINED: fenced"),
      { code: "WORKSPACE_QUARANTINED" },
    );

    it("Codex base: outcome.cause", async () => {
      const services = makeServices();
      services.updateCodexText.mockResolvedValue({
        persisted: false,
        cause: quarantined,
      });
      const error = await saveEditorDocument(
        { kind: "codex", id: "codex-1", phaseId: null, loadedVersion: 3 },
        doc,
        services,
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AlreadyNotifiedSaveError);
      expect((error as AlreadyNotifiedSaveError).cause).toBe(quarantined);
    });

    it("snippet: outcome.cause", async () => {
      const services = makeServices({ persisted: false, cause: quarantined });
      const error = await saveEditorDocument(
        { kind: "snippet", id: "snippet-1", loadedVersion: 5 },
        doc,
        services,
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AlreadyNotifiedSaveError);
      expect((error as AlreadyNotifiedSaveError).cause).toBe(quarantined);
    });

    it("Codex phase: onFailure で受けた error", async () => {
      const services = makeServices();
      services.updateCodexPhase.mockImplementation(
        async (
          _id: string,
          _data: unknown,
          options: { onFailure?: (cause: unknown) => void },
        ) => {
          options.onFailure?.(quarantined);
          return null;
        },
      );
      const error = await saveEditorDocument(
        { kind: "codex", id: "codex-1", phaseId: "phase-1", loadedVersion: 3 },
        doc,
        services,
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AlreadyNotifiedSaveError);
      expect((error as AlreadyNotifiedSaveError).cause).toBe(quarantined);
    });

    it("cause が無い失敗（衝突・行なし）は cause 無しのまま", async () => {
      const services = makeServices({ persisted: false });
      const error = await saveEditorDocument(
        { kind: "snippet", id: "snippet-1", loadedVersion: 5 },
        doc,
        services,
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AlreadyNotifiedSaveError);
      expect((error as AlreadyNotifiedSaveError).cause).toBeUndefined();
    });
  });
});

describe("EAR-24 Codex 本文・断片の保存は、本文の捕捉と同じ同期区間で自分の保存の hold を開いて渡す", () => {
  afterEach(() => {
    _resetRecorderForTests();
  });

  const codexIdentity: TimelapseDocumentIdentity = {
    projectId: "project-1",
    domain: "codex",
    entityType: "codex_entry",
    entityId: "codex-1",
  };
  const snippetIdentity: TimelapseDocumentIdentity = {
    projectId: "project-1",
    domain: "snippet",
    entityType: "snippet",
    entityId: "snippet-1",
  };

  /** 本文の捕捉（toJSON／serializeSnippet）の時点で hold が既に開いているかを記録する doc。 */
  function makeProbeDoc(identity: TimelapseDocumentIdentity) {
    const seen: number[] = [];
    const doc = {
      toJSON: () => {
        seen.push(_inspectOwnSaveCapturesForTests(identity).activeCaptures);
        return { type: "doc", content: [] };
      },
    } as unknown as ProseMirrorNode;
    return { doc, seen };
  }

  it("Codex 本文：toJSON の前に hold を開いて store に渡し、返ったあとには閉じている", async () => {
    const services = makeServices();
    const { doc, seen } = makeProbeDoc(codexIdentity);
    let passed: { release: () => void } | undefined;
    services.updateCodexText.mockImplementation(
      async (
        _id: string,
        _data: unknown,
        options: { ownSaveCapture?: never },
      ) => {
        passed = options.ownSaveCapture;
        // store に届いた時点でも hold は開いている。
        expect(
          _inspectOwnSaveCapturesForTests(codexIdentity).activeCaptures,
        ).toBe(1);
        return { persisted: true, version: 4 };
      },
    );

    await saveEditorDocument(
      { kind: "codex", id: "codex-1", phaseId: null, loadedVersion: 3 },
      doc,
      services,
      { timelapseDocumentIdentity: codexIdentity },
    );

    expect(seen).toEqual([1]);
    expect(passed).toBeDefined();
    expect(_inspectOwnSaveCapturesForTests(codexIdentity).activeCaptures).toBe(
      0,
    );
  });

  it("断片：serializeSnippet の前に hold を開いて store に渡し、失敗しても閉じる", async () => {
    const services = makeServices({ persisted: false });
    const seen: number[] = [];
    services.serializeSnippet.mockImplementation(() => {
      seen.push(
        _inspectOwnSaveCapturesForTests(snippetIdentity).activeCaptures,
      );
      return "<p>snippet</p>";
    });

    const error = await saveEditorDocument(
      { kind: "snippet", id: "snippet-1", loadedVersion: 5 },
      makeDoc(),
      services,
      { timelapseDocumentIdentity: snippetIdentity },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AlreadyNotifiedSaveError);
    expect(seen).toEqual([1]);
    expect(services.updateSnippet.mock.calls[0]?.[2]).toHaveProperty(
      "ownSaveCapture",
    );
    expect(
      _inspectOwnSaveCapturesForTests(snippetIdentity).activeCaptures,
    ).toBe(0);
  });

  it("identity が無ければ hold は開かず従来の経路に倒す。phase の保存は hold を開かない", async () => {
    const services = makeServices();
    await saveEditorDocument(
      { kind: "codex", id: "codex-1", phaseId: null, loadedVersion: 3 },
      makeDoc(),
      services,
    );
    expect(services.updateCodexText.mock.calls[0]?.[2]).not.toHaveProperty(
      "ownSaveCapture",
    );
    await saveEditorDocument(
      { kind: "codex", id: "codex-1", phaseId: "phase-1", loadedVersion: 3 },
      makeDoc(),
      services,
      { timelapseDocumentIdentity: codexIdentity },
    );
    expect(services.updateCodexPhase.mock.calls[0]?.[2]).not.toHaveProperty(
      "ownSaveCapture",
    );
    expect(_inspectOwnSaveCapturesForTests(codexIdentity).activeCaptures).toBe(
      0,
    );
  });
});
