// @vitest-environment happy-dom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { WorkLayerProvider, WorkLayerSurface, WorkPulse } from "./WorkLayer";
import type {
  WorkLayerLiveEntry,
  WorkLayerModel,
  WorkLayerPort,
} from "./types";
import { WORK_LAYER_FIXTURE } from "./workLayerFixture";

function liveModel(
  liveEntries: readonly WorkLayerLiveEntry[],
  extra: Partial<WorkLayerModel> = {},
): WorkLayerModel {
  return {
    scopeId: "example-work",
    liveEntries,
    focus: null,
    attention: [],
    disposedAttention: [],
    system: { state: "idle", label: "idle" },
    ...extra,
  };
}

function livePort(model: WorkLayerModel): WorkLayerPort {
  return {
    kind: "live",
    scopeKey: model.scopeId,
    load: vi.fn().mockResolvedValue(model),
  };
}

function renderLive(model: WorkLayerModel) {
  return render(
    <WorkLayerProvider port={livePort(model)}>
      <WorkPulse />
      <WorkLayerSurface />
    </WorkLayerProvider>,
  );
}

describe("Work Layer live provenance in the Pulse and Attention tray", () => {
  it("shows the sum of counted rows and omits preview-only marks", async () => {
    const user = userEvent.setup();
    renderLive(
      liveModel([
        { id: "codex-candidates", status: "ready", count: 2 },
        { id: "stale-proposals", status: "ready", count: 1 },
      ]),
    );

    await user.click(
      await screen.findByRole("button", { name: "Attention 3件" }),
    );
    const tray = screen.getByRole("dialog", { name: "Attentionの作業トレイ" });

    // The tray header and the body's lead both show the same total.
    expect(within(tray).getAllByText("ATTENTION")).toHaveLength(2);
    expect(within(tray).getAllByText("3")).toHaveLength(2);
    expect(within(tray).queryByText("UI PREVIEW")).not.toBeInTheDocument();
    expect(
      within(tray).queryByRole("button", { name: "作業を捕捉" }),
    ).not.toBeInTheDocument();
    expect(within(tray).queryByText("LATER")).not.toBeInTheDocument();
  });

  it("counts only the rows that are counted so far", async () => {
    renderLive(
      liveModel([
        { id: "codex-candidates", status: "not-counted", count: null },
        { id: "stale-proposals", status: "ready", count: 4 },
      ]),
    );

    expect(
      await screen.findByRole("button", { name: "Attention 4件" }),
    ).toBeInTheDocument();
  });

  it("never announces or highlights an arrival, even if the model carries one", async () => {
    renderLive(
      liveModel([{ id: "codex-candidates", status: "ready", count: 2 }], {
        attentionDelta: 2,
      }),
    );

    await screen.findByRole("button", { name: "Attention 2件" });
    expect(screen.getByTestId("work-pulse-live-region")).toBeEmptyDOMElement();
    expect(
      screen.queryByTestId("work-layer-arrival-charge"),
    ).not.toBeInTheDocument();
  });

  it("keeps the preview marks in a preview model", async () => {
    const user = userEvent.setup();
    render(
      <WorkLayerProvider initialModel={WORK_LAYER_FIXTURE}>
        <WorkPulse />
        <WorkLayerSurface />
      </WorkLayerProvider>,
    );

    await user.click(screen.getByRole("button", { name: /^Attention/ }));
    const tray = screen.getByRole("dialog", { name: "Attentionの作業トレイ" });

    expect(within(tray).getByText("UI PREVIEW")).toBeInTheDocument();
    expect(
      within(tray).getByRole("button", { name: "作業を捕捉" }),
    ).toBeInTheDocument();
    expect(within(tray).getByText("LATER")).toBeInTheDocument();
  });
});
