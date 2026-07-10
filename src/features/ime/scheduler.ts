import { refreshImeExport } from "./api";

export const IME_EXPORT_DEBOUNCE_MS = 1_500;

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Codex の連続入力を project ごとにまとめ、native 辞書書出しを本流から切り離す。
 * 書出し失敗はオートセーブや AI 書き込みを失敗させない。
 */
export function scheduleImeExportRefresh(projectId: string): void {
  const existing = timers.get(projectId);
  if (existing) clearTimeout(existing);

  timers.set(
    projectId,
    setTimeout(() => {
      timers.delete(projectId);
      void refreshImeExport(projectId).catch(() => {
        // fail-open: IME は付加機能であり、Codex 保存の成否に影響させない。
      });
    }, IME_EXPORT_DEBOUNCE_MS),
  );
}

export function cancelScheduledImeExports(projectId?: string): void {
  if (projectId !== undefined) {
    const timer = timers.get(projectId);
    if (timer) clearTimeout(timer);
    timers.delete(projectId);
    return;
  }
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}
