import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiDataDisclosureV1 } from "@grimodex/scan-contract";
import { ScanAiConsentDialog } from "./ScanAiConsentDialog";

afterEach(cleanup);

const disclosure: AiDataDisclosureV1 = {
  schemaVersion: "grimodex/ai-data-disclosure/1",
  policyVersion: "2026-07-19.1",
  route: "scan",
  provider: "workers-ai",
  consentId: "consent_scan_workers_ai_2026_07_19_abcdef",
  usagePolicy: {
    summary: "The manuscript is processed only after explicit consent.",
    policyUrl: "https://example.com/policy",
  },
  sentData: [{ category: "source", description: "Uploaded manuscript text" }],
  processingDestinations: [
    {
      processor: "Cloudflare Workers AI",
      purpose: "Scan the manuscript",
      location: "Cloudflare managed infrastructure",
      privacyPolicyUrl: "https://example.com/privacy",
    },
  ],
  storage: {
    application: {
      storesPrompt: true,
      storesResponse: true,
      location:
        "Cloudflare R2 stores content and artifacts; Cloudflare D1 stores non-content operational metadata and token/request hashes.",
    },
    provider: {
      summary: "Provider handling follows the linked policy.",
      policyUrl: "https://example.com/provider",
    },
  },
  retention: {
    application: { uploadMinutes: 60, sourceDays: 1, artifactDays: 30 },
    provider: {
      summary: "Provider retains abuse-monitoring logs for up to 30 days.",
      policyUrl: "https://example.com/retention",
    },
  },
  trainingUse: {
    status: "not-used",
    summary: "Customer content is not used for model training.",
    policyUrl: "https://example.com/training",
  },
};

describe("ScanAiConsentDialog", () => {
  it("shows sent data, destination, storage, retention, and training before accepting", () => {
    render(
      <ScanAiConsentDialog
        disclosure={disclosure}
        onAccept={vi.fn()}
        onDecline={vi.fn()}
      />,
    );

    expect(screen.getByText("Uploaded manuscript text")).toBeTruthy();
    expect(screen.getByText(/Cloudflare Workers AI/)).toBeTruthy();
    expect(screen.getByText(/Cloudflare R2/)).toBeTruthy();
    expect(screen.getByText(/non-content operational metadata/i)).toBeTruthy();
    expect(screen.getByText(/原稿 1日/)).toBeTruthy();
    expect(
      screen.getByText(/abuse-monitoring logs for up to 30 days/i),
    ).toBeTruthy();
    expect(screen.getByText(/not used for model training/i)).toBeTruthy();
    expect(
      screen
        .getAllByRole("link", { name: "ポリシーを開く" })
        .some(
          (link) =>
            link.getAttribute("href") === "https://example.com/retention",
        ),
    ).toBe(true);
  });

  it("requires an explicit checkbox before returning the opaque consent id", () => {
    const onAccept = vi.fn();
    render(
      <ScanAiConsentDialog
        disclosure={disclosure}
        onAccept={onAccept}
        onDecline={vi.fn()}
      />,
    );

    const accept = screen.getByRole("button", { name: "同意してScanを開始" });
    expect((accept as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(
      screen.getByRole("checkbox", { name: /送信・保存・学習利用方針/ }),
    );
    fireEvent.click(accept);

    expect(onAccept).toHaveBeenCalledWith(disclosure.consentId);
  });
});
