import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import type { ForeshadowSetupSignalKind } from "@/features/narrative-extraction/ir/inferences/foreshadowSetupSignal";
import { runStructuredRepairTask } from "./runStructuredRepairTask";

export const NARRATIVE_FORESHADOW_SIGNAL_SYNTHESIZE_PATH =
  "narrative_foreshadow_signal_synthesize" as const;

const SETUP_KINDS: readonly ForeshadowSetupSignalKind[] = [
  "causal-seed",
  "prophetic-hint",
  "object-plant",
  "character-trait",
  "atmospheric-motif",
  "dialogue-echo",
  "other",
];

export interface RunForeshadowSignalSynthesisTaskInput {
  readonly clusterRef: string;
  readonly documentRef: string;
  readonly surface: string;
  readonly candidateEntityRefs: readonly string[];
  readonly projectId?: string | null;
  readonly repairOnFailure?: boolean;
}

export interface ForeshadowSignalSynthesisAiResult {
  readonly clusterRef: string;
  readonly documentRef: string;
  readonly proposition: string;
  readonly signalKind: ForeshadowSetupSignalKind;
  readonly materiality: "major" | "moderate" | "minor";
  readonly relatedEntityRefs: readonly string[];
}

function buildPrompt(input: RunForeshadowSignalSynthesisTaskInput): string {
  const entities = input.candidateEntityRefs.map((ref) => `- ${ref}`).join("\n");
  return `あなたは小説の伏線 setup 信号抽出アシスタントです。1 か所の本文抜粋から
setup 信号候補を JSON で返してください。候補にない Entity Ref は作らないでください。

# clusterRef
${input.clusterRef}

# documentRef
${input.documentRef}

# surface
${input.surface}

# candidateEntityRefs
${entities}

# signalKind の選択肢
causal-seed, prophetic-hint, object-plant, character-trait, atmospheric-motif, dialogue-echo, other

# 出力（JSON のみ）
{"clusterRef":"${input.clusterRef}","documentRef":"${input.documentRef}","proposition":"...","signalKind":"causal-seed","materiality":"moderate","relatedEntityRefs":[]}`;
}

function parseResult(
  responseText: string,
  input: RunForeshadowSignalSynthesisTaskInput,
): ForeshadowSignalSynthesisAiResult | null {
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
  if (row.documentRef !== input.documentRef) return null;
  if (typeof row.proposition !== "string" || row.proposition.trim() === "") {
    return null;
  }
  const signalKind = row.signalKind;
  if (
    typeof signalKind !== "string" ||
    !SETUP_KINDS.includes(signalKind as ForeshadowSetupSignalKind)
  ) {
    return null;
  }
  const materiality = row.materiality;
  if (
    materiality !== "major" &&
    materiality !== "moderate" &&
    materiality !== "minor"
  ) {
    return null;
  }
  const relatedEntityRefs = Array.isArray(row.relatedEntityRefs)
    ? row.relatedEntityRefs.filter((v): v is string => typeof v === "string")
    : [];
  return {
    clusterRef: input.clusterRef,
    documentRef: input.documentRef,
    proposition: row.proposition.trim(),
    signalKind: signalKind as ForeshadowSetupSignalKind,
    materiality,
    relatedEntityRefs,
  };
}

/** Stage AI: narrative_foreshadow_signal_synthesize */
export async function runForeshadowSignalSynthesisTask(
  input: RunForeshadowSignalSynthesisTaskInput,
): Promise<ForeshadowSignalSynthesisAiResult | null> {
  if (blockIfPolicyOff("analysis")) return null;
  const projectId = requireAuditProjectId(
    input.projectId ?? useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride(NARRATIVE_FORESHADOW_SIGNAL_SYNTHESIZE_PATH);
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: buildPrompt(input) }],
    {
      projectId,
      pathId: "narrative_foreshadow_signal_synthesize",
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
    surface: NARRATIVE_FORESHADOW_SIGNAL_SYNTHESIZE_PATH,
    model: ov.model,
    provider: ov.provider,
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
    projectId,
    metadata: { pathId: NARRATIVE_FORESHADOW_SIGNAL_SYNTHESIZE_PATH },
  });

  let parsed = parseResult(response.text, input);
  if (parsed === null && input.repairOnFailure !== false) {
    const repaired = await runStructuredRepairTask({
      brokenText: response.text,
      expectedShape: `{"clusterRef":"${input.clusterRef}","documentRef":"${input.documentRef}","proposition":"...","signalKind":"causal-seed","materiality":"moderate","relatedEntityRefs":[]}`,
      projectId,
    });
    if (repaired) parsed = parseResult(repaired, input);
  }
  return parsed;
}
