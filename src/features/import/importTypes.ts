/** Import source format selected in the unified import dialog. */
export type ImportSource = "novelcrafter" | "kakuyomu" | "markdown";

/** Markdown import input shape within the Markdown flow. */
export type MarkdownImportMode = "single" | "multi";

/** A scene parsed from an import source. */
export interface ParsedScene {
  /** New Grimodex UUID */
  id: string;
  title: string;
  /**
   * Plain text body (Novelcrafter default). Converted via fieldValueToProseMirror.
   */
  body: string;
  /** GFM markdown — converted via markdownToPmJson on import. */
  bodyMarkdown?: string;
  /** Pre-built ProseMirror JSON string — stored as-is on import. */
  bodyProseMirror?: string;
}

/** A chapter parsed from novel.md (`## Heading`). */
export interface ParsedChapter {
  /** New Grimodex UUID */
  id: string;
  title: string;
  scenes: ParsedScene[];
}

/** Recursive tree node for nested folder/scene import (Kakuyomu, multi-MD). */
export type ImportedNode =
  | {
      kind: "folder";
      id: string;
      title: string;
      children: ImportedNode[];
    }
  | {
      kind: "scene";
      id: string;
      title: string;
      body?: string;
      bodyMarkdown?: string;
      bodyProseMirror?: string;
    };

/** Convert flat ParsedChapter[] to ImportedNode[] (2-level). */
export function chaptersToImportedNodes(
  chapters: ParsedChapter[],
): ImportedNode[] {
  return chapters.map((chapter) => ({
    kind: "folder" as const,
    id: chapter.id,
    title: chapter.title,
    children: chapter.scenes.map((scene) => ({
      kind: "scene" as const,
      id: scene.id,
      title: scene.title,
      body: scene.body,
      bodyMarkdown: scene.bodyMarkdown,
      bodyProseMirror: scene.bodyProseMirror,
    })),
  }));
}
