import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openEditorDocument } from "@/application/editor/openEditorDocument";
import {
  narrativeMaintenanceStaleProposalScenes,
  type StaleProposalSceneCount,
} from "@/application/narrative-extraction/nativeApi";
import { defaultEditorNavigationPorts } from "@/features/editor/editorNavigationPorts";
import {
  getAllProjectScenesInOrder,
  useTreeStore,
} from "@/features/tree/treeStore";

interface Props {
  readonly projectId: string;
  /** Called after a scene has been opened, so the panel can close. */
  readonly onOpened: () => void;
}

type ListState =
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | {
      readonly kind: "ready";
      readonly scenes: readonly StaleProposalSceneCount[];
      readonly withoutSceneCount: number;
      readonly nextCursor?: string;
      readonly more: "idle" | "loading" | "failed";
    };

/**
 * The scenes cited by proposals whose evidence is out of date, with the number
 * of proposals per scene. Titles come from the loaded scene tree; a scene id
 * that is not in the tree is only called deleted once the tree of the same
 * project has finished loading.
 */
export function StaleProposalScenesList({ projectId, onOpened }: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const nodes = useTreeStore((s) => s.nodes);
  const hydratedProjectId = useTreeStore((s) => s.hydratedProjectId);
  const treeReady = hydratedProjectId === projectId;
  // Bumped when the project changes or the list unmounts; a response from an
  // older generation is dropped.
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setState({ kind: "loading" });
    void narrativeMaintenanceStaleProposalScenes({ projectId })
      .then((page) => {
        if (generation.current !== current) return;
        setState({
          kind: "ready",
          scenes: page.scenes,
          withoutSceneCount: page.withoutSceneCount,
          nextCursor: page.nextCursor,
          more: "idle",
        });
      })
      .catch(() => {
        if (generation.current === current) setState({ kind: "failed" });
      });
    return () => {
      generation.current += 1;
    };
  }, [projectId]);

  const loadMore = useCallback(() => {
    if (state.kind !== "ready" || state.nextCursor === undefined) return;
    if (state.more === "loading") return;
    const current = generation.current;
    const cursor = state.nextCursor;
    setState({ ...state, more: "loading" });
    void narrativeMaintenanceStaleProposalScenes({ projectId, cursor })
      .then((page) => {
        if (generation.current !== current) return;
        setState((prev) => {
          if (prev.kind !== "ready") return prev;
          const seen = new Set(prev.scenes.map((s) => s.sceneId));
          return {
            kind: "ready",
            scenes: [
              ...prev.scenes,
              ...page.scenes.filter((s) => !seen.has(s.sceneId)),
            ],
            withoutSceneCount: page.withoutSceneCount,
            nextCursor: page.nextCursor,
            more: "idle",
          };
        });
      })
      .catch(() => {
        if (generation.current !== current) return;
        setState((prev) =>
          prev.kind === "ready" ? { ...prev, more: "failed" } : prev,
        );
      });
  }, [projectId, state]);

  // Show the loaded rows in manuscript order; ids that are not in the tree go
  // last, in the order the read returned them.
  const order = useMemo(() => {
    const result = new Map<string, { index: number; title: string }>();
    if (!treeReady) return result;
    getAllProjectScenesInOrder(nodes).forEach((node, index) => {
      result.set(node.id, { index, title: node.title });
    });
    return result;
  }, [nodes, treeReady]);

  const rows = useMemo(() => {
    if (state.kind !== "ready") return [];
    const rank = (id: string) => order.get(id)?.index ?? order.size;
    return [...state.scenes].sort((a, b) => rank(a.sceneId) - rank(b.sceneId));
  }, [state, order]);

  const open = (sceneId: string) => {
    openEditorDocument(
      {
        target: { kind: "scene", documentId: sceneId },
        mode: "pinned",
        revealEditor: true,
        focusEditor: false,
        syncSceneContext: true,
      },
      defaultEditorNavigationPorts,
    );
    onOpened();
  };

  const count = (value: number) =>
    t("narrativeMaintenance.inbox.countUnit", "{{value}}件", { value });

  return (
    <section
      className="mt-2 border-t border-border/60 pt-2"
      aria-labelledby="structure-health-scenes-title"
      aria-busy={state.kind === "loading"}
      data-testid="structure-health-scenes"
    >
      <h3 id="structure-health-scenes-title" className="text-xs font-semibold">
        {t("narrativeMaintenance.scenes.heading", "引用した場面")}
      </h3>

      {state.kind === "loading" && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t("narrativeMaintenance.scenes.loading", "場面を調べています…")}
        </p>
      )}
      {state.kind === "failed" && (
        <p className="mt-1 text-xs text-muted-foreground" role="alert">
          {t(
            "narrativeMaintenance.scenes.failed",
            "場面の内訳を読み込めませんでした。閉じてもう一度開くと、読み直します。",
          )}
        </p>
      )}

      {state.kind === "ready" && (
        <>
          <ul className="mt-1 space-y-0.5">
            {rows.map((row) => {
              const known = order.get(row.sceneId);
              const title =
                known?.title.trim() ||
                t("narrativeMaintenance.scenes.untitled", "無題の場面");
              return (
                <li
                  key={row.sceneId}
                  className="flex items-center justify-between gap-3"
                  data-testid="structure-health-scene-row"
                >
                  {known ? (
                    <button
                      type="button"
                      className="min-w-0 truncate rounded px-1 text-left underline decoration-dotted underline-offset-2 hover:bg-accent"
                      onClick={() => open(row.sceneId)}
                      title={title}
                    >
                      {title}
                    </button>
                  ) : (
                    <span className="px-1 text-muted-foreground">
                      {treeReady
                        ? t("narrativeMaintenance.scenes.missing", "消えた場面")
                        : t(
                            "narrativeMaintenance.scenes.treeLoading",
                            "場面を読み込み中…",
                          )}
                    </span>
                  )}
                  <span className="shrink-0">{count(row.proposalCount)}</span>
                </li>
              );
            })}
            {state.withoutSceneCount > 0 && (
              <li
                className="flex items-center justify-between gap-3 text-muted-foreground"
                data-testid="structure-health-scene-without"
              >
                <span className="px-1">
                  {t(
                    "narrativeMaintenance.scenes.without",
                    "場面を引用していない提案",
                  )}
                </span>
                <span className="shrink-0">
                  {count(state.withoutSceneCount)}
                </span>
              </li>
            )}
          </ul>

          {state.nextCursor !== undefined && (
            <button
              type="button"
              className="mt-1 rounded border border-border px-2 py-0.5 text-xs disabled:opacity-60"
              onClick={loadMore}
              disabled={state.more === "loading"}
              data-testid="structure-health-scenes-more"
            >
              {t("narrativeMaintenance.scenes.more", "さらに表示")}
            </button>
          )}
          {state.more === "failed" && (
            <p className="mt-1 text-xs text-muted-foreground" role="alert">
              {t(
                "narrativeMaintenance.scenes.moreFailed",
                "続きを読み込めませんでした。",
              )}
            </p>
          )}

          {rows.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t(
                "narrativeMaintenance.scenes.overlapNote",
                "1 つの提案が複数の場面を引用することがあるため、場面ごとの件数の合計は、上の件数と合わないことがあります。",
              )}
            </p>
          )}
        </>
      )}
    </section>
  );
}
