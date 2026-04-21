import type { AxisMode } from "./timelineStore";

export interface AxisLabelInput {
  storyTimeLabel: string | null;
  createdAt: string;
}

export interface AxisLabel {
  index: number;
  label: string;
}

/** ノード密度とズームに応じた間引き間隔を返す */
function thinInterval(count: number, zoom: number): number {
  const effective = count / zoom;
  if (effective <= 10) return 1;
  if (effective <= 20) return 3;
  if (effective <= 40) return 5;
  return 10;
}

function formatDate(isoString: string): string {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return isoString;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 軸ラベル（間引き済み）を計算して返す。
 * 純粋関数なのでテスト可能。
 */
export function computeAxisLabels(
  scenes: AxisLabelInput[],
  axisMode: AxisMode,
  zoom: number,
): AxisLabel[] {
  if (scenes.length === 0) return [];

  const interval = thinInterval(scenes.length, zoom);
  const result: AxisLabel[] = [];

  for (let i = 0; i < scenes.length; i++) {
    if (i % interval !== 0) continue;

    let label: string;
    switch (axisMode) {
      case "story":
        label = scenes[i].storyTimeLabel ?? `T${i + 1}`;
        break;
      case "reading":
        label = `Ch.${i + 1}`;
        break;
      case "write":
        label = formatDate(scenes[i].createdAt);
        break;
    }

    result.push({ index: i, label });
  }

  return result;
}
