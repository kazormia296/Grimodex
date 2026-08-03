import { isElectron } from "@/lib/shell";
import { invoke } from "@/lib/tauri";

export interface MozkeyInstallResult {
  version: string;
  assetName: string;
}

export function canInstallMozkeyFromApp(): boolean {
  return isElectron();
}

export function downloadAndInstallMozkey(): Promise<MozkeyInstallResult> {
  return invoke<MozkeyInstallResult>("mozkey_download_and_install");
}
