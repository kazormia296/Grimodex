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

/** X 軸下に描くフォルダ・グルーピング帯の 1 区間。index は表示順シーン配列の位置。 */
export interface FolderGroup {
  startIndex: number;
  endIndex: number;
  id: string;
  label: string;
}

/**
 * 表示順のシーン配列を、各フォルダ深さ(level)ごとの連続レンジにまとめる純関数。
 * level 0 = 最上位フォルダ（部）、深いほど直近（章）寄り。
 * `ancestorsOf` は各シーンの祖先フォルダを **root→直近** の順で返すこと。
 * 同じフォルダ id が連続するシーンを 1 区間に束ね、フォルダが無いシーンで切れる。
 */
export function computeFolderGroups(
  sceneIds: string[],
  ancestorsOf: (sceneId: string) => { id: string; label: string }[],
): FolderGroup[][] {
  const paths = sceneIds.map((id) => ancestorsOf(id));
  const maxDepth = paths.reduce((m, p) => Math.max(m, p.length), 0);
  const levels: FolderGroup[][] = [];
  for (let d = 0; d < maxDepth; d++) {
    const groups: FolderGroup[] = [];
    let cur: FolderGroup | null = null;
    paths.forEach((path, i) => {
      const f = path[d];
      if (f && cur && cur.id === f.id) {
        cur.endIndex = i;
      } else if (f) {
        cur = { startIndex: i, endIndex: i, id: f.id, label: f.label };
        groups.push(cur);
      } else {
        cur = null; // 当該深さにフォルダが無いシーンで区間を切る
      }
    });
    levels.push(groups);
  }
  return levels;
}
