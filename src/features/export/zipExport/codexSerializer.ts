import { renderPmDocToArchiveMarkdown } from "../exportEngine";
import type { CodexEntry } from "@/features/codex/api";
import type { ZipExportSettings } from "./types";
import { resolveUniqueSlug } from "./slug";

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((v) => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

function parseTags(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function buildFrontmatter(entry: CodexEntry): string {
  const lines = [
    "---",
    `id: ${entry.id}`,
    `name: ${JSON.stringify(entry.name)}`,
    `aliases: ${JSON.stringify(parseJsonArray(entry.aliases))}`,
    `excluded_aliases: ${JSON.stringify(parseJsonArray(entry.excludedAliases))}`,
    `summary: ${JSON.stringify(entry.summary ?? "")}`,
    `tags: ${JSON.stringify(parseTags(entry.tagsCache))}`,
    `context_mode: ${entry.contextMode}`,
    `children_budget: ${entry.childrenBudget}`,
    `icon: ${entry.icon ? JSON.stringify(entry.icon) : "null"}`,
    "---",
    "",
  ];
  return lines.join("\n");
}

export interface CodexFileEntry {
  path: string;
  content: string;
}

export function serializeCodexEntries(
  entries: CodexEntry[],
  settings: ZipExportSettings,
): CodexFileEntry[] {
  const usedByDir = new Map<string, Set<string>>();
  const files: CodexFileEntry[] = [];

  for (const entry of entries) {
    const typeSlug = entry.type || "misc";
    const used = usedByDir.get(typeSlug) ?? new Set<string>();
    usedByDir.set(typeSlug, used);
    const nameSlug = resolveUniqueSlug(entry.name, used);

    const body = renderPmDocToArchiveMarkdown(entry.content, {
      rubyStyle: settings.rubyFormatForArchive,
      emphasisDotsStyle: settings.emphasisDotsFormatForArchive,
    });

    const notesSection = entry.notes?.trim()
      ? `\n## Notes\n\n${entry.notes.trim()}\n`
      : "";

    files.push({
      path: `codex/${typeSlug}/${nameSlug}.md`,
      content: buildFrontmatter(entry) + body + notesSection,
    });
  }

  return files;
}
