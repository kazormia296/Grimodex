import { GripVertical } from "lucide-react";
import {
  Group,
  Panel,
  Separator,
  type GroupProps,
  type PanelProps,
} from "react-resizable-panels";
import { cn } from "@/lib/utils";

function ResizablePanelGroup({ className, ...props }: GroupProps) {
  return <Group className={cn("flex h-full w-full", className)} {...props} />;
}

function ResizablePanel({ className, ...props }: PanelProps) {
  return <Panel className={className} {...props} />;
}

function ResizableHandle({
  withHandle,
  horizontal,
  className,
  ...props
}: React.ComponentProps<typeof Separator> & {
  withHandle?: boolean;
  /** Use for vertical ResizablePanelGroups (top/bottom split) */
  horizontal?: boolean;
}) {
  return (
    <Separator
      className={cn(
        horizontal
          ? "relative flex h-px w-full cursor-row-resize items-center justify-center bg-border after:absolute after:inset-x-0 after:-bottom-1 after:-top-1 after:content-[''] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1"
          : "relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:-left-1 after:-right-1 after:content-[''] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1",
        className,
      )}
      {...props}
    >
      {withHandle && !horizontal && (
        <div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border bg-border">
          <GripVertical className="h-2.5 w-2.5" />
        </div>
      )}
    </Separator>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
