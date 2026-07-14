import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen } from "lucide-react";
import { buildCrossReferenceReportForProject } from "../crossReference";
import { useTreeStore } from "@/features/tree/treeStore";
import type { CodexEntry } from "../api";
import type { SceneMention } from "../crossReference";

interface ReferencesSectionProps {
  entry: CodexEntry;
}

export function ReferencesSection({ entry }: ReferencesSectionProps) {
  const { t } = useTranslation();
  const [scenes, setScenes] = useState<SceneMention[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const setActiveScene = useTreeStore((s) => s.setActiveScene);

  const handleLoad = async () => {
    setIsLoading(true);
    try {
      const report = await buildCrossReferenceReportForProject(entry.projectId);
      const found = report.find((r) => r.entryId === entry.id);
      setScenes(found?.scenes ?? []);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      data-testid="references-section"
      className="space-y-2 border-t border-border pt-3"
    >
      <h4 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t("codex.references.appearsIn")}
      </h4>

      {scenes === null ? (
        <button
          type="button"
          data-testid="references-load-button"
          onClick={() => void handleLoad()}
          disabled={isLoading}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50"
        >
          <BookOpen className="h-3 w-3" />
          {isLoading
            ? t("codex.references.searching")
            : t("codex.references.checkOccurrences")}
        </button>
      ) : scenes.length === 0 ? (
        <p
          data-testid="references-empty"
          className="text-xs text-muted-foreground"
        >
          {t("codex.references.noMentions")}
        </p>
      ) : (
        <ul className="space-y-0.5">
          {scenes.map((scene) => (
            <li key={scene.sceneId}>
              <button
                type="button"
                data-testid={`references-scene-${scene.sceneId}`}
                onClick={() => setActiveScene(scene.sceneId)}
                className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-accent"
              >
                <span className="truncate">{scene.sceneTitle}</span>
                {scene.automaticCount !== undefined ||
                scene.semanticCount !== undefined ? (
                  <span className="ml-2 flex shrink-0 items-center gap-1">
                    {(scene.automaticCount ?? 0) > 0 && (
                      <span
                        data-testid={`references-automatic-count-${scene.sceneId}`}
                        title={t("codex.references.automatic")}
                        className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                      >
                        {scene.automaticCount}
                      </span>
                    )}
                    {(scene.semanticCount ?? 0) > 0 && (
                      <span
                        data-testid={`references-semantic-count-${scene.sceneId}`}
                        title={t("codex.references.semantic")}
                        className="rounded-full border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-600 dark:text-violet-300"
                      >
                        {scene.semanticCount}
                      </span>
                    )}
                  </span>
                ) : (
                  <span
                    data-testid={`references-count-${scene.sceneId}`}
                    className="ml-2 shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                  >
                    {scene.count}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
