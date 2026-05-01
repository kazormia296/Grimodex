import { useRescanStore } from "@/features/codex/mentionRescanQueue";
import { useMatrixStore } from "./matrixStore";

interface Props {
  sceneCount: number;
  codexCount: number;
  filledCells: number;
}

export function MatrixStatusBar({
  sceneCount,
  codexCount,
  filledCells,
}: Props) {
  const settingsSaved = useMatrixStore((s) => s.settingsSaved);
  const isRunning = useRescanStore((s) => s.isRunning);
  const progress = useRescanStore((s) => s.progress);
  const total = useRescanStore((s) => s.total);

  return (
    <div className="flex items-center gap-3 border-t px-4 py-1 text-[11px] text-muted-foreground">
      <span>
        {sceneCount} scenes × {codexCount} codex entries
      </span>
      <span>•</span>
      <span>{filledCells} cells filled</span>
      <span>•</span>
      <span>Settings: {settingsSaved ? "Saved" : "Saving..."}</span>
      {isRunning && (
        <>
          <span>•</span>
          <span className="text-yellow-600 dark:text-yellow-400">
            Scanning... {progress}/{total}
          </span>
        </>
      )}
    </div>
  );
}
