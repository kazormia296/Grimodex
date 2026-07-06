import { useMemo } from "react";
import { createPortal } from "react-dom";
import { motion } from "motion/react";
import type { Editor } from "@tiptap/react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Flag } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DURATIONS,
  EASINGS,
  VARIANTS,
  useReducedMotion,
} from "@/lib/animation";
import { useAnchoredPopover } from "@/components/ui/useAnchoredPopover";
import { useSettingNumber } from "@/features/settings/useSettingControl";
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

/** Codex 組み込み4タイプの見本ドット色 (typeApi.ts BUILTIN_TYPES の seed 値)。 */
const CODEX_SAMPLE_COLORS = ["#7F77DD", "#1D9E75", "#BA7517", "#D85A30"];

function WavySample({ color }: { color: string }) {
  return (
    <svg
      width="30"
      height="8"
      viewBox="0 0 30 8"
      fill="none"
      stroke={color}
      strokeWidth="1.6"
      strokeLinecap="round"
    >
      <path d="M2 5q2.4-4 4.8 0t4.8 0t4.8 0t4.8 0t4.8 0" />
    </svg>
  );
}

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
  sample,
  label,
  note,
  count,
  checked,
  onToggle,
  children,
}: {
  sample: React.ReactNode;
  label: string;
  note?: string;
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
            "flex w-[30px] flex-shrink-0 items-center",
            !checked && "opacity-40",
          )}
        >
          {sample}
        </span>
        <span
          className={cn(
            "flex-1 truncate text-xs",
            checked ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          {label}
          {note && (
            <span className="ms-1 text-[9px] text-muted-foreground">
              {note}
            </span>
          )}
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
 * 「本文レイヤー」ポップオーバー (Editorパネル Refine 1c)。
 * 帰属 / コメント / 伏線 / 校閲 / Lint / Codex の表示トグルを1箇所に集約し、
 * 各行の左に本文中の見え方の見本、右に件数バッジとスイッチを置く。
 * 帰属行は ON のとき濃度スライダー（display.attributionHighlightOpacity）を
 * 展開する。トグルは各ストアへ write-through され設定として永続化される。
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
    toggleShowLint,
  } = useCursorSettingsStore();
  const showAnnotations = useAnnotationStore((s) => s.showAnnotations);
  const toggleShowAnnotations = useAnnotationStore(
    (s) => s.toggleShowAnnotations,
  );
  const codexEnabled = useCodexHighlightStore((s) => s.enabled);
  const setCodexEnabled = useCodexHighlightStore((s) => s.setEnabled);

  const { value: opacity, setValue: setOpacity } = useSettingNumber(
    "display.attributionHighlightOpacity",
    10,
  );

  const isScene = !!sceneId && nodeType === "scene";

  const reviewCount = useAnnotationStore((s) =>
    sceneId
      ? (s.annotationsByScene.get(sceneId) ?? []).filter(
          (a) => a.status !== "dismissed",
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

  const hideAll = () => {
    if (showAttribution) toggleAttribution();
    if (showComments) {
      toggleShowComments();
      dispatchMeta(COMMENT_REBUILD_META);
    }
    if (showForeshadowMarks) {
      toggleShowForeshadowMarks();
      dispatchMeta(GUTTER_REBUILD_META);
    }
    if (showAnnotations) {
      toggleShowAnnotations();
      dispatchMeta(ANNOTATION_REBUILD_META);
    }
    if (showLint) {
      toggleShowLint();
      dispatchMeta(LINT_REBUILD_META);
    }
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

      {/* 帰属ハイライト */}
      <LayerRow
        sample={
          <span className="flex w-full flex-col gap-0.5">
            <span
              className="h-1.5 rounded-sm"
              style={{
                background:
                  "color-mix(in oklab, var(--attribution-ai) 30%, transparent)",
              }}
            />
            <span
              className="h-1.5 rounded-sm"
              style={{
                background:
                  "color-mix(in oklab, var(--attribution-unknown) 30%, transparent)",
              }}
            />
          </span>
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
          <div className="mt-2 flex items-center gap-2 ps-[40px]">
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
        sample={
          <span
            className="h-2 w-full"
            style={{ borderBottom: "2px dotted var(--deco-comment)" }}
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

      {/* 伏線マーク */}
      <LayerRow
        sample={
          <span className="flex w-full items-center gap-0.5">
            <Flag
              size={9}
              className="flex-shrink-0"
              style={{ color: "var(--deco-foreshadow-setup)" }}
              fill="var(--deco-foreshadow-setup)"
            />
            <span
              className="h-2 flex-1"
              style={{
                borderBottom: "2px dashed var(--deco-foreshadow-setup)",
              }}
            />
          </span>
        }
        label={t("editor.layers.foreshadow")}
        count={markCounts.foreshadow}
        checked={showForeshadowMarks}
        onToggle={() => {
          toggleShowForeshadowMarks();
          dispatchMeta(GUTTER_REBUILD_META);
        }}
      />

      {/* 校閲の指摘 (scene のみ) */}
      {isScene && (
        <LayerRow
          sample={<WavySample color="var(--deco-review)" />}
          label={t("editor.layers.review")}
          count={reviewCount}
          checked={showAnnotations}
          onToggle={() => {
            toggleShowAnnotations();
            dispatchMeta(ANNOTATION_REBUILD_META);
          }}
        />
      )}

      {/* Lint */}
      <LayerRow
        sample={<WavySample color="var(--deco-lint-warning)" />}
        label={t("editor.layers.lint")}
        count={lintCount}
        checked={showLint}
        onToggle={() => {
          toggleShowLint();
          dispatchMeta(LINT_REBUILD_META);
        }}
      />

      {/* Codex ハイライト */}
      <LayerRow
        sample={
          <span className="flex gap-0.5">
            {CODEX_SAMPLE_COLORS.map((c) => (
              <span
                key={c}
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: c }}
              />
            ))}
          </span>
        }
        label={t("editor.layers.codex")}
        note={t("editor.layers.codexNote")}
        checked={codexEnabled}
        onToggle={() => setCodexEnabled(!codexEnabled)}
      />

      {/* フッタ */}
      <div className="flex items-center border-t border-border bg-muted/30 px-3 py-1.5">
        <span className="text-[9px] text-muted-foreground">
          {t("editor.layers.sampleNote")}
        </span>
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
