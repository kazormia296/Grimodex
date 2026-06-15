/**
 * Kakuyomu official backup ZIP parser.
 *
 * Expects about.txt + episode_NNNN.txt files (UTF-8, CRLF).
 */

import { unzipSync, strFromU8 } from "fflate";
import i18next from "@/lib/i18n";
import { zipBombGuard } from "./zipGuard";
import type { ImportedNode } from "./importTypes";
import {
  extractEpisodeBody,
  kakuyomuBodyToProseMirror,
  parseBulletList,
  parseKakuyomuSections,
} from "./kakuyomuMarkup";

export interface KakuyomuMetadata {
  title?: string;
  author?: string;
  genre?: string;
  catchphrase?: string;
  outline?: string;
  tags?: string[];
  selfRating?: string[];
  serialStatus?: string;
}

export interface KakuyomuParseResult {
  projectTitle: string;
  tree: ImportedNode[];
  metadata: KakuyomuMetadata;
  flatStructure: boolean;
  warnings: string[];
}

interface TocChapter {
  id: string;
  title: string;
  depth: number;
  children: TocNode[];
  /** True when created from a `§` line in the TOC. */
  explicitSection: boolean;
}

type TocNode = TocChapter | TocEpisodeSlot;

interface TocEpisodeSlot {
  kind: "episode";
  episodeNum: number;
  title: string;
}

interface ParsedEpisode {
  num: number;
  title: string;
  body: string;
  bodyProseMirror: string;
}

const KNOWN_ABOUT_KEYS = new Set([
  "タイトル",
  "作者名",
  "連載状態",
  "ジャンル",
  "キャッチコピー",
  "紹介文（1行）",
  "セルフレイティング",
  "タグ",
  "イメージカラー",
  "作成日時",
  "更新日時",
  "公開日時",
  "文字数",
  "目次",
]);

export function parseKakuyomuZip(zipBytes: Uint8Array): KakuyomuParseResult {
  // zip-bomb / 過大 zip による renderer の OOM/ハングを防ぐ (PIO-3)。
  const files = unzipSync(zipBytes, { filter: zipBombGuard() });
  const warnings: string[] = [];

  const aboutBytes = files["about.txt"];
  if (!aboutBytes) {
    throw new Error("Missing about.txt in Kakuyomu backup ZIP");
  }

  const aboutSections = parseKakuyomuSections(strFromU8(aboutBytes));
  const metadata = parseAboutMetadata(aboutSections);
  const projectTitle =
    metadata.title ?? i18next.t("import.kakuyomu.defaultProjectTitle");

  const episodes = collectEpisodes(files, warnings);
  const tocRoots = parseToc(aboutSections.get("目次") ?? "");
  const hasChapterHeaders = tocRoots.some((r) => r.explicitSection);
  const flatStructure = !hasChapterHeaders;

  let tree: ImportedNode[];

  if (flatStructure) {
    tree = [
      {
        kind: "folder",
        id: crypto.randomUUID(),
        title: projectTitle,
        children: episodes.map((ep) => episodeToScene(ep)),
      },
    ];
  } else {
    const { tree: builtTree, placedNums } = buildTreeFromToc(
      tocRoots,
      episodes,
      warnings,
    );
    tree = builtTree;
    appendUnmappedEpisodes(tree, episodes, placedNums, warnings);
  }

  return {
    projectTitle,
    tree,
    metadata,
    flatStructure,
    warnings,
  };
}

function parseAboutMetadata(sections: Map<string, string>): KakuyomuMetadata {
  const metadata: KakuyomuMetadata = {};

  for (const key of sections.keys()) {
    if (!KNOWN_ABOUT_KEYS.has(key)) continue;
  }

  metadata.title = sections.get("タイトル")?.trim() || undefined;
  metadata.author = sections.get("作者名")?.trim() || undefined;
  metadata.serialStatus = sections.get("連載状態")?.trim() || undefined;
  metadata.genre = sections.get("ジャンル")?.trim() || undefined;
  metadata.catchphrase = sections.get("キャッチコピー")?.trim() || undefined;
  metadata.outline = sections.get("紹介文（1行）")?.trim() || undefined;

  const tagsRaw = sections.get("タグ");
  if (tagsRaw) metadata.tags = parseBulletList(tagsRaw);

  const ratingRaw = sections.get("セルフレイティング");
  if (ratingRaw) metadata.selfRating = parseBulletList(ratingRaw);

  return metadata;
}

function collectEpisodes(
  files: Record<string, Uint8Array>,
  warnings: string[],
): ParsedEpisode[] {
  const episodes: ParsedEpisode[] = [];

  for (const [path, data] of Object.entries(files)) {
    const m = /^episode_(\d+)\.txt$/.exec(path);
    if (!m) continue;
    const num = Number(m[1]);
    const sections = parseKakuyomuSections(strFromU8(data));
    const title =
      sections.get("タイトル")?.trim() ||
      i18next.t("import.kakuyomu.defaultEpisodeTitle", { num });
    const body = extractEpisodeBody(sections);
    if (!body) {
      warnings.push(
        i18next.t("import.kakuyomu.warnings.emptyBody", {
          file: `episode_${String(num).padStart(4, "0")}.txt`,
        }),
      );
    }
    episodes.push({
      num,
      title,
      body,
      bodyProseMirror: kakuyomuBodyToProseMirror(body),
    });
  }

  episodes.sort((a, b) => a.num - b.num);
  return episodes;
}

