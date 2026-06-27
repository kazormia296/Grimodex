import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trash2, Circle } from "lucide-react";
import { useTrashBinStore } from "./trashBinStore";
import { TrashBinListView } from "./TrashBinListView";
import {
  TrashBinPhysicsView,
  type PhysicsViewHandle,
} from "./TrashBinPhysicsView";
import { TrashBinStirButton } from "./TrashBinStirButton";
import { PanelHeader } from "@/features/layout/PanelHeader";
import { pruneTrashItems } from "./api";
import { useReducedMotion } from "@/lib/animation";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useConfirmDialog } from "./ConfirmDialog";
import { getCurrentProjectId } from "@/features/project/projectStore";

// 設計書 §3.4: 文字屑 50 件 + 構造 50 件 = 物理ビュー最大 100 body
const PHYSICS_DISPLAY_LIMIT = 100;
// セーフティバルブ (10000 text + 500 structure ≒ 10500)
const PRUNE_MAX_COUNT = 10_500;
const DEFAULT_RETENTION_DAYS = 60;
// 「無期限」を表す sentinel 値 (設定 UI でこの値を使う)。
// pruneTrashItems の retentionDays に巨大値を渡せば実質的にスキップできる。
const RETENTION_UNLIMITED = -1;
const RETENTION_UNLIMITED_DAYS = 365_000; // 約 1000 年 → 実質 prune しない
// 1 時間おきのバックグラウンド prune
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

function resolveRetentionDays(): number {
  const raw = useSettingsStore
    .getState()
    .getNumber("trashBin.retentionDays", DEFAULT_RETENTION_DAYS);
  if (raw === RETENTION_UNLIMITED) return RETENTION_UNLIMITED_DAYS;
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_RETENTION_DAYS;
  return raw;
}

export function TrashBinPanel() {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const items = useTrashBinStore((s) => s.items);
  const isCapturing = useTrashBinStore((s) => s.isCapturing);
  const isLoading = useTrashBinStore((s) => s.isLoading);
  const loadItems = useTrashBinStore((s) => s.loadItems);
  const removeItem = useTrashBinStore((s) => s.removeItem);
  const clearAll = useTrashBinStore((s) => s.clearAll);
  const setCapturing = useTrashBinStore((s) => s.setCapturing);

  const physicsHandleRef = useRef<PhysicsViewHandle | null>(null);
  // reduced-motion fallback で「かき混ぜる」= シャッフル順を保持
  const [shuffleSeed, setShuffleSeed] = useState(0);
  const { confirm, dialog: confirmDialog } = useConfirmDialog();

  useEffect(() => {
    // 起動時 prune → loadItems の順 (古い物が残ったまま表示されないように)
    void (async () => {
      try {
        await pruneTrashItems(
          getCurrentProjectId(),
          resolveRetentionDays(),
          PRUNE_MAX_COUNT,
        );
      } catch {
        /* prune 失敗は致命的ではない */
      }
      await loadItems(getCurrentProjectId());
    })();

    // 1 時間おきのバックグラウンド prune (設計書 §3.4)
    // パネル mount 中のみ動作 — フォアグラウンド時のみという要件を満たす。
    const intervalId = setInterval(() => {
      void pruneTrashItems(
        getCurrentProjectId(),
        resolveRetentionDays(),
        PRUNE_MAX_COUNT,
      ).then(() => loadItems(getCurrentProjectId()));
    }, PRUNE_INTERVAL_MS);
    return () => clearInterval(intervalId);
  }, [loadItems]);

  // selector 内で派生配列を生成すると new ref になるため、
  // useMemo で items Map を一度だけ配列化する (`feedback_zustand_selector_new_ref.md`)。
  const sortedItems = useMemo(() => {
    const list = Array.from(items.values()).sort((a, b) =>
      a.deletedAt < b.deletedAt ? 1 : -1,
    );
    if (reducedMotion && shuffleSeed > 0) {
      // Fisher-Yates: 偶然の再発見を残すため shuffle (設計書 §10)
      const arr = [...list];
      let s = shuffleSeed;
      for (let i = arr.length - 1; i > 0; i--) {
        s = (s * 9301 + 49297) % 233280;
        const j = Math.floor((s / 233280) * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }
    return list;
  }, [items, reducedMotion, shuffleSeed]);

  // 物理ビューは 100 body まで (設計書 §3.4)。それ以上はリスト fallback で全件閲覧可能。
  const physicsItems = useMemo(
    () => sortedItems.slice(0, PHYSICS_DISPLAY_LIMIT),
    [sortedItems],
  );

  const handleStir = (intensity: number) => {
    if (reducedMotion) {
      setShuffleSeed((s) => s + Math.floor(intensity));
      return;
    }
    physicsHandleRef.current?.stir(intensity);
  };

  const handleClearAll = async () => {
    if (sortedItems.length === 0) return;
    const ok = await confirm({
      title: t("trashBin.clearAll"),
      description: t("trashBin.clearConfirm"),
      confirmLabel: t("trashBin.clearAll"),
    });
    if (!ok) return;
    void clearAll(getCurrentProjectId());
  };

  const handleRemoveItem = async (id: string) => {
    const ok = await confirm({
      title: t("trashBin.discard"),
      description: t("trashBin.removeConfirm"),
      confirmLabel: t("trashBin.discard"),
    });
    if (!ok) return;
    void removeItem(id);
  };

  return (
    <div className="flex h-full flex-col" aria-label={t("trashBin.title")}>
      {confirmDialog}
      <PanelHeader
        panelId="trash-bin"
        count={t("trashBin.count", { count: sortedItems.length })}
        actions={
          <>
            <TrashBinStirButton
              onStir={handleStir}
              disabled={sortedItems.length === 0}
            />
            <button
              type="button"
              onClick={() => setCapturing(!isCapturing)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted"
              title={t("trashBin.pauseToggle")}
              aria-label={t("trashBin.pauseToggle")}
              aria-pressed={!isCapturing}
            >
              <Circle
                className={`h-2.5 w-2.5 ${
                  isCapturing
                    ? "fill-red-500 text-red-500"
                    : "fill-muted-foreground/40 text-muted-foreground/40"
                }`}
              />
              <span>
                {isCapturing ? t("trashBin.recording") : t("trashBin.paused")}
              </span>
            </button>
            <button
              type="button"
              onClick={handleClearAll}
              disabled={sortedItems.length === 0}
              className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
              title={t("trashBin.clearAll")}
              aria-label={t("trashBin.clearAll")}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        }
      />

      <div className="flex-1 overflow-hidden">
        {reducedMotion ? (
          <div className="h-full overflow-y-auto">
            <TrashBinListView
              items={sortedItems}
              isLoading={isLoading}
              onRemove={handleRemoveItem}
            />
          </div>
        ) : (
          <TrashBinPhysicsView
            items={physicsItems}
            isLoading={isLoading}
            handleRef={physicsHandleRef}
          />
        )}
      </div>
    </div>
  );
}
