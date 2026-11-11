import { useTranslation } from "react-i18next";

export interface ProjectMenuCommandsProps {
  onOpenImport?: () => void;
  onOpenExport?: () => void;
  onOpenSnapshot?: () => void;
}

export function hasProjectMenuCommands({
  onOpenImport,
  onOpenExport,
  onOpenSnapshot,
}: ProjectMenuCommandsProps): boolean {
  return Boolean(onOpenImport || onOpenExport || onOpenSnapshot);
}

const COMMAND_CLASS =
  "flex w-full items-center gap-2 whitespace-nowrap px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground";

/**
 * 統合メニューの中段（インポート・ZIP の書き出し・スナップショット）。
 * 渡されたハンドラの項目だけを出す。区切りは `WorkspaceMenu` が置く。
 */
export function ProjectMenuCommands({
  onClose,
  onOpenImport,
  onOpenExport,
  onOpenSnapshot,
}: ProjectMenuCommandsProps & { onClose: () => void }) {
  const { t } = useTranslation();
  const commands = [
    {
      testId: "project-import-open",
      label: t("project.import.action"),
      run: onOpenImport,
    },
    {
      testId: "project-export-open",
      label: t("project.export.action"),
      run: onOpenExport,
    },
    {
      testId: "project-snapshot-open",
      label: t("project.snapshot.action"),
      run: onOpenSnapshot,
    },
  ];

  return (
    <>
      {commands.map(({ testId, label, run }) =>
        run ? (
          <button
            key={testId}
            type="button"
            data-testid={testId}
            onClick={() => {
              onClose();
              run();
            }}
            className={COMMAND_CLASS}
          >
            <span className="w-4 shrink-0" />
            {label}
          </button>
        ) : null,
      )}
    </>
  );
}
