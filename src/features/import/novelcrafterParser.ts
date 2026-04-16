/**
 * Novelcrafter "full export" ZIP parser
 *
 * Converts Novelcrafter zip export bytes into Grimodex-compatible records
 * (codex entries + snippets). Pure function — no DB or Tauri calls here.
 */

import { unzipSync, strFromU8 } from "fflate";
import yaml from "js-yaml";

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
  summary: string;
  /** ProseMirror JSON string. "{}" when no fields. */
  content: string;
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

export interface ParseResult {
  projectTitle: string;
  codexEntries: ParsedCodexEntry[];
  snippets: ParsedSnippet[];
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
  const files = unzipSync(zipBytes);

  const projectTitle = parseProjectTitle(files);
  const { entries } = parseCodexEntries(files);
  const snippets = parseSnippets(files);

  return { projectTitle, codexEntries: entries, snippets };
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
      let content = "{}";

      if (entryBytes) {
        const { frontmatter, body } = parseFrontmatter(strFromU8(entryBytes));
        summary = body.trim();
        const fields =
          frontmatter && typeof frontmatter === "object"
            ? (frontmatter as Record<string, unknown>).fields
            : undefined;
        if (fields && typeof fields === "object" && fields !== null) {
          const fieldMap = fields as Record<string, string>;
          if (Object.keys(fieldMap).length > 0) {
            content = buildProseMirrorFromFields(fieldMap);
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

/**
 * Build a minimal ProseMirror JSON document from a Novelcrafter `fields` map.
 * Each field becomes a level-3 heading followed by paragraph nodes.
 */
function buildProseMirrorFromFields(fields: Record<string, string>): string {
  const content: {
    type: string;
    attrs?: Record<string, unknown>;
    content?: unknown[];
  }[] = [];

  for (const [name, value] of Object.entries(fields)) {
    if (typeof value !== "string") continue;

    content.push({
      type: "heading",
      attrs: { level: 3 },
      content: [makeTextNode(name)],
    });

    // Paragraph nodes — split value on blank lines
    const lines = value.split("\n");
    let paraLines: string[] = [];
    for (const line of lines) {
      if (line.trim() === "") {
        if (paraLines.length > 0) {
          content.push(makeParagraph(paraLines.join("\n")));
          paraLines = [];
        }
      } else {
        paraLines.push(line);
      }
    }
    if (paraLines.length > 0) {
      content.push(makeParagraph(paraLines.join("\n")));
    }
  }

  return JSON.stringify({ type: "doc", content });
}

function makeTextNode(text: string) {
  return { type: "text", text };
}

function makeParagraph(text: string) {
  if (!text.trim()) {
    return { type: "paragraph" };
  }
  return {
    type: "paragraph",
    content: [makeTextNode(text)],
  };
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
