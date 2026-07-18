import {
  AI_DATA_DISCLOSURE_SCHEMA_VERSION,
  parseAiDataDisclosure,
  type AiDataDisclosureRoute,
  type AiDataDisclosureV1,
} from "@grimodex/scan-contract";
import type { ScanEnv } from "../env";
import { constantTimeEqual, sha256Hex } from "../security";

export const AI_DATA_POLICY_VERSION = "2026-07-19.4";
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

type ConfiguredProvider = "workers-ai" | "ai-gateway" | "openrouter";

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

function workersAiDisclosure(route: AiDataDisclosureRoute): ProviderDisclosure {
  return {
    id: "workers-ai",
    processingDestinations: [
      {
        processor: "Cloudflare Workers AI",
        purpose:
          route === "scan"
            ? "Analyze the manuscript and produce the requested scan artifacts."
            : "Generate the requested hosted editor assistance.",
        location:
          "Cloudflare-managed Workers AI infrastructure; no specific processing geography is asserted by this disclosure.",
        privacyPolicyUrl: WORKERS_AI_DATA_POLICY_URL,
      },
    ],
    policyUrl: WORKERS_AI_DATA_POLICY_URL,
    providerStorageSummary:
      "Cloudflare documents that Customer Content may be stored when a storage service is used with Workers AI.",
    providerRetentionSummary:
      "Provider-side handling follows the linked Cloudflare policy; Grimodex does not assert an additional provider retention duration.",
    trainingUse: {
      status: "not-used",
      summary:
        "Cloudflare states that Workers AI Customer Content is not used to train AI models or improve services without explicit consent.",
      policyUrl: WORKERS_AI_DATA_POLICY_URL,
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
): ProviderDisclosure {
  const upstream = cloudflareGatewayUpstream(env);
  return {
    id: `ai-gateway:${upstream}`,
    processingDestinations: [
      {
        processor: "Cloudflare AI Gateway",
        purpose:
          route === "scan"
            ? "Route and observe the configured frontier analysis request."
            : "Route and observe the hosted editor assistance request.",
        location:
          "Cloudflare-managed AI Gateway infrastructure; no specific processing geography is asserted by this disclosure.",
        privacyPolicyUrl: AI_GATEWAY_LOGGING_POLICY_URL,
      },
      {
        processor: "OpenAI API",
        purpose:
          route === "scan"
            ? "Run the configured Full Scan frontier analysis."
            : "Generate the configured hosted editor assistance.",
        location:
          "OpenAI-managed API infrastructure; no specific processing geography is asserted by this disclosure.",
        privacyPolicyUrl: OPENAI_API_DATA_POLICY_URL,
      },
    ],
    policyUrl: AI_GATEWAY_LOGGING_POLICY_URL,
    providerStorageSummary:
      "Cloudflare AI Gateway can store request and response payload logs according to gateway settings; OpenAI API data controls apply upstream.",
    providerRetentionSummary:
      "Cloudflare AI Gateway log retention depends on the configured gateway settings. OpenAI API abuse-monitoring logs may be retained for up to 30 days by default unless stricter controls apply.",
    trainingUse: {
      status: "depends",
      summary:
        "OpenAI API data is not used for model training by default, but account opt-in and configured gateway or upstream controls can change handling; verify the linked policies.",
      policyUrl: OPENAI_API_DATA_POLICY_URL,
    },
  };
}

function openRouterDisclosure(
  env: ScanEnv,
  route: AiDataDisclosureRoute,
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
            ? "Route the configured scan analysis request."
            : "Route the hosted editor assistance request.",
        location:
          "OpenRouter-managed routing infrastructure; processing geography depends on account and endpoint configuration.",
        privacyPolicyUrl: OPENROUTER_DATA_POLICY_URL,
      },
      {
        processor: "OpenRouter-selected model provider",
        purpose: "Generate the requested AI result.",
        location:
          "The selected model provider's infrastructure; geography depends on OpenRouter routing and account controls.",
        privacyPolicyUrl: OPENROUTER_PROVIDER_POLICY_URL,
      },
    ],
    policyUrl: OPENROUTER_DATA_POLICY_URL,
    providerStorageSummary:
      "OpenRouter prompt logging is account-controlled, while the selected model provider has its own storage policy.",
    providerRetentionSummary:
      "OpenRouter and the selected model provider apply account-, endpoint-, and provider-specific retention controls; no single duration is asserted.",
    trainingUse: {
      status: "depends",
      summary:
        "Training use depends on OpenRouter privacy controls and the selected model provider; providers without an established policy must not be represented as no-training.",
      policyUrl: OPENROUTER_PROVIDER_POLICY_URL,
    },
  };
}

