import { useEffect } from "react";
import { useLayoutStore } from "@/features/layout/layoutStore";
import {
  getPanelWindowHandle,
  getPanelWindowTarget,
} from "@/features/layout/multiwindow/panelWindow";
import { useCodexStore } from "../codexStore";
import { emitSelectEntry, onSelectEntry } from "./codexWindowSync";

/**
 * 「Codex でこのエントリを開く」を窓間ルーティングして実行する（要望4）。
 *
 * - 別フローティング Codex 窓が存在する → そちらへ選択を broadcast して focus。
 *   メイン窓では Codex パネルを開かない（メイン窓で勝手に開くと鬱陶しいため）。
 *   メイン窓の Codex パネルが既に開いている場合は self-echo で選択が同期される
 *   （useCodexSelectionSync の listener が isPanelActive を見て適用）。
 * - 別窓が無い → 従来通りメイン窓で Codex パネルを開いて選択。
 */
export async function requestOpenInCodex(entryId: string): Promise<void> {
  const win = await getPanelWindowHandle("codex");
  if (win) {
    await emitSelectEntry(entryId);
    await win.setFocus();
    return;
  }
  useLayoutStore.getState().showPanel("codex");
  useCodexStore.getState().requestSelectEntry(entryId);
}

/**
 * 窓間の Codex 選択連動（要望3）。各窓で 1 回マウントする。
 * codex:select-entry を受けたら:
 * - この窓が Codex 別窓 → 常に選択を反映（別窓は常に Codex を表示）。
 * - メイン窓 → Codex パネルが開いている時だけ反映（閉じている窓を勝手に開かない）。
 * 適用は requestSelectEntry 経由（emit しない）なので echo ループにならない。
 */
export function useCodexSelectionSync(): void {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void onSelectEntry((entryId) => {
      const isCodexWindow = getPanelWindowTarget() === "codex";
      const codexPanelOpen = useLayoutStore.getState().isPanelActive("codex");
      if (isCodexWindow || codexPanelOpen) {
        useCodexStore.getState().requestSelectEntry(entryId);
      }
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}
