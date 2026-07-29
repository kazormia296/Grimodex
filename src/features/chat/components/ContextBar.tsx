import {
  useState,
  useRef,
  useLayoutEffect,
  useEffect,
  useCallback,
} from "react";
import { recordCounter } from "@/lib/perfLog";
import { motion, AnimatePresence } from "motion/react";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";
import { useTranslation } from "react-i18next";
import {
  X,
  AlertTriangle,
  BookOpen,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Spotlight,
  Undo2,
  ScrollText,
  Crosshair,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { CodexEntry, CodexContextEntry } from "@/features/codex/api";
import type {
  PinnedCodexEntryWithData,
  PinnedSnippetEntryWithData,
  PinnedStickyEntryWithData,
} from "../chatApi";
import type { LayerBreakdown } from "../contextBuilder";
import type { ChatContextPlan } from "../context/types";
import { PromptPreviewModal } from "./PromptPreviewModal";
import { ContextCreatorButton } from "./ContextCreatorButton";
import { ContextCreatorDialog } from "./ContextCreatorDialog";
import { runContextCreator, type SuggestedEntry } from "../contextCreatorApi";
import { useChatStore, type ChatPromptPreviewResult } from "../chatStore";
import type { ResolvedChatTurnRoute } from "../turn/resolveTurnRoute";
import { useAiSettingsStore } from "../store";
import {
  formatContextWindow,
  resolveModelCapabilities,
} from "../agent/modelLimits";
import type { AiProvider } from "../types";
import { estimateInputCost, formatCost } from "../modelPricing";
import { CircularProgress } from "@/components/ui/circular-progress";
import { getTypeLabel } from "../utils/typeLabels";
import { ContextPillGroup } from "./ContextPillGroup";
import { useCodexHighlightStore } from "@/features/editor/codexHighlightStore";
import { getChildrenFromArray } from "@/features/codex/childrenBudget";
import {
  CodexPill,
  type CodexPillEntry,
} from "@/features/codex/components/CodexPill";
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
  /**
   * プレビューを所有する workspace / project / scope / session の immutable
   * snapshot。値が変わった時点で、構築中・表示中の旧プレビューを失効させる。
   */
  previewAuthorityKey: string;
  /**
   * codex/snippet スコープのアンカー (= この会話の主題)。固定・削除不可の
   * 専用チップとして先頭付近に表示し、プロンプトの <focus_subject> 注入対象と
   * 一致させる。scene/folder/project スコープでは null。
   */
  scopeAnchor?:
    | { kind: "codex"; id: string; name: string }
    | { kind: "snippet"; id: string; title: string }
    | null;
  pinnedEntries: PinnedCodexEntryWithData[];
  /** 永続化済みの manual Codex Spotlight。picker の checked 正本。 */
  pinnedCodexIds: Set<string>;
  /** Last materialized plan is the display authority. Source arrays describe
   * candidates only and may contain budget-trimmed or policy-excluded rows. */
  contextPlan?: ChatContextPlan | null;
  /** G15: auto-detected entries (excluding pinned)。M10: icon なし projection 行 */
  detectedEntries?: CodexContextEntry[];
  /** G15: always-mode entries (excluding pinned and detected) */
  alwaysEntries?: CodexContextEntry[];
  /** G16: pinned snippet entries */
  pinnedSnippets?: PinnedSnippetEntryWithData[];
  /**
   * Map Sticky を「Spotlight」した一時注入。ユーザー向け表記は
   * Spotlight だが、DB / API は pin と同じテーブル (sticky_id 列) を
   * 使うため命名は pinnedStickies のまま。
   */
  pinnedStickies?: PinnedStickyEntryWithData[];
  onUnpinSticky?: (stickyId: string) => void | Promise<void>;
  /** 手動ピンをautoに戻す（source==="manual"のエントリのみ） */
  onReturnToAuto: (entryId: string) => void;
  /** ピン解除してcontextから完全除去 */
  onRemove: (entryId: string) => void;
  /** autoエントリをcontextから即時除去 */
  onRemoveAuto: (entryId: string) => void;
  onPin: (entryId: string) => Promise<void>;
  onPinBatch?: (entryIds: readonly string[]) => Promise<boolean>;
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
  contextWindowOverride?: number | null;
  contextLayers: LayerBreakdown[];
  systemPrompt: string;
  model: string;
  /** provider namespace paired with model/contextWindowOverride. */
  provider?: AiProvider | null;
  canUseCreator?: boolean;
  /** Conversation/composer route used only when the Context Creator role is unset. */
  creatorFallbackRoute?: ResolvedChatTurnRoute | null;
  /** Phase 4 後続: AI に注入される project outline 全文（trim 済み・空でない場合のみ） */
  projectOutline?: string;
  /** Phase 4 後続: 祖先 chapter の outline（outermost → innermost 順） */
  chapterOutlines?: ReadonlyArray<{ title: string; outline: string }>;
  summaryCount?: number;
  maxSummaryGeneration?: number;
  onCreateLinkedSession?: () => void;
  /** セッション切替・メッセージ読込・生成中は Spotlight 変更を禁止する。 */
  spotlightDisabled?: boolean;
  cacheInvalidatedReason?: "model" | "instructions" | "budget" | null;
  onDismissCacheInvalidated?: () => void;
}

