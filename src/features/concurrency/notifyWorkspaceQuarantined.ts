import { toast } from "sonner";
import i18next from "@/lib/i18n";
import { isWorkspaceQuarantinedError } from "./workspaceQuarantined";

/** 全 AutoSave・store で共有する 1 つの sticky toast の id。 */
export const WORKSPACE_QUARANTINED_TOAST_ID = "autosave-workspace-quarantined";

/**
 * quarantine の案内（保存できない・内容を控える・再起動が要る）を sticky で
 * 出す。固定 id なので、store と `useAutoSave` が重ねて呼んでも toast は 1 つ。
 */
export function notifyWorkspaceQuarantined(): void {
  toast.error(i18next.t("autoSave.workspaceQuarantined"), {
    id: WORKSPACE_QUARANTINED_TOAST_ID,
    duration: Infinity,
  });
}

/**
 * store の catch 用。error が quarantine の拒否なら、汎用の失敗 toast の代わりに
 * quarantine の案内を出して true を返す（汎用の toast と二重にしない）。
 * quarantine 以外は何もせず false。
 */
export function notifyIfWorkspaceQuarantined(error: unknown): boolean {
  if (!isWorkspaceQuarantinedError(error)) return false;
  notifyWorkspaceQuarantined();
  return true;
}
