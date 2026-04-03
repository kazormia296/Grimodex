import { useState, useEffect, useCallback } from "react";
import { useAiSettingsStore } from "@/features/chat/store";
import { AI_PROVIDERS } from "@/features/chat/types";
import type { AiProvider } from "@/features/chat/types";
import { SettingSection } from "../components/SettingSection";
import { SettingRow } from "../components/SettingRow";
import { useSettingsStore } from "../settingsStore";

const PROVIDER_LABELS: Record<AiProvider, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
  ollama: "Ollama (ローカル)",
};

const BUDGET_LAYERS = [
  {
    key: "ai.contextBudget.l1",
    label: "L1 プロジェクト情報",
    min: 1,
    default: 2,
  },
  {
    key: "ai.contextBudget.l2",
    label: "L2 これまでの物語",
    min: 1,
    default: 10,
  },
  { key: "ai.contextBudget.l3", label: "L3 現在のシーン", min: 5, default: 40 },
  {
    key: "ai.contextBudget.l4",
    label: "L4 Codex & Snippets",
    min: 1,
    default: 20,
  },
  { key: "ai.contextBudget.l5", label: "L5 会話履歴", min: 1, default: 20 },
  {
    key: "ai.contextBudget.reserve",
    label: "レスポンス予約",
    min: 1,
    default: 5,
  },
];

export function AiCategory() {
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

  const settingsStore = useSettingsStore();

  const [apiKeyInput, setApiKeyInput] = useState("");
  const [localSettings, setLocalSettings] = useState(settings);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    if (settings) {
      setLocalSettings(settings);
    }
  }, [settings]);

  const handleLoadModels = useCallback(() => {
    if (settings) loadModels();
  }, [settings, loadModels]);

  useEffect(() => {
    if (hasApiKey && settings) handleLoadModels();
  }, [hasApiKey, settings?.provider, handleLoadModels]);

  async function handleProviderChange(provider: AiProvider) {
    const updated = { ...localSettings!, provider, model: "" };
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
    const updated = { ...localSettings!, model };
    setLocalSettings(updated);
    await saveSettings(updated);
  }

  async function handleEndpointChange(endpoint: string) {
    setLocalSettings((s) => (s ? { ...s, ollamaEndpoint: endpoint } : s));
  }

  async function handleSaveEndpoint() {
    if (localSettings) await saveSettings(localSettings);
  }

  // Context budget
  const budgetValues = BUDGET_LAYERS.map((l) => ({
    ...l,
    value: settingsStore.getNumber(l.key, l.default),
  }));
  const budgetTotal = budgetValues.reduce((sum, l) => sum + l.value, 0);
  const budgetError = budgetTotal > 100;

  if (!localSettings) {
    return <div className="p-6 text-sm text-muted-foreground">読み込み中…</div>;
  }

  return (
    <div className="p-6">
      {/* Provider */}
      <SettingSection title="プロバイダー">
        <div className="flex flex-wrap gap-2 mb-3">
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

        {/* Ollama endpoint */}
        {localSettings.provider === "ollama" && (
          <SettingRow label="エンドポイント">
            <input
              type="text"
              value={localSettings.ollamaEndpoint}
              onChange={(e) => handleEndpointChange(e.target.value)}
              onBlur={handleSaveEndpoint}
              className="w-48 rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
              placeholder="http://localhost:11434"
            />
          </SettingRow>
        )}

        {/* API Key */}
        {localSettings.provider !== "ollama" && (
          <SettingRow label="API キー">
            {hasApiKey ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  設定済み ✓
                </span>
                <button
                  type="button"
                  onClick={handleDeleteKey}
                  className="rounded-md border border-destructive px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                >
                  削除
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <div className="relative">
                  <input
                    type={showKey ? "text" : "password"}
                    value={apiKeyInput}
                    onChange={(e) => setApiKeyInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSaveKey()}
                    className="w-40 rounded-md border border-input bg-background px-2 py-1 pr-8 text-sm focus:outline-none"
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
                  className="rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground hover:bg-primary/90"
                >
                  保存
                </button>
              </div>
            )}
          </SettingRow>
        )}
      </SettingSection>

      {/* Models */}
      <SettingSection title="モデル">
        <SettingRow label="デフォルトチャットモデル">
          <div className="flex gap-2">
            <select
              value={localSettings.model}
              onChange={(e) => handleModelChange(e.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
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
              className="rounded-md border border-border px-2 py-1 text-sm hover:bg-accent disabled:opacity-50"
            >
              更新
            </button>
          </div>
        </SettingRow>

        <SettingRow
          label="インラインAIモデル"
          description="Editor の /コマンドで使用するモデル"
        >
          <select
            value={settingsStore.get("ai.inlineModel")}
            onChange={(e) =>
              settingsStore.set("ai.inlineModel", e.target.value)
            }
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
            disabled={isLoadingModels}
          >
            <option value="">チャットモデルと同じ</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </SettingRow>

        <SettingRow
          label="セッションタイトルモデル"
          description="セッション名の自動生成に使用するモデル"
        >
          <select
            value={settingsStore.get("ai.sessionTitleModel")}
            onChange={(e) =>
              settingsStore.set("ai.sessionTitleModel", e.target.value)
            }
            className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
            disabled={isLoadingModels}
          >
            <option value="">チャットモデルと同じ</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </SettingRow>

        {/* Test connection */}
        <div className="mt-2">
          <button
            type="button"
            onClick={testConnection}
            disabled={
              isTestingConnection ||
              !localSettings.model ||
              (!hasApiKey && localSettings.provider !== "ollama")
            }
            className="rounded-md bg-secondary px-3 py-1.5 text-sm text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
          >
            {isTestingConnection ? "接続テスト中…" : "接続テスト"}
          </button>
          {connectionTestResult && (
            <p
              className={`mt-1.5 text-sm ${
                connectionTestResult.success
                  ? "text-green-600"
                  : "text-destructive"
              }`}
            >
              {connectionTestResult.success ? "✓ " : "✗ "}
              {connectionTestResult.message}
            </p>
          )}
        </div>
      </SettingSection>

      {/* Context budget */}
      <SettingSection title="コンテキスト予算配分">
        <div className="space-y-2">
          {budgetValues.map((layer) => (
            <div key={layer.key} className="flex items-center gap-3">
              <span className="w-36 text-xs text-muted-foreground">
                {layer.label}
              </span>
              <input
                type="range"
                min={layer.min}
                max={60}
                step={1}
                value={layer.value}
                onChange={(e) => settingsStore.set(layer.key, e.target.value)}
                className="h-1.5 w-24 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
              />
              <span className="w-8 text-right text-xs tabular-nums">
                {layer.value}%
              </span>
            </div>
          ))}
          <div
            className={`mt-2 text-right text-xs tabular-nums ${
              budgetError
                ? "font-semibold text-destructive"
                : "text-muted-foreground"
            }`}
          >
            合計: {budgetTotal}%{budgetError && " (100% を超えています)"}
          </div>
          <button
            type="button"
            onClick={() => {
              BUDGET_LAYERS.forEach((l) =>
                settingsStore.set(l.key, String(l.default)),
              );
            }}
            className="mt-1 text-xs text-muted-foreground underline hover:text-foreground"
          >
            デフォルトにリセット
          </button>
        </div>
      </SettingSection>
    </div>
  );
}
