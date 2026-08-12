import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import type { SetupPayoffBridgeKind } from "@/features/narrative-extraction/ir/inferences/setupPayoffSupportEdge";
import { runStructuredRepairTask } from "./runStructuredRepairTask";

export const NARRATIVE_SETUP_PAYOFF_LINK_PATH =
  "narrative_setup_payoff_link" as const;

const BRIDGE_KINDS: readonly SetupPayoffBridgeKind[] = [
  "direct-echo",
  "causal-unlock",
  "character-reveal",
  "object-return",
  "motif-resolution",
  "thematic-payoff",
  "other",
];

export interface RunSetupPayoffLinkTaskInput {
  readonly clusterRef: string;
  readonly setupSummary: string;
  readonly payoffSummary: string;
  readonly projectId?: string | null;
  readonly repairOnFailure?: boolean;
}

export interface SetupPayoffLinkAiResult {
  readonly clusterRef: string;
  readonly bridgeKind: SetupPayoffBridgeKind;
  readonly confidence: "high" | "medium" | "low";
  readonly explanation: string;
}

function buildPrompt(input: RunSetupPayoffLinkTaskInput): string {
  return `あなたは小説の setup/payoff リンクアシスタントです。setup 信号と payoff 信号の
対応関係を JSON で返してください。新しい Scene ID や DB ID は作らないでください。

# clusterRef
${input.clusterRef}

# setupSummary
${input.setupSummary}

# payoffSummary
${input.payoffSummary}

# bridgeKind の選択肢
direct-echo, causal-unlock, character-reveal, object-return, motif-resolution, thematic-payoff, other

# 出力（JSON のみ）
{"clusterRef":"${input.clusterRef}","bridgeKind":"causal-unlock","confidence":"medium","explanation":"..."}`;
}

function parseResult(
  responseText: string,
  input: RunSetupPayoffLinkTaskInput,
): SetupPayoffLinkAiResult | null {
  const jsonText = extractJsonObject(responseText);
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (row.clusterRef !== input.clusterRef) return null;
  const bridgeKind = row.bridgeKind;
  if (
    typeof bridgeKind !== "string" ||
    !BRIDGE_KINDS.includes(bridgeKind as SetupPayoffBridgeKind)
  ) {
    return null;
  }
  const confidence = row.confidence;
  if (
    confidence !== "high" &&
    confidence !== "medium" &&
    confidence !== "low"
  ) {
    return null;
  }
  if (typeof row.explanation !== "string" || row.explanation.trim() === "") {
    return null;
  }
  return {
    clusterRef: input.clusterRef,
    bridgeKind: bridgeKind as SetupPayoffBridgeKind,
    confidence,
    explanation: row.explanation.trim(),
  };
}

/** Stage AI: narrative_setup_payoff_link */
export async function runSetupPayoffLinkTask(
  input: RunSetupPayoffLinkTaskInput,
): Promise<SetupPayoffLinkAiResult | null> {
  if (blockIfPolicyOff("analysis")) return null;
  const projectId = requireAuditProjectId(
    input.projectId ?? useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride(NARRATIVE_SETUP_PAYOFF_LINK_PATH);
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: buildPrompt(input) }],
    {
      projectId,
      pathId: "narrative_setup_payoff_link",
    },
    undefined,
    undefined,
    ov.apiVariant,
    undefined,
    ov.model,
    ov.provider,
    ov.endpointId,
  );
  void recordAiUsage({
    surface: NARRATIVE_SETUP_PAYOFF_LINK_PATH,
    model: ov.model,
    provider: ov.provider,
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
    projectId,
    metadata: { pathId: NARRATIVE_SETUP_PAYOFF_LINK_PATH },
  });

  let parsed = parseResult(response.text, input);
  if (parsed === null && input.repairOnFailure !== false) {
    const repaired = await runStructuredRepairTask({
      brokenText: response.text,
      expectedShape: `{"clusterRef":"${input.clusterRef}","bridgeKind":"causal-unlock","confidence":"medium","explanation":"..."}`,
      projectId,
    });
    if (repaired) parsed = parseResult(repaired, input);
  }
  return parsed;
}
