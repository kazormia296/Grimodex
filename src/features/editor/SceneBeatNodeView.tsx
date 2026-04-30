import { useRef, useState } from "react";
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
import { useCodexStore } from "@/features/codex/codexStore";
import { AnimatedDropdown } from "@/components/ui/animated-dropdown";
import type { BeatType } from "./SceneBeatNode";
import { useSceneBeatEditorContext } from "./beat/SceneBeatEditorContext";
import { useBeatGeneration } from "./beat/useBeatGeneration";
import {
  convertBeatToText,
  deleteBeatAndProse,
  deleteBeatOnly,
} from "./beat/beatOperations";

export function SceneBeatNodeView({
  node,
  editor,
  updateAttributes,
}: ReactNodeViewProps) {
  const { t } = useTranslation();
  const collapsed = !!node.attrs.collapsed;
  const beatType = (node.attrs.beatType ?? "free") as BeatType;
  const povId = (node.attrs.pov ?? null) as string | null;
  const beatId = (node.attrs.id ?? null) as string | null;

  // Resolve POV id → codex character name (Slice 3c-i).
  const povName = useCodexStore((s) =>
    povId ? (s.entries.find((e) => e.id === povId)?.name ?? null) : null,
  );

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

  const [menuOpen, setMenuOpen] = useState(false);
  const menuContainerRef = useRef<HTMLDivElement>(null);

  const runMenuAction = (fn: () => void) => {
    setMenuOpen(false);
    fn();
  };

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
        {povId && (
          <span
            data-testid="beat-pov-chip"
            className="rounded bg-muted px-1 py-0.5 text-[10px]"
          >
            {t("editor.beat.povPrefix")} {povName ?? povId}
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
        <div ref={menuContainerRef} className="relative">
          <button
            type="button"
            data-testid="beat-menu-btn"
            aria-label={t("editor.beat.menu")}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            disabled={!beatId || !editor}
            className="rounded p-0.5 hover:bg-muted disabled:opacity-50"
          >
            <MoreVertical className="h-3 w-3" />
          </button>
          <AnimatedDropdown
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            containerRef={menuContainerRef}
            className="absolute right-0 top-6 z-50 min-w-[180px] rounded-md border border-border bg-popover py-1 shadow-md"
          >
            <ul role="menu" className="text-xs">
              <li>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="beat-menu-convert-to-text"
                  onClick={() =>
                    runMenuAction(() => {
                      if (editor && beatId) convertBeatToText(editor, beatId);
                    })
                  }
                  className="block w-full px-3 py-1.5 text-left hover:bg-accent"
                >
                  {t("editor.beat.menuItems.convertToText")}
                </button>
              </li>
              <li>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="beat-menu-delete-only"
                  onClick={() =>
                    runMenuAction(() => {
                      if (editor && beatId) deleteBeatOnly(editor, beatId);
                    })
                  }
                  className="block w-full px-3 py-1.5 text-left hover:bg-accent"
                >
                  {t("editor.beat.menuItems.deleteBeatOnly")}
                </button>
              </li>
              <li>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="beat-menu-delete-with-prose"
                  onClick={() =>
                    runMenuAction(() => {
                      if (editor && beatId) deleteBeatAndProse(editor, beatId);
                    })
                  }
                  className="block w-full px-3 py-1.5 text-left text-red-600 hover:bg-accent dark:text-red-400"
                >
                  {t("editor.beat.menuItems.deleteBeatAndProse")}
                </button>
              </li>
            </ul>
          </AnimatedDropdown>
        </div>
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
