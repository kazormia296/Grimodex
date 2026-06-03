import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  useAiSettingsStore,
  isRagCapableProvider,
} from "@/features/chat/store";
import { normalizeDomainList } from "@/features/chat/webSearchConfig";
import { ModelPicker } from "@/features/chat/ModelPicker";
import {
  AI_PROVIDERS,
  DEFAULT_OPENAI_COMPATIBLE_SETTINGS,
  OPENROUTER_PROVIDER_PINS,
  groupModelsByDeveloper,
} from "@/features/chat/types";
import type { AiProvider, CliKind, AiModel } from "@/features/chat/types";
import { detectCliBinary, testCliConnection } from "@/features/chat/cliApi";
import { resolveModelCapabilities } from "@/features/chat/agent/modelLimits";
import {
  AINOVERIST_BASE_URL,
  AINOVERIST_V1_BASE_URL,
  AINOVERIST_EXTRA_SAMPLING_KEYS,
  isAinoveristV1Model,
  resolveAinoveristApiVariant,
} from "@/features/chat/aiNovelist";
import { SettingSection } from "../components/SettingSection";
import { SettingScopeHeader } from "../components/SettingScopeHeader";
import { SettingRow } from "../components/SettingRow";
import { SettingToggle } from "../components/SettingToggle";
import { SettingTextarea } from "../components/SettingTextarea";
import { useSettingsStore } from "../settingsStore";

/** AI プロンプト追記カスタマイズの対象スロット (project_settings の key 末尾)。 */
const PROMPT_CUSTOM_SLOTS = [
  "chat",
  "kouetsu",
  "inline",
  "beat",
  "aiBranch",
] as const;

const PROVIDER_LABELS: Record<AiProvider, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
  ollama: "ollama-local",
  "openai-compatible": "OpenAI 互換",
  "ai-novelist": "AI のべりすと",
  cli: "CLI エージェント",
};

/** AI のべりすと等のサンプリングキーで「数値型」として扱うキー */
const NUMERIC_SAMPLING_KEYS = new Set([
  "top_a",
  "tailfree",
  "typical_p",
  "min_p",
  "rep_pen",
]);

function withCustomCliModel(models: AiModel[], current?: string): AiModel[] {
  const trimmed = current?.trim();
  if (!trimmed || models.some((m) => m.id === trimmed)) return models;
  return [{ id: trimmed, name: `${trimmed} (custom)` }, ...models];
}

/**
 * サンプリング 1 キー分の編集 UI を返す。
 * - 数値キー: number input、空欄なら undefined
 * - その他: text input、JSON.parse 可能ならパース、不能なら文字列保存
 */
function renderSamplingInput(
  key: string,
  value: unknown,
  onChange: (next: unknown) => void,
  onBlur: () => void,
): React.ReactNode {
  const isNumeric = NUMERIC_SAMPLING_KEYS.has(key);
  const display =
    value === undefined || value === null
      ? ""
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  return (
    <div key={key} className="flex items-center gap-2">
      <label className="w-24 shrink-0 text-xs font-mono text-muted-foreground">
        {key}
      </label>
      <input
        type={isNumeric ? "number" : "text"}
        step={isNumeric ? "any" : undefined}
        value={display}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") {
            onChange(undefined);
            return;
          }
          if (isNumeric) {
            const n = Number(raw);
            onChange(Number.isFinite(n) ? n : undefined);
            return;
          }
          // 文字列キー: JSON parse 可能ならパース、不能なら生文字列
          try {
            onChange(JSON.parse(raw));
          } catch {
            onChange(raw);
          }
        }}
        onBlur={onBlur}
        className="flex-1 rounded-md border border-input bg-background px-2 py-1 text-sm font-mono focus:outline-none"
        placeholder="(空欄で省略)"
      />
    </div>
  );
}

