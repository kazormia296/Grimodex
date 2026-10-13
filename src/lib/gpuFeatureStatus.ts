import { electronBridge, isElectron } from "./shell";

/**
 * GPU blocklist／無効化で WebGL2 が使えないと確定しているかを返す。
 *
 * Electron 以外（Web Editor を含む）と取得失敗は「不明」として false を返し、
 * 呼び出し側は従来どおり実際に probe する。不明を unsupported 扱いにしない。
 */
export async function isWebGl2GpuBlocked(): Promise<boolean> {
  if (!isElectron()) return false;
  try {
    return await electronBridge().getWebGl2GpuBlocked();
  } catch {
    return false;
  }
}
