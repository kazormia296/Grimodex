/** 年表の出来事に添える、読者への開示シーン。 */
export interface ChronicleRevealMark {
  readonly id: string;
  readonly title: string;
  readonly revealedToReader?: boolean;
}

/** 開示シーンを、今開いている場面から見た印にする。 */
export function markChronicleRevealScene(
  revealSceneId: string | null,
  currentSceneId: string | null,
  readingOrder: ReadonlyMap<string, number>,
  titleByScene: ReadonlyMap<string, string>,
): ChronicleRevealMark | null {
  if (
    revealSceneId === null ||
    revealSceneId === "" ||
    !readingOrder.has(revealSceneId)
  )
    return null;

  const mark = {
    id: revealSceneId,
    title: titleByScene.get(revealSceneId)!,
  };
  if (currentSceneId === null || !readingOrder.has(currentSceneId)) return mark;

  return {
    ...mark,
    revealedToReader:
      readingOrder.get(currentSceneId)! >= readingOrder.get(revealSceneId)!,
  };
}
