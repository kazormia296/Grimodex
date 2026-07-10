import { describe, it, expect } from "vitest";
import { strToU8, zipSync, unzipSync, strFromU8 } from "fflate";
import { buildScenePathIndex } from "./scenePathIndex";
import { serializeSceneContent } from "./sceneSerializer";
import { serializeCodexEntries } from "./codexSerializer";
import { buildManifest } from "./manifest";
import { DEFAULT_ZIP_EXPORT_SETTINGS } from "./types";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { CodexEntry } from "@/features/codex/api";

describe("buildArchive (fixture assembly)", () => {
  it("assembles expected directory structure from in-memory fixture", () => {
    const nodes: TreeNodeData[] = [
      {
        id: "folder-1",
        projectId: "p1",
        parentId: null,
        nodeType: "folder",
        title: "Chapter 1",
        synopsis: null,

        intent: null,
        sortOrder: "a0",
        status: null,
        storyTimeOrder: null,
        storyTimeLabel: null,
        povCharacterId: null,
        locationId: null,
        charCount: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
      {
        id: "scene-1",
        projectId: "p1",
        parentId: "folder-1",
        nodeType: "scene",
        title: "Opening",
        synopsis: null,

        intent: null,
        sortOrder: "a0",
        status: null,
        storyTimeOrder: null,
        storyTimeLabel: null,
        povCharacterId: null,
        locationId: null,
        charCount: 10,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ];

    const contentMap: Record<string, string> = {
      "scene-1":
        '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Hello zip"}]}]}',
    };

    const codex: CodexEntry[] = [
      {
        id: "codex-1",
        projectId: "p1",
        parentId: null,
        type: "character",
        name: "Alice",
        aliases: null,
        excludedAliases: null,
        readings: null,
        summary: "Hero",
        content:
          '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Hero"}]}]}',
        icon: null,
        tagsCache: null,
        contextMode: "mentioned",
        childrenBudget: "compact",
        sourceChatMessageId: null,
        notes: null,
        version: 0,
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-01T00:00:00Z",
      },
    ];

    const { scenePathById } = buildScenePathIndex(nodes);
    const zipInput: Record<string, Uint8Array> = {};

    for (const info of scenePathById.values()) {
      const { markdown } = serializeSceneContent(
        contentMap[info.sceneId],
        DEFAULT_ZIP_EXPORT_SETTINGS,
      );
      zipInput[info.relativePath] = strToU8(markdown);
    }

    for (const file of serializeCodexEntries(
      codex,
      DEFAULT_ZIP_EXPORT_SETTINGS,
    )) {
      zipInput[file.path] = strToU8(file.content);
    }

    const manifest = buildManifest(
      { id: "p1", title: "Test Novel", createdAt: "2024-01-01T00:00:00Z" },
      DEFAULT_ZIP_EXPORT_SETTINGS,
      "0.4.2",
    );
    zipInput["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));

    const zipBytes = zipSync(zipInput);
    const extracted: Record<string, string> = {};
    for (const [path, bytes] of Object.entries(unzipSync(zipBytes))) {
      extracted[path] = strFromU8(bytes);
    }

    const paths = Object.keys(extracted);
    expect(paths).toContain("manifest.json");
    expect(
      paths.some((p) => p.startsWith("chapters/") && p.endsWith(".md")),
    ).toBe(true);
    expect(paths.some((p) => p.startsWith("codex/character/"))).toBe(true);
    expect(Object.values(extracted).some((c) => c.includes("Hello zip"))).toBe(
      true,
    );
  });
});
