import { useRef, useState, useMemo, useCallback, useEffect } from "react";
import { useSettingsStore } from "@/features/settings/settingsStore";
import {
  ChevronDown,
  ChevronRight,
  GripVertical,
  Loader2,
  MoreVertical,
  Zap,
} from "lucide-react";
import { useDraggable } from "@dnd-kit/core";
import { NodeViewContent, NodeViewWrapper } from "@tiptap/react";
import type { ReactNodeViewProps } from "@tiptap/react";
import { useTranslation } from "react-i18next";
import { useCodexStore } from "@/features/codex/codexStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAiSettingsStore } from "@/features/chat/store";
import { useAiGate } from "@/features/ai-policy/useAiGate";
import { AnimatedDropdown } from "@/components/ui/animated-dropdown";
import { ChatModelMenu } from "@/features/chat/components/ChatModelMenu";
import { useChatModelCatalog } from "@/features/chat/useChatModelCatalog";
import {
  applyModelWhitelist,
  type CatalogModel,
} from "@/features/chat/chatModelCatalog";
import type { AiProvider } from "@/features/chat/types";
import type { BeatType } from "./SceneBeatNode";
import { BEAT_TYPES } from "./SceneBeatNode";
import { useSceneBeatEditorContext } from "./beat/SceneBeatEditorContext";
import { useBeatGeneration } from "./beat/useBeatGeneration";
import {
  clearBeatContent,
  convertBeatToText,
  deleteBeatAndProse,
  deleteBeatOnly,
  replaceBeatBlock,
  unplaceBeat,
} from "./beat/beatOperations";
import { generateBeatAlternative } from "./beat/generateBeatAlternative";
import { findGeneratedBlockForBeat } from "./beat/insertBeatStream";
import { RoleSuggestionBadges } from "./beat/RoleSuggestionBadges";
import { useRoleSuggestionsStore } from "./beat/roleSuggestionsStore";
import { toast } from "sonner";

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
  const beatModel = (node.attrs.model as string | null) ?? null;
  const beatModelProvider = (node.attrs.modelProvider as string | null) ?? null;
  const beatModelEndpointId =
    (node.attrs.modelEndpointId as string | null) ?? null;

  const ctx = useSceneBeatEditorContext();
  const sceneId = ctx?.sceneId ?? null;

  // Resolve POV id → codex character name (Slice 3c-i).
  const povName = useCodexStore((s) =>
    povId ? (s.entries.find((e) => e.id === povId)?.name ?? null) : null,
  );
  const allEntries = useCodexStore((s) => s.entries);
  const characters = useMemo(
    () => allEntries.filter((e) => e.type === "character"),
    [allEntries],
  );
  const scenePovCharId = useTreeStore((s) =>
    sceneId
      ? (s.nodes.find((n) => n.id === sceneId)?.povCharacterId ?? null)
      : null,
  );
  const { state, generate } = useBeatGeneration(editor, beatId ?? "", sceneId);
  const generating = state.status === "generating";
  const bodyWriteGate = useAiGate("bodyWrite");
  const generateDisabled =
    !beatId ||
    !sceneId ||
    generating ||
    bodyWriteGate.presentation !== "enabled";

  const [showActionBar, setShowActionBar] = useState(false);
  const prevStatusRef = useRef(state.status);
  useEffect(() => {
    if (prevStatusRef.current === "generating" && state.status === "idle") {
      setShowActionBar(true);
    }
    if (state.status === "generating" || state.status === "error") {
      setShowActionBar(false);
    }
    prevStatusRef.current = state.status;
  }, [state.status]);

  // Auto-dismiss when user edits generated prose
  const generatedBlock =
    editor && beatId ? findGeneratedBlockForBeat(editor, beatId) : null;
  const isModified = generatedBlock
    ? (editor?.state.doc.nodeAt(generatedBlock.blockPos)?.attrs.modified as
        | boolean
        | undefined) === true
    : false;
  useEffect(() => {
    if (showActionBar && isModified) setShowActionBar(false);
  }, [showActionBar, isModified]);

  // C-7: Clear role suggestions when beat unmounts (beat deleted or scene unloaded).
  // Use getState() instead of subscribing — clearBeat is a stable action and
  // we don't want zustand selector identity changes to retrigger this effect.
  useEffect(() => {
    const id = beatId;
    return () => {
      if (id) useRoleSuggestionsStore.getState().clearBeat(id);
    };
  }, [beatId]);

  const generateTooltip =
    bodyWriteGate.tooltip ??
    (!sceneId
      ? t("editor.beat.generateDisabledHint")
      : generating
        ? t("editor.beat.generating")
        : t("editor.beat.generate"));

  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const [povMenuOpen, setPovMenuOpen] = useState(false);
  const povBtnRef = useRef<HTMLButtonElement>(null);
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const typeBtnRef = useRef<HTMLButtonElement>(null);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelBtnRef = useRef<HTMLButtonElement>(null);

  // 縦書き(.editor-vertical 配下)では Beat ヘッダーのポップオーバーを portal 化しても
  // block-end(=左)側へ開く。判定は設定ストアではなく DOM クラスで行う: 縦書きの真実は
  // `.editor-vertical` クラスにあり(ImeDiagnosticsPlugin と同じ流儀)、テストもストアを
  // 介さずこのクラスだけを付けるため。メニューを開く瞬間に判定すれば DOM は attach 済み。
  const [isVertical, setIsVertical] = useState(false);
  const syncVertical = useCallback((el: HTMLElement | null) => {
    setIsVertical(!!el?.closest(".editor-vertical"));
  }, []);

  const aiSettings = useAiSettingsStore((s) => s.settings);
  const loadModels = useAiSettingsStore((s) => s.loadModels);
  const modelWhitelistRaw = useSettingsStore((s) => s.get("ai.modelWhitelist"));
  // チャット入力欄と同じ「複数プロバイダ横断」モデルカタログ。ピッカーを開いた
  // ときに設定済みプロバイダのモデルを取得する(useChatModelCatalog がアクティブ
  // プロバイダ + 他プロバイダ + OpenAI 互換エンドポイントをまとめてセクション化)。
  const { sections: modelSections, loading: catalogLoading } =
    useChatModelCatalog(modelMenuOpen);
  // モデル whitelist は全プロバイダ横断のグローバル絞り込み(チャット側と同じ規則)。
  const displaySections = useMemo(() => {
    let whitelist: string[];
    try {
      const parsed: unknown = JSON.parse(modelWhitelistRaw || "[]");
      whitelist = Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      whitelist = [];
    }
    return applyModelWhitelist(modelSections, whitelist);
  }, [modelSections, modelWhitelistRaw]);

  const handleModelCatalogSelect = useCallback(
    (model: CatalogModel) => {
      // model だけでなく provider / variant / endpoint も永続化する(別プロバイダの
      // モデルがアクティブプロバイダの API へ誤送出されるのを防ぐ)。
      updateAttributes({
        model: model.id,
        modelProvider: model.provider,
        modelVariant: model.variant,
        modelEndpointId: model.endpointId ?? null,
      });
      setModelMenuOpen(false);
    },
    [updateAttributes],
  );

  const handleModelInherit = useCallback(() => {
    updateAttributes({
      model: null,
      modelProvider: null,
      modelVariant: null,
      modelEndpointId: null,
    });
    setModelMenuOpen(false);
  }, [updateAttributes]);

  const runMenuAction = (fn: () => void) => {
    setMenuOpen(false);
    fn();
  };

  const handleRegenerate = () => {
    runMenuAction(() => {
      if (!editor || !beatId) return;
      const block = findGeneratedBlockForBeat(editor, beatId);
      if (block) {
        const blockNode = editor.state.doc.nodeAt(block.blockPos);
        const isModified = blockNode?.attrs.modified === true;
        if (isModified && !window.confirm(t("editor.beat.regenerateConfirm"))) {
          return;
        }
        replaceBeatBlock(editor, beatId);
      }
      void generate();
    });
  };

  const handleClearBeat = () => {
    runMenuAction(() => {
      if (!editor || !beatId) return;
      if (!window.confirm(t("editor.beat.clearConfirm"))) return;
      clearBeatContent(editor, beatId);
    });
  };

  const handleActionBarRetry = () => {
    setShowActionBar(false);
    if (!editor || !beatId) return;
    replaceBeatBlock(editor, beatId);
    void generate();
  };

  const handleActionBarDiscard = () => {
    setShowActionBar(false);
    if (!editor || !beatId) return;
    clearBeatContent(editor, beatId);
  };

  const handleUnplace = () => {
    runMenuAction(() => {
      if (!editor || !beatId || !sceneId) return;
      unplaceBeat(editor, beatId, sceneId);
      toast.info(t("editor.beat.unplaceToast"));
    });
  };

  const [isGeneratingAlternative, setIsGeneratingAlternative] = useState(false);

  const handleGenerateAlternative = () => {
    runMenuAction(() => {
      if (!editor || !beatId || !sceneId || isGeneratingAlternative) return;
      setIsGeneratingAlternative(true);
      void generateBeatAlternative(editor, beatId, sceneId, {
        onDone: () => {
          setIsGeneratingAlternative(false);
          toast.success(t("editor.beat.alternativeSaved"));
        },
        onError: (msg) => {
          setIsGeneratingAlternative(false);
          toast.error(msg);
        },
      });
    });
  };

  const { listeners: dragListeners, attributes: dragAttributes } = useDraggable(
    {
      id: `placed-beat-${beatId ?? "unknown"}`,
      data: { placedBeatId: beatId },
      disabled: !beatId,
    },
  );

  return (
    <NodeViewWrapper
      as="div"
      data-type="scene-beat"
      data-beat-id={beatId ?? undefined}
      data-collapsed={collapsed ? "true" : undefined}
      // 縦書きモード対応: 物理でなく論理プロパティで書く（border-s = 横書き左
      // / 縦書き上端）。block 軸 margin は index.css の margin-block 規則。
      className="rounded-md border-s-4 border-yellow-400/70 bg-yellow-50/40 dark:bg-yellow-900/10"
    >
      <header
        contentEditable={false}
        className="flex select-none items-center gap-2 px-2 py-1 font-sans text-xs text-muted-foreground"
      >
        <button
          type="button"
          data-testid="beat-drag-handle"
          aria-label={t("editor.beat.dragHandle")}
          className="cursor-grab rounded p-0.5 text-muted-foreground/40 hover:bg-muted hover:text-muted-foreground active:cursor-grabbing"
          {...dragListeners}
          {...dragAttributes}
        >
          <GripVertical className="h-3 w-3" />
        </button>
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
        <div className="relative">
          <button
            ref={typeBtnRef}
            type="button"
            data-testid="beat-type-chip"
            data-beat-type={beatType}
            onClick={() => {
              syncVertical(typeBtnRef.current);
              setTypeMenuOpen((v) => !v);
            }}
            className="rounded bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wide hover:bg-muted/80"
          >
            {t(`editor.beat.types.${beatType}`, beatType)}
          </button>
          <AnimatedDropdown
            open={typeMenuOpen}
            onClose={() => setTypeMenuOpen(false)}
            anchorRef={typeBtnRef}
            placement={isVertical ? "left-start" : "bottom-start"}
            className="beat-popover z-[100] min-w-[120px] rounded-md border border-border bg-popover py-1 shadow-md font-sans"
          >
            <ul role="menu" className="m-0! list-none! p-0! text-xs">
              {BEAT_TYPES.map((bt) => (
                <li key={bt}>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid={`beat-type-option-${bt}`}
                    onClick={() => {
                      updateAttributes({ beatType: bt });
                      setTypeMenuOpen(false);
                    }}
                    className={`block w-full px-3 py-1.5 text-left uppercase tracking-wide hover:bg-primary hover:text-primary-foreground ${bt === beatType ? "font-medium" : ""}`}
                  >
                    {t(`editor.beat.types.${bt}`, bt)}
                  </button>
                </li>
              ))}
            </ul>
          </AnimatedDropdown>
        </div>
        <div className="relative">
          <button
            ref={povBtnRef}
            type="button"
            data-testid="beat-pov-btn"
            onClick={() => {
              syncVertical(povBtnRef.current);
              setPovMenuOpen((v) => !v);
            }}
            className={`rounded px-1 py-0.5 text-[10px] ${
              povId && povId !== scenePovCharId
                ? "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300"
                : "text-muted-foreground/50 hover:bg-muted"
            }`}
          >
            {povId && povId !== scenePovCharId ? (
              <span data-testid="beat-pov-chip">
                {t("editor.beat.povPrefix")} {povName ?? povId}
              </span>
            ) : (
              <span className="opacity-60">{t("editor.beat.povPrefix")}</span>
            )}
          </button>
          <AnimatedDropdown
            open={povMenuOpen}
            onClose={() => setPovMenuOpen(false)}
            anchorRef={povBtnRef}
            placement={isVertical ? "left-start" : "bottom-start"}
            className="beat-popover z-[100] min-w-[160px] rounded-md border border-border bg-popover py-1 shadow-md font-sans"
          >
            <ul role="menu" className="m-0! list-none! p-0! text-xs">
              <li>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="beat-pov-clear"
                  onClick={() => {
                    updateAttributes({ pov: null });
                    setPovMenuOpen(false);
                  }}
                  className="block w-full px-3 py-1.5 text-left text-muted-foreground hover:bg-primary hover:text-primary-foreground"
                >
                  {t("editor.beat.povInherit")}
                </button>
              </li>
              {characters.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      updateAttributes({ pov: c.id });
                      setPovMenuOpen(false);
                    }}
                    className={`block w-full px-3 py-1.5 text-left hover:bg-primary hover:text-primary-foreground ${
                      c.id === povId ? "font-medium" : ""
                    }`}
                  >
                    {c.name}
                  </button>
                </li>
              ))}
            </ul>
          </AnimatedDropdown>
        </div>
        {/* C-6: Role suggestion badges (after POV chip, before menu) */}
        {editor && beatId && (
          <RoleSuggestionBadges editor={editor} beatId={beatId} />
        )}
        <div className="relative ms-auto">
          <button
            ref={menuBtnRef}
            type="button"
            data-testid="beat-menu-btn"
            aria-label={t("editor.beat.menu")}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => {
              syncVertical(menuBtnRef.current);
              setMenuOpen((v) => !v);
            }}
            disabled={!beatId || !editor}
            className="rounded p-0.5 hover:bg-muted disabled:opacity-50"
          >
            <MoreVertical className="h-3 w-3" />
          </button>
          <AnimatedDropdown
            open={menuOpen}
            onClose={() => setMenuOpen(false)}
            anchorRef={menuBtnRef}
            placement={isVertical ? "left-start" : "bottom-end"}
            className="beat-popover z-[100] min-w-[180px] rounded-md border border-border bg-popover py-1 shadow-md font-sans"
          >
            <ul role="menu" className="m-0! list-none! p-0! text-xs">
              <li>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="beat-menu-generate-alternative"
                  disabled={generateDisabled || isGeneratingAlternative}
                  onClick={handleGenerateAlternative}
                  className="block w-full px-3 py-1.5 text-left hover:bg-primary hover:text-primary-foreground disabled:opacity-50"
                >
                  {isGeneratingAlternative
                    ? t("editor.beat.menuItems.generatingAlternative")
                    : t("editor.beat.menuItems.generateAlternative")}
                </button>
              </li>
              <li>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="beat-menu-regenerate"
                  disabled={generateDisabled}
                  onClick={handleRegenerate}
                  className="block w-full px-3 py-1.5 text-left hover:bg-primary hover:text-primary-foreground disabled:opacity-50"
                >
                  {t("editor.beat.menuItems.regenerate")}
                </button>
              </li>
              <li>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="beat-menu-unplace"
                  disabled={!sceneId}
                  onClick={handleUnplace}
                  className="block w-full px-3 py-1.5 text-left hover:bg-primary hover:text-primary-foreground disabled:opacity-50"
                >
                  {t("editor.beat.menuItems.unplace")}
                </button>
              </li>
              <li>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="beat-menu-clear"
                  onClick={handleClearBeat}
                  className="block w-full px-3 py-1.5 text-left hover:bg-primary hover:text-primary-foreground"
                >
                  {t("editor.beat.menuItems.clearBeat")}
                </button>
              </li>
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
                  className="block w-full px-3 py-1.5 text-left hover:bg-primary hover:text-primary-foreground"
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
                  className="block w-full px-3 py-1.5 text-left hover:bg-primary hover:text-primary-foreground"
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
                  className="block w-full px-3 py-1.5 text-left text-red-600 hover:bg-primary hover:text-primary-foreground dark:text-red-400"
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
          className="beat-divider border-red-200/50 bg-red-50/30 px-2 py-1 font-sans text-xs text-red-700 dark:bg-red-900/10 dark:text-red-300"
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
      {!collapsed && showActionBar && (
        <div
          contentEditable={false}
          data-testid="beat-action-bar"
          className="beat-divider flex select-none items-center gap-1 border-yellow-200/50 bg-yellow-50/60 px-2 py-1 font-sans text-xs dark:bg-yellow-900/15 dark:border-yellow-800/30"
        >
          <span className="me-1 text-muted-foreground/60">
            {t("editor.beat.generating")}
          </span>
          <button
            type="button"
            data-testid="beat-action-keep"
            onClick={() => setShowActionBar(false)}
            className="rounded border border-border bg-background px-2 py-0.5 hover:bg-muted"
          >
            {t("editor.beat.actionBarKeep")}
          </button>
          <button
            type="button"
            data-testid="beat-action-retry"
            onClick={handleActionBarRetry}
            className="rounded border border-border bg-background px-2 py-0.5 hover:bg-muted"
          >
            {t("editor.beat.actionBarRetry")}
          </button>
          <button
            type="button"
            data-testid="beat-action-discard"
            onClick={handleActionBarDiscard}
            className="rounded border border-red-200 bg-background px-2 py-0.5 text-red-600 hover:bg-red-50 dark:border-red-800/50 dark:text-red-400"
          >
            {t("editor.beat.actionBarDiscard")}
          </button>
        </div>
      )}
      {!collapsed && (
        <footer
          contentEditable={false}
          className="beat-divider flex select-none items-center gap-1.5 border-yellow-200/50 px-2 py-1 font-sans text-xs text-muted-foreground dark:border-yellow-800/30"
        >
          <div className="relative">
            <button
              ref={modelBtnRef}
              type="button"
              data-testid="beat-model-btn"
              onClick={() => {
                if (!modelMenuOpen) loadModels();
                setModelMenuOpen((v) => !v);
              }}
              className="flex max-w-[180px] items-center rounded px-1 py-0.5 text-[10px] text-muted-foreground/70 hover:bg-muted"
            >
              <span className="truncate">
                {beatModel ?? t("editor.beat.modelInherit")}
              </span>
            </button>
            <AnimatedDropdown
              open={modelMenuOpen}
              onClose={() => setModelMenuOpen(false)}
              anchorRef={modelBtnRef}
              placement="top-start"
              className="beat-popover z-[100] overflow-hidden rounded-md border border-border bg-popover shadow-md font-sans"
            >
              {(maxHeight) => (
                <ChatModelMenu
                  sections={displaySections}
                  loading={catalogLoading}
                  maxHeight={maxHeight ?? undefined}
                  current={{
                    provider: beatModelProvider
                      ? (beatModelProvider as AiProvider)
                      : aiSettings?.provider,
                    modelId: beatModel ?? "",
                    endpointId:
                      beatModelEndpointId ??
                      aiSettings?.activeOpenaiCompatibleEndpointId,
                  }}
                  onSelect={handleModelCatalogSelect}
                  inheritOption={{
                    label: t("editor.beat.modelInherit"),
                    active: beatModel === null,
                    onSelect: handleModelInherit,
                  }}
                />
              )}
            </AnimatedDropdown>
          </div>
          {/* bodyWrite がポリシーで OFF のときは生成ボタンを隠す（モード扱い）。
              no-model / no-provider は disabled + tooltip で残す。model セレクタ等の
              ノード本体は残す。 */}
          {bodyWriteGate.presentation !== "hidden" && (
            <button
              type="button"
              data-testid="beat-generate-btn"
              data-tour-target="beat-generate-btn"
              disabled={generateDisabled}
              onClick={generate}
              aria-label={t("editor.beat.generate")}
              title={generateTooltip}
              className={`ms-auto inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] ${
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
          )}
        </footer>
      )}
    </NodeViewWrapper>
  );
}
