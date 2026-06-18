import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Check, X, Target } from "lucide-react";
import { useSettingNumber } from "@/features/settings/useSettingControl";
import { computeGoalProgress } from "./deriveStats";

interface DailyGoalProgressProps {
  /** 本日の挿入文字数（best-effort）。 */
  todayChars: number;
  /** 字数復元が成立しているか。false なら字数ベースの進捗は不正確。 */
  hasCharData: boolean;
}

/**
 * 本日の執筆量を「一日の目標文字数」に対する進捗として表示する。
 *
 * 目標は二段構成：プロジェクト固有値 (`goal.dailyChars`) が 0 ならグローバル
 * 既定 (`goal.dailyDefaultChars`) にフォールバックする。インライン編集はこの
 * プロジェクトの値だけを書き換える（0 を保存すると既定に戻る）。
 */
export function DailyGoalProgress({
  todayChars,
  hasCharData,
}: DailyGoalProgressProps) {
  const { t } = useTranslation();
  const { value: projectGoal, setValue: setProjectGoal } = useSettingNumber(
    "goal.dailyChars",
    0,
  );
  const { value: defaultGoal } = useSettingNumber("goal.dailyDefaultChars", 0);

  const effectiveGoal = projectGoal > 0 ? projectGoal : defaultGoal;
  const usingDefault = projectGoal <= 0 && defaultGoal > 0;
  const progress = computeGoalProgress(todayChars, effectiveGoal);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // 編集開始時に入力欄へフォーカス（autoFocus 属性は a11y lint で禁止のため）。
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function startEdit() {
    setDraft(projectGoal > 0 ? String(projectGoal) : "");
    setEditing(true);
  }
  function commit() {
    const v = parseInt(draft, 10);
    setProjectGoal(Number.isNaN(v) || v < 0 ? 0 : v);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="rounded border border-border bg-card px-2.5 py-2">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t("writingStats.dailyGoal.title")}
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          <input
            ref={inputRef}
            type="number"
            min={0}
            step={100}
            value={draft}
            placeholder={
              defaultGoal > 0
                ? String(defaultGoal)
                : t("writingStats.dailyGoal.placeholder")
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") setEditing(false);
            }}
            className="w-24 rounded border border-input bg-background px-2 py-1 text-right text-sm tabular-nums focus:outline-none"
            data-testid="daily-goal-input"
          />
          <span className="text-xs text-muted-foreground">
            {t("writingStats.charsUnit")}
          </span>
          <button
            type="button"
            onClick={commit}
            title={t("writingStats.dailyGoal.save")}
            className="rounded p-1 text-muted-foreground hover:bg-accent"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            title={t("writingStats.dailyGoal.cancel")}
            className="rounded p-1 text-muted-foreground hover:bg-accent"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {defaultGoal > 0 && (
          <div className="mt-1 text-[10px] text-muted-foreground">
            {t("writingStats.dailyGoal.clearHint")}
          </div>
        )}
      </div>
    );
  }

  if (!progress.hasGoal) {
    return (
      <button
        type="button"
        onClick={startEdit}
        className="flex items-center gap-1.5 self-start rounded border border-dashed border-border px-2.5 py-2 text-xs text-muted-foreground hover:bg-accent"
        data-testid="daily-goal-set"
      >
        <Target className="h-3.5 w-3.5" />
        {t("writingStats.dailyGoal.set")}
      </button>
    );
  }

  return (
    <div
      className="rounded border border-border bg-card px-2.5 py-2"
      data-testid="daily-goal"
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t("writingStats.dailyGoal.title")}
        </span>
        <button
          type="button"
          onClick={startEdit}
          title={t("writingStats.dailyGoal.edit")}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent"
        >
          <Pencil className="h-3 w-3" />
        </button>
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold tabular-nums text-foreground">
          {t("writingStats.dailyGoal.currentProgress", {
            current: progress.current.toLocaleString(),
            goal: progress.goal.toLocaleString(),
          })}
        </span>
        <span
          className={`text-xs tabular-nums ${
            progress.reached
              ? "font-medium text-primary"
              : "text-muted-foreground"
          }`}
        >
          {progress.reached
            ? t("writingStats.dailyGoal.reached")
            : t("writingStats.dailyGoal.remaining", {
                remaining: progress.remaining.toLocaleString(),
              })}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-all ${
            progress.reached ? "bg-primary" : "bg-primary/70"
          }`}
          style={{ width: `${progress.pct}%` }}
        />
      </div>
      {usingDefault && (
        <div className="mt-1 text-[10px] text-muted-foreground">
          {t("writingStats.dailyGoal.usingDefault")}
        </div>
      )}
      {!hasCharData && (
        <div className="mt-1 text-[10px] text-muted-foreground">
          {t("writingStats.dailyGoal.noCharData")}
        </div>
      )}
    </div>
  );
}
