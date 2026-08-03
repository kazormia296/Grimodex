import { useEffect, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { deriveReading, type ReadingMap } from "../reading";

interface HeroReadingProps {
  name: string;
  readings: ReadingMap;
  enabled: boolean;
  onCommit: (reading: string) => void;
  onOpen: () => void;
}

/** Inline representative reading editor. Full multi-surface editing stays in Tracking. */
export function HeroReading({
  name,
  readings,
  enabled,
  onCommit,
  onOpen,
}: HeroReadingProps) {
  const { t } = useTranslation();
  const explicit = (readings[name] ?? []).filter((reading) => reading.trim());
  const derived = explicit.length === 0 ? deriveReading(name) : null;
  const representative = explicit[0]?.trim() ?? derived ?? "";
  const [draft, setDraft] = useState(representative);
  const cancelNextBlurRef = useRef(false);

  useEffect(() => {
    setDraft(representative);
  }, [name, representative]);

  if (!enabled || !name.trim()) return null;

  const commit = () => {
    const trimmed = draft.trim();
    // An automatically derived kana/ASCII reading is virtual. Clearing the
    // input cannot remove it, so restore it instead of creating a no-op save.
    if (derived && explicit.length === 0 && !trimmed) {
      setDraft(representative);
      return;
    }
    setDraft(trimmed);
    if (trimmed !== representative) onCommit(trimmed);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // Confirming an IME conversion also emits Enter. Let composition finish
    // before treating Enter as a field commit.
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelNextBlurRef.current = true;
      setDraft(representative);
      event.currentTarget.blur();
    }
  };

  const alternateCount = Math.max(0, explicit.length - 1);
  return (
    <div
      data-testid="codex-hero-reading"
      data-derived={derived && draft === representative ? "true" : "false"}
      className="-ml-1 mb-0.5 flex max-w-full items-center gap-1 text-[12px] leading-4"
    >
      <input
        type="text"
        data-testid="codex-hero-reading-input"
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={() => {
          if (cancelNextBlurRef.current) {
            cancelNextBlurRef.current = false;
            return;
          }
          commit();
        }}
        onKeyDown={handleKeyDown}
        aria-label={t("codex.readings.heroLabel")}
        title={t("codex.readings.heroLabel")}
        placeholder={t("codex.readings.heroPlaceholder")}
        className="w-40 min-w-0 max-w-full rounded border border-transparent bg-transparent px-1 py-0.5 text-muted-foreground/80 outline-none transition-colors placeholder:text-muted-foreground/45 hover:border-border/70 hover:bg-accent/30 focus:border-border focus:bg-background focus:text-foreground focus:ring-1 focus:ring-ring"
      />
      {alternateCount > 0 && (
        <span
          data-testid="codex-hero-reading-more"
          className="shrink-0 rounded-full bg-muted px-1 text-[10px] tabular-nums text-muted-foreground"
        >
          +{alternateCount}
        </span>
      )}
      <button
        type="button"
        data-testid="codex-hero-reading-manage"
        onClick={onOpen}
        aria-label={t("codex.readings.manage")}
        title={t("codex.readings.manage")}
        className="shrink-0 rounded p-1 text-muted-foreground/60 transition-colors hover:bg-accent/50 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Settings2 className="h-3 w-3" />
      </button>
    </div>
  );
}
