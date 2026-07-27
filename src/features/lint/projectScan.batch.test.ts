import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/features/tree/api", () => ({
  listNodes: vi.fn(),
  loadSceneContents: vi.fn(),
}));
vi.mock("@/features/codex/api", () => ({
  listCodexMatchTargets: vi.fn(),
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: vi.fn(() => "project-1"),
}));
vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@/lib/tauri";
import { listNodes, loadSceneContents } from "@/features/tree/api";
import { scanProject } from "./projectScan";
import type { LintResponse } from "./types";

const mockInvoke = vi.mocked(invoke);
const mockListNodes = vi.mocked(listNodes);
const mockLoadSceneContents = vi.mocked(loadSceneContents);

function storedDoc(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  });
}

function scene(id: string, title: string, sortOrder: string) {
  return {
    id,
    title,
    sortOrder,
    nodeType: "scene",
  };
}

const emptyLintResponse: LintResponse = {
  diagnostics: [],
  warnings: [],
  computed_at: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockResolvedValue(emptyLintResponse);
});

describe("scanProject batched scene loading", () => {
  it("loads every scene once, preserves order, and skips missing rows", async () => {
    mockListNodes.mockResolvedValue([
      scene("scene-b", "Second", "b"),
      scene("scene-a", "First", "a"),
      scene("scene-c", "Missing", "c"),
    ] as Awaited<ReturnType<typeof listNodes>>);
    mockLoadSceneContents.mockResolvedValue(
      new Map([
        ["scene-a", storedDoc("alpha")],
        ["scene-b", storedDoc("bravo")],
      ]),
    );

    const result = await scanProject({
      projectId: "project-1",
      language: "ja",
      baseConfig: {},
      includeCodex: false,
      signal: new AbortController().signal,
    });

    expect(mockLoadSceneContents).toHaveBeenCalledOnce();
    expect(mockLoadSceneContents).toHaveBeenCalledWith([
      "scene-a",
      "scene-b",
      "scene-c",
    ]);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      finished: true,
      fatalError: null,
      scenes: [
        { sceneId: "scene-a", sceneText: "alpha" },
        { sceneId: "scene-b", sceneText: "bravo" },
      ],
    });
  });

  it("keeps the previous best-effort completion contract on batch failure", async () => {
    mockListNodes.mockResolvedValue([
      scene("scene-a", "First", "a"),
      scene("scene-b", "Second", "b"),
    ] as Awaited<ReturnType<typeof listNodes>>);
    mockLoadSceneContents.mockRejectedValue(new Error("database unavailable"));
    const progress = vi.fn();

    const result = await scanProject({
      projectId: "project-1",
      language: "ja",
      baseConfig: {},
      includeCodex: false,
      signal: new AbortController().signal,
      onProgress: progress,
    });

    expect(mockLoadSceneContents).toHaveBeenCalledOnce();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(result).toEqual({
      scenes: [],
      finished: true,
      fatalError: null,
    });
    expect(progress).toHaveBeenLastCalledWith({
      completed: 2,
      total: 2,
      currentSceneId: null,
      currentSceneTitle: null,
    });
  });
});
