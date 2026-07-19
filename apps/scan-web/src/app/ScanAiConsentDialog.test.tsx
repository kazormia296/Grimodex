import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_CONTENT_POLICY_ACK_HEADER,
  CLOUD_CONTENT_POLICY_VERSION,
  type AiDataDisclosureV1,
} from "@grimodex/scan-contract";
import { ScanAiConsentDialog } from "./ScanAiConsentDialog";

afterEach(cleanup);

const disclosure: AiDataDisclosureV1 = {
  schemaVersion: "grimodex/ai-data-disclosure/1",
  policyVersion: "2026-07-19.1",
  contentPolicy: {
    version: CLOUD_CONTENT_POLICY_VERSION,
    acknowledgementHeader: CLOUD_CONTENT_POLICY_ACK_HEADER,
  },
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
        locale="ja"
        onAccept={vi.fn()}
        onDecline={vi.fn()}
      />,
    );

    expect(screen.getByText("Uploaded manuscript text")).toBeTruthy();
    expect(
      screen.getByText("Cloudflare Workers AI", { selector: "strong" }),
    ).toBeTruthy();
    expect(screen.getByText(/Cloudflare R2/)).toBeTruthy();
    expect(screen.getByText(/non-content operational metadata/i)).toBeTruthy();
    expect(screen.getByText(/原稿 1日/)).toBeTruthy();
    expect(
      screen.getByText(/abuse-monitoring logs for up to 30 days/i),
    ).toBeTruthy();
    expect(screen.getByText(/not used for model training/i)).toBeTruthy();
    expect(
      screen.getByRole("heading", {
        name: "クラウド利用時の原稿内容と権利",
      }),
    ).toBeTruthy();
    expect(screen.getByText(/成人向け・R18.*一律.*禁止/u)).toBeTruthy();
    expect(screen.getByText(/AI.*拒否/u)).toBeTruthy();
    expect(screen.getByText(/権利.*許諾.*二次創作/u)).toBeTruthy();
    expect(screen.getByText(/児童.*未成年/u)).toBeTruthy();
    expect(screen.getByText(/人身取引/u)).toBeTruthy();
    expect(screen.getByText(/著作権/u)).toBeTruthy();
    expect(screen.getByText(/個人情報/u)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Grimodex プライバシー通知" })
        .getAttribute("href"),
    ).toBe("https://example.com/policy");
    expect(
      screen
        .getByRole("link", {
          name: "Cloudflare Workers AI のデータ利用ポリシー",
        })
        .getAttribute("href"),
    ).toBe("https://example.com/privacy");
    expect(
      screen
        .getByRole("link", {
          name: "Cloudflare ホスティング／Abuse方針",
        })
        .getAttribute("href"),
    ).toBe(
      "https://blog.cloudflare.com/cloudflares-abuse-policies-and-approach/",
    );
  });

  it("renders the complete dialog chrome and named policy links in English", () => {
    render(
      <ScanAiConsentDialog
        disclosure={disclosure}
        locale="en"
        onAccept={vi.fn()}
        onDecline={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Review before uploading" }),
    ).toBeTruthy();
    expect(screen.getByText("Data sent for processing")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Grimodex Privacy Notice" })
        .getAttribute("href"),
    ).toBe("https://example.com/policy");
    expect(
      screen
        .getByRole("link", {
          name: "Cloudflare Workers AI data usage policy",
        })
        .getAttribute("href"),
    ).toBe("https://example.com/privacy");
    expect(
      screen.getByRole("heading", {
        name: "Manuscript content and rights for cloud use",
      }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /adult-only fictional works.*R18.*not categorically prohibited/i,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/AI provider may refuse/i)).toBeTruthy();
    expect(
      screen.getByText(/rights or permission.*derivative-work guidelines/i),
    ).toBeTruthy();
  });

  it("requires separate data and content-rights confirmations before returning the opaque consent id", () => {
    const onAccept = vi.fn();
    render(
      <ScanAiConsentDialog
        disclosure={disclosure}
        locale="ja"
        onAccept={onAccept}
        onDecline={vi.fn()}
      />,
    );

    const accept = screen.getByRole("button", { name: "同意してScanを開始" });
    expect((accept as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(
      screen.getByRole("checkbox", { name: /送信・保存・学習利用方針/ }),
    );
    expect((accept as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(accept);
    expect(onAccept).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: /必要な権利・許諾/ }));
    expect((accept as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(accept);

    expect(onAccept).toHaveBeenCalledWith(disclosure.consentId);
  });
});
