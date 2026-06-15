import { useCallback, useEffect, useRef, useState } from "react";
import i18next from "i18next";
import type { Editor } from "@tiptap/react";
import { AnimatedDropdown } from "@/components/ui/animated-dropdown";
import {
  countUnitLabelKey,
  countWords,
  manuscriptPages,
  primaryCountUnit,
  readingMinutes,
} from "@/features/editor/charCountStats";
import { countBeats } from "@/features/editor/beat/countBeats";
import { useCharCountMilestone } from "@/features/editor/useCharCountMilestone";
import { useCurrentProject } from "@/features/project/projectStore";
import { useSettingNumber } from "@/features/settings/useSettingControl";
import { useTreeStore } from "@/features/tree/treeStore";
import { getDocText } from "@/features/editor/RubyNode";
import { markStart, markEnd } from "@/lib/perfLog";
import { cn } from "@/lib/utils";

interface EditorStatsFooterProps {
  editor: Editor | null;
  /** 現在エディタにロード済みのコンテンツ id。switch 中の取り違えを避ける
   *  ため fire 時に読む（親の saveSceneIdRef を返す stable callback）。 */
  getSyncSceneId: () => string | null | undefined;
  /** scene 編集時のみ tree store の charCount を同期する */
  syncToTree: boolean;
  /** ロード完了 (true→false 遷移) で即時再計算する。setContent は
   *  emitUpdate:false なので update イベントでは拾えない。 */
  isLoading: boolean;
}

/**
 * フッター右側の統計（Beats / 文字数 / 目標進捗 / 詳細ポップオーバー）。
 *
 * count 系 state を EditorPane 本体から分離してここに持つ。親に置くと
 * タイピング休止ごとの stat 更新で 2200 行ペイン全体が再レンダーされる
 * ため、editor の update イベントを自前購読し 200ms trailing debounce で
 * 再計算する（再レンダー範囲はこの footer のみ）。
 *
 * 旧実装と異なり inline AI 生成中の update でも再計算する（旧 onUpdate は
 * status !== idle でガードしていた）。表示とツリーの charCount キャッシュが
 * 対象なので、生成途中の値が一瞬見えても次の update で追従し、害はない。
 * なお外部更新・peer sync の setContent は emitUpdate:false でそもそも
 * update イベントを出さないため、ここでの扱いは旧実装と同一。
 */
