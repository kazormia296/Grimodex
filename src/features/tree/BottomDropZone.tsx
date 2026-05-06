import { useDroppable } from "@dnd-kit/core";

export const BOTTOM_DROP_ZONE_ID = "drop-bottom-zone";

export function BottomDropZone() {
  const { setNodeRef } = useDroppable({ id: BOTTOM_DROP_ZONE_ID });
  return <div ref={setNodeRef} className="min-h-6" />;
}
