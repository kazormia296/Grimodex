import { useTranslation } from "react-i18next";

interface Props {
  totalChapters: number;
  totalScenes: number;
  totalCharCount: number;
}

export function GridStatusBar({
  totalChapters,
  totalScenes,
  totalCharCount,
}: Props) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 border-t px-4 py-1 text-[11px] text-muted-foreground">
      <span>
        {t("grid.status.chapters", "{{count}} 章", { count: totalChapters })}
      </span>
      <span>
        {t("grid.status.scenes", "{{count}} シーン", { count: totalScenes })}
      </span>
      <span>{totalCharCount.toLocaleString()} chars</span>
    </div>
  );
}
