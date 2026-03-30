import { useState, useEffect, useCallback } from "react";
import { useAiSettingsStore } from "./store";
import { AI_PROVIDERS, DEFAULT_AI_SETTINGS } from "./types";
import type { AiProvider, AiSettings } from "./types";

const PROVIDER_LABELS: Record<AiProvider, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
  ollama: "Ollama (ローカル)",
};

interface AiSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function AiSettingsDialog({ open, onClose }: AiSettingsDialogProps) {
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

  const [apiKeyInput, setApiKeyInput] = useState("");
  const [localSettings, setLocalSettings] =
    useState<AiSettings>(DEFAULT_AI_SETTINGS);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    if (open) {
      loadSettings();
    }
  }, [open, loadSettings]);

  useEffect(() => {
    if (settings) {
      setLocalSettings(settings);
    }
  }, [settings]);

  const handleLoadModels = useCallback(() => {
    if (settings) {
      loadModels();
    }
  }, [settings, loadModels]);

  useEffect(() => {
    if (open && hasApiKey && settings) {
      handleLoadModels();
    }
  }, [open, hasApiKey, settings?.provider, handleLoadModels]);

  if (!open) return null;

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
    handleLoadModels();
  }

  async function handleDeleteKey() {
    await deleteApiKey();
    setApiKeyInput("");
  }

  async function handleModelChange(model: string) {
    const updated = { ...localSettings, model };
    setLocalSettings(updated);
    await saveSettings(updated);
  }

  async function handleEndpointChange(endpoint: string) {
    const updated = { ...localSettings, ollamaEndpoint: endpoint };
    setLocalSettings(updated);
  }

  async function handleSaveEndpoint() {
    await saveSettings(localSettings);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-lg border border-border bg-background p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">AI設定</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            ✕
          </button>
        </div>

        {/* Provider selection */}
        <div className="mb-4">
          <label className="mb-1 block text-sm font-medium">プロバイダー</label>
          <div className="flex flex-wrap gap-2">
            {AI_PROVIDERS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => handleProviderChange(p)}
                className={`rounded-md border px-3 py-1.5 text-sm ${
                  localSettings.provider === p
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-accent"
                }`}
              >
                {PROVIDER_LABELS[p]}
              </button>
            ))}
          </div>
        </div>

        {/* Ollama endpoint */}
        {localSettings.provider === "ollama" && (
          <div className="mb-4">
            <label className="mb-1 block text-sm font-medium">
              Ollamaエンドポイント
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={localSettings.ollamaEndpoint}
                onChange={(e) => handleEndpointChange(e.target.value)}
                onBlur={handleSaveEndpoint}
                className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
                placeholder="http://localhost:11434"
              />
            </div>
          </div>
        )}

        {/* API Key input */}
        {localSettings.provider !== "ollama" && (
          <div className="mb-4">
            <label className="mb-1 block text-sm font-medium">APIキー</label>
            {hasApiKey ? (
              <div className="flex items-center gap-2">
                <span className="flex-1 text-sm text-muted-foreground">
                  キー設定済み ✓
                </span>
                <button
                  type="button"
                  onClick={handleDeleteKey}
                  className="rounded-md border border-destructive px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10"
                >
                  削除
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input
                    type={showKey ? "text" : "password"}
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSaveKey()}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 pr-10 text-sm"
                    placeholder="sk-..."
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground"
                  >
                    {showKey ? "隠す" : "表示"}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={handleSaveKey}
                  className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
                >
                  保存
                </button>
              </div>
            )}
          </div>
        )}

        {/* Model selection */}
        <div className="mb-4">
          <label className="mb-1 block text-sm font-medium">モデル</label>
          <div className="flex gap-2">
            <select
              value={localSettings.model}
              onChange={(e) => handleModelChange(e.target.value)}
              className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
              disabled={isLoadingModels}
            >
              <option value="">
                {isLoadingModels ? "読み込み中…" : "モデルを選択"}
              </option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleLoadModels}
              disabled={isLoadingModels}
              className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"
            >
              更新
            </button>
          </div>
        </div>

        {/* Test connection */}
        <div className="mb-4">
          <button
            type="button"
            onClick={testConnection}
            disabled={
              isTestingConnection ||
              !localSettings.model ||
              (!hasApiKey && localSettings.provider !== "ollama")
            }
            className="rounded-md bg-secondary px-4 py-2 text-sm text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
          >
            {isTestingConnection ? "接続テスト中…" : "接続テスト"}
          </button>
          {connectionTestResult && (
            <p
              className={`mt-2 text-sm ${connectionTestResult.success ? "text-green-600" : "text-destructive-foreground"}`}
            >
              {connectionTestResult.success ? "✓ " : "✗ "}
              {connectionTestResult.message}
            </p>
          )}
        </div>

        {/* Close */}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}
