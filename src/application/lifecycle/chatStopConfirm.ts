import { create } from "zustand";
import { getActiveTurnStopper } from "@/lib/activeTurnStopRegistry";

export type ChatStopConfirmKind = "close" | "switch";

export interface ChatStopConfirmRequest {
  kind: ChatStopConfirmKind;
  answer: (ok: boolean) => void;
}

export const useChatStopConfirmStore = create<{
  request: ChatStopConfirmRequest | null;
}>(() => ({ request: null }));

let pending: Promise<boolean> | null = null;

/**
 * 終了や切替の前に呼ぶ。生成中の応答が無ければ、同期で true を返す。あれば確認を出し、
 * 了承されたら停止してから true、断られたら false を返す。静止の lease を取る前に呼ぶ。
 */
export function confirmStopActiveTurn(
  kind: ChatStopConfirmKind,
): true | Promise<boolean> {
  // 確認が出ている間は、応答が自然に終わっていても、その確認の扱いに従う。
  if (!pending && !getActiveTurnStopper()?.isActive()) return true;
  const current = useChatStopConfirmStore.getState().request;
  if (pending) {
    // 出ている文面と違う操作には、答えを流用しない。
    return current?.kind === kind ? pending : Promise.resolve(false);
  }
  pending = new Promise<boolean>((resolve) => {
    useChatStopConfirmStore.setState({
      request: {
        kind,
        answer: (ok) => {
          useChatStopConfirmStore.setState({ request: null });
          pending = null;
          const stopper = getActiveTurnStopper();
          if (ok && stopper?.isActive()) stopper.stop();
          resolve(ok);
        },
      },
    });
  });
  return pending;
}
