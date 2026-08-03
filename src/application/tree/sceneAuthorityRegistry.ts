type SceneAuthorityCommitSink = (sceneId: string) => void;

let sceneAuthorityCommitSink: SceneAuthorityCommitSink | null = null;

/**
 * Register the renderer composition sink without importing Chat into Tree.
 * Tree publishes only after its own admission guards have accepted the target.
 */
export function registerSceneAuthorityCommitSink(
  sink: SceneAuthorityCommitSink | null,
): void {
  sceneAuthorityCommitSink = sink;
}

/**
 * Mirror a Tree-owned Scene commit synchronously while the caller still holds
 * any navigation lease. This prevents a new Chat send from observing mixed
 * Tree / Chat authority between a Store update and a passive React effect.
 */
export function publishSceneAuthorityCommit(sceneId: string): void {
  sceneAuthorityCommitSink?.(sceneId);
}
