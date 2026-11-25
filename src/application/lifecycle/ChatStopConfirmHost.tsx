import { lazy, Suspense, useEffect, type ComponentType } from "react";
import { debugLog, errorDetail } from "@/lib/debugLog";
import {
  useChatStopConfirmStore,
  type ChatStopConfirmRequest,
} from "./chatStopConfirm";

/** 画面を読み込めないときは「断る」で答える（終了や切替を固めない）。 */
function DeclineOnLoadFailure({ answer }: ChatStopConfirmRequest) {
  useEffect(() => answer(false), [answer]);
  return null;
}

const ChatStopConfirmDialog = lazy<ComponentType<ChatStopConfirmRequest>>(() =>
  import("./ChatStopConfirmDialog").catch((error: unknown) => {
    debugLog.error(
      "lifecycle",
      "failed to load the stop confirmation",
      errorDetail(error),
    );
    return { default: DeclineOnLoadFailure };
  }),
);

/** 窓ごとに 1 つ置く。確認の要求があるときだけ、画面を読み込んで出す。 */
export function ChatStopConfirmHost() {
  const request = useChatStopConfirmStore((state) => state.request);
  if (!request) return null;
  return (
    <Suspense fallback={null}>
      <ChatStopConfirmDialog {...request} />
    </Suspense>
  );
}
