import {
  useState,
  useRef,
  useLayoutEffect,
  useEffect,
  useCallback,
} from "react";
import { motion, AnimatePresence } from "motion/react";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";
import { useTranslation } from "react-i18next";
import {
  X,
  BookOpen,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Spotlight,
  Undo2,
  Bot,
  ScrollText,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import { estimateInputCost, formatCost } from "../modelPricing";
import { getTypeLabel } from "../utils/typeLabels";
import { ContextPillGroup } from "./ContextPillGroup";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { getChildrenFromArray } from "@/features/codex/childrenBudget";
import { CodexPill } from "@/features/codex/components/CodexPill";
import { useCodexStore } from "@/features/codex/codexStore";
import { PinCodexDialog } from "./PinCodexDialog";

const TYPE_ORDER = ["character", "location", "item", "lore"];
const GROUP_THRESHOLD = 6; // DOM未マウント / テスト環境用フォールバック
// Zustand selector で `?? []` を返すと毎回新規参照になるので、モジュール定数で
// fallback して再レンダー無限ループを避ける。
const EMPTY_CHAPTER_OUTLINES: ReadonlyArray<{
  title: string;
  outline: string;
}> = [];

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
  /** auto エントリのうち ✨ Spotlight 候補としてマークする ID 集合 */
  spotlightCandidateIds?: ReadonlySet<string>;
  onPinEntry: (entryId: string, type?: "codex" | "snippet") => void;
  onUnpinEntry: (entryId: string) => void;
  onTogglePinChildren: (entryId: string, withChildren: boolean) => void;
  contextTokenCount: number;
  contextLayers: LayerBreakdown[];
  systemPrompt: string;
  model: string;
  agentMode?: boolean;
  canUseCreator?: boolean;
  /** Phase 4 後続: AI に注入される project outline 全文（trim 済み・空でない場合のみ） */
  projectOutline?: string;
  /** Phase 4 後続: 祖先 chapter の outline（outermost → innermost 順） */
  chapterOutlines?: ReadonlyArray<{ title: string; outline: string }>;
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
  spotlightCandidateIds,
  onPinEntry,
  onUnpinEntry,
  onTogglePinChildren,
  contextTokenCount,
  contextLayers,
  systemPrompt,
  model,
  agentMode = false,
  canUseCreator = false,
  projectOutline,
  chapterOutlines = EMPTY_CHAPTER_OUTLINES,
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

  // 幅ベースのグルーピング判定
  const pillsColumnRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [useGrouping, setUseGrouping] = useState(false);

  const totalPillCount =
    pinnedEntries.length +
    detectedEntries.length +
    alwaysEntries.length +
    viaChildren.length +
    pinnedSnippets.length;

  const checkGrouping = useCallback(() => {
    const col = pillsColumnRef.current;
    const measure = measureRef.current;
    if (!col || !measure || col.clientWidth === 0) {
      // DOM未マウント / テスト環境: カウント閾値にフォールバック
      setUseGrouping((prev) => {
        const next = totalPillCount > GROUP_THRESHOLD;
        return prev === next ? prev : next;
      });
      return;
    }
    // offsetWidth は max-content 幅で確実に計測できる（scrollWidth は overflow:visible で不安定）
    const overflows = measure.offsetWidth > col.clientWidth;
    setUseGrouping((prev) => (prev === overflows ? prev : overflows));
  }, [totalPillCount]);

  // レンダー後に毎回チェック（exit アニメーション中の要素も含めた幅を正確に測定）
  useLayoutEffect(() => {
    checkGrouping();
  });

  // パネル幅変化にも追従
  useEffect(() => {
    const el = pillsColumnRef.current;
    if (!el) return;
    const ro = new ResizeObserver(checkGrouping);
    ro.observe(el);
    return () => ro.disconnect();
  }, [checkGrouping]);

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
        <div
          role="button"
          tabIndex={0}
          onClick={() => setCollapsed((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setCollapsed((v) => !v);
            }
          }}
          aria-expanded={!collapsed}
          className="flex w-full cursor-pointer items-center justify-between px-4 py-1 text-xs text-muted-foreground hover:bg-muted/30"
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
            {contextTokenCount > 0 &&
              (() => {
                const estimated = estimateInputCost(model, contextTokenCount);
                const costLabel =
                  estimated !== null ? formatCost(estimated) : null;
                return (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPreviewOpen(true);
                      }}
                      className="rounded bg-muted px-1.5 py-0.5 text-xs hover:bg-accent"
                      title={
                        costLabel
                          ? t("chat.context.tokensWithCostTitle", {
                              cost: costLabel,
                            })
                          : t("chat.context.showPrompt")
                      }
                    >
                      ~{contextTokenCount.toLocaleString()} tokens
                      {costLabel && (
                        <span className="ml-1 text-muted-foreground">
                          · ~{costLabel}
                        </span>
                      )}
                    </button>
                    {ctxWindowLabel && (
                      <span className="text-xs text-muted-foreground/60">
                        / {ctxWindowLabel}
                      </span>
                    )}
                  </div>
                );
              })()}
            {collapsed ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronUp className="h-3 w-3" />
            )}
          </div>
        </div>

        {/* ピル行 */}
        {!collapsed && (
          <div className="flex items-start px-4 pb-1.5">
            {/* エントリピル: 外側は幅測定の基準のみ。内側コンテナで overflow-hidden + flex-nowrap */}
            <div ref={pillsColumnRef} className="relative min-w-0 flex-1">
              {/* 幅計測用: フラットモードの全ピルを非表示で描画して scrollWidth を測定 */}
              {/* width: max-content で shrink-to-fit 制約を外し、offsetWidth = 全ピルの自然幅 にする */}
              <div
                ref={measureRef}
                style={{ width: "max-content" }}
                className="pointer-events-none invisible absolute left-0 top-0 flex flex-nowrap items-center gap-1 text-xs"
                aria-hidden="true"
              >
                {contextLayers.find((l) => l.layer === "L1" && l.used > 0) && (
                  <span className="px-1.5 py-0.5">Project</span>
                )}
                {sceneTokens > 0 && (
                  <span className="px-1.5 py-0.5">
                    Scene: {sceneTokens.toLocaleString()}
                  </span>
                )}
                {projectOutline && (
                  <span className="px-1.5 py-0.5">
                    {t("chat.context.projectOutline")}
                  </span>
                )}
                {chapterOutlines.map((co) => (
                  <span key={co.title} className="px-1.5 py-0.5">
                    {t("chat.context.chapterOutline", { title: co.title })}
                  </span>
                ))}
                {pinnedEntries.map((e) => (
                  <span
                    key={e.id}
                    className="inline-flex items-center gap-1 px-2 py-0.5"
                  >
                    {e.name}
                    {e.pinSource === "manual" && (
                      <span className="inline-block h-3 w-3" />
                    )}
                    <span className="inline-block h-3 w-3" />
                  </span>
                ))}
                {viaChildren.map(({ child, viaParentName }) => (
                  <span
                    key={child.id}
                    className="inline-flex items-center gap-1 px-2 py-0.5"
                  >
                    {child.name}
                    <span>via {viaParentName}</span>
                    <span className="inline-block h-3 w-3" />
                    <span className="inline-block h-3 w-3" />
                  </span>
                ))}
                {[...detectedEntries, ...alwaysEntries].map((e) => (
                  <span
                    key={e.id}
                    className="inline-flex items-center gap-1 px-2 py-0.5"
                  >
                    {e.name}
                    <span>auto</span>
                    <span className="inline-block h-3 w-3" />
                    <span className="inline-block h-3 w-3" />
                  </span>
                ))}
                {pinnedSnippets.map((s) => (
                  <span
                    key={s.id}
                    className="inline-flex items-center gap-1 px-2 py-0.5"
                  >
                    {s.title}
                    <span className="inline-block h-3 w-3" />
                  </span>
                ))}
              </div>
              {/* 表示領域: flex-nowrap + 水平スクロール（スクロールバーは no-scrollbar で非表示） */}
              {/* whitespace-nowrap がピル側に付いているので height は膨張しない */}
              <div
                data-testid="pills-visible"
                className="no-scrollbar flex flex-nowrap items-center gap-1 overflow-x-auto overflow-y-hidden"
              >
                {/* L1: Project (常に存在するなら表示) */}
                {contextLayers.find((l) => l.layer === "L1" && l.used > 0) && (
                  <span
                    className="shrink-0 whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                    title={t("chat.context.projectInfo")}
                  >
                    Project
                  </span>
                )}
                {/* L3: Scene + トークン数 */}
                {sceneTokens > 0 && (
                  <span
                    className="shrink-0 whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                    title={t("chat.context.sceneTokens", {
                      count: sceneTokens.toLocaleString(),
                    })}
                  >
                    Scene: {sceneTokens.toLocaleString()}
                  </span>
                )}
                {/* Phase 4 後続: project outline chip — クリックで全文プレビュー */}
                {projectOutline && (
                  <OutlineChip
                    label={t("chat.context.projectOutline")}
                    title={t("chat.context.projectOutlineTitle")}
                    body={projectOutline}
                  />
                )}
                {/* Phase 4 後続: chapter outline chip（祖先順）*/}
                {chapterOutlines.map((co) => (
                  <OutlineChip
                    key={co.title}
                    label={t("chat.context.chapterOutline", {
                      title: co.title,
                    })}
                    title={t("chat.context.chapterOutlineTitle", {
                      title: co.title,
                    })}
                    body={co.outline}
                  />
                ))}
                {/* グループモード: AnimatePresence なし → モード切り替え時に即 DOM 削除 */}
                {/* exit アニメーション要素が溜まらないので height が膨張しない */}
                {useGrouping &&
                  Array.from(groupMap.entries())
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
                        className="shrink-0"
                        style={{ display: "inline-flex" }}
                        initial={{ opacity: 0, scale: 0.85 }}
                        animate={{ opacity: 1, scale: 1 }}
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
                          spotlightCandidateIds={spotlightCandidateIds}
                          onReturnToAuto={onReturnToAuto}
                          onRemove={onRemove}
                          onRemoveAuto={onRemoveAuto}
                          onPin={onPin}
                          onDismissVia={onDismissViaChild}
                          resolvedColor={typeColorMap[type]}
                        />
                      </motion.div>
                    ))}
                {/* 個別モード: AnimatePresence はピン追加/削除アニメーション専用 */}
                {/* !useGrouping が false になった瞬間この AnimatePresence ごと消えるので */}
                {/* exit アニメーション要素は DOM に残らない */}
                {!useGrouping && (
                  <AnimatePresence>
                    {pinnedEntries.map((entry, i) => {
                      const isManual = entry.pinSource === "manual";
                      return (
                        <motion.span
                          key={entry.id}
                          className="inline-flex shrink-0"
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
                          <CodexPill
                            entry={entry}
                            actions={
                              <span className="inline-flex items-center gap-1 pr-1">
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
                              </span>
                            }
                          />
                        </motion.span>
                      );
                    })}
                  </AnimatePresence>
                )}
                {/* via子エントリ（非グループ時）: 通常ピルと同スタイル + via表示 */}
                {!useGrouping &&
                  viaChildren.map(({ child, viaParentId, viaParentName }) => (
                    <CodexPill
                      key={`via-${viaParentId}-${child.id}`}
                      entry={child}
                      suffix={
                        <span className="text-muted-foreground/70">
                          via {viaParentName}
                        </span>
                      }
                      actions={
                        <span className="inline-flex items-center gap-1 pr-1">
                          <button
                            type="button"
                            onClick={() => onPin(child.id)}
                            className="hover:text-foreground text-muted-foreground/70"
                            aria-label={t("chat.context.pinEntry", {
                              name: child.name,
                            })}
                          >
                            <Spotlight className="h-3 w-3" />
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
                      }
                    />
                  ))}
                {/* G15: auto entries (非グループ時のみ個別表示) */}
                {!useGrouping &&
                  [...detectedEntries, ...alwaysEntries].map((entry) => {
                    const isCandidate =
                      spotlightCandidateIds?.has(entry.id) ?? false;
                    return (
                      <CodexPill
                        key={entry.id}
                        entry={entry}
                        dim
                        suffix={
                          isCandidate ? (
                            <span className="inline-flex items-center gap-0.5 text-muted-foreground/70">
                              <Sparkles className="h-3 w-3" />
                              {t("chat.context.spotlightCandidate")}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/70">
                              auto
                            </span>
                          )
                        }
                        actions={
                          <span className="inline-flex items-center gap-1 pr-1">
                            <button
                              type="button"
                              onClick={() => onPin(entry.id)}
                              className="hover:text-foreground text-muted-foreground/70"
                              aria-label={t("chat.context.pinEntry", {
                                name: entry.name,
                              })}
                            >
                              <Spotlight className="h-3 w-3" />
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
                        }
                      />
                    );
                  })}
                {/* G16: ピン留め Snippet エントリ */}
                {pinnedSnippets.map((snippet) => (
                  <span
                    key={snippet.id}
                    className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-purple-100 px-2 py-0.5 text-xs text-purple-800"
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
              {/* /pills-visible */}
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
          model={model}
          onClose={() => setPreviewOpen(false)}
        />
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

interface OutlineChipProps {
  label: string;
  title: string;
  body: string;
}

function OutlineChip({ label, title, body }: OutlineChipProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent"
          title={title}
        >
          <ScrollText className="h-3 w-3" />
          <span className="max-w-[14ch] truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-80 max-w-[min(24rem,calc(100vw-1rem))]"
      >
        <div className="mb-1.5 text-xs font-medium text-muted-foreground">
          {title}
        </div>
        <div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">
          {body}
        </div>
      </PopoverContent>
    </Popover>
  );
}
