import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Trash2 } from "lucide-react";
import { useTimelineStore } from "@/features/timeline/timelineStore";
import { usePlotThreadStore } from "./plotThreadStore";
import { PLOT_PHASE_TYPES, type PlotPhaseType } from "@/db/schema";

/** onBlur でコミットする単一行テキスト編集（毎キーストロークの IPC を避ける）。 */
function InlineText({
  value,
  onCommit,
  placeholder,
}: {
  value: string;
  onCommit: (next: string) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <input
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      className="rounded border border-border bg-background px-1.5 py-0.5 text-xs focus:outline-none"
    />
  );
}

/** onBlur でコミットする複数行メモ編集。 */
function NoteEditor({
  value,
  onCommit,
  placeholder,
}: {
  value: string;
  onCommit: (next: string) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <textarea
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      rows={3}
      className="resize-none rounded border border-border bg-background px-1.5 py-1 text-xs focus:outline-none"
    />
  );
}

/**
 * threads モードのインスペクタ。選択中のスレッド（レーン見出しクリック）と
 * 選択中のマーカー（マーカークリック）を編集する。
 */
export function PlotMarkerInspector({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const linkId = useTimelineStore((s) => s.selectedPlotLinkId);
  const threadId = useTimelineStore((s) => s.selectedPlotThreadId);
  const setSelectedPlotLinkId = useTimelineStore(
    (s) => s.setSelectedPlotLinkId,
  );
  const setSelectedPlotThreadId = useTimelineStore(
    (s) => s.setSelectedPlotThreadId,
  );
  const links = usePlotThreadStore((s) => s.links);
  const threads = usePlotThreadStore((s) => s.threads);
  const renameThread = usePlotThreadStore((s) => s.renameThread);
  const deleteThread = usePlotThreadStore((s) => s.deleteThread);
  const updateMarker = usePlotThreadStore((s) => s.updateMarker);
  const deleteMarker = usePlotThreadStore((s) => s.deleteMarker);

  const link = links.find((l) => l.id === linkId) ?? null;
  // アクティブなスレッド = 選択マーカーの親 or レーン見出しクリックで選択したスレッド。
  const activeThreadId = link?.threadId ?? threadId;
  const thread = activeThreadId
    ? (threads.find((th) => th.id === activeThreadId) ?? null)
    : null;

  return (
    <div
      data-testid="plot-marker-inspector"
      className="flex w-56 shrink-0 flex-col gap-3 border-l border-border p-3 text-xs"
    >
      <div className="flex items-center justify-between">
        <span className="font-semibold text-foreground">
          {t("plotThread.thread", "スレッド")}
        </span>
        <button
          onClick={onClose}
          aria-label={t("common.close", "閉じる")}
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {!thread ? (
        <p className="text-muted-foreground">
          {t("plotThread.noSelection", "スレッドかマーカーを選択してください")}
        </p>
      ) : (
        <>
          {/* スレッド編集 */}
          <label className="flex flex-col gap-1">
            <span className="text-muted-foreground">
              {t("plotThread.name", "名前")}
            </span>
            <InlineText
              key={thread.id}
              value={thread.name}
              placeholder={t("plotThread.newThreadName", "新しいスレッド")}
              onCommit={(next) => void renameThread(thread.id, next)}
            />
          </label>
          <button
            onClick={() => {
              void deleteThread(thread.id);
              setSelectedPlotThreadId(null);
              setSelectedPlotLinkId(null);
            }}
            className="inline-flex items-center gap-1 self-start rounded px-1.5 py-1 text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t("plotThread.deleteThread", "スレッドを削除")}
          </button>

          {/* マーカー編集（マーカー選択時のみ） */}
          {link && (
            <div className="flex flex-col gap-3 border-t border-border pt-3">
              <span className="font-semibold text-foreground">
                {t("plotThread.marker", "マーカー")}
              </span>
              <label className="flex flex-col gap-1">
                <span className="text-muted-foreground">
                  {t("plotThread.phase", "段階")}
                </span>
                <select
                  value={link.phaseType}
                  onChange={(e) =>
                    void updateMarker(link.id, {
                      phaseType: e.target.value as PlotPhaseType,
                    })
                  }
                  className="rounded border border-border bg-background px-1.5 py-0.5 focus:outline-none"
                >
                  {PLOT_PHASE_TYPES.map((p) => (
                    <option key={p} value={p}>
                      {t(`plotThread.phaseType.${p}`, p)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-muted-foreground">
                  {t("plotThread.note", "メモ")}
                </span>
                <NoteEditor
                  key={link.id}
                  value={link.note ?? ""}
                  placeholder={t(
                    "plotThread.notePlaceholder",
                    "このマーカーのメモ",
                  )}
                  onCommit={(next) =>
                    void updateMarker(link.id, { note: next || null })
                  }
                />
              </label>
              <button
                onClick={() => {
                  void deleteMarker(link.id);
                  setSelectedPlotLinkId(null);
                }}
                className="inline-flex items-center gap-1 self-start rounded px-1.5 py-1 text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("plotThread.deleteMarker", "マーカーを削除")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
