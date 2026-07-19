export const CLOUD_CONTENT_POLICY_VERSION = "2026-07-19.7" as const;
export const CLOUD_CONTENT_POLICY_ACK_HEADER =
  "x-grimodex-content-policy-version" as const;

export const CLOUDFLARE_ABUSE_POLICY_URL =
  "https://blog.cloudflare.com/cloudflares-abuse-policies-and-approach/";
export const CLOUDFLARE_WORKERS_AI_DATA_POLICY_URL =
  "https://developers.cloudflare.com/workers-ai/platform/data-usage/";
export const CLOUDFLARE_ABUSE_REPORT_URL = "https://abuse.cloudflare.com/";

export type CloudContentPolicyLocale = "ja" | "en";

export interface CloudContentPolicyCopy {
  heading: string;
  adultContentNotice: string;
  aiRefusalNotice: string;
  rightsNotice: string;
  prohibitedHeading: string;
  prohibitedItems: readonly [string, string, string, string];
  confirmation: string;
  bannerNotice: string;
  hostingPolicyLabel: string;
  workersAiPolicyLabel: string;
}

const JAPANESE_POLICY: CloudContentPolicyCopy = {
  heading: "クラウド利用時の原稿内容と権利",
  adultContentNotice:
    "成人のみを扱う合法な架空の成人向け・R18作品を一律に禁止するものではありません。ただし、保存・解析・AI応答を保証しません。Grimodex、CloudflareまたはAIプロバイダの最新ポリシーにより、処理の拒否、対象データの削除またはアクセス停止が行われる場合があります。",
  aiRefusalNotice:
    "保存可能な原稿でも、AIが安全ポリシーにより解析や応答を拒否する場合があります。",
  rightsNotice:
    "アップロードまたは送信する原稿について必要な権利または許諾を有し、二次創作では原作品の権利者が定めるガイドラインを遵守してください。",
  prohibitedHeading: "クラウドへ送信できない内容",
  prohibitedItems: [
    "児童・未成年者の性的描写、性的搾取・虐待、またはそれらを促進する内容",
    "違法な売春・性的サービスまたは人身取引を仲介・促進する内容",
    "著作権、商標権、肖像権、プライバシー権その他の権利を侵害する内容",
    "個人情報の暴露、詐欺、脅迫、その他の違法・有害な内容",
  ],
  confirmation:
    "必要な権利・許諾があり、原作品の権利者が定めるガイドラインを含む適用ルールを守り、上記の禁止内容を含まないことを確認します。",
  bannerNotice:
    "必要な権利・許諾のある内容だけをクラウドへ送信してください。合法な成人向け・R18作品を一律禁止しませんが、AIが処理を拒否する場合があります。",
  hostingPolicyLabel: "Cloudflare ホスティング／Abuse方針",
  workersAiPolicyLabel: "Cloudflare Workers AI データ利用方針",
};

const ENGLISH_POLICY: CloudContentPolicyCopy = {
  heading: "Manuscript content and rights for cloud use",
  adultContentNotice:
    "Lawful adult-only fictional works, including R18 works, are not categorically prohibited. This does not guarantee storage, analysis, or an AI response: Grimodex, Cloudflare, or an AI provider may refuse processing, remove affected data, or restrict access under its current policies.",
  aiRefusalNotice:
    "An AI provider may refuse to analyze or answer even when the manuscript itself may be stored.",
  rightsNotice:
    "You must have the rights or permission needed for anything you upload or send and follow the original rightsholder’s derivative-work guidelines where applicable.",
  prohibitedHeading: "Content that must not be sent to the cloud",
  prohibitedItems: [
    "sexual depictions or sexual exploitation or abuse of children or minors, or content that facilitates them",
    "content that facilitates illegal prostitution, sexual services, or human trafficking",
    "content that infringes copyright, trademark, publicity, privacy, or other rights",
    "doxxing or unauthorized disclosure of personal data, fraud, threats, or other unlawful or harmful content",
  ],
  confirmation:
    "I confirm that I have the required rights or permission, comply with all applicable rightsholder rules, and that the content does not fall within the prohibited categories above.",
  bannerNotice:
    "Send only content for which you have the required rights or permission. Lawful adult-only and R18 works are not categorically prohibited, but AI may refuse processing.",
  hostingPolicyLabel: "Cloudflare hosting and abuse policy",
  workersAiPolicyLabel: "Cloudflare Workers AI model data policy",
};

export function cloudContentPolicy(
  locale: CloudContentPolicyLocale,
): CloudContentPolicyCopy {
  return locale === "ja" ? JAPANESE_POLICY : ENGLISH_POLICY;
}
