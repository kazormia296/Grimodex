import {
  ChevronDown,
  ChevronRight,
  Loader2,
  MoreVertical,
  Zap,
} from "lucide-react";
import { NodeViewContent, NodeViewWrapper } from "@tiptap/react";
import type { ReactNodeViewProps } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import type { BeatType } from "./SceneBeatNode";
import { useSceneBeatEditorContext } from "./beat/SceneBeatEditorContext";
import { useBeatGeneration } from "./beat/useBeatGeneration";

/**
 * React NodeView for sceneBeat.
 * - Generate ボタン: Slice 3b-ii で配線済 (sceneId が context から取れる場合のみ enable)
 * - ⋮ メニュー: placeholder (Slice 3c で操作メニュー)
 * - POV チップ: id 表示 (Slice 3c で codex 名解決)
 */
export function SceneBeatNodeView({
  node,
  editor,
  updateAttributes,
}: ReactNodeViewProps) {
  const { t } = useTranslation();
  const collapsed = !!node.attrs.collapsed;
  const beatType = (node.attrs.beatType ?? "free") as BeatType;
  const pov = (node.attrs.pov ?? null) as string | null;
  const beatId = (node.attrs.id ?? null) as string | null;

  const ctx = useSceneBeatEditorContext();
  const sceneId = ctx?.sceneId ?? null;
  const { state, generate } = useBeatGeneration(editor, beatId ?? "", sceneId);
  const generating = state.status === "generating";
  const generateDisabled = !beatId || !sceneId || generating;
  const generateTooltip = !sceneId
    ? t("editor.beat.generateDisabledHint")
    : generating
      ? t("editor.beat.generating")
      : t("editor.beat.generate");

  return (
    <NodeViewWrapper
      as="div"
      data-type="scene-beat"
      data-beat-id={beatId ?? undefined}
      data-collapsed={collapsed ? "true" : undefined}
      className="my-2 rounded-md border-l-4 border-yellow-400/70 bg-yellow-50/40 dark:bg-yellow-900/10"
    >
      <header
        contentEditable={false}
        className="flex select-none items-center gap-2 px-2 py-1 text-xs text-muted-foreground"
      >
        <button
          type="button"
          data-testid="beat-collapse-toggle"
          aria-label={
            collapsed ? t("editor.beat.expand") : t("editor.beat.collapse")
          }
          aria-expanded={!collapsed}
          onClick={() => updateAttributes({ collapsed: !collapsed })}
          className="rounded p-0.5 hover:bg-muted"
        >
          {collapsed ? (
            <ChevronRight className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
        </button>
        <span className="font-medium">{t("editor.beat.label")}</span>
        <span
          data-testid="beat-type-chip"
          className="rounded bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wide"
        >
          {beatType}
        </span>
        {pov && (
          <span
            data-testid="beat-pov-chip"
            className="rounded bg-muted px-1 py-0.5 text-[10px]"
          >
            {t("editor.beat.povPrefix")} {pov}
          </span>
        )}
        <button
          type="button"
          data-testid="beat-generate-btn"
          disabled={generateDisabled}
          onClick={generate}
          aria-label={t("editor.beat.generate")}
          title={generateTooltip}
          className={`ml-auto inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] ${
            generateDisabled ? "opacity-50" : "hover:bg-muted"
          }`}
        >
          {generating ? (
            <Loader2
              data-testid="beat-generating-spinner"
              className="h-3 w-3 animate-spin"
            />
          ) : (
            <Zap className="h-3 w-3" />
          )}
          {t("editor.beat.generate")}
        </button>
        <button
          type="button"
          data-testid="beat-menu-btn"
          aria-label={t("editor.beat.menu")}
          disabled
          className="rounded p-0.5 opacity-50"
        >
          <MoreVertical className="h-3 w-3" />
        </button>
      </header>
      {state.status === "error" && state.error && (
        <div
          contentEditable={false}
          data-testid="beat-error"
          className="border-t border-red-200/50 bg-red-50/30 px-2 py-1 text-xs text-red-700 dark:bg-red-900/10 dark:text-red-300"
        >
          {state.error}
        </div>
      )}
      {collapsed ? (
        <div
          // Even when collapsed, content must remain mounted so PM keeps the
          // editable nodes in sync. We just visually hide it via CSS — that
          // way selection / undo / save logic continue to work transparently.
          className="hidden"
        >
          <NodeViewContent />
        </div>
      ) : (
        <NodeViewContent
          as="div"
          className="px-2 py-1 text-sm leading-relaxed focus:outline-none"
        />
      )}
    </NodeViewWrapper>
  );
}
