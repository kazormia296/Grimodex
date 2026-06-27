import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { PANEL_ICON_MAP } from "./panelIcons";
import type { PanelId } from "./panelIds";

type HeaderPanelId = Exclude<PanelId, "editor">;

interface PanelHeaderProps {
  /**
   * パネル ID。アイコンは `PANEL_ICON_MAP[panelId]`(ストライプと同一)、
   * 既定タイトルは i18n `layout.panel.<id>` から解決する。
   */
  panelId: HeaderPanelId;
  /** タイトル上書き。省略時は `layout.panel.<id>`(全パネル定義済み・翻訳済み)。 */
  title?: ReactNode;
  /** タイトル直後に出す軽い補助(件数など)。muted・nowrap。 */
  count?: ReactNode;
  /** タイトル行に差し込む追加の左側内容(警告チップ・トグル等)。 */
  children?: ReactNode;
  /** 右端(ms-auto)に並べる操作群。 */
  actions?: ReactNode;
  /** ヘッダー帯に足すクラス(背景色など、ごく例外的な調整用)。 */
  className?: string;
  /** タイトル span に足すクラス。 */
  titleClassName?: string;
}

/**
 * 全パネル共通のヘッダー帯。**パネルヘッダーの正本(デザインルールの実体)**。
 *
 * 標準:
 * - 高さ `h-8`(32px)/ 横 `px-3` / `text-xs` / `border-b border-border`。
 * - 先頭に `PANEL_ICON_MAP` のアイコン(`size-3.5` opacity-70)→ タイトル(`font-medium`)。
 *   アイコンはサイドストライプと同一なので、ストライプ↔ヘッダーで視覚が一致する。
 * - `data-panel-header` を必ず持つ。これだけで `PanelChromeMenu` 経由の
 *   「ヘッダーのダブルクリックで最大化」「右クリックでコンテキストメニュー
 *   (最大化/折りたたみ/ウィンドウで開く)」が自動で有効になる(配線不要)。
 * - 操作ボタンは `actions` に渡す(`ms-auto` で右寄せ)。ボタン等は
 *   `isPanelChromeGestureTarget` のインタラクティブ判定で dblclick 誤発火しない。
 *
 * 新しいパネルや既存ヘッダーの作り直しは、生 div ではなく本コンポーネントを使う。
 * 詳細は docs/Grimodex_パネルヘッダー設計書.md。
 */
export function PanelHeader({
  panelId,
  title,
  count,
  children,
  actions,
  className,
  titleClassName,
}: PanelHeaderProps) {
  const { t } = useTranslation();
  const Icon = PANEL_ICON_MAP[panelId];
  const resolvedTitle = title ?? t(`layout.panel.${panelId}`);

  return (
    <div
      data-panel-header
      className={cn(
        "flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs",
        className,
      )}
    >
      <Icon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
      <span
        className={cn("truncate font-medium text-foreground", titleClassName)}
      >
        {resolvedTitle}
      </span>
      {count != null && (
        <span className="shrink-0 whitespace-nowrap text-muted-foreground">
          {count}
        </span>
      )}
      {children}
      {actions != null && (
        <div className="ms-auto flex shrink-0 items-center gap-1">
          {actions}
        </div>
      )}
    </div>
  );
}
