import { create } from "zustand";

/**
 * renderer の全状態を作り直す reload（復元の後など）を、GPU で合成する面
 * （エディタ背景の WebGL canvas）が display から外れてから行う。
 *
 * 機構: WebGL canvas の drawing buffer は GPU process の shared image で、
 * display compositor は renderer から受け取った frame の中でその mailbox を
 * 参照して描く。document を破棄すると WebGL context と共に shared image も
 * 消えるが、canvas を外した frame を display がまだ描いていなければ、display は
 * 消えた mailbox を描こうとして `SharedImageManager::ProduceSkia: ... from a
 * non-existent mailbox` を出す。復元では `beginWorkspaceSwitch()` で editor が
 * unmount され、その数 ms 後に reload していたため、この競合が起きていた
 * （Linux Xvfb + SwiftShader の product journey で 13/20）。
 *
 * ここでは (1) まだ mount されている WebGL の面を外し、(2) 数 frame 待って
 * canvas を含まない frame が display に描かれてから reload する。
 */
interface RendererReloadState {
  /** true の間、WebGL の面は描かず静的な代替を出す（reload まで戻らない）。 */
  gpuSurfacesReleased: boolean;
}

export const useRendererReloadStore = create<RendererReloadState>(() => ({
  gpuSurfacesReleased: false,
}));

/** canvas を外した frame が display に描かれるまで待つ animation frame の数。 */
export const RENDERER_RELOAD_RELEASE_FRAMES = 3;
/**
 * 待ちの上限。非表示の window では rAF が止まる（その間 display も描かない）。
 * software GL では 3 frame に 0.6 秒前後かかるので、それより十分長くする。
 */
export const RENDERER_RELOAD_RELEASE_TIMEOUT_MS = 2000;

interface ReloadRendererOptions {
  view?: Pick<
    Window,
    "requestAnimationFrame" | "setTimeout" | "clearTimeout" | "location"
  >;
  frames?: number;
  timeoutMs?: number;
}

/**
 * GPU の面を外し、canvas を含まない frame が描かれるのを待ってから reload する。
 */
export function reloadRendererAfterReleasingGpuSurfaces({
  view = window,
  frames = RENDERER_RELOAD_RELEASE_FRAMES,
  timeoutMs = RENDERER_RELOAD_RELEASE_TIMEOUT_MS,
}: ReloadRendererOptions = {}): Promise<void> {
  useRendererReloadStore.setState({ gpuSurfacesReleased: true });
  return new Promise<void>((resolve) => {
    let settled = false;
    let remaining = Math.max(0, frames);
    const finish = () => {
      if (settled) return;
      settled = true;
      view.clearTimeout(timer);
      view.location.reload();
      resolve();
    };
    const timer = view.setTimeout(finish, timeoutMs);
    const step = () => {
      if (settled) return;
      if (remaining === 0) {
        finish();
        return;
      }
      remaining -= 1;
      view.requestAnimationFrame(step);
    };
    step();
  });
}
