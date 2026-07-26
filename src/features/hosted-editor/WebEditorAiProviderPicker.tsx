import { BROWSER_DIRECT_AI_PROVIDERS } from "@/features/chat/browserProviderPolicy";
import type { AiProvider } from "@/features/chat/types";
import { getProviderLabel } from "@/features/chat/providerLabels";
import { useTranslation } from "react-i18next";

export function WebEditorAiProviderPicker({
  provider,
  onSelect,
}: {
  provider: AiProvider;
  onSelect: (provider: AiProvider) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {BROWSER_DIRECT_AI_PROVIDERS.map((candidate) => (
        <button
          key={candidate}
          type="button"
          onClick={() => onSelect(candidate)}
          className={`rounded-md border px-3 py-1.5 text-sm ${
            provider === candidate
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border hover:bg-accent"
          }`}
        >
          {getProviderLabel(candidate, t)}
        </button>
      ))}
    </div>
  );
}
