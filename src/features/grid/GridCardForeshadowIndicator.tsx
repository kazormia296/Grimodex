import { useEffect, useState } from "react";
import { getSceneForeshadowInfo } from "@/features/foreshadow/api";
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
  const [setupIds, setSetupIds] = useState<string[]>([]);
  const [payoffIds, setPayoffIds] = useState<string[]>([]);
  const storeItems = useForeshadowStore((s) => s.items);

  useEffect(() => {
    void getSceneForeshadowInfo(sceneId).then(
      ({ setupForeshadowIds, payoffForeshadowIds }) => {
        setSetupIds(setupForeshadowIds);
        setPayoffIds(payoffForeshadowIds);
      },
    );
  }, [sceneId]);

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

  if (compact) {
    return (
      <button
        className="flex items-center px-3 pb-1"
        onClick={handleClick}
        title={dot.title}
      >
        <span className={`inline-block h-2 w-2 rounded-full ${dot.bg}`} />
      </button>
    );
  }

  return (
    <button
      className="flex items-center gap-1.5 px-3 pb-1.5 text-[10px] text-muted-foreground hover:text-foreground"
      onClick={handleClick}
      title={dot.title}
    >
      <span
        className={`inline-block h-2 w-2 rounded-full shrink-0 ${dot.bg}`}
      />
      {setupCount > 0 && <span>📌{setupCount}</span>}
      {payoffCount > 0 && <span>✓{payoffCount}</span>}
    </button>
  );
}
