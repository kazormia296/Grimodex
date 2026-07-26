import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

export interface PhoneSceneItem {
  id: string;
  title: string;
  chapterTitle?: string;
  nodeType?: "scene" | "note";
}

export type PhoneSceneAction = "move-up" | "move-down" | "delete";

interface Props {
  scenes: readonly PhoneSceneItem[];
  currentSceneId?: string;
  onOpenScene: (sceneId: string) => void;
  onCreateNode?: (nodeType: "scene" | "note") => void;
  onSceneAction?: (sceneId: string, action: PhoneSceneAction) => void;
  active?: boolean;
}

export function PhoneSceneNavigator({
  scenes,
  currentSceneId,
  onOpenScene,
  onCreateNode,
  onSceneAction,
  active = true,
}: Props) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [menuSceneId, setMenuSceneId] = useState<string | null>(null);
  const [deleteSceneId, setDeleteSceneId] = useState<string | null>(null);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized
      ? scenes.filter((scene) =>
          `${scene.title} ${scene.chapterTitle ?? ""}`
            .toLocaleLowerCase()
            .includes(normalized),
        )
      : scenes;
  }, [query, scenes]);
  const deleteScene = scenes.find((scene) => scene.id === deleteSceneId);

  useEffect(() => {
    if (active) return;
    setCreateMenuOpen(false);
    setMenuSceneId(null);
    setDeleteSceneId(null);
  }, [active]);

  return (
    <section
      aria-label={t("mobileWorkspace.scenes.title")}
      data-phone-scene-navigator
    >
      <header className="flex items-center gap-2 p-3">
        <input
          aria-label={t("mobileWorkspace.scenes.searchLabel")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("mobileWorkspace.scenes.searchPlaceholder")}
          className="min-h-11 min-w-0 flex-1 rounded border px-2"
        />
        {onCreateNode && (
          <div className="relative">
            <button
              type="button"
              className="min-h-11 min-w-11 rounded"
              aria-label={t("mobileWorkspace.scenes.add")}
              aria-haspopup="menu"
              aria-expanded={createMenuOpen}
              onClick={() => setCreateMenuOpen((open) => !open)}
            >
              +
            </button>
            {createMenuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-full z-20 mt-1 grid min-w-44 rounded border bg-background p-1 shadow"
              >
                {(["scene", "note"] as const).map((nodeType) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={nodeType}
                    className="min-h-11 rounded px-3 text-left"
                    onClick={() => {
                      onCreateNode(nodeType);
                      setCreateMenuOpen(false);
                    }}
                  >
                    {t(
                      nodeType === "scene"
                        ? "scenes.addScene"
                        : "scenes.addNote",
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </header>
      <ul className="m-0 grid list-none gap-1 p-2">
        {filtered.map((scene) => (
          <li key={scene.id} className="relative flex items-center gap-1">
            <button
              type="button"
              className="min-h-11 min-w-0 flex-1 rounded px-3 text-left"
              aria-current={scene.id === currentSceneId ? "page" : undefined}
              data-node-type={scene.nodeType ?? "scene"}
              onClick={() => onOpenScene(scene.id)}
            >
              <span className="block truncate">{scene.title}</span>
              {scene.chapterTitle && (
                <small className="block truncate text-muted-foreground">
                  {scene.chapterTitle}
                </small>
              )}
            </button>
            <button
              type="button"
              className="min-h-11 min-w-11 rounded"
              aria-label={t("mobileWorkspace.scenes.actions", {
                title: scene.title,
              })}
              aria-expanded={menuSceneId === scene.id}
              onClick={() =>
                setMenuSceneId(menuSceneId === scene.id ? null : scene.id)
              }
            >
              ⋯
            </button>
            {menuSceneId === scene.id && (
              <div
                className="absolute right-0 top-full z-20 grid min-w-44 rounded border bg-background p-1 shadow"
                role="menu"
              >
                {(
                  [
                    ["move-up", t("mobileWorkspace.scenes.moveUp")],
                    ["move-down", t("mobileWorkspace.scenes.moveDown")],
                    ["delete", t("mobileWorkspace.scenes.delete")],
                  ] as const
                ).map(([action, label]) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={action}
                    className="min-h-11 rounded px-3 text-left"
                    onClick={() => {
                      if (action === "delete") {
                        setDeleteSceneId(scene.id);
                      } else {
                        onSceneAction?.(scene.id, action);
                      }
                      setMenuSceneId(null);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
      <Dialog
        open={deleteScene !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleteSceneId(null);
        }}
      >
        <DialogContent
          role="alertdialog"
          showClose={false}
          className="max-w-xs"
        >
          <DialogHeader>
            <DialogTitle>
              {t(
                deleteScene?.nodeType === "note"
                  ? "mobileWorkspace.scenes.deleteNoteTitle"
                  : "mobileWorkspace.scenes.deleteTitle",
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                deleteScene?.nodeType === "note"
                  ? "mobileWorkspace.scenes.deleteNoteDescription"
                  : "mobileWorkspace.scenes.deleteDescription",
                {
                  title: deleteScene?.title ?? "",
                },
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteSceneId(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteScene) {
                  onSceneAction?.(deleteScene.id, "delete");
                }
                setDeleteSceneId(null);
              }}
            >
              {t("common.deleteConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
