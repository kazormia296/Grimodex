import {
  AI_DATA_DISCLOSURE_SCHEMA_VERSION,
  CLOUD_CONTENT_POLICY_ACK_HEADER,
  CLOUD_CONTENT_POLICY_VERSION,
  parseAiDataDisclosure,
  type AiDataDisclosureRoute,
  type AiDataDisclosureV1,
} from "@grimodex/scan-contract";
import type { ScanEnv } from "../env";
import { constantTimeEqual, sha256Hex } from "../security";

// Scan and Hosted Editor use one opaque consent identity for the complete
// pre-dispatch gate. A hosted-content policy revision must therefore renew the
// disclosed data-policy version as well as the rights confirmation UI.
export const AI_DATA_POLICY_VERSION = CLOUD_CONTENT_POLICY_VERSION;
export const WORKERS_AI_DATA_POLICY_URL =
  "https://developers.cloudflare.com/workers-ai/platform/data-usage/";
export const AI_GATEWAY_LOGGING_POLICY_URL =
  "https://developers.cloudflare.com/ai-gateway/observability/logging/";
export const OPENAI_API_DATA_POLICY_URL =
  "https://platform.openai.com/docs/models/default-usage-policies-by-endpoint";
export const OPENROUTER_DATA_POLICY_URL =
  "https://openrouter.ai/docs/guides/privacy/data-collection";
export const OPENROUTER_PROVIDER_POLICY_URL =
  "https://openrouter.ai/docs/guides/privacy/provider-logging/";
export const GRIMODEX_AI_DATA_POLICY_URL =
  "https://try.grimodex.app/PRIVACY_ja.md";
export const GRIMODEX_AI_DATA_POLICY_URL_EN =
  "https://try.grimodex.app/PRIVACY_en.md";

type ConfiguredProvider = "workers-ai" | "ai-gateway" | "openrouter";
export type AiDataDisclosureLocale = "ja" | "en";

interface ProviderDisclosure {
  id: string;
  processingDestinations: AiDataDisclosureV1["processingDestinations"];
  policyUrl: string;
  providerStorageSummary: string;
  providerRetentionSummary: string;
  trainingUse: AiDataDisclosureV1["trainingUse"];
}

interface DisclosureProfile {
  provider: string;
  processingDestinations: AiDataDisclosureV1["processingDestinations"];
  policyUrl: string;
  providerStorageSummary: string;
  providerRetentionSummary: string;
  trainingUse: AiDataDisclosureV1["trainingUse"];
}

export class AiDataDisclosureUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiDataDisclosureUnavailableError";
  }
}

export interface AiDataConsentIdentity {
  consentId: string;
  policyVersion: string;
  provider: string;
  route: AiDataDisclosureRoute;
}

