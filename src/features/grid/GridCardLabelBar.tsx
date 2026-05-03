import { useState } from "react";
import { useLabelStore } from "@/features/labels/labelStore";
import { LABEL_PALETTE } from "@/lib/labelPalette";
import type { Label } from "@/features/labels/labelApi";

const EMPTY_IDS: string[] = [];

interface Props {
  nodeId: string;
  compact?: boolean;
}

export function GridCardLabelBar({ nodeId }: Props) {
  const [hovering, setHovering] = useState(false);

  const allLabels = useLabelStore((s) => s.labels);
  const nodeLabels = useLabelStore((s) => s.nodeLabels);
  const labelIds = nodeLabels[nodeId] ?? EMPTY_IDS;

  if (labelIds.length === 0) return null;

  const labels: Label[] = [];
  for (const id of labelIds) {
    const label = allLabels.find((l) => l.id === id);
    if (label) labels.push(label);
  }

  if (labels.length === 0) return null;

  const displayLabels = labels.slice(0, 3);
  const extraCount = Math.max(0, labels.length - 3);

  return (
    <div
      className="absolute left-0 inset-y-0 w-1.5 rounded-l-md flex flex-col overflow-hidden cursor-default z-10"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {displayLabels.map((label) => (
        <div
          key={label.id}
          className="flex-1"
          style={{
            backgroundColor: LABEL_PALETTE[label.color]?.light ?? "#888888",
          }}
        />
      ))}
      {extraCount > 0 && (
        <div className="text-[7px] text-white font-bold bg-black/30 text-center leading-none py-[3px]">
          +{extraCount}
        </div>
      )}

      {hovering && (
        <div className="absolute left-3 top-1 z-50 bg-popover border rounded shadow-md px-2 py-1.5 text-xs space-y-0.5 pointer-events-none min-w-[100px]">
          {labels.map((label) => (
            <div
              key={label.id}
              className="flex items-center gap-1.5 whitespace-nowrap"
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{
                  backgroundColor:
                    LABEL_PALETTE[label.color]?.light ?? "#888888",
                }}
              />
              <span>{label.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
