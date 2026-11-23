import type { Node } from "@xyflow/react";
import {
  generateAiBranchCards,
  type AiBranchSeed,
  type AiBranchProjectContext,
} from "./mapAiApi";
import type { AiBranchCard } from "./mapApi";
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
import { isCodexContextModeHiddenFromAi } from "@/features/codex/context/codexVisibilityPolicy";
import { listCodexIdsHiddenFromAiInAnyPhase } from "@/features/codex/context/codexHiddenAnyPhase";
import type { AiOperationAuthority } from "@/features/ai-audit/projectScope";
import type { VsOptions } from "@/lib/verbalizedSampling";
import { debugLog, errorDetail } from "@/lib/debugLog";
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
 * 種（seed）・Spotlight の Codex が、どの Codex 由来かを送信の直前まで運ぶための局所の型。
 * 公開の `AiBranchSeed`（mapAiApi。audit 経路 map_branch の sourceRef）は変えない。
 * `codexEntryId` は送る直前に剥がす（prompt・送信には出ない）。
 */
export type AiBranchSeedSource = AiBranchSeed & { codexEntryId?: string };

/**
 * React Flow ノード id 群を受け取り、各ノードを seed として利用するための
 * title + body 抽出を行う。本文は store / 引数のローカル state から拾うので
 * 追加の IPC は走らない (project fetch 以外は同期)。
 */
