import { Check, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ModelPicker } from "@/features/chat/ModelPicker";
import { useAiSettingsStore } from "@/features/chat/store";
import {
  resolveActiveOpenaiCompatibleEndpoint,
  type AiProvider,
  type AiSettings,
  type OpenaiCompatibleEndpoint,
} from "@/features/chat/types";
import { applyEndpointsToSettings } from "@/features/settings/categories/openaiCompatibleEndpointsHelpers";
import { resolveModelApiVariant } from "@/features/chat/aiNovelist";
import { browserProviderRequiresApiKey } from "@/lib/browser-ai";
import { SettingRow } from "@/features/settings/components/SettingRow";
import { SettingSection } from "@/features/settings/components/SettingSection";
import { AiProjectSettings } from "@/features/settings/categories/AiProjectSettings";
import { OpenaiCompatibleEndpointsManager } from "@/features/settings/categories/OpenaiCompatibleEndpointsManager";
import { WebEditorAiProviderPicker } from "./WebEditorAiProviderPicker";
import { WebEditorApiKeySettings } from "./WebEditorApiKeySettings";
import { WebEditorOllamaSetup } from "./WebEditorOllamaSetup";

function canConnect(settings: AiSettings, hasApiKey: boolean): boolean {
  if (!settings.model) return false;
  if (settings.provider === "openai-compatible") {
    return Boolean(resolveActiveOpenaiCompatibleEndpoint(settings)?.baseUrl);
  }
  return !browserProviderRequiresApiKey(settings.provider) || hasApiKey;
}

export function WebEditorAiCategory() {
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
    deleteApiKey,
    testConnection,
    loadModels,
  } = useAiSettingsStore();
  const [localSettings, setLocalSettings] = useState<AiSettings | null>(
    settings,
  );
  const [apiKeyInput, setApiKeyInput] = useState("");

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    setLocalSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (!settings) return;
    if (!browserProviderRequiresApiKey(settings.provider) || hasApiKey) {
      void loadModels();
    }
  }, [hasApiKey, loadModels, settings]);

  if (!localSettings) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }

  const provider = localSettings.provider as AiProvider;
  const needsKey = browserProviderRequiresApiKey(provider);
  async function persist(next: AiSettings) {
    setLocalSettings(next);
    await saveSettings(next);
  }

  async function selectProvider(nextProvider: AiProvider) {
    await persist({
      ...localSettings!,
      provider: nextProvider,
      model: "",
      modelApiVariant: null,
    });
    await loadSettings();
  }

  async function saveKey() {
    const key = apiKeyInput.trim();
    if (!key) return;
    await saveApiKey(key);
    setApiKeyInput("");
    await loadModels();
  }

  async function changeCompatibleEndpoints(
    endpoints: OpenaiCompatibleEndpoint[],
    activeId: string | null,
  ) {
    const browserEndpoints = endpoints.map((endpoint) =>
      endpoint.apiVariant === "responses"
        ? { ...endpoint, apiVariant: null }
        : endpoint,
    );
    await persist(
      applyEndpointsToSettings(localSettings!, browserEndpoints, activeId),
    );
  }

  async function selectModel(model: string) {
    await persist({
      ...localSettings!,
      model,
      modelApiVariant:
        resolveModelApiVariant(
          provider,
          model,
          models,
          localSettings!.modelApiVariant,
        ) ?? null,
    });
  }

  return (
    <div className="space-y-6 p-6">
      <div className="rounded-md border border-primary/25 bg-primary/5 p-3 text-sm">
        <p className="font-medium">{t("hostedEditor.trial.aiNotice")}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("hostedEditor.trial.apiKeyMemoryNotice")}
        </p>
      </div>

      <SettingSection title={t("settings.ai.provider")}>
        <WebEditorAiProviderPicker
          provider={provider}
          onSelect={(candidate) => void selectProvider(candidate)}
        />

        {provider === "ollama" && (
          <>
            <SettingRow label={t("settings.ai.endpoint")}>
              <input
                type="url"
                value={localSettings.ollamaEndpoint}
                onChange={(event) =>
                  setLocalSettings({
                    ...localSettings,
                    ollamaEndpoint: event.target.value,
                    model: "",
                  })
                }
                onBlur={() => void persist(localSettings)}
                className="w-72 rounded-md border border-input bg-background px-2 py-1 text-sm"
                placeholder="http://localhost:11434"
              />
            </SettingRow>
            <WebEditorOllamaSetup />
          </>
        )}

        {provider === "openai-compatible" && (
          <OpenaiCompatibleEndpointsManager
            endpoints={localSettings.openaiCompatibleEndpoints ?? []}
            activeId={localSettings.activeOpenaiCompatibleEndpointId ?? null}
            onChange={(endpoints, activeId) =>
              void changeCompatibleEndpoints(endpoints, activeId)
            }
          />
        )}

        {needsKey && (
          <WebEditorApiKeySettings
            hasApiKey={hasApiKey}
            value={apiKeyInput}
            onChange={setApiKeyInput}
            onSave={() => void saveKey()}
            onDelete={() => void deleteApiKey()}
          />
        )}
      </SettingSection>

      <SettingSection title={t("settings.ai.models")}>
        <SettingRow label={t("settings.ai.defaultChatModel")}>
          <div className="flex gap-2">
            <ModelPicker
              models={models}
              value={localSettings.model}
              onChange={(model) => void selectModel(model)}
              isLoading={isLoadingModels}
            />
            <button
              type="button"
              onClick={() => void loadModels()}
              disabled={isLoadingModels || (needsKey && !hasApiKey)}
              className="rounded-md border border-border px-2 py-1 text-sm disabled:opacity-50"
            >
              {t("settings.ai.refresh")}
            </button>
          </div>
        </SettingRow>
        <button
          type="button"
          onClick={() => void testConnection()}
          disabled={
            isTestingConnection || !canConnect(localSettings, hasApiKey)
          }
          className="rounded-md bg-secondary px-3 py-1.5 text-sm text-secondary-foreground disabled:opacity-50"
        >
          {isTestingConnection
            ? t("settings.ai.testing")
            : t("settings.ai.testConnection")}
        </button>
        {connectionTestResult && (
          <p
            className={`mt-2 flex items-center gap-1 text-sm ${
              connectionTestResult.success
                ? "text-green-600"
                : "text-destructive"
            }`}
          >
            {connectionTestResult.success ? (
              <Check className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <X className="h-3.5 w-3.5" aria-hidden />
            )}
            {connectionTestResult.message}
          </p>
        )}
      </SettingSection>

      <AiProjectSettings />
    </div>
  );
}
