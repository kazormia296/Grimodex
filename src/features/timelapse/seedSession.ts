/**
 * 執筆タイムラプス — per-session 初期状態 seed (P0.4, §17)。
 *
 * layout/UI の forward イベント(captureLayout の layout.snapshot)は「変化」しか
 * 残さないため、replay の初期状態が未定義になる。OFF→ON 時の baseline 焼きだけでは
 * 通常起動経路(既に ON のプロジェクトを開く projectStore.loadProject)で初期 UI が
 * 欠落する。そこで **毎セッション開始時**に現在のレイアウトを state_snapshots へ焼く。
 *
 * change_events 本線には append しない(seed が sequence/hashChain を消費して volume を
 * 膨らませ、consumer が seed と実操作を区別する必要が出るため)。anchorSequence は
 * 現在の chain head にし、loadLatestSnapshot(asOfSequence) が seed を起点に拾い、
 * sequence > head の layout イベントを前進適用する。
 *
 * activeScene は editor の doc.step が sceneId を持つため別途 seed 不要(consumer 推論可)。
 * 過去会話の初期表示は P0 では defer(replay は空チャット起点)。
 */

import { useLayoutStore } from "@/features/layout/layoutStore";
import { getCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { recordLayoutSnapshot } from "./snapshots";
import { getRecorderChainHead } from "./recorder";

export async function seedWorkspaceSnapshot(
  projectId: string,
  isAuthoritative: () => boolean = () => true,
): Promise<void> {
  if (!isAuthoritative()) return;
  const workspaceIdentity = getCurrentWorkspaceIdentity();
  if (!workspaceIdentity) return;
  const { layout, activePresetId, hiddenStripePanels } =
    useLayoutStore.getState();
  if (!isAuthoritative()) return;
  await recordLayoutSnapshot({
    expectedWorkspacePath: workspaceIdentity.path,
    projectId,
    expectedAnchorSequence: getRecorderChainHead(),
    // captureLayout の layout.snapshot と同形の payload にし consumer を共通化。
    payload: {
      layout,
      ...(activePresetId ? { activePresetId } : {}),
      ...(hiddenStripePanels.size > 0
        ? { hiddenStripePanels: [...hiddenStripePanels] }
        : {}),
    },
  });
}
