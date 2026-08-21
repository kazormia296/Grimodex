import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockNarrativeAiTask } from "./narrativeAiTaskGuard";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  assertStageExecutionContext,
  NARRATIVE_STAGE_IDS,
  type NarrativeStageExecutionContext,
} from "@/features/narrative-extraction/reconciler/stageExecution";

export const NARRATIVE_STRUCTURED_REPAIR_PATH =
  "narrative_structured_repair" as const;

export interface RunStructuredRepairTaskInput {
  readonly brokenText: string;
  readonly expectedShape: string;
  readonly projectId?: string | null;
  /** Child Stage identity when called from a Chronicle pilot stage. */
  readonly stageExecution?: NarrativeStageExecutionContext;
  /** Live eval / tests may inject the child-stage transport. */
  readonly send?: StructuredRepairSend;
}

export type StructuredRepairSend = (
  messages: Parameters<typeof sendChatMessageWithThinking>[0],
  options: Parameters<typeof sendChatMessageWithThinking>[1] & {
    readonly stageExecution?: NarrativeStageExecutionContext;
  },
) => Promise<
  Pick<
    Awaited<ReturnType<typeof sendChatMessageWithThinking>>,
    "text" | "inputTokens" | "outputTokens"
  >
>;

export type RunStructuredRepairTaskInputWithTransport =
  RunStructuredRepairTaskInput;

/**
 * Stage AI: narrative_structured_repair.
 * Called at most once after a JSON extract/parse failure on another stage.
 */
export async function runStructuredRepairTask(
  input: RunStructuredRepairTaskInput,
): Promise<string | null> {
  if (blockNarrativeAiTask()) return null;

  if (input.stageExecution) {
    assertStageExecutionContext(input.stageExecution);
    if (
      input.projectId !== undefined &&
      input.projectId !== null &&
      input.projectId !== input.stageExecution.projectId
    ) {
      throw new TypeError(
        "Structured repair projectId must match stage execution projectId",
      );
    }
    if (input.stageExecution.stageId !== NARRATIVE_STAGE_IDS.structuredRepair) {
      throw new TypeError(
        `Structured repair requires stageId '${NARRATIVE_STAGE_IDS.structuredRepair}'`,
      );
    }
  }

  const prompt = `次のモデル出力を、指定の JSON 形へ修復してください。説明文は付けず JSON だけを返します。
Project ID / Scene ID / Event ID などの DB 識別子は新たに作らず、入力に含まれる Source View ref（S0001 形式）だけを維持してください。

# 期待する形
${input.expectedShape}

# 壊れた出力
${input.brokenText}`;

  const projectId = requireAuditProjectId(
    input.projectId ??
      input.stageExecution?.projectId ??
      useTreeStore.getState().projectId,
  );
  const ov = resolveRoleSendOverride("narrative_structured_repair");
  const response = input.send
    ? await input.send([{ role: "user", content: prompt }], {
        projectId,
        pathId: "narrative_structured_repair",
        ...(input.stageExecution
          ? { stageExecution: input.stageExecution }
          : {}),
      })
    : await sendChatMessageWithThinking(
        [{ role: "user", content: prompt }],
        {
          projectId,
          pathId: "narrative_structured_repair",
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
    surface: "narrative_structured_repair",
    model: ov.model,
    provider: ov.provider,
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
    projectId,
    metadata: { pathId: NARRATIVE_STRUCTURED_REPAIR_PATH },
  });

  return extractJsonObject(response.text);
}
