import type { TFunction } from "i18next";
import i18next from "@/lib/i18n";
import {
  browserProviderRequiresApiKey,
  normalizeOllamaEndpoint,
} from "@/lib/browser-ai";
import type { BrowserAiMode } from "@/features/chat/types";
import { BROWSER_DIRECT_AI_PROVIDERS } from "@/features/chat/browserProviderPolicy";
import type { AiDataDisclosureView } from "./AiDataConsentDialog";
import { requestAiDataConsent } from "./aiDataConsentBroker";

export const BROWSER_AI_DATA_POLICY_VERSION = "2026-07-25.2";

export type BrowserAiDisclosureLocale = "ja" | "en";
type BrowserAiDisclosureProvider = (typeof BROWSER_DIRECT_AI_PROVIDERS)[number];

export interface BrowserAiDisclosureOptions {
  locale?: BrowserAiDisclosureLocale;
  ollamaEndpoint?: string | null;
  baseUrl?: string | null;
  hasApiKey?: boolean;
  browserAiMode?: BrowserAiMode;
}

type ProviderFacts = Pick<
  AiDataDisclosureView,
  "processingDestinations" | "trainingUse"
> & {
  destination: string;
  providerRetention: AiDataDisclosureView["retention"]["provider"];
  providerStorage: AiDataDisclosureView["storage"]["provider"];
};

function resolveLocale(
  requested?: BrowserAiDisclosureLocale,
): BrowserAiDisclosureLocale {
  if (requested) return requested;
  const current = i18next.resolvedLanguage || i18next.language;
  return current === "ja" || current?.startsWith("ja-") ? "ja" : "en";
}

function requireProvider(value: string): BrowserAiDisclosureProvider {
  const provider = value.trim().toLowerCase();
  if ((BROWSER_DIRECT_AI_PROVIDERS as readonly string[]).includes(provider)) {
    return provider as BrowserAiDisclosureProvider;
  }
  throw new Error(
    `Provider "${provider || "unknown"}" is not supported in browser mode`,
  );
}

