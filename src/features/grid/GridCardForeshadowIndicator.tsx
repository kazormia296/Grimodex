import { useForeshadowNavStore } from "@/features/foreshadow/foreshadowNavStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useForeshadowStore } from "@/features/foreshadow/foreshadowStore";
import type { DerivedLabel } from "@/features/foreshadow/types";

const LABEL_HEALTH_PRIORITY: DerivedLabel[] = [
  "critical_weak",
  "orphan_payoff",
  "needs_strengthening",
  "seeded",
  "paid",
  "planned",
  "abandoned",
];

const HEALTH_DOT: Record<DerivedLabel, { bg: string; title: string }> = {
  paid: { bg: "bg-green-500", title: "Paid off" },
  seeded: { bg: "bg-blue-500", title: "Seeded" },
  needs_strengthening: { bg: "bg-yellow-400", title: "Needs strengthening" },
  critical_weak: { bg: "bg-red-500", title: "Critical & weak" },
  orphan_payoff: { bg: "bg-orange-400", title: "Orphan payoff" },
  planned: { bg: "bg-muted-foreground/30", title: "Planned" },
  abandoned: { bg: "bg-muted-foreground/20", title: "Abandoned" },
};

interface Props {
  sceneId: string;
  compact?: boolean;
}

export function GridCardForeshadowIndicator({ sceneId, compact }: Props) {
  const sceneInfo = useForeshadowStore(
    (s) => s.sceneInfoBySceneId[sceneId],
  );
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

  const dot = worstLabel ? HEALTH_DOT[worstLabel] : HEALTH_DOT.seeded;

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
      title={dot.title}
    >
      <span
        className={`inline-block h-2 w-2 rounded-full shrink-0 ${dot.bg}`}
      />
      {!compact && setupCount > 0 && <span>📌{setupCount}</span>}
      {!compact && payoffCount > 0 && <span>✓{payoffCount}</span>}
    </button>
  );
}
