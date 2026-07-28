import i18next from "@/lib/i18n";

export const AI_PROVIDERS = [
  "openrouter",
  "openai",
  "anthropic",
  "ollama",
  "openai-compatible",
  "sakana",
  "ai-novelist",
  "cli",
] as const;

export type AiProvider = (typeof AI_PROVIDERS)[number];

/**
 * Ollama treats an omitted tag as `:latest`. Keep the persisted manual-context
 * namespace aligned with the capability registry so selecting `gemma4` and
 * receiving `gemma4:latest` from `/api/tags` addresses the same model.
 */
export function normalizeOllamaModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/:latest$/u, "");
}

function serializeOllamaContextLengthSettingKey(
  endpoint: string,
  model: string,
): string {
  const normalizedEndpoint = endpoint.trim().replace(/\/+$/u, "");
  return JSON.stringify([normalizedEndpoint, model]);
}

/** Scope a manual Ollama allocation by endpoint and canonical model identity. */
export function ollamaContextLengthSettingKey(
  endpoint: string,
  model: string,
): string {
  return serializeOllamaContextLengthSettingKey(
    endpoint,
    normalizeOllamaModelId(model),
  );
}

/**
 * Read candidates for settings written before model-id normalization.
 *
 * The canonical key comes first. Exact legacy spellings and both sides of the
 * implicit `:latest` alias remain readable so existing settings migrate only
 * when the user next edits them.
 */
export function ollamaContextLengthSettingKeys(
  endpoint: string,
  model: string,
): string[] {
  const trimmed = model.trim();
  const normalized = normalizeOllamaModelId(trimmed);
  const lastSegment = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  const isLatestAlias =
    /:latest$/iu.test(trimmed) || !lastSegment.includes(":");
  const modelCandidates = [normalized, trimmed];

  if (isLatestAlias) {
    modelCandidates.push(`${normalized}:latest`);
    modelCandidates.push(
      /:latest$/iu.test(trimmed)
        ? trimmed.replace(/:latest$/iu, "")
        : `${trimmed}:latest`,
    );
  }

  return [...new Set(modelCandidates)]
    .filter(Boolean)
    .map((candidate) =>
      serializeOllamaContextLengthSettingKey(endpoint, candidate),
    );
}

/**
 * Agent ループでツール呼び出しをどのプロトコルで授受するか。
 * - `auto`: HTTP OpenAI 互換プロバイダで、model 名に `hermes` を含む場合のみ Hermes 扱い。
 *   それ以外は native（OpenAI structured `tool_calls`）。
 * - `native`: 常に OpenAI structured `tool_calls`。
 * - `hermes`: 本文 `<tool_call>`/`<tool_response>` テキストプロトコル（Hermes/ChatML 系）。
 * Anthropic / CLI など非 OpenAI 互換プロバイダでは常に native（resolve 側で無効化）。
 */
export type ToolProtocolMode = "auto" | "native" | "hermes";

/** CLI エージェント種別 (Claude Code / Codex CLI / OpenCode) */
export type CliKind = "claude" | "codex" | "opencode";

/** Codex CLI を単発実行するか、常駐 App Server に接続するか。 */
export type CliTransport = "exec" | "app-server" | "auto";

/** CLI プロバイダ用設定 */
export interface CliSettings {
  /** 使用する CLI 種別 */
  kind: CliKind;
  /**
   * 実行可能ファイルのパス。空なら CLI 名を PATH 解決する。
   * 通常は detect_cli_binary で取得した絶対パスを保存する。
   */
  binaryPath?: string;
  /** CLI に渡すモデル名。空なら CLI のデフォルトモデル */
  model?: string;
  /** kind === "codex" のときだけ有効。未設定は既存互換の exec。 */
  codexTransport?: CliTransport;
  /** Codex App Serverの承認付きworkspace writeを明示的に許可する。 */
  codexAllowApprovals?: boolean;
}

/** カスタム OpenAI 互換プロバイダの設定。 */
export interface OpenaiCompatibleSettings {
  /** ユーザーが入力する OpenAI 互換エンドポイント */
  baseUrl: string;
  /** 手動指定するモデルのコンテキスト窓 (tokens) */
  customMaxContext?: number;
  /** 手動指定するモデルの最大出力 (tokens) */
  customMaxOutput?: number;
  /** AI Codex 自動抽出 / Synopsis / セッションタイトル自動生成を許可するか */
  enableStructuredTasks?: boolean;
}

export const DEFAULT_OPENAI_COMPATIBLE_SETTINGS: OpenaiCompatibleSettings = {
  baseUrl: "",
};

/** legacy 単一設定の移行で合成する既定エンドポイントの固定 ID（Rust と共有）。 */
export const LEGACY_OPENAI_COMPAT_ENDPOINT_ID = "default";

/**
 * 1 つの OpenAI 互換エンドポイント設定（複数登録対応版）。
 * `id` は keyring user / override 参照キー。複数のローカル / クラウド互換サーバを
 * 同時に登録し、チャットピッカー / A-B 枠 / ロール別ルーティングで横断利用する。
 */
