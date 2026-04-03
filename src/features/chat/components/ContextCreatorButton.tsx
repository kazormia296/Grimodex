import { Sparkles } from "lucide-react";

interface ContextCreatorButtonProps {
  onClick: () => void;
  disabled?: boolean;
}

export function ContextCreatorButton({
  onClick,
  disabled,
}: ContextCreatorButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={
        disabled
          ? "このモデルはツール使用に対応していません"
          : "AIがコンテキストに追加するエントリを提案します"
      }
      className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
      aria-label="AIコンテキスト提案"
    >
      <Sparkles className="h-3 w-3" />✦ AI
    </button>
  );
}
