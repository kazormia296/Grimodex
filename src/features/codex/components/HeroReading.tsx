import { useTranslation } from "react-i18next";
import { deriveReading, type ReadingMap } from "../reading";

interface HeroReadingProps {
  name: string;
  readings: ReadingMap;
  enabled: boolean;
  onOpen: () => void;
}

/** Representative reading above the Codex hero name. Full editing stays in Tracking. */
export function HeroReading({
  name,
  readings,
  enabled,
  onOpen,
}: HeroReadingProps) {
  const { t } = useTranslation();
  if (!enabled) return null;

  const explicit = (readings[name] ?? []).filter((reading) => reading.trim());
  const derived = explicit.length === 0 ? deriveReading(name) : null;
  const representative = explicit[0]?.trim() ?? derived;
  if (!representative) return null;

  const alternateCount = Math.max(0, explicit.length - 1);
  return (
    <button
      type="button"
      data-testid="codex-hero-reading"
      data-derived={derived ? "true" : "false"}
      onClick={onOpen}
      title={t("codex.readings.manage")}
      className="-ml-1 mb-0.5 inline-flex max-w-full items-center gap-1 rounded px-1 text-left text-[12px] leading-4 text-muted-foreground/80 hover:bg-accent/40 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="truncate">{representative}</span>
      {alternateCount > 0 && (
        <span
          data-testid="codex-hero-reading-more"
          className="shrink-0 rounded-full bg-muted px-1 text-[10px] tabular-nums text-muted-foreground"
        >
          +{alternateCount}
        </span>
      )}
    </button>
  );
}
