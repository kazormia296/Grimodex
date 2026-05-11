import { useState, useRef, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  Plus,
  Globe,
  FolderTree,
  FileText,
  Check,
  Circle,
} from "lucide-react";
import { useTreeStore } from "@/features/tree/treeStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";

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
