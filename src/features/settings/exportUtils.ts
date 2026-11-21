import { db } from "@/db/client";
import { treeNodes, codexEntries, codexTypes } from "@/db/schema";
import { eq, asc } from "drizzle-orm";
import { prosemirrorToText } from "@/lib/prosemirror";
import { getCurrentProjectId } from "@/features/project/projectStore";

export async function exportAsMarkdown(): Promise<string> {
  const scenes = await db
    .select()
    .from(treeNodes)
    .where(eq(treeNodes.projectId, getCurrentProjectId()))
    .orderBy(asc(treeNodes.sortOrder));

  const parts: string[] = [];
  for (const node of scenes) {
    if (node.nodeType === "part") {
      parts.push(`# ${node.title}\n`);
    } else if (node.nodeType === "chapter") {
      parts.push(`## ${node.title}\n`);
    } else if (node.nodeType === "scene" || node.nodeType === "note") {
      parts.push(`### ${node.title}\n`);
      const text = prosemirrorToText(node.content);
      if (text.trim()) parts.push(text + "\n");
    }
  }
  return parts.join("\n");
}

export async function exportAsPlainText(): Promise<string> {
  const md = await exportAsMarkdown();
  // Strip Markdown headings and extra whitespace
  return md
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function exportCodexJson(): Promise<string> {
  const types = await db
    .select()
    .from(codexTypes)
    .where(eq(codexTypes.projectId, getCurrentProjectId()));

  const entries = await db
    .select()
    .from(codexEntries)
    .where(eq(codexEntries.projectId, getCurrentProjectId()));

  const typeMap = Object.fromEntries(types.map((t) => [t.slug, t.label]));

  const data = entries.map((e) => ({
    id: e.id,
    type: typeMap[e.type] ?? e.type,
    name: e.name,
    aliases: e.aliases ? JSON.parse(e.aliases) : [],
    summary: e.summary ?? "",
  }));

  return JSON.stringify(data, null, 2);
}
