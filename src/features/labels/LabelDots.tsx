import { useLabelStore } from "./labelStore";
import { LABEL_PALETTE } from "@/lib/labelPalette";

const EMPTY_IDS: string[] = [];
const MAX_DOTS = 4;

interface Props {
  nodeId: string;
}

export function LabelDots({ nodeId }: Props) {
  const allLabels = useLabelStore((s) => s.labels);
  const nodeLabels = useLabelStore((s) => s.nodeLabels);
  const labelIds = nodeLabels[nodeId] ?? EMPTY_IDS;

  if (labelIds.length === 0) return null;

  const labels = labelIds
    .map((id) => allLabels.find((l) => l.id === id))
    .filter(Boolean);

  if (labels.length === 0) return null;

  const displayLabels = labels.slice(0, MAX_DOTS);
  const extraCount = Math.max(0, labels.length - MAX_DOTS);

  return (
    <span className="ml-1 flex items-center gap-0.5 flex-shrink-0">
      {displayLabels.map((label) => (
        <span
          key={label!.id}
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{
            backgroundColor: LABEL_PALETTE[label!.color]?.light ?? "#888888",
          }}
          title={label!.name}
        />
      ))}
      {extraCount > 0 && (
        <span className="text-[9px] text-muted-foreground leading-none">
          +{extraCount}
        </span>
      )}
    </span>
  );
}
