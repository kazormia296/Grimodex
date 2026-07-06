import { useMemo } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import type { Editor } from "@tiptap/react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  Fingerprint,
  Flag,
  MessageSquareText,
  MessagesSquare,
  PanelsTopLeft,
  SpellCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DURATIONS,
  EASINGS,
  VARIANTS,
  useReducedMotion,
} from "@/lib/animation";
import { useAnchoredPopover } from "@/components/ui/useAnchoredPopover";
import {
  useSettingControl,
  useSettingNumber,
} from "@/features/settings/useSettingControl";
import { useAttributionStore } from "@/features/attribution/attributionStore";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { ANNOTATION_REBUILD_META } from "@/features/post-effect/AnnotationPlugin";
import { useLintStore } from "@/features/lint/lintStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useCursorSettingsStore } from "./cursorSettingsStore";
import { useCodexHighlightStore } from "./codexHighlightStore";
import { COMMENT_REBUILD_META } from "./CommentDecorationPlugin";
import { GUTTER_REBUILD_META } from "./GutterMarksPlugin";
import { LINT_REBUILD_META } from "./LintDecorationPlugin";
import { countMarkRuns } from "./layerCounts";

function LayerSwitch({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className={cn(
        "relative h-[17px] w-[30px] flex-shrink-0 rounded-full p-[2px] transition-colors",
        checked ? "bg-primary" : "bg-border",
      )}
    >
      <span
        className={cn(
          "block h-[13px] w-[13px] rounded-full bg-white shadow-sm transition-transform",
          checked && "translate-x-[13px]",
        )}
      />
    </button>
  );
}

