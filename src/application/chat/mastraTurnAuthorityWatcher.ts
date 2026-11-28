import { subscribeQuiescenceLease } from "@/application/lifecycle/quiescenceLease";
import { useLicenseStore } from "@/features/license/store";
import { useProjectStore } from "@/features/project/projectStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { subscribeCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import type { SubscribeChatState } from "./chatStoreActionPorts";

/** Called only by a Mastra turn. Its captured authority decides whether to stop. */
export function watchMastraTurnAuthority(
  check: () => void,
  subscribeChat: SubscribeChatState,
): () => void {
  const unsubscribe = [
    subscribeCurrentWorkspaceIdentity(check),
    subscribeQuiescenceLease(({ active }) => {
      if (active) check();
    }),
    subscribeChat((state, previous) => {
      if (state.activeProjectId !== previous.activeProjectId) check();
    }),
    useTreeStore.subscribe((state, previous) => {
      if (state.projectId !== previous.projectId) check();
    }),
    useProjectStore.subscribe(check),
    useLicenseStore.subscribe(check),
  ];
  return () => {
    for (const stop of unsubscribe) stop();
  };
}