function normalizeConfiguredDestination(
  value: string | null | undefined,
): string {
  const destination = value?.trim().replace(/\/+$/, "") ?? "";
  if (!destination) {
    throw new Error("OpenAI-compatible base URL is not configured");
  }
  let parsed: URL;
  try {
    parsed = new URL(destination);
  } catch {
    throw new Error("OpenAI-compatible base URL is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("OpenAI-compatible base URL must use http or https");
  }
  return destination;
}

function grimodexPrivacyUrl(locale: BrowserAiDisclosureLocale): string {
  return `https://github.com/kazormia296/Grimodex/blob/master/public/PRIVACY_${locale}.md`;
}

function destinationFingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function providerFacts(
  provider: BrowserAiDisclosureProvider,
  options: BrowserAiDisclosureOptions,
  t: TFunction,
): ProviderFacts {
  if (options.browserAiMode === "webgpu") {
    const privacyUrl = grimodexPrivacyUrl(resolveLocale(options.locale));
    return {
      destination: "browser://local",
      processingDestinations: [
        {
          processor: t("aiDataConsent.disclosure.local.processor"),
          purpose: t("aiDataConsent.disclosure.local.purpose"),
          location: t("aiDataConsent.disclosure.local.location"),
          privacyPolicyUrl: privacyUrl,
        },
      ],
      providerStorage: {
        summary: t("aiDataConsent.disclosure.local.storage"),
        policyUrl: privacyUrl,
      },
      providerRetention: {
        summary: t("aiDataConsent.disclosure.local.retention"),
        policyUrl: privacyUrl,
      },
      trainingUse: {
        status: "not-used",
        summary: t("aiDataConsent.disclosure.local.training"),
        policyUrl: privacyUrl,
      },
    };
  }
  if (provider === "openai") {
    const retentionPolicy =
      "https://platform.openai.com/docs/models/default-usage-policies-by-endpoint";
    const trainingPolicy =
      "https://openai.com/policies/how-your-data-is-used-to-improve-model-performance/";
    return {
      destination: "https://api.openai.com",
      processingDestinations: [
        {
          processor: "OpenAI API",
          purpose: t("aiDataConsent.disclosure.provider.openai.purpose"),
          location: t("aiDataConsent.disclosure.provider.openai.location"),
          privacyPolicyUrl: trainingPolicy,
        },
      ],
      providerStorage: {
        summary: t("aiDataConsent.disclosure.provider.openai.storage"),
        policyUrl: retentionPolicy,
      },
      providerRetention: {
        summary: t("aiDataConsent.disclosure.provider.openai.retention"),
        policyUrl: retentionPolicy,
      },
      trainingUse: {
        status: "not-used",
        summary: t("aiDataConsent.disclosure.provider.openai.training"),
        policyUrl: trainingPolicy,
      },
    };
  }

  if (provider === "anthropic") {
    const retentionPolicy =
      "https://privacy.anthropic.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data";
    const trainingPolicy =
      "https://privacy.anthropic.com/en/articles/7996868-is-my-data-used-for-model-training";
    return {
      destination: "https://api.anthropic.com",
      processingDestinations: [
        {
          processor: "Anthropic API",
          purpose: t("aiDataConsent.disclosure.provider.anthropic.purpose"),
          location: t("aiDataConsent.disclosure.provider.anthropic.location"),
          privacyPolicyUrl: trainingPolicy,
        },
      ],
      providerStorage: {
        summary: t("aiDataConsent.disclosure.provider.anthropic.storage"),
        policyUrl: retentionPolicy,
      },
      providerRetention: {
        summary: t("aiDataConsent.disclosure.provider.anthropic.retention"),
        policyUrl: retentionPolicy,
      },
      trainingUse: {
        status: "not-used",
        summary: t("aiDataConsent.disclosure.provider.anthropic.training"),
        policyUrl: trainingPolicy,
      },
    };
  }

  if (provider === "openai-compatible") {
    const destination = normalizeConfiguredDestination(options.baseUrl);
    return {
      destination,
      processingDestinations: [
        {
          processor: t(
            "aiDataConsent.disclosure.provider.configured.processor",
          ),
          purpose: t("aiDataConsent.disclosure.provider.configured.purpose"),
          location: destination,
          privacyPolicyUrl: destination,
        },
      ],
      providerStorage: {
        summary: t("aiDataConsent.disclosure.provider.configured.storage"),
        policyUrl: destination,
      },
      providerRetention: {
        summary: t("aiDataConsent.disclosure.provider.configured.retention"),
        policyUrl: destination,
      },
      trainingUse: {
        status: "depends",
        summary: t("aiDataConsent.disclosure.provider.configured.training"),
        policyUrl: destination,
      },
    };
  }

  const externalProviders: Partial<
    Record<
      BrowserAiDisclosureProvider,
      {
        destination: string;
        label: string;
        processor: string;
        policyUrl: string;
      }
    >
  > = {
    openrouter: {
      destination: "https://openrouter.ai/api/v1",
      label: "OpenRouter",
      processor: "OpenRouter and its selected inference provider(s)",
      policyUrl: "https://openrouter.ai/docs/guides/privacy/data-collection",
    },
    sakana: {
      destination: "https://api.sakana.ai/v1",
      label: "Sakana AI",
      processor: "Sakana AI API and the providers enabled for your API key",
      policyUrl: "https://console.sakana.ai/privacy-policy",
    },
    "ai-novelist": {
      destination: "https://api.tringpt.com",
      label: "AI Novelist",
      processor: "AI Novelist / Bit192",
      policyUrl: "https://ai-novel.com/terms_of_use.html",
    },
  };
  const external = externalProviders[provider];
  if (external) {
    const label = external.label;
    return {
      destination: external.destination,
      processingDestinations: [
        {
          processor: external.processor,
          purpose: t("aiDataConsent.disclosure.provider.external.purpose", {
            provider: label,
          }),
          location: t("aiDataConsent.disclosure.provider.external.location", {
            provider: label,
          }),
          privacyPolicyUrl: external.policyUrl,
        },
      ],
      providerStorage: {
        summary: t("aiDataConsent.disclosure.provider.external.storage", {
          provider: label,
        }),
        policyUrl: external.policyUrl,
      },
      providerRetention: {
        summary: t("aiDataConsent.disclosure.provider.external.retention", {
          provider: label,
        }),
        policyUrl: external.policyUrl,
      },
      trainingUse: {
        status: "depends",
        summary: t("aiDataConsent.disclosure.provider.external.training", {
          provider: label,
        }),
        policyUrl: external.policyUrl,
      },
    };
  }

  const destination = normalizeOllamaEndpoint(options.ollamaEndpoint);
  const policyUrl = "https://ollama.com/privacy";
  return {
    destination,
    processingDestinations: [
      {
        processor: t("aiDataConsent.disclosure.provider.ollama.processor"),
        purpose: t("aiDataConsent.disclosure.provider.ollama.purpose"),
        location: destination,
        privacyPolicyUrl: policyUrl,
      },
    ],
    providerStorage: {
      summary: t("aiDataConsent.disclosure.provider.ollama.storage"),
      policyUrl,
    },
    providerRetention: {
      summary: t("aiDataConsent.disclosure.provider.ollama.retention"),
      policyUrl,
    },
    trainingUse: {
      status: "depends",
      summary: t("aiDataConsent.disclosure.provider.ollama.training"),
      policyUrl,
    },
  };
}

export function createByokAiDataDisclosure(
  providerInput: string,
  options: BrowserAiDisclosureOptions = {},
): AiDataDisclosureView {
  const provider = requireProvider(providerInput);
  const locale = resolveLocale(options.locale);
  const t = i18next.getFixedT(locale);
  const facts = providerFacts(provider, options, t);
  const privacyUrl = grimodexPrivacyUrl(locale);
  const sendsCredential =
    options.browserAiMode === "webgpu"
      ? false
      : (options.hasApiKey ?? browserProviderRequiresApiKey(provider));
  const isBrowserLocal = options.browserAiMode === "webgpu";
  const disclosureProvider = isBrowserLocal ? "browser-local" : provider;
  const consentRoute = isBrowserLocal ? "browser-local" : "byok";
  const consentRouteId = consentRoute.replace(/-/gu, "_");
  return {
    schemaVersion: "grimodex/ai-data-disclosure/1",
    policyVersion: BROWSER_AI_DATA_POLICY_VERSION,
    route: consentRoute,
    provider: disclosureProvider,
    destination: facts.destination,
    consentId: `consent_${consentRouteId}_${disclosureProvider}_${destinationFingerprint(facts.destination)}_${BROWSER_AI_DATA_POLICY_VERSION.replace(/[^0-9a-z]/gi, "_")}_v2`,
    usagePolicy: {
      summary: t(
        isBrowserLocal
          ? "aiDataConsent.disclosure.local.usageSummary"
          : "aiDataConsent.disclosure.usageSummary",
      ),
      policyUrl: privacyUrl,
    },
    sentData: [
      {
        category: "prompt",
        description: t("aiDataConsent.disclosure.sentPrompt"),
      },
      {
        category: "selected-context",
        description: t("aiDataConsent.disclosure.sentContext"),
      },
      ...(!sendsCredential
        ? []
        : [
            {
              category: "credential",
              description: t("aiDataConsent.disclosure.sentCredential"),
            },
          ]),
    ],
    processingDestinations: facts.processingDestinations,
    storage: {
      application: {
        storesPrompt: true,
        storesResponse: true,
        location: t("aiDataConsent.disclosure.applicationStorage"),
      },
      provider: facts.providerStorage,
    },
    retention: {
      application: {
        uploadMinutes: 0,
        sourceDays: 0,
        artifactDays: 0,
      },
      provider: facts.providerRetention,
    },
    trainingUse: facts.trainingUse,
  };
}

export function authorizeBrowserAiRequest(input: {
  provider?: string;
  ollamaEndpoint?: string | null;
  baseUrl?: string | null;
  hasApiKey?: boolean;
  browserAiMode?: BrowserAiMode;
}): Promise<void> {
  return requestAiDataConsent(
    createByokAiDataDisclosure(input.provider ?? "unknown", {
      ollamaEndpoint: input.ollamaEndpoint,
      baseUrl: input.baseUrl,
      hasApiKey: input.hasApiKey,
      browserAiMode: input.browserAiMode,
    }),
  );
}
