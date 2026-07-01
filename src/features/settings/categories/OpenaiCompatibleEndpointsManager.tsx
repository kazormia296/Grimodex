import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Check, Plus, Trash2, X } from "lucide-react";
import {
  hasApiKey,
  saveApiKey,
  deleteApiKey,
  testAiConnection,
  listAiModels,
} from "@/features/chat/api";
import type { OpenaiCompatibleEndpoint } from "@/features/chat/types";
import {
  makeNewEndpoint,
  addEndpoint,
  updateEndpoint,
  removeEndpoint,
} from "./openaiCompatibleEndpointsHelpers";

const PROVIDER = "openai-compatible" as const;

interface ManagerProps {
  endpoints: OpenaiCompatibleEndpoint[];
  activeId: string | null;
  /** list / activeId が変わったら呼ぶ（呼び出し側が persist する）。 */
  onChange: (list: OpenaiCompatibleEndpoint[], activeId: string | null) => void;
}

interface EndpointTestState {
  testing: boolean;
  result: { success: boolean; message: string } | null;
}

/**
 * 複数 OpenAI 互換エンドポイントの管理 UI。SettingRow の値列ではなく、全幅の
 * ブロックセクションとして描画する（値列に full-width block を入れると説明列が
 * 0 幅まで潰れて縦書き化するため）。各エンドポイントはカード 1 枚で、ラベル /
 * baseUrl / コンテキスト窓 / 最大出力 / 構造化タスク許可 / API 経路 / 既定化 /
 * 削除、そして per-endpoint の API キー保存・削除・接続テストを持つ。
 */
