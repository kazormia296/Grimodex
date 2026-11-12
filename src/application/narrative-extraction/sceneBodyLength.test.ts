// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { markdownToPmJson } from "@/features/external-mount/markdownBridge";
import { buildNarrativeCorpusSnapshot } from "@/features/narrative-extraction/source/buildSnapshot";
import type { ProjectNarrativeSourceRow } from "@/features/narrative-extraction/source/types";
import {
  DEFAULT_MAX_WINDOW_OWNED_CHARS,
  measureSceneCanonicalBodyLength,
  SceneBodyLengthError,
} from "./sceneBodyLength";

function row(
  overrides: Partial<ProjectNarrativeSourceRow>,
): ProjectNarrativeSourceRow {
  return {
    nodeId: "scene-a",
    parentId: "folder-a",
    title: "Scene A",
    content: "{}",
    sortOrder: "a0",
    storyTimeOrder: null,
    orderIndex: 0,
    version: 1,
    updatedAt: "2026-08-09T00:00:00.000Z",
    sourceUri: null,
    ...overrides,
  };
}

const databaseContent = JSON.stringify({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "  一行目。  " }] },
    { type: "paragraph", content: [{ type: "text", text: "二行目　です。" }] },
    { type: "paragraph" },
    { type: "paragraph", content: [{ type: "text", text: "三行目。" }] },
  ],
});

async function sealedLength(
  content: string,
  sourceUri: string | null,
): Promise<number> {
  const built = await buildNarrativeCorpusSnapshot({
    snapshotId: "snapshot-a",
    language: "ja",
    origin: { kind: "grimodex-project", projectId: "project-a" },
    documents: [
      {
        sourceKey: "project:scene:scene-a",
        parentSourceKey: null,
        title: "Scene A",
        orderIndex: 0,
        proseMirrorJson: content,
        origin: {
          kind: "project-node",
          projectId: "project-a",
          nodeId: "scene-a",
          sourceVersion: 1,
          sourceUpdatedAt: "2026-08-09T00:00:00.000Z",
          sourceUri,
        },
      },
    ],
    omissions: [],
    createdAt: "2026-08-10T00:00:00.000Z",
  });
  if (!built.ok) throw new Error("fixture did not seal");
  return built.snapshot.documents[0]!.canonical.text.length;
}

describe("measureSceneCanonicalBodyLength", () => {
  it("re-exports the window planner's owned-text budget", () => {
    expect(DEFAULT_MAX_WINDOW_OWNED_CHARS).toBe(6000);
  });

  it("reads exactly one Scene through the snapshot's row loader", async () => {
    const loadSourceRows = vi.fn(async () => [
      row({ content: databaseContent }),
    ]);
    await measureSceneCanonicalBodyLength("project-a", "scene-a", {
      loadSourceRows,
    });
    expect(loadSourceRows).toHaveBeenCalledWith("project-a", ["scene-a"]);
  });

  it("matches the sealed snapshot's length for a database Scene", async () => {
    const result = await measureSceneCanonicalBodyLength(
      "project-a",
      "scene-a",
      { loadSourceRows: async () => [row({ content: databaseContent })] },
    );
    expect(result.canonicalLength).toBe(
      await sealedLength(databaseContent, null),
    );
    expect(result.canonicalLength).toBeGreaterThan(0);
  });

  it("matches the sealed snapshot's length for an external-mount (file-backed) Scene", async () => {
    const content = JSON.stringify(
      markdownToPmJson("# 見出し\n\n本文の一段落目。\n\n二段落目。\n"),
    );
    const sourceUri = "external-root://root-1/chapter/first.md";
    const result = await measureSceneCanonicalBodyLength(
      "project-a",
      "scene-a",
      { loadSourceRows: async () => [row({ content, sourceUri })] },
    );
    expect(result.canonicalLength).toBe(await sealedLength(content, sourceUri));
  });

  it("reports 0 for an empty body", async () => {
    const empty = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
    const result = await measureSceneCanonicalBodyLength(
      "project-a",
      "scene-a",
      { loadSourceRows: async () => [row({ content: empty })] },
    );
    expect(result.canonicalLength).toBe(0);
  });

  it("throws a typed error when the row is not available", async () => {
    await expect(
      measureSceneCanonicalBodyLength("project-a", "scene-a", {
        loadSourceRows: async () => [],
      }),
    ).rejects.toMatchObject({
      name: "SceneBodyLengthError",
      code: "SCENE_BODY_ROW_UNAVAILABLE",
    });
  });

  it("throws a typed error when the body cannot be normalized", async () => {
    const promise = measureSceneCanonicalBodyLength("project-a", "scene-a", {
      loadSourceRows: async () => [row({ content: "not json" })],
    });
    await expect(promise).rejects.toBeInstanceOf(SceneBodyLengthError);
    await expect(promise).rejects.toMatchObject({
      code: "SCENE_BODY_UNREADABLE",
    });
  });
});