export class AiDataConsentMismatchError extends Error {
  constructor() {
    super("AI data consent identity is missing or no longer current");
    this.name = "AiDataConsentMismatchError";
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function localized(
  locale: AiDataDisclosureLocale,
  english: string,
  japanese: string,
): string {
  return locale === "ja" ? japanese : english;
}

function grimodexPolicyUrl(locale: AiDataDisclosureLocale): string {
  return locale === "ja"
    ? GRIMODEX_AI_DATA_POLICY_URL
    : GRIMODEX_AI_DATA_POLICY_URL_EN;
}

function configuredProvider(env: ScanEnv): ConfiguredProvider {
  if (
    env.SCAN_AI_PROVIDER === "workers-ai" ||
    env.SCAN_AI_PROVIDER === "ai-gateway" ||
    env.SCAN_AI_PROVIDER === "openrouter"
  ) {
    return env.SCAN_AI_PROVIDER;
  }
  return env.AI ? "workers-ai" : "ai-gateway";
}

function configuredFrontierProvider(env: ScanEnv): ConfiguredProvider {
  if (
    env.SCAN_FRONTIER_PROVIDER === "workers-ai" ||
    env.SCAN_FRONTIER_PROVIDER === "ai-gateway" ||
    env.SCAN_FRONTIER_PROVIDER === "openrouter"
  ) {
    return env.SCAN_FRONTIER_PROVIDER;
  }
  return configuredProvider(env);
}

function workersAiDisclosure(
  route: AiDataDisclosureRoute,
  locale: AiDataDisclosureLocale,
): ProviderDisclosure {
  return {
    id: "workers-ai",
    processingDestinations: [
      {
        processor: "Cloudflare Workers AI",
        purpose:
          route === "scan"
            ? localized(
                locale,
                "Analyze the manuscript and produce the requested scan artifacts.",
                "原稿を解析し、要求されたScan成果物を生成します。",
              )
            : localized(
                locale,
                "Generate the requested hosted editor assistance.",
                "要求されたHosted Editor支援を生成します。",
              ),
        location: localized(
          locale,
          "Cloudflare-managed Workers AI infrastructure; no specific processing geography is asserted by this disclosure.",
          "Cloudflareが管理するWorkers AI基盤で処理されます。この開示では特定の処理地域を保証しません。",
        ),
        privacyPolicyUrl: WORKERS_AI_DATA_POLICY_URL,
      },
    ],
    policyUrl: WORKERS_AI_DATA_POLICY_URL,
    providerStorageSummary: localized(
      locale,
      "Cloudflare documents that Customer Content may be stored when a storage service is used with Workers AI.",
      "Cloudflareは、Workers AIとストレージサービスを併用する場合、Customer Contentが保存される可能性があると説明しています。",
    ),
    providerRetentionSummary: localized(
      locale,
      "Provider-side handling follows the linked Cloudflare policy; Grimodex does not assert an additional provider retention duration.",
      "プロバイダ側の取扱いはリンク先のCloudflareポリシーに従います。Grimodexは追加のプロバイダ保持期間を保証しません。",
    ),
    trainingUse: {
      status: "not-used",
      summary: localized(
        locale,
        "Cloudflare states that Workers AI Customer Content is not used to train AI models or improve services without explicit consent.",
        "Cloudflareは、明示的な同意なしにWorkers AIのCustomer ContentをAIモデルの学習またはサービス改善へ利用しないと説明しています。",
      ),
      policyUrl: WORKERS_AI_DATA_POLICY_URL,
    },
  };
}

function deterministicScanDisclosure(
  locale: AiDataDisclosureLocale,
): ProviderDisclosure {
  const policyUrl = grimodexPolicyUrl(locale);
  return {
    id: "deterministic",
    processingDestinations: [
      {
        processor: "Grimodex deterministic Scan",
        purpose: localized(
          locale,
          "Build Scan artifacts with deterministic rules without sending manuscript content to an external AI model.",
          "原稿を外部AIモデルへ送信せず、決定的ルールでScan成果物を生成します。",
        ),
        location: localized(
          locale,
          "Cloudflare Worker execution and Grimodex-managed R2/D1 storage; no external AI model endpoint is used.",
          "Cloudflare Worker上で実行し、Grimodex管理のR2／D1へ保存します。外部AIモデルのエンドポイントは使用しません。",
        ),
        privacyPolicyUrl: policyUrl,
      },
    ],
    policyUrl,
    providerStorageSummary: localized(
      locale,
      "No AI provider receives or stores the manuscript; only the application storage described in this disclosure applies.",
      "AIプロバイダは原稿を受信・保存しません。この開示に記載したアプリ側ストレージだけを使用します。",
    ),
    providerRetentionSummary: localized(
      locale,
      "No AI-provider retention period applies because no external AI model receives the manuscript.",
      "外部AIモデルへ原稿を送信しないため、AIプロバイダ側の保持期間は適用されません。",
    ),
    trainingUse: {
      status: "not-used",
      summary: localized(
        locale,
        "The manuscript is not sent to an external AI model, so it is not used for model training by an AI provider.",
        "原稿は外部AIモデルへ送信されないため、AIプロバイダのモデル学習には利用されません。",
      ),
      policyUrl,
    },
  };
}

function cloudflareGatewayUpstream(env: ScanEnv): "openai" {
  let endpoint: URL;
  try {
    endpoint = new URL(env.SCAN_AI_GATEWAY_URL ?? "");
  } catch {
    throw new AiDataDisclosureUnavailableError(
      "AI Gateway disclosure requires a recognized upstream endpoint",
    );
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.hostname !== "gateway.ai.cloudflare.com"
  ) {
    throw new AiDataDisclosureUnavailableError(
      "AI Gateway disclosure requires a recognized Cloudflare endpoint",
    );
  }
  const pathSegments = endpoint.pathname.split("/").filter(Boolean);
  if (!pathSegments.includes("openai")) {
    throw new AiDataDisclosureUnavailableError(
      "AI Gateway disclosure requires a recognized upstream provider",
    );
  }
  return "openai";
}

function aiGatewayDisclosure(
  env: ScanEnv,
  route: AiDataDisclosureRoute,
  locale: AiDataDisclosureLocale,
): ProviderDisclosure {
  const upstream = cloudflareGatewayUpstream(env);
  return {
    id: `ai-gateway:${upstream}`,
    processingDestinations: [
      {
        processor: "Cloudflare AI Gateway",
        purpose:
          route === "scan"
            ? localized(
                locale,
                "Route and observe the configured frontier analysis request.",
                "設定されたfrontier解析リクエストを中継し、可観測性を提供します。",
              )
            : localized(
                locale,
                "Route and observe the hosted editor assistance request.",
                "Hosted Editor支援リクエストを中継し、可観測性を提供します。",
              ),
        location: localized(
          locale,
          "Cloudflare-managed AI Gateway infrastructure; no specific processing geography is asserted by this disclosure.",
          "Cloudflareが管理するAI Gateway基盤で処理されます。この開示では特定の処理地域を保証しません。",
        ),
        privacyPolicyUrl: AI_GATEWAY_LOGGING_POLICY_URL,
      },
      {
        processor: "OpenAI API",
        purpose:
          route === "scan"
            ? localized(
                locale,
                "Run the configured Full Scan frontier analysis.",
                "設定されたFull Scanのfrontier解析を実行します。",
              )
            : localized(
                locale,
                "Generate the configured hosted editor assistance.",
                "設定されたHosted Editor支援を生成します。",
              ),
        location: localized(
          locale,
          "OpenAI-managed API infrastructure; no specific processing geography is asserted by this disclosure.",
          "OpenAIが管理するAPI基盤で処理されます。この開示では特定の処理地域を保証しません。",
        ),
        privacyPolicyUrl: OPENAI_API_DATA_POLICY_URL,
      },
    ],
    policyUrl: AI_GATEWAY_LOGGING_POLICY_URL,
    providerStorageSummary: localized(
      locale,
      "Cloudflare AI Gateway can store request and response payload logs according to gateway settings; OpenAI API data controls apply upstream.",
      "Cloudflare AI Gatewayはゲートウェイ設定に従いリクエスト／レスポンスのペイロードログを保存する場合があり、上流ではOpenAI APIのデータ管理が適用されます。",
    ),
    providerRetentionSummary: localized(
      locale,
      "Cloudflare AI Gateway log retention depends on the configured gateway settings. OpenAI API abuse-monitoring logs may be retained for up to 30 days by default unless stricter controls apply.",
      "Cloudflare AI Gatewayのログ保持期間はゲートウェイ設定に依存します。OpenAI APIの不正利用監視ログは、より厳しい管理が適用されない限り、標準で最長30日保持される場合があります。",
    ),
    trainingUse: {
      status: "depends",
      summary: localized(
        locale,
        "OpenAI API data is not used for model training by default, but account opt-in and configured gateway or upstream controls can change handling; verify the linked policies.",
        "OpenAI APIのデータは標準ではモデル学習に利用されませんが、アカウントのオプトインやゲートウェイ／上流の設定により取扱いが変わる場合があります。リンク先のポリシーを確認してください。",
      ),
      policyUrl: OPENAI_API_DATA_POLICY_URL,
    },
  };
}

function openRouterDisclosure(
  env: ScanEnv,
  route: AiDataDisclosureRoute,
  locale: AiDataDisclosureLocale,
): ProviderDisclosure {
  let endpoint: URL;
  try {
    endpoint = new URL(env.OPENROUTER_URL ?? "");
  } catch {
    throw new AiDataDisclosureUnavailableError(
      "OpenRouter disclosure requires a recognized endpoint",
    );
  }
  if (
    endpoint.protocol !== "https:" ||
    (endpoint.hostname !== "openrouter.ai" &&
      endpoint.hostname !== "eu.openrouter.ai")
  ) {
    throw new AiDataDisclosureUnavailableError(
      "OpenRouter disclosure requires a recognized endpoint",
    );
  }
  return {
    id: "openrouter:provider-dependent",
    processingDestinations: [
      {
        processor: "OpenRouter",
        purpose:
          route === "scan"
            ? localized(
                locale,
                "Route the configured scan analysis request.",
                "設定されたScan解析リクエストを中継します。",
              )
            : localized(
                locale,
                "Route the hosted editor assistance request.",
                "Hosted Editor支援リクエストを中継します。",
              ),
        location: localized(
          locale,
          "OpenRouter-managed routing infrastructure; processing geography depends on account and endpoint configuration.",
          "OpenRouterが管理するルーティング基盤で処理されます。処理地域はアカウントとエンドポイントの設定に依存します。",
        ),
        privacyPolicyUrl: OPENROUTER_DATA_POLICY_URL,
      },
      {
        processor: "OpenRouter-selected model provider",
        purpose: localized(
          locale,
          "Generate the requested AI result.",
          "要求されたAI結果を生成します。",
        ),
        location: localized(
          locale,
          "The selected model provider's infrastructure; geography depends on OpenRouter routing and account controls.",
          "選択されたモデルプロバイダの基盤で処理されます。地域はOpenRouterのルーティングとアカウント設定に依存します。",
        ),
        privacyPolicyUrl: OPENROUTER_PROVIDER_POLICY_URL,
      },
    ],
    policyUrl: OPENROUTER_DATA_POLICY_URL,
    providerStorageSummary: localized(
      locale,
      "OpenRouter prompt logging is account-controlled, while the selected model provider has its own storage policy.",
      "OpenRouterのプロンプトログはアカウント設定で管理され、選択されたモデルプロバイダには独自の保存ポリシーがあります。",
    ),
    providerRetentionSummary: localized(
      locale,
      "OpenRouter and the selected model provider apply account-, endpoint-, and provider-specific retention controls; no single duration is asserted.",
      "OpenRouterと選択されたモデルプロバイダでは、アカウント、エンドポイント、プロバイダごとの保持管理が適用されます。単一の保持期間は保証しません。",
    ),
    trainingUse: {
      status: "depends",
      summary: localized(
        locale,
        "Training use depends on OpenRouter privacy controls and the selected model provider; providers without an established policy must not be represented as no-training.",
        "モデル学習への利用はOpenRouterのプライバシー設定と選択されたモデルプロバイダに依存します。方針を確認できないプロバイダを「学習に利用しない」とは表示しません。",
      ),
      policyUrl: OPENROUTER_PROVIDER_POLICY_URL,
    },
  };
}

function disclosureForProvider(
  env: ScanEnv,
  route: AiDataDisclosureRoute,
  provider: ConfiguredProvider,
  locale: AiDataDisclosureLocale,
): ProviderDisclosure {
  if (provider === "workers-ai") return workersAiDisclosure(route, locale);
  if (provider === "ai-gateway") return aiGatewayDisclosure(env, route, locale);
  return openRouterDisclosure(env, route, locale);
}

function disclosureProfile(
  env: ScanEnv,
  route: AiDataDisclosureRoute,
  locale: AiDataDisclosureLocale = "en",
): DisclosureProfile {
  const providers =
    route === "scan" && env.SCAN_WORKERS_AI_ENABLED !== "true"
      ? [deterministicScanDisclosure(locale)]
      : [disclosureForProvider(env, route, configuredProvider(env), locale)];
  if (route === "scan" && env.SCAN_FRONTIER_ENABLED === "true") {
    const frontier = disclosureForProvider(
      env,
      route,
      configuredFrontierProvider(env),
      locale,
    );
    if (!providers.some((provider) => provider.id === frontier.id)) {
      providers.push(frontier);
    }
  }
  const provider = providers.map(({ id }) => id).join("+");
  const processingDestinations = providers.flatMap(
    ({ processingDestinations: destinations }) => destinations,
  );
  const providerStorageSummary = providers
    .map(({ providerStorageSummary: summary }) => summary)
    .join(" ");
  const providerRetentionSummary = providers
    .map(({ providerRetentionSummary: summary }) => summary)
    .join(" ");
  const providerWithConditionalTraining = providers.find(
    ({ trainingUse }) => trainingUse.status !== "not-used",
  );
  const trainingUse = providerWithConditionalTraining
    ? {
        status: "depends" as const,
        summary: providers
          .map(({ trainingUse: { summary } }) => summary)
          .join(" "),
        policyUrl: providerWithConditionalTraining.trainingUse.policyUrl,
      }
    : providers.length === 1
      ? providers[0]!.trainingUse
      : {
          status: "not-used" as const,
          summary: providers
            .map(({ trainingUse: { summary } }) => summary)
            .join(" "),
          policyUrl: providers.at(-1)!.trainingUse.policyUrl,
        };
  return {
    provider,
    processingDestinations,
    policyUrl: providers.at(-1)!.policyUrl,
    providerStorageSummary,
    providerRetentionSummary,
    trainingUse,
  };
}

export async function expectedAiDataConsentId(
  env: ScanEnv,
  route: AiDataDisclosureRoute,
): Promise<string> {
  const profile = disclosureProfile(env, route);
  const digest = await sha256Hex(
    `${AI_DATA_POLICY_VERSION}\u0000${route}\u0000${profile.provider}`,
  );
  return `consent_${digest}`;
}

export async function currentAiDataConsentIdentity(
  env: ScanEnv,
  route: AiDataDisclosureRoute,
): Promise<AiDataConsentIdentity> {
  const profile = disclosureProfile(env, route);
  return {
    consentId: await expectedAiDataConsentId(env, route),
    policyVersion: AI_DATA_POLICY_VERSION,
    provider: profile.provider,
    route,
  };
}

export async function assertCurrentAiDataConsentIdentity(
  env: ScanEnv,
  identity: AiDataConsentIdentity | null | undefined,
  route: AiDataDisclosureRoute,
): Promise<AiDataConsentIdentity> {
  if (
    !identity ||
    typeof identity.consentId !== "string" ||
    typeof identity.policyVersion !== "string" ||
    typeof identity.provider !== "string" ||
    identity.route !== route
  ) {
    throw new AiDataConsentMismatchError();
  }
  const current = await currentAiDataConsentIdentity(env, route);
  if (
    identity.policyVersion !== current.policyVersion ||
    identity.provider !== current.provider ||
    identity.route !== current.route ||
    !constantTimeEqual(identity.consentId, current.consentId)
  ) {
    throw new AiDataConsentMismatchError();
  }
  return current;
}

function sentDataForRoute(
  route: AiDataDisclosureRoute,
  locale: AiDataDisclosureLocale,
): AiDataDisclosureV1["sentData"] {
  if (route === "scan") {
    return [
      {
        category: "manuscript",
        description: localized(
          locale,
          "The uploaded manuscript text and the metadata required to process the scan.",
          "アップロードした原稿本文と、Scan処理に必要なメタデータです。",
        ),
      },
    ];
  }
  return [
    {
      category: "prompt",
      description: localized(
        locale,
        "The instruction entered for hosted editor assistance.",
        "Hosted Editor支援のために入力した指示です。",
      ),
    },
    {
      category: "system-instructions",
      description: localized(
        locale,
        "System instructions used to define the requested editor assistance.",
        "要求されたEditor支援の動作を定義するシステム指示です。",
      ),
    },
    {
      category: "conversation-history",
      description: localized(
        locale,
        "Prior visible user and assistant messages, structured tool-call arguments, and explicit tool-result text included in the current conversation context. Hidden reasoning blocks are not sent.",
        "現在の会話コンテキストに含まれる、表示済みのユーザー／アシスタントメッセージ、構造化されたツール呼び出し引数、明示的なツール結果本文です。非表示の推論ブロックは送信しません。",
      ),
    },
    {
      category: "tool-definitions",
      description: localized(
        locale,
        "The names, descriptions, and input JSON schemas of the tools declared for this agent turn.",
        "このエージェントターンで宣言されたツールの名前、説明、入力JSONスキーマです。",
      ),
    },
    {
      category: "selected-context",
      description: localized(
        locale,
        "Only the manuscript context included with the hosted editor request.",
        "Hosted Editorリクエストに含めた原稿コンテキストだけです。",
      ),
    },
  ];
}

export async function createAiDataDisclosure(
  env: ScanEnv,
  route: AiDataDisclosureRoute,
  locale: AiDataDisclosureLocale = "en",
): Promise<AiDataDisclosureV1> {
  const profile = disclosureProfile(env, route, locale);
  const workersOnly = profile.provider === "workers-ai";
  const deterministicOnly = profile.provider === "deterministic";
  const candidate: AiDataDisclosureV1 = {
    schemaVersion: AI_DATA_DISCLOSURE_SCHEMA_VERSION,
    policyVersion: AI_DATA_POLICY_VERSION,
    contentPolicy: {
      version: CLOUD_CONTENT_POLICY_VERSION,
      acknowledgementHeader: CLOUD_CONTENT_POLICY_ACK_HEADER,
    },
    route,
    provider: profile.provider,
    consentId: await expectedAiDataConsentId(env, route),
    usagePolicy: {
      summary: deterministicOnly
        ? localized(
            locale,
            "This Scan configuration uses deterministic Grimodex processing; no external AI model receives the manuscript. Processing starts only after explicit consent.",
            "このScan構成では、原稿をGrimodexの決定的ルールで処理し、外部AIモデルへ送信しません。処理は明示的な同意後にのみ開始します。",
          )
        : workersOnly
          ? localized(
              locale,
              "Grimodex sends the disclosed data to Cloudflare Workers AI only after explicit consent.",
              "Grimodexは、明示的な同意後にのみ、開示したデータをCloudflare Workers AIへ送信します。",
            )
          : localized(
              locale,
              `Grimodex sends the disclosed data through the configured ${profile.provider} processing chain only after explicit consent.`,
              `Grimodexは、明示的な同意後にのみ、開示したデータを設定済みの${profile.provider}処理経路へ送信します。`,
            ),
      policyUrl: grimodexPolicyUrl(locale),
    },
    sentData: sentDataForRoute(route, locale),
    processingDestinations: profile.processingDestinations,
    storage: {
      application: {
        storesPrompt: !deterministicOnly,
        storesResponse: true,
        location:
          route === "scan"
            ? localized(
                locale,
                "Cloudflare R2 stores the uploaded manuscript and Scan artifacts for the source and artifact retention periods shown below. Cloudflare D1 stores non-content operational metadata, consent identity, token hashes, provider/model details, request and idempotency hashes, usage records, and retention deadlines; those records follow Scan deletion plus applicable operational or legal retention requirements. The deletion control on the results screen immediately revokes access and starts removing the manuscript and artifacts stored by Grimodex in R2.",
                "Cloudflare R2は、アップロードした原稿とScan成果物を、以下に示す原稿／成果物の保持期間中保存します。Cloudflare D1は、本文を含まない運用メタデータ、同意識別子、トークンのハッシュ、プロバイダ／モデル情報、リクエスト／冪等性のハッシュ、利用記録、保持期限を保存します。これらの記録は、Scan削除後も適用される運用上または法的な保持要件に従います。結果画面の削除操作では、アクセスを直ちに停止し、GrimodexがR2に保存した原稿と成果物の削除を開始します。",
              )
            : localized(
                locale,
                "Visible chat history and AI output are stored in this browser workspace's IndexedDB until its workspace/site data is deleted. Cloudflare R2 stores scoped Hosted AI result artifacts for the server retention period shown below. Cloudflare D1 stores non-content operational metadata, session token hashes, consent identity, provider/model details, request and idempotency hashes, usage records, and retention deadlines; those records follow workspace or Scan deletion plus applicable operational or legal retention requirements.",
                "表示済みのチャット履歴とAI出力は、このブラウザワークスペースのIndexedDBに、ワークスペースまたはサイトデータを削除するまで保存されます。Cloudflare R2は、対象を限定したHosted AI結果成果物を以下のサーバー保持期間中保存します。Cloudflare D1は、本文を含まない運用メタデータ、セッショントークンのハッシュ、同意識別子、プロバイダ／モデル情報、リクエスト／冪等性のハッシュ、利用記録、保持期限を保存します。これらの記録は、ワークスペースまたはScan削除後も適用される運用上または法的な保持要件に従います。",
              ),
      },
      provider: {
        summary: profile.providerStorageSummary,
        policyUrl: profile.policyUrl,
      },
    },
    retention: {
      application: {
        uploadMinutes: positiveInt(env.SCAN_UPLOAD_RETENTION_MINUTES, 60),
        sourceDays: positiveInt(env.SCAN_SOURCE_RETENTION_DAYS, 1),
        artifactDays: positiveInt(env.SCAN_RETENTION_DAYS, 30),
      },
      provider: {
        summary: profile.providerRetentionSummary,
        policyUrl: profile.policyUrl,
      },
    },
    trainingUse: profile.trainingUse,
  };
  const parsed = parseAiDataDisclosure(candidate);
  if (!parsed.ok) {
    throw new AiDataDisclosureUnavailableError(
      "AI data disclosure failed contract validation",
    );
  }
  return parsed.value;
}
