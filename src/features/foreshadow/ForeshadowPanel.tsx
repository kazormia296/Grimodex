import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Loader2,
  MapPin,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useTreeStore } from "@/features/tree/treeStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { useForeshadowStore } from "./foreshadowStore";
import { useForeshadowNavStore } from "./foreshadowNavStore";
import { ForeshadowItemSkeletonList } from "@/components/ui/skeleton-patterns";
import { CreateForeshadowDialog } from "./CreateForeshadowDialog";
import { EditForeshadowDialog } from "./EditForeshadowDialog";
import { ForeshadowChapterTab } from "./ForeshadowChapterTab";
import { useDropTarget } from "@/features/trash-bin/useDropTarget";
import { isSetupEvaluationStale } from "./staleness";
import { safeParseAiEvaluation } from "./types";
import { setSetupStrength, getSceneForeshadowInfo } from "./api";
import type {
  DerivedLabel,
  ForeshadowLoadBearing,
  ForeshadowSetupRow,
  ForeshadowStrength,
  ForeshadowWithLabel,
} from "./types";

const LABEL_ORDER: DerivedLabel[] = [
  "planned",
  "seeded",
  "critical_weak",
  "needs_strengthening",
  "paid",
  "orphan_payoff",
  "abandoned",
];

const LABEL_STYLE: Record<DerivedLabel, string> = {
  planned: "bg-muted text-muted-foreground",
  seeded: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  paid: "bg-green-500/15 text-green-600 dark:text-green-400",
  critical_weak: "bg-red-500/15 text-red-600 dark:text-red-400",
  needs_strengthening: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
  orphan_payoff: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  abandoned: "bg-muted text-muted-foreground/50 line-through",
};

const STRENGTH_STYLE: Record<string, string> = {
  subtle: "text-yellow-600 dark:text-yellow-400",
  moderate: "text-blue-600 dark:text-blue-400",
  overt: "text-green-600 dark:text-green-400",
};

const PERSONA_KEYS = ["careful", "casual", "skim"] as const;

const STRENGTH_VALUES: (ForeshadowStrength | null)[] = [
  "subtle",
  "moderate",
  "overt",
  null,
];

interface SetupRowProps {
  setup: ForeshadowSetupRow;
  evaluatingSetupIds: Set<string>;
  onEvaluate: (setup: ForeshadowSetupRow) => void;
  onReanchor: () => void;
  onReinsert: () => void;
  onDiscard: () => void;
  onJump: () => void;
  onStrengthChange: (strength: ForeshadowStrength | null) => void;
}