export interface OpenaiCompatibleEndpoint {
  /** 安定 ID（移行既定は "default"、新規は crypto.randomUUID()）。 */
  id: string;
  /** 表示用ラベル。空なら UI で baseUrl を代用。 */
  label: string;
  baseUrl: string;
  customMaxContext?: number;
  customMaxOutput?: number;
  enableStructuredTasks?: boolean;
  /**
   * このエンドポイント既定の API 経路（未指定ならグローバル / モデル名推論）。
   * "legacy" は AI のべりすと専用のため OpenAI 互換エンドポイントでは選べない。
   */
  apiVariant?: "v1" | "responses" | null;
}

/** AI のべりすと専用の設定。 */
export interface AiNovelistSettings {
  /** KoboldAI 系独自サンプリングパラメータ (top_a / tailfree 等) */
  sampling?: Record<string, unknown>;
  /** AI Codex 自動抽出 / Synopsis / セッションタイトル自動生成を許可するか */
  enableStructuredTasks?: boolean;
  /** 日本語以外で生成する場合に true */
  multilingualMode?: boolean;
}

export const DEFAULT_AI_NOVELIST_SETTINGS: AiNovelistSettings = {};

export interface AiSettings {
  provider: AiProvider;
  model: string;
  ollamaEndpoint: string;
  /**
   * Ollama 側でendpoint+modelごとに割り当てた実効 context size の申告値。
   *
   * Grimodex の OpenAI 互換経路は runner の context size を変更できないため、
   * `/api/ps` で実行中の値を取得できない場合にだけローカル事前判定へ使う。
   * モデル自体の最大 context length (`AiModel.contextLength`) とは別物。
   */
  ollamaContextLengths?: Record<string, number>;
  thinkingEnabled: boolean;
  /** legacy 単一 OpenAI 互換設定。複数版へ移行後も round-trip / downgrade 用に保持。 */
  openaiCompatible: OpenaiCompatibleSettings;
  /** 複数 OpenAI 互換エンドポイント。空なら openaiCompatible から移行（getOpenaiCompatibleEndpoints）。 */
  openaiCompatibleEndpoints?: OpenaiCompatibleEndpoint[];
  /** 既定（override 無し時）の OpenAI 互換エンドポイント ID。 */
  activeOpenaiCompatibleEndpointId?: string | null;
  aiNovelist?: AiNovelistSettings;
  /** CLI プロバイダ選択時のみ意味を持つ */
  cli?: CliSettings;
  /**
   * OpenRouter で同一 provider に routing を固定する slug。
   * 例: "anthropic" / "amazon-bedrock" / "google-vertex"。
   * 未設定 (undefined / null / 空文字) なら OpenRouter のデフォルト routing。
   * 設定すると Anthropic prompt cache が安定して効くようになる。
   */
  openrouterProviderPin?: string | null;
  /**
   * 選択中モデルの API 経路。バックエンド fallback 用 (Rust `resolve_api_variant`)。
   * - "legacy" | "v1": AI のべりすとのレガシー / OpenAI 互換 API 切替。
   * - "responses": OpenAI 直 / OpenAI 互換 gateway で `/v1/responses`
   *   (Responses API) を使う。未設定なら `/chat/completions`。
   */
  modelApiVariant?: "legacy" | "v1" | "responses" | null;
  /**
   * reasoning モデルの effort 上書き（low/medium/high）。
   * undefined / null ⇒ タスク既定（getEffortForTask）に従う。chat/agent でのみ適用。
   */
  reasoningEffortOverride?: "low" | "medium" | "high" | null;
  /**
   * Agent ツール呼び出しプロトコル。未設定 ⇒ "auto"。
   * Hermes/ChatML 系モデルが本文に出す `<tool_call>` を実ツール呼び出しとして扱うため。
   */
  toolProtocolMode?: ToolProtocolMode;
  /**
   * OpenRouter Fusion (マルチモデル合議) のカスタム構成。
   * model が `"openrouter/fusion"` のときだけ `plugins:[{id:"fusion",...}]` として注入。
   * undefined / enabled=false なら OpenRouter 既定パネル (= 素の openrouter/fusion)。
   */
  fusion?: FusionSettings;
}

/** OpenRouter Fusion のカスタム構成 (パネル + judge)。 */
export interface FusionSettings {
  /** カスタム構成を適用するか。false なら OpenRouter 既定パネルに委ねる。 */
  enabled: boolean;
  /** パネル (analysis_models)。1〜8 件。空なら既定 (Quality preset)。 */
  analysisModels: string[];
  /** judge (集約) モデル。空 / null なら既定 (outer)。 */
  judgeModel?: string | null;
}

/**
 * OpenRouter provider pin の候補一覧（UI 用）。
 * 言語切り替えに追従させるため関数化（import 時固定の const は避ける）。
 */
