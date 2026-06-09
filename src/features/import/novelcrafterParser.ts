/**
 * Novelcrafter "full export" ZIP parser
 *
 * Converts Novelcrafter zip export bytes into Grimodex-compatible records
 * (codex entries + snippets). Pure function — no DB or Tauri calls here.
 */

import { unzipSync, strFromU8 } from "fflate";
import { zipBombGuard } from "./zipGuard";
import yaml from "js-yaml";
import type { ParsedChapter, ParsedScene } from "./importTypes";

export type { ParsedChapter, ParsedScene } from "./importTypes";

// ─────────────────────────────────────────────────────────────────
// Output types
// ─────────────────────────────────────────────────────────────────

export interface ParsedCodexEntry {
  /** New Grimodex UUID */
  id: string;
  /** Original Novelcrafter ID (used only for parent resolution) */
  ncId: string;
  type: string;
  name: string;
  aliases: string[];
  /** Raw body text from entry.md — converted to ProseMirror JSON and stored as codex content on import. */
  summary: string;
  /** ProseMirror JSON string. Always "{}" in the parser — importApi converts summary to ProseMirror and writes it here. */
  content: string;
  /** Raw key-value fields from entry.md frontmatter, imported as custom detail values */
  fields?: Record<string, string>;
  contextMode: "always" | "mentioned" | "hidden";
  /** JSON-serialised {name,color}[] for TagCacheItem compatibility */
  tagsCache: string;
  /** Raw image bytes for thumbnail (thumbnail.jpg), if present */
  thumbnail?: Uint8Array;
  /** Resolved Grimodex parent UUID, or undefined for top-level entries */
  parentId?: string;
}

export interface ParsedSnippet {
  /** New Grimodex UUID */
  id: string;
  /** Original Novelcrafter ID extracted from filename */
  ncId: string;
  title: string;
  /** Raw markdown body (stored verbatim as snippet content) */
  content: string;
}

/** A single message inside an imported chat session. */
export interface ParsedChatMessage {
  /** "user" or "assistant". */
  role: "user" | "assistant";
  /** Raw markdown content of the message. */
  content: string;
}

/** A chat session parsed from `chats/*.md`. */
export interface ParsedChatSession {
  /** New Grimodex UUID */
  id: string;
  /** Resolved title (frontmatter title → first-user-message preview → filename). */
  title: string;
  /** True when the title came from a non-empty frontmatter `title` field. */
  titleFromFrontmatter: boolean;
  /** ISO timestamp derived from the YYYY-MM-DD prefix of the filename. */
  createdAt: string;
  messages: ParsedChatMessage[];
}

export interface ParseResult {
  projectTitle: string;
  codexEntries: ParsedCodexEntry[];
  snippets: ParsedSnippet[];
  chapters: ParsedChapter[];
  chatSessions: ParsedChatSession[];
}

/** Collect all unique tag names across parsed entries, sorted alphabetically. */
export function collectAllTagNames(entries: ParsedCodexEntry[]): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    const tags = JSON.parse(entry.tagsCache) as {
      name: string;
      color: string | null;
    }[];
    for (const tag of tags) {
      if (tag.name) seen.add(tag.name);
    }
  }
  return [...seen].sort();
}

// ─────────────────────────────────────────────────────────────────
// Novelcrafter → Grimodex type map
// ─────────────────────────────────────────────────────────────────

const NC_TYPE_MAP: Record<string, string> = {
  character: "character",
  location: "location",
  object: "item",
  lore: "lore",
  other: "lore",
};

const CODEX_DIRS = [
  "characters",
  "locations",
  "lore",
  "objects",
  "other",
] as const;

// ─────────────────────────────────────────────────────────────────
// Main parser
// ─────────────────────────────────────────────────────────────────

