import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import {
  parseMarkdownSingle,
  parseMarkdownZip,
  parseMarkdownMulti,
  countScenesInTree,
  countFoldersInTree,
} from "./markdownParser";
import { generateExport } from "@/features/export/exportEngine";
import { DEFAULT_EXPORT_SETTINGS } from "@/features/export/types";
import type { TreeNodeData } from "@/features/tree/treeStore";

function makeZip(files: Record<string, string>): Uint8Array {
  const input: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    input[path] = strToU8(content);
  }
  return zipSync(input);
}

describe("parseMarkdownSingle", () => {
  it("parses canonical # title / ## chapter / ### scene", () => {
    const md = `# My Novel
by Author

## Act 1

### Opening

Hello **world**.

### Closing

The end.
`;
    const result = parseMarkdownSingle(md);
    expect(result.projectTitle).toBe("My Novel");
    expect(result.chapters).toHaveLength(1);
    expect(result.chapters[0]?.scenes).toHaveLength(2);
    expect(result.chapters[0]?.scenes[0]?.bodyMarkdown).toContain("Hello");
  });

  it("parses ## chapter / ### scene when min level is 2", () => {
    const md = `## Chapter One

### Scene A

Body A

## Chapter Two

### Scene B

Body B
`;
    const result = parseMarkdownSingle(md);
    expect(result.chapters).toHaveLength(2);
    expect(result.chapters[0]?.title).toBe("Chapter One");
    expect(result.chapters[0]?.scenes[0]?.title).toBe("Scene A");
  });

  it("parses # chapter / ## scene simplified form", () => {
    const md = `# Chapter

## Scene

Content here.
`;
    const result = parseMarkdownSingle(md);
    expect(result.chapters).toHaveLength(1);
    expect(result.chapters[0]?.scenes[0]?.bodyMarkdown).toBe("Content here.");
  });

  it("rescues H2-direct content as a synthetic scene named after the chapter", () => {
    // H1+H2+H3 mixed → chapterLevel=2, sceneLevel=3, skipTitle=true.
    // Content under ## that appears before any ### used to be silently dropped.
    const md = `# Title

## 概要

hohohohoho
yoyouy
uiuiui

Body paragraph.

## 詳細

### サブセクション

Detail body.
`;
    const result = parseMarkdownSingle(md);
    expect(result.projectTitle).toBe("Title");
    expect(result.chapters.map((c) => c.title)).toEqual(["概要", "詳細"]);
    // 概要 chapter has no ### but its body must survive as a synthetic scene.
    const gaiyou = result.chapters[0]!;
    expect(gaiyou.scenes).toHaveLength(1);
    expect(gaiyou.scenes[0]?.title).toBe("概要");
    expect(gaiyou.scenes[0]?.bodyMarkdown).toContain("hohohohoho");
    expect(gaiyou.scenes[0]?.bodyMarkdown).toContain("Body paragraph.");
    // 詳細 chapter has a ### sub — that subsection owns its body.
    const shousai = result.chapters[1]!;
    expect(shousai.scenes.map((s) => s.title)).toEqual(["サブセクション"]);
    expect(shousai.scenes[0]?.bodyMarkdown).toContain("Detail body.");
  });

  it("rescues a chapter with no scene-level heading at all (H1+H2+H3 mixed)", () => {
    // headingLevels = [1, 2, 3] → chapterLevel=2, sceneLevel=3, skipTitle=true
    // 参考資料 has no ### so its content would have been dropped.
    const md = `# Title

## 参考資料

- one
- two

## 別章

### サブ

Sub body.
`;
    const result = parseMarkdownSingle(md);
    const chap = result.chapters.find((c) => c.title === "参考資料")!;
    expect(chap).toBeDefined();
    expect(chap.scenes).toHaveLength(1);
    expect(chap.scenes[0]?.bodyMarkdown).toContain("- one");
  });
});

describe("parseMarkdownMulti", () => {
  it("builds recursive folder tree from paths", () => {
    const result = parseMarkdownMulti([
      { relPath: "act1/scene1.md", content: "# Scene 1\n\nBody 1" },
      { relPath: "act1/scene2.md", content: "# Scene 2\n\nBody 2" },
      { relPath: "act2/scene3.md", content: "# Scene 3\n\nBody 3" },
    ]);

    expect(countFoldersInTree(result.tree)).toBe(2);
    expect(countScenesInTree(result.tree)).toBe(3);
    const act1 = result.tree.find(
      (n) => n.kind === "folder" && n.title === "act1",
    );
    expect(act1?.kind).toBe("folder");
    if (act1?.kind === "folder") {
      expect(act1.children).toHaveLength(2);
    }
  });

  it("parses markdown zip", () => {
    const zip = makeZip({
      "chapter1/ep1.md": "# Episode 1\n\nText",
      "chapter1/ep2.md": "# Episode 2\n\nMore",
    });
    const result = parseMarkdownZip(zip);
    expect(countScenesInTree(result.tree)).toBe(2);
  });
});

describe("parseMarkdownSingle ↔ generateExport round-trip (synthetic-echo)", () => {
  // `## chapter\n\nbody` のように chapter 直下に body しかない入力は、parser が
  // 本文救済のため chapter と同名 synthetic scene を作る (markdownParser.ts:71)。
  // 既定 export (folderHeading=true, sceneTitle="heading") でそのまま流すと
  // `## chapter\n### chapter\nbody` と見出しが重複していた。重複は exportEngine
  // 側で抑制する (bug #2 fix)。
  function asTreeNode(
    id: string,
    nodeType: "folder" | "scene",
    title: string,
    parentId: string | null,
    sortOrder = "a0",
  ): TreeNodeData {
    return {
      id,
      projectId: "p1",
      parentId,
      nodeType,
      title,
      synopsis: null,
      sortOrder,
      status: null,
      storyTimeOrder: null,
      storyTimeLabel: null,
      povCharacterId: null,
      locationId: null,
      charCount: 0,
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
    };
  }

  it("`## 概要\\n\\nbody` → export では `### 概要` の echo が出ない", () => {
    const md = "## 概要\n\nbody\n";
    const parsed = parseMarkdownSingle(md);
    const chapter = parsed.chapters[0]!;
    const synth = chapter.scenes[0]!;
    expect(synth.title).toBe(chapter.title); // synthetic-echo の前提を確認

    const folder = asTreeNode(chapter.id, "folder", chapter.title, null);
    const scene = asTreeNode(synth.id, "scene", synth.title, chapter.id);

    const out = generateExport({
      nodes: [folder, scene],
      contentMap: {
        [scene.id]: JSON.stringify({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: synth.bodyMarkdown ?? "" }],
            },
          ],
        }),
      },
      checkedIds: new Set([scene.id]),
      settings: {
        ...DEFAULT_EXPORT_SETTINGS,
        format: "markdown",
        folderHeading: true,
        sceneTitle: "heading",
      },
    });

    expect(out).toContain("# 概要"); // chapter heading は出る (depth 0)
    expect(out).not.toContain("## 概要"); // synthetic echo (folderDepth 1) は抑制
    expect(out).toContain("body");
  });
});
