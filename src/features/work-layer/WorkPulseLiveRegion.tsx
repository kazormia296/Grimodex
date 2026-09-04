import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface WorkPulseLiveRegionProps {
  readonly attentionDelta: number;
  readonly resolutionDelta: number;
}

export function WorkPulseLiveRegion({
  attentionDelta,
  resolutionDelta,
}: WorkPulseLiveRegionProps) {
  const { t } = useTranslation();
  const [announcement, setAnnouncement] = useState("");
  const arrivalAnnouncement =
    attentionDelta > 0
      ? t("workLayer.arrival.aria", "新しいAttentionが{{count}}件あります", {
          count: attentionDelta,
        })
      : "";
  const resolutionAnnouncement =
    resolutionDelta < 0
      ? t(
          "workLayer.resolution.aria",
          "Attentionが{{count}}件解消されました（UIプレビュー）",
          { count: Math.abs(resolutionDelta) },
        )
      : "";
  const nextAnnouncement = resolutionAnnouncement || arrivalAnnouncement;

  useEffect(() => {
    setAnnouncement(nextAnnouncement);
  }, [nextAnnouncement]);

  return (
    <span
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={announcement || undefined}
      data-testid="work-pulse-live-region"
      className="sr-only"
    >
      {announcement}
    </span>
  );
}
