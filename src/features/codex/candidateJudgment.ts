/**
 * candidateJudgment.ts — 未確定固有名詞候補の LLM 判定 (B2)。
 *
 * 形態素×LLM の LLM 半分: B1 が決定的に列挙した候補に対し、single-shot で
 * (種別分類 / 一行要約 / 既存エントリの別名か) を判定する。伏線 AI
 * (proposePastSetups) と同じ「FE で sendChatMessageWithThinking →
 * extractJsonObject → 型ガード」パターン。post-effect の runs/annotations 機構には
 * 乗せない (これは Codex 候補の補助情報であって annotation ではない)。
 */
import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { getPromptCatalog } from "@/prompts/index";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import { getProject } from "@/features/project/api";
import { parseAliases } from "./codexMatcher";
import { candidateKey } from "./codexCandidates";
import type { CodexCandidate } from "./candidateExtractor";

export type SuggestedType = "character" | "location" | "item" | "lore";

export interface CandidateJudgment {
  surface: string;
  suggestedType: SuggestedType;
  summary: string;
  /** 既存エントリの別名と判断された場合その id。新規なら null。 */
  aliasOfId: string | null;
}

const SUGGESTED_TYPES: readonly SuggestedType[] = [
  "character",
  "location",
  "item",
  "lore",
];

// 1 リクエストのトークン量を抑える上限 (候補は Rust が count desc でソート済)。
const MAX_CANDIDATES = 50;
const MAX_ENTRIES = 200;

type EntryLike = { id: string; name: string | null; aliases: string | null };

/**
 * 候補を一括判定し、`candidateKey(surface) → CandidateJudgment` の Map を返す。
 * policy off / 候補なし / AI 失敗時は空 Map (UI は決定的な候補一覧のまま動く)。
 */
export async function judgeCandidates(
  candidates: ReadonlyArray<CodexCandidate>,
  entries: ReadonlyArray<EntryLike>,
): Promise<Map<string, CandidateJudgment>> {
  const result = new Map<string, CandidateJudgment>();
  // 分析系 LLM は analysis policy で gate (伏線/校閲と同じ)。
  if (blockIfPolicyOff("analysis")) return result;
  if (candidates.length === 0) return result;

  let lang = "ja";
  try {
    const project = await getProject(useTreeStore.getState().projectId);
    lang = project?.language ?? "ja";
  } catch {
    // ignore — ja 既定
  }

  const knownIds = new Set(entries.map((e) => e.id));
  // LLM が入力に無い surface を返した場合 (hallucination) を弾く照合先。
  const validSurfaces = new Set(candidates.map((c) => candidateKey(c.surface)));
  const prompt = getPromptCatalog(
    lang,
  ).codexJudgment.buildCandidateJudgmentPrompt({
    candidates: candidates.slice(0, MAX_CANDIDATES).map((c) => ({
      surface: c.surface,
      lemma: c.lemma,
      count: c.count,
      context: c.context,
    })),
    existingEntries: entries.slice(0, MAX_ENTRIES).map((e) => ({
      id: e.id,
      name: e.name ?? "",
      aliases: parseAliases(e.aliases),
    })),
  });

  let response;
  try {
    response = await sendChatMessageWithThinking([
      { role: "user", content: prompt },
    ]);
  } catch {
    return result;
  }
  void recordAiUsage({
    surface: "codex_judgment",
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
  });

  return parseJudgmentResponse(response.text, validSurfaces, knownIds);
}

/**
 * LLM 応答テキストから judgments を抽出・検証して Map にする純関数。
 * **本番経路 (judgeCandidates) と live 品質テストの双方がこれを使う** ことで
 * パーサのドリフトを防ぐ。型ガード:
 * - surface は入力候補 (validSurfaces) に在るものだけ (hallucination 棄却)。
 * - suggestedType は trim+lower で 4 種 enum に正規化、外れは捨てる。
 * - aliasOfId は実在 id (knownIds) のみ採用、未知/不正は null に倒す (判定は活かす)。
 */
export function parseJudgmentResponse(
  responseText: string,
  validSurfaces: Set<string>,
  knownIds: Set<string>,
): Map<string, CandidateJudgment> {
  const result = new Map<string, CandidateJudgment>();
  const jsonText = extractJsonObject(responseText);
  if (!jsonText) return result;
  try {
    const parsed = JSON.parse(jsonText) as { judgments?: unknown };
    if (!Array.isArray(parsed.judgments)) return result;
    for (const raw of parsed.judgments) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      if (typeof r.surface !== "string") continue;
      const key = candidateKey(r.surface);
      // 入力候補に無い surface (hallucination)・空キー (空白のみ) は捨てる。
      if (!key || !validSurfaces.has(key)) continue;
      // 種別は前後空白・大小を吸収して 4 種 enum に丸める。
      const typeStr =
        typeof r.suggestedType === "string"
          ? r.suggestedType.trim().toLowerCase()
          : "";
      if (!SUGGESTED_TYPES.includes(typeStr as SuggestedType)) continue;
      // aliasOfId は実在 id のみ採用。不正/未知は null に倒す (種別判定自体は活かす)。
      const aliasRaw =
        typeof r.aliasOfId === "string" ? r.aliasOfId.trim() : null;
      const aliasOfId = aliasRaw && knownIds.has(aliasRaw) ? aliasRaw : null;
      result.set(key, {
        surface: r.surface,
        suggestedType: typeStr as SuggestedType,
        summary: typeof r.summary === "string" ? r.summary : "",
        aliasOfId,
      });
    }
  } catch {
    // ignore — 空 Map
  }
  return result;
}