function parseToc(tocText: string): TocChapter[] {
  if (!tocText.trim()) return [];

  const roots: TocChapter[] = [];
  const stack: { node: TocChapter; depth: number }[] = [];

  for (const line of tocText.split("\n")) {
    if (!line.trim()) continue;

    const leadingSpaces = line.match(/^ */)?.[0].length ?? 0;
    const depth = Math.floor(leadingSpaces / 2);
    const trimmed = line.trimStart();

    const chapterMatch = /^§\s+(.+)$/.exec(trimmed);
    if (chapterMatch) {
      const chapter: TocChapter = {
        id: crypto.randomUUID(),
        title: chapterMatch[1]!.trim(),
        depth,
        children: [],
        explicitSection: true,
      };
      while (stack.length > 0 && stack[stack.length - 1]!.depth >= depth) {
        stack.pop();
      }
      if (stack.length === 0) {
        roots.push(chapter);
      } else {
        stack[stack.length - 1]!.node.children.push(chapter);
      }
      stack.push({ node: chapter, depth });
      continue;
    }

    const episodeMatch = /^(\d+)\.\s+(.+)$/.exec(trimmed);
    if (episodeMatch) {
      const slot: TocEpisodeSlot = {
        kind: "episode",
        episodeNum: Number(episodeMatch[1]),
        title: episodeMatch[2]!.trim(),
      };
      if (stack.length === 0) {
        let root = roots.find((r) => r.title === "__implicit__");
        if (!root) {
          root = {
            id: crypto.randomUUID(),
            title: "__implicit__",
            depth: 0,
            children: [],
            explicitSection: false,
          };
          roots.push(root);
        }
        root.children.push(slot);
      } else {
        stack[stack.length - 1]!.node.children.push(slot);
      }
    }
  }

  return roots.filter(
    (r) => r.title !== "__implicit__" || r.children.length > 0,
  );
}

function buildTreeFromToc(
  tocRoots: TocChapter[],
  episodes: ParsedEpisode[],
  warnings: string[],
): { tree: ImportedNode[]; placedNums: Set<number> } {
  const episodeByNum = new Map(episodes.map((e) => [e.num, e]));
  const placedNums = new Set<number>();

  function convertNodes(nodes: TocNode[]): ImportedNode[] {
    const result: ImportedNode[] = [];
    for (const node of nodes) {
      if ("kind" in node && node.kind === "episode") {
        const ep = episodeByNum.get(node.episodeNum);
        if (!ep) {
          warnings.push(
            i18next.t("import.kakuyomu.warnings.missingEpisodeFile", {
              num: node.episodeNum,
              file: `episode_${String(node.episodeNum).padStart(4, "0")}.txt`,
            }),
          );
          continue;
        }
        placedNums.add(ep.num);
        if (ep.title !== node.title) {
          warnings.push(
            i18next.t("import.kakuyomu.warnings.titleMismatch", {
              num: ep.num,
              tocTitle: node.title,
              fileTitle: ep.title,
            }),
          );
        }
        result.push(episodeToScene(ep));
      } else {
        const chapter = node as TocChapter;
        result.push({
          kind: "folder",
          id: chapter.id,
          title: chapter.title,
          children: convertNodes(chapter.children),
        });
      }
    }
    return result;
  }

  return { tree: convertNodes(tocRoots), placedNums };
}

function appendUnmappedEpisodes(
  tree: ImportedNode[],
  episodes: ParsedEpisode[],
  placedNums: Set<number>,
  warnings: string[],
): void {
  const unmapped = episodes.filter((e) => !placedNums.has(e.num));
  if (unmapped.length === 0) return;

  for (const ep of unmapped) {
    warnings.push(
      i18next.t("import.kakuyomu.warnings.episodeNotInToc", {
        file: `episode_${String(ep.num).padStart(4, "0")}.txt`,
      }),
    );
  }

  const lastFolder = findLastFolder(tree);
  if (lastFolder) {
    for (const ep of unmapped) {
      lastFolder.children.push(episodeToScene(ep));
    }
  } else if (tree.length > 0) {
    tree.push({
      kind: "folder",
      id: crypto.randomUUID(),
      title: i18next.t("import.kakuyomu.extraEpisodesFolder"),
      children: unmapped.map(episodeToScene),
    });
  }
}

function findLastFolder(
  nodes: ImportedNode[],
): Extract<ImportedNode, { kind: "folder" }> | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]!;
    if (n.kind === "folder") {
      const nested = findLastFolder(n.children);
      return nested ?? n;
    }
  }
  return null;
}

function episodeToScene(ep: ParsedEpisode): ImportedNode {
  return {
    kind: "scene",
    id: crypto.randomUUID(),
    title: ep.title,
    body: ep.body,
    bodyProseMirror: ep.bodyProseMirror,
  };
}

/** Detect whether a ZIP looks like a Kakuyomu backup. */
export function isKakuyomuZip(files: Record<string, Uint8Array>): boolean {
  return (
    "about.txt" in files &&
    Object.keys(files).some((p) => /^episode_\d+\.txt$/.test(p))
  );
}

/** Detect whether a ZIP looks like a Novelcrafter export. */
export function isNovelcrafterZip(files: Record<string, Uint8Array>): boolean {
  return "novel.md" in files;
}
