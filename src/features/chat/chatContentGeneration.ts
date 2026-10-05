import { buildThinkingParams, getEffortForTask } from "./agent/modelLimits";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { requireAuditProjectId } from "@/features/ai-audit/projectScope";
import { getProject } from "@/features/project/api";
import { useTreeStore } from "@/features/tree/treeStore";
import { getPromptCatalog } from "@/prompts/index";
import { resolveRoleSendOverride } from "./modelRouting";
import { sanitizeSceneContent } from "./contextBuilder";
import { loadSingleShotTransport } from "./lazyTransportApi";

/**
 * B-8: One-shot synopsis generation from scene content.
 * Returns the generated synopsis text (100-200 chars).
 */
export async function generateSynopsisFromContent(
  sceneTitle: string,
  sceneContent: string,
): Promise<string> {
  const { invokeSingleShotChat } = await loadSingleShotTransport();
  const projectId = useTreeStore.getState().projectId;
  const project = await getProject(projectId).catch(() => null);
  const lang = project?.language ?? "ja";
  const messages = [
    {
      role: "user",
      content: getPromptCatalog(lang).chatApi.buildSynopsisFromContentPrompt(
        sceneTitle,
        sanitizeSceneContent(sceneContent),
      ),
    },
  ];
  const ov = resolveRoleSendOverride("synopsis");
  const response = await invokeSingleShotChat(
    {
      messages,
      thinking: null,
      effort: null,
      reasoningEnabled: null,
      reasoningEffort: null,
      apiVariant: ov.apiVariant,
      model: ov.model,
      provider: ov.provider,
      endpointId: ov.endpointId,
    },
    {
      projectId: requireAuditProjectId(projectId),
      pathId: "synopsis",
    },
  );
  // N4: あらすじ生成の usage を台帳に記録する。
  void recordAiUsage({
    surface: "synopsis",
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
    projectId,
  });
  return response.blocks
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; content: string }).content)
    .join("\n");
}

/**
 * セッションタイトルを軽量モデルで自動生成する (P1-2)
 * Returns the generated title, or null if generation failed.
 */
export async function generateSessionTitle(
  userMessage: string,
  assistantReply: string,
  model: string,
  lang = "ja",
  projectId?: string | null,
): Promise<string | null> {
  try {
    const { invokeSingleShotChat } = await loadSingleShotTransport();
    // 機能別モデル: session_title ロールが設定されていればそれを使い、未設定なら
    // 呼び出し側が渡した既定モデル(model)へフォールバック（thinking/usage 表示用）。
    // 実生成は invoke の model 引数（roleModel ?? null）で決まり、null は Rust 側で
    // settings.model に解決される＝未設定時 byte-identical。
    const ov = resolveRoleSendOverride("session_title");
    const effectiveModel = ov.model ?? model;
    const thinkingParams = buildThinkingParams(
      effectiveModel,
      getEffortForTask("session_title"),
      "omitted",
    );
    const messages = [
      {
        role: "user",
        content: getPromptCatalog(lang).chatApi.buildSessionTitlePrompt(
          userMessage,
          assistantReply,
        ),
      },
    ];
    const response = await invokeSingleShotChat(
      {
        messages,
        thinking: thinkingParams.thinking ?? null,
        effort: thinkingParams.effort ?? null,
        reasoningEnabled: thinkingParams.reasoningEnabled ?? null,
        reasoningEffort: thinkingParams.reasoningEffort ?? null,
        apiVariant: ov.apiVariant,
        model: ov.model,
        provider: ov.provider,
        endpointId: ov.endpointId,
      },
      {
        projectId: requireAuditProjectId(
          projectId ?? useTreeStore.getState().projectId,
        ),
        pathId: "session_title",
      },
    );
    void recordAiUsage({
      surface: "session_title",
      model: effectiveModel,
      projectId,
      tokensIn: response.inputTokens,
      tokensOut: response.outputTokens,
    });
    const title = response.blocks
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; content: string }).content)
      .join("")
      .trim();
    return title || null;
  } catch {
    return null;
  }
}
