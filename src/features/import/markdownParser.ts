/**
 * Markdown import parser — single structured file or multi-file folder/ZIP.
 */

import { unzipSync, strFromU8 } from "fflate";
import {
  basename,
  titleFromFilename,
} from "@/features/external-mount/sourceUri";
import type { ImportedNode, ParsedChapter, ParsedScene } from "./importTypes";

export interface MarkdownParseResult {
  projectTitle: string;
  /** Flat chapters for single-file import (2-level). */
  chapters: ParsedChapter[];
  /** Recursive tree for multi-file import. */
  tree: ImportedNode[];
}

export interface MarkdownFileEntry {
  relPath: string;
  content: string;
}

/** Parse a single structured markdown file into chapters/scenes. */
export function parseMarkdownSingle(text: string): MarkdownParseResult {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  const headingLevels: number[] = [];
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) headingLevels.push(m[1]!.length);
  }

  const uniqueLevels = [...new Set(headingLevels)].sort((a, b) => a - b);
  void uniqueLevels;
  const minLevel = headingLevels.length > 0 ? Math.min(...headingLevels) : 1;
  const maxLevel = headingLevels.length > 0 ? Math.max(...headingLevels) : 1;

  const twoLevelOnly = maxLevel - minLevel <= 1;
  const chapterLevel = twoLevelOnly ? minLevel : minLevel + 1;
  const sceneLevel = twoLevelOnly ? minLevel + 1 : minLevel + 2;
  const skipTitle = !twoLevelOnly;

  let projectTitle = "Imported Project";
  let titleSkipped = false;

  const chapters: ParsedChapter[] = [];
  let currentChapter: ParsedChapter | null = null;
  let currentScene: ParsedScene | null = null;
  let bodyLines: string[] = [];

  function flushScene(): void {
    if (!currentScene) return;
    currentScene.body = "";
    currentScene.bodyMarkdown = bodyLines.join("\n").replace(/^\n+|\n+$/g, "");
    bodyLines = [];
  }

  /**
   * H1+H2+H3 mixed files (skipTitle=true) where chapter-level (H2) has direct
   * content before any scene-level (H3) heading used to silently drop that
   * content. Synthesise a scene named after the chapter to hold it — this also
   * captures the entire chapter body when no H3 ever appears.
   *
   * Returns false when there is no current chapter, signalling that the caller
   * should drop the line (preamble text between the title and the first chapter
   * heading has no natural home and is not preserved, matching prior behaviour).
   */
  function ensureScene(): boolean {
    if (currentScene) return true;
    if (!currentChapter) return false;
    currentScene = {
      id: crypto.randomUUID(),
      title: currentChapter.title,
      body: "",
    };
    currentChapter.scenes.push(currentScene);
    return true;
  }

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const title = headingMatch[2]!.trim();

      if (level === minLevel && skipTitle && !titleSkipped) {
        projectTitle = title;
        titleSkipped = true;
        continue;
      }

      if (level === chapterLevel) {
        flushScene();
        currentScene = null;
        currentChapter = {
          id: crypto.randomUUID(),
          title,
          scenes: [],
        };
        chapters.push(currentChapter);
        continue;
      }

      if (level === sceneLevel) {
        flushScene();
        if (!currentChapter) {
          currentChapter = {
            id: crypto.randomUUID(),
            title: "Untitled",
            scenes: [],
          };
          chapters.push(currentChapter);
        }
        currentScene = {
          id: crypto.randomUUID(),
          title,
          body: "",
        };
        currentChapter.scenes.push(currentScene);
        continue;
      }

      // Heading at a non-chapter/scene level (e.g. H4 under chapter=H2/scene=H3
      // or H1 inside a 2-level body) — preserve verbatim in body markdown so
      // the source structure round-trips intact.
      if (ensureScene()) bodyLines.push(line);
      continue;
    }

    // Skip leading blank lines until the first body line of the scene to keep
    // bodyMarkdown clean; once any body line exists, preserve blanks.
    if (!currentScene && line.trim() === "") continue;
    if (ensureScene()) bodyLines.push(line);
  }

  flushScene();

  return {
    projectTitle,
    chapters,
    tree: [],
  };
}

/** Parse a ZIP containing .md files into a recursive folder tree. */
export function parseMarkdownZip(zipBytes: Uint8Array): MarkdownParseResult {
  const files = unzipSync(zipBytes);
  const entries: MarkdownFileEntry[] = [];

  for (const [path, data] of Object.entries(files)) {
    if (!path.endsWith(".md") && !path.endsWith(".markdown")) continue;
    if (path.includes("__MACOSX")) continue;
    entries.push({
      relPath: path.replace(/\\/g, "/"),
      content: strFromU8(data),
    });
  }

  return parseMarkdownMulti(entries);
}

