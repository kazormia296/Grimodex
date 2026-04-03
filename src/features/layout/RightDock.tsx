import { ChatPanel } from "@/features/chat/ChatPanel";

export function RightDock() {
  return (
    <div className="flex h-full flex-col overflow-hidden border-l border-border bg-background">
      <ChatPanel />
    </div>
  );
}
