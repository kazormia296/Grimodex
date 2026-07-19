import type { TFunction } from "i18next";
import i18next from "@/lib/i18n";
import { normalizeOllamaEndpoint } from "@/lib/browser-ai";
import type { AiDataDisclosureView } from "./AiDataConsentDialog";
import { requestAiDataConsent } from "./aiDataConsentBroker";

export const BROWSER_AI_DATA_POLICY_VERSION = "2026-07-20.2";

export type BrowserAiDisclosureLocale = "ja" | "en";
type BrowserAiDisclosureProvider = "openai" | "anthropic" | "ollama";

export interface BrowserAiDisclosureOptions {
  locale?: BrowserAiDisclosureLocale;
  ollamaEndpoint?: string | null;
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
  if (
    provider === "openai" ||
    provider === "anthropic" ||
    provider === "ollama"
  ) {
    return provider;
  }
  throw new Error(
    `Provider "${provider || "unknown"}" is not supported in browser mode`,
  );
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
  return {
    schemaVersion: "grimodex/ai-data-disclosure/1",
    policyVersion: BROWSER_AI_DATA_POLICY_VERSION,
    route: "byok",
    provider,
    destination: facts.destination,
    consentId: `consent_byok_${provider}_${destinationFingerprint(facts.destination)}_${BROWSER_AI_DATA_POLICY_VERSION.replace(/[^0-9a-z]/gi, "_")}_v2`,
    usagePolicy: {
      summary: t("aiDataConsent.disclosure.usageSummary"),
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
      ...(provider === "ollama"
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
}): Promise<void> {
  return requestAiDataConsent(
    createByokAiDataDisclosure(input.provider ?? "unknown", {
      ollamaEndpoint: input.ollamaEndpoint,
    }),
  );
}