export function parseNovelcrafterZip(zipBytes: Uint8Array): ParseResult {
  // zip-bomb / 過大 zip による renderer の OOM/ハングを防ぐ (PIO-3)。
  const files = unzipSync(zipBytes, { filter: zipBombGuard() });

  const projectTitle = parseProjectTitle(files);
  const { entries } = parseCodexEntries(files);
  const snippets = parseSnippets(files);
  const chapters = parseNovelBody(files);
  const chatSessions = parseChatSessions(files);

  return {
    projectTitle,
    codexEntries: entries,
    snippets,
    chapters,
    chatSessions,
  };
}

// ─────────────────────────────────────────────────────────────────
// Project title
// ─────────────────────────────────────────────────────────────────

function parseProjectTitle(files: Record<string, Uint8Array>): string {
  const novelMd = files["novel.md"];
  if (!novelMd) return "Imported Project";
  const text = strFromU8(novelMd);
  const match = text.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : "Imported Project";
}

// ─────────────────────────────────────────────────────────────────
// Codex entries
// ─────────────────────────────────────────────────────────────────

interface RawEntry {
  entry: ParsedCodexEntry;
  /** Novelcrafter IDs of direct children */
  childNcIds: string[];
}

function parseCodexEntries(files: Record<string, Uint8Array>): {
  entries: ParsedCodexEntry[];
  ncIdToGrimodexId: Map<string, string>;
} {
  const raw: RawEntry[] = [];
  const ncIdToGrimodexId = new Map<string, string>();

  for (const dir of CODEX_DIRS) {
    const prefix = `${dir}/`;
    // Collect unique sub-directory paths
    const subDirs = new Set<string>();
    for (const path of Object.keys(files)) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) continue;
      subDirs.add(rest.slice(0, slash));
    }

    for (const subDir of subDirs) {
      const base = `${prefix}${subDir}/`;
      const metadataBytes = files[`${base}metadata.json`];
      const entryBytes = files[`${base}entry.md`];
      const thumbnailBytes = files[`${base}thumbnail.jpg`];

      if (!metadataBytes) continue;

      let metadata: NcMetadata;
      try {
        metadata = JSON.parse(strFromU8(metadataBytes)) as NcMetadata;
      } catch {
        continue;
      }

      const grimodexId = crypto.randomUUID();
      ncIdToGrimodexId.set(metadata.id, grimodexId);

      const attrs = metadata.attributes;
      const type = NC_TYPE_MAP[attrs.type] ?? "lore";
      const contextMode = resolveContextMode(attrs);

      let summary = "";
      const content = "{}";
      let rawFields: Record<string, string> | undefined;

      if (entryBytes) {
        const { frontmatter, body } = parseFrontmatter(strFromU8(entryBytes));
        summary = body.trim();
        const fields =
          frontmatter && typeof frontmatter === "object"
            ? (frontmatter as Record<string, unknown>).fields
            : undefined;
        if (fields && typeof fields === "object" && fields !== null) {
          const entries: Record<string, string> = {};
          for (const [k, v] of Object.entries(
            fields as Record<string, unknown>,
          )) {
            if (typeof v === "string") entries[k] = v;
          }
          if (Object.keys(entries).length > 0) {
            rawFields = entries;
          }
        }
      }

      raw.push({
        entry: {
          id: grimodexId,
          ncId: metadata.id,
          type,
          name: attrs.name,
          aliases: attrs.aliases ?? [],
          summary,
          content,
          contextMode,
          tagsCache: JSON.stringify(
            (attrs.tags ?? []).map((t: string) => ({ name: t, color: null })),
          ),
          thumbnail: thumbnailBytes,
          parentId: undefined,
          fields: rawFields,
        },
        childNcIds: metadata.relationships?.nestedEntries ?? [],
      });
    }
  }

  const entries = raw.map((r) => r.entry);

  // Second pass: assign parentId based on parent's childNcIds
  for (const { entry, childNcIds } of raw) {
    for (const childNcId of childNcIds) {
      const childGrimodexId = ncIdToGrimodexId.get(childNcId);
      if (!childGrimodexId) continue;
      const childEntry = entries.find((e) => e.id === childGrimodexId);
      if (childEntry) {
        childEntry.parentId = entry.id;
      }
    }
  }

  return { entries, ncIdToGrimodexId };
}

