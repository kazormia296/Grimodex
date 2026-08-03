let runtimeCompositionPromise: Promise<void> | null = null;
const runtimeCompositionModules = import.meta.glob(
  "./runtimeStoreComposition.ts",
);

/**
 * Load the renderer composition graph only when a Workspace is actually
 * opening. The import is cached so repeated opens share the same registration
 * work, while a failed load can be retried on the next open attempt.
 */
export function ensureRuntimeStoreComposition(): Promise<void> {
  runtimeCompositionPromise ??= (
    runtimeCompositionModules["./runtimeStoreComposition.ts"]?.() ??
    Promise.reject(new Error("Runtime composition module is missing"))
  )
    .then(() => undefined)
    .catch((error: unknown) => {
      runtimeCompositionPromise = null;
      throw error;
    });
  return runtimeCompositionPromise;
}
