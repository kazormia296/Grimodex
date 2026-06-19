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

function isValidJudgment(
  x: unknown,
  knownIds: Set<string>,
): x is CandidateJudgment {
  if (!x || typeof x !== "object") return false;
  const j = x as Record<string, unknown>;
  if (typeof j.surface !== "string" || j.surface.length === 0) return false;
  if (
    typeof j.suggestedType !== "string" ||
    !SUGGESTED_TYPES.includes(j.suggestedType as SuggestedType)
  ) {
    return false;
  }
  if (j.summary != null && typeof j.summary !== "string") return false;
  // aliasOfId は null か、実在する既存エントリ id のみ許可 (hallucinate 棄却)。
  if (
    j.aliasOfId != null &&
    (typeof j.aliasOfId !== "string" || !knownIds.has(j.aliasOfId))
  ) {
    return false;
  }
  return true;
}

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

  const jsonText = extractJsonObject(response.text);
  if (!jsonText) return result;
  try {
    const parsed = JSON.parse(jsonText) as { judgments?: unknown };
    if (!Array.isArray(parsed.judgments)) return result;
    for (const raw of parsed.judgments) {
      if (isValidJudgment(raw, knownIds)) {
        result.set(candidateKey(raw.surface), {
          surface: raw.surface,
          suggestedType: raw.suggestedType,
          summary: typeof raw.summary === "string" ? raw.summary : "",
          aliasOfId: raw.aliasOfId ?? null,
        });
      }
    }
  } catch {
    // ignore — 空 Map
  }
  return result;
}
