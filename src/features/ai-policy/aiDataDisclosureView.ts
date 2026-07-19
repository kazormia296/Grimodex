export interface AiDataDisclosureView {
  schemaVersion: "grimodex/ai-data-disclosure/1";
  policyVersion: string;
  route: "byok";
  provider: string;
  destination: string;
  consentId: string;
  usagePolicy: { summary: string; policyUrl: string };
  sentData: Array<{ category: string; description: string }>;
  processingDestinations: Array<{
    processor: string;
    purpose: string;
    location: string;
    privacyPolicyUrl: string;
  }>;
  storage: {
    application: {
      storesPrompt: boolean;
      storesResponse: boolean;
      location: string;
    };
    provider: { summary: string; policyUrl: string };
  };
  retention: {
    application: {
      uploadMinutes: number;
      sourceDays: number;
      artifactDays: number;
    };
    provider: { summary: string; policyUrl: string };
  };
  trainingUse: {
    status: "not-used" | "used" | "depends";
    summary: string;
    policyUrl: string;
  };
}
