import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown, FileText, FolderTree, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { ScopeTreePickerList } from "@/features/tree/ScopeTreePicker";
import { useAnchoredPopover } from "@/components/ui/useAnchoredPopover";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useTabStore } from "@/features/editor/tabStore";
import { useKouetsuStore, type KouetsuStatusFilter } from "./kouetsuStore";

const FILTERS: Array<{ id: KouetsuStatusFilter; labelKey: string }> = [
  { id: "open", labelKey: "kouetsu.filter.open" },
  { id: "dismissed", labelKey: "kouetsu.filter.dismissed" },
];

/**
 * シーンを選んだときのエディタ移動。`ChatPanel.selectSceneFromChat` と同じ挙動
 * (editor パネルが表示中のときだけタブを開いて前面化 + tree の active scene 更新)
 * を意図的に複製している。ChatPanel.tsx を直接 import すると TipTap/tiktoken 等
 * 重い依存が連鎖するため、軽量な store 呼び出しだけをここに複製する。
 * 挙動を変えるときは ChatPanel.tsx 側の同名ロジックとの同期を忘れないこと。
 */
function openSceneInEditor(sceneId: string): void {
  if (useLayoutStore.getState().isPanelActive("editor")) {
    useTabStore.getState().openPinned(sceneId);
    useLayoutStore.getState().showPanel("editor");
  }
  useTreeStore.getState().setActiveScene(sceneId);
}

/**
 * 指摘タブのヘッダ行: ツリースコープピッカー（シーン/フォルダ/プロジェクト、
 * Chat と同セマンティクス）+ ステータスフィルタ chips（開いている/除外）。
 * シーン選択はエディタ移動 + scene スコープ（Chat と同挙動）。
 */
export function KouetsuScopeBar() {
  const { t } = useTranslation();
  const scope = useKouetsuStore((s) => s.scope);
  const setScope = useKouetsuStore((s) => s.setScope);
  const statusFilter = useKouetsuStore((s) => s.statusFilter);
  const setStatusFilter = useKouetsuStore((s) => s.setStatusFilter);
  const nodes = useTreeStore((s) => s.nodes);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popover = useAnchoredPopover(
    triggerRef,
    open,
    () => setOpen(false),
    "bottom-start",
  );

  const label = (() => {
    if (scope.type === "project") return t("kouetsu.scope.project");
    if (scope.type === "folder") {
      const folder = nodes.find((n) => n.id === scope.anchorId);
      if (!folder) return t("kouetsu.scope.project");
      const kindLabel =
        folder.parentId === null
          ? t("chat.scope.act")
          : t("chat.scope.chapter");
      return `${kindLabel}: ${folder.title}`;
    }
    const scene = nodes.find((n) => n.id === activeSceneId);
    return scene
      ? `${t("kouetsu.scope.current")}: ${scene.title}`
      : t("kouetsu.scope.current");
  })();

  const ScopeIcon =
    scope.type === "project"
      ? Globe
      : scope.type === "folder"
        ? FolderTree
        : FileText;

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border bg-muted/20 px-2 py-1 text-xs">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        className="flex max-w-[220px] items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        title={t("kouetsu.scopePicker")}
      >
        <ScopeIcon className="h-3 w-3 shrink-0 text-primary" />
        <span className="truncate">{label}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>

      <div className="ml-auto flex items-center gap-1">
        {FILTERS.map(({ id, labelKey }) => (
          <button
            key={id}
            type="button"
            aria-pressed={statusFilter === id}
            onClick={() => setStatusFilter(id)}
            className={cn(
              "rounded px-2 py-0.5",
              statusFilter === id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>

      {open &&
        popover.style &&
        createPortal(
          <div
            ref={popover.popoverRef}
            style={popover.style}
            className="z-[100] w-72 overflow-hidden rounded-md border border-border bg-popover shadow-lg"
          >
            <ScopeTreePickerList
              selection={
                scope.type === "scene"
                  ? activeSceneId
                    ? { type: "scene", sceneId: activeSceneId }
                    : null
                  : scope
              }
              editorActiveSceneId={activeSceneId || undefined}
              onPickScene={(sceneId) => {
                openSceneInEditor(sceneId);
                setScope({ type: "scene" });
                setOpen(false);
              }}
              onPickFolder={(folderId) => {
                setScope({ type: "folder", anchorId: folderId });
                setOpen(false);
              }}
              onPickProject={() => {
                setScope({ type: "project" });
                setOpen(false);
              }}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
