/**
 * preload（sandbox:true / contextIsolation:true）。
 *
 * Phase 2 S3 では shell 識別子のみ公開する骨格。
 * invoke / listen / emit / windowControls などのフル API は S4 以降で実装する
 * （設計書 §5.4 の GrimodexBridge 契約）。
 */
import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("grimodex", {
  shell: "electron",
});
