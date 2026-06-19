import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pencil, Check, X, Flag } from "lucide-react";
import {
  useSettingNumber,
  useSettingControl,
} from "@/features/settings/useSettingControl";
import { computeFinishLineProgress } from "./finishLine";

interface FinishLinePacemakerProps {
  /** 現在の原稿総文字数（シーン charCount の合計、net）。 */
  currentChars: number;
  /** 直近の暦日平均ペース（字/日）。events 由来のため概算。 */
  pace: number;
  /** 字数復元が成立しているか。false なら events 由来のペースは不正確。 */
  hasCharData: boolean;
  /** 現在時刻 unix ms（パネルのスナップショットと揃える）。 */
  now: number;
}

/** "YYYY-MM-DD" をロケール短縮日付に。 */
function formatDayKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString();
}

/**
 * 「完走ペースメーカー」。原稿全体の目標総文字数（`goal.manuscriptTargetChars`）と
 * 任意の締切（`goal.manuscriptDeadline`）に対し、現在総量・残量・直近ペースから
 * 完走予定日を出す。締切があれば、間に合わせるのに必要な 1 日あたり字数と
 * 間に合うかどうかも示す。どちらもこのプロジェクト固有値（インライン編集）。
 *
 * 目標/現在/残量は scene の charCount（net）由来で常に正確。ペースと完走予定は
 * 編集イベント由来の概算なので、字数データが無いときは予測を伏せる。
 */
export function FinishLinePacemaker({
  currentChars,
  pace,
  hasCharData,
  now,
}: FinishLinePacemakerProps) {
  const { t } = useTranslation();
  const { value: target, setValue: setTarget } = useSettingNumber(
    "goal.manuscriptTargetChars",
    0,
  );
  const { value: deadline, setValue: setDeadline } = useSettingControl(
    "goal.manuscriptDeadline",
    "",
  );

  const progress = computeFinishLineProgress({
    target,
    current: currentChars,
    pace,
    deadlineKey: deadline || null,
    now,
  });

  const [editing, setEditing] = useState(false);
  const [targetDraft, setTargetDraft] = useState("");
  const [deadlineDraft, setDeadlineDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function startEdit() {
    setTargetDraft(target > 0 ? String(target) : "");
    setDeadlineDraft(deadline);
    setEditing(true);
  }
  function commit() {
    const v = parseInt(targetDraft, 10);
    setTarget(Number.isNaN(v) || v < 0 ? 0 : v);
    setDeadline(deadlineDraft);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="rounded border border-border bg-card px-2.5 py-2">
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t("writingStats.pacemaker.title")}
        </div>
        <label className="mt-1.5 block text-[11px] text-muted-foreground">
          {t("writingStats.pacemaker.targetLabel")}
        </label>
        <div className="mt-0.5 flex items-center gap-1.5">
          <input
            ref={inputRef}
            type="number"
            min={0}
            step={1000}
            value={targetDraft}
            placeholder={t("writingStats.pacemaker.targetPlaceholder")}
            onChange={(e) => setTargetDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") setEditing(false);
            }}
            className="w-28 rounded border border-input bg-background px-2 py-1 text-right text-sm tabular-nums focus:outline-none"
            data-testid="pacemaker-target-input"
          />
          <span className="text-xs text-muted-foreground">
            {t("writingStats.charsUnit")}
          </span>
        </div>
        <label className="mt-2 block text-[11px] text-muted-foreground">
          {t("writingStats.pacemaker.deadlineLabel")}
        </label>
        <div className="mt-0.5 flex items-center gap-1.5">
          <input
            type="date"
            value={deadlineDraft}
            onChange={(e) => setDeadlineDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              else if (e.key === "Escape") setEditing(false);
            }}
            className="rounded border border-input bg-background px-2 py-1 text-sm tabular-nums focus:outline-none"
            data-testid="pacemaker-deadline-input"
          />
          <button
            type="button"
            onClick={commit}
            title={t("writingStats.pacemaker.save")}
            className="rounded p-1 text-muted-foreground hover:bg-accent"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            title={t("writingStats.pacemaker.cancel")}
            className="rounded p-1 text-muted-foreground hover:bg-accent"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  }

  if (!progress.hasTarget) {
    return (
      <button
        type="button"
        onClick={startEdit}
        className="flex items-center gap-1.5 self-start rounded border border-dashed border-border px-2.5 py-2 text-xs text-muted-foreground hover:bg-accent"
        data-testid="pacemaker-set"
      >
        <Flag className="h-3.5 w-3.5" />
        {t("writingStats.pacemaker.set")}
      </button>
    );
  }

  const showProjection = hasCharData && !progress.reached;

  return (
    <div
      className="rounded border border-border bg-card px-2.5 py-2"
      data-testid="pacemaker"
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {t("writingStats.pacemaker.title")}
        </span>
        <button
          type="button"
          onClick={startEdit}
          title={t("writingStats.pacemaker.edit")}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent"
        >
          <Pencil className="h-3 w-3" />
        </button>
      </div>

      <div className="mt-1 flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold tabular-nums text-foreground">
          {t("writingStats.pacemaker.currentProgress", {
            current: progress.current.toLocaleString(),
            target: progress.target.toLocaleString(),
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
            ? t("writingStats.pacemaker.reached")
            : t("writingStats.pacemaker.remaining", {
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

      {hasCharData && !progress.reached && (
        <div className="mt-1.5 text-[11px] text-muted-foreground">
          {t("writingStats.pacemaker.pace", {
            pace: Math.round(progress.pace).toLocaleString(),
          })}
        </div>
      )}

      {showProjection && progress.projectedFinishKey && (
        <div className="mt-0.5 text-[11px] text-foreground">
          {t("writingStats.pacemaker.projectedFinish", {
            date: formatDayKey(progress.projectedFinishKey),
            days: progress.daysToFinish?.toLocaleString() ?? "",
          })}
        </div>
      )}
      {showProjection && progress.daysToFinish === null && (
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {t("writingStats.pacemaker.noPace")}
        </div>
      )}
      {!hasCharData && !progress.reached && (
        <div className="mt-0.5 text-[10px] text-muted-foreground">
          {t("writingStats.pacemaker.noCharData")}
        </div>
      )}

      {progress.hasDeadline && !progress.reached && (
        <div className="mt-1.5 border-t border-border pt-1.5">
          {progress.requiredPace !== null &&
            progress.daysUntilDeadline !== null && (
              <div className="text-[11px] text-muted-foreground">
                {t("writingStats.pacemaker.deadlineRequired", {
                  date: formatDayKey(deadline),
                  pace: progress.requiredPace.toLocaleString(),
                })}
              </div>
            )}
          {hasCharData && (
            <div
              className={`mt-0.5 text-[11px] font-medium ${
                progress.onTrack ? "text-primary" : "text-destructive"
              }`}
            >
              {progress.onTrack
                ? t("writingStats.pacemaker.onTrack")
                : progress.deltaDays !== null
                  ? t("writingStats.pacemaker.behind", {
                      days: progress.deltaDays.toLocaleString(),
                    })
                  : t("writingStats.pacemaker.cannotMake")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
