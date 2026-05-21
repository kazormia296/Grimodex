/**
 * Drop target × TrashItem subKind の組み合わせを restorer / 挿入処理に
 * ディスパッチする (設計書 §5-C のマトリクス)。
 *
 * 各パネルの `onDrop` から本ファイルのヘルパを呼び、`trashBinStore.pickup` の
 * `onRestore` コールバックに渡す。restorer が成功したら `pickup` 側で trash
 * から item を消す。
 *
 * 構造アイテム (scene/codex/snippet/sticky/foreshadow/grid-chapter) は元パネルへ
 * 復元、text-fragment は editor 系へのテキスト挿入のみを許可。text-fragment を
 * snippet/sticky に "化けさせる" cross-kind 変換は廃止 (孤児を作って文脈が
 * 失われるため)。
 */
import { toast } from "sonner";
import i18next from "i18next";
import {
  restoreScene,
  restoreCodexEntry,
  restoreSnippet,
  restoreMapSticky,
  restoreForeshadow,
  restoreGridChapter,
} from "./restorers";
import type { RestoreOutcome } from "./restorers";
import type { DropTarget, DropPoint } from "@/store/dropTargetRegistry";
import { getFocusedEditor } from "@/store/focusedContentEditorStore";
import { insertTrashItemIntoEditor } from "./editorInsert";
import type { TrashItemData, TrashSubKind } from "./types";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useMapStore } from "@/features/map/mapStore";
import { useForeshadowStore } from "@/features/foreshadow/foreshadowStore";
import { getCurrentProjectId } from "@/features/project/projectStore";

/**
 * 受け入れ可否判定 (設計書 §5-C のマトリクス)。
 * パネル側の DropTarget.accepts はこの関数を呼ぶ。
 */
export function acceptsMatrix(
  targetKind: DropTarget["kind"],
  subKind: TrashSubKind,
): boolean {
  switch (targetKind) {
    case "scene-editor":
    case "codex-editor":
    case "snippet-editor":
      // エディタ本文はほぼ何でも受け取り (テキスト化して挿入)
      return true;
    case "scenes-panel":
      return subKind === "scene" || subKind === "grid-chapter";
    case "codex-panel":
      return subKind === "codex-entry";
    case "snippets-panel":
      return subKind === "snippet";
    case "map-panel":
      return subKind === "map-sticky";
    case "foreshadow-panel":
      return subKind === "foreshadow";
  }
}

/**
 * パネル側 onDrop から呼ぶ。restorers を呼んで結果を `pickup` 規約に整形する。
 * `dropPoint` はパネル座標系での drop 点 (Map の x/y 反映用)。
 */
export async function dispatchDrop(
  item: TrashItemData,
  target: DropTarget,
  dropPoint: DropPoint,
  projectId: string = getCurrentProjectId(),
): Promise<RestoreOutcome> {
  const { kind } = target;

  // パネル個別の復元 (構造 → 元パネル)
  if (kind === "scenes-panel") {
    if (item.subKind === "scene") {
      return restoreScene(item, { projectId });
    }
    if (item.subKind === "grid-chapter") {
      return restoreGridChapter(item, { projectId });
    }
  }
  if (kind === "codex-panel" && item.subKind === "codex-entry") {
    return restoreCodexEntry(item, { projectId });
  }
  if (kind === "snippets-panel" && item.subKind === "snippet") {
    return restoreSnippet(item, { projectId });
  }
  if (kind === "foreshadow-panel" && item.subKind === "foreshadow") {
    return restoreForeshadow(item, { projectId });
  }
  if (kind === "map-panel" && item.subKind === "map-sticky") {
    return restoreMapSticky(item, {
      // 開いている board に強制的に乗せる: 元 board が消えていたり、
      // 別 board を表示中でも、UI 上のドロップ先と一致させる。
      boardIdOverride: useMapStore.getState().activeBoardId ?? undefined,
      dropX: dropPoint.x,
      dropY: dropPoint.y,
    });
  }

  // text-fragment はパネルへの構造化復元はしない。エディタへの挿入か、
  // Popover のクリップボードコピーで取り出す前提 (設計判断: 文脈の切れた
  // 孤児 snippet/sticky を勝手に作るとどこへ戻ったか分からなくなるため)。

  // エディタ本文へのテキスト挿入 (設計書 §5-C)。
  // ドロップされた pane が保持する Editor を優先し (target.getEditor)、
  // 無ければ focusedContentEditorStore の現在フォーカスエディタにフォールバック。
  if (
    kind === "scene-editor" ||
    kind === "codex-editor" ||
    kind === "snippet-editor"
  ) {
    const editor = target.getEditor?.() ?? getFocusedEditor();
    if (!editor) {
      return {
        ok: false,
        reason: "no-target",
        message: "no editor available",
      };
    }
    const inserted = insertTrashItemIntoEditor(editor, item);
    if (inserted === 0) {
      return {
        ok: false,
        reason: "rejected",
        message: "empty payload",
      };
    }
    // 挿入は副作用。新 ID は発行しないので previewText を識別子として返す。
    return { ok: true, newId: item.id, brokenLinks: [] };
  }

  return {
    ok: false,
    reason: "rejected",
    message: `no handler for ${kind} ← ${item.subKind}`,
  };
}

/**
 * `pickup` のラッパ: dispatchDrop を呼んで失敗時は toast、成功時は brokenLinks
 * を warning として表示。
 */
/**
 * 復元先パネルのストアを更新して即時反映させる。restorer は API を直接叩くだけで
 * Zustand ストアを触らないため、target.kind から該当ストアの reload を発火する。
 * editor 系は TipTap に直接挿入されるのでパネルリロードは不要。
 */
function refreshAfterRestore(target: DropTarget): void {
  switch (target.kind) {
    case "scenes-panel":
      void useTreeStore.getState().loadTree(getCurrentProjectId());
      return;
    case "codex-panel":
      void useCodexStore.getState().loadEntries();
      return;
    case "snippets-panel":
      void useSnippetStore.getState().loadEntries();
      return;
    case "map-panel":
      useMapStore.getState().bumpBoardDataVersion();
      return;
    case "foreshadow-panel":
      void useForeshadowStore.getState().load(getCurrentProjectId());
      return;
    case "scene-editor":
    case "codex-editor":
    case "snippet-editor":
      return;
  }
}

export async function pickupAndDispatch(
  item: TrashItemData,
  target: DropTarget,
  dropPoint: DropPoint,
): Promise<RestoreOutcome> {
  const result = await dispatchDrop(item, target, dropPoint);
  if (result.ok) {
    refreshAfterRestore(target);
  }
  if (!result.ok) {
    toast.error(
      i18next.t("trashBin.pickupFailed", "復元に失敗しました") +
        (result.message ? `: ${result.message}` : ""),
    );
  } else if (result.brokenLinks.length > 0) {
    toast.warning(
      i18next.t(
        "trashBin.brokenLinkWarning",
        "復元しましたが一部のリンクが切れています",
      ) + ` (${result.brokenLinks.join(", ")})`,
    );
  } else {
    toast.success(i18next.t("trashBin.pickupSuccess", "復元しました"));
  }
  return result;
}
