// @vitest-environment happy-dom

import type { ReactNode } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { WorkLayerProvider } from "./WorkLayerContext";
import { WorkLayerSurface } from "./WorkLayerSurface";
import { WorkPulse } from "./WorkPulse";
import { WORK_LAYER_FIXTURE } from "./workLayerFixture";

function renderPreview(model = WORK_LAYER_FIXTURE, extra: ReactNode = null) {
  return render(
    <WorkLayerProvider initialModel={model}>
      <WorkPulse />
      {extra}
      <main>
        <WorkLayerSurface />
      </main>
    </WorkLayerProvider>,
  );
}

async function openFirstLens() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Attention 2件" }));
  await user.click(
    screen.getByRole("button", { name: "『アリス』の参照先が曖昧を開く" }),
  );
  return user;
}

describe("Work Layer specification boundaries", () => {
  it("removes the resolved frame and leads to the next Attention review", async () => {
    renderPreview();
    const user = await openFirstLens();

    await user.click(
      screen.getByRole("button", {
        name: "アリス・レインへBindingをプレビュー",
      }),
    );

    const receipt = screen.getByRole("status", {
      name: "プレビュー判断の受領証",
    });
    expect(receipt.parentElement).not.toHaveClass("border");
    await user.click(
      within(receipt).getByRole("button", {
        name: /次: Chronicle『脱獄』のEvidenceが見つからない/,
      }),
    );
    expect(
      screen.getByRole("dialog", { name: "Change Review" }),
    ).toHaveTextContent("Chronicle『脱獄』のEvidenceが見つからない");
  });

  it("offers Context Portal only when the current preset lacks Codex", async () => {
    const { unmount } = renderPreview({
      ...WORK_LAYER_FIXTURE,
      codexPanelAvailable: true,
    });
    await openFirstLens();
    expect(
      screen.queryByRole("button", { name: "Context Portalを開く" }),
    ).not.toBeInTheDocument();
    unmount();

    renderPreview({
      ...WORK_LAYER_FIXTURE,
      codexPanelAvailable: false,
    });
    await openFirstLens();
    expect(
      screen.getByRole("button", { name: "Context Portalを開く" }),
    ).toBeInTheDocument();
  });

  it("exposes the selected Projection finding to assistive technology", async () => {
    renderPreview();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Attention 2件" }));
    await user.click(
      screen.getByRole("button", { name: "2件をResolve Projectionで開く" }),
    );

    const first = screen.getByRole("button", {
      name: "『アリス』の参照先が曖昧",
    });
    const second = screen.getByRole("button", {
      name: "Chronicle『脱獄』のEvidenceが見つからない",
    });
    expect(first).toHaveAttribute("aria-pressed", "true");
    expect(second).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.queryByRole("button", { name: "Change Reviewを開く" }),
    ).not.toBeInTheDocument();

    await user.click(second);
    expect(first).toHaveAttribute("aria-pressed", "false");
    expect(second).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: "Change Reviewを開く" }),
    ).toBeInTheDocument();
  });

  it("positions the arrival gutter at the visible anchor supplied by the preview", () => {
    renderPreview({
      ...WORK_LAYER_FIXTURE,
      attentionDelta: 1,
      attentionAnchorVisible: true,
      attentionAnchorPosition: { xPercent: 61, yPercent: 72, heightPx: 48 },
    });

    const gutter = screen.getByTestId("work-layer-arrival-gutter");
    expect(gutter).toHaveStyle({
      left: "61%",
      top: "72%",
      height: "48px",
    });
    expect(gutter).toHaveClass("fixed");
    expect(gutter.parentElement).toBe(document.body);
  });

  it("lets a foreign modal consume Escape and stops handled Work Layer Escape at document", async () => {
    const outerEscape = vi.fn();
    window.addEventListener("keydown", outerEscape);
    try {
      const foreignPreview = renderPreview(
        WORK_LAYER_FIXTURE,
        <section role="dialog" aria-modal="true" aria-label="Settings">
          <button type="button">Settings field</button>
        </section>,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Attention 2件" }));

      fireEvent.keyDown(
        screen.getByRole("button", { name: "Settings field" }),
        { key: "Escape" },
      );
      expect(outerEscape).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("dialog", { name: "Attentionの作業トレイ" }),
      ).toBeInTheDocument();

      foreignPreview.unmount();
      renderPreview();
      await user.click(screen.getByRole("button", { name: "Attention 2件" }));
      fireEvent.keyDown(screen.getByRole("button", { name: "閉じる" }), {
        key: "Escape",
      });
      expect(outerEscape).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByRole("dialog", { name: "Attentionの作業トレイ" }),
      ).not.toBeInTheDocument();
    } finally {
      window.removeEventListener("keydown", outerEscape);
    }
  });
});
