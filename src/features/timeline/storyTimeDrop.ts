import { generateKeyBetween } from "fractional-indexing";
import i18next from "@/lib/i18n";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  useGlobalHistoryStore,
  type HistoryCollector,
} from "@/store/globalHistoryStore";

export interface StoryTimeWrite {
  id: string;
  order: string;
}

/**
 * 同じ作中時間の値を持つ場面の間に落としたときの書き込みを決める。
 *
 * 同じ値の間には値を作れないので、落とした位置より後ろの同値の場面を
 * まとめて 1 つ後ろの値へ振り直す（振り直した場面どうしは同じ値のまま）。
 * 戻り値は書く順。後ろの場面から書き、落とした場面を最後にするので、途中で
 * 止まっても他の場面どうしの順番は変わらない。順番が変わらない落とし込みは
 * 何も書かない。
 * 値を作れない（読めない値がある）場合は例外を投げる。
 *
 * @param scheduled 作中時間が入っている場面（表示順。落とす場面も含む）
 * @param nextSceneId 落とした位置の直後の場面
 */
export function planTiedStoryTimeDrop(
  scheduled: readonly { id: string; storyTimeOrder: string | null }[],
  movedId: string,
  nextSceneId: string,
): StoryTimeWrite[] {
  const others = scheduled.filter((scene) => scene.id !== movedId);
  const insertIndex = others.findIndex((scene) => scene.id === nextSceneId);
  const tied = others[insertIndex]?.storyTimeOrder;
  if (!tied) return [];
  if (scheduled.findIndex((scene) => scene.id === movedId) === insertIndex) {
    return [];
  }
  let end = insertIndex;
  while (others[end]?.storyTimeOrder === tied) end += 1;
  // 上限は落とす場面の今の値も含めて取る。除くと、途中で止まったときに
  // 振り直した場面が、まだ動いていない落とす場面を追い越す。
  const upper =
    scheduled.find(
      (scene) => scene.storyTimeOrder !== null && scene.storyTimeOrder > tied,
    )?.storyTimeOrder ?? null;
  const movedOrder = generateKeyBetween(tied, upper);
  const shiftedOrder = generateKeyBetween(movedOrder, upper);
  const shifted = others
    .slice(insertIndex, end)
    .reverse()
    .map((scene) => ({ id: scene.id, order: shiftedOrder }));
  return [...shifted, { id: movedId, order: movedOrder }];
}

/**
 * 書き込みを順に保存する。2 件以上は「元に戻す」1 回で戻る 1 つの履歴にする。
 * 途中で失敗したら残りは書かず、済んだ分を履歴に残してから失敗を投げる。
 */
export async function applyStoryTimeWrites(
  writes: readonly StoryTimeWrite[],
  updateStoryTime: (
    id: string,
    order: string,
    label?: string,
    history?: HistoryCollector,
  ) => Promise<void>,
): Promise<void> {
  const dropped = writes[writes.length - 1];
  if (!dropped) return;
  if (writes.length === 1) {
    await updateStoryTime(dropped.id, dropped.order);
    return;
  }
  let failure: { error: unknown } | undefined;
  await useGlobalHistoryStore.getState().runAsTransaction(
    {
      kind: "scenes",
      label: i18next.t("tree.undo.storyTimeChanged"),
      entityId: dropped.id,
      // 保存の途中で作品が切り替わったら、前の作品の履歴を積まない。
      shouldCommit: () =>
        useTreeStore.getState().nodes.some((node) => node.id === dropped.id),
    },
    async (history) => {
      try {
        for (const write of writes) {
          await updateStoryTime(write.id, write.order, undefined, history);
        }
      } catch (error) {
        // ここで投げると、済んだ書き込みの履歴ごと捨てられる。
        failure = { error };
      }
    },
  );
  if (failure) throw failure.error;
}
