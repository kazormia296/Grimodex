import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Globe, ChevronDown, Plus } from "lucide-react";
import { useTreeStore } from "@/features/tree/treeStore";

interface ChatPanelHeaderProps {
  sessionsPanelOpen: boolean;
  setSessionsPanelOpen: (open: boolean) => void;
  isGlobalChat: boolean;
  onToggleGlobalChat: () => void;
  chatSceneId: string;
  onSceneChange: (sceneId: string) => void;
  onNewSession: () => void;
}

export function ChatPanelHeader({
  sessionsPanelOpen,
  setSessionsPanelOpen,
  isGlobalChat,
  onToggleGlobalChat,
  chatSceneId,
  onSceneChange,
  onNewSession,
}: ChatPanelHeaderProps) {
  const { t } = useTranslation();
  const nodes = useTreeStore((s) => s.nodes);

  // シーンをフォルダごとにグループ化
  const sceneGroups = (() => {
    const folderMap = new Map(
      nodes.filter((n) => n.nodeType === "folder").map((n) => [n.id, n.title]),
    );
    const sceneNodes = nodes.filter((n) => n.nodeType === "scene");
    const byFolder = new Map<
      string | null,
      { groupLabel: string; scenes: typeof sceneNodes }
    >();
    for (const scene of sceneNodes) {
      const folderId = scene.parentId;
      if (!byFolder.has(folderId)) {
        const groupLabel =
          folderId === null
            ? "Uncategorized"
            : (folderMap.get(folderId) ?? folderId);
        byFolder.set(folderId, { groupLabel, scenes: [] });
      }
      byFolder.get(folderId)!.scenes.push(scene);
    }
    return [...byFolder.values()];
  })();

  const currentSceneTitle =
    nodes.find((n) => n.id === chatSceneId)?.title ?? "Scene";

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dropdownOpen) return;
    function onOutside(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [dropdownOpen]);

  return (
    <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
      {/* 左側: タイトル + グローバルトグル + シーンインジケーター */}
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="text-sm font-semibold text-foreground shrink-0">
          {t("chat.title")}
        </span>

        {/* 🌐 グローバルチャットトグル */}
        <button
          type="button"
          onClick={onToggleGlobalChat}
          title={
            isGlobalChat ? t("chat.globalScopeOn") : t("chat.globalScopeOff")
          }
          className={[
            "rounded p-0.5 transition-colors",
            isGlobalChat
              ? "text-primary"
              : "text-muted-foreground hover:text-foreground",
          ].join(" ")}
        >
          <Globe className="h-3.5 w-3.5" />
        </button>

        {/* シーンインジケーター (ドロップダウン) */}
        <div className="relative min-w-0" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setDropdownOpen((v) => !v)}
            className="flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground max-w-[140px]"
            title={t("chat.sceneContext")}
          >
            <span className="truncate">
              {isGlobalChat ? "Project" : currentSceneTitle}
            </span>
            <ChevronDown className="h-3 w-3 shrink-0" />
          </button>

          {dropdownOpen && (
            <div className="absolute left-0 top-full z-50 mt-1 w-52 rounded-md border border-border bg-background shadow-lg">
              <div className="max-h-64 overflow-y-auto py-1">
                {sceneGroups.map((group) => (
                  <div key={group.groupLabel}>
                    <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {group.groupLabel}
                    </div>
                    {group.scenes.map((scene) => (
                      <button
                        key={scene.id}
                        type="button"
                        onClick={() => {
                          onSceneChange(scene.id);
                          setDropdownOpen(false);
                        }}
                        className={[
                          "w-full px-3 py-1 text-left text-xs hover:bg-accent",
                          scene.id === chatSceneId && !isGlobalChat
                            ? "font-medium text-foreground"
                            : "text-muted-foreground",
                        ].join(" ")}
                      >
                        {scene.title}
                      </button>
                    ))}
                  </div>
                ))}
                {sceneGroups.length === 0 && (
                  <p className="px-3 py-2 text-xs text-muted-foreground">
                    {t("chat.noScenes")}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 右側: Sessions + 新規セッション */}
      <div className="flex items-center gap-1 shrink-0">
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
