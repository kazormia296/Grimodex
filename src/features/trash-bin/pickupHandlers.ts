/**
 * Drop target × TrashItem subKind の組み合わせを restorer / 挿入処理に
 * ディスパッチする (設計書 §5-C のマトリクス)。
 *
 * 各パネルの `onDrop` から本ファイルのヘルパを呼び、`trashBinStore.pickup` の
 * `onRestore` コールバックに渡す。restorer が成功したら `pickup` 側で trash
 * から item を消す。
 *
 * Phase 6 では構造アイテム → 自パネル復元のみ完全対応。文字屑のエディタ挿入と
 * cross-kind 変換 (text → snippet 等) は同マトリクスで分岐する。
 */
import { toast } from "sonner";
import i18next from "i18next";
import {
  restoreScene,
  restoreCodexEntry,
  restoreSnippet,
  restoreMapSticky,
  restoreForeshadow,
  restorePin,
  restoreGridChapter,
} from "./restorers";
import type { RestoreOutcome } from "./restorers";
import type { DropTarget, DropPoint } from "@/store/dropTargetRegistry";
import { getFocusedEditor } from "@/store/focusedContentEditorStore";
import { insertTrashItemIntoEditor } from "./editorInsert";
import type { TextFragmentPayload, TrashItemData, TrashSubKind } from "./types";

const DEFAULT_PROJECT_ID = "default-project";

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
      return subKind === "snippet" || subKind === "text-fragment";
    case "map-panel":
      return (
        subKind === "map-sticky" ||
        subKind === "text-fragment" ||
        subKind === "codex-entry"
      );
    case "foreshadow-panel":
      return subKind === "foreshadow";
    case "pin-panel":
      return subKind === "pin";
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
  projectId: string = DEFAULT_PROJECT_ID,
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
  if (kind === "pin-panel" && item.subKind === "pin") {
    return restorePin(item);
  }
  if (kind === "map-panel" && item.subKind === "map-sticky") {
    return restoreMapSticky(item, {
      dropX: dropPoint.x,
      dropY: dropPoint.y,
    });
  }

  // Cross-kind 変換: text-fragment → snippet (Snippets パネル)
  if (kind === "snippets-panel" && item.subKind === "text-fragment") {
    const payload = item.payload as TextFragmentPayload;
    const synthetic: TrashItemData = {
      ...item,
      subKind: "snippet",
      payload: {
        originalId: item.id,
        title: item.previewText.slice(0, 40),
        body: JSON.stringify({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: payload.text
                ? [{ type: "text", text: payload.text }]
                : [],
            },
          ],
        }),
        tags: null,
        contentSource: "trash-bin",
        sceneId: null,
      },
    };
    return restoreSnippet(synthetic, { projectId });
  }

  // Cross-kind 変換: text-fragment → map-sticky (Map ペイン)
  if (kind === "map-panel" && item.subKind === "text-fragment") {
    const payload = item.payload as TextFragmentPayload;
    const synthetic: TrashItemData = {
      ...item,
      subKind: "map-sticky",
      payload: {
        originalId: item.id,
        boardId: "",
        title: null,
        body: JSON.stringify({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: payload.text
                ? [{ type: "text", text: payload.text }]
                : [],
            },
          ],
        }),
        previewText: payload.text.slice(0, 60),
        paletteId: "post-it-playful",
        colorSlot: 0,
        x: dropPoint.x,
        y: dropPoint.y,
        pinned: false,
        zIndex: 0,
      },
    };
    return restoreMapSticky(synthetic, {
      dropX: dropPoint.x,
      dropY: dropPoint.y,
    });
  }

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
export async function pickupAndDispatch(
  item: TrashItemData,
  target: DropTarget,
  dropPoint: DropPoint,
): Promise<RestoreOutcome> {
  const result = await dispatchDrop(item, target, dropPoint);
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
