import { Check, Pin } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useForeshadowNavStore } from "@/features/foreshadow/foreshadowNavStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useForeshadowStore } from "@/features/foreshadow/foreshadowStore";
import type { DerivedLabel } from "@/features/foreshadow/types";
import {
  FORESHADOW_LABEL_PRIORITY as LABEL_HEALTH_PRIORITY,
  FORESHADOW_LABEL_DOT_BG as HEALTH_DOT_BG,
  FORESHADOW_LABEL_TITLE_KEY as HEALTH_DOT_TITLE_KEY,
} from "@/features/foreshadow/foreshadowLabelStyles";

interface Props {
  sceneId: string;
  compact?: boolean;
}

export function GridCardForeshadowIndicator({ sceneId, compact }: Props) {
  const { t } = useTranslation();
  const sceneInfo = useForeshadowStore((s) => s.sceneInfoBySceneId[sceneId]);
  const setupIds = sceneInfo?.setupForeshadowIds ?? [];
  const payoffIds = sceneInfo?.payoffForeshadowIds ?? [];
  const storeItems = useForeshadowStore((s) => s.items);

  const setupCount = setupIds.length;
  const payoffCount = payoffIds.length;

  if (setupCount === 0 && payoffCount === 0) return null;

  // Derive worst health from store items (if loaded)
  const allIds = [...new Set([...setupIds, ...payoffIds])];
  let worstLabel: DerivedLabel | null = null;
  for (const priorityLabel of LABEL_HEALTH_PRIORITY) {
    if (
      allIds.some(
        (id) =>
          storeItems.find((item) => item.id === id)?.label === priorityLabel,
      )
    ) {
      worstLabel = priorityLabel;
      break;
    }
  }

  const dotLabel = worstLabel ?? "seeded";
  const dotBg = HEALTH_DOT_BG[dotLabel];
  const dotTitle = t(HEALTH_DOT_TITLE_KEY[dotLabel]);

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    useForeshadowNavStore.getState().requestSceneFilter(sceneId);
    useLayoutStore.getState().showPanel("foreshadow");
  }

  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/80 hover:text-foreground transition-colors"
      onClick={handleClick}
      title={dotTitle}
    >
      <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${dotBg}`} />
      {!compact && setupCount > 0 && (
        <span className="inline-flex items-center gap-0.5">
          <Pin className="h-2.5 w-2.5 shrink-0" aria-hidden />
          {setupCount}
        </span>
      )}
      {!compact && payoffCount > 0 && (
        <span className="inline-flex items-center gap-0.5">
          <Check className="h-2.5 w-2.5 shrink-0" strokeWidth={3} aria-hidden />
          {payoffCount}
        </span>
      )}
    </button>
  );
}
