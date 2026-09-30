// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkLayerProvider } from "./WorkLayerContext";
import { WorkLayerSurfaceHost } from "./WorkLayerSurfaceHost";
import { WORK_LAYER_FIXTURE } from "./workLayerFixture";

const { surfaceModuleLoaded } = vi.hoisted(() => ({
  surfaceModuleLoaded: vi.fn(),
}));

vi.mock("./WorkLayerSurface", () => {
  surfaceModuleLoaded();
  return {
    WorkLayerSurface: () => <div data-testid="lazy-work-layer-surface" />,
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkLayerSurfaceHost", () => {
  it("imports the review surface only after a Work Layer context becomes active", async () => {
    const view = render(
      <WorkLayerProvider active={false} initialModel={WORK_LAYER_FIXTURE}>
        <WorkLayerSurfaceHost />
      </WorkLayerProvider>,
    );

    expect(surfaceModuleLoaded).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId("lazy-work-layer-surface"),
    ).not.toBeInTheDocument();

    view.rerender(
      <WorkLayerProvider active initialModel={WORK_LAYER_FIXTURE}>
        <WorkLayerSurfaceHost />
      </WorkLayerProvider>,
    );

    await waitFor(() => {
      expect(surfaceModuleLoaded).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("lazy-work-layer-surface")).toBeInTheDocument();
    });
  });
});
