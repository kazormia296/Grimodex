import { describe, it, expect } from "vitest";
import { serializeSnippets } from "./snippetSerializer";
import { DEFAULT_ZIP_EXPORT_SETTINGS } from "./types";
import type { Snippet } from "@/features/snippets/api";

function fakeSnippet(overrides: Partial<Snippet> = {}): Snippet {
  return {
    id: "sn-1",
    projectId: "p1",
    title: "Test Snippet",
    content: "",
    tagsCache: null,
    sceneId: null,
    sourceChatMessageId: null,
    usageCount: 0,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("snippetSerializer", () => {
  it("exports plain-text snippet bodies", () => {
    const [file] = serializeSnippets(
      [fakeSnippet({ content: "プレーンテキストのスニペット" })],
      DEFAULT_ZIP_EXPORT_SETTINGS,
    );
    expect(file.content).toContain("プレーンテキストのスニペット");
  });

  it("exports HTML snippet bodies as plain text", () => {
    const [file] = serializeSnippets(
      [fakeSnippet({ content: "<p>HTML <strong>body</strong></p>" })],
      DEFAULT_ZIP_EXPORT_SETTINGS,
    );
    expect(file.content).toContain("HTML body");
    expect(file.content).not.toContain("<p>");
  });

  it("exports ProseMirror JSON snippet bodies as markdown", () => {
    const [file] = serializeSnippets(
      [
        fakeSnippet({
          content:
            '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"PM snippet"}]}]}',
        }),
      ],
      DEFAULT_ZIP_EXPORT_SETTINGS,
    );
    expect(file.content).toContain("PM snippet");
  });
});
