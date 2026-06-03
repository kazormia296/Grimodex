import { useState, useRef, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  Plus,
  Globe,
  Globe2,
  FolderTree,
  FileText,
  Check,
  Circle,
  BookOpen,
  Leaf,
  Map as MapIcon,
} from "lucide-react";
import { useTreeStore } from "@/features/tree/treeStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { useLayoutStore } from "@/features/layout/layoutStore";

type ChatScope = "scene" | "folder" | "project";

interface ChatPanelHeaderProps {
  sessionsPanelOpen: boolean;
  setSessionsPanelOpen: (open: boolean) => void;
  chatScope: ChatScope;
  scopeAnchorId: string | null;
  /** scope=scene のときの anchor scene id（tree active を追従） */
  chatSceneId: string;
  /** エディタが実際に開いているシーン（インジケータ表示用） */
  editorActiveSceneId: string;
  /**
   * スコープ切替。folder のとき anchorId 必須、project では null/undefined。
   * scene 選択時は同時にエディタもそのシーンへナビゲートする
   * （onSelectScene 経由）。
   */
  onScopeChange: (scope: ChatScope, anchorId?: string | null) => void;
  /** シーンをクリックしたとき: エディタ移動 + scope=scene を発火 */
  onSelectScene: (sceneId: string) => void;
  onNewSession: () => void;
  /** 本文を context に含めるか (eco モード相当)。project でも Tier 1 閾値内なら有効 */
  includeBodies: boolean;
  onToggleIncludeBodies: () => void;
  /**
   * Map overlay: アクティブな Map board 全体を L4 に注入するか。
   * chatScope と直交する独立トグル。
   */
  includeMapBoard: boolean;
  /** Map ON のとき chip に表示する board title。null なら "Map" のみ。 */
  mapBoardTitle: string | null;
  onToggleIncludeMapBoard: () => void;
  /** Web 検索 (RAG) トグルの状態。 */
  ragEnabled: boolean;
  /** RAG 非対応プロバイダ等で操作不可のとき true (トグルを無効化)。 */
  ragDisabled: boolean;
  /** 無効時のツールチップ理由文 (例: ollama は非対応)。 */
  ragDisabledReason?: string;
  onToggleRag: () => void;
}

interface TreeRow {
  node: TreeNodeData;
  depth: number;
}

/** Flatten nodes into a depth-tagged DFS order using parentId chains. */
function flattenTree(nodes: TreeNodeData[]): TreeRow[] {
  const childrenByParent = new Map<string | null, TreeNodeData[]>();
  for (const n of nodes) {
    const key = n.parentId;
    const arr = childrenByParent.get(key) ?? [];
    arr.push(n);
    childrenByParent.set(key, arr);
  }
  for (const arr of childrenByParent.values()) {
    arr.sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));
  }
  const out: TreeRow[] = [];
  function walk(parentId: string | null, depth: number) {
    const kids = childrenByParent.get(parentId) ?? [];
    for (const n of kids) {
      out.push({ node: n, depth });
      if (n.nodeType === "folder") walk(n.id, depth + 1);
    }
  }
  walk(null, 0);
  return out;
}

