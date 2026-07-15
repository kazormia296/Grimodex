import { useMemo, useState } from "react";

export interface PhoneSceneItem {
  id: string;
  title: string;
  chapterTitle?: string;
}

export type PhoneSceneAction =
  | "move-up"
  | "move-down"
  | "move-to-chapter"
  | "duplicate"
  | "delete";

interface Props {
  scenes: readonly PhoneSceneItem[];
  currentSceneId?: string;
  onOpenScene: (sceneId: string) => void;
  onSceneAction?: (sceneId: string, action: PhoneSceneAction) => void;
}

export function PhoneSceneNavigator({
  scenes,
  currentSceneId,
  onOpenScene,
  onSceneAction,
}: Props) {
  const [query, setQuery] = useState("");
  const [menuSceneId, setMenuSceneId] = useState<string | null>(null);
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
  return (
    <section aria-label="Scenes" data-phone-scene-navigator>
      <header className="flex items-center gap-2 p-3">
        <h1 className="flex-1 text-lg font-semibold">Scenes</h1>
        <input
          aria-label="Search scenes"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search"
          className="min-h-11 min-w-0 rounded border px-2"
        />
      </header>
      <ul className="m-0 grid list-none gap-1 p-2">
        {filtered.map((scene) => (
          <li key={scene.id} className="relative flex items-center gap-1">
            <button
              type="button"
              className="min-h-11 min-w-0 flex-1 rounded px-3 text-left"
              aria-current={scene.id === currentSceneId ? "page" : undefined}
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
              aria-label={`${scene.title} actions`}
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
                    ["move-up", "Move up"],
                    ["move-down", "Move down"],
                    ["move-to-chapter", "Move to chapter"],
                    ["duplicate", "Duplicate"],
                    ["delete", "Delete"],
                  ] as const
                ).map(([action, label]) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={action}
                    className="min-h-11 rounded px-3 text-left"
                    onClick={() => {
                      onSceneAction?.(scene.id, action);
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
    </section>
  );
}
