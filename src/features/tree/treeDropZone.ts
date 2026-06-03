/**
 * Scenes ツリーの drop ゾーン判定（純ロジック）。
 * pointer の Y を over 矩形に対する相対位置に変換し、before/after/inside を返す。
 * container(folder) は上 25% = before / 下 25% = after / 中央 50% = inside、
 * leaf(scene) は中点で before/after の 2 分割。
 *
 * useScenesDnd の onDragEnd / onDragOver で二重定義されていたものを集約・テスト可能化。
 * over.rect は dnd-kit が渡す値で getBoundingClientRect を直接呼ばないため happy-dom で検証可能。
 */
export type TreeDropPosition = "before" | "after" | "inside";

export function resolveTreeDropZone(
  pointerY: number,
  overRect: { top: number; height: number },
  isContainer: boolean,
): TreeDropPosition {
  const relY = pointerY - overRect.top;
  const h = overRect.height;
  if (isContainer) {
    if (relY < h * 0.25) return "before";
    if (relY > h * 0.75) return "after";
    return "inside";
  }
  return relY < h / 2 ? "before" : "after";
}
