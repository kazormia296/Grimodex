const sceneTails = new Map<string, Promise<void>>();

/**
 * Serializes Grid Beat aggregate mutations per scene.
 *
 * Every add/edit operation reads its rollback snapshot only after the previous
 * operation settled. A failed first write therefore cannot roll the in-memory
 * aggregate behind a later successful write.
 */
export function runGridBeatMutation<T>(
  sceneId: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const previous = sceneTails.get(sceneId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(mutation);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  sceneTails.set(sceneId, tail);
  void tail.finally(() => {
    if (sceneTails.get(sceneId) === tail) sceneTails.delete(sceneId);
  });
  return run;
}

export function _resetGridBeatMutationQueueForTests(): void {
  sceneTails.clear();
}
