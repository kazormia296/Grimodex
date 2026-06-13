import type { Node } from "@xyflow/react";
import type { AiBranchSeed, AiBranchProjectContext } from "./mapAiApi";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useChatStore } from "@/features/chat/chatStore";
import {
  listPinnedCodexEntries,
  listPinnedSnippetEntries,
  listPinnedStickyEntries,
} from "@/features/chat/chatApi";
import { prosemirrorToText } from "@/lib/prosemirror";
import { fetchProjectContext } from "@/features/project/contextAtoms";
import { useSettingsStore } from "@/features/settings/settingsStore";
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
 * Project info を AI Branch 用に整形して返す。共有 atom
 * fetchProjectContext (features/project/contextAtoms) の薄ラッパ。
 * field 名が outline→synopsis に変わるだけ。
 */
export async function fetchAiBranchProjectContext(
  projectId: string,
): Promise<AiBranchProjectContext | null> {
  const ctx = await fetchProjectContext(projectId);
  if (!ctx) return null;
  return {
    title: ctx.title,
    genre: ctx.genre,
    pov: ctx.pov,
    tense: ctx.tense,
    synopsis: ctx.outline,
    styleGuide: ctx.styleGuide,
    aiInstructions: ctx.aiInstructions,
    // en プロジェクトは AI Branch プロンプトを英語で組む。
    language: ctx.language,
    // ユーザー定義の AI Branch 追記指示 (project_settings)。空なら system に出ない。
    customInstruction: useSettingsStore
      .getState()
      .get("aiPrompt.custom.aiBranch", ""),
  };
}

/**
 * アクティブな Chat session の pin (Codex / Snippet / Sticky) を AI
 * Branch の seed 配列の前段に挿入する。Chat で「常時参照したい世界観」
 * として pin したエンティティを Map AI Branch 側でも自動で踏まえる
 * ためのブリッジ。session が無いときは空配列。
 *
 * 設計上の妥協:
 *  - chat session は project-scoped かつ複数存在しうるが、ここでは
 *    activeSessionId 一本だけを参照する。「ユーザーが今フォーカス
 *    している世界観」を流用するセマンティクス。
 *  - pin の本文は prosemirrorToText で plain 化、長文は 1500 字 clamp。
 *  - 失敗は silent (空配列フォールバック)。
 */
export async function fetchActiveSessionSpotlight(): Promise<AiBranchSeed[]> {
  const sessionId = useChatStore.getState().activeSessionId;
  if (!sessionId) return [];

  try {
    const [codexPins, snippetPins, stickyPins] = await Promise.all([
      listPinnedCodexEntries(sessionId),
      listPinnedSnippetEntries(sessionId),
      listPinnedStickyEntries(sessionId),
    ]);

    const out: AiBranchSeed[] = [];

    for (const entry of codexPins) {
      const rawBody =
        (entry.summary && entry.summary.trim()) ||
        (entry.content ? prosemirrorToText(entry.content).trim() : "");
      out.push({
        type: "codex",
        title: entry.name || "(無題)",
        body: rawBody ? clampBody(rawBody) : undefined,
      });
    }

    for (const sn of snippetPins) {
      const body = sn.content ? prosemirrorToText(sn.content).trim() : "";
      out.push({
        type: "snippet",
        title: sn.title || "(スニペット)",
        body: body ? clampBody(body) : undefined,
      });
    }

    for (const st of stickyPins) {
      const body = st.content ? prosemirrorToText(st.content).trim() : "";
      out.push({
        type: "sticky",
        title: st.title || "(Sticky)",
        body: body ? clampBody(body) : undefined,
      });
    }

    return out;
  } catch {
    return [];
  }
}
