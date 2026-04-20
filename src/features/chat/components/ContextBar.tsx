import {
  useState,
  useRef,
  useCallback,
  useEffect,
  type MouseEvent,
} from "react";
import { motion, AnimatePresence } from "motion/react";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  X,
  BookOpen,
  ChevronDown,
  ChevronUp,
  Pin,
  Undo2,
  Bot,
} from "lucide-react";
import type { CodexEntry } from "@/features/codex/api";
import type {
  PinnedCodexEntryWithData,
  PinnedSnippetEntryWithData,
} from "../chatApi";
import type { LayerBreakdown } from "../contextBuilder";
import { PromptPreviewModal } from "./PromptPreviewModal";
import { ContextCreatorButton } from "./ContextCreatorButton";
import { ContextCreatorDialog } from "./ContextCreatorDialog";
import { runContextCreator, type SuggestedEntry } from "../contextCreatorApi";
import { useChatStore } from "../chatStore";
import {
  getModelCapabilities,
  formatContextWindow,
} from "../agent/modelLimits";
import { getTypeLabel } from "../utils/typeLabels";
import { ContextPillGroup } from "./ContextPillGroup";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { getChildrenFromArray } from "@/features/codex/childrenBudget";
import { CodexEntryPopoverContent } from "@/features/codex/components/CodexEntryPopoverContent";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { PinCodexDialog } from "./PinCodexDialog";

const GROUP_THRESHOLD = 6;
const TYPE_ORDER = ["character", "location", "item", "lore"];

type ViaChild = {
  child: CodexEntry;
  viaParentId: string;
  viaParentName: string;
};

interface ContextBarProps {
  pinnedEntries: PinnedCodexEntryWithData[];
  /** G15: auto-detected entries (excluding pinned) */
  detectedEntries?: CodexEntry[];
  /** G15: always-mode entries (excluding pinned and detected) */
  alwaysEntries?: CodexEntry[];
  /** G16: pinned snippet entries */
  pinnedSnippets?: PinnedSnippetEntryWithData[];
  /** 手動ピンをautoに戻す（source==="manual"のエントリのみ） */
  onReturnToAuto: (entryId: string) => void;
  /** ピン解除してcontextから完全除去 */
  onRemove: (entryId: string) => void;
  /** autoエントリをcontextから即時除去 */
  onRemoveAuto: (entryId: string) => void;
  onPin: (entryId: string) => Promise<void>;
  /** via表示の子エントリを一時的に非表示にする */
  onDismissViaChild?: (childId: string) => void;
  dismissedViaChildIds?: Set<string>;
  pinnedSnippetIds: Set<string>;
  onPinEntry: (entryId: string, type?: "codex" | "snippet") => void;
  onUnpinEntry: (entryId: string) => void;
  onTogglePinChildren: (entryId: string, withChildren: boolean) => void;
  contextTokenCount: number;
  contextLayers: LayerBreakdown[];
  systemPrompt: string;
  model: string;
  agentMode?: boolean;
  canUseCreator?: boolean;
}

