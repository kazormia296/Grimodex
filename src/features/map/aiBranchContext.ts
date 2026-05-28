import type { Node } from "@xyflow/react";
import type { AiBranchSeed, AiBranchProjectContext } from "./mapAiApi";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { prosemirrorToText } from "@/lib/prosemirror";
import { getProject } from "@/features/project/api";
import type { MapSticky, MapAiBranch } from "@/db/schema";

/** 1500 文字を超える seed body は prompt 圧迫を避けるため切り詰める。
 *  AI Branch は「種から派生」UX のため詳細より概要重視で十分。 */
const SEED_BODY_LIMIT = 1500;

function clampBody(s: string): string {
  const t = s.trim();
  if (t.length <= SEED_BODY_LIMIT) return t;
  return t.slice(0, SEED_BODY_LIMIT) + "\n…(以下省略)";
}

/**
 * React Flow ノード id 群を受け取り、各ノードを seed として利用するための
 * title + body 抽出を行う。本文は store / 引数のローカル state から拾うので
 * 追加の IPC は走らない (project fetch 以外は同期)。
 */
export function collectAiBranchSeeds(
  nodes: Node[],
  stickies: MapSticky[],
  aiBranches: MapAiBranch[],
): AiBranchSeed[] {
  const treeNodes = useTreeStore.getState().nodes;
  const codexEntries = useCodexStore.getState().entries;
  const snippets = useSnippetStore.getState().entries;

  const seeds: AiBranchSeed[] = [];

  for (const n of nodes) {
    if (n.id.startsWith("scene:") || n.id.startsWith("note:")) {
      const id = n.id.slice(n.id.indexOf(":") + 1);
      const tree = treeNodes.find((t) => t.id === id);
      if (!tree) continue;
      seeds.push({
        type: n.id.startsWith("scene:") ? "scene" : "note",
        title: tree.title || "(無題)",
        body: tree.synopsis ? clampBody(tree.synopsis) : undefined,
      });
    } else if (n.id.startsWith("codex:")) {
      const id = n.id.slice("codex:".length);
      const entry = codexEntries.find((e) => e.id === id);
      if (!entry) continue;
      // summary を主、空なら content の本文を fallback。
      const rawBody =
        (entry.summary && entry.summary.trim()) ||
        (entry.content ? prosemirrorToText(entry.content).trim() : "");
      seeds.push({
        type: "codex",
        title: entry.name || "(無題)",
        body: rawBody ? clampBody(rawBody) : undefined,
      });
    } else if (n.id.startsWith("sticky:")) {
      const id = n.id.slice("sticky:".length);
      const sticky = stickies.find((s) => s.id === id);
      if (!sticky) continue;
      const body = sticky.body ? prosemirrorToText(sticky.body).trim() : "";
      seeds.push({
        type: "sticky",
        title: sticky.title || sticky.previewText || "(Sticky)",
        body: body ? clampBody(body) : undefined,
      });
    } else if (n.id.startsWith("snippet:")) {
      const id = n.id.slice("snippet:".length);
      const snippet = snippets.find((s) => s.id === id);
      if (!snippet) continue;
      const body = snippet.content ? prosemirrorToText(snippet.content) : "";
      seeds.push({
        type: "snippet",
        title: snippet.title || "(スニペット)",
        body: body ? clampBody(body) : undefined,
      });
    } else if (n.id.startsWith("ai_branch:")) {
      const id = n.id.slice("ai_branch:".length);
      const branch = aiBranches.find((b) => b.id === id);
      if (!branch) continue;
      seeds.push({
        type: "ai_branch",
        title: branch.prompt.slice(0, 60),
        body: branch.prompt.length > 60 ? branch.prompt : undefined,
      });
    }
  }

  return seeds;
}

/**
 * Project info を AI Branch 用に整形して返す。失敗時 null。Chat の
 * fetchProjectContext と重複するが、あちらは module-private なので
 * 当面コピー (将来 atom として切り出す可能性あり)。
 */
export async function fetchAiBranchProjectContext(
  projectId: string,
): Promise<AiBranchProjectContext | null> {
  try {
    const project = await getProject(projectId);
    if (!project) return null;
    return {
      title: project.title,
      genre: project.genre,
      pov: project.pov,
      tense: project.tense,
      synopsis: project.outline,
      styleGuide: project.styleGuide,
      aiInstructions: project.aiInstructions,
    };
  } catch {
    return null;
  }
}