/** Parse multiple markdown files (folder import) into a recursive tree. */
export function parseMarkdownMulti(
  files: MarkdownFileEntry[],
): MarkdownParseResult {
  const sorted = [...files].sort((a, b) =>
    a.relPath.localeCompare(b.relPath, undefined, { numeric: true }),
  );

  const projectTitle =
    extractProjectTitle(sorted) ??
    (sorted[0]
      ? titleFromFilename(basename(sorted[0].relPath))
      : "Imported Project");

  const tree = buildTreeFromFiles(sorted);

  return {
    projectTitle,
    chapters: [],
    tree,
  };
}

function extractProjectTitle(files: MarkdownFileEntry[]): string | null {
  for (const file of files) {
    const m = /^#\s+(.+?)\s*$/m.exec(file.content.replace(/\r\n/g, "\n"));
    if (m) return m[1]!.trim();
  }
  return null;
}

function buildTreeFromFiles(files: MarkdownFileEntry[]): ImportedNode[] {
  interface FolderBuilder {
    kind: "folder";
    id: string;
    title: string;
    children: Map<string, FolderBuilder | ImportedNode>;
    pathKey: string;
  }

  const root: FolderBuilder = {
    kind: "folder",
    id: crypto.randomUUID(),
    title: "__root__",
    children: new Map(),
    pathKey: "",
  };

  for (const file of files) {
    const normalized = file.relPath.replace(/\\/g, "/");
    const parts = normalized.split("/");
    const filename = parts.pop()!;
    if (!filename) continue;

    let current = root;
    let pathSoFar = "";

    for (const part of parts) {
      pathSoFar = pathSoFar ? `${pathSoFar}/${part}` : part;
      let child = current.children.get(part);
      if (!child || child.kind !== "folder") {
        const folder: FolderBuilder = {
          kind: "folder",
          id: crypto.randomUUID(),
          title: part,
          children: new Map(),
          pathKey: pathSoFar,
        };
        current.children.set(part, folder);
        child = folder;
      }
      current = child as FolderBuilder;
    }

    const sceneTitle = extractSceneTitle(file.content, filename);
    const bodyMarkdown = extractSceneBody(file.content);

    const scene: ImportedNode = {
      kind: "scene",
      id: crypto.randomUUID(),
      title: sceneTitle,
      body: "",
      bodyMarkdown,
    };

    const sceneKey = `__scene__:${filename}`;
    current.children.set(sceneKey, scene);
  }

  return flattenFolderBuilder(root);
}

function flattenFolderBuilder(builder: {
  kind: "folder";
  id: string;
  title: string;
  children: Map<string, unknown>;
  pathKey: string;
}): ImportedNode[] {
  const nodes: ImportedNode[] = [];

  const childEntries = [...builder.children.entries()].sort(([a], [b]) => {
    const aIsScene = a.startsWith("__scene__:");
    const bIsScene = b.startsWith("__scene__:");
    if (aIsScene !== bIsScene) return aIsScene ? 1 : -1;
    return a.localeCompare(b, undefined, { numeric: true });
  });

  for (const [, child] of childEntries) {
    if (
      child &&
      typeof child === "object" &&
      "kind" in child &&
      child.kind === "folder"
    ) {
      const folder = child as {
        kind: "folder";
        id: string;
        title: string;
        children: Map<string, unknown>;
        pathKey: string;
      };
      nodes.push({
        kind: "folder",
        id: folder.id,
        title: folder.title,
        children: flattenFolderBuilder(folder),
      });
    } else if (
      child &&
      typeof child === "object" &&
      "kind" in child &&
      child.kind === "scene"
    ) {
      nodes.push(child as ImportedNode);
    }
  }

  return nodes;
}

function extractSceneTitle(content: string, filename: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const m = /^#\s+(.+?)\s*$/m.exec(normalized);
  if (m) return m[1]!.trim();
  return titleFromFilename(filename);
}

function extractSceneBody(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const bodyLines: string[] = [];
  let skippedFirstHeading = false;

  for (const line of lines) {
    if (!skippedFirstHeading && /^#\s+/.test(line)) {
      skippedFirstHeading = true;
      continue;
    }
    bodyLines.push(line);
  }

  return bodyLines.join("\n").trim();
}

/** Count scenes in an ImportedNode tree. */
export function countScenesInTree(nodes: ImportedNode[]): number {
  let count = 0;
  for (const n of nodes) {
    if (n.kind === "scene") count++;
    else count += countScenesInTree(n.children);
  }
  return count;
}

/** Count folders in an ImportedNode tree. */
export function countFoldersInTree(nodes: ImportedNode[]): number {
  let count = 0;
  for (const n of nodes) {
    if (n.kind === "folder") {
      count++;
      count += countFoldersInTree(n.children);
    }
  }
  return count;
}