function disclosureForProvider(
  env: ScanEnv,
  route: AiDataDisclosureRoute,
  provider: ConfiguredProvider,
): ProviderDisclosure {
  if (provider === "workers-ai") return workersAiDisclosure(route);
  if (provider === "ai-gateway") return aiGatewayDisclosure(env, route);
  return openRouterDisclosure(env, route);
}

function disclosureProfile(
  env: ScanEnv,
  route: AiDataDisclosureRoute,
): DisclosureProfile {
  const providers = [
    disclosureForProvider(env, route, configuredProvider(env)),
  ];
  if (route === "scan" && env.SCAN_FRONTIER_ENABLED === "true") {
    const frontier = disclosureForProvider(
      env,
      route,
      configuredFrontierProvider(env),
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
    : providers[0]!.trainingUse;
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
): AiDataDisclosureV1["sentData"] {
  if (route === "scan") {
    return [
      {
        category: "manuscript",
        description:
          "The uploaded manuscript text and the metadata required to process the scan.",
      },
    ];
  }
  return [
    {
      category: "prompt",
      description: "The instruction entered for hosted editor assistance.",
    },
    {
      category: "system-instructions",
      description:
        "System instructions used to define the requested editor assistance.",
    },
    {
      category: "conversation-history",
      description:
        "Prior visible user and assistant messages, structured tool-call arguments, and explicit tool-result text included in the current conversation context. Hidden reasoning blocks are not sent.",
    },
    {
      category: "tool-definitions",
      description:
        "The names, descriptions, and input JSON schemas of the tools declared for this agent turn.",
    },
    {
      category: "selected-context",
      description:
        "Only the manuscript context included with the hosted editor request.",
    },
  ];
}

export async function createAiDataDisclosure(
  env: ScanEnv,
  route: AiDataDisclosureRoute,
): Promise<AiDataDisclosureV1> {
  const profile = disclosureProfile(env, route);
  const workersOnly = profile.provider === "workers-ai";
  const candidate: AiDataDisclosureV1 = {
    schemaVersion: AI_DATA_DISCLOSURE_SCHEMA_VERSION,
    policyVersion: AI_DATA_POLICY_VERSION,
    route,
    provider: profile.provider,
    consentId: await expectedAiDataConsentId(env, route),
    usagePolicy: {
      summary: workersOnly
        ? "Grimodex sends the disclosed data to Cloudflare Workers AI only after explicit consent."
        : `Grimodex sends the disclosed data through the configured ${profile.provider} processing chain only after explicit consent.`,
      policyUrl: GRIMODEX_AI_DATA_POLICY_URL,
    },
    sentData: sentDataForRoute(route),
    processingDestinations: profile.processingDestinations,
    storage: {
      application: {
        storesPrompt: true,
        storesResponse: true,
        location:
          route === "scan"
            ? "Cloudflare R2 stores the uploaded manuscript and Scan artifacts for the source and artifact retention periods shown below. Cloudflare D1 stores non-content operational metadata, consent identity, token hashes, provider/model details, request and idempotency hashes, usage records, and retention deadlines; those records follow Scan deletion plus applicable operational or legal retention requirements."
            : "Visible chat history and AI output are stored in this browser workspace's IndexedDB until its workspace/site data is deleted. Cloudflare R2 stores scoped Hosted AI result artifacts for the server retention period shown below. Cloudflare D1 stores non-content operational metadata, session token hashes, consent identity, provider/model details, request and idempotency hashes, usage records, and retention deadlines; those records follow workspace or Scan deletion plus applicable operational or legal retention requirements.",
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
