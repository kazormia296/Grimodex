import { useForeshadowNavStore } from "./foreshadowNavStore";
import { openEditorDocument } from "@/application/editor/openEditorDocument";
import { defaultEditorNavigationPorts } from "@/application/editor/defaultEditorNavigation";

/**
 * 伏線パネル / レーダーから本文へのジャンプ要求の正本。
 *
 * fromPos/toPos を渡すと該当範囲を選択する (Setup/Payoff マーカーへ移動)。
 * 位置が無い場合 (例: レーダーから setup シーンを開くだけ) はシーンを開くのみ。
 *
 * 順序が重要: 先に pendingJump を立ててから setActiveScene → showPanel を呼ぶ。
 * 別シーンへ切り替える場合でも EditorPane.switchScene が同じマイクロタスク内で
 * consumeJump できる順序を保証する。
 */
export function requestForeshadowJump(
  sceneId: string,
  fromPos?: number,
  toPos?: number,
): void {
  if (typeof fromPos === "number" && typeof toPos === "number") {
    useForeshadowNavStore.getState().requestJump({ sceneId, fromPos, toPos });
  }
  openEditorDocument(
    {
      target: { kind: "scene", documentId: sceneId },
      mode: "pinned",
      revealEditor: true,
      focusEditor: false,
      syncSceneContext: true,
    },
    defaultEditorNavigationPorts,
  );
}