export function ContextBar({
  previewAuthorityKey,
  scopeAnchor = null,
  pinnedEntries: candidatePinnedEntries,
  pinnedCodexIds,
  contextPlan = null,
  detectedEntries: candidateDetectedEntries = [],
  alwaysEntries: candidateAlwaysEntries = [],
  pinnedSnippets: candidatePinnedSnippets = [],
  pinnedStickies: candidatePinnedStickies = [],
  onUnpinSticky,
  onReturnToAuto,
  onRemove,
  onRemoveAuto,
  onPin,
  onPinBatch,
  onDismissViaChild,
  dismissedViaChildIds,
  pinnedSnippetIds,
  spotlightCandidateIds,
  onPinEntry,
  onUnpinEntry,
  onTogglePinChildren,
  contextTokenCount,
  contextWindowOverride,
  contextLayers,
  systemPrompt,
  model,
  provider = null,
  canUseCreator = false,
  creatorFallbackRoute = null,
  projectOutline,
  chapterOutlines = EMPTY_CHAPTER_OUTLINES,
  summaryCount = 0,
  maxSummaryGeneration = 0,
  onCreateLinkedSession,
  spotlightDisabled = false,
  cacheInvalidatedReason,
  onDismissCacheInvalidated,
}: ContextBarProps) {
  const { t } = useTranslation();
  useEffect(() => {
    recordCounter("chat.contextBar.commit");
  });
  const reduced = useReducedMotion();
  // 動的 capability レジストリ更新時に contextWindow 表示を再計算する
  useAiSettingsStore((s) => s.modelCapsRevision);
  const aiSettings = useAiSettingsStore((s) => s.settings);
  const [collapsed, setCollapsed] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  // プレビューを開いたときに related_scenes（意味検索）込みでプロンプトを
  // 組み直した結果。null = まだ構築前。exact 構築不能時は unavailable を保持し、
  // live-estimate cache をプレビューへ流用しない。
  const [previewData, setPreviewData] =
    useState<ChatPromptPreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const buildPreviewPrompt = useChatStore((s) => s.buildPreviewPrompt);
  const previewRequestGenerationRef = useRef(0);
  const latestPreviewAuthorityKeyRef = useRef(previewAuthorityKey);
  latestPreviewAuthorityKeyRef.current = previewAuthorityKey;

  const closePreview = useCallback(() => {
    previewRequestGenerationRef.current += 1;
    setPreviewOpen(false);
    setPreviewData(null);
    setPreviewLoading(false);
  }, []);

  useLayoutEffect(() => {
    previewRequestGenerationRef.current += 1;
    setPreviewOpen(false);
    setPreviewData(null);
    setPreviewLoading(false);
    return () => {
      // unmount と authority change の cleanup は、未解決 request の callback
      // より先に ownership を破棄する。state は cleanup では更新しない。
      previewRequestGenerationRef.current += 1;
    };
  }, [previewAuthorityKey]);

  // プレビューを開く: related_scenes はメッセージ依存で送信時のみ計算される
  // ため、開いた瞬間に1回検索を走らせて RAG 込みのプロンプトを構築する。
  const openPreview = useCallback(() => {
    const requestGeneration = ++previewRequestGenerationRef.current;
    const requestAuthorityKey = previewAuthorityKey;
    const ownsPreview = () =>
      previewRequestGenerationRef.current === requestGeneration &&
      latestPreviewAuthorityKeyRef.current === requestAuthorityKey;
    setPreviewData(null);
    setPreviewLoading(true);
    setPreviewOpen(true);
    void buildPreviewPrompt()
      .then((data) => {
        if (ownsPreview()) setPreviewData(data);
      })
      .catch(() => {
        if (!ownsPreview()) return;
        setPreviewData({
          status: "unavailable",
          prompt: "",
          layers: [],
          totalTokens: 0,
          userMessage: "",
        });
      })
      .finally(() => {
        if (ownsPreview()) setPreviewLoading(false);
      });
  }, [buildPreviewPrompt, previewAuthorityKey]);

  const [creatorOpen, setCreatorOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const pinContainerRef = useRef<HTMLDivElement>(null);
  const typeColorMap = useCodexHighlightStore((s) => s.typeColorMap);
  const allCodexEntries = useCodexStore((s) => s.entries);

  useEffect(() => {
    if (!spotlightDisabled) return;
    setPinOpen(false);
    setCreatorOpen(false);
  }, [spotlightDisabled]);

  const selectedPlanKeys = contextPlan
    ? new Set(contextPlan.items.map((item) => item.key))
    : null;
  const isSelected = (kind: string, id: string) =>
    selectedPlanKeys === null || selectedPlanKeys.has(`${kind}:${id}`);
  const pinnedEntries = candidatePinnedEntries.filter((entry) =>
    isSelected("codex", entry.id),
  );
  const detectedEntries = candidateDetectedEntries.filter((entry) =>
    isSelected("codex", entry.id),
  );
  const alwaysEntries = candidateAlwaysEntries.filter((entry) =>
    isSelected("codex", entry.id),
  );
  const pinnedSnippets = candidatePinnedSnippets.filter((entry) =>
    isSelected("snippet", entry.id),
  );
  const pinnedStickies = candidatePinnedStickies.filter((entry) =>
    isSelected("sticky", entry.id),
  );

  // M10: detected/always は icon 列を持たない projection 行。ピルのホバー
  // ポップオーバーに出すアイコンは codexStore の全列行から補完する
  // (store 未 hydrate 時は従来の色ドット表示にフォールバック)。
  const fullEntryById = new Map(allCodexEntries.map((e) => [e.id, e]));
  const toPillEntry = (e: CodexContextEntry): CodexPillEntry =>
    fullEntryById.get(e.id) ?? e;

  // via表示の子エントリを計算（既に pinned/detected/always に含まれるものと dismissed は除外）
  const alreadyShownIds = new Set([
    ...pinnedEntries.map((e) => e.id),
    ...detectedEntries.map((e) => e.id),
    ...alwaysEntries.map((e) => e.id),
  ]);
  const dismissedSet = dismissedViaChildIds ?? new Set<string>();
  const viaChildren: ViaChild[] = candidatePinnedEntries.flatMap((entry) => {
    if (!entry.withChildren) return [];
    return getChildrenFromArray(entry.id, allCodexEntries)
      .filter(
        (c) =>
          isSelected("codex", c.id) &&
          !alreadyShownIds.has(c.id) &&
          !dismissedSet.has(c.id),
      )
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

  // 内容（ピル数）が変わったら再判定。幅変化は ResizeObserver で追従する。
  // deps なしで毎レンダー実行すると、commit-phase の setState がネストし
  // "Maximum update depth exceeded" を踏むことがある（レイアウトプリセット切替時等）。
  useLayoutEffect(() => {
    checkGrouping();
  }, [checkGrouping]);

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
    auto: CodexPillEntry[];
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
      g.auto.push(toPillEntry(entry));
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

  // Mutation controls reflect persisted candidate state; only the visible pill
  // projection is plan-filtered.
  const pinnedIds = candidatePinnedEntries.map((entry) => entry.id);

  async function handleCreatorSearch(
    instruction: string,
  ): Promise<SuggestedEntry[]> {
    return runContextCreator(instruction, pinnedIds, creatorFallbackRoute);
  }

  async function handleCreatorAddSelected(
    entries: SuggestedEntry[],
  ): Promise<boolean> {
    const entryIds = entries.map((entry) => entry.id);
    if (onPinBatch) {
      return onPinBatch(entryIds);
    }
    await Promise.all(entryIds.map((entryId) => onPin(entryId)));
    return true;
  }

  const l3 = contextLayers.find((l) => l.layer === "L3");
  const sceneTokens = l3?.used ?? 0;

  // codex/snippet スコープのアンカー (この会話の主題) を表す固定チップのラベル。
  // ヘッダのスコープピッカーと同じ語彙 (chat.scope.codex / chat.scope.snippet)。
  const scopeAnchorLabel = scopeAnchor
    ? scopeAnchor.kind === "codex"
      ? `${t("chat.scope.codex")}: ${scopeAnchor.name}`
      : `${t("chat.scope.snippet")}: ${scopeAnchor.title}`
    : null;

  const contextWindow =
    contextWindowOverride !== undefined
      ? contextWindowOverride
      : model
        ? resolveModelCapabilities(
            model,
            aiSettings && provider
              ? { ...aiSettings, provider, model }
              : aiSettings,
          ).contextWindow
        : 0;
  const ctxWindowLabel =
    model && contextWindow !== null ? formatContextWindow(contextWindow) : null;
  const windowFillPct =
    contextWindow !== null && contextWindow > 0
      ? Math.min(100, Math.round((contextTokenCount / contextWindow) * 100))
      : null;
  const windowFillStroke =
    windowFillPct === null
      ? null
      : windowFillPct >= 80
        ? "stroke-destructive"
        : windowFillPct >= 50
          ? "stroke-amber-500"
          : "stroke-primary";
  const omittedDecisions = (contextPlan?.decisions ?? [])
    .filter((decision) => decision.status !== "selected")
    .sort((left, right) => {
      const statusOrder = { unavailable: 0, trimmed: 1, excluded: 2 } as const;
      return (
        statusOrder[left.status as keyof typeof statusOrder] -
          statusOrder[right.status as keyof typeof statusOrder] ||
        left.key.localeCompare(right.key) ||
        left.reason.localeCompare(right.reason)
      );
    });
  const omittedDecisionCounts = {
    unavailable: omittedDecisions.filter(
      (decision) => decision.status === "unavailable",
    ).length,
    trimmed: omittedDecisions.filter(
      (decision) => decision.status === "trimmed",
    ).length,
    excluded: omittedDecisions.filter(
      (decision) => decision.status === "excluded",
    ).length,
  };

  return (
    <>
      <div
        className="border-b border-border"
        data-testid="context-bar"
        data-tour-target="chat-context-bar"
      >
        {/* ヘッダー行: 左側の独立ボタンで折りたたみ */}
        <div className="flex w-full items-center justify-between px-4 py-1 text-xs text-muted-foreground hover:bg-muted/30">
          <button
            type="button"
            data-testid="context-bar-toggle"
            onClick={() => setCollapsed((value) => !value)}
            aria-expanded={!collapsed}
            className="flex min-w-0 flex-1 items-center justify-between self-stretch pr-2 text-left hover:text-foreground"
          >
            <span className="flex items-center gap-1.5 font-medium">
              {t("chat.context.heading")}
            </span>
            {collapsed ? (
              <ChevronDown className="h-3 w-3" aria-hidden />
            ) : (
              <ChevronUp className="h-3 w-3" aria-hidden />
            )}
          </button>
          <div className="flex items-center gap-2">
            {(summaryCount > 3 || maxSummaryGeneration > 3) &&
              onCreateLinkedSession && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCreateLinkedSession();
                  }}
                  className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-700 hover:bg-amber-500/25 dark:text-amber-300"
                  title={t("chat.context.multiSummaryWarning", {
                    count: Math.max(summaryCount, maxSummaryGeneration),
                  })}
                >
                  <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
                  {t("chat.context.multiSummaryWarning", {
                    count: Math.max(summaryCount, maxSummaryGeneration),
                  })}
                </button>
              )}
            {cacheInvalidatedReason && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDismissCacheInvalidated?.();
                }}
                className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-300"
                title={
                  cacheInvalidatedReason === "model"
                    ? t("chat.context.cacheRebuiltModel")
                    : cacheInvalidatedReason === "instructions"
                      ? t("chat.context.cacheRebuiltInstructions")
                      : t("chat.context.cacheRebuiltBudget")
                }
              >
                <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
                {t("chat.context.cacheRebuilt")}{" "}
                {cacheInvalidatedReason === "model"
                  ? t("chat.context.cacheRebuiltModel")
                  : cacheInvalidatedReason === "instructions"
                    ? t("chat.context.cacheRebuiltInstructions")
                    : t("chat.context.cacheRebuiltBudget")}
              </button>
            )}
            {omittedDecisions.length > 0 && (
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    data-testid="context-decision-summary"
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                    className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-700 hover:bg-amber-500/25 dark:text-amber-300"
                    aria-label={t("chat.context.decisionSummary", {
                      count: omittedDecisions.length,
                    })}
                    title={t("chat.context.decisionSummary", {
                      count: omittedDecisions.length,
                    })}
                  >
                    <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
                    {t("chat.context.decisionSummary", {
                      count: omittedDecisions.length,
                    })}
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  sideOffset={6}
                  data-testid="context-decision-popover"
                  className="w-96 max-w-[min(28rem,calc(100vw-1rem))]"
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="mb-2 text-xs font-medium text-foreground">
                    {t("chat.context.decisionSummaryTitle")}
                  </div>
                  <div className="mb-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                    {omittedDecisionCounts.unavailable > 0 && (
                      <span>
                        {t("chat.context.decisionUnavailable")}:{" "}
                        {omittedDecisionCounts.unavailable}
                      </span>
                    )}
                    {omittedDecisionCounts.trimmed > 0 && (
                      <span>
                        {t("chat.context.decisionTrimmed")}:{" "}
                        {omittedDecisionCounts.trimmed}
                      </span>
                    )}
                    {omittedDecisionCounts.excluded > 0 && (
                      <span>
                        {t("chat.context.decisionExcluded")}:{" "}
                        {omittedDecisionCounts.excluded}
                      </span>
                    )}
                  </div>
                  <ul className="max-h-64 space-y-1.5 overflow-y-auto text-[11px]">
                    {omittedDecisions.slice(0, 8).map((decision, index) => (
                      <li
                        key={`${decision.status}:${decision.key}:${decision.reason}:${index}`}
                        className="rounded bg-muted/60 px-2 py-1.5"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <code className="break-all text-foreground">
                            {decision.key}
                          </code>
                          <span className="shrink-0 text-muted-foreground">
                            {decision.status === "unavailable"
                              ? t("chat.context.decisionUnavailable")
                              : decision.status === "trimmed"
                                ? t("chat.context.decisionTrimmed")
                                : t("chat.context.decisionExcluded")}
                          </span>
                        </div>
                        <div className="mt-0.5 break-all text-muted-foreground">
                          {decision.reason} · {decision.tokensBefore}
                          {" → "}
                          {decision.tokensAfter} tokens
                        </div>
                      </li>
                    ))}
                  </ul>
                  {omittedDecisions.length > 8 && (
                    <div className="mt-2 text-[11px] text-muted-foreground">
                      {t("chat.context.decisionMore", {
                        count: omittedDecisions.length - 8,
                      })}
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            )}
            {contextTokenCount > 0 &&
              (() => {
                const estimated = estimateInputCost(
                  model,
                  contextTokenCount,
                  provider,
                );
                const costLabel =
                  estimated !== null ? formatCost(estimated) : null;
                return (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      data-tour-target="chat-tokens-badge"
                      onClick={(e) => {
                        e.stopPropagation();
                        openPreview();
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
                    {windowFillPct !== null && windowFillStroke && (
                      <div
                        role="progressbar"
                        data-tour-target="chat-context-progress"
                        aria-valuenow={windowFillPct}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={t("chat.context.windowFillOfWindow", {
                          pct: windowFillPct,
                          window: ctxWindowLabel ?? "",
                        })}
                        title={t("chat.context.windowFillOfWindow", {
                          pct: windowFillPct,
                          window: ctxWindowLabel ?? "",
                        })}
                      >
                        <CircularProgress
                          value={windowFillPct}
                          size={26}
                          strokeWidth={3}
                          strokeClass={windowFillStroke}
                        />
                      </div>
                    )}
                  </div>
                );
              })()}
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
                  <span className="px-1.5 py-0.5">
                    {t("chat.context.projectLabel")}
                  </span>
                )}
                {scopeAnchorLabel && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5">
                    <span className="inline-block h-3 w-3" />
                    {scopeAnchorLabel}
                  </span>
                )}
                {sceneTokens > 0 && (
                  <span className="px-1.5 py-0.5">
                    {t("chat.context.sceneLabel")}{" "}
                    {sceneTokens.toLocaleString()}
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
                    <span>
                      {t("chat.context.via", { name: viaParentName })}
                    </span>
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
                    <span>{t("chat.context.autoLabel")}</span>
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
                    {t("chat.context.projectLabel")}
                  </span>
                )}
                {/* スコープアンカー: codex/snippet スコープの主題を表す固定チップ。
                    削除ボタンは持たない (スコープピッカーが管理主体)。session pin と
                    視覚的に区別するため primary アクセントで強調する。 */}
                {scopeAnchorLabel && (
                  <span
                    data-testid="scope-anchor-chip"
                    className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                    title={scopeAnchorLabel}
                  >
                    {scopeAnchor?.kind === "snippet" ? (
                      <ScrollText
                        className="h-3 w-3 shrink-0"
                        strokeWidth={3}
                      />
                    ) : (
                      <Crosshair className="h-3 w-3 shrink-0" strokeWidth={3} />
                    )}
                    <span className="max-w-[160px] truncate">
                      {scopeAnchorLabel}
                    </span>
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
                    {t("chat.context.sceneLabel")}{" "}
                    {sceneTokens.toLocaleString()}
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
                          actionsDisabled={spotlightDisabled}
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
                                    disabled={spotlightDisabled}
                                    className="hover:text-foreground text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-50"
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
                                  disabled={spotlightDisabled}
                                  className="hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
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
                          {t("chat.context.via", { name: viaParentName })}
                        </span>
                      }
                      actions={
                        <span className="inline-flex items-center gap-1 pr-1">
                          <button
                            type="button"
                            onClick={() => onPin(child.id)}
                            disabled={spotlightDisabled}
                            className="hover:text-foreground text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-50"
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
                              disabled={spotlightDisabled}
                              className="hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
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
                        entry={toPillEntry(entry)}
                        dim
                        suffix={
                          isCandidate ? (
                            <span className="inline-flex items-center gap-0.5 text-muted-foreground/70">
                              <Sparkles className="h-3 w-3" />
                              {t("chat.context.spotlightCandidate")}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/70">
                              {t("chat.context.autoLabel")}
                            </span>
                          )
                        }
                        actions={
                          <span className="inline-flex items-center gap-1 pr-1">
                            <button
                              type="button"
                              onClick={() => onPin(entry.id)}
                              disabled={spotlightDisabled}
                              className="hover:text-foreground text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-50"
                              aria-label={t("chat.context.pinEntry", {
                                name: entry.name,
                              })}
                            >
                              <Spotlight className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => onRemoveAuto(entry.id)}
                              disabled={spotlightDisabled}
                              className="hover:text-destructive text-muted-foreground/70 disabled:cursor-not-allowed disabled:opacity-50"
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
                      disabled={spotlightDisabled}
                      className="hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label={t("chat.context.unpinEntry", {
                        name: snippet.title,
                      })}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                {/* Spotlight Sticky エントリ (Map 由来) */}
                {pinnedStickies.map((sticky) => {
                  const label =
                    sticky.title ??
                    sticky.content.slice(0, 24) ??
                    t("chat.context.stickyLabel");
                  return (
                    <span
                      key={sticky.id}
                      title={
                        sticky.content
                          ? t("chat.context.spotlightLabel", {
                              content: sticky.content.slice(0, 80),
                            })
                          : t("chat.context.pin")
                      }
                      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900"
                    >
                      <Sparkles className="h-3 w-3" aria-hidden />
                      {label}
                      <button
                        type="button"
                        onClick={() => onUnpinSticky?.(sticky.id)}
                        disabled={spotlightDisabled}
                        className="hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label={t("chat.context.unpinSpotlight", { label })}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  );
                })}
              </div>
              {/* /pills-visible */}
            </div>
            {/* ピン留め・AIボタン（右端固定） */}
            <div className="ml-1 flex shrink-0 items-center gap-1 py-0.5">
              <div ref={pinContainerRef} className="relative">
                <button
                  type="button"
                  onClick={() => setPinOpen((v) => !v)}
                  disabled={spotlightDisabled}
                  className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                  aria-label={t("chat.context.pinCodexSnippet")}
                >
                  <BookOpen className="h-3 w-3" />
                  {t("chat.context.pin")}
                </button>
                <PinCodexDialog
                  open={pinOpen}
                  containerRef={pinContainerRef}
                  pinnedIds={pinnedCodexIds}
                  // スコープアンカーは <focus_subject> として固定注入されるため、
                  // 通常の永続 pin と混ぜず checked + disabled で表示する。
                  lockedIds={
                    scopeAnchor ? new Set([scopeAnchor.id]) : undefined
                  }
                  withChildrenIds={
                    new Set(
                      candidatePinnedEntries
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
                disabled={!canUseCreator || spotlightDisabled}
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
          systemPrompt={previewData?.prompt ?? systemPrompt}
          layers={previewData?.layers ?? contextLayers}
          totalTokens={previewData?.totalTokens ?? contextTokenCount}
          userMessage={previewData?.userMessage ?? ""}
          model={model}
          provider={provider}
          contextWindow={contextWindow ?? undefined}
          loading={previewLoading}
          unavailable={previewData?.status === "unavailable"}
          onClose={closePreview}
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