export function getOpenrouterProviderPins(): Array<{
  slug: string;
  label: string;
}> {
  return [
    {
      slug: "anthropic",
      label: `Anthropic (${i18next.t("settings.ai.providerPinDirect")})`,
    },
    { slug: "amazon-bedrock", label: "Amazon Bedrock" },
    { slug: "google-vertex", label: "Google Vertex" },
  ];
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  provider: "openrouter",
  model: "",
  ollamaEndpoint: "http://localhost:11434",
  ollamaContextLengths: {},
  thinkingEnabled: true,
  openaiCompatible: DEFAULT_OPENAI_COMPATIBLE_SETTINGS,
  openaiCompatibleEndpoints: [],
  activeOpenaiCompatibleEndpointId: null,
  toolProtocolMode: "auto",
};

/**
 * 有効な OpenAI 互換エンドポイント一覧を返す（Rust `normalize_openai_compatible` と同論理）。
 * 配列が空かつ legacy `openaiCompatible.baseUrl` が非空なら `"default"` を 1 件合成する。
 * Rust は read 時に normalize 済みだが、FE 単体（永続化前の draft 等）でも一貫させる。
 */
export function getOpenaiCompatibleEndpoints(
  settings: Pick<AiSettings, "openaiCompatibleEndpoints" | "openaiCompatible">,
): OpenaiCompatibleEndpoint[] {
  const list = settings.openaiCompatibleEndpoints ?? [];
  if (list.length > 0) return list;
  const legacy = settings.openaiCompatible?.baseUrl?.trim();
  if (legacy) {
    return [
      {
        id: LEGACY_OPENAI_COMPAT_ENDPOINT_ID,
        label: "",
        baseUrl: settings.openaiCompatible.baseUrl,
        customMaxContext: settings.openaiCompatible.customMaxContext,
        customMaxOutput: settings.openaiCompatible.customMaxOutput,
        enableStructuredTasks: settings.openaiCompatible.enableStructuredTasks,
      },
    ];
  }
  return [];
}

/**
 * `requestedId`（override）→ active id → 先頭、の順で解決した OpenAI 互換エンドポイント。
 * Rust `active_openai_compatible_endpoint` と同論理。配列が空なら undefined。
 */
export function resolveActiveOpenaiCompatibleEndpoint(
  settings: Pick<
    AiSettings,
    | "openaiCompatibleEndpoints"
    | "openaiCompatible"
    | "activeOpenaiCompatibleEndpointId"
  >,
  requestedId?: string | null,
): OpenaiCompatibleEndpoint | undefined {
  const list = getOpenaiCompatibleEndpoints(settings);
  if (list.length === 0) return undefined;
  const want =
    requestedId && requestedId.length > 0
      ? requestedId
      : (settings.activeOpenaiCompatibleEndpointId ?? undefined);
  if (want) {
    const found = list.find((e) => e.id === want);
    if (found) return found;
  }
  return list[0];
}

export interface AiModel {
  id: string;
  name: string;
  /** AI のべりすと: "legacy" | "v1" */
  apiVariant?: "legacy" | "v1";
  /** プロバイダから取得したモデル自体の最大 context length。 */
  contextLength?: number;
  /**
   * 現在の経路で実際に利用できる context length。
   * Ollama では `/api/ps` の runner 割り当て、または Modelfile の `num_ctx`。
   */
  effectiveContextLength?: number;
  /** `effectiveContextLength` を得た経路。 */
  effectiveContextSource?: "runner" | "model-parameter";
  maxCompletionTokens?: number;
  supportedParameters?: string[];
  pricingPrompt?: string;
  pricingCompletion?: string;
}

/**
 * モデルIDからデベロッパー名を抽出する。
 * OpenRouter の "anthropic/claude-..." → "anthropic"
 * スラッシュがない場合は空文字 (単一プロバイダー扱い)
 */
export function modelDeveloper(modelId: string): string {
  const slash = modelId.indexOf("/");
  return slash >= 0 ? modelId.slice(0, slash) : "";
}

/**
 * モデル一覧をデベロッパーでグループ化し、
 * デベロッパー名昇順・モデル名昇順でソートして返す。
 * 戻り値: [developerLabel, models[]] のタプル配列
 */
export function groupModelsByDeveloper(
  models: AiModel[],
): [string, AiModel[]][] {
  const map = new Map<string, AiModel[]>();
  for (const m of models) {
    const dev = modelDeveloper(m.id);
    if (!map.has(dev)) map.set(dev, []);
    map.get(dev)!.push(m);
  }
  // 各グループ内をモデル名でソート
  for (const arr of map.values()) {
    arr.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  }
  // デベロッパー名でソート（空文字は末尾）
  return [...map.entries()].sort(([a], [b]) => {
    if (a === "") return 1;
    if (b === "") return -1;
    return a.localeCompare(b);
  });
}

export interface ConnectionTestResult {
  success: boolean;
  message: string;
}