function SetupRow({
  setup,
  evaluatingSetupIds,
  onEvaluate,
  onReanchor,
  onReinsert,
  onDiscard,
  onJump,
  onStrengthChange,
}: SetupRowProps) {
  const { t } = useTranslation();
  const [showPersonas, setShowPersonas] = useState(false);
  const isEvaluating = evaluatingSetupIds.has(setup.id);
  const evaluation = safeParseAiEvaluation(setup.aiReasoning);
  const stale =
    setup.sceneUpdatedAt !== undefined
      ? isSetupEvaluationStale(setup, setup.sceneUpdatedAt)
      : !setup.lastEvaluatedAt;

  return (
    <div data-testid={`foreshadow-setup-${setup.id}`} className="py-1.5">
      {/* Setup row header */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] text-muted-foreground">
          {t(`foreshadow.setup.kind.${setup.kind}`)}
        </span>

        {setup.isOrphan && (
          <span className="rounded bg-orange-500/15 px-1 py-0.5 text-[10px] font-medium text-orange-600 dark:text-orange-400">
            {t("foreshadow.setup.orphan", "孤立")}
          </span>
        )}

        {/* strength selector (author) */}
        <select
          data-testid={`foreshadow-setup-strength-${setup.id}`}
          value={setup.strength ?? ""}
          onChange={(e) => {
            const val = e.target.value as ForeshadowStrength | "";
            onStrengthChange(val === "" ? null : val);
          }}
          title={t("foreshadow.evaluate.authorStrength", "作者評価")}
          className={`cursor-pointer rounded border-0 bg-transparent p-0 text-[10px] font-medium focus:outline-none focus:ring-1 focus:ring-ring ${setup.strength ? (STRENGTH_STYLE[setup.strength] ?? "") : "text-muted-foreground/50"}`}
        >
          <option value="">
            {t("foreshadow.strength.unset", "strength 未設定")}
          </option>
          {STRENGTH_VALUES.filter(Boolean).map((v) => (
            <option key={v} value={v!}>
              {t(`foreshadow.strength.${v!}`, v!)}
            </option>
          ))}
        </select>
        {setup.aiStrength && (
          <span
            className={`text-[10px] ${STRENGTH_STYLE[setup.aiStrength] ?? ""} opacity-70`}
            title={t("foreshadow.evaluate.aiStrength", "AI評価（careful）")}
          >
            AI:{t(`foreshadow.strength.${setup.aiStrength}`, setup.aiStrength)}
          </span>
        )}

        {/* staleness dot */}
        {stale && (
          <span
            className="inline-block h-1.5 w-1.5 rounded-full bg-yellow-500"
            title={t("foreshadow.evaluate.stale", "未評価または陳腐化")}
          />
        )}

        {/* Jump to setup in editor — orphan setups have re-anchor instead */}
        {!setup.isOrphan && (
          <button
            type="button"
            data-testid={`foreshadow-setup-jump-${setup.id}`}
            onClick={onJump}
            className="ml-auto flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("foreshadow.setup.jump", "Setup へ移動")}
          >
            <ArrowRight className="h-2.5 w-2.5" />
          </button>
        )}

        {/* AI evaluate button */}
        <button
          type="button"
          data-testid={`foreshadow-setup-evaluate-${setup.id}`}
          onClick={() => onEvaluate(setup)}
          disabled={isEvaluating}
          className={`${setup.isOrphan ? "ml-auto " : ""}flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50`}
          title={t("foreshadow.evaluate.button", "AI評価")}
        >
          {isEvaluating ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
          ) : (
            <Sparkles className="h-2.5 w-2.5" />
          )}
          {t("foreshadow.evaluate.button", "AI評価")}
        </button>

        {/* persona toggle */}
        {evaluation && (
          <button
            type="button"
            onClick={() => setShowPersonas((p) => !p)}
            className="rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
          >
            {showPersonas ? (
              <ChevronDown className="h-2.5 w-2.5" />
            ) : (
              <ChevronRight className="h-2.5 w-2.5" />
            )}
          </button>
        )}
      </div>

      {/* Per-persona evaluation details */}
      {evaluation && showPersonas && (
        <div className="mt-1 space-y-1 rounded bg-muted/50 px-2 py-1.5">
          {PERSONA_KEYS.map((persona) => {
            const peval = evaluation[persona];
            return (
              <div key={persona} className="flex items-start gap-1.5">
                <span className="w-12 shrink-0 text-xs text-muted-foreground">
                  {t(`foreshadow.evaluate.persona.${persona}`, persona)}
                </span>
                <span
                  className={`shrink-0 text-xs font-medium ${STRENGTH_STYLE[peval.strength] ?? ""}`}
                >
                  {t(`foreshadow.strength.${peval.strength}`, peval.strength)}
                </span>
                <span className="text-xs leading-snug text-muted-foreground">
                  {peval.reasoning}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Orphan actions */}
      {setup.isOrphan && (
        <div className="mt-1 flex gap-1">
          <button
            type="button"
            data-testid={`foreshadow-setup-reanchor-${setup.id}`}
            onClick={onReanchor}
            className="rounded px-1.5 py-0.5 text-[10px] text-blue-600 hover:bg-blue-500/10 dark:text-blue-400"
          >
            {t("foreshadow.setup.reanchor", "再アンカー")}
          </button>
          <button
            type="button"
            data-testid={`foreshadow-setup-reinsert-${setup.id}`}
            onClick={onReinsert}
            className="rounded px-1.5 py-0.5 text-[10px] text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400"
          >
            {t("foreshadow.setup.reinsert", "再挿入")}
          </button>
          <button
            type="button"
            data-testid={`foreshadow-setup-discard-${setup.id}`}
            onClick={onDiscard}
            className="rounded px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
          >
            {t("foreshadow.setup.discard", "破棄")}
          </button>
        </div>
      )}
    </div>
  );
}

type PanelTab = "list" | "chapter";

export function ForeshadowPanel() {
  const { t } = useTranslation();
  const trashDropRef = useDropTarget("foreshadow-panel", "foreshadow-panel");
  const {
    items,
    isLoading,
    load,
    create,
    remove,
    setupsByForeshadowId,
    loadSetups,
    removeSetup,
    reanchorSetup,
    reinsertSetup,
    evaluateSetup,
    evaluatingSetupIds,
    proposeSetups,
    proposingForForeshadowIds,
    proposeResults,
    adoptProposedSetup,
    adoptInsertedNewSetup,
  } = useForeshadowStore();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<ForeshadowWithLabel | null>(
    null,
  );
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<PanelTab>("list");
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // エディタのホバーポップオーバーからのパネルハイライト要求を処理する
  useEffect(() => {
    return useForeshadowNavStore.subscribe((state) => {
      const id = state.pendingPanelHighlight;
      if (!id) return;
      useForeshadowNavStore.getState().consumePanelHighlight();
      setActiveTab("list");
      setExpandedId(id);
      void loadSetups(id);
      setHighlightedId(id);
      setTimeout(() => {
        itemRefs.current[id]?.scrollIntoView({
          block: "nearest",
          behavior: "smooth",
        });
      }, 50);
      setTimeout(() => setHighlightedId(null), 1500);
    });
  }, [loadSetups]);

  const jumpToAnchor = (sceneId: string, fromPos: number, toPos: number) => {
    // 同シーン・別シーンとも EditorPane が一元的に処理する。
    // 先に pendingJump を立ててから setActiveScene と showPanel を呼ぶことで、
    // 別シーンでも switchScene が consumeJump できる順序を保証する。
    useForeshadowNavStore.getState().requestJump({ sceneId, fromPos, toPos });
    useTreeStore.getState().setActiveScene(sceneId);
    useLayoutStore.getState().showPanel("editor");
  };

  const handleExpand = (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    void loadSetups(id);
  };
  const [sceneFilter, setSceneFilter] = useState<string | null>(null);
  const [sceneFilterIds, setSceneFilterIds] = useState<Set<string>>(
    () => new Set(),
  );
  const nodes = useTreeStore((s) => s.nodes);
  const sceneFilterTitle = sceneFilter
    ? (nodes.find((n) => n.id === sceneFilter)?.title ?? "…")
    : null;

  // Grid カードからのシーン絞り込み要求を処理する
  useEffect(() => {
    return useForeshadowNavStore.subscribe((state) => {
      const sceneId = state.pendingSceneFilter;
      if (!sceneId) return;
      useForeshadowNavStore.getState().consumeSceneFilter();
      setActiveTab("list");
      setSceneFilter(sceneId);
      const cached = useForeshadowStore.getState().sceneInfoBySceneId[sceneId];
      if (cached) {
        setSceneFilterIds(
          new Set([
            ...cached.setupForeshadowIds,
            ...cached.payoffForeshadowIds,
          ]),
        );
        return;
      }
      void getSceneForeshadowInfo(sceneId).then(
        ({ setupForeshadowIds, payoffForeshadowIds }) => {
          setSceneFilterIds(
            new Set([...setupForeshadowIds, ...payoffForeshadowIds]),
          );
        },
      );
    });
  }, []);

  const [activeFilters, setActiveFilters] = useState<Set<DerivedLabel>>(
    () => new Set(),
  );

  const toggleFilter = (label: DerivedLabel) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
      } else {
        next.add(label);
      }
      return next;
    });
  };

  const visibleItems = items.filter((item) => {
    if (sceneFilter && !sceneFilterIds.has(item.id)) return false;
    if (activeFilters.size > 0 && !activeFilters.has(item.label)) return false;
    return true;
  });

  const usedLabels = new Set(items.map((item) => item.label));

  useEffect(() => {
    void load(getCurrentProjectId());
  }, [load]);

  const handleCreate = async (data: {
    title: string;
    intent: string | null;
    loadBearing: ForeshadowLoadBearing | null;
  }) => {
    await create({
      projectId: getCurrentProjectId(),
      title: data.title,
      intent: data.intent,
      loadBearing: data.loadBearing,
    });
  };

  return (
    <div
      ref={trashDropRef}
      data-droptarget-id="foreshadow-panel"
      className="flex h-full flex-col data-[trash-drop-hover=true]:ring-2 data-[trash-drop-hover=true]:ring-primary/60 data-[trash-drop-hover=true]:ring-inset"
    >
      <div
        data-panel-header
        className="flex items-center justify-between border-b border-border px-3 py-2"
      >
        <span className="text-xs font-semibold text-foreground">
          {t("foreshadow.panel.title")}
          {items.length > 0 && (
            <span className="ml-1.5 text-muted-foreground">
              ({items.length})
            </span>
          )}
        </span>
        <button
          type="button"
          data-testid="foreshadow-new-button"
          onClick={() => setDialogOpen(true)}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t("foreshadow.panel.newButton")}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Tab switcher */}
      <div className="flex border-b border-border">
        <button
          type="button"
          data-testid="foreshadow-tab-list"
          onClick={() => setActiveTab("list")}
          className={`flex-1 py-1.5 text-[11px] font-medium transition-colors ${
            activeTab === "list"
              ? "border-b-2 border-foreground text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t("foreshadow.panel.tabList", "一覧")}
        </button>
        <button
          type="button"
          data-testid="foreshadow-tab-chapter"
          onClick={() => setActiveTab("chapter")}
          className={`flex-1 py-1.5 text-[11px] font-medium transition-colors ${
            activeTab === "chapter"
              ? "border-b-2 border-foreground text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {t("foreshadow.panel.tabChapter", "章別監査")}
        </button>
      </div>

      {/* Chapter audit tab */}
      {activeTab === "chapter" && (
        <div
          data-testid="foreshadow-chapter-tab-content"
          className="flex-1 overflow-y-auto"
        >
          <ForeshadowChapterTab />
        </div>
      )}

      {/* Scene filter banner — shown when opened from a Grid card */}
      {activeTab === "list" && sceneFilter && (
        <div className="flex items-center gap-1.5 border-b border-amber-400/30 bg-amber-400/10 px-2 py-1.5">
          <MapPin className="h-3 w-3 shrink-0 text-amber-500 dark:text-amber-400" />
          <span className="flex-1 truncate text-[10px] text-amber-800 dark:text-amber-300">
            {t("foreshadow.panel.sceneFilterBanner", {
              title: sceneFilterTitle,
              defaultValue: "「{{title}}」の伏線",
            })}
          </span>
          <button
            type="button"
            onClick={() => {
              setSceneFilter(null);
              setSceneFilterIds(new Set());
            }}
            className="rounded p-0.5 text-amber-600 hover:bg-amber-400/20 dark:text-amber-400"
            aria-label={t(
              "foreshadow.panel.clearSceneFilter",
              "シーンフィルタを解除",
            )}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* Label filter bar — only shown when items exist and on list tab */}
      {activeTab === "list" && items.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
          {LABEL_ORDER.filter((label) => usedLabels.has(label)).map((label) => (
            <button
              key={label}
              type="button"
              data-testid={`foreshadow-filter-${label}`}
              onClick={() => toggleFilter(label)}
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                activeFilters.has(label)
                  ? "opacity-100 ring-1 ring-current " + LABEL_STYLE[label]
                  : "opacity-60 hover:opacity-90 " + LABEL_STYLE[label]
              }`}
            >
              {t(`foreshadow.label.${label}`)}
            </button>
          ))}
          {activeFilters.size > 0 && (
            <button
              type="button"
              data-testid="foreshadow-filter-clear"
              onClick={() => {
                setActiveFilters(new Set());
              }}
              className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-accent"
              aria-label={t("foreshadow.panel.clearFilter", "フィルタをクリア")}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      )}

      {activeTab === "list" && (
        <div className="flex-1 overflow-y-auto">
          {isLoading && (
            <ForeshadowItemSkeletonList testId="foreshadow-panel-loading" />
          )}

          {!isLoading && items.length === 0 && (
            <p className="px-3 py-4 text-xs text-muted-foreground">
              {t("foreshadow.panel.empty")}
            </p>
          )}

          {!isLoading && items.length > 0 && visibleItems.length === 0 && (
            <p className="px-3 py-4 text-xs text-muted-foreground">
              {t("foreshadow.panel.filterEmpty", "該当なし")}
            </p>
          )}

          {!isLoading &&
            visibleItems.map((item) => (
              <div
                key={item.id}
                ref={(el) => {
                  itemRefs.current[item.id] = el;
                }}
                className={`border-b border-border/50 transition-colors duration-300 ${
                  highlightedId === item.id ? "bg-primary/10" : ""
                }`}
              >
                {/* Item row */}
                <div
                  data-testid="foreshadow-item"
                  className="group flex items-start gap-2 px-3 py-2 hover:bg-accent/50"
                >
                  <button
                    type="button"
                    data-testid={`foreshadow-expand-${item.id}`}
                    onClick={() => handleExpand(item.id)}
                    className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label={t("foreshadow.panel.toggle", "展開/折り畳み")}
                  >
                    {expandedId === item.id ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                  </button>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-foreground">
                      {item.title}
                    </p>
                    {item.intent && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {item.intent}
                      </p>
                    )}
                  </div>

                  {deleteConfirmId === item.id ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <span className="text-[10px] text-destructive">
                        {t("common.confirmDelete", "削除?")}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setDeleteConfirmId(null);
                          void remove(item.id);
                        }}
                        className="rounded px-1 py-0.5 text-[10px] text-destructive hover:bg-destructive/10"
                        aria-label={t("common.confirm", "確認")}
                      >
                        ✓
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteConfirmId(null)}
                        className="rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
                        aria-label={t("common.cancel", "キャンセル")}
                      >
                        ✗
                      </button>
                    </div>
                  ) : (
                    <div className="flex shrink-0 items-center gap-1.5">
                      {item.payoffSceneId &&
                        item.payoffFromPos != null &&
                        item.payoffToPos != null && (
                          <button
                            type="button"
                            data-testid={`foreshadow-payoff-jump-${item.id}`}
                            onClick={() =>
                              jumpToAnchor(
                                item.payoffSceneId!,
                                item.payoffFromPos!,
                                item.payoffToPos!,
                              )
                            }
                            className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                            title={t(
                              "foreshadow.panel.jumpPayoff",
                              "Payoff へ移動",
                            )}
                            aria-label={t(
                              "foreshadow.panel.jumpPayoff",
                              "Payoff へ移動",
                            )}
                          >
                            <ArrowRight className="h-3 w-3" />
                          </button>
                        )}
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${LABEL_STYLE[item.label]}`}
                      >
                        {t(`foreshadow.label.${item.label}`)}
                      </span>
                      <button
                        type="button"
                        onClick={() => setEditingItem(item)}
                        className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
                        aria-label={t("foreshadow.panel.editButton", "編集")}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleteConfirmId(item.id)}
                        className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-destructive group-hover:opacity-100"
                        aria-label={t("common.delete", "削除")}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                </div>

                {/* Setup list (shown when expanded) */}
                {expandedId === item.id && (
                  <div className="border-t border-border/30 bg-muted/30 pl-6 pr-3">
                    {!setupsByForeshadowId[item.id] ? (
                      <p className="py-2 text-[10px] text-muted-foreground">
                        …
                      </p>
                    ) : setupsByForeshadowId[item.id].length === 0 ? (
                      <p className="py-2 text-[10px] text-muted-foreground">
                        {t("foreshadow.panel.setupsEmpty", "Setup なし")}
                      </p>
                    ) : (
                      setupsByForeshadowId[item.id].map((setup) => (
                        <SetupRow
                          key={setup.id}
                          setup={setup}
                          evaluatingSetupIds={evaluatingSetupIds}
                          onEvaluate={(s) =>
                            void evaluateSetup(
                              s.id,
                              item.id,
                              "",
                              item.intent ?? "",
                            )
                          }
                          onReanchor={() =>
                            void reanchorSetup(setup.id, item.id)
                          }
                          onReinsert={() =>
                            void reinsertSetup(setup.id, item.id)
                          }
                          onDiscard={() => void removeSetup(setup.id, item.id)}
                          onJump={() =>
                            jumpToAnchor(
                              setup.sceneId,
                              setup.fromPos,
                              setup.toPos,
                            )
                          }
                          onStrengthChange={(strength) =>
                            void setSetupStrength(setup.id, strength).then(
                              () => void loadSetups(item.id),
                            )
                          }
                        />
                      ))
                    )}

                    {/* Setup を提案ボタン：payoff anchor があり未確定の場合のみ表示 */}
                    {item.payoffSceneId && !item.payoffConfirmed && (
                      <div className="py-1.5">
                        <button
                          type="button"
                          data-testid={`foreshadow-propose-setups-${item.id}`}
                          disabled={proposingForForeshadowIds.has(item.id)}
                          onClick={() => void proposeSetups(item.id)}
                          className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                        >
                          {proposingForForeshadowIds.has(item.id) ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Sparkles className="h-3 w-3" />
                          )}
                          {t("foreshadow.panel.proposeSetups", "Setup を提案")}
                        </button>

                        {/* 提案結果 */}
                        {(proposeResults[item.id] ?? []).map(
                          (candidate, idx) => (
                            <div
                              key={idx}
                              className="mt-1 rounded border border-border/60 bg-background p-1.5 text-[10px]"
                            >
                              <div className="flex items-center gap-1">
                                <span className="rounded bg-muted px-1 py-0.5 font-mono">
                                  {candidate.kind}
                                </span>
                                <span
                                  className={
                                    STRENGTH_STYLE[
                                      candidate.predictedStrength
                                    ] ?? ""
                                  }
                                >
                                  {candidate.predictedStrength}
                                </span>
                              </div>
                              <p className="mt-0.5 text-muted-foreground">
                                {candidate.rationale}
                              </p>
                              {candidate.existingExcerpt && (
                                <p className="mt-0.5 italic text-foreground/70">
                                  「{candidate.existingExcerpt}」
                                </p>
                              )}
                              {candidate.suggestedText && (
                                <pre className="mt-0.5 whitespace-pre-wrap text-foreground/70">
                                  {candidate.suggestedText}
                                </pre>
                              )}
                              {candidate.kind === "designated_existing" && (
                                <div className="mt-1">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void adoptProposedSetup(item.id, idx)
                                    }
                                    className="rounded px-1.5 py-0.5 text-[10px] text-blue-600 hover:bg-blue-500/10 dark:text-blue-400"
                                  >
                                    {t("foreshadow.panel.adoptSetup", "採用")}
                                  </button>
                                </div>
                              )}
                              {candidate.kind === "inserted_new" && (
                                <div className="mt-1">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void adoptInsertedNewSetup(item.id, idx)
                                    }
                                    className="rounded px-1.5 py-0.5 text-[10px] text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400"
                                  >
                                    {t(
                                      "foreshadow.panel.adoptInsertNew",
                                      "挿入して採用",
                                    )}
                                  </button>
                                </div>
                              )}
                            </div>
                          ),
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
        </div>
      )}

      <CreateForeshadowDialog
        open={dialogOpen}
        projectId={getCurrentProjectId()}
        onSave={handleCreate}
        onClose={() => setDialogOpen(false)}
      />
      <EditForeshadowDialog
        open={!!editingItem}
        item={editingItem}
        onClose={() => setEditingItem(null)}
      />
    </div>
  );
}
