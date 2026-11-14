import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CodexStructureFoldedDismissedSurface } from "./codexStructureExtractionStore";

const FOLDED_DISPLAY_LIMIT = 10;

export interface CodexStructureFoldedDismissalsProps {
  /** 候補画面で見送り済みのため畳んだ表記（live の診断）。 */
  readonly surfaces?: readonly CodexStructureFoldedDismissedSurface[];
  /** 見送りの記録を読めず、畳まずに全件を出した run。 */
  readonly unavailable?: boolean;
  /**
   * 見送りを外す。候補画面の却下の状態の入口を通す（構造抽出の側から直接保存しない）。
   * 渡されないときは戻す操作を出さない。
   */
  readonly onRestore?: (keys: readonly string[]) => void;
}

/**
 * 打ち手 3：候補画面で見送った表記を構造抽出で畳んだことを見せ、戻せるようにする。
 * 戻した表記は、この run の提案には戻らない（次の抽出から出る）。
 */
export function CodexStructureFoldedDismissals({
  surfaces = [],
  unavailable = false,
  onRestore,
}: CodexStructureFoldedDismissalsProps) {
  const { t } = useTranslation();
  const [restored, setRestored] = useState<ReadonlySet<string>>(new Set());

  // 同じキーは 1 種にまとめる（出現の数ではなく表記の種類）。
  const unique: CodexStructureFoldedDismissedSurface[] = [];
  const seen = new Set<string>();
  for (const item of surfaces) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    unique.push(item);
  }

  if (unavailable) {
    return (
      <p
        className="text-[11px] text-amber-800 dark:text-amber-300"
        data-testid="codex-structure-folded-dismissed-unavailable"
      >
        {t("codex.structureReview.foldedDismissed.unavailable")}
      </p>
    );
  }
  if (unique.length === 0) return null;

  const pending = unique.filter((item) => !restored.has(item.key));
  const restore = (keys: readonly string[]) => {
    if (!onRestore || keys.length === 0) return;
    onRestore(keys);
    setRestored((prev) => new Set([...prev, ...keys]));
  };

  return (
    <div
      className="flex flex-col gap-1 rounded border border-border/60 px-2 py-1.5 text-[11px] text-muted-foreground"
      data-testid="codex-structure-folded-dismissed"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>
          {t("codex.structureReview.foldedDismissed.summary", {
            count: unique.length,
          })}
        </span>
        {onRestore && pending.length > 0 && unique.length > 1 && (
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-primary hover:bg-accent"
            onClick={() => restore(pending.map((item) => item.key))}
            data-testid="codex-structure-folded-dismissed-restore-all"
          >
            {t("codex.structureReview.foldedDismissed.restoreAll")}
          </button>
        )}
      </div>
      <ul className="flex flex-wrap gap-1">
        {unique.slice(0, FOLDED_DISPLAY_LIMIT).map((item) => {
          const isRestored = restored.has(item.key);
          return (
            <li
              key={item.key}
              className="flex items-center gap-1 rounded bg-muted/40 px-1.5 py-0.5"
              data-testid="codex-structure-folded-dismissed-item"
            >
              <span>「{item.surface}」</span>
              {isRestored ? (
                <span className="text-[10px]">
                  {t("codex.structureReview.foldedDismissed.restored")}
                </span>
              ) : (
                onRestore && (
                  <button
                    type="button"
                    className="rounded px-1 text-primary hover:bg-accent"
                    onClick={() => restore([item.key])}
                    data-testid="codex-structure-folded-dismissed-restore"
                  >
                    {t("codex.structureReview.foldedDismissed.restore")}
                  </button>
                )
              )}
            </li>
          );
        })}
        {unique.length > FOLDED_DISPLAY_LIMIT && (
          <li className="px-1 py-0.5">
            {t("codex.structureReview.foldedDismissed.more", {
              count: unique.length - FOLDED_DISPLAY_LIMIT,
            })}
          </li>
        )}
      </ul>
    </div>
  );
}
