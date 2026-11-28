import type {
  MastraAgentTurnQuestionPayload,
  MastraAgentTurnQuestionToolName,
  MastraAgentTurnUiToolResult,
} from "@/../electron/shared/mastraAgentTurnWire";
import type { createAskUserToolHandler } from "./chatAgentToolHandlers";
import {
  answerMastraAgentTurnQuestion,
  listenMastraAgentTurnQuestion,
} from "@/lib/mastraAgentTurn";

type AskUserContext = Parameters<typeof createAskUserToolHandler>[0];
type TurnAuthorityCheck = () => void;
type HandlerResult = Pick<
  MastraAgentTurnUiToolResult,
  "content" | "summary" | "tokensUsed"
> &
  Partial<
    Pick<MastraAgentTurnUiToolResult, "error" | "undoId" | "settingProposal">
  >;
type UiOperationLimit = (
  name: string,
  toolCallId: string,
) => HandlerResult | null;

const loadAppUiTools = () => import("@/features/chat/agent/appUiTools");
const loadUiOperationTools = () =>
  import("@/features/chat/agent/uiOperationTools");
const loadSettingProposalTools = () =>
  import("@/features/chat/agent/settingProposalTools");
const loadAppHelpTools = () => import("@/features/chat/agent/appHelpTools");
const loadAskUserTools = () => import("@/features/chat/agent/askUser");
const loadChatAgentToolHandlers = () => import("./chatAgentToolHandlers");

function errorResult(
  question: MastraAgentTurnQuestionPayload,
  message: string,
): MastraAgentTurnUiToolResult {
  return {
    toolCallId: question.toolCallId,
    name: question.toolName,
    content: { error: message },
    summary: message,
    tokensUsed: 0,
    error: message,
  };
}

function isRecordWithUndoId(value: unknown): value is { undoId: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).undoId === "string"
  );
}

async function loadHandler(
  name: Exclude<
    MastraAgentTurnQuestionToolName,
    "apply_ai_tree_plan" | "propose_scene_body"
  >,
  askUserContext: AskUserContext,
): Promise<
  (
    toolCallId: string,
    args: Record<string, unknown>,
  ) => HandlerResult | Promise<HandlerResult>
> {
  switch (name) {
    case "ask_user": {
      const { createAskUserToolHandler } = await loadChatAgentToolHandlers();
      const handler = createAskUserToolHandler(askUserContext);
      return async (toolCallId, args) => {
        const result = await handler("ask_user", toolCallId, args);
        if (result === null) throw new Error("ask_user handler unavailable");
        return result as HandlerResult;
      };
    }
    case "run_app_command": {
      const { runAppCommandTool } = await loadAppUiTools();
      return (_toolCallId, args) => runAppCommandTool(args);
    }
    case "apply_layout_preset": {
      const { applyLayoutPresetTool } = await loadAppUiTools();
      return (_toolCallId, args) => applyLayoutPresetTool(args);
    }
    case "propose_setting_change": {
      const { proposeSettingChangeTool } = await loadSettingProposalTools();
      return (_toolCallId, args) => proposeSettingChangeTool(args);
    }
    case "get_ui_state": {
      const { getUiStateTool } = await loadAppHelpTools();
      return () => getUiStateTool();
    }
    case "get_app_help_index": {
      const { getAppHelpIndexTool } = await loadAppHelpTools();
      return (_toolCallId, args) => getAppHelpIndexTool(args);
    }
    case "get_app_help": {
      const { getAppHelpTool } = await loadAppHelpTools();
      return (_toolCallId, args) => getAppHelpTool(args);
    }
    default: {
      const exhaustive: never = name;
      return Promise.reject(new Error(`Unknown UI tool: ${exhaustive}`));
    }
  }
}

