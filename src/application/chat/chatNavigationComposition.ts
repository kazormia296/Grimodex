import type { ChatState } from "./chatStoreTypes";
import { isChatAuthorityMutationBlocked } from "./chatScopeStoreActions";
import {
  setChatNavigationBlocker,
  setChatSceneTransitionBlocker,
} from "@/lib/chatNavigationGuard";
import { registerSceneAuthorityCommitSink } from "@/application/tree/sceneAuthorityRegistry";

type ChatNavigationState = Pick<
  ChatState,
  "agentMode" | "isStreaming" | "setActiveSceneId"
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
}