// ─────────────────────────────────────────────────────────────────
// Snippets
// ─────────────────────────────────────────────────────────────────

function parseSnippets(files: Record<string, Uint8Array>): ParsedSnippet[] {
  const snippets: ParsedSnippet[] = [];

  for (const [path, data] of Object.entries(files)) {
    if (!path.startsWith("snippets/") || !path.endsWith(".md")) continue;

    const md = strFromU8(data);
    const { frontmatter, body } = parseFrontmatter(md);

    const fm =
      frontmatter && typeof frontmatter === "object"
        ? (frontmatter as Record<string, unknown>)
        : {};
    const title =
      typeof fm.title === "string" && fm.title
        ? fm.title
        : basenameWithoutExtension(path);

    // Extract Novelcrafter ID from filename: "{date} {name} - {id}.md"
    const filename = basenameWithoutExtension(path);
    const idMatch = filename.match(/-\s*([A-Za-z0-9]+)$/);
    const ncId = idMatch ? idMatch[1] : crypto.randomUUID();

    snippets.push({
      id: crypto.randomUUID(),
      ncId,
      title,
      content: body.trim(),
    });
  }

  return snippets;
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function basenameWithoutExtension(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  const base = parts[parts.length - 1] ?? path;
  return base.endsWith(".md") ? base.slice(0, -3) : base;
}

/**
 * Parse YAML frontmatter from a markdown string.
 * Returns the parsed frontmatter object and the body after the closing `---`.
 */
function parseFrontmatter(md: string): {
  frontmatter: unknown;
  body: string;
} {
  // Normalize Windows line endings so parsing works regardless of export platform
  const normalized = md.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) {
    return { frontmatter: null, body: normalized };
  }
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: null, body: md };
  }
  const yamlStr = normalized.slice(4, end); // skip opening "---\n"
  const body = normalized.slice(end + 4).trimStart(); // skip closing "---\n"
  let frontmatter: unknown = null;
  try {
    frontmatter = yaml.load(yamlStr);
  } catch {
    // ignore YAML parse errors — treat as no frontmatter
  }
  return { frontmatter, body };
}

function resolveContextMode(
  attrs: NcAttributes,
): "always" | "mentioned" | "hidden" {
  if (attrs.alwaysIncludeInContext) return "always";
  if (attrs.doNotTrack) return "hidden";
  return "mentioned";
}

// ─────────────────────────────────────────────────────────────────
// Novelcrafter types
// ─────────────────────────────────────────────────────────────────

interface NcAttributes {
  type: string;
  name: string;
  color: string | null;
  aliases: string[];
  tags: string[];
  alwaysIncludeInContext: boolean;
  doNotTrack: boolean;
  noAutoInclude: boolean;
}

interface NcMetadata {
  id: string;
  attributes: NcAttributes;
  relationships?: {
    nestedEntries?: string[];
  };
}

// ─────────────────────────────────────────────────────────────────
// Novel body (novel.md)
// ─────────────────────────────────────────────────────────────────

/**
 * Parse `novel.md` into chapters/scenes.
 *
 * Format produced by Novelcrafter's "full markdown" export:
 *
 *   # Project Title
 *   by Author
 *
 *   ## Act 1            ← chapter (folder)
 *
 *   ### Scene Title     ← scene
 *
 *   ...any text...      ← scene body (preserved verbatim)
 *
 * The leading `# Title` and the `by ...` line are skipped. Everything between
 * a scene heading and the next heading (`##` or `###`) is captured verbatim
 * as the scene `body` — bullet lists, `---` separators, and prose are all
 * treated as part of the same document.
 */
