import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle } from "lucide-react";
import { useAiSettingsStore } from "@/features/chat/store";
import type { AiProvider } from "@/features/chat/types";
import { DEFAULT_AI_SETTINGS } from "@/features/chat/types";
import { ModelPicker } from "@/features/chat/ModelPicker";

const PREFLIGHT_PROVIDERS: AiProvider[] = [
  "openrouter",
  "openai",
  "anthropic",
  "ollama",
  "cli",
];

const PROVIDER_LABELS: Record<string, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
  ollama: "Ollama (local)",
  cli: "CLI Agent",
};

const NO_KEY_PROVIDERS = new Set<AiProvider>(["ollama", "cli"]);

interface AiProviderStepProps {
  onSetupLater: () => void;
}

export function AiProviderStep({ onSetupLater }: AiProviderStepProps) {
  const { t } = useTranslation();
  const {
    settings,
    hasApiKey,
    isTestingConnection,
    connectionTestResult,
    models,
    isLoadingModels,
    loadSettings,
    saveSettings,
    saveApiKey,
    testConnection,
    loadModels,
  } = useAiSettingsStore();

  const [apiKeyInput, setApiKeyInput] = useState("");
  const [localSettings, setLocalSettings] = useState(
    settings ?? { ...DEFAULT_AI_SETTINGS },
  );

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (settings) setLocalSettings(settings);
  }, [settings]);

  // Load models when key is available (non-CLI providers)
  useEffect(() => {
    if (!settings) return;
    const noKey = NO_KEY_PROVIDERS.has(settings.provider);
    if (hasApiKey || noKey) loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasApiKey, settings?.provider]);

  async function handleModelChange(modelId: string) {
    const updated = { ...localSettings, model: modelId };
    setLocalSettings(updated);
    await saveSettings(updated);
  }

  async function handleProviderChange(provider: AiProvider) {
    const updated = { ...localSettings, provider, model: "" };
    setLocalSettings(updated);
    await saveSettings(updated);
    await loadSettings();
  }

  async function handleSaveKey() {
    if (!apiKeyInput.trim()) return;
    await saveApiKey(apiKeyInput.trim());
    setApiKeyInput("");
    loadModels();
  }

  const provider =
    localSettings.provider as (typeof PREFLIGHT_PROVIDERS)[number];
  const needsKey = !NO_KEY_PROVIDERS.has(provider);
  const canTest = (hasApiKey || !needsKey) && !!localSettings.model;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="mb-1 text-center text-base font-semibold text-foreground">
          {t("preflight.step3Title")}
        </p>
        <p className="text-center text-xs text-muted-foreground">
          {t("preflight.step3Subtitle")}
        </p>
      </div>

      {/* Provider selection */}
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted-foreground">
          {t("preflight.selectProvider")}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {PREFLIGHT_PROVIDERS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => void handleProviderChange(p)}
              className={[
                "rounded-md border px-2.5 py-1 text-xs transition-colors",
                localSettings.provider === p
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:border-primary/50 hover:bg-accent",
              ].join(" ")}
            >
              {PROVIDER_LABELS[p as keyof typeof PROVIDER_LABELS] ?? p}
            </button>
          ))}
        </div>
      </div>

      {/* API key input */}
      {needsKey && !hasApiKey && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">
            {t("preflight.apiKey")}
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void handleSaveKey()}
              placeholder={t("preflight.keyPlaceholder")}
              className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <button
              type="button"
              onClick={() => void handleSaveKey()}
              disabled={!apiKeyInput.trim()}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {t("preflight.saveKey")}
            </button>
          </div>
        </div>
      )}

      {/* Key saved indicator */}
      {needsKey && hasApiKey && (
        <p className="flex items-center gap-1.5 text-xs text-emerald-500">
          <CheckCircle size={13} />
          {t("preflight.connected")}
        </p>
      )}

      {/* Model selection — shown once models can be loaded.
          CLI manages models separately so it's excluded. */}
      {provider !== "cli" && (hasApiKey || !needsKey) && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">
            {t("preflight.modelLabel")}
          </p>
          <ModelPicker
            models={models}
            value={localSettings.model}
            onChange={(id) => void handleModelChange(id)}
            isLoading={isLoadingModels}
            className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      )}

      {/* Test connection */}
      <button
        type="button"
        onClick={() => void testConnection()}
        disabled={!canTest || isTestingConnection}
        className="w-full rounded-lg border border-border py-2 text-xs text-muted-foreground hover:bg-accent disabled:opacity-40"
      >
        {isTestingConnection
          ? t("preflight.testing")
          : t("preflight.testConnection")}
      </button>

      {connectionTestResult && (
        <p
          className={[
            "text-center text-xs",
            connectionTestResult.success
              ? "text-emerald-500"
              : "text-destructive",
          ].join(" ")}
        >
          {connectionTestResult.success
            ? t("preflight.testSuccess")
            : connectionTestResult.message}
        </p>
      )}

      {/* Setup later */}
      <button
        type="button"
        onClick={onSetupLater}
        className="w-full py-1 text-xs text-muted-foreground/70 hover:text-muted-foreground underline underline-offset-2"
      >
        {t("preflight.setupLater")}
      </button>
    </div>
  );
}
