import { BROWSER_DIRECT_AI_PROVIDERS } from "@/features/chat/browserProviderPolicy";
import type { AiProvider } from "@/features/chat/types";

const PROVIDER_LABELS: Record<
  (typeof BROWSER_DIRECT_AI_PROVIDERS)[number],
  string
> = {
  ollama: "Ollama (Local LLM)",
  openai: "OpenAI (BYOK)",
  anthropic: "Anthropic (BYOK)",
};

export function WebEditorAiProviderPicker({
  provider,
  onSelect,
}: {
  provider: AiProvider;
  onSelect: (provider: AiProvider) => void;
}) {
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
          {PROVIDER_LABELS[candidate]}
        </button>
      ))}
    </div>
  );
}
