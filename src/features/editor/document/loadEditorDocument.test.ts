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
  });

  it("loads a Chronicle Event title and detail independently", async () => {
    const getEvent = vi.fn().mockResolvedValue({
      title: "Event",
      detail: '{"type":"doc","content":[]}',
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
  });

  it("loads Codex phases before returning a binding candidate", async () => {
    const getCodexEntry = vi.fn().mockResolvedValue({
      content: '{"type":"doc","content":[]}',
      summary: null,
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
    });
    expect(loaded.content).toEqual({ type: "doc", content: [] });
  });
});
