import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import type { DetailDefinitionCatalogRecord } from "@/features/codex/details/detailDefinitionCatalog";
import type { ProjectedDetailValue } from "@/features/codex/details/semanticBindingTypes";
import type { StateAssertionValue } from "@/features/narrative-extraction/ir/observations/stateAssertion";
import {
  composeDetailValue,
  DetailComposeError,
} from "@/features/codex/extraction/detailValueComposer";
import { runStructuredRepairTask } from "./runStructuredRepairTask";

export const NARRATIVE_DETAIL_COMPOSE_PATH =
  "narrative_detail_compose" as const;

export interface RunDetailComposeTaskInput {
  readonly definition: DetailDefinitionCatalogRecord;
  readonly facetKey: string;
  readonly assertionValue: StateAssertionValue;
  readonly optionRefs?: ReadonlySet<string>;
  readonly projectId?: string | null;
  readonly repairOnFailure?: boolean;
}

function buildPrompt(input: RunDetailComposeTaskInput): string {
  const options = input.optionRefs
    ? [...input.optionRefs].map((ref) => `- ${ref}`).join("\n")
    : "(none)";
  return `あなたは小説の Custom Detail 値整形アシスタントです。State Assertion を Detail Definition 向けの値へ整形し JSON で返してください。
dropdown では opaque optionRef のみを使い、ラベル文字列をそのまま返さないでください。
clear / inherit / set を混同しないでください。

# definitionRef
${input.definition.definitionRef}

# fieldType
${input.definition.fieldType}

# facetKey
${input.facetKey}

# assertion
${JSON.stringify(input.assertionValue)}

# optionRefs
${options}

# 出力（JSON のみ）
{"writeKind":"set","value":{"kind":"text","text":"監察官"}}`;
}

function parseComposed(
  responseText: string,
  input: RunDetailComposeTaskInput,
): ProjectedDetailValue | null {
  const jsonText = extractJsonObject(responseText);
  if (!jsonText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const row = parsed as Record<string, unknown>;
  const writeKind = row.writeKind;
  if (writeKind === "clear") return { kind: "clear" };
  if (writeKind === "inherit") {
    // inherit is not a ProjectedDetailValue; reject AI inventing inherit as value
    return null;
  }
  const value = row.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.kind === "text" && typeof v.text === "string") {
    return { kind: "text", text: v.text };
  }
  if (v.kind === "enum" && typeof v.optionRef === "string") {
    if (input.optionRefs && !input.optionRefs.has(v.optionRef)) return null;
    return { kind: "enum", optionRef: v.optionRef };
  }
  if (v.kind === "entity" && typeof v.entityId === "string") {
    return { kind: "entity", entityId: v.entityId };
  }
  if (v.kind === "clear") return { kind: "clear" };
  return null;
}

/**
 * Stage AI: narrative_detail_compose.
 * Deterministic composeDetailValue is authoritative; AI may only refine text.
 */
export async function runDetailComposeTask(
  input: RunDetailComposeTaskInput,
): Promise<ProjectedDetailValue | null> {
  let deterministic: ProjectedDetailValue | null = null;
  try {
    deterministic = composeDetailValue({
      definition: input.definition,
      assertionValue: input.assertionValue,
      optionRefs: input.optionRefs,
    });
  } catch (error) {
    if (!(error instanceof DetailComposeError)) throw error;
    deterministic = null;
  }

  if (blockIfPolicyOff("analysis")) return deterministic;
  // Dropdown / clear stay deterministic — never let AI invent option labels.
  if (
    input.definition.fieldType === "dropdown" ||
    input.assertionValue.kind === "clear"
  ) {
    return deterministic;
  }

  const prompt = buildPrompt(input);
  const projectId = requireAuditProjectId(
    input.projectId ?? useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride(NARRATIVE_DETAIL_COMPOSE_PATH);
  const response = await sendChatMessageWithThinking(
    [{ role: "user", content: prompt }],
    {
      projectId,
      pathId: "narrative_detail_compose",
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
    surface: NARRATIVE_DETAIL_COMPOSE_PATH,
    model: ov.model,
    provider: ov.provider,
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
    projectId,
    metadata: { pathId: NARRATIVE_DETAIL_COMPOSE_PATH },
  });

  let composed = parseComposed(response.text, input);
  if (composed === null && input.repairOnFailure !== false) {
    const repaired = await runStructuredRepairTask({
      brokenText: response.text,
      expectedShape: `{"writeKind":"set","value":{"kind":"text","text":"..."}}`,
      projectId,
    });
    if (repaired) composed = parseComposed(repaired, input);
  }

  return composed ?? deterministic;
}
