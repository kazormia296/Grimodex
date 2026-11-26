import type { ChatState } from "./chatStoreTypes";
import { isChatAuthorityMutationBlocked } from "./chatScopeStoreActions";
import {
  setChatNavigationBlocker,
  setChatSceneTransitionBlocker,
} from "@/lib/chatNavigationGuard";
import { registerSceneAuthorityCommitSink } from "@/application/tree/sceneAuthorityRegistry";
import { registerActiveTurnStopper } from "@/lib/activeTurnStopRegistry";

type ChatNavigationState = Pick<
  ChatState,
  "agentMode" | "isStreaming" | "setActiveSceneId" | "stopGeneration"
>;

export function installChatNavigationBlockers(input: {
  getState: () => ChatNavigationState;
  hasPendingPersistence: () => boolean;
  activeTurnSurface: () => "chat" | "agent" | null;
}): void {
  setChatNavigationBlocker(() => {
    const state = input.getState();
    return isChatAuthorityMutationBlocked({
      isStreaming: state.isStreaming,
      hasPendingCompletedTurnPersistence: input.hasPendingPersistence(),
    });
  });
  setChatSceneTransitionBlocker(() => {
    const state = input.getState();
    const activeTurnSurface = input.activeTurnSurface();
    return (
      input.hasPendingPersistence() ||
      (state.isStreaming &&
        (activeTurnSurface === "agent" ||
          (activeTurnSurface === null && state.agentMode)))
    );
  });
  registerSceneAuthorityCommitSink((sceneId) => {
    input.getState().setActiveSceneId(sceneId);
  });
  // 終了や切替の前の確認（chatStopConfirm）が使う。
  registerActiveTurnStopper({
    isActive: () => input.getState().isStreaming,
    stop: () => input.getState().stopGeneration(),
  });
}
