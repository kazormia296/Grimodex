import type { AiDataDisclosureView } from "./AiDataConsentDialog";
import { requestAiDataConsent } from "./aiDataConsentBroker";

export const BROWSER_AI_DATA_POLICY_VERSION = "2026-07-19.2";
const GRIMODEX_PRIVACY_URL =
  "https://github.com/kazormia296/Grimodex/blob/master/public/PRIVACY_ja.md";

type ProviderFacts = Pick<
  AiDataDisclosureView,
  "processingDestinations" | "trainingUse"
> & {
  providerRetention: AiDataDisclosureView["retention"]["provider"];
  providerStorage: AiDataDisclosureView["storage"]["provider"];
};

const PROVIDER_FACTS: Record<string, ProviderFacts> = {
  openai: {
    processingDestinations: [
      {
        processor: "OpenAI API",
        purpose: "選択したAI支援を生成するため",
        location: "OpenAI が管理するインフラストラクチャ",
        privacyPolicyUrl:
          "https://openai.com/policies/how-your-data-is-used-to-improve-model-performance/",
      },
    ],
    providerStorage: {
      summary:
        "OpenAI API側では、既定で不正利用監視ログが最大30日保持されます。対象組織は保持期間変更やZero Data Retentionを申請できます。",
      policyUrl:
        "https://platform.openai.com/docs/models/default-usage-policies-by-endpoint",
    },
    providerRetention: {
      summary:
        "既定の不正利用監視ログは最大30日です。契約・設定・法的例外により異なる場合があります。",
      policyUrl:
        "https://platform.openai.com/docs/models/default-usage-policies-by-endpoint",
    },
    trainingUse: {
      status: "not-used",
      summary:
        "OpenAI APIの入出力は、組織が明示的にオプトインしない限りモデル学習に使用されません。",
      policyUrl:
        "https://openai.com/policies/how-your-data-is-used-to-improve-model-performance/",
    },
  },
  anthropic: {
    processingDestinations: [
      {
        processor: "Anthropic API",
        purpose: "選択したAI支援を生成するため",
        location: "Anthropic が管理するインフラストラクチャ",
        privacyPolicyUrl:
          "https://privacy.anthropic.com/en/articles/7996868-is-my-data-used-for-model-training",
      },
    ],
    providerStorage: {
      summary:
        "Anthropic APIの入出力は通常30日以内に削除されますが、契約・安全対策・法的義務による例外があります。",
      policyUrl:
        "https://privacy.anthropic.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data",
    },
    providerRetention: {
      summary:
        "通常は30日以内に削除されます。Zero Data Retention契約や安全・法的例外では条件が異なります。",
      policyUrl:
        "https://privacy.anthropic.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data",
    },
    trainingUse: {
      status: "not-used",
      summary:
        "Anthropicの商用/APIデータは、明示的なオプトインやフィードバック提供を除きモデル学習に使用されません。",
      policyUrl:
        "https://privacy.anthropic.com/en/articles/7996868-is-my-data-used-for-model-training",
    },
  },
  openrouter: {
    processingDestinations: [
      {
        processor: "OpenRouter と選択された上流モデル提供者",
        purpose: "AIリクエストのルーティングと生成",
        location: "OpenRouterおよび上流提供者が管理するインフラストラクチャ",
        privacyPolicyUrl:
          "https://openrouter.ai/docs/guides/privacy/data-collection",
      },
    ],
    providerStorage: {
      summary:
        "OpenRouterのプライバシー設定と、実際に選ばれた上流提供者の保持方針が適用されます。ZDRルーティングも選択できます。",
      policyUrl: "https://openrouter.ai/docs/guides/privacy/data-collection",
    },
    providerRetention: {
      summary:
        "保持期間はOpenRouterの設定と上流提供者に依存します。必要に応じてZero Data Retentionルーティングを有効化してください。",
      policyUrl: "https://openrouter.ai/docs/guides/features/zdr",
    },
    trainingUse: {
      status: "depends",
      summary:
        "学習への利用は選択された上流提供者とOpenRouterのデータポリシー設定に依存します。",
      policyUrl: "https://openrouter.ai/docs/guides/privacy/data-collection",
    },
  },
  ollama: {
    processingDestinations: [
      {
        processor: "設定されたOllamaサーバー",
        purpose: "選択したAI支援をローカルまたは指定先で生成するため",
        location: "設定されたOllamaエンドポイント",
        privacyPolicyUrl: "https://ollama.com/privacy",
      },
    ],
    providerStorage: {
      summary:
        "保存の有無は、ユーザーが管理するOllamaサーバーと接続先モデルの設定に依存します。Grimodexは追加のサーバー保存を行いません。",
      policyUrl: "https://ollama.com/privacy",
    },
    providerRetention: {
      summary: "保持期間は設定されたOllamaサーバーの運用方針に依存します。",
      policyUrl: "https://ollama.com/privacy",
    },
    trainingUse: {
      status: "depends",
      summary:
        "学習への利用は、設定されたOllamaサーバーとモデルの運用方針に依存します。",
      policyUrl: "https://ollama.com/privacy",
    },
  },
};

