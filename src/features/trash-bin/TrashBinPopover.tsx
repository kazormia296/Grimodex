/**
 * 設計書 §5-D / §10: 物理 body をクリック / リスト fallback で開くプレビュー Popover。
 *
 * Phase 6 では reduced-motion fallback (TrashBinListView) からの「拾い上げ」を
 * 提供する。物理ビューからの呼び出しは Phase 6 末に追加可能 (今は drag のみ)。
 *
 * 機能:
 *  - previewText / origin / brokenLink ヒントの表示
 *  - 受け入れ可能な drop target をセレクタとして列挙
 *  - 「拾い上げる」ボタン → 選択された target で pickup を呼ぶ
 *  - 「完全に削除」ボタン → 確認モーダル + removeItem
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Trash2, Copy } from "lucide-react";
import { toast } from "sonner";
import { useTrashBinStore } from "./trashBinStore";
import { useDropTargetRegistry } from "@/store/dropTargetRegistry";
import { acceptsMatrix, pickupAndDispatch } from "./pickupHandlers";
import { useConfirmDialog } from "./ConfirmDialog";
import { copyWithAttribution } from "@/lib/clipboardAttribution";
import type { TextFragmentPayload, TrashItemData } from "./types";

interface Props {
  item: TrashItemData;
  children: React.ReactNode;
  /** 制御モード: 物理ビューから空 trigger + 任意座標で開きたいとき。 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 制御モード時のアンカー点 (client 座標)。trigger 不要で位置だけ決める。 */
  anchorPoint?: { x: number; y: number };
}

export function TrashBinPopover({
  item,
  children,
  open,
  onOpenChange,
  anchorPoint,
}: Props) {
  const { t } = useTranslation();
  const targets = useDropTargetRegistry((s) => s.targets);
  const removeItem = useTrashBinStore((s) => s.removeItem);
  const pickup = useTrashBinStore((s) => s.pickup);
  const { confirm, dialog: confirmDialog } = useConfirmDialog();

  const acceptingTargets = useMemo(() => {
    return Array.from(targets.values()).filter((tgt) =>
      acceptsMatrix(tgt.kind, item.subKind),
    );
  }, [targets, item.subKind]);

  const [selectedId, setSelectedId] = useState<string>(
    () => acceptingTargets[0]?.id ?? "",
  );

  const handlePickup = async () => {
    const target = acceptingTargets.find((tgt) => tgt.id === selectedId);
    if (!target) return;
    const rect = target.rect();
    const center = rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : { x: 0, y: 0 };
    await pickup(item.id, () => pickupAndDispatch(item, target, center));
  };

  const handleCopy = async () => {
    if (item.subKind === "text-fragment") {
      const payload = item.payload as TextFragmentPayload;
      const text = payload.text ?? item.previewText;
      if (!text) return;
      // spans の source が単一なら其れを、混在なら "unknown" を伝搬する。
      // (paste Case 1 は単一 source 前提。per-span 復元は pickup 経路が担保。)
      // 素の writeText だと paste 時 Case 3 で常に "unknown" 化していた。
      const sources = new Set(
        payload.spans.filter((s) => s.text.length > 0).map((s) => s.source),
      );
      const source = sources.size === 1 ? [...sources][0] : "unknown";
      try {
        await copyWithAttribution(text, source);
        toast.success(t("trashBin.copied", "コピーしました"));
      } catch {
        toast.error(t("trashBin.copyFailed", "コピーに失敗しました"));
      }
      return;
    }
    // 構造アイテムは previewText (帰属概念なし) をプレーンコピー。
    const text = item.previewText;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t("trashBin.copied", "コピーしました"));
    } catch {
      toast.error(t("trashBin.copyFailed", "コピーに失敗しました"));
    }
  };

  const handleDelete = async () => {
    const ok = await confirm({
      title: t("trashBin.discard"),
      description: t("trashBin.removeConfirm"),
      confirmLabel: t("trashBin.discard"),
    });
    if (!ok) return;
    void removeItem(item.id);
  };

  // 制御モードでは anchorPoint をスタイルに使う「見えない trigger」を絶対配置する
  const controlledTrigger = anchorPoint ? (
    <span
      style={{
        position: "fixed",
        left: anchorPoint.x,
        top: anchorPoint.y,
        width: 1,
        height: 1,
        pointerEvents: "none",
      }}
      aria-hidden
    />
  ) : null;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {confirmDialog}
      <PopoverTrigger asChild>{controlledTrigger ?? children}</PopoverTrigger>
      <PopoverContent className="w-72 space-y-2 p-3 text-sm">
        <div className="font-semibold">
          {item.previewText || t("common.untitled")}
        </div>
        <div className="text-xs text-muted-foreground">
          {t(`trashBin.kind.${kindKey(item.subKind)}`)}
        </div>

        {acceptingTargets.length === 0 ? (
          <div className="rounded bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
            {t("trashBin.noDropTarget", "拾い上げ先が開いていません")}
          </div>
        ) : (
          <div className="space-y-1.5">
            <label className="block text-xs text-muted-foreground">
              {t("trashBin.pickupTo", "拾い上げ先")}
            </label>
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className="w-full rounded border border-input bg-background px-2 py-1 text-xs"
            >
              {acceptingTargets.map((tgt) => (
                <option key={tgt.id} value={tgt.id}>
                  {t(`trashBin.dropTarget.${dropKey(tgt.kind)}`, tgt.kind)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handlePickup}
              className="w-full rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t("trashBin.pickup")}
            </button>
          </div>
        )}

        {item.subKind === "text-fragment" ? (
          <button
            type="button"
            onClick={handleCopy}
            className="flex w-full items-center justify-center gap-1 rounded border border-input px-2 py-1 text-xs hover:bg-accent"
          >
            <Copy className="h-3 w-3" />
            {t("trashBin.copyToClipboard", "クリップボードにコピー")}
          </button>
        ) : null}

        <button
          type="button"
          onClick={handleDelete}
          className="flex w-full items-center justify-center gap-1 rounded border border-destructive/30 px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="h-3 w-3" />
          {t("trashBin.discard")}
        </button>
      </PopoverContent>
    </Popover>
  );
}

function kindKey(subKind: string): string {
  switch (subKind) {
    case "text-fragment":
      return "textFragment";
    case "codex-entry":
      return "codex";
    case "map-sticky":
      return "mapSticky";
    case "grid-chapter":
      return "gridChapter";
    default:
      return subKind;
  }
}

function dropKey(kind: string): string {
  switch (kind) {
    case "scene-editor":
    case "codex-editor":
    case "snippet-editor":
      return "editor";
    case "scenes-panel":
      return "scenes";
    case "codex-panel":
      return "codex";
    case "snippets-panel":
      return "snippets";
    case "map-panel":
      return "map";
    case "foreshadow-panel":
      return "foreshadow";
    default:
      return kind;
  }
}
