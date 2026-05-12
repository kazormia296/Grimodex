import { MessageSquare } from "lucide-react";

export function CommentsTab() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-4 py-8 text-center">
      <MessageSquare size={24} className="text-muted-foreground/50" />
      <p className="text-sm font-medium text-muted-foreground">
        コメント集約は準備中
      </p>
      <p className="text-xs text-muted-foreground/70">
        インラインコメントの横断表示が
        <br />
        ここに追加される予定です
      </p>
    </div>
  );
}