export function AiCategory() {
  const { t } = useTranslation();

  const BUDGET_LAYERS = [
    {
      key: "ai.contextBudget.l1",
      label: t("settings.ai.contextBudgetL1"),
      min: 1,
      default: 2,
    },
    {
      key: "ai.contextBudget.l2",
      label: t("settings.ai.contextBudgetL2"),
      min: 1,
      default: 10,
    },
    {
      key: "ai.contextBudget.l3",
      label: t("settings.ai.contextBudgetL3"),
      min: 5,
      default: 40,
    },
    {
      key: "ai.contextBudget.l4",
      label: t("settings.ai.contextBudgetL4"),
      min: 1,
      default: 20,
    },
    {
      key: "ai.contextBudget.l5",
      label: t("settings.ai.contextBudgetL5"),
      min: 1,
      default: 20,
    },
    {
      key: "ai.contextBudget.reserve",
      label: t("settings.ai.contextBudgetReserve"),
      min: 1,
      default: 5,
    },
  ];

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
  const [whitelistFilter, setWhitelistFilter] = useState("");
  // Web 検索ドメインの textarea バッファ（null = settingsStore から再同期）。
  const [webSearchDomainsText, setWebSearchDomainsText] = useState<
    string | null
  >(null);

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
    if (!settings) return;
    // ollama / ai-novelist は認証不要でモデル一覧を取得できる
    const noKeyNeeded =
      settings.provider === "ollama" ||
      settings.provider === "ai-novelist" ||
      settings.provider === "cli";
    if (hasApiKey || noKeyNeeded) {
      handleLoadModels();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasApiKey, settings?.provider, handleLoadModels]);

  async function handleProviderChange(provider: AiProvider) {
    const updated = {
      ...localSettings!,
      provider,
      model: "",
      cli:
        provider === "cli"
          ? (localSettings!.cli ?? {
              kind: "claude" as CliKind,
              binaryPath: "",
              model: "",
            })
          : localSettings!.cli,
      // OpenAI 互換に切替時は openaiCompatible 設定を初期化（既存値は保持）
      openaiCompatible:
        localSettings!.openaiCompatible ?? DEFAULT_OPENAI_COMPATIBLE_SETTINGS,
    };
    setLocalSettings(updated);
    await saveSettings(updated);
    await loadSettings();
  }

  async function handleOpenaiCompatChange<
    K extends keyof NonNullable<typeof localSettings>["openaiCompatible"],
  >(key: K, value: NonNullable<typeof localSettings>["openaiCompatible"][K]) {
    setLocalSettings((s) =>
      s
        ? {
            ...s,
            openaiCompatible: { ...s.openaiCompatible, [key]: value },
          }
        : s,
    );
  }

  async function handleSaveOpenaiCompat() {
    if (localSettings) await saveSettings(localSettings);
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
    const apiVariant = resolveAinoveristApiVariant(
      model,
      models,
      localSettings?.modelApiVariant,
    );
    const updated = {
      ...localSettings!,
      model,
      modelApiVariant: apiVariant ?? null,
    };
    setLocalSettings(updated);
    await saveSettings(updated);
  }

  async function handleThinkingToggle() {
    const updated = {
      ...localSettings!,
      thinkingEnabled: !localSettings!.thinkingEnabled,
    };
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

  const providerLabel = (p: AiProvider) =>
    p === "ollama" ? t("settings.ai.ollamaLocal") : PROVIDER_LABELS[p];

  if (!localSettings) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="p-6">
      <SettingScopeHeader title={t("settings.scopeGlobal")} />
      {/* Provider */}
      <SettingSection title={t("settings.ai.provider")}>
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
              {providerLabel(p)}
            </button>
          ))}
        </div>

        {/* Ollama endpoint */}
        {localSettings.provider === "ollama" && (
          <SettingRow label={t("settings.ai.endpoint")}>
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

        {/* OpenAI 互換 (カスタム): Base URL + コンテキスト窓 + 最大出力 */}
        {localSettings.provider === "openai-compatible" && (
          <>
            <p className="mb-2 text-xs text-muted-foreground">
              llama.cpp / LM Studio / vLLM / 自前ホストの GPU
              推論サーバ等。baseURL を入力してください。API
              キーが不要なサーバの場合は空欄で構いません。
            </p>
            <SettingRow label="Base URL">
              <input
                type="text"
                value={localSettings.openaiCompatible?.baseUrl ?? ""}
                onChange={(e) =>
                  handleOpenaiCompatChange("baseUrl", e.target.value)
                }
                onBlur={handleSaveOpenaiCompat}
                className="w-72 rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
                placeholder="http://localhost:1234/v1"
              />
            </SettingRow>
            <SettingRow
              label="コンテキスト窓 (tokens)"
              description="モデルの最大入力トークン数。空欄時は 8,000 にフォールバック"
            >
              <input
                type="number"
                min={1}
                value={localSettings.openaiCompatible?.customMaxContext ?? ""}
                onChange={(e) =>
                  handleOpenaiCompatChange(
                    "customMaxContext",
                    e.target.value ? Number(e.target.value) : undefined,
                  )
                }
                onBlur={handleSaveOpenaiCompat}
                className="w-32 rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
                placeholder="8000"
              />
            </SettingRow>
            <SettingRow
              label="最大出力 (tokens)"
              description="モデル固有の出力上限。指定すると応答予約のクランプに使われる"
            >
              <input
                type="number"
                min={1}
                value={localSettings.openaiCompatible?.customMaxOutput ?? ""}
                onChange={(e) =>
                  handleOpenaiCompatChange(
                    "customMaxOutput",
                    e.target.value ? Number(e.target.value) : undefined,
                  )
                }
                onBlur={handleSaveOpenaiCompat}
                className="w-32 rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
                placeholder="(任意)"
              />
            </SettingRow>
            <SettingRow
              label="Codex 自動抽出 / Synopsis 自動生成を許可"
              description="構造化出力 (JSON) の精度が低い場合はオフのままにしてください"
            >
              <input
                type="checkbox"
                checked={
                  localSettings.openaiCompatible?.enableStructuredTasks ?? false
                }
                onChange={async (e) => {
                  const updated = {
                    ...localSettings,
                    openaiCompatible: {
                      ...localSettings.openaiCompatible,
                      enableStructuredTasks: e.target.checked,
                    },
                  };
                  setLocalSettings(updated);
                  await saveSettings(updated);
                }}
                className="h-4 w-4"
              />
            </SettingRow>
          </>
        )}

        {/* AI のべりすと: 固定 URL 表示 + サンプリングパラメータ + 構造化出力許可 */}
        {localSettings.provider === "ai-novelist" && (
          <>
            <p className="mb-2 text-xs text-muted-foreground">
              日本語小説特化のプロバイダ。API キーは{" "}
              <span className="font-mono">ai-novel.com/account_api.php</span>{" "}
              で発行できます。
            </p>
            <SettingRow label="Base URL (legacy)">
              <span className="text-sm text-muted-foreground font-mono">
                {AINOVERIST_BASE_URL}
              </span>
            </SettingRow>
            <SettingRow label="Base URL (v1)">
              <span className="text-sm text-muted-foreground font-mono">
                {AINOVERIST_V1_BASE_URL}
              </span>
            </SettingRow>
            <SettingRow
              label="多言語モード"
              description="日本語以外で生成する場合に有効にしてください（spiko Ultra / v1 モデル向け）"
            >
              <input
                type="checkbox"
                checked={localSettings.aiNovelist?.multilingualMode ?? false}
                onChange={async (e) => {
                  const updated = {
                    ...localSettings,
                    aiNovelist: {
                      ...localSettings.aiNovelist,
                      multilingualMode: e.target.checked,
                    },
                  };
                  setLocalSettings(updated);
                  await saveSettings(updated);
                }}
                className="h-4 w-4"
              />
            </SettingRow>
            {!isAinoveristV1Model(
              localSettings.model,
              resolveAinoveristApiVariant(
                localSettings.model,
                models,
                localSettings.modelApiVariant,
              ),
            ) && (
              <div className="mt-3 mb-2">
                <p className="mb-1 text-sm font-medium text-foreground">
                  サンプリングパラメータ
                </p>
                <p className="mb-2 text-xs text-muted-foreground">
                  空欄でリクエストから省略されます。配列・オブジェクトは JSON
                  文字列で入力してください（例:{" "}
                  <code className="font-mono">["foo","bar"]</code>）。
                </p>
                <div className="space-y-1.5">
                  {AINOVERIST_EXTRA_SAMPLING_KEYS.map((key) =>
                    renderSamplingInput(
                      key,
                      localSettings.aiNovelist?.sampling?.[key],
                      (next) => {
                        const current =
                          localSettings.aiNovelist?.sampling ?? {};
                        const merged = { ...current };
                        if (next === undefined) {
                          delete merged[key];
                        } else {
                          merged[key] = next;
                        }
                        const updated = {
                          ...localSettings,
                          aiNovelist: {
                            ...localSettings.aiNovelist,
                            sampling: merged,
                          },
                        };
                        setLocalSettings(updated);
                        void saveSettings(updated);
                      },
                      () => {
                        /* onBlur は no-op: onChange で同期保存済み */
                      },
                    ),
                  )}
                </div>
              </div>
            )}
            <SettingRow
              label="Codex 自動抽出 / Synopsis 自動生成を許可"
              description={
                isAinoveristV1Model(
                  localSettings.model,
                  resolveAinoveristApiVariant(
                    localSettings.model,
                    models,
                    localSettings.modelApiVariant,
                  ),
                )
                  ? "v1 モデルでは利用可能ですが、デフォルトは保守的に無効化されています"
                  : "このプロバイダは構造化出力 (JSON) の精度が低いため、デフォルトで無効化されています"
              }
            >
              <input
                type="checkbox"
                checked={
                  localSettings.aiNovelist?.enableStructuredTasks ?? false
                }
                onChange={async (e) => {
                  const updated = {
                    ...localSettings,
                    aiNovelist: {
                      ...localSettings.aiNovelist,
                      enableStructuredTasks: e.target.checked,
                    },
                  };
                  setLocalSettings(updated);
                  await saveSettings(updated);
                }}
                className="h-4 w-4"
              />
            </SettingRow>
          </>
        )}

        {/* CLI プロバイダ: 種別選択 + バイナリ検出 + 接続テスト */}
        {localSettings.provider === "cli" &&
          (() => {
            const cli = localSettings.cli ?? {
              kind: "claude" as CliKind,
              binaryPath: "",
              model: "",
            };
            const updateCliLocal = (patch: Partial<typeof cli>): void => {
              setLocalSettings((s) => {
                if (!s) return s;
                const current = s.cli ?? {
                  kind: "claude" as CliKind,
                  binaryPath: "",
                  model: "",
                };
                return { ...s, cli: { ...current, ...patch } };
              });
            };
            const persistCliSettings = (): void => {
              setLocalSettings((s) => {
                if (s) void saveSettings(s);
                return s;
              });
            };
            const updateCli = async (
              patch: Partial<typeof cli>,
            ): Promise<void> => {
              const updated = {
                ...localSettings,
                cli: { ...cli, ...patch },
              };
              setLocalSettings(updated);
              await saveSettings(updated);
            };
            return (
              <>
                <SettingRow label="CLI 種別">
                  <select
                    value={cli.kind}
                    onChange={(e) => {
                      void updateCli({
                        kind: e.target.value as CliKind,
                        // バイナリパスは CLI 種別に紐づくのでクリア
                        binaryPath: "",
                      }).then(() => handleLoadModels());
                    }}
                    className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
                  >
                    <option value="claude">Claude Code (claude)</option>
                    <option value="codex">Codex CLI (codex)</option>
                    <option value="opencode">OpenCode (opencode)</option>
                  </select>
                </SettingRow>
                <p className="mb-2 text-xs text-muted-foreground">
                  CLI 側で事前に{" "}
                  <code className="font-mono">
                    {cli.kind === "opencode"
                      ? "opencode auth login"
                      : cli.kind === "codex"
                        ? "codex login"
                        : "claude login"}
                  </code>{" "}
                  等で認証を済ませてください。本パネルからはツール (ファイル R/W
                  / shell) は全て無効化された状態で起動します。
                </p>
                <SettingRow
                  label="バイナリパス"
                  description="空欄なら CLI 名で PATH 解決。「自動検出」は macOS/Linux で bash -lc which、Windows で where.exe を使います"
                >
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={cli.binaryPath ?? ""}
                      onChange={(e) =>
                        updateCliLocal({ binaryPath: e.target.value })
                      }
                      onBlur={persistCliSettings}
                      className="w-72 rounded-md border border-input bg-background px-2 py-1 text-sm font-mono focus:outline-none"
                      placeholder={`${cli.kind}（PATH またはフルパス）`}
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        const path = await detectCliBinary(cli.kind);
                        if (path) {
                          await updateCli({ binaryPath: path });
                          handleLoadModels();
                          toast.success(`検出: ${path}`);
                        } else {
                          toast.error(
                            `${cli.kind} が PATH 上で見つかりませんでした。手動でパスを指定してください。`,
                          );
                        }
                      }}
                      className="rounded-md border border-border px-2 py-1 text-sm hover:bg-accent"
                    >
                      自動検出
                    </button>
                  </div>
                </SettingRow>
                <SettingRow
                  label="モデル"
                  description={
                    cli.kind === "claude"
                      ? "Claude Code は一覧コマンドがないためよく使うモデルを表示します。空欄なら CLI のデフォルト"
                      : "CLI から取得したモデル一覧。空欄なら CLI のデフォルト"
                  }
                >
                  <div className="flex gap-2">
                    <ModelPicker
                      models={withCustomCliModel(models, cli.model ?? "")}
                      value={cli.model ?? ""}
                      onChange={(modelId) => void updateCli({ model: modelId })}
                      isLoading={isLoadingModels}
                      placeholder="(CLI デフォルト)"
                    />
                    <button
                      type="button"
                      onClick={handleLoadModels}
                      disabled={isLoadingModels}
                      className="rounded-md border border-border px-2 py-1 text-sm hover:bg-accent disabled:opacity-50"
                    >
                      {t("settings.ai.refresh")}
                    </button>
                  </div>
                </SettingRow>
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={async () => {
                      const path = cli.binaryPath || cli.kind;
                      try {
                        const version = await testCliConnection(path);
                        toast.success(`接続成功: ${version}`);
                      } catch (e) {
                        toast.error(
                          `接続失敗: ${e instanceof Error ? e.message : String(e)}`,
                        );
                      }
                    }}
                    disabled={!cli.binaryPath && !cli.kind}
                    className="rounded-md bg-secondary px-3 py-1.5 text-sm text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
                  >
                    接続テスト (--version)
                  </button>
                </div>
              </>
            );
          })()}

        {/* API Key */}
        {localSettings.provider !== "ollama" &&
          localSettings.provider !== "cli" && (
            <SettingRow
              label={t("settings.ai.apiKey")}
              description={
                localSettings.provider === "openai-compatible"
                  ? "ローカル LLM サーバ等で API キーが不要な場合は空欄で構いません"
                  : localSettings.provider === "ai-novelist"
                    ? "ai-novel.com/account_api.php で発行した API キーを入力してください"
                    : undefined
              }
            >
              {hasApiKey ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">
                    {t("settings.ai.keySet")}
                  </span>
                  <button
                    type="button"
                    onClick={handleDeleteKey}
                    className="rounded-md border border-destructive px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                  >
                    {t("settings.ai.deleteKey")}
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
                      {showKey
                        ? t("settings.ai.hideKey")
                        : t("settings.ai.showKey")}
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={handleSaveKey}
                    className="rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground hover:bg-primary/90"
                  >
                    {t("settings.ai.saveKey")}
                  </button>
                </div>
              )}
            </SettingRow>
          )}
      </SettingSection>

      {/* Models */}
      <SettingSection title={t("settings.ai.models")}>
        {(() => {
          const grouped = groupModelsByDeveloper(models);
          const devLabel = (dev: string) =>
            dev
              ? dev.charAt(0).toUpperCase() + dev.slice(1)
              : t("common.other");
          const whitelist: string[] = (() => {
            try {
              return JSON.parse(settingsStore.get("ai.modelWhitelist") || "[]");
            } catch {
              return [];
            }
          })();
          const handleWhitelistToggle = (modelId: string, add: boolean) => {
            const current: string[] = (() => {
              try {
                return JSON.parse(
                  settingsStore.get("ai.modelWhitelist") || "[]",
                );
              } catch {
                return [];
              }
            })();
            const next = add
              ? [...current, modelId]
              : current.filter((id) => id !== modelId);
            settingsStore.set("ai.modelWhitelist", JSON.stringify(next));
          };

          return (
            <>
              {localSettings.provider !== "cli" && (
                <SettingRow label={t("settings.ai.defaultChatModel")}>
                  <div className="flex gap-2">
                    <ModelPicker
                      models={models}
                      value={localSettings.model}
                      onChange={handleModelChange}
                      isLoading={isLoadingModels}
                    />
                    <button
                      type="button"
                      onClick={handleLoadModels}
                      disabled={isLoadingModels}
                      className="rounded-md border border-border px-2 py-1 text-sm hover:bg-accent disabled:opacity-50"
                    >
                      {t("settings.ai.refresh")}
                    </button>
                  </div>
                </SettingRow>
              )}

              <SettingRow
                label={t("settings.ai.inlineModel")}
                description={t("settings.ai.inlineModelDesc")}
              >
                <ModelPicker
                  models={models}
                  value={settingsStore.get("ai.inlineModel")}
                  onChange={(v) => settingsStore.set("ai.inlineModel", v)}
                  isLoading={isLoadingModels}
                  placeholder={t("settings.ai.sameChatModel")}
                />
              </SettingRow>

              <SettingRow
                label={t("settings.ai.titleModel")}
                description={t("settings.ai.titleModelDesc")}
              >
                <ModelPicker
                  models={models}
                  value={settingsStore.get("ai.sessionTitleModel")}
                  onChange={(v) => settingsStore.set("ai.sessionTitleModel", v)}
                  isLoading={isLoadingModels}
                  placeholder={t("settings.ai.sameChatModel")}
                />
              </SettingRow>

              {/* Model whitelist */}
              {models.length > 0 && (
                <div className="mt-3">
                  <p className="mb-1 text-sm font-medium text-foreground">
                    {t("settings.ai.modelWhitelist")}
                  </p>
                  <p className="mb-2 text-xs text-muted-foreground">
                    {t("settings.ai.modelWhitelistDesc")}
                  </p>
                  <input
                    type="search"
                    value={whitelistFilter}
                    onChange={(e) => setWhitelistFilter(e.target.value)}
                    placeholder={t("settings.ai.modelWhitelistSearch")}
                    className="mb-1.5 w-full rounded-md border border-input bg-background px-2 py-1 text-xs focus:outline-none"
                  />
                  <div className="max-h-48 overflow-y-auto rounded-md border border-border bg-muted/30 p-2">
                    {(() => {
                      const q = whitelistFilter.trim().toLowerCase();
                      const filteredGrouped = q
                        ? grouped
                            .map(
                              ([dev, devModels]) =>
                                [
                                  dev,
                                  devModels.filter(
                                    (m) =>
                                      (m.name || m.id)
                                        .toLowerCase()
                                        .includes(q) ||
                                      dev.toLowerCase().includes(q),
                                  ),
                                ] as [string, typeof devModels],
                            )
                            .filter(([, devModels]) => devModels.length > 0)
                        : grouped;
                      if (filteredGrouped.length === 0) {
                        return (
                          <p className="px-1.5 py-2 text-xs text-muted-foreground">
                            {t("settings.ai.modelWhitelistNoResults")}
                          </p>
                        );
                      }
                      return filteredGrouped.map(([dev, devModels]) => (
                        <div key={dev || "__other"}>
                          {grouped.length > 1 && (
                            <div className="px-1.5 pb-0.5 pt-2 first:pt-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                              {devLabel(dev)}
                            </div>
                          )}
                          {devModels.map((m) => (
                            <label
                              key={m.id}
                              className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent"
                            >
                              <input
                                type="checkbox"
                                checked={whitelist.includes(m.id)}
                                onChange={(e) =>
                                  handleWhitelistToggle(m.id, e.target.checked)
                                }
                                className="h-3 w-3 shrink-0"
                              />
                              <span className="truncate">{m.name || m.id}</span>
                            </label>
                          ))}
                        </div>
                      ));
                    })()}
                  </div>
                </div>
              )}
            </>
          );
        })()}

        {/* Thinking toggle — thinking対応モデル選択時のみ表示 */}
        {localSettings.model &&
          (() => {
            const selectedApiVariant = resolveAinoveristApiVariant(
              localSettings.model,
              models,
              localSettings.modelApiVariant,
            );
            const caps = resolveModelCapabilities(
              localSettings.model,
              localSettings,
              selectedApiVariant,
            );
            return (
              caps.supportsAdaptiveThinking ||
              caps.supportsThinking ||
              caps.supportsReasoning
            );
          })() && (
            <SettingRow
              label={t("settings.ai.thinkingMode")}
              description={t("settings.ai.thinkingModeDesc")}
            >
              <button
                type="button"
                onClick={handleThinkingToggle}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
                  localSettings.thinkingEnabled
                    ? "bg-primary"
                    : "bg-muted-foreground/30"
                }`}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                    localSettings.thinkingEnabled
                      ? "translate-x-4"
                      : "translate-x-0.5"
                  }`}
                />
              </button>
            </SettingRow>
          )}

        {/* OpenRouter provider pin (OpenRouter 選択時のみ) */}
        {localSettings.provider === "openrouter" && (
          <SettingRow
            label="Provider pin"
            description="OpenRouter のルーティングを 1 つの provider に固定し、Anthropic prompt cache を効きやすくする。fallbacks 有効なので落ちたら別 provider に逃げる。"
          >
            <select
              value={localSettings.openrouterProviderPin ?? ""}
              onChange={async (e) => {
                const v = e.target.value;
                const updated = {
                  ...localSettings!,
                  openrouterProviderPin: v === "" ? null : v,
                };
                setLocalSettings(updated);
                await saveSettings(updated);
              }}
              className="rounded-md border border-input bg-background px-2 py-1 text-sm"
            >
              <option value="">指定しない（OpenRouter デフォルト）</option>
              {OPENROUTER_PROVIDER_PINS.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.label}
                </option>
              ))}
            </select>
          </SettingRow>
        )}

        {/* Test connection (CLI は専用ボタンが上にあるためここでは非表示) */}
        {localSettings.provider !== "cli" && (
          <div className="mt-2">
            <button
              type="button"
              onClick={testConnection}
              disabled={
                isTestingConnection ||
                !localSettings.model ||
                (!hasApiKey &&
                  localSettings.provider !== "ollama" &&
                  localSettings.provider !== "openai-compatible")
              }
              className="rounded-md bg-secondary px-3 py-1.5 text-sm text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
            >
              {isTestingConnection
                ? t("settings.ai.testing")
                : t("settings.ai.testConnection")}
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
        )}
      </SettingSection>

      {/* Web 検索 (RAG) ドメイン制御 (global) — RAG 対応プロバイダのみ表示 */}
      {isRagCapableProvider(localSettings.provider) &&
        (() => {
          const mode = settingsStore.get("ai.webSearch.domainMode", "off");
          const domainsJson = settingsStore.get("ai.webSearch.domains", "[]");
          const domainsTextValue =
            webSearchDomainsText ??
            (() => {
              try {
                const a = JSON.parse(domainsJson);
                return Array.isArray(a) ? a.join("\n") : "";
              } catch {
                return "";
              }
            })();
          const persistDomains = () => {
            // wire 側と同じ正規化を使い、表示と実際に送る値の乖離を防ぐ。
            const arr = normalizeDomainList(domainsTextValue.split("\n"));
            settingsStore.set("ai.webSearch.domains", JSON.stringify(arr));
            // null に戻して次の描画で store の正規化済み値から再導出させる。
            setWebSearchDomainsText(null);
          };
          // 正規化後に残るドメイン数（allow が空＝fail-open 判定に使う）。
          const effectiveDomainCount = normalizeDomainList(
            domainsTextValue.split("\n"),
          ).length;
          const maxTokensSet =
            Number(settingsStore.get("ai.webSearch.maxContentTokens", "")) > 0;
          // exa 強制・content cap・未検証警告は OpenRouter 経路のみ。Anthropic は
          // native web_search でドメイン制御を検証済み（exa 非経由・追加課金なし）。
          const isOpenRouter = localSettings.provider === "openrouter";
          const forcesExa = isOpenRouter && (mode !== "off" || maxTokensSet);
          return (
            <SettingSection title={t("settings.ai.webSearch.title")}>
              <p className="mb-2 text-xs text-muted-foreground">
                {t("settings.ai.webSearch.providerNote")}
              </p>
              {/* 第三者送信の永続的・SR可読な開示（security review F-1）。 */}
              <p className="mb-2 text-xs text-amber-600 dark:text-amber-500">
                {t("settings.ai.webSearch.privacyNote")}
              </p>
              <SettingRow
                label={t("settings.ai.webSearch.domainMode")}
                description={t("settings.ai.webSearch.domainModeDesc")}
              >
                <select
                  value={mode}
                  onChange={(e) =>
                    settingsStore.set("ai.webSearch.domainMode", e.target.value)
                  }
                  className="rounded-md border border-input bg-background px-2 py-1 text-sm"
                >
                  <option value="off">
                    {t("settings.ai.webSearch.domainModeOff")}
                  </option>
                  <option value="allow">
                    {t("settings.ai.webSearch.domainModeAllow")}
                  </option>
                  <option value="block">
                    {t("settings.ai.webSearch.domainModeBlock")}
                  </option>
                </select>
              </SettingRow>
              {mode !== "off" && (
                <SettingRow
                  label={t("settings.ai.webSearch.domains")}
                  description={t("settings.ai.webSearch.domainsDesc")}
                >
                  <textarea
                    value={domainsTextValue}
                    onChange={(e) => setWebSearchDomainsText(e.target.value)}
                    onBlur={persistDomains}
                    rows={4}
                    className="w-72 rounded-md border border-input bg-background px-2 py-1 text-sm font-mono focus:outline-none"
                    placeholder={t("settings.ai.webSearch.domainsPlaceholder")}
                  />
                </SettingRow>
              )}
              {/* allow リストが空 = fail-open（全 Web 検索）の注意喚起。 */}
              {mode === "allow" && effectiveDomainCount === 0 && (
                <p className="-mt-1 mb-1 text-xs text-amber-600 dark:text-amber-500">
                  {t("settings.ai.webSearch.allowEmptyWarning")}
                </p>
              )}
              {/* content cap は OpenRouter(exa) 専用。Anthropic には対応フィールド無し。 */}
              {isOpenRouter && (
                <SettingRow
                  label={t("settings.ai.webSearch.maxContentTokens")}
                  description={t("settings.ai.webSearch.maxContentTokensDesc")}
                >
                  <input
                    type="number"
                    min={1}
                    value={settingsStore.get(
                      "ai.webSearch.maxContentTokens",
                      "",
                    )}
                    onChange={(e) =>
                      settingsStore.set(
                        "ai.webSearch.maxContentTokens",
                        e.target.value,
                      )
                    }
                    className="w-32 rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
                    placeholder="4000"
                  />
                </SettingRow>
              )}
              {forcesExa && (
                <p className="mt-2 text-xs text-amber-600 dark:text-amber-500">
                  {t("settings.ai.webSearch.unverifiedNote")}
                </p>
              )}
            </SettingSection>
          );
        })()}

      <SettingScopeHeader title={t("settings.scopeProject")} />
      {/* Context budget */}
      <SettingSection title={t("settings.ai.contextBudget")}>
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
            {budgetError
              ? t("settings.ai.budgetOverflow", { total: budgetTotal })
              : t("settings.ai.budgetTotal", { total: budgetTotal })}
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
            {t("settings.ai.resetBudget")}
          </button>
        </div>
      </SettingSection>

      {/* Beat AI integration (Phase C) */}
      <SettingSection title={t("settings.ai.beat.title")}>
        <div className="space-y-3">
          <SettingRow
            label={t("settings.ai.beat.injectIntoContext.label")}
            description={t("settings.ai.beat.injectIntoContext.description")}
          >
            <SettingToggle
              settingKey="beat.injectIntoContext"
              defaultValue={true}
            />
          </SettingRow>
          <SettingRow
            label={t("settings.ai.beat.inferRoles.label")}
            description={t("settings.ai.beat.inferRoles.description")}
          >
            <SettingToggle settingKey="beat.inferRoles" defaultValue={true} />
          </SettingRow>
          <SettingRow
            label={t("settings.ai.beat.confidenceThreshold.label")}
            description={t("settings.ai.beat.confidenceThreshold.description")}
          >
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={50}
                max={95}
                step={5}
                value={Math.round(
                  settingsStore.getNumber(
                    "beat.roleInferenceConfidenceThreshold",
                    0.7,
                  ) * 100,
                )}
                onChange={(e) =>
                  settingsStore.set(
                    "beat.roleInferenceConfidenceThreshold",
                    String(parseInt(e.target.value) / 100),
                  )
                }
                className="h-1.5 w-24 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
              />
              <span className="w-10 text-right text-xs tabular-nums">
                {Math.round(
                  settingsStore.getNumber(
                    "beat.roleInferenceConfidenceThreshold",
                    0.7,
                  ) * 100,
                )}
                %
              </span>
            </div>
          </SettingRow>
        </div>
      </SettingSection>

      {/* AI プロンプト追記カスタマイズ (Phase 0) — 各機能の組み込みプロンプトに追記 */}
      <SettingSection title={t("settings.ai.promptCustom.title")}>
        <p className="mb-3 text-xs text-muted-foreground">
          {t("settings.ai.promptCustom.intro")}
        </p>
        <div className="space-y-4">
          {PROMPT_CUSTOM_SLOTS.map((slot) => {
            const key = `aiPrompt.custom.${slot}`;
            return (
              <div key={slot}>
                <div className="mb-1 text-sm">
                  {t(`settings.ai.promptCustom.${slot}.label`)}
                </div>
                <div className="mb-1 text-xs text-muted-foreground">
                  {t(`settings.ai.promptCustom.${slot}.description`)}
                </div>
                <SettingTextarea
                  value={settingsStore.get(key, "")}
                  onChange={(v) => settingsStore.set(key, v)}
                  placeholder={t(
                    `settings.ai.promptCustom.${slot}.placeholder`,
                  )}
                  rows={4}
                  maxLength={2000}
                />
              </div>
            );
          })}
        </div>
      </SettingSection>
    </div>
  );
}
