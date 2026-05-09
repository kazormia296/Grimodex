import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useAiSettingsStore } from "@/features/chat/store";
import {
  AI_PROVIDERS,
  DEFAULT_OPENAI_COMPATIBLE_SETTINGS,
  groupModelsByDeveloper,
} from "@/features/chat/types";
import type {
  AiProvider,
  CliKind,
  OpenaiCompatPresetId,
} from "@/features/chat/types";
import { detectCliBinary, testCliConnection } from "@/features/chat/cliApi";
import { resolveModelCapabilities } from "@/features/chat/agent/modelLimits";
import {
  getOpenaiCompatPreset,
  listOpenaiCompatPresets,
} from "@/features/chat/openaiCompatPresets";
import { SettingSection } from "../components/SettingSection";
import { SettingRow } from "../components/SettingRow";
import { SettingToggle } from "../components/SettingToggle";
import { useSettingsStore } from "../settingsStore";

const PROVIDER_LABELS: Record<AiProvider, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
  ollama: "ollama-local",
  "openai-compatible": "OpenAI 互換",
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
    // OpenAI 互換でハードコードプリセットを使う場合は API を叩かないので
    // hasApiKey の有無にかかわらずロード可能。CLI プロバイダはモデル一覧を持たない。
    const presetId = settings.openaiCompatible?.preset;
    const usePresetModels =
      settings.provider === "openai-compatible" &&
      presetId !== undefined &&
      presetId !== "custom";
    if (hasApiKey || usePresetModels || settings.provider === "ollama") {
      handleLoadModels();
    }
    // settings は truthy ガード用途。再実行のトリガは provider / preset 変更。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    hasApiKey,
    settings?.provider,
    settings?.openaiCompatible?.preset,
    handleLoadModels,
  ]);

  async function handleProviderChange(provider: AiProvider) {
    const updated = {
      ...localSettings!,
      provider,
      model: "",
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
    const updated = { ...localSettings!, model };
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

        {/* OpenAI 互換: プリセット選択 + 設定 */}
        {localSettings.provider === "openai-compatible" &&
          (() => {
            const presets = listOpenaiCompatPresets();
            const currentPresetId =
              localSettings.openaiCompatible?.preset ?? "custom";
            const preset = getOpenaiCompatPreset(currentPresetId);
            const isCustom = preset.id === "custom";
            return (
              <>
                <SettingRow label="プリセット">
                  <select
                    value={currentPresetId}
                    onChange={async (e) => {
                      const presetId = e.target.value as OpenaiCompatPresetId;
                      const updated = {
                        ...localSettings,
                        openaiCompatible: {
                          ...localSettings.openaiCompatible,
                          preset: presetId,
                        },
                      };
                      setLocalSettings(updated);
                      await saveSettings(updated);
                    }}
                    className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
                  >
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.displayName}
                      </option>
                    ))}
                  </select>
                </SettingRow>
                {preset.helperText && (
                  <p className="mb-2 text-xs text-muted-foreground">
                    {preset.helperText}
                  </p>
                )}
                {isCustom ? (
                  <>
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
                        value={
                          localSettings.openaiCompatible?.customMaxContext ?? ""
                        }
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
                        value={
                          localSettings.openaiCompatible?.customMaxOutput ?? ""
                        }
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
                  </>
                ) : (
                  <>
                    {preset.baseUrl && (
                      <SettingRow label="Base URL">
                        <span className="text-sm text-muted-foreground font-mono">
                          {preset.baseUrl}
                        </span>
                      </SettingRow>
                    )}
                    {preset.extraSamplingKeys.length > 0 && (
                      <div className="mt-3 mb-2">
                        <p className="mb-1 text-sm font-medium text-foreground">
                          サンプリングパラメータ
                        </p>
                        <p className="mb-2 text-xs text-muted-foreground">
                          このプリセット固有のサンプリングパラメータ。空欄でリクエストから省略されます。配列やオブジェクトは
                          JSON 文字列で入力してください（例:{" "}
                          <code className="font-mono">["foo","bar"]</code>）。
                        </p>
                        <div className="space-y-1.5">
                          {preset.extraSamplingKeys.map((key) =>
                            renderSamplingInput(
                              key,
                              localSettings.openaiCompatible?.sampling?.[key],
                              (next) => {
                                // setLocalSettings の queue 経由ではなく onChange の
                                // クロージャで閉じた最新 localSettings から updated を
                                // 同期構築し、そのまま saveSettings に渡す（複数 key
                                // 編集時に間の値が失われないように）
                                const current =
                                  localSettings.openaiCompatible?.sampling ??
                                  {};
                                const merged = { ...current };
                                if (next === undefined) {
                                  delete merged[key];
                                } else {
                                  merged[key] = next;
                                }
                                const updated = {
                                  ...localSettings,
                                  openaiCompatible: {
                                    ...localSettings.openaiCompatible,
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
                    {preset.defaultDisableStructuredTasks && (
                      <SettingRow
                        label="Codex 自動抽出 / Synopsis 自動生成を許可"
                        description="このプロバイダは構造化出力 (JSON) の精度が低いため、デフォルトで無効化されています。明示的にオプトインする場合のみ有効化してください"
                      >
                        <input
                          type="checkbox"
                          checked={
                            localSettings.openaiCompatible
                              ?.enableStructuredTasks ?? false
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
                    )}
                  </>
                )}
              </>
            );
          })()}

        {/* CLI プロバイダ: 種別選択 + バイナリ検出 + 接続テスト */}
        {localSettings.provider === "cli" &&
          (() => {
            const cli = localSettings.cli ?? {
              kind: "claude" as CliKind,
              binaryPath: "",
              model: "",
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
            const isWindowsNative =
              typeof navigator !== "undefined" &&
              /Win/.test(navigator.platform) &&
              !/WSL/i.test(navigator.userAgent);
            return (
              <>
                {isWindowsNative && (
                  <p className="mb-2 rounded-md border border-yellow-500/50 bg-yellow-500/10 p-2 text-xs text-yellow-700 dark:text-yellow-400">
                    Windows ネイティブはまだ対応していません。WSL
                    経由でアプリを起動してください。
                  </p>
                )}
                <SettingRow label="CLI 種別">
                  <select
                    value={cli.kind}
                    onChange={(e) => {
                      void updateCli({
                        kind: e.target.value as CliKind,
                        // バイナリパスは CLI 種別に紐づくのでクリア
                        binaryPath: "",
                      });
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
                  <code className="font-mono">{cli.kind} login</code>{" "}
                  等で認証を済ませてください。本パネルからはツール (ファイル R/W
                  / shell) は全て無効化された状態で起動します。
                </p>
                {cli.kind !== "claude" && (
                  <p className="mb-2 rounded-md border border-yellow-500/50 bg-yellow-500/10 p-2 text-xs text-yellow-700 dark:text-yellow-400">
                    {cli.kind === "codex" ? "Codex CLI" : "OpenCode"}{" "}
                    用の出力パーサは未実装です
                    (将来対応予定)。現状は応答が空のまま終了します。
                  </p>
                )}
                <SettingRow
                  label="バイナリパス"
                  description="空欄なら CLI 名で PATH 解決。「自動検出」で bash -lc 経由で which を試行します"
                >
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={cli.binaryPath ?? ""}
                      onChange={(e) =>
                        updateCli({ binaryPath: e.target.value })
                      }
                      className="w-72 rounded-md border border-input bg-background px-2 py-1 text-sm font-mono focus:outline-none"
                      placeholder={`/usr/local/bin/${cli.kind}`}
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        const path = await detectCliBinary(cli.kind);
                        if (path) {
                          await updateCli({ binaryPath: path });
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
                  description="CLI に --model で渡される。空欄なら CLI のデフォルト"
                >
                  <input
                    type="text"
                    value={cli.model ?? ""}
                    onChange={(e) => updateCli({ model: e.target.value })}
                    className="w-48 rounded-md border border-input bg-background px-2 py-1 text-sm font-mono focus:outline-none"
                    placeholder="(任意)"
                  />
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
          const modelOptgroups = (extraOption?: React.ReactNode) => (
            <>
              {extraOption}
              {grouped.map(([dev, devModels]) => (
                <optgroup key={dev || "__other"} label={devLabel(dev)}>
                  {devModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </>
          );

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
              <SettingRow label={t("settings.ai.defaultChatModel")}>
                <div className="flex gap-2">
                  <select
                    value={localSettings.model}
                    onChange={(e) => handleModelChange(e.target.value)}
                    className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
                    disabled={isLoadingModels}
                  >
                    {modelOptgroups(
                      <option value="">
                        {isLoadingModels
                          ? t("settings.ai.loadingModels")
                          : t("settings.ai.selectModel")}
                      </option>,
                    )}
                  </select>
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

              <SettingRow
                label={t("settings.ai.inlineModel")}
                description={t("settings.ai.inlineModelDesc")}
              >
                <select
                  value={settingsStore.get("ai.inlineModel")}
                  onChange={(e) =>
                    settingsStore.set("ai.inlineModel", e.target.value)
                  }
                  className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
                  disabled={isLoadingModels}
                >
                  {modelOptgroups(
                    <option value="">{t("settings.ai.sameChatModel")}</option>,
                  )}
                </select>
              </SettingRow>

              <SettingRow
                label={t("settings.ai.titleModel")}
                description={t("settings.ai.titleModelDesc")}
              >
                <select
                  value={settingsStore.get("ai.sessionTitleModel")}
                  onChange={(e) =>
                    settingsStore.set("ai.sessionTitleModel", e.target.value)
                  }
                  className="rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
                  disabled={isLoadingModels}
                >
                  {modelOptgroups(
                    <option value="">{t("settings.ai.sameChatModel")}</option>,
                  )}
                </select>
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
            // openai-compatible 等のプリセット capabilitiesOverride を反映するため
            // resolveModelCapabilities を使う
            const caps = resolveModelCapabilities(
              localSettings.model,
              localSettings,
            );
            return caps.supportsAdaptiveThinking || caps.supportsThinking;
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
    </div>
  );
}