export function collectAiBranchSeeds(
  nodes: Node[],
  stickies: MapSticky[],
  aiBranches: MapAiBranch[],
): AiBranchSeedSource[] {
  const treeNodes = useTreeStore.getState().nodes;
  const codexEntries = useCodexStore.getState().entries;
  const snippets = useSnippetStore.getState().entries;

  const seeds: AiBranchSeedSource[] = [];

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
      // 作者が AI に秘匿（hidden）と印した Codex は種にしない。chat の
      // nonSceneContextSource と同じ正本（codexVisibilityPolicy）で、地図は
      // 場面を持たないので base の mode で判定する。
      if (isCodexContextModeHiddenFromAi(entry.contextMode)) continue;
      // summary を主、空なら content の本文を fallback。
      const rawBody =
        (entry.summary && entry.summary.trim()) ||
        (entry.content ? prosemirrorToText(entry.content).trim() : "");
      seeds.push({
        type: "codex",
        title: entry.name || "(無題)",
        body: rawBody ? clampBody(rawBody) : undefined,
        codexEntryId: entry.id,
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
export async function fetchActiveSessionSpotlight(): Promise<
  AiBranchSeedSource[]
> {
  const sessionId = useChatStore.getState().activeSessionId;
  if (!sessionId) return [];

  try {
    const [codexPins, snippetPins, stickyPins] = await Promise.all([
      listPinnedCodexEntries(sessionId),
      listPinnedSnippetEntries(sessionId),
      listPinnedStickyEntries(sessionId),
    ]);

    const out: AiBranchSeedSource[] = [];

    for (const entry of codexPins) {
      // hidden の pin は AI に渡さない（seed と同じ判定）。
      if (isCodexContextModeHiddenFromAi(entry.contextMode)) continue;
      const rawBody =
        (entry.summary && entry.summary.trim()) ||
        (entry.content ? prosemirrorToText(entry.content).trim() : "");
      out.push({
        type: "codex",
        title: entry.name || "(無題)",
        body: rawBody ? clampBody(rawBody) : undefined,
        codexEntryId: entry.id,
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

/** hidden（AI に秘匿）の判定に失敗したため、何も送らなかった。画面には原因の文を出さない（debugLog のみ）。 */
export const MAP_AI_BRANCH_HIDDEN_CHECK_FAILED =
  "MAP_AI_BRANCH_HIDDEN_CHECK_FAILED" as const;

export class AiBranchHiddenCheckFailedError extends Error {
  readonly code = MAP_AI_BRANCH_HIDDEN_CHECK_FAILED;

  constructor() {
    super("AI Branch hidden check failed; nothing was sent");
    this.name = "AiBranchHiddenCheckFailedError";
  }
}

/** `codexEntryId` を剥がして、公開の `AiBranchSeed` に戻す（prompt・送信に id を出さない）。 */
function stripSource(seed: AiBranchSeedSource): AiBranchSeed {
  const { codexEntryId, ...rest } = seed;
  void codexEntryId;
  return rest;
}

/**
 * 送信の直前に、種・Spotlight の Codex を DB で判定して hidden を除く。
 *
 * 地図は場面を持たないので、base が hidden、またはどれかの Phase で hidden（不明な mode を含む）、
 * DB に無い・この project でない Codex は送らない（`listCodexIdsHiddenFromAiInAnyPhase`。DR-MP4-43）。
 * 判定に失敗したら `AiBranchHiddenCheckFailedError` で reject し、何も送らない（fail-closed）。
 * Codex が 1 件も無いときは DB を読まず、失敗もしない。Codex 以外の種は無条件に残り、順序は保つ。
 */
export async function prepareAiBranchSendContext(input: {
  projectId: string;
  seeds: readonly AiBranchSeedSource[];
}): Promise<{
  projectCtx: AiBranchProjectContext | null;
  seeds: AiBranchSeed[];
  spotlight: AiBranchSeed[];
}> {
  // helper は projectId が空だと project で絞らない。入口で守る。
  const projectId = input.projectId?.trim();
  if (!projectId) {
    debugLog.warn("codex-hidden", "AI Branch に projectId が無いので送らない");
    throw new AiBranchHiddenCheckFailedError();
  }

  const [projectCtx, pins] = await Promise.all([
    fetchAiBranchProjectContext(projectId),
    fetchActiveSessionSpotlight(),
  ]);

  const isCodex = (s: AiBranchSeedSource) => s.type === "codex";
  const entryIds = new Set<string>();
  for (const s of [...input.seeds, ...pins]) {
    if (isCodex(s) && s.codexEntryId) entryIds.add(s.codexEntryId);
  }

  let hidden = new Set<string>();
  if (entryIds.size > 0) {
    try {
      hidden = await listCodexIdsHiddenFromAiInAnyPhase({
        entryIds: [...entryIds],
        projectId,
      });
    } catch (error) {
      debugLog.warn(
        "codex-hidden",
        "hidden 判定に失敗したので AI Branch を送らない",
        errorDetail(error),
      );
      throw new AiBranchHiddenCheckFailedError();
    }
  }

  // id を持たない Codex の種は、由来を確かめられないので送らない。
  const sendable = (s: AiBranchSeedSource): boolean => {
    if (!isCodex(s)) return true;
    return !!s.codexEntryId && !hidden.has(s.codexEntryId);
  };

  return {
    projectCtx,
    seeds: input.seeds.filter(sendable).map(stripSource),
    spotlight: pins.filter(sendable).map(stripSource),
  };
}

/**
 * AI Branch の生成（判定から送信まで）。`generateAiBranchCards` の呼び元はここだけで、
 * hidden の判定を必ず先に通す（呼び元が判定を飛ばして送る経路を作らない）。
 *
 * 順序：project 文脈・pin の取得 → hidden の判定 → `assertAuthority()` → 送信。
 * 判定に失敗したら送信 0 回で reject する。`assertAuthority` が throw しても送信 0 回。
 */
export async function runAiBranchGeneration(input: {
  prompt: string;
  count: number;
  seeds: readonly AiBranchSeedSource[];
  vs: VsOptions | null;
  authority: AiOperationAuthority;
  /** 非同期の読みの後・送信の直前に呼ぶ。project・board の切替を検出したら throw する。 */
  assertAuthority: () => void;
}): Promise<AiBranchCard[]> {
  const { projectCtx, seeds, spotlight } = await prepareAiBranchSendContext({
    projectId: input.authority.projectId,
    seeds: input.seeds,
  });
  // 文脈・判定は非同期で、切替の間に古い store を見たかもしれない。送信の前に必ず確かめる。
  input.assertAuthority();
  return generateAiBranchCards(
    input.prompt,
    input.count,
    seeds,
    projectCtx,
    spotlight,
    input.vs,
    input.authority,
  );
}
