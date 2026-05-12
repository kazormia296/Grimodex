import { Sparkles } from "lucide-react";

export function EditorialTab() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-4 py-8 text-center">
      <Sparkles size={24} className="text-muted-foreground/50" />
      <p className="text-sm font-medium text-muted-foreground">
        批評機能は準備中
      </p>
      <p className="text-xs text-muted-foreground/70">
        レビュー・疑似コメント・メタ構造レビューが
        <br />
        ここに追加される予定です
      </p>
    </div>
  );
}
