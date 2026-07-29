import { describe, expect, it, vi } from "vitest";
import { loadEditorDocument, targetFromTab } from "./loadEditorDocument";

describe("targetFromTab", () => {
  it("keeps the tree node kind and storage in the target", () => {
    expect(
      targetFromTab("scene", "scene-1", {
        tree: { nodeType: "note", storage: "file" },
      }),
    ).toEqual({
      kind: "tree",
      id: "scene-1",
      nodeType: "note",
      storage: "file",
    });
  });

  it("distinguishes base, explicit, and auto Codex targets", () => {
    expect(
      targetFromTab("codex", "codex-1", { phaseIdOverride: "__base__" }),
    ).toEqual({
      kind: "codex",
      id: "codex-1",
      phase: { mode: "base" },
    });
    expect(
      targetFromTab("codex", "codex-1", { phaseIdOverride: "phase-1" }),
    ).toEqual({
      kind: "codex",
      id: "codex-1",
      phase: { mode: "explicit", phaseId: "phase-1" },
    });
    expect(targetFromTab("codex", "codex-1", { sceneId: "scene-1" })).toEqual({
      kind: "codex",
      id: "codex-1",
      phase: { mode: "auto", sceneId: "scene-1" },
    });
  });
});

describe("loadEditorDocument", () => {
  it("loads and parses a tree document without applying it to an editor", async () => {
    const loadSceneFull = vi.fn().mockResolvedValue({
      content: '{"type":"doc","content":[]}',
      unplacedBeatsDoc: "[]",
    });

    const loaded = await loadEditorDocument(
      {
        kind: "tree",
        id: "scene-1",
        nodeType: "scene",
        storage: "database",
      },
      { services: { tree: { loadSceneFull } } },
    );

    expect(loadSceneFull).toHaveBeenCalledOnce();
    expect(loaded).toEqual({
      binding: {
        kind: "tree",
        id: "scene-1",
        nodeType: "scene",
        storage: "database",
      },
      content: { type: "doc", content: [] },
      unplacedBeatsDoc: "[]",
    });
  });

  it("loads a snippet through the project-scoped service", async () => {
    const getSnippet = vi.fn().mockResolvedValue({
      content: "<p>snippet</p>",
      version: 4,
    });

    const loaded = await loadEditorDocument(
      { kind: "snippet", id: "snippet-1" },
      {
        services: {
          snippet: {
            getSnippet,
            getCurrentProjectId: () => "project-1",
          },
        },
      },
    );

    expect(getSnippet).toHaveBeenCalledWith("project-1", "snippet-1");
    expect(loaded.content).toBe("<p>snippet</p>");
    expect(loaded.binding).toEqual({
      kind: "snippet",
      id: "snippet-1",
      loadedVersion: 4,
    });
  });

  it("rejects a missing snippet instead of creating a writable empty binding", async () => {
    await expect(
      loadEditorDocument(
        { kind: "snippet", id: "missing-snippet" },
        {
          services: {
            snippet: {
              getSnippet: vi.fn().mockResolvedValue(undefined),
              getCurrentProjectId: () => "project-1",
            },
          },
        },
      ),
    ).rejects.toThrow("missing-snippet");
  });

  it("loads a Chronicle Event title and detail independently", async () => {
    const getEvent = vi.fn().mockResolvedValue({
      title: "Event",
      detail: '{"type":"doc","content":[]}',
      version: 7,
    });

    const loaded = await loadEditorDocument(
      { kind: "chronicle-event", id: "event-1" },
      {
        services: {
          chronicleEvent: {
            getEvent,
            getCurrentProjectId: () => "project-1",
          },
        },
      },
    );

    expect(getEvent).toHaveBeenCalledWith("project-1", "event-1");
    expect(loaded.title).toBe("Event");
    expect(loaded.content).toEqual({ type: "doc", content: [] });
    expect(loaded.binding).toEqual({
      kind: "chronicle-event",
      id: "event-1",
      loadedVersion: 7,
    });
  });

  it("rejects a missing Chronicle Event instead of binding version zero", async () => {
    await expect(
      loadEditorDocument(
        { kind: "chronicle-event", id: "missing-event" },
        {
          services: {
            chronicleEvent: {
              getEvent: vi.fn().mockResolvedValue(undefined),
              getCurrentProjectId: () => "project-1",
            },
          },
        },
      ),
    ).rejects.toThrow("missing-event");
  });

  it("loads Codex phases before returning a binding candidate", async () => {
    const getCodexEntry = vi.fn().mockResolvedValue({
      content: '{"type":"doc","content":[]}',
      summary: null,
      version: 5,
    });
    const loadPhasesForEntry = vi.fn().mockResolvedValue(undefined);
    const getPhasesForEntry = vi.fn().mockReturnValue([]);

    const loaded = await loadEditorDocument(
      { kind: "codex", id: "codex-1", phase: { mode: "base" } },
      {
        codex: {
          phase: { mode: "base" },
          sceneTimeIndex: null,
          resolutionMode: null,
        },
        services: {
          codex: {
            getCodexEntry,
            loadPhasesForEntry,
            getPhasesForEntry,
            getCurrentProjectId: () => "project-1",
          },
        },
      },
    );

    expect(getCodexEntry).toHaveBeenCalledWith("project-1", "codex-1");
    expect(loadPhasesForEntry).toHaveBeenCalledWith("codex-1");
    expect(loaded.binding).toEqual({
      kind: "codex",
      id: "codex-1",
      phaseId: null,
      loadedVersion: 5,
    });
    expect(loaded.content).toEqual({ type: "doc", content: [] });
  });

  it("rejects a missing Codex entry or explicitly requested Phase", async () => {
    const commonContext = {
      phase: { mode: "base" as const },
      sceneTimeIndex: null,
      resolutionMode: null,
    };
    await expect(
      loadEditorDocument(
        { kind: "codex", id: "missing-codex", phase: { mode: "base" } },
        {
          codex: commonContext,
          services: {
            codex: {
              getCodexEntry: vi.fn().mockResolvedValue(undefined),
              loadPhasesForEntry: vi.fn(),
              getPhasesForEntry: vi.fn().mockReturnValue([]),
              getCurrentProjectId: () => "project-1",
            },
          },
        },
      ),
    ).rejects.toThrow("missing-codex");

    await expect(
      loadEditorDocument(
        {
          kind: "codex",
          id: "codex-1",
          phase: { mode: "explicit", phaseId: "missing-phase" },
        },
        {
          codex: {
            phase: { mode: "explicit", phaseId: "missing-phase" },
            sceneTimeIndex: null,
            resolutionMode: null,
          },
          services: {
            codex: {
              getCodexEntry: vi.fn().mockResolvedValue({
                content: "{}",
                summary: null,
                version: 1,
              }),
              loadPhasesForEntry: vi.fn().mockResolvedValue(undefined),
              getPhasesForEntry: vi.fn().mockReturnValue([]),
              getCurrentProjectId: () => "project-1",
            },
          },
        },
      ),
    ).rejects.toThrow("missing-phase");
  });
});
