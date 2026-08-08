import { describe, expect, it } from "vitest";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { generateExport } from "./exportEngine";
import { DEFAULT_EXPORT_SETTINGS, type ExportSettings } from "./types";

function makeScene(id = "scene-1", sortOrder = "a0"): TreeNodeData {
  return {
    id,
    projectId: "project-1",
    parentId: null,
    nodeType: "scene",
    title: "Scene",
    synopsis: null,
    intent: null,
    sortOrder,
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

function generatedDocument(...paragraphs: string[]): string {
  return JSON.stringify({
    type: "doc",
    content: [
      {
        type: "generatedProseBlock",
        attrs: { beatId: "beat-1", modified: false },
        content: paragraphs.map((text) => ({
          type: "paragraph",
          content: [{ type: "text", text }],
        })),
      },
    ],
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

function exportGeneratedParagraphs(
  paragraphs: string[],
  exportSettings: ExportSettings,
): string {
  const scene = makeScene();
  return generateExport({
    nodes: [scene],
    contentMap: { [scene.id]: generatedDocument(...paragraphs) },
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
  it("applies the policy inside generated prose blocks for full-width output", () => {
    const result = exportGeneratedParagraphs(
      ["生成地の文", "「会話」", "『内声』", "　「意図的な字下げ」"],
      settings({
        format: "plaintext",
        paragraphIndent: "fullwidth-space",
      }),
    );

    expect(result).toBe(
      "　生成地の文\n\n「会話」\n\n『内声』\n\n　「意図的な字下げ」\n",
    );
  });

  it("applies the policy inside generated prose blocks for CSS output", () => {
    const result = exportGeneratedParagraphs(
      ["生成地の文", "「会話」", "『内声』", "　「意図的な字下げ」"],
      settings({ format: "html", paragraphIndent: "css" }),
    );

    expect(result).toContain('<p class="paragraph-indent">生成地の文</p>');
    expect(result).toContain("<p>「会話」</p>");
    expect(result).toContain("<p>『内声』</p>");
    expect(result).toContain("<p>　「意図的な字下げ」</p>");
  });

  it("does not enumerate content for unselected scenes", () => {
    const selected = makeScene("scene-1", "a0");
    const unselected = makeScene("scene-2", "a1");
    const contentMap = new Proxy<Record<string, string>>(
      {
        [selected.id]: document("地の文"),
        [unselected.id]: document("「未選択の会話」"),
      },
      {
        ownKeys() {
          throw new Error("contentMap must not be enumerated");
        },
      },
    );

    expect(
      generateExport({
        nodes: [selected, unselected],
        contentMap,
        checkedIds: new Set([selected.id]),
        settings: settings({
          format: "plaintext",
          paragraphIndent: "fullwidth-space",
        }),
      }),
    ).toBe("　地の文\n");
  });
});
