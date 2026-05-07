import { useCallback } from "react";
import { useDroppable } from "@dnd-kit/core";

/**
 * Wraps the editor content area as a dnd-kit droppable. Must be rendered as a
 * descendant of the relevant DndContext — registering useDroppable in the
 * EditorPane body would attach it to an ancestor (or default) DnD manager,
 * leaving the inner DndContext unable to resolve `over` for this zone.
 */
export function EditorDropDiv({
  outerRef,
  className,
  onClick,
  children,
  ...rest
}: {
  outerRef: React.MutableRefObject<HTMLDivElement | null>;
  className?: string;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  children: React.ReactNode;
  "data-show-foreshadow-marks"?: string;
  "data-focus-hide-beats"?: string;
}) {
  const { setNodeRef } = useDroppable({ id: "beat-editor-drop-zone" });
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      outerRef.current = el;
      setNodeRef(el);
    },
    [setNodeRef, outerRef],
  );
  return (
    <div ref={setRef} className={className} onClick={onClick} {...rest}>
      {children}
    </div>
  );
}
