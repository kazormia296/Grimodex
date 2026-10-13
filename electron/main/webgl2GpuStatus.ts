/**
 * `app.getGPUFeatureStatus()` の `webgl2` 値から「WebGL2 が使えないと確定しているか」を判定する。
 *
 * 値の意味（Electron 43 の型定義は各欄を string としか示さないため、Chromium の GPU 機能状態の
 * 意味で判断する）:
 * - `unavailable_off` / `disabled_off`: GPU ハードウェア側が無効（blocklist・`--disable-gpu` 等）。
 *   WebGL2 はハードウェアで使えず、renderer の probe も失敗する。ここだけを「確定」とする。
 * - `*_software`（software 描画のみ）、`enabled*`、`disabled_off_ok`、空文字、未知の値は
 *   「不明」として扱い、renderer は従来どおり probe する（不明を unsupported にしない）。
 *
 * GPU 情報が未確定の起動直後は値が空になり得るため、その場合も不明（= probe）になる。
 */
const WEBGL2_BLOCKED_GPU_STATUSES: ReadonlySet<string> = new Set([
  "unavailable_off",
  "disabled_off",
]);

export function isWebGl2GpuBlocked(status: unknown): boolean {
  if (typeof status !== "object" || status === null) return false;
  const webgl2: unknown = (status as { webgl2?: unknown }).webgl2;
  return typeof webgl2 === "string" && WEBGL2_BLOCKED_GPU_STATUSES.has(webgl2);
}
