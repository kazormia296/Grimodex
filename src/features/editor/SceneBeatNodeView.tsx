import { ChevronDown, ChevronRight, MoreVertical, Zap } from "lucide-react";
import { NodeViewContent, NodeViewWrapper } from "@tiptap/react";
import type { ReactNodeViewProps } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import type { BeatType } from "./SceneBeatNode";

/**
 * React NodeView for sceneBeat (Slice 3b-i: 表示と折りたたみのみ).
 * - Generate ボタンは disabled。Slice 3b-ii で配線する。
 * - ⋮ メニューは placeholder。Slice 3c で操作メニューを実装する。
 * - POV のキャラ名解決は Slice 3c（codex 連携）。当面は id をそのまま表示。
 */
export function SceneBeatNodeView({
  node,
  updateAttributes,
}: ReactNodeViewProps) {
  const { t } = useTranslation();
  const collapsed = !!node.attrs.collapsed;
  const beatType = (node.attrs.beatType ?? "free") as BeatType;
  const pov = (node.attrs.pov ?? null) as string | null;

  return (
    <NodeViewWrapper
      as="div"
      data-type="scene-beat"
      data-beat-id={node.attrs.id ?? undefined}
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
          disabled
          aria-label={t("editor.beat.generate")}
          title={t("editor.beat.generateDisabledHint")}
          className="ml-auto inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] opacity-50"
        >
          <Zap className="h-3 w-3" />
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