export function EditorStatsFooter({
  editor,
  getSyncSceneId,
  syncToTree,
  isLoading,
}: EditorStatsFooterProps) {
  const [charCount, setCharCount] = useState(0);
  const [wordCount, setWordCount] = useState(0);
  const [beatTotal, setBeatTotal] = useState(0);
  const [beatGenerated, setBeatGenerated] = useState(0);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const charCountRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<number | null>(null);
  // 一次メトリクスは PROJECT 言語で決める (en=語数 / それ以外=文字数)。
  // tree へ同期する charCount は常に文字数のまま (永続列の意味を変えない)。
  const lang = useCurrentProject()?.language;
  const unit = primaryCountUnit(lang);
  const primaryCount = unit === "word" ? wordCount : charCount;
  const unitLabel = i18next.t(countUnitLabelKey(unit));
  const { value: targetCount } = useSettingNumber("editor.targetCharCount", 0);
  // 目標値は project スコープ設定なので、単位は一次メトリクスに従って解釈する。
  useCharCountMilestone(primaryCount, targetCount, charCountRef);

  // props を ref に逃がし、毎レンダーの identity 変化で update 購読が
  // 再構築されないようにする。
  const getSyncSceneIdRef = useRef(getSyncSceneId);
  getSyncSceneIdRef.current = getSyncSceneId;
  const syncToTreeRef = useRef(syncToTree);
  syncToTreeRef.current = syncToTree;
  // recompute は [] deps なので lang を ref 経由で読む (stale closure 回避)。
  const langRef = useRef(lang);
  langRef.current = lang;

  const recompute = useCallback((e: Editor) => {
    const text = getDocText(e.state.doc);
    const count = text.length;
    setCharCount(count);
    setWordCount(countWords(text, langRef.current));
    const bc = countBeats(e.state.doc);
    setBeatTotal(bc.total);
    setBeatGenerated(bc.generated);
    const sid = getSyncSceneIdRef.current();
    if (sid && syncToTreeRef.current) {
      useTreeStore.getState().setCharCount(sid, count);
    }
  }, []);

  // タイピング: update イベント → 200ms trailing debounce で1回だけ
  // full-doc walk + setState する（タイピング中は発火しない）。
  useEffect(() => {
    if (!editor || typeof editor.on !== "function") return;
    const onUpdate = ({ editor: e }: { editor: Editor }) => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (e.isDestroyed) return;
        markStart("editor.statSync");
        recompute(e);
        markEnd("editor.statSync");
      }, 200);
    };
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [editor, recompute]);

  // ロード完了時の初期値（と editor 差し替え時の再シード）。
  useEffect(() => {
    if (!editor || editor.isDestroyed || isLoading) return;
    recompute(editor);
  }, [editor, isLoading, recompute]);

  return (
    <>
      {beatTotal > 0 && (
        <span
          data-testid="beat-stats"
          className="tabular-nums text-muted-foreground"
        >
          {i18next.t("editor.status.beatsLabel", { total: beatTotal })}
          {beatGenerated > 0 &&
            ` ${i18next.t("editor.status.generatedBeats", { generated: beatGenerated })}`}
        </span>
      )}
      <div ref={containerRef} className="relative">
        <button
          type="button"
          ref={charCountRef}
          data-testid="char-count"
          onClick={() => setPopoverOpen((v) => !v)}
          title={i18next.t("editor.status.charCountDetails")}
          className="flex items-center gap-1.5 tabular-nums hover:text-foreground"
        >
          <span>
            {primaryCount.toLocaleString()} {unitLabel}
          </span>
          {targetCount > 0 && (
            <>
              <span className="text-muted-foreground">
                / {targetCount.toLocaleString()}
              </span>
              <span
                className="relative h-1 w-12 overflow-hidden rounded-full bg-muted"
                aria-hidden
              >
                <span
                  className={cn(
                    "absolute inset-y-0 left-0 transition-[width] duration-200",
                    primaryCount >= targetCount
                      ? "bg-emerald-500"
                      : "bg-primary",
                  )}
                  style={{
                    width: `${Math.min(100, (primaryCount / targetCount) * 100)}%`,
                  }}
                />
              </span>
              {primaryCount > targetCount && (
                <span className="text-rose-500">
                  +{(primaryCount - targetCount).toLocaleString()}
                </span>
              )}
            </>
          )}
        </button>
        <AnimatedDropdown
          open={popoverOpen}
          onClose={() => setPopoverOpen(false)}
          containerRef={containerRef}
          className="absolute bottom-6 right-0 z-50 min-w-[220px] rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md"
        >
          {(() => {
            const text = editor ? getDocText(editor.state.doc) : "";
            const wc = countWords(text, lang);
            // 原稿用紙換算・読了時間は一次メトリクスから算出する
            // (en=語数ベース / それ以外=文字数ベース)。
            const pages = manuscriptPages(primaryCount, lang);
            const minutes = readingMinutes(primaryCount, lang);
            const charsRow = (
              <Stat
                label={i18next.t("editor.status.chars")}
                value={charCount.toLocaleString()}
              />
            );
            const wordsRow = (
              <Stat
                label={i18next.t("editor.status.words")}
                value={wc.toLocaleString()}
              />
            );
            return (
              <div className="flex flex-col gap-1.5 tabular-nums">
                {/* 一次メトリクスを先頭に出す (en=語数 / それ以外=文字数)。 */}
                {unit === "word" ? (
                  <>
                    {wordsRow}
                    {charsRow}
                  </>
                ) : (
                  <>
                    {charsRow}
                    {wordsRow}
                  </>
                )}
                <Stat
                  label={i18next.t("editor.status.manuscriptPages")}
                  value={i18next.t(
                    unit === "word"
                      ? "editor.status.manuscriptPagesValueWords"
                      : "editor.status.manuscriptPagesValueChars",
                    { n: pages.toFixed(1) },
                  )}
                />
                <Stat
                  label={i18next.t("editor.status.readingTime")}
                  value={i18next.t("editor.status.readingTimeValue", {
                    n: minutes,
                  })}
                />
                {targetCount > 0 && (
                  <>
                    <div className="my-1 border-t border-border" />
                    <Stat
                      label={i18next.t("editor.status.goal")}
                      value={`${targetCount.toLocaleString()} ${unitLabel}`}
                    />
                    <div className="flex items-center gap-2">
                      <span
                        className="relative h-1 flex-1 overflow-hidden rounded-full bg-muted"
                        aria-hidden
                      >
                        <span
                          className={cn(
                            "absolute inset-y-0 left-0",
                            primaryCount >= targetCount
                              ? "bg-emerald-500"
                              : "bg-primary",
                          )}
                          style={{
                            width: `${Math.min(100, (primaryCount / targetCount) * 100)}%`,
                          }}
                        />
                      </span>
                      <span className="w-10 text-right text-muted-foreground">
                        {Math.round((primaryCount / targetCount) * 100)}%
                      </span>
                    </div>
                  </>
                )}
              </div>
            );
          })()}
        </AnimatedDropdown>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