export function OpenaiCompatibleEndpointsManager({
  endpoints,
  activeId,
  onChange,
}: ManagerProps) {
  const { t } = useTranslation();
  // endpoint.id -> キー有無 / キー入力欄 / テスト状態（ローカル UI 状態）。
  const [keyPresent, setKeyPresent] = useState<Record<string, boolean>>({});
  const [keyInput, setKeyInput] = useState<Record<string, string>>({});
  const [testState, setTestState] = useState<Record<string, EndpointTestState>>(
    {},
  );
  // endpoint.id -> 直近のキー操作（保存/削除/エンドポイント削除）の失敗メッセージ。
  // 失敗を握りつぶすと「ボタンが無反応」に見えるため、ユーザーへ明示する。
  const [actionError, setActionError] = useState<Record<string, string>>({});

  const setError = (id: string, message: string | null): void => {
    setActionError((s) => {
      if (message === null) {
        if (!(id in s)) return s;
        const { [id]: _omit, ...rest } = s;
        return rest;
      }
      return { ...s, [id]: message };
    });
  };

  const errMessage = (e: unknown): string =>
    e instanceof Error ? e.message : String(e);

  // キー有無は未取得の id だけ IPC で問い合わせる。endpoints は label 入力などの
  // per-keystroke で参照が変わるため、id 集合を安定キー化して effect の再発火を
  // 抑える（同じ id 集合なら再取得しない）。保存/削除の成功時はローカルで直接
  // keyPresent を更新する。
  const fetchedIdsRef = useRef<Set<string>>(new Set());
  const idsKey = endpoints.map((e) => e.id).join("\n");

  useEffect(() => {
    const targets = (idsKey ? idsKey.split("\n") : []).filter(
      (id) => !fetchedIdsRef.current.has(id),
    );
    if (targets.length === 0) return;
    for (const id of targets) fetchedIdsRef.current.add(id);
    void (async () => {
      const entries = await Promise.all(
        targets.map(async (id) => [id, await hasApiKey(PROVIDER, id)] as const),
      );
      setKeyPresent((s) => ({ ...s, ...Object.fromEntries(entries) }));
    })();
  }, [idsKey]);

  const patch = (id: string, p: Partial<OpenaiCompatibleEndpoint>): void => {
    onChange(updateEndpoint(endpoints, id, p), activeId);
  };

  const handleAdd = (): void => {
    const created = makeNewEndpoint();
    const next = addEndpoint(endpoints, created);
    // 最初の 1 件は自動で既定にする。
    onChange(next, activeId ?? created.id);
  };

  const handleDelete = async (id: string): Promise<void> => {
    setError(id, null);
    try {
      await deleteApiKey(PROVIDER, id);
      const { list, activeId: nextActive } = removeEndpoint(
        endpoints,
        activeId,
        id,
      );
      onChange(list, nextActive);
      // 消えた endpoint のローカル状態を掃除（次に同 id が来ることはないが、
      // keyPresent を現存 endpoint のみに保つ）。
      fetchedIdsRef.current.delete(id);
      setKeyPresent((s) => {
        if (!(id in s)) return s;
        const { [id]: _omit, ...rest } = s;
        return rest;
      });
    } catch (e) {
      // 失敗時はエンドポイントを残したままエラーを表示（onChange を呼ばないので
      // 一覧は不変＝楽観的に消えてしまう不整合を避ける）。
      setError(id, errMessage(e));
    }
  };

  const handleSaveKey = async (id: string): Promise<void> => {
    const key = (keyInput[id] ?? "").trim();
    if (!key) return;
    setError(id, null);
    try {
      await saveApiKey(PROVIDER, key, id);
      setKeyInput((s) => ({ ...s, [id]: "" }));
      // 保存成功＝キー有りが確定しているので、全件 hasApiKey を撃ち直さない。
      setKeyPresent((s) => ({ ...s, [id]: true }));
    } catch (e) {
      // 入力値は消さずに残し（再試行可能）、失敗理由を明示する。
      setError(id, errMessage(e));
    }
  };

  const handleDeleteKey = async (id: string): Promise<void> => {
    setError(id, null);
    try {
      await deleteApiKey(PROVIDER, id);
      setKeyPresent((s) => ({ ...s, [id]: false }));
    } catch (e) {
      setError(id, errMessage(e));
    }
  };

  const handleTest = async (
    endpoint: OpenaiCompatibleEndpoint,
  ): Promise<void> => {
    setTestState((s) => ({
      ...s,
      [endpoint.id]: { testing: true, result: null },
    }));
    try {
      // 単一エンドポイント版と同様、まずモデル一覧を取得して 1 件目を試す。
      // 取れなければエンドポイント既定 / 空モデルで疎通だけ確認する。
      let model = "";
      try {
        const models = await listAiModels(PROVIDER, endpoint.id);
        model = models[0]?.id ?? "";
      } catch {
        /* モデル一覧が無くても接続テストは試みる */
      }
      const message = await testAiConnection(
        PROVIDER,
        model,
        endpoint.apiVariant ?? null,
        endpoint.id,
      );
      setTestState((s) => ({
        ...s,
        [endpoint.id]: { testing: false, result: { success: true, message } },
      }));
    } catch (e) {
      setTestState((s) => ({
        ...s,
        [endpoint.id]: {
          testing: false,
          result: {
            success: false,
            message: e instanceof Error ? e.message : String(e),
          },
        },
      }));
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {t("settings.ai.openaiCompatDesc")}
      </p>

      {endpoints.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {t("settings.ai.endpoints.empty")}
        </p>
      ) : (
        endpoints.map((endpoint) => {
          const isActive = (activeId ?? endpoints[0]?.id) === endpoint.id;
          const present = keyPresent[endpoint.id] ?? false;
          const test = testState[endpoint.id];
          return (
            <div
              key={endpoint.id}
              className={`rounded-lg border bg-muted/20 p-3 ${
                isActive ? "border-primary" : "border-border"
              }`}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="radio"
                    name="openai-compat-default"
                    checked={isActive}
                    onChange={() => onChange(endpoints, endpoint.id)}
                    className="h-3.5 w-3.5"
                  />
                  <span
                    className={
                      isActive
                        ? "font-medium text-foreground"
                        : "text-muted-foreground"
                    }
                  >
                    {isActive
                      ? t("settings.ai.endpoints.default")
                      : t("settings.ai.endpoints.setDefault")}
                  </span>
                </label>
                <button
                  type="button"
                  onClick={() => void handleDelete(endpoint.id)}
                  aria-label={t("settings.ai.endpoints.delete")}
                  className="inline-flex items-center gap-1 rounded-md border border-destructive px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  {t("settings.ai.endpoints.delete")}
                </button>
              </div>

              <div className="space-y-2">
                <div>
                  <div className="mb-0.5 text-xs text-muted-foreground">
                    {t("settings.ai.endpoints.label")}
                  </div>
                  <input
                    type="text"
                    value={endpoint.label}
                    onChange={(e) =>
                      patch(endpoint.id, { label: e.target.value })
                    }
                    className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
                    placeholder={t("settings.ai.endpoints.labelPlaceholder")}
                  />
                </div>

                <div>
                  <div className="mb-0.5 text-xs text-muted-foreground">
                    Base URL
                  </div>
                  <input
                    type="text"
                    value={endpoint.baseUrl}
                    onChange={(e) =>
                      patch(endpoint.id, { baseUrl: e.target.value })
                    }
                    className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm font-mono focus:outline-none"
                    placeholder="http://localhost:1234/v1"
                  />
                </div>

                <div className="flex flex-wrap gap-3">
                  <div>
                    <div className="mb-0.5 text-xs text-muted-foreground">
                      {t("settings.ai.contextWindowLabel")}
                    </div>
                    <input
                      type="number"
                      min={1}
                      value={endpoint.customMaxContext ?? ""}
                      onChange={(e) =>
                        patch(endpoint.id, {
                          customMaxContext: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                      className="w-32 rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
                      placeholder="8000"
                    />
                  </div>
                  <div>
                    <div className="mb-0.5 text-xs text-muted-foreground">
                      {t("settings.ai.maxOutputLabel")}
                    </div>
                    <input
                      type="number"
                      min={1}
                      value={endpoint.customMaxOutput ?? ""}
                      onChange={(e) =>
                        patch(endpoint.id, {
                          customMaxOutput: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                      className="w-32 rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
                      placeholder={t("settings.ai.optionalPlaceholder")}
                    />
                  </div>
                  <div>
                    <div className="mb-0.5 text-xs text-muted-foreground">
                      {t("settings.ai.endpoints.apiVariant")}
                    </div>
                    <select
                      value={endpoint.apiVariant ?? ""}
                      onChange={(e) =>
                        patch(endpoint.id, {
                          apiVariant:
                            e.target.value === ""
                              ? null
                              : (e.target.value as "v1" | "responses"),
                        })
                      }
                      className="rounded-md border border-input bg-background px-2 py-1 text-sm"
                    >
                      <option value="">
                        {t("settings.ai.endpoints.apiVariantAuto")}
                      </option>
                      <option value="v1">v1</option>
                      <option value="responses">responses</option>
                    </select>
                  </div>
                </div>

                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={endpoint.enableStructuredTasks ?? false}
                    onChange={(e) =>
                      patch(endpoint.id, {
                        enableStructuredTasks: e.target.checked,
                      })
                    }
                    className="h-4 w-4"
                  />
                  <span>{t("settings.ai.allowStructuredTasks")}</span>
                </label>

                {/* per-endpoint API キー（ローカル LLM などキー不要なら空のままで可）。 */}
                <div>
                  <div className="mb-0.5 text-xs text-muted-foreground">
                    {t("settings.ai.apiKey")}
                  </div>
                  {present ? (
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                        {t("settings.ai.keySet")}
                        <Check
                          className="h-3.5 w-3.5 shrink-0"
                          strokeWidth={3}
                          aria-hidden
                        />
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleDeleteKey(endpoint.id)}
                        className="rounded-md border border-destructive px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                      >
                        {t("settings.ai.deleteKey")}
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={keyInput[endpoint.id] ?? ""}
                        onChange={(e) =>
                          setKeyInput((s) => ({
                            ...s,
                            [endpoint.id]: e.target.value,
                          }))
                        }
                        onKeyDown={(e) =>
                          e.key === "Enter" && void handleSaveKey(endpoint.id)
                        }
                        className="w-40 rounded-md border border-input bg-background px-2 py-1 text-sm focus:outline-none"
                        placeholder="sk-..."
                      />
                      <button
                        type="button"
                        onClick={() => void handleSaveKey(endpoint.id)}
                        className="rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground hover:bg-primary/90"
                      >
                        {t("settings.ai.saveKey")}
                      </button>
                    </div>
                  )}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t("settings.ai.apiKeyDescOpenaiCompat")}
                  </p>
                  {actionError[endpoint.id] && (
                    <p
                      role="alert"
                      className="mt-1.5 flex items-center gap-1 text-sm text-destructive"
                    >
                      <X className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      <span>{actionError[endpoint.id]}</span>
                    </p>
                  )}
                </div>

                {/* per-endpoint 接続テスト */}
                <div>
                  <button
                    type="button"
                    onClick={() => void handleTest(endpoint)}
                    disabled={test?.testing || !endpoint.baseUrl.trim()}
                    className="rounded-md bg-secondary px-3 py-1.5 text-sm text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
                  >
                    {test?.testing
                      ? t("settings.ai.testing")
                      : t("settings.ai.testConnection")}
                  </button>
                  {test?.result && (
                    <p
                      className={`mt-1.5 flex items-center gap-1 text-sm ${
                        test.result.success
                          ? "text-green-600"
                          : "text-destructive"
                      }`}
                    >
                      {test.result.success ? (
                        <Check
                          className="h-3.5 w-3.5 shrink-0"
                          strokeWidth={3}
                          aria-hidden
                        />
                      ) : (
                        <X className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      )}
                      <span>{test.result.message}</span>
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })
      )}

      <button
        type="button"
        onClick={handleAdd}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
      >
        <Plus className="h-4 w-4" aria-hidden />
        {t("settings.ai.endpoints.add")}
      </button>
    </div>
  );
}
