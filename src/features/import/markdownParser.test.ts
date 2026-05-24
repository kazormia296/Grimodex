import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import {
  parseMarkdownSingle,
  parseMarkdownZip,
  parseMarkdownMulti,
  countScenesInTree,
  countFoldersInTree,
} from "./markdownParser";

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
