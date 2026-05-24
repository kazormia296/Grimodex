import type { Snippet } from "@/features/snippets/api";
import { renderArchiveBodyFromDb } from "../exportEngine";
import type { ZipExportSettings } from "./types";
import { resolveUniqueSlug } from "./slug";

export function serializeSnippets(
  snippets: Snippet[],
  settings: ZipExportSettings,
): { path: string; content: string }[] {
  const used = new Set<string>();
  return snippets.map((s) => {
    const slug = resolveUniqueSlug(s.title || "snippet", used);
    const body = renderArchiveBodyFromDb(s.content, {
      rubyStyle: settings.rubyFormatForArchive,
      emphasisDotsStyle: settings.emphasisDotsFormatForArchive,
    });
    const frontmatter = [
      "---",
      `id: ${s.id}`,
      `sceneId: ${s.sceneId ? JSON.stringify(s.sceneId) : "null"}`,
      `sourceChatMessageId: ${s.sourceChatMessageId ? JSON.stringify(s.sourceChatMessageId) : "null"}`,
      `tags: ${s.tagsCache ?? "[]"}`,
      `createdAt: ${JSON.stringify(s.createdAt)}`,
      "---",
      "",
    ].join("\n");
    return {
      path: `snippets/${slug}.md`,
      content: frontmatter + body,
    };
  });
}