function genericFacts(provider: string): ProviderFacts {
  return {
    processingDestinations: [
      {
        processor: `設定された ${provider} エンドポイント`,
        purpose: "選択したAI支援を生成するため",
        location: "設定された接続先が管理するインフラストラクチャ",
        privacyPolicyUrl: GRIMODEX_PRIVACY_URL,
      },
    ],
    providerStorage: {
      summary:
        "保存の有無は設定された接続先の契約と運用方針に依存します。接続先のポリシーを確認してください。",
      policyUrl: GRIMODEX_PRIVACY_URL,
    },
    providerRetention: {
      summary: "保持期間は設定された接続先の契約と運用方針に依存します。",
      policyUrl: GRIMODEX_PRIVACY_URL,
    },
    trainingUse: {
      status: "depends",
      summary:
        "学習への利用は設定された接続先のポリシーに依存します。Grimodexからは判定できません。",
      policyUrl: GRIMODEX_PRIVACY_URL,
    },
  };
}

export function createByokAiDataDisclosure(
  provider: string,
): AiDataDisclosureView {
  const normalizedProvider = provider.trim().toLowerCase() || "unknown";
  const facts = PROVIDER_FACTS[normalizedProvider] ?? genericFacts(provider);
  return {
    schemaVersion: "grimodex/ai-data-disclosure/1",
    policyVersion: BROWSER_AI_DATA_POLICY_VERSION,
    route: "byok",
    provider: normalizedProvider,
    consentId: `consent_byok_${normalizedProvider.replace(/[^a-z0-9_-]/g, "_")}_${BROWSER_AI_DATA_POLICY_VERSION.replace(/[^0-9a-z]/gi, "_")}_v1`,
    usagePolicy: {
      summary:
        "入力した指示・選択された本文や文脈・認証情報を、選択中のAI提供者へ直接送信します。送信前に内容を確認してください。",
      policyUrl: GRIMODEX_PRIVACY_URL,
    },
    sentData: [
      {
        category: "prompt",
        description: "入力した指示、会話履歴、システム指示",
      },
      {
        category: "selected-context",
        description:
          "リクエストのために選択された本文、シーン、Codex、プロジェクト設定などの文脈",
      },
      {
        category: "credential",
        description:
          "提供者が必要とするAPIキー（認証ヘッダーで送信し、このブラウザセッションのメモリにだけ保持）",
      },
    ],
    processingDestinations: facts.processingDestinations,
    storage: {
      application: {
        storesPrompt: true,
        storesResponse: true,
        location: "このブラウザのローカルワークスペース（IndexedDB）",
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
}): Promise<void> {
  return requestAiDataConsent(
    createByokAiDataDisclosure(input.provider ?? "unknown"),
  );
}
