import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Trash2, Ban, ChevronDown, ChevronUp } from "lucide-react";
import { useTimelineStore } from "@/features/timeline/timelineStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { activeCodexPaletteSlots } from "@/lib/resolveCodexColors";
import { usePlotThreadStore } from "./plotThreadStore";
import { PlotBranchEditor } from "./PlotBranchEditor";
import { PlotMarkerDeleteConfirmDialog } from "./PlotMarkerDeleteConfirmDialog";
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
export function PlotMarkerInspector({
  width,
  onClose,
}: {
  /** Splitter で可変・永続化された幅(px)。 */
  width: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // スレッド情報はマーカーの下に折りたたむ（マーカー選択中は既定で畳む）。
  const [threadExpanded, setThreadExpanded] = useState(false);
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
  const branches = usePlotThreadStore((s) => s.branches);
  // branch/merge アンカーのマーカー削除時に確認ダイアログを出す（Scene 削除と同型）。
  const [confirmDeleteMarker, setConfirmDeleteMarker] = useState(false);
  const renameThread = usePlotThreadStore((s) => s.renameThread);
  const setThreadColor = usePlotThreadStore((s) => s.setThreadColor);
  const deleteThread = usePlotThreadStore((s) => s.deleteThread);
  const updateMarker = usePlotThreadStore((s) => s.updateMarker);
  const deleteMarker = usePlotThreadStore((s) => s.deleteMarker);

  // スレッドの色は Codex タイプと同じパレットから選ぶ（アクティブテーマ×モード）。
  const colorTheme = useWorkspaceStore((s) => s.globalSettings?.colorTheme);
  const paletteSlots = activeCodexPaletteSlots(
    colorTheme,
    typeof document !== "undefined" &&
      document.documentElement.classList.contains("dark"),
  );

  const link = links.find((l) => l.id === linkId) ?? null;
  // アクティブなスレッド = 選択マーカーの親 or レーン見出しクリックで選択したスレッド。
  const activeThreadId = link?.threadId ?? threadId;
  const thread = activeThreadId
    ? (threads.find((th) => th.id === activeThreadId) ?? null)
    : null;

  // このマーカーを起点(to アンカー)に消える分岐 / 合流の件数（削除カスケード対象）。
  const markerEdgeCount = link
    ? branches.filter(
        (b) => b.toThreadId === link.threadId && b.atNodeId === link.nodeId,
      ).length
    : 0;
  const removeSelectedMarker = () => {
    if (!link) return;
    void deleteMarker(link.id);
    setSelectedPlotLinkId(null);
  };
  const onClickDeleteMarker = () => {
    if (!link) return;
    // branch/merge の起点なら確認ダイアログ。そうでなければ即削除。
    if (markerEdgeCount > 0) setConfirmDeleteMarker(true);
    else removeSelectedMarker();
  };

  return (
    <div
      data-testid="plot-marker-inspector"
      style={{ width }}
      className="flex min-h-0 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border p-3 text-xs"
    >
      <div className="flex items-center justify-between">
        <span className="font-semibold text-foreground">
          {link
            ? t("plotThread.marker", "マーカー")
            : t("plotThread.thread", "スレッド")}
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
          {/* マーカー編集（マーカー選択時のみ・最上部） */}
          {link && (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-muted-foreground">
                  {t("plotThread.phase", "段階")}
                </span>
                <select
                  aria-label={t("plotThread.phase", "段階")}
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
              {/* このマーカーのシーンを起点にした分岐 / 合流の編集。
                  key で選択替え時に内部 state（対象スレッド選択）をリセットする。 */}
              <PlotBranchEditor
                key={`${thread.id}:${link.nodeId}`}
                thread={thread}
                atNodeId={link.nodeId}
                threads={threads}
                linkId={link.id}
              />
              <button
                onClick={onClickDeleteMarker}
                className="inline-flex items-center gap-1 self-start rounded px-1.5 py-1 text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("plotThread.deleteMarker", "マーカーを削除")}
              </button>
            </div>
          )}

          {/* スレッド編集（マーカーの下・折りたたみ可能）。マーカー未選択時はスレッドが
              主役なので常に展開する。 */}
          <div
            className={`flex flex-col gap-3 ${link ? "border-t border-border pt-3" : ""}`}
          >
            {link ? (
              <button
                type="button"
                onClick={() => setThreadExpanded((v) => !v)}
                aria-expanded={threadExpanded}
                className="flex w-full items-center justify-between text-left font-semibold text-foreground"
              >
                <span>{t("plotThread.thread", "スレッド")}</span>
                {threadExpanded ? (
                  <ChevronUp className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                )}
              </button>
            ) : (
              <span className="font-semibold text-foreground">
                {t("plotThread.thread", "スレッド")}
              </span>
            )}

            {(!link || threadExpanded) && (
              <>
                <label className="flex flex-col gap-1">
                  <span className="text-muted-foreground">
                    {t("plotThread.name", "名前")}
                  </span>
                  <InlineText
                    key={thread.id}
                    value={thread.name}
                    placeholder={t(
                      "plotThread.newThreadName",
                      "新しいスレッド",
                    )}
                    onCommit={(next) => {
                      const v = next.trim();
                      if (v && v !== thread.name)
                        void renameThread(thread.id, v);
                    }}
                  />
                </label>

                {/* スレッド色（Codex タイプと同じパレット） */}
                <div className="flex flex-col gap-1">
                  <span className="text-muted-foreground">
                    {t("plotThread.color", "色")}
                  </span>
                  <div
                    className="flex flex-wrap items-center gap-1"
                    role="group"
                    aria-label={t("plotThread.color", "色")}
                  >
                    {paletteSlots.map((slot, i) => {
                      const selected = thread.color === slot.fg;
                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() =>
                            void setThreadColor(thread.id, slot.fg)
                          }
                          aria-label={slot.label}
                          aria-pressed={selected}
                          title={slot.label}
                          className={`h-5 w-5 rounded-full border ${selected ? "ring-2 ring-ring ring-offset-1" : "border-border"}`}
                          style={{ backgroundColor: slot.fg }}
                        />
                      );
                    })}
                    {/* 色をクリア（既定色 var(--primary) に戻す） */}
                    <button
                      type="button"
                      onClick={() => void setThreadColor(thread.id, null)}
                      aria-label={t("plotThread.colorClear", "色をクリア")}
                      aria-pressed={thread.color === null}
                      title={t("plotThread.colorClear", "色をクリア")}
                      className={`flex h-5 w-5 items-center justify-center rounded-full border text-muted-foreground ${thread.color === null ? "ring-2 ring-ring ring-offset-1" : "border-border"}`}
                    >
                      <Ban className="h-3 w-3" />
                    </button>
                  </div>
                </div>

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
              </>
            )}
          </div>
        </>
      )}

      {confirmDeleteMarker && (
        <PlotMarkerDeleteConfirmDialog
          edgeCount={markerEdgeCount}
          onCancel={() => setConfirmDeleteMarker(false)}
          onConfirm={() => {
            removeSelectedMarker();
            setConfirmDeleteMarker(false);
          }}
        />
      )}
    </div>
  );
}