export function ContextBar({
  pinnedEntries,
  detectedEntries = [],
  alwaysEntries = [],
  pinnedSnippets = [],
  onReturnToAuto,
  onRemove,
  onRemoveAuto,
  onPin,
  onDismissViaChild,
  dismissedViaChildIds,
  pinnedSnippetIds,
  onPinEntry,
  onUnpinEntry,
  onTogglePinChildren,
  contextTokenCount,
  contextLayers,
  systemPrompt,
  model,
  agentMode = false,
  canUseCreator = false,
}: ContextBarProps) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const [collapsed, setCollapsed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const pinContainerRef = useRef<HTMLDivElement>(null);
  const typeColorMap = useCodexHighlightStore((s) => s.typeColorMap);
  const allCodexEntries = useCodexStore((s) => s.entries);

  // via表示の子エントリを計算（既に pinned/detected/always に含まれるものと dismissed は除外）
  const alreadyShownIds = new Set([
    ...pinnedEntries.map((e) => e.id),
    ...detectedEntries.map((e) => e.id),
    ...alwaysEntries.map((e) => e.id),
  ]);
  const dismissedSet = dismissedViaChildIds ?? new Set<string>();
  const viaChildren: ViaChild[] = pinnedEntries.flatMap((entry) => {
    if (!entry.withChildren) return [];
    return getChildrenFromArray(entry.id, allCodexEntries)
      .filter((c) => !alreadyShownIds.has(c.id) && !dismissedSet.has(c.id))
      .map((c) => ({
        child: c,
        viaParentId: entry.id,
        viaParentName: entry.name,
      }));
  });

  // Codex エントリ hover ポップオーバー
  const [hoveredEntry, setHoveredEntry] = useState<{
    entry: CodexEntry;
    rect: DOMRect;
  } | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  const handleEntryMouseEnter = useCallback(
    (entry: CodexEntry, e: MouseEvent<HTMLElement>) => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setHoveredEntry({ entry, rect });
    },
    [],
  );

  const handleEntryMouseLeave = useCallback(() => {
    hideTimerRef.current = setTimeout(() => {
      setHoveredEntry(null);
    }, 200);
  }, []);

  function handleOpenInCodex(entryId: string) {
    setHoveredEntry(null);
    useLayoutStore.getState().showPanel("codex");
    useCodexStore.getState().requestSelectEntry(entryId);
  }

  const allContextEntries = [
    ...pinnedEntries,
    ...detectedEntries,
    ...alwaysEntries,
    ...viaChildren.map((vc) => vc.child),
  ];
  const useGrouping =
    allContextEntries.length + pinnedSnippets.length > GROUP_THRESHOLD;

  // type別グループマップ（pinned + via + auto を統合、pinned が先頭）
  type MergedGroup = {
    pinned: PinnedCodexEntryWithData[];
    auto: CodexEntry[];
    via: ViaChild[];
  };
  const groupMap = new Map<string, MergedGroup>();
  if (useGrouping) {
    for (const entry of pinnedEntries) {
      const g = groupMap.get(entry.type) ?? { pinned: [], auto: [], via: [] };
      g.pinned.push(entry);
      groupMap.set(entry.type, g);
    }
    for (const entry of [...detectedEntries, ...alwaysEntries]) {
      const g = groupMap.get(entry.type) ?? { pinned: [], auto: [], via: [] };
      g.auto.push(entry);
      groupMap.set(entry.type, g);
    }
    for (const vc of viaChildren) {
      const g = groupMap.get(vc.child.type) ?? {
        pinned: [],
        auto: [],
        via: [],
      };
      g.via.push(vc);
      groupMap.set(vc.child.type, g);
    }
  }

  const pinnedIds = pinnedEntries.map((e) => e.id);

  async function handleCreatorSearch(
    instruction: string,
  ): Promise<SuggestedEntry[]> {
    return runContextCreator(instruction, pinnedIds, model);
  }

  async function handleCreatorAddSelected(
    entries: SuggestedEntry[],
  ): Promise<void> {
    for (const entry of entries) {
      await onPin(entry.id);
    }
  }

  const l3 = contextLayers.find((l) => l.layer === "L3");
  const sceneTokens = l3?.used ?? 0;

  const ctxWindowLabel = model
    ? formatContextWindow(getModelCapabilities(model).contextWindow)
    : null;

  return (
    <>
      <div className="border-b border-border" data-testid="context-bar">
        {/* ヘッダー行: クリックで折りたたみ */}
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-1 text-xs text-muted-foreground hover:bg-muted/30"
        >
          <span className="flex items-center gap-1.5 font-medium">
            Context
            {agentMode && (
              <span className="inline-flex items-center gap-0.5 rounded bg-violet-500/15 px-1.5 py-0.5 text-xs font-medium text-violet-600 dark:text-violet-400">
                <Bot className="h-3 w-3" />
                Agent
              </span>
            )}
          </span>
          <div className="flex items-center gap-2">
            {contextTokenCount > 0 && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPreviewOpen(true);
                  }}
                  className="rounded bg-muted px-1.5 py-0.5 text-xs hover:bg-accent"
                  title={t("chat.context.showPrompt")}
                >
                  ~{contextTokenCount.toLocaleString()} tokens
                </button>
                {ctxWindowLabel && (
                  <span className="text-xs text-muted-foreground/60">
                    / {ctxWindowLabel}
                  </span>
                )}
              </div>
            )}
            {collapsed ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronUp className="h-3 w-3" />
            )}
          </div>
        </button>

        {/* ピル行 */}
        {!collapsed && (
          <div className="flex items-start px-4 pb-1.5">
            {/* エントリピル（折り返し可） */}
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
              {/* L1: Project (常に存在するなら表示) */}
              {contextLayers.find((l) => l.layer === "L1" && l.used > 0) && (
                <span
                  className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                  title={t("chat.context.projectInfo")}
                >
                  Project
                </span>
              )}
              {/* L3: Scene + トークン数 */}
              {sceneTokens > 0 && (
                <span
                  className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                  title={t("chat.context.sceneTokens", {
                    count: sceneTokens.toLocaleString(),
                  })}
                >
                  Scene: {sceneTokens.toLocaleString()}
                </span>
              )}
              {/* Codex エントリ: グループ時は pinned + via + auto を統合 */}
              <AnimatePresence>
                {useGrouping
                  ? Array.from(groupMap.entries())
                      .sort(([a], [b]) => {
                        const oa = TYPE_ORDER.indexOf(a);
                        const ob = TYPE_ORDER.indexOf(b);
                        return (
                          (oa === -1 ? TYPE_ORDER.length : oa) -
                          (ob === -1 ? TYPE_ORDER.length : ob)
                        );
                      })
                      .map(([type, group], i) => (
                        <motion.div
                          key={type}
                          style={{ display: "inline-flex" }}
                          initial={{ opacity: 0, scale: 0.85 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.85 }}
                          transition={
                            reduced
                              ? { duration: 0 }
                              : {
                                  duration: DURATIONS.fast,
                                  ease: EASINGS.easeOut,
                                  delay: i * 0.03,
                                }
                          }
                        >
                          <ContextPillGroup
                            type={type}
                            label={getTypeLabel(type)}
                            pinnedEntries={group.pinned}
                            autoEntries={group.auto}
                            viaEntries={group.via.map((vc) => ({
                              child: vc.child,
                              parentName: vc.viaParentName,
                            }))}
                            onReturnToAuto={onReturnToAuto}
                            onRemove={onRemove}
                            onRemoveAuto={onRemoveAuto}
                            onPin={onPin}
                            onDismissVia={onDismissViaChild}
                            resolvedColor={typeColorMap[type]}
                          />
                        </motion.div>
                      ))
                  : pinnedEntries.map((entry, i) => {
                      const rc = typeColorMap[entry.type];
                      const isManual = entry.pinSource === "manual";
                      return (
                        <motion.span
                          key={entry.id}
                          className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs"
                          initial={{ opacity: 0, scale: 0.85 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.85 }}
                          transition={
                            reduced
                              ? { duration: 0 }
                              : {
                                  duration: DURATIONS.fast,
                                  ease: EASINGS.easeOut,
                                  delay: i * 0.03,
                                }
                          }
                          style={
                            rc
                              ? { backgroundColor: rc.hl, color: rc.fg }
                              : undefined
                          }
                          onMouseEnter={(e) => handleEntryMouseEnter(entry, e)}
                          onMouseLeave={handleEntryMouseLeave}
                        >
                          {entry.name}
                          {isManual && (
                            <button
                              type="button"
                              onClick={() => onReturnToAuto(entry.id)}
                              className="hover:text-foreground text-muted-foreground/70"
                              aria-label={t("chat.context.returnToAuto", {
                                name: entry.name,
                              })}
                            >
                              <Undo2 className="h-3 w-3" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => onRemove(entry.id)}
                            className="hover:text-destructive"
                            aria-label={t("chat.context.unpinEntry", {
                              name: entry.name,
                            })}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </motion.span>
                      );
                    })}
              </AnimatePresence>
              {/* via子エントリ（非グループ時）: 通常ピルと同スタイル + via表示 */}
              {!useGrouping &&
                viaChildren.map(({ child, viaParentId, viaParentName }) => {
                  const rc = typeColorMap[child.type];
                  return (
                    <span
                      key={`via-${viaParentId}-${child.id}`}
                      className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs"
                      style={
                        rc
                          ? { backgroundColor: rc.hl, color: rc.fg }
                          : undefined
                      }
                      onMouseEnter={(e) => handleEntryMouseEnter(child, e)}
                      onMouseLeave={handleEntryMouseLeave}
                    >
                      {child.name}
                      <span className="text-muted-foreground/70">
                        via {viaParentName}
                      </span>
                      <button
                        type="button"
                        onClick={() => onPin(child.id)}
                        className="hover:text-foreground text-muted-foreground/70"
                        aria-label={t("chat.context.pinEntry", {
                          name: child.name,
                        })}
                      >
                        <Pin className="h-3 w-3" />
                      </button>
                      {onDismissViaChild && (
                        <button
                          type="button"
                          onClick={() => onDismissViaChild(child.id)}
                          className="hover:text-destructive"
                          aria-label={t("chat.context.unpinEntry", {
                            name: child.name,
                          })}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </span>
                  );
                })}
              {/* G15: auto entries (非グループ時のみ個別表示) */}
              {!useGrouping &&
                [...detectedEntries, ...alwaysEntries].map((entry) => {
                  const rc = typeColorMap[entry.type];
                  const isDetected = detectedEntries.includes(entry);
                  return (
                    <span
                      key={entry.id}
                      data-testid={isDetected ? "detected-pill" : "always-pill"}
                      className="inline-flex items-center gap-1 rounded-full bg-accent/50 px-2 py-0.5 text-xs"
                      style={
                        rc
                          ? {
                              backgroundColor: rc.hl,
                              color: rc.fg,
                              opacity: 0.75,
                            }
                          : undefined
                      }
                      onMouseEnter={(e) => handleEntryMouseEnter(entry, e)}
                      onMouseLeave={handleEntryMouseLeave}
                    >
                      {entry.name}
                      <span className="text-muted-foreground/70">auto</span>
                      <button
                        type="button"
                        onClick={() => onPin(entry.id)}
                        className="hover:text-foreground text-muted-foreground/70"
                        aria-label={t("chat.context.pinEntry", {
                          name: entry.name,
                        })}
                      >
                        <Pin className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemoveAuto(entry.id)}
                        className="hover:text-destructive text-muted-foreground/70"
                        aria-label={t("chat.context.unpinEntry", {
                          name: entry.name,
                        })}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  );
                })}
              {/* G16: ピン留め Snippet エントリ */}
              {pinnedSnippets.map((snippet) => (
                <span
                  key={snippet.id}
                  className="inline-flex items-center gap-1 rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-800"
                >
                  {snippet.title}
                  <button
                    type="button"
                    onClick={() => onRemove(snippet.id)}
                    className="hover:text-destructive"
                    aria-label={t("chat.context.unpinEntry", {
                      name: snippet.title,
                    })}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
            {/* ピン留め・AIボタン（右端固定） */}
            <div className="ml-1 flex shrink-0 items-center gap-1 py-0.5">
              <div ref={pinContainerRef} className="relative">
                <button
                  type="button"
                  onClick={() => setPinOpen((v) => !v)}
                  className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent"
                  aria-label={t("chat.context.pinCodexSnippet")}
                >
                  <BookOpen className="h-3 w-3" />
                  {t("chat.context.pin")}
                </button>
                <PinCodexDialog
                  open={pinOpen}
                  containerRef={pinContainerRef}
                  pinnedIds={new Set(pinnedEntries.map((e) => e.id))}
                  withChildrenIds={
                    new Set(
                      pinnedEntries
                        .filter((e) => e.withChildren)
                        .map((e) => e.id),
                    )
                  }
                  pinnedSnippetIds={pinnedSnippetIds}
                  onPin={onPinEntry}
                  onUnpin={onUnpinEntry}
                  onToggleChildren={onTogglePinChildren}
                  onClose={() => setPinOpen(false)}
                />
              </div>
              <ContextCreatorButton
                onClick={() => setCreatorOpen(true)}
                disabled={!canUseCreator}
              />
            </div>
          </div>
        )}

        {/* ContextCreator ダイアログ (ピル行の下に展開) */}
        {!collapsed && creatorOpen && (
          <ContextCreatorDialog
            onSearch={handleCreatorSearch}
            onAddSelected={handleCreatorAddSelected}
            onClose={() => setCreatorOpen(false)}
          />
        )}
      </div>

      {previewOpen && (
        <PromptPreviewModal
          systemPrompt={systemPrompt}
          layers={contextLayers}
          totalTokens={contextTokenCount}
          onClose={() => setPreviewOpen(false)}
        />
      )}

      {/* Codex エントリ hover ポップオーバー */}
      {hoveredEntry &&
        createPortal(
          <div
            className="fixed z-50 w-64 rounded-lg border border-border bg-popover p-3 shadow-md"
            style={{
              left: hoveredEntry.rect.left,
              top: hoveredEntry.rect.bottom + 4,
            }}
            onMouseEnter={() => {
              if (hideTimerRef.current) {
                clearTimeout(hideTimerRef.current);
                hideTimerRef.current = null;
              }
            }}
            onMouseLeave={() => setHoveredEntry(null)}
          >
            <CodexEntryPopoverContent
              entry={hoveredEntry.entry}
              dotColor={typeColorMap[hoveredEntry.entry.type]?.fg ?? "#888888"}
              typeLabel={getTypeLabel(hoveredEntry.entry.type)}
              onOpenInCodex={() => handleOpenInCodex(hoveredEntry.entry.id)}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

/** chatStore から systemPrompt を取得するためのラッパー */
export function ContextBarConnected(
  props: Omit<ContextBarProps, "systemPrompt">,
) {
  const systemPrompt = useChatStore((s) => s.lastSystemPrompt);
  return <ContextBar {...props} systemPrompt={systemPrompt} />;
}
