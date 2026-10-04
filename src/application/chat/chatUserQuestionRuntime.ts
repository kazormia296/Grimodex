import type { ChatStoreActionPorts } from "./chatStoreActionPorts";
import type { ChatState } from "./chatStoreTypes";
import {
  buildAskUserResult,
  dismissedAskUserResult,
} from "@/features/chat/agent/askUser";
import type {
  AskUserContent,
  ToolResult,
} from "@/features/chat/agent/agentTypes";

export interface ChatUserQuestionRuntime {
  register: (resolve: (result: ToolResult) => void) => void;
  resolve: (result: ToolResult) => void;
  cancel: (result: ToolResult) => void;
}

export function createChatUserQuestionRuntime(): ChatUserQuestionRuntime {
  let resolver: ((result: ToolResult) => void) | null = null;

  return {
    register(resolve) {
      resolver = resolve;
    },
    resolve(result) {
      resolver?.(result);
      resolver = null;
    },
    cancel(result) {
      if (!resolver) return;
      resolver(result);
      resolver = null;
    },
  };
}

export function createChatUserQuestionStoreActions(
  ports: ChatStoreActionPorts & {
    runtime: ChatUserQuestionRuntime;
    abortTurn: () => void;
  },
): Pick<
  ChatState,
  "resolveUserQuestion" | "dismissUserQuestion" | "_cancelPendingUserQuestion"
> {
  const { get, set, runtime } = ports;
  return {
    resolveUserQuestion: (answer: AskUserContent) => {
      const pending = get().pendingUserQuestion;
      if (!pending) return;
      if (pending.sessionId !== get().activeSessionId) return;
      runtime.resolve(
        buildAskUserResult(pending.toolCallId, answer, pending.dismissNote),
      );
      set({ pendingUserQuestion: null });
    },

    dismissUserQuestion: () => {
      get().resolveUserQuestion({ answers: [], dismissed: true });
    },

    _cancelPendingUserQuestion: () => {
      const pending = get().pendingUserQuestion;
      if (!pending) return;
      ports.abortTurn();
      runtime.cancel(
        dismissedAskUserResult(pending.toolCallId, pending.dismissNote),
      );
      set({ pendingUserQuestion: null });
    },
  };
}
