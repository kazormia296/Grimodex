import { lazy, Suspense } from "react";
import { useChatStopConfirmStore } from "./chatStopConfirm";

const ChatStopConfirmDialog = lazy(() => import("./ChatStopConfirmDialog"));

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
