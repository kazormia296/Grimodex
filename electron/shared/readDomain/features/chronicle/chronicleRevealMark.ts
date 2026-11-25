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

/** 印の判定に使う、tree の読み。 */
export interface ChronicleRevealView {
  readonly nodes: readonly { readonly id: string; readonly title: string }[];
  readonly currentSceneId: string | null;
  readonly readingOrder: ReadonlyMap<string, number>;
}

/**
 * 出来事の id から、返り値に広げる `{ revealScene }`（印が無ければ `{}`）を引く関数を作る。
 * 開示シーンのある出来事が 1 件も無いときは、`read` を呼ばない（読みを増やさない）。
 */
export function chronicleRevealMarks(
  events: Iterable<{
    readonly id: string;
    readonly revealSceneId: string | null;
  }>,
  read: () => ChronicleRevealView,
): (eventId: string) => { revealScene?: ChronicleRevealMark } {
  const marks = new Map<string, ChronicleRevealMark>();
  let view: ChronicleRevealView | undefined;
  let titles: Map<string, string> | undefined;
  for (const event of events) {
    if (event.revealSceneId == null || event.revealSceneId === "") continue;
    view ??= read();
    titles ??= new Map(view.nodes.map((n) => [n.id, n.title] as const));
    const mark = markChronicleRevealScene(
      event.revealSceneId,
      view.currentSceneId,
      view.readingOrder,
      titles,
    );
    if (mark) marks.set(event.id, mark);
  }
  return (eventId) => {
    const revealScene = marks.get(eventId);
    return revealScene ? { revealScene } : {};
  };
}