export async function registerMastraAgentTurnResponder(
  turnId: string,
  assertTurnAuthority: TurnAuthorityCheck,
  askUserContext: AskUserContext,
): Promise<() => void> {
  let active = true;
  let uiOperationLimit: UiOperationLimit | null = null;
  let activeAskUserToolCallId: string | null = null;

  const answerQuestion = async (
    question: MastraAgentTurnQuestionPayload,
  ): Promise<void> => {
    if (Date.now() >= question.deadlineAt) {
      await answerMastraAgentTurnQuestion({
        requestId: question.requestId,
        result: errorResult(
          question,
          "UI tool request expired before execution",
        ),
      }).catch(() => undefined);
      return;
    }

    try {
      assertTurnAuthority();
    } catch {
      await answerMastraAgentTurnQuestion({
        requestId: question.requestId,
        refusal: "authority-revoked",
      }).catch(() => undefined);
      return;
    }

    let handler: Awaited<ReturnType<typeof loadHandler>> | null = null;
    if (
      question.toolName !== "apply_ai_tree_plan" &&
      question.toolName !== "propose_scene_body"
    ) {
      try {
        handler = await loadHandler(question.toolName, askUserContext);
      } catch {
        await answerMastraAgentTurnQuestion({
          requestId: question.requestId,
          result: errorResult(question, "UI tool handler failed to load"),
        }).catch(() => undefined);
        return;
      }
    }
    if (!active) return;
    if (Date.now() >= question.deadlineAt) {
      await answerMastraAgentTurnQuestion({
        requestId: question.requestId,
        result: errorResult(
          question,
          "UI tool request expired before execution",
        ),
      }).catch(() => undefined);
      return;
    }

    if (
      question.toolName === "run_app_command" ||
      question.toolName === "apply_layout_preset"
    ) {
      try {
        assertTurnAuthority();
      } catch {
        await answerMastraAgentTurnQuestion({
          requestId: question.requestId,
          refusal: "authority-revoked",
        }).catch(() => undefined);
        return;
      }
      if (uiOperationLimit === null) {
        const [
          { createUiOperationLimitHandler },
          { MAX_UI_OPERATIONS_PER_TURN },
        ] = await Promise.all([
          loadChatAgentToolHandlers(),
          loadUiOperationTools(),
        ]);
        if (!active) return;
        uiOperationLimit = createUiOperationLimitHandler(
          MAX_UI_OPERATIONS_PER_TURN,
        ) as UiOperationLimit;
      }
      const limited = uiOperationLimit(question.toolName, question.toolCallId);
      if (limited) {
        await answerMastraAgentTurnQuestion({
          requestId: question.requestId,
          result: {
            ...limited,
            toolCallId: question.toolCallId,
            name: question.toolName,
          },
        }).catch(() => undefined);
        return;
      }
    }

    if (Date.now() >= question.deadlineAt) {
      await answerMastraAgentTurnQuestion({
        requestId: question.requestId,
        result: errorResult(
          question,
          "UI tool request expired before execution",
        ),
      }).catch(() => undefined);
      return;
    }

    try {
      assertTurnAuthority();
    } catch {
      await answerMastraAgentTurnQuestion({
        requestId: question.requestId,
        refusal: "authority-revoked",
      }).catch(() => undefined);
      return;
    }

    let result: MastraAgentTurnUiToolResult;
    if (question.toolName === "ask_user") {
      activeAskUserToolCallId = question.toolCallId;
    }
    try {
      if (
        question.toolName === "apply_ai_tree_plan" ||
        question.toolName === "propose_scene_body"
      ) {
        const { executeTool } =
          await import("@/features/chat/agent/toolExecutors");
        if (!active) return;
        try {
          assertTurnAuthority();
        } catch {
          await answerMastraAgentTurnQuestion({
            requestId: question.requestId,
            refusal: "authority-revoked",
          }).catch(() => undefined);
          return;
        }
        const executed = await executeTool(
          question.toolName,
          question.toolCallId,
          { ...question.args },
          question.authorization,
        );
        result = {
          toolCallId: question.toolCallId,
          name: question.toolName,
          content: executed.content,
          summary: executed.summary,
          tokensUsed: executed.tokensUsed,
          ...(executed.error ? { error: executed.error } : {}),
          ...(question.toolName === "apply_ai_tree_plan" &&
          isRecordWithUndoId(executed.content)
            ? { undoId: executed.content.undoId }
            : {}),
        };
      } else {
        result = {
          ...(await handler!(question.toolCallId, { ...question.args })),
          toolCallId: question.toolCallId,
          name: question.toolName,
        };
      }
    } catch {
      result = errorResult(question, "UI tool handler failed");
    } finally {
      if (activeAskUserToolCallId === question.toolCallId) {
        activeAskUserToolCallId = null;
      }
    }
    if (!active) return;
    await answerMastraAgentTurnQuestion({
      requestId: question.requestId,
      result,
    }).catch(() => undefined);
  };

  const unlisten = await listenMastraAgentTurnQuestion((question) => {
    if (!active || question.turnId !== turnId) return;
    void answerQuestion(question).catch(() => undefined);
  });

  return () => {
    if (!active) return;
    active = false;
    unlisten();
    if (activeAskUserToolCallId !== null) {
      const toolCallId = activeAskUserToolCallId;
      void loadAskUserTools()
        .then(({ dismissedAskUserResult }) => {
          let matchesPendingQuestion = false;
          askUserContext.set((state) => {
            matchesPendingQuestion =
              state.pendingUserQuestion?.toolCallId === toolCallId;
            return matchesPendingQuestion ? { pendingUserQuestion: null } : {};
          });
          if (matchesPendingQuestion) {
            askUserContext.runtime.cancel(
              dismissedAskUserResult(toolCallId, askUserContext.dismissNote),
            );
          }
        })
        .catch(() => undefined);
    }
  };
}
