import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface HeaderBarLayoutProps {
  /** 左レールの中身（ロゴ・メニュー・履歴・エクスポートなど）。 */
  left: ReactNode;
  /** 中央スロット（Command Center バー）。ウィンドウ幾何中心に固定される。 */
  center: ReactNode;
  /** 右レールの中身（各種ドロップダウン・設定・ウィンドウ操作など）。 */
  right: ReactNode;
  /** macOS の traffic-light 用に左右へ対称な余白を確保する。 */
  mac?: boolean;
  /** header 要素へ追加するクラス（例: screenshot 時の no-screenshot）。 */
  className?: string;
}

/**
 * ヘッダーバーの 3 レール配置。
 *
 * 中央スロット (center) を **ウィンドウ幾何中心**に固定するための土台。
 *
 * 設計の肝:
 * - 左右レールを共に `flex-1 basis-0` にすると、中身の幅に関係なく両レールの
 *   外寸が必ず等しくなる。中央も同じく `flex-1 basis-0` の middle column な
 *   ので、その中心 = ヘッダーの中心 = ウィンドウ中心になる。
 * - 旧実装は「中央だけ flex-1 + justify-center」で、左右ボタン群の*あいだ*の
 *   余白の中央にバーを置いていた。左群 (ロゴ+メニュー+履歴+エクスポート) は
 *   右群より広いため、余白の中心がウィンドウ中心から右へズレていた。
 * - mac の traffic-light 余白は左レールに `pl-20` を入れると中央が +40px ズレる
 *   （padding は flex item の外寸に加算されるため）。対称化のため右レールにも
 *   同量の `pr-20` を入れてレール外寸を揃え、中央を保つ。
 *
 * 中央が真に center であることは browser test
 * (`HeaderBarLayout.browser.test.tsx`) で実寸 assert して gate している。
 */
export function HeaderBarLayout({
  left,
  center,
  right,
  mac,
  className,
}: HeaderBarLayoutProps) {
  return (
    <header
      data-header-bar
      className={cn(
        // py-2: ボタン上下に最低 8px の Tauri drag region 帯を確保する。
        // py-1 (4px) では狭すぎて掴みづらく、CommandCenterBar の opt-out と
        // 相まってウィンドウ移動できない事象が出ていた。
        "flex flex-shrink-0 items-center gap-3 border-b border-border px-4 py-2",
        className,
      )}
      data-tauri-drag-region
    >
      {/* Tauri v2 の data-tauri-drag-region は親→子で必ずしも継承されない
          ため、各レール自身にも明示的に付与する。各レール内の interactive な
          要素 (button/menu) は属性を持たないので通常クリックになり、
          CommandCenterBar は自前で "false" opt-out している。 */}
      <div
        data-tauri-drag-region
        data-header-rail="left"
        className={cn(
          "flex min-w-0 flex-1 basis-0 items-center gap-3",
          mac && "pl-20",
        )}
      >
        {left}
      </div>
      <div
        data-tauri-drag-region
        data-header-center
        className="flex min-w-0 flex-1 basis-0 justify-center px-8"
      >
        {center}
      </div>
      <div
        data-tauri-drag-region
        data-header-rail="right"
        className={cn(
          "flex min-w-0 flex-1 basis-0 items-center justify-end gap-3",
          mac && "pr-20",
        )}
      >
        {right}
      </div>
    </header>
  );
}