function parseNovelBody(files: Record<string, Uint8Array>): ParsedChapter[] {
  const novelMd = files["novel.md"];
  if (!novelMd) return [];

  const text = strFromU8(novelMd).replace(/\r\n/g, "\n");
  const lines = text.split("\n");

  const chapters: ParsedChapter[] = [];
  let currentChapter: ParsedChapter | null = null;
  let currentScene: ParsedScene | null = null;

  let bodyLines: string[] = [];

  function flushScene(): void {
    if (!currentScene) return;
    currentScene.body = bodyLines.join("\n").replace(/^\n+|\n+$/g, "");
    bodyLines = [];
  }

  for (const line of lines) {
    // Chapter heading: "## ..." (but not "### ...")
    const chapterMatch = /^##\s+(.+?)\s*$/.exec(line);
    if (chapterMatch && !line.startsWith("###")) {
      flushScene();
      currentScene = null;
      currentChapter = {
        id: crypto.randomUUID(),
        title: chapterMatch[1].trim(),
        scenes: [],
      };
      chapters.push(currentChapter);
      continue;
    }

    // Scene heading: "### ..."
    const sceneMatch = /^###\s+(.+?)\s*$/.exec(line);
    if (sceneMatch) {
      flushScene();
      // Scenes without an enclosing chapter are placed under a synthetic chapter
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
        title: sceneMatch[1].trim(),
        body: "",
      };
      currentChapter.scenes.push(currentScene);
      continue;
    }

    if (!currentScene) continue; // pre-scene preamble (title / author)
    bodyLines.push(line);
  }

  flushScene();

  return chapters;
}

// ─────────────────────────────────────────────────────────────────
// Chat sessions (chats/*.md)
// ─────────────────────────────────────────────────────────────────

/**
 * Parse `chats/*.md` into chat sessions.
 *
 * Each file is one session. Format:
 *
 *   ---
 *   title: "..."
 *   favourite: false
 *   ---
 *   ## User
 *   <message body>
 *
 *   ## AI
 *   <message body>
 *
 * Filename pattern: `YYYY-MM-DD <id>.md` — date used as session createdAt.
 */
function parseChatSessions(
  files: Record<string, Uint8Array>,
): ParsedChatSession[] {
  const sessions: ParsedChatSession[] = [];

  for (const [path, data] of Object.entries(files)) {
    if (!path.startsWith("chats/") || !path.endsWith(".md")) continue;

    const md = strFromU8(data);
    const { frontmatter, body } = parseFrontmatter(md);

    const messages = parseChatMessages(body);

    const filename = basenameWithoutExtension(path);
    const fm =
      frontmatter && typeof frontmatter === "object"
        ? (frontmatter as Record<string, unknown>)
        : {};
    const fmTitle = typeof fm.title === "string" ? fm.title.trim() : "";
    const titleFromFrontmatter = fmTitle.length > 0;

    let title = fmTitle;
    if (!title) {
      const firstUser = messages.find((m) => m.role === "user");
      if (firstUser) {
        const preview = firstUser.content.replace(/\s+/g, " ").trim();
        title = preview.length > 40 ? `${preview.slice(0, 40)}…` : preview;
      }
    }
    if (!title) title = filename;

    const createdAt = parseDateFromFilename(filename);

    sessions.push({
      id: crypto.randomUUID(),
      title,
      titleFromFrontmatter,
      createdAt,
      messages,
    });
  }

  return sessions;
}

function parseChatMessages(body: string): ParsedChatMessage[] {
  const normalized = body.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const messages: ParsedChatMessage[] = [];

  let currentRole: "user" | "assistant" | null = null;
  let buffer: string[] = [];

  function flush(): void {
    if (currentRole === null) return;
    const content = buffer.join("\n").trim();
    if (content) messages.push({ role: currentRole, content });
    buffer = [];
  }

  for (const line of lines) {
    const m = /^##\s+(User|AI|Assistant)\s*$/i.exec(line);
    if (m) {
      flush();
      const label = m[1].toLowerCase();
      currentRole = label === "user" ? "user" : "assistant";
      continue;
    }
    if (currentRole !== null) buffer.push(line);
  }
  flush();

  return messages;
}

/**
 * Extract a YYYY-MM-DD prefix from the filename and convert to an ISO timestamp
 * at midnight UTC. Falls back to the current time if no date prefix is present.
 */
function parseDateFromFilename(filename: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(filename);
  if (!m) return new Date().toISOString();
  const [, y, mo, d] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return date.toISOString();
}
