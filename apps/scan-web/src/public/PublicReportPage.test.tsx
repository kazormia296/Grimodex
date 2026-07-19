// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PublicReportV1 } from "@grimodex/scan-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicReportPage } from "./PublicReportPage";

const report: PublicReportV1 = {
  schemaVersion: "grimodex-scan/public-report/1",
  title: "公開用レポート",
  language: "ja",
  source: { sectionCount: 3, paragraphCount: 12, characterCount: 4800 },
  summary: { genreCandidates: ["ミステリー"], themes: ["記憶"] },
  entities: [
    {
      id: "public:entity:0001",
      type: "character",
      name: "旅人",
      aliases: [],
    },
  ],
  relations: [],
  phases: [{ id: "public:phase:0001", title: "Phase 1" }],
  events: [{ id: "public:event:0001", title: "Event 1", order: 1 }],
  findings: [
    {
      id: "public:finding:0001",
      kind: "continuity",
      title: "Finding 1",
      summary: "Details are available in the private report.",
    },
  ],
  publication: {
    authorConfirmedAt: "2026-07-19T00:00:00.000Z",
    evidenceOmitted: true,
    privateProvenanceOmitted: true,
  },
};

afterEach(cleanup);

describe("PublicReportPage", () => {
  it("renders only the redacted public projection and exposes a localized abuse route", async () => {
    const api = {
      getPublicReport: vi.fn(async () => report),
      reportPublicAbuse: vi.fn(async () => undefined),
    };

    render(
      <PublicReportPage publicReportId="public-1" locale="ja" api={api} />,
    );

    expect(
      await screen.findByRole("heading", { name: "公開用レポート" }),
    ).toBeTruthy();
    expect(screen.getByText(/原稿本文・根拠・非公開メタデータ.*表示されません/u)).toBeTruthy();
    expect(screen.getByText(/短い派生ラベル.*原稿由来/u)).toBeTruthy();
    expect(screen.queryByText(/evidence excerpt/i)).toBeNull();
    expect(screen.getByText("旅人")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Cloudflareへ正式に報告" })
        .getAttribute("href"),
    ).toBe("https://abuse.cloudflare.com/");

    fireEvent.change(screen.getByRole("textbox", { name: "通報理由" }), {
      target: { value: "権利侵害の可能性があります" },
    });
    fireEvent.click(screen.getByRole("button", { name: "通報を送信" }));

    await waitFor(() =>
      expect(api.reportPublicAbuse).toHaveBeenCalledWith(
        "public-1",
        "権利侵害の可能性があります",
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "通報を受け付けました",
    );
  });

  it("localizes the public disclosure and abuse form in English", async () => {
    const api = {
      getPublicReport: vi.fn(async () => ({ ...report, title: "Public report" })),
      reportPublicAbuse: vi.fn(async () => undefined),
    };

    render(
      <PublicReportPage publicReportId="public-1" locale="en" api={api} />,
    );

    expect(
      await screen.findByRole("heading", { name: "Public report" }),
    ).toBeTruthy();
    expect(screen.getByText(/manuscript text, evidence, and private metadata.*not shown/i)).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Report this public report" }),
    ).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Reason for report" })).toBeTruthy();
  });
});
