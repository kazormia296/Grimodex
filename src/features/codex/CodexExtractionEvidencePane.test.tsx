// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import i18n from "@/lib/i18n";
import { CodexExtractionEvidencePane } from "./CodexExtractionEvidencePane";

beforeEach(async () => {
  await i18n.changeLanguage("ja");
});

const quote = {
  anchorId: "anchor-1",
  quote: "その夜、彼は戻った。",
  documentRef: "scene:s1",
  sceneId: "s1",
  sceneTitle: "第一章",
  method: "exact" as const,
};

const proposal = {
  evidence: [quote],
  blockedReason: "根拠が未解決です。再抽出して根拠を確認してください",
  proposal: {
    payload: {
      binding: { kind: "bind-existing", entityRef: "K0001" },
      typeResolution: { status: "resolved", typeRef: "T0001" },
    },
  },
} as never;

describe("CodexExtractionEvidencePane", () => {
  it("uses catalog labels when available, falls back to refs, and localizes blocked reasons", async () => {
    const { rerender } = render(
      <CodexExtractionEvidencePane
        proposal={proposal}
        bindingLabels={{ entityName: "主人公", typeLabel: "人物" }}
      />,
    );
    expect(screen.getByText("既存 Entry（主人公）")).toBeInTheDocument();
    expect(screen.getByText("Type: 人物")).toBeInTheDocument();

    rerender(<CodexExtractionEvidencePane proposal={proposal} />);
    expect(screen.getByText("既存 Entry（K0001）")).toBeInTheDocument();
    expect(screen.getByText("Type: T0001")).toBeInTheDocument();
    expect(
      screen.getByText("根拠が未解決です。再抽出して根拠を確認してください"),
    ).toBeInTheDocument();
    await i18n.changeLanguage("en");
    expect(
      await screen.findByText(
        "Evidence is unresolved. Extract again to review the evidence.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps evidence static without a scene click target", () => {
    const { rerender } = render(
      <CodexExtractionEvidencePane
        proposal={{ evidence: [quote], blockedReason: undefined }}
      />,
    );
    expect(screen.getByTestId("codex-evidence-quote-anchor-1").tagName).toBe(
      "DIV",
    );

    rerender(
      <CodexExtractionEvidencePane
        proposal={{
          evidence: [{ ...quote, sceneId: undefined }],
          blockedReason: undefined,
        }}
        onEvidenceClick={() => undefined}
      />,
    );
    expect(screen.getByTestId("codex-evidence-quote-anchor-1").tagName).toBe(
      "DIV",
    );
  });
});
