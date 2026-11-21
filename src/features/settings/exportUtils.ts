import { db } from "@/db/client";
import { treeNodes, codexEntries, codexTypes } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { prosemirrorToText } from "@/lib/prosemirror";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { orderNodesInReadingOrder } from "@/features/tree/treeReadingOrder";

const MAX_HEADING_LEVEL = 6;

export async function exportAsMarkdown(): Promise<string> {
  // 外部 Markdown のファイル消失・重複で自動の soft delete になった行は出力しない。
  // 祖先だけが archived の行は listNodes と同じく残る（root から届かない行として末尾に並ぶ）。
  const nodes = await db
    .select()
    .from(treeNodes)
    .where(
      and(
        eq(treeNodes.projectId, getCurrentProjectId()),
        isNull(treeNodes.archivedAt),
      ),
    );

  // 読む順は tree の DFS（兄弟ごとの sortOrder）。見出しの深さは folder の入れ子の深さ
  // （第一部＞第一章＞場面 なら # ＞ ## ＞ ###）。
  const parts: string[] = [];
  for (const { node, depth } of orderNodesInReadingOrder(nodes)) {
    const heading = "#".repeat(Math.min(depth + 1, MAX_HEADING_LEVEL));
    if (node.nodeType === "folder") {
      parts.push(`${heading} ${node.title}\n`);
    } else if (node.nodeType === "scene" || node.nodeType === "note") {
      parts.push(`${heading} ${node.title}\n`);
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
