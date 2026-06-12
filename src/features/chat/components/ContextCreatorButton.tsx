import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";

interface ContextCreatorButtonProps {
  onClick: () => void;
  disabled?: boolean;
}

export function ContextCreatorButton({
  onClick,
  disabled,
}: ContextCreatorButtonProps) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={
        disabled
          ? t("chat.contextCreator.disabledTitle")
          : t("chat.contextCreator.enabledTitle")
      }
      className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
      aria-label={t("chat.contextCreator.ariaLabel")}
    >
      <Sparkles className="h-3 w-3" aria-hidden />
      AI
    </button>
  );
}
