type WorkLayerLiveEnv = Pick<ImportMetaEnv, "VITE_WORK_LAYER_LIVE">;

export function isWorkLayerLiveEnabled(
  env: WorkLayerLiveEnv = import.meta.env,
): boolean {
  return (
    env.VITE_WORK_LAYER_LIVE === "true" || env.VITE_WORK_LAYER_LIVE === "1"
  );
}