export function ChatPanelHeader({
  sessionsPanelOpen,
  setSessionsPanelOpen,
  chatScope,
  scopeAnchorId,
  chatSceneId,
  editorActiveSceneId,
  onScopeChange,
  onSelectScene,
  onNewSession,
  includeBodies,
  onToggleIncludeBodies,
  includeMapBoard,
  mapBoardTitle,
  onToggleIncludeMapBoard,
  ragEnabled,
  ragDisabled,
  ragDisabledReason,
  onToggleRag,
}: ChatPanelHeaderProps) {
  const { t } = useTranslation();
  const nodes = useTreeStore((s) => s.nodes);

  const rows = useMemo(() => flattenTree(nodes), [nodes]);

  const currentLabel = useMemo(() => {
    if (chatScope === "project") return t("chat.scope.project");
    if (chatScope === "folder") {
      const folder = nodes.find((n) => n.id === scopeAnchorId);
      if (!folder) return t("chat.scope.project");
      const isAct = folder.parentId === null;
      const kindLabel = isAct ? t("chat.scope.act") : t("chat.scope.chapter");
      return `${kindLabel}: ${folder.title}`;
    }
    // scene
    const scene = nodes.find((n) => n.id === chatSceneId);
    if (!scene) return t("chat.scope.scene");
    return `${t("chat.scope.scene")}: ${scene.title}`;
  }, [chatScope, scopeAnchorId, chatSceneId, nodes, t]);

  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [scopeHint, setScopeHint] = useState(false);
  const activePresetId = useLayoutStore((s) => s.activePresetId);

  useEffect(() => {
    if (!open) return;
    function onOutside(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [open]);

  // Chat プリセット切替時に Project スコープを時限ポップオーバーで提案
  useEffect(() => {
    if (activePresetId !== "builtin:chat-main") return;
    if (chatScope === "project") return;
    setScopeHint(true);
    const timer = setTimeout(() => setScopeHint(false), 6000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePickScene = (sceneId: string) => {
    onSelectScene(sceneId);
    onScopeChange("scene");
    setOpen(false);
  };
  const handlePickFolder = (folderId: string) => {
    onScopeChange("folder", folderId);
    setOpen(false);
  };
  const handlePickProject = () => {
    onScopeChange("project");
    setOpen(false);
  };

  return (
    <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-sm font-semibold text-foreground">
          {t("chat.title")}
        </span>

        <div className="relative min-w-0" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex max-w-[200px] items-center gap-0.5 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("chat.scope.picker")}
            aria-label={t("chat.scope.picker")}
          >
            {chatScope === "project" ? (
              <Globe className="mr-1 h-3 w-3 shrink-0 text-primary" />
            ) : chatScope === "folder" ? (
              <FolderTree className="mr-1 h-3 w-3 shrink-0 text-primary" />
            ) : (
              <FileText className="mr-1 h-3 w-3 shrink-0 text-primary" />
            )}
            <span className="truncate">{currentLabel}</span>
            <ChevronDown className="h-3 w-3 shrink-0" />
          </button>

          {scopeHint && !open && (
            <div className="absolute left-0 top-full z-50 mt-1 w-52 rounded-md border border-primary/40 bg-popover p-2.5 shadow-md">
              <p className="mb-2 text-[11px] text-muted-foreground">
                {t("chat.scopeHint.message")}
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setScopeHint(false)}
                  className="rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
                >
                  {t("common.close")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onScopeChange("project");
                    setScopeHint(false);
                  }}
                  className="rounded bg-primary px-2 py-0.5 text-[11px] text-primary-foreground hover:bg-primary/90"
                >
                  {t("chat.scopeHint.action")}
                </button>
              </div>
            </div>
          )}

          {open && (
            <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-md border border-border bg-popover shadow-lg">
              {/* Project (root) */}
              <button
                type="button"
                onClick={handlePickProject}
                className={[
                  "flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-xs",
                  chatScope === "project"
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                ].join(" ")}
              >
                <Globe className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1">{t("chat.scope.project")}</span>
                {chatScope === "project" && (
                  <Check className="h-3 w-3 shrink-0" />
                )}
              </button>

              <div className="max-h-72 overflow-y-auto py-1">
                {rows.length === 0 && (
                  <p className="px-3 py-2 text-xs text-muted-foreground">
                    {t("chat.noScenes")}
                  </p>
                )}
                {rows.map(({ node, depth }) => {
                  const isFolder = node.nodeType === "folder";
                  if (!isFolder && node.nodeType !== "scene") return null;
                  const isSelected = isFolder
                    ? chatScope === "folder" && scopeAnchorId === node.id
                    : chatScope === "scene" && chatSceneId === node.id;
                  const isEditorActive =
                    !isFolder && editorActiveSceneId === node.id;
                  return (
                    <button
                      key={node.id}
                      type="button"
                      onClick={() =>
                        isFolder
                          ? handlePickFolder(node.id)
                          : handlePickScene(node.id)
                      }
                      style={{ paddingLeft: 12 + depth * 12 }}
                      className={[
                        "flex w-full items-center gap-1.5 py-1 pr-3 text-left text-xs",
                        isSelected
                          ? "bg-accent font-medium text-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      ].join(" ")}
                    >
                      {isFolder ? (
                        <FolderTree className="h-3 w-3 shrink-0 opacity-70" />
                      ) : (
                        <FileText className="h-3 w-3 shrink-0 opacity-70" />
                      )}
                      <span className="flex-1 truncate">{node.title}</span>
                      {isEditorActive && (
                        <Circle
                          className="h-2 w-2 shrink-0 fill-primary text-primary"
                          aria-label={t("chat.scope.editorHere")}
                        />
                      )}
                      {isSelected && <Check className="h-3 w-3 shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* eco モード相当: 本文を context に含めるかのトグル */}
        <button
          type="button"
          onClick={onToggleIncludeBodies}
          title={
            includeBodies ? t("chat.scope.bodiesOn") : t("chat.scope.bodiesOff")
          }
          aria-pressed={includeBodies}
          aria-label={
            includeBodies ? t("chat.scope.bodiesOn") : t("chat.scope.bodiesOff")
          }
          className={[
            "rounded p-0.5 transition-colors",
            includeBodies
              ? "text-primary hover:bg-accent"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          ].join(" ")}
        >
          {includeBodies ? (
            <BookOpen className="h-3.5 w-3.5" />
          ) : (
            <Leaf className="h-3.5 w-3.5" />
          )}
        </button>

        {/* Map overlay toggle: scope と直交。ON で active board 全体を L4 注入。 */}
        <button
          type="button"
          onClick={onToggleIncludeMapBoard}
          aria-pressed={includeMapBoard}
          aria-label={
            includeMapBoard ? t("chat.mapOverlay.on") : t("chat.mapOverlay.off")
          }
          title={
            includeMapBoard ? t("chat.mapOverlay.on") : t("chat.mapOverlay.off")
          }
          className={[
            "flex max-w-[160px] items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors",
            includeMapBoard
              ? "bg-primary/10 text-primary hover:bg-primary/15"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          ].join(" ")}
        >
          <MapIcon className="h-3 w-3 shrink-0" />
          {includeMapBoard && mapBoardTitle ? (
            <span className="truncate">{mapBoardTitle}</span>
          ) : (
            <span>{t("chat.mapOverlay.label")}</span>
          )}
        </button>

        {/* Web 検索 (RAG) toggle: ON でプロバイダのサーバサイド検索を注入。
            非対応プロバイダ (ollama 等) では disabled。 */}
        <button
          type="button"
          onClick={onToggleRag}
          disabled={ragDisabled}
          aria-pressed={ragEnabled}
          aria-label={
            ragEnabled ? t("chat.webSearch.on") : t("chat.webSearch.off")
          }
          // 第三者送信の開示は title (ホバー専用) に頼らず aria-describedby で
          // スクリーンリーダー/タッチにも到達させる（security review F-1）。
          aria-describedby={ragDisabled ? undefined : "rag-egress-note"}
          title={
            ragDisabled
              ? (ragDisabledReason ?? t("chat.webSearch.unavailable"))
              : `${
                  ragEnabled ? t("chat.webSearch.on") : t("chat.webSearch.off")
                }\n${t("chat.webSearch.egressNote")}`
          }
          className={[
            "flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors",
            ragDisabled
              ? "cursor-not-allowed text-muted-foreground/40"
              : ragEnabled
                ? "bg-primary/10 text-primary hover:bg-primary/15"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
          ].join(" ")}
        >
          <Globe2 className="h-3 w-3 shrink-0" />
          <span>{t("chat.webSearch.label")}</span>
        </button>
        {/* aria-describedby の参照先。検索クエリが第三者へ送られる旨の開示。 */}
        <span id="rag-egress-note" className="sr-only">
          {t("chat.webSearch.egressNote")}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => setSessionsPanelOpen(!sessionsPanelOpen)}
          className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {t("chat.sessions")}
        </button>
        <button
          type="button"
          onClick={onNewSession}
          title={t("chat.newSession")}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
