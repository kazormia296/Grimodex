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
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import { getPromptCatalog } from "@/prompts/index";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import { getProject } from "@/features/project/api";
import { parseAliases } from "./codexMatcher";
import { candidateKey, knownNameSet } from "./codexCandidates";
import type { CodexCandidate } from "./candidateExtractor";
import i18next from "@/lib/i18n";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { listCodexIdsHiddenFromAiInAnyPhase } from "./context/codexHiddenAnyPhase";

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

export const CODEX_JUDGMENT_NO_VALID_RESULT =
  "CODEX_JUDGMENT_NO_VALID_RESULT" as const;

export const CODEX_JUDGMENT_HIDDEN_CHECK_FAILED =
  "CODEX_JUDGMENT_HIDDEN_CHECK_FAILED" as const;

/** hidden（AI に秘匿）の判定に失敗したため、何も送らなかった。 */
export class CandidateJudgmentHiddenCheckFailedError extends Error {
  readonly code = CODEX_JUDGMENT_HIDDEN_CHECK_FAILED;

  constructor() {
    super(i18next.t("codex.candidates.judgeFailed"));
    this.name = "CandidateJudgmentHiddenCheckFailedError";
  }
}

export const CODEX_JUDGMENT_PROJECT_CHANGED =
  "CODEX_JUDGMENT_PROJECT_CHANGED" as const;

/** 判定の途中で project が切り替わったため、何も送らなかった。 */
export class CandidateJudgmentProjectChangedError extends Error {
  readonly code = CODEX_JUDGMENT_PROJECT_CHANGED;

  constructor() {
    super(i18next.t("codex.candidates.judgeFailed"));
    this.name = "CandidateJudgmentProjectChangedError";
  }
}

export class CandidateJudgmentNoValidResultError extends Error {
  readonly code = CODEX_JUDGMENT_NO_VALID_RESULT;

  constructor() {
    super(i18next.t("codex.candidates.judgeNoResult"));
    this.name = "CandidateJudgmentNoValidResultError";
  }
}

type EntryLike = { id: string; name: string | null; aliases: string | null };

/**
 * 候補を一括判定し、`candidateKey(surface) → CandidateJudgment` の Map を返す。
 * policy off / 候補なしは空 Map。送信失敗・有効結果なしは reject し、UI が通知する。
 * いずれの場合も決定的な候補一覧自体は維持される。
 *
 * 作者が hidden（AI に秘匿）と印した Codex の id・名前・別名は送らない。この画面は場面を
 * 持たないので、base が hidden、またはどれかの Phase で hidden の項目を全部除く
 * （`listCodexIdsHiddenFromAiInAnyPhase`）。判定は送信の直前に DB で行い（呼び側の `entries` は
 * 古いことがある）、先頭 `MAX_ENTRIES` 件の窓は除いた後に数える。候補そのもの（surface・lemma）が
 * 除いた項目の名前・別名と同じなら、その候補も送らない。判定に失敗したら、または判定の間に
 * project が切り替わったら、fail-closed で何も送らず reject する。ADR 013。
 */
export async function judgeCandidates(
  candidates: ReadonlyArray<CodexCandidate>,
  entries: ReadonlyArray<EntryLike>,
): Promise<Map<string, CandidateJudgment>> {
  const result = new Map<string, CandidateJudgment>();
  // 分析系 LLM は analysis policy で gate (伏線/校閲と同じ)。
  if (blockIfPolicyOff("analysis") || blockIfUnlicensed()) return result;
  if (candidates.length === 0) return result;

  // projectId は同期的な入口で固定し、以後の await をまたいで使い回す（途中で project が
  // 切り替わっても、旧 project の候補を新 project の id で送らない）。
  const projectId = requireAuditProjectId(useTreeStore.getState().projectId);

  let lang = "ja";
  try {
    const project = await getProject(projectId);
    lang = project?.language ?? "ja";
  } catch {
    // ignore — ja 既定
  }

  // 送信の直前に hidden を判定して除く。判定に失敗したら送らない（fail-closed）。
  let sendableEntries: ReadonlyArray<EntryLike>;
  let hiddenEntries: ReadonlyArray<EntryLike>;
  try {
    const hidden = await listCodexIdsHiddenFromAiInAnyPhase({
      entryIds: entries.map((e) => e.id),
      projectId,
    });
    sendableEntries = entries.filter((e) => !hidden.has(e.id));
    hiddenEntries = entries.filter((e) => hidden.has(e.id));
  } catch (error) {
    debugLog.warn(
      "codex-hidden",
      "hidden 判定に失敗したので候補の AI 評価を送らない",
      errorDetail(error),
    );
    throw new CandidateJudgmentHiddenCheckFailedError();
  }

  // 候補そのもの（surface・lemma）が hidden の名前・別名と同じなら、その候補も送らない
  // （呼び側が hidden を除いた entries を渡しても、entries に含まれる hidden とは照合できる）。
  const hiddenKeys = knownNameSet(hiddenEntries);
  const sendableCandidates = candidates.filter(
    (c) =>
      !hiddenKeys.has(candidateKey(c.surface)) &&
      !hiddenKeys.has(candidateKey(c.lemma)),
  );
  if (sendableCandidates.length === 0) return result;

  const knownIds = new Set(sendableEntries.map((e) => e.id));
  // LLM が入力に無い surface を返した場合 (hallucination) を弾く照合先。
  const validSurfaces = new Set(
    sendableCandidates.map((c) => candidateKey(c.surface)),
  );
  const prompt = getPromptCatalog(
    lang,
  ).codexJudgment.buildCandidateJudgmentPrompt({
    candidates: sendableCandidates.slice(0, MAX_CANDIDATES).map((c) => ({
      surface: c.surface,
      lemma: c.lemma,
      count: c.count,
      context: c.context,
    })),
    existingEntries: sendableEntries.slice(0, MAX_ENTRIES).map((e) => ({
      id: e.id,
      name: e.name ?? "",
      aliases: parseAliases(e.aliases),
    })),
  });

  // 判定の await の間に project が切り替わっていたら、送らずに reject する。
  if (useTreeStore.getState().projectId?.trim() !== projectId) {
    throw new CandidateJudgmentProjectChangedError();
  }

  const ov = resolveRoleSendOverride("codex_judgment");
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: prompt }],
    {
      projectId,
      pathId: "codex_judgment",
    },
    undefined, // thinkingParams
    undefined, // systemCacheSegments
    ov.apiVariant, // apiVariant（横断割り当て時のみ）
    undefined, // systemVolatileTail
    ov.model,
    ov.provider,
    ov.endpointId,
  );
  void recordAiUsage({
    surface: "codex_judgment",
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
  });

  const parsed = parseJudgmentResponse(response.text, validSurfaces, knownIds);
  if (parsed.size === 0) throw new CandidateJudgmentNoValidResultError();
  return parsed;
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