function LayerRow({
  icon,
  label,
  count,
  checked,
  onToggle,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  count?: string | number | null;
  checked: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="border-b border-border/40 px-3 py-2 last:border-b-0">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className={cn(
            "flex w-[18px] flex-shrink-0 items-center justify-center",
            !checked && "opacity-40",
          )}
        >
          {icon}
        </span>
        <span
          className={cn(
            "flex-1 truncate text-xs",
            checked ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          {label}
        </span>
        {count != null && count !== "" && (
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {count}
          </span>
        )}
        <LayerSwitch checked={checked} label={label} onChange={onToggle} />
      </div>
      {children}
    </div>
  );
}

export interface LayersPopoverProps {
  editor: Editor;
  open: boolean;
  onClose: () => void;
  /** トリガボタンの ref（配置基準 + 外側クリック判定）。 */
  triggerRef: RefObject<HTMLElement | null>;
  sceneId?: string;
  nodeType?: string;
}

/**
 * 「本文レイヤー」ポップオーバー (Editorパネル Refine 1c→2b)。
 * 帰属 / コメント / 読者コメント / 伏線 / 校閲の指摘 / Codex の表示トグルを
 * 1箇所に集約する。校閲の指摘は校閲アノテーション+Lint を束ねる統合レイヤー
 * （1スイッチが両フラグへ write-through）。各行の左は Lucide アイコンを
 * チャネル色で描く。帰属行は濃度スライダー、Codex 行はスタイル (デフォルト/
 * 下線) セグメントと濃度スライダーを ON 時に展開する。
 * ヘッダ下の「パネル連動」は useLayerAutoFollow の Auto モードのトグル。
 */
export function LayersPopover({
  editor,
  open,
  onClose,
  triggerRef,
  sceneId,
  nodeType,
}: LayersPopoverProps) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const { popoverRef, style } = useAnchoredPopover(
    triggerRef,
    open,
    onClose,
    "bottom-end",
  );

  const { showAttribution, toggleAttribution } = useAttributionStore();
  const {
    showComments,
    toggleShowComments,
    showForeshadowMarks,
    toggleShowForeshadowMarks,
    showLint,
    setShowLint,
    layerAutoFollow,
    toggleLayerAutoFollow,
  } = useCursorSettingsStore();
  const showAnnotations = useAnnotationStore((s) => s.showAnnotations);
  const setShowAnnotations = useAnnotationStore((s) => s.setShowAnnotations);
  const showReaderComments = useAnnotationStore((s) => s.showReaderComments);
  const toggleShowReaderComments = useAnnotationStore(
    (s) => s.toggleShowReaderComments,
  );
  const codexEnabled = useCodexHighlightStore((s) => s.enabled);
  const setCodexEnabled = useCodexHighlightStore((s) => s.setEnabled);

  const { value: opacity, setValue: setOpacity } = useSettingNumber(
    "display.attributionHighlightOpacity",
    10,
  );
  const { value: codexStyle, setValue: setCodexStyle } = useSettingControl(
    "display.codexHighlightStyle",
    "color-text",
  );
  const { value: codexOpacity, setValue: setCodexOpacity } = useSettingNumber(
    "display.codexHighlightOpacity",
    10,
  );

  const isScene = !!sceneId && nodeType === "scene";

  const reviewCount = useAnnotationStore((s) =>
    sceneId
      ? (s.annotationsByScene.get(sceneId) ?? []).filter(
          (a) => a.status !== "dismissed" && a.category !== "pseudo_comment",
        ).length
      : 0,
  );
  const readerCommentCount = useAnnotationStore((s) =>
    sceneId
      ? (s.annotationsByScene.get(sceneId) ?? []).filter(
          (a) => a.status !== "dismissed" && a.category === "pseudo_comment",
        ).length
      : 0,
  );
  const lintCount = useLintStore((s) => s.diagnostics.length);
  const aiRatio = useTreeStore((s) =>
    sceneId ? (s.aiRatios[sceneId] ?? null) : null,
  );

  // doc 走査の件数は開いたときに一度だけ算出する（開いている間の編集には
  // 追従しない — ポップオーバーは一時的な UI なので十分）。
  const markCounts = useMemo(() => {
    if (!open) return { comments: 0, foreshadow: 0 };
    return {
      comments: countMarkRuns(editor.state.doc, ["comment"]),
      foreshadow: countMarkRuns(editor.state.doc, [
        "foreshadowSetup",
        "foreshadowPayoff",
      ]),
    };
  }, [open, editor]);

  if (!open || !style) return null;

  const dispatchMeta = (meta: string) => {
    editor.view.dispatch(editor.state.tr.setMeta(meta, true));
  };

  // 校閲の指摘 = 校閲アノテーション + Lint の統合レイヤー。スイッチは
  // 「どちらかON」を表示し、トグルで両フラグを揃えて書き込む。
  const issuesChecked = showAnnotations || showLint;
  const toggleIssues = () => {
    const next = !issuesChecked;
    setShowAnnotations(next);
    setShowLint(next);
    dispatchMeta(ANNOTATION_REBUILD_META);
    dispatchMeta(LINT_REBUILD_META);
  };

  const hideAll = () => {
    if (showAttribution) toggleAttribution();
    if (showComments) {
      toggleShowComments();
      dispatchMeta(COMMENT_REBUILD_META);
    }
    // 読者コメント行は scene でのみ表示している — 見えていないトグルを
    // グローバルにOFF永続化しないよう、hideAll も同じ条件でガードする。
    if (showReaderComments && isScene) {
      toggleShowReaderComments();
      dispatchMeta(ANNOTATION_REBUILD_META);
    }
    if (showForeshadowMarks) {
      toggleShowForeshadowMarks();
      dispatchMeta(GUTTER_REBUILD_META);
    }
    if (issuesChecked) toggleIssues();
    if (codexEnabled) setCodexEnabled(false);
  };

  return createPortal(
    <motion.div
      ref={popoverRef}
      role="dialog"
      aria-label={t("editor.layers.title")}
      initial={reducedMotion ? false : VARIANTS.popover.initial}
      animate={VARIANTS.popover.animate}
      transition={{ duration: DURATIONS.fast, ease: EASINGS.easeOut }}
      style={style}
      className="z-50 w-[272px] overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
      data-testid="layers-popover"
    >
      {/* ヘッダ */}
      <div className="flex items-center border-b border-border px-3 py-1.5">
        <span className="text-[10px] font-bold tracking-wider text-muted-foreground">
          {t("editor.layers.title")}
        </span>
        <button
          type="button"
          onClick={hideAll}
          className="ms-auto rounded px-1 text-[10px] font-semibold text-primary hover:bg-accent"
        >
          {t("editor.layers.hideAll")}
        </button>
      </div>

      {/* パネル連動 (Auto) モード */}
      <div
        className="flex items-center gap-2.5 border-b border-border bg-muted/30 px-3 py-2"
        title={t("editor.layers.autoFollowHint")}
      >
        <span
          aria-hidden
          className="flex w-[18px] flex-shrink-0 items-center justify-center text-muted-foreground"
        >
          <PanelsTopLeft size={14} />
        </span>
        <span
          className={cn(
            "flex-1 truncate text-xs",
            layerAutoFollow
              ? "font-medium text-foreground"
              : "text-muted-foreground",
          )}
        >
          {t("editor.layers.autoFollow")}
        </span>
        <LayerSwitch
          checked={layerAutoFollow}
          label={t("editor.layers.autoFollow")}
          onChange={toggleLayerAutoFollow}
        />
      </div>

      {/* 帰属ハイライト */}
      <LayerRow
        icon={
          <Fingerprint size={14} style={{ color: "var(--attribution-ai)" }} />
        }
        label={t("editor.layers.attribution")}
        count={
          aiRatio != null && isScene
            ? t("editor.layers.aiShare", { percent: aiRatio })
            : null
        }
        checked={showAttribution}
        onToggle={toggleAttribution}
      >
        {showAttribution && (
          <div className="mt-2 flex items-center gap-2 ps-[28px]">
            <span className="flex-shrink-0 text-[9px] text-muted-foreground">
              {t("editor.layers.opacity")}
            </span>
            <input
              type="range"
              min={5}
              max={25}
              step={1}
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
              aria-label={t("editor.layers.opacity")}
              className="h-1 min-w-0 flex-1 accent-primary"
            />
            <span className="w-8 flex-shrink-0 text-right font-mono text-[9px] tabular-nums text-muted-foreground">
              {opacity}%
            </span>
          </div>
        )}
      </LayerRow>

      {/* コメント */}
      <LayerRow
        icon={
          <MessageSquareText
            size={14}
            style={{ color: "var(--deco-comment)" }}
          />
        }
        label={t("editor.layers.comments")}
        count={markCounts.comments}
        checked={showComments}
        onToggle={() => {
          toggleShowComments();
          dispatchMeta(COMMENT_REBUILD_META);
        }}
      />

      {/* 読者コメント (scene のみ) */}
      {isScene && (
        <LayerRow
          icon={
            <MessagesSquare
              size={14}
              style={{ color: "var(--deco-reader-comment)" }}
            />
          }
          label={t("editor.layers.readerComments")}
          count={readerCommentCount}
          checked={showReaderComments}
          onToggle={() => {
            toggleShowReaderComments();
            dispatchMeta(ANNOTATION_REBUILD_META);
          }}
        />
      )}

      {/* 伏線マーク */}
      <LayerRow
        icon={
          <Flag size={14} style={{ color: "var(--deco-foreshadow-setup)" }} />
        }
        label={t("editor.layers.foreshadow")}
        count={markCounts.foreshadow}
        checked={showForeshadowMarks}
        onToggle={() => {
          toggleShowForeshadowMarks();
          dispatchMeta(GUTTER_REBUILD_META);
        }}
      />

      {/* 校閲の指摘 (校閲 + Lint 統合) */}
      <LayerRow
        icon={
          <SpellCheck
            size={14}
            style={{ color: "var(--deco-issue-warning)" }}
          />
        }
        label={t("editor.layers.review")}
        count={lintCount + (isScene ? reviewCount : 0)}
        checked={issuesChecked}
        onToggle={toggleIssues}
      />

      {/* Codex ハイライト */}
      <LayerRow
        icon={<BookOpen size={14} className="text-muted-foreground" />}
        label={t("editor.layers.codex")}
        checked={codexEnabled}
        onToggle={() => setCodexEnabled(!codexEnabled)}
      >
        {codexEnabled && (
          <div className="mt-2 flex flex-col gap-1.5 ps-[28px]">
            <div className="flex items-center gap-2">
              <span className="flex-shrink-0 text-[9px] text-muted-foreground">
                {t("editor.layers.codexStyle")}
              </span>
              <div className="flex items-center gap-px rounded-md border border-border bg-muted/30 p-0.5">
                <button
                  type="button"
                  onClick={() => setCodexStyle("color-text")}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] transition-colors",
                    codexStyle !== "underline"
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t("editor.layers.codexStyleDefault")}
                </button>
                <button
                  type="button"
                  onClick={() => setCodexStyle("underline")}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] transition-colors",
                    codexStyle === "underline"
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t("editor.layers.codexStyleUnderline")}
                </button>
              </div>
            </div>
            {codexStyle !== "underline" && (
              <div className="flex items-center gap-2">
                <span className="flex-shrink-0 text-[9px] text-muted-foreground">
                  {t("editor.layers.opacity")}
                </span>
                <input
                  type="range"
                  min={5}
                  max={25}
                  step={1}
                  value={codexOpacity}
                  onChange={(e) => setCodexOpacity(Number(e.target.value))}
                  aria-label={t("editor.layers.codexOpacity")}
                  className="h-1 min-w-0 flex-1 accent-primary"
                />
                <span className="w-8 flex-shrink-0 text-right font-mono text-[9px] tabular-nums text-muted-foreground">
                  {codexOpacity * 10}%
                </span>
              </div>
            )}
          </div>
        )}
      </LayerRow>

      {/* フッタ */}
      <div className="flex items-center border-t border-border bg-muted/30 px-3 py-1.5">
        <button
          type="button"
          onClick={() => {
            useLayoutStore.getState().showPanel("kouetsu");
            onClose();
          }}
          className="ms-auto rounded px-1 text-[10px] font-semibold text-primary hover:bg-accent"
        >
          {t("editor.layers.openKouetsu")}
        </button>
      </div>
    </motion.div>,
    document.body,
  );
}
