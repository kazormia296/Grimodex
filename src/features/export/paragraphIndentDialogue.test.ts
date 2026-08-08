import { describe, expect, it } from "vitest";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { generateExport } from "./exportEngine";
import {
  DEFAULT_EXPORT_SETTINGS,
  type ExportSettings,
} from "./types";

function makeScene(): TreeNodeData {
  return {
    id: "scene-1",
    projectId: "project-1",
    parentId: null,
    nodeType: "scene",
    title: "Scene",
    synopsis: null,
    intent: null,
    sortOrder: "a0",
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    createdAt: "2026-01-01T00:00:00Z",
    charCount: 0,
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function document(...paragraphs: string[]): string {
  return JSON.stringify({
    type: "doc",
    content: paragraphs.map((text) => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    })),
  });
}

function settings(overrides: Partial<ExportSettings>): ExportSettings {
  return { ...DEFAULT_EXPORT_SETTINGS, ...overrides };
}

function exportParagraphs(
  paragraphs: string[],
  exportSettings: ExportSettings,
): string {
  const scene = makeScene();
  return generateExport({
    nodes: [scene],
    contentMap: { [scene.id]: document(...paragraphs) },
    checkedIds: new Set([scene.id]),
    settings: exportSettings,
  });
}

describe("dialogue paragraph indentation", () => {
  it("omits automatic full-width spaces before Japanese dialogue", () => {
    const result = exportParagraphs(
      ["地の文", "「会話文」", "『内声』"],
      settings({
        format: "plaintext",
        paragraphIndent: "fullwidth-space",
      }),
    );

    expect(result).toBe("　地の文\n\n「会話文」\n\n『内声』\n");
  });

  it("preserves author-entered whitespace before dialogue", () => {
    const result = exportParagraphs(
      ["　「意図的に字下げした会話」"],
      settings({
        format: "plaintext",
        paragraphIndent: "fullwidth-space",
      }),
    );

    expect(result).toBe("　「意図的に字下げした会話」\n");
  });

  it("omits the CSS indent class from dialogue paragraphs", () => {
    const result = exportParagraphs(
      ["地の文", "「会話文」", "『内声』"],
      settings({ format: "html", paragraphIndent: "css" }),
    );

    expect(result).toContain('<p class="paragraph-indent">地の文</p>');
    expect(result).toContain("<p>「会話文」</p>");
    expect(result).toContain("<p>『内声』</p>");
    expect(result).not.toContain("grimodex-dialogue-indent-exempt");
  });

  it("omits inserted full-width spaces in HTML output", () => {
    const result = exportParagraphs(
      ["地の文", "「会話文」"],
      settings({
        format: "html",
        paragraphIndent: "fullwidth-space",
      }),
    );

    expect(result).toContain("<p>　地の文</p>");
    expect(result).toContain("<p>「会話文」</p>");
  });
});
