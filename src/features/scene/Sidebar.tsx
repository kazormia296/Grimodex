import { useState, useCallback, useRef, useEffect } from "react";
import { useSceneStore } from "./store";
import { cn } from "@/lib/utils";

export function Sidebar() {
  const scenes = useSceneStore((s) => s.scenes);
  const activeSceneId = useSceneStore((s) => s.activeSceneId);
  const createScene = useSceneStore((s) => s.createScene);
  const deleteScene = useSceneStore((s) => s.deleteScene);
  const renameScene = useSceneStore((s) => s.renameScene);
  const setActiveScene = useSceneStore((s) => s.setActiveScene);

  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <nav className="flex h-full w-60 flex-col border-r border-sidebar-border bg-sidebar-background text-sidebar-foreground">
      <div className="flex items-center justify-between border-b border-sidebar-border px-3 py-2">
        <span className="text-sm font-semibold">シーン</span>
        <button
          type="button"
          aria-label="シーン追加"
          onClick={createScene}
          className="rounded px-2 py-0.5 text-sm hover:bg-sidebar-accent"
        >
          +
        </button>
      </div>
      <ul className="flex-1 overflow-auto py-1">
        {scenes.map((scene) => (
          <SceneItem
            key={scene.id}
            id={scene.id}
            title={scene.title}
            isActive={scene.id === activeSceneId}
            isEditing={scene.id === editingId}
            canDelete={scenes.length > 1}
            onSelect={() => setActiveScene(scene.id)}
            onDelete={() => deleteScene(scene.id)}
            onStartRename={() => setEditingId(scene.id)}
            onFinishRename={(newTitle) => {
              if (newTitle) renameScene(scene.id, newTitle);
              setEditingId(null);
            }}
          />
        ))}
      </ul>
    </nav>
  );
}

interface SceneItemProps {
  id: string;
  title: string;
  isActive: boolean;
  isEditing: boolean;
  canDelete: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onStartRename: () => void;
  onFinishRename: (newTitle: string | null) => void;
}

function SceneItem({
  id,
  title,
  isActive,
  isEditing,
  canDelete,
  onSelect,
  onDelete,
  onStartRename,
  onFinishRename,
}: SceneItemProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        const val = inputRef.current?.value.trim();
        onFinishRename(val || null);
      } else if (e.key === "Escape") {
        onFinishRename(null);
      }
    },
    [onFinishRename],
  );

  return (
    <li
      data-testid={`scene-item-${id}`}
      data-active={isActive}
      className={cn(
        "group flex items-center gap-1 px-3 py-1.5 text-sm cursor-pointer",
        isActive
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "hover:bg-sidebar-accent/50",
      )}
      onClick={onSelect}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onStartRename();
      }}
    >
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          defaultValue={title}
          className="flex-1 rounded border border-input bg-background px-1 py-0 text-sm text-foreground"
          onKeyDown={handleKeyDown}
          onBlur={() => {
            const val = inputRef.current?.value.trim();
            onFinishRename(val || null);
          }}
        />
      ) : (
        <span className="flex-1 truncate">{title}</span>
      )}
      {canDelete && !isEditing && (
        <button
          type="button"
          aria-label="削除"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="invisible rounded px-1 text-xs text-muted-foreground hover:text-destructive group-hover:visible"
        >
          ×
        </button>
      )}
    </li>
  );
}
