import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";

interface ReorderCardProps {
  id: string;
  surface: string;
}

export function ReorderCard({ id, surface }: ReorderCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-start gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-sm shadow-sm",
        isDragging && "opacity-80 shadow-md",
      )}
    >
      <button
        type="button"
        className="mt-0.5 shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing"
        aria-label="drag handle"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={14} />
      </button>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
        {surface}
      </span>
    </div>
  );
}
