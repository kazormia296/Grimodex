import { cn } from "@/lib/utils";
import { useUpdatePending } from "./updaterStore";

/**
 * 保留中の更新があるとき小さなドットを出す常設インジケーター。設定ボタン (⚙) と
 * 設定内の About タブに置き、更新トーストを「後で」で閉じても・見逃しても
 * 更新に気づけるようにする。`useUpdatePending`(=availableVersion) を読むので
 * トーストの表示状態とは独立して残る。
 *
 * 視覚的な合図なので `aria-hidden`。アクセシブルな更新導線は UpdateToast
 * (role=status/aria-live) と About タブの更新ボタンが担う。
 */
export function UpdateDot({ className }: { className?: string }) {
  const pending = useUpdatePending();
  if (!pending) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "block h-2 w-2 rounded-full bg-primary ring-2 ring-background",
        className,
      )}
    />
  );
}
