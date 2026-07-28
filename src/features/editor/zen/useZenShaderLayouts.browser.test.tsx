import { render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";
import { useZenShaderLayouts } from "./useZenShaderLayouts";

function LayoutProbe({ zen = false }: { zen?: boolean }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const layouts = useZenShaderLayouts(surfaceRef);

  return (
    <div
      ref={surfaceRef}
      data-testid="shader-layout"
      data-contrast-rect={layouts.contrast.rect.join(" ")}
      data-glass-rect={layouts.glass.rect.join(" ")}
      data-glass-corner-radius={layouts.glass.cornerRadius}
      style={{
        position: "relative",
        width: 1_000,
        height: 600,
      }}
    >
      <section
        data-editor-area
        style={{
          position: "absolute",
          left: zen ? 0 : 100,
          top: zen ? 0 : 60,
          width: zen ? 1_000 : 800,
          height: zen ? 600 : 480,
          borderRadius: zen ? 0 : 18,
        }}
      >
        <article
          className="zen-editor-paper"
          style={{
            position: "absolute",
            left: zen ? 200 : 200,
            top: zen ? 40 : 100,
            width: zen ? 600 : 400,
            height: zen ? 520 : 240,
          }}
        />
      </section>
    </div>
  );
}

function EmptyLayoutProbe() {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const layouts = useZenShaderLayouts(surfaceRef);

  return (
    <div
      ref={surfaceRef}
      data-testid="empty-shader-layout"
      data-glass-rect={layouts.glass.rect.join(" ")}
      data-glass-corner-radius={layouts.glass.cornerRadius}
      style={{ width: 1_000, height: 600 }}
    />
  );
}

function SplitLayoutProbe({ direction }: { direction: "right" | "below" }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const layouts = useZenShaderLayouts(surfaceRef);
  const splitRight = direction === "right";

  return (
    <div
      ref={surfaceRef}
      data-testid={`split-${direction}-shader-layout`}
      data-contrast-rect={layouts.contrast.rect.join(" ")}
      style={{ position: "relative", width: 1_000, height: 600 }}
    >
      <section
        data-editor-area
        style={{
          position: "absolute",
          inset: 0,
          width: 1_000,
          height: 600,
        }}
      >
        {(["primary", "secondary"] as const).map((pane, index) => (
          <div
            key={pane}
            className="glass-editor-body"
            data-split-pane={pane}
            style={{
              position: "absolute",
              left: splitRight ? index * 500 : 0,
              top: splitRight ? 0 : index * 300,
              width: splitRight ? 500 : 1_000,
              height: splitRight ? 600 : 300,
              overflow: "auto",
            }}
          >
            <article
              className="zen-editor-paper"
              style={{
                position: "absolute",
                left: splitRight ? "20%" : 200,
                top: splitRight ? 100 : 50,
                width: splitRight ? 300 : 600,
                height: splitRight ? 400 : 200,
              }}
            />
          </div>
        ))}
      </section>
    </div>
  );
}

function OverflowingPaperProbe({
  writingMode,
}: {
  writingMode: "horizontal" | "vertical";
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const layouts = useZenShaderLayouts(surfaceRef);
  const vertical = writingMode === "vertical";

  return (
    <div
      ref={surfaceRef}
      data-testid={`${writingMode}-overflow-shader-layout`}
      data-contrast-rect={layouts.contrast.rect.join(" ")}
      data-contrast-feather={layouts.contrast.feather.join(" ")}
      style={{ position: "relative", width: 1_000, height: 600 }}
    >
      <section
        data-editor-area
        style={{ position: "absolute", inset: 0, width: 1_000, height: 600 }}
      >
        <div
          className="glass-editor-body"
          data-overflow-scrollport={writingMode}
          style={{
            position: "absolute",
            left: 100,
            top: 100,
            width: 800,
            height: 400,
            overflow: "auto",
          }}
        >
          <article
            className="zen-editor-paper"
            style={{
              position: "absolute",
              left: vertical ? 0 : 200,
              top: vertical ? 50 : 0,
              width: vertical ? 1_200 : 400,
              height: vertical ? 300 : 900,
              writingMode: vertical ? "vertical-rl" : "horizontal-tb",
            }}
          />
        </div>
      </section>
    </div>
  );
}

function WorkspaceSurfaceProbe({ glass = true }: { glass?: boolean }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const layouts = useZenShaderLayouts(surfaceRef);

  return (
    <div
      ref={surfaceRef}
      data-testid="workspace-surface-layout"
      data-contrast-rect={layouts.contrast.rect.join(" ")}
      data-ui-surface-rects={JSON.stringify(
        layouts.uiSurfaces.map((surface) => surface.rect),
      )}
      style={{ position: "relative", width: 1_000, height: 600 }}
    >
      <div
        data-workspace-glass-root
        data-layout-shell
        data-workspace-fluid-glass={glass ? "true" : "false"}
        style={{ position: "absolute", inset: 0 }}
      >
        <aside
          data-ambient-glass-surface="panel"
          style={{
            position: "absolute",
            left: 0,
            top: 100,
            width: 200,
            height: 300,
            borderRadius: 18,
          }}
        />
        <nav
          data-ambient-glass-surface="stripe"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: 1_000,
            height: 40,
            borderRadius: 18,
          }}
        />
        <aside
          data-ambient-glass-surface="panel"
          aria-hidden="true"
          style={{
            position: "absolute",
            visibility: "hidden",
            left: 800,
            top: 100,
            width: 200,
            height: 300,
          }}
        />
        <section
          data-editor-area
          style={{
            position: "absolute",
            left: 300,
            top: 60,
            width: 400,
            height: 480,
          }}
        >
          <article
            className="zen-editor-paper"
            style={{
              position: "absolute",
              left: 100,
              top: 100,
              width: 200,
              height: 240,
            }}
          />
        </section>
      </div>
    </div>
  );
}

function TransientWorkspaceSurfaceProbe({
  visible,
  ancestorVisible = true,
}: {
  visible: boolean;
  ancestorVisible?: boolean;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const layouts = useZenShaderLayouts(surfaceRef);

  return (
    <div
      ref={surfaceRef}
      data-testid="transient-workspace-surface-layout"
      data-ui-surface-rects={JSON.stringify(
        layouts.uiSurfaces.map((surface) => surface.rect),
      )}
      style={{ position: "relative", width: 1_000, height: 600 }}
    >
      <div
        data-workspace-glass-root
        data-workspace-fluid-glass="true"
        style={{ position: "absolute", inset: 0 }}
      >
        <div
          data-transient-surface-ancestor
          style={{
            position: "absolute",
            inset: 0,
            opacity: ancestorVisible ? 1 : 0,
          }}
        >
          <div
            data-ambient-glass-surface="stripe"
            style={{
              position: "absolute",
              opacity: visible ? 1 : 0,
              left: 100,
              top: 40,
              width: 800,
              height: 40,
            }}
          />
        </div>
      </div>
    </div>
  );
}

function PositionOnlySettlementProbe({
  phase,
}: {
  phase: "baseline" | "transient" | "settled";
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const layouts = useZenShaderLayouts(surfaceRef);

  return (
    <div
      ref={surfaceRef}
      data-testid="position-only-settlement-layout"
      data-ui-surface-rects={JSON.stringify(
        layouts.uiSurfaces.map((surface) => surface.rect),
      )}
      style={{ position: "relative", width: 1_000, height: 600 }}
    >
      <div
        className={phase === "baseline" ? undefined : "closing"}
        data-workspace-glass-root
        data-workspace-fluid-glass="true"
        style={{ position: "absolute", inset: 0 }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            width: 1_000,
            height: 600,
          }}
        >
          {phase === "transient" && (
            <div
              data-position-only-exit
              style={{
                width: 1_000,
                height: 180,
                flexShrink: 0,
              }}
            />
          )}
          <div
            data-position-only-spacer
            style={{
              width: 1_000,
              height: 520,
              flexShrink: 0,
            }}
          />
          <nav
            data-ambient-glass-surface="stripe"
            style={{
              width: 1_000,
              height: 40,
              flexShrink: 0,
              borderRadius: 16,
            }}
          />
        </div>
      </div>
    </div>
  );
}

const parseRect = (value: string | null) => value?.split(" ").map(Number) ?? [];

const parseNumber = (value: string | null) => Number(value);

const parseRects = (value: string | null): number[][] =>
  value ? (JSON.parse(value) as number[][]) : [];

function expectRects(actual: number[][], expected: number[][]) {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((rect, rectIndex) => {
    expect(actual[rectIndex]).toHaveLength(rect.length);
    rect.forEach((coordinate, coordinateIndex) => {
      expect(actual[rectIndex][coordinateIndex]).toBeCloseTo(coordinate);
    });
  });
}

function expectRect(value: string | null, expected: number[]) {
  const actual = parseRect(value);
  expect(actual).toHaveLength(expected.length);
  expected.forEach((coordinate, index) => {
    expect(actual[index]).toBeCloseTo(coordinate);
  });
}

describe("Zen shader geometry (real Chromium)", () => {
  it("keeps the glass layout empty while the Editor is not mounted", async () => {
    const view = render(<EmptyLayoutProbe />);
    const probe = view.getByTestId("empty-shader-layout");

    await waitFor(() => {
      expectRect(probe.getAttribute("data-glass-rect"), [0, 0, 0, 0]);
      expect(parseNumber(probe.getAttribute("data-glass-corner-radius"))).toBe(
        0,
      );
    });
  });

  it("refracts the complete Editor while contrast protection follows only the paper", async () => {
    const view = render(<LayoutProbe />);
    const probe = view.getByTestId("shader-layout");

    await waitFor(() => {
      expectRect(probe.getAttribute("data-glass-rect"), [0.1, 0.1, 0.9, 0.9]);
      expect(parseNumber(probe.getAttribute("data-glass-corner-radius"))).toBe(
        18,
      );
    });
    expectRect(probe.getAttribute("data-contrast-rect"), [
      0.3,
      1 / 3,
      0.7,
      11 / 15,
    ]);

    view.rerender(<LayoutProbe zen />);

    await waitFor(() => {
      expectRect(probe.getAttribute("data-glass-rect"), [0, 0, 1, 1]);
      expect(parseNumber(probe.getAttribute("data-glass-corner-radius"))).toBe(
        0,
      );
    });
    expectRect(probe.getAttribute("data-contrast-rect"), [
      0.2,
      1 / 15,
      0.8,
      14 / 15,
    ]);
  });
});

describe("Zen shader split-editor geometry (real Chromium)", () => {
  it("protects both writing columns in a left/right split", async () => {
    const view = render(<SplitLayoutProbe direction="right" />);
    const probe = view.getByTestId("split-right-shader-layout");

    await waitFor(() => {
      expectRect(probe.getAttribute("data-contrast-rect"), [
        0.1,
        1 / 6,
        0.9,
        5 / 6,
      ]);
    });
  });

  it("protects both writing columns in a top/bottom split", async () => {
    const view = render(<SplitLayoutProbe direction="below" />);
    const probe = view.getByTestId("split-below-shader-layout");

    await waitFor(() => {
      expectRect(probe.getAttribute("data-contrast-rect"), [
        0.2,
        1 / 12,
        0.8,
        11 / 12,
      ]);
    });
  });

  it("remeasures when the secondary editor scrolls", async () => {
    const view = render(<SplitLayoutProbe direction="below" />);
    const probe = view.getByTestId("split-below-shader-layout");

    await waitFor(() => {
      expectRect(probe.getAttribute("data-contrast-rect"), [
        0.2,
        1 / 12,
        0.8,
        11 / 12,
      ]);
    });

    const secondaryBody = view.container.querySelector<HTMLElement>(
      '[data-split-pane="secondary"]',
    );
    const secondaryPaper =
      secondaryBody?.querySelector<HTMLElement>(".zen-editor-paper");
    if (!secondaryBody || !secondaryPaper) {
      throw new Error("secondary editor was not rendered");
    }
    secondaryPaper.style.transform = "translateY(-100px)";
    secondaryBody.dispatchEvent(new Event("scroll"));

    await waitFor(() => {
      expectRect(probe.getAttribute("data-contrast-rect"), [
        0.2,
        0.25,
        0.8,
        11 / 12,
      ]);
    });
  });

  it("observes secondary paper and scroll-container resizes", async () => {
    const view = render(<SplitLayoutProbe direction="right" />);
    const probe = view.getByTestId("split-right-shader-layout");
    const secondaryBody = view.container.querySelector<HTMLElement>(
      '[data-split-pane="secondary"]',
    );
    const secondaryPaper =
      secondaryBody?.querySelector<HTMLElement>(".zen-editor-paper");
    if (!secondaryBody || !secondaryPaper) {
      throw new Error("secondary editor was not rendered");
    }

    secondaryPaper.style.width = "350px";
    await waitFor(() => {
      expectRect(probe.getAttribute("data-contrast-rect"), [
        0.1,
        1 / 6,
        0.95,
        5 / 6,
      ]);
    });

    secondaryBody.style.width = "400px";
    await waitFor(() => {
      expectRect(probe.getAttribute("data-contrast-rect"), [
        0.1,
        1 / 6,
        0.9,
        5 / 6,
      ]);
    });
  });
});

describe("Zen shader scrollport clipping (real Chromium)", () => {
  it("clips horizontal writing protection before and after vertical scrolling", async () => {
    const view = render(<OverflowingPaperProbe writingMode="horizontal" />);
    const probe = view.getByTestId("horizontal-overflow-shader-layout");

    await waitFor(() => {
      expectRect(probe.getAttribute("data-contrast-rect"), [
        0.3,
        1 / 6,
        0.7,
        5 / 6,
      ]);
    });
    expectRect(
      probe.getAttribute("data-contrast-feather"),
      [0.048, 0, 0.048, 0],
    );

    const scrollport = view.container.querySelector<HTMLElement>(
      '[data-overflow-scrollport="horizontal"]',
    );
    const paper = scrollport?.querySelector<HTMLElement>(".zen-editor-paper");
    if (!scrollport || !paper) {
      throw new Error("horizontal overflow editor was not rendered");
    }
    paper.style.transform = "translateY(-700px)";
    scrollport.dispatchEvent(new Event("scroll"));

    await waitFor(() => {
      expectRect(probe.getAttribute("data-contrast-rect"), [
        0.3,
        0.5,
        0.7,
        5 / 6,
      ]);
    });
    expectRect(
      probe.getAttribute("data-contrast-feather"),
      [0.048, 0.08, 0.048, 0],
    );
  });

  it("clips vertical writing protection before and after horizontal scrolling", async () => {
    const view = render(<OverflowingPaperProbe writingMode="vertical" />);
    const probe = view.getByTestId("vertical-overflow-shader-layout");

    await waitFor(() => {
      expectRect(
        probe.getAttribute("data-contrast-rect"),
        [0.1, 0.25, 0.9, 0.75],
      );
    });
    expectRect(probe.getAttribute("data-contrast-feather"), [0, 0.08, 0, 0.08]);

    const scrollport = view.container.querySelector<HTMLElement>(
      '[data-overflow-scrollport="vertical"]',
    );
    const paper = scrollport?.querySelector<HTMLElement>(".zen-editor-paper");
    if (!scrollport || !paper) {
      throw new Error("vertical overflow editor was not rendered");
    }
    paper.style.transform = "translateX(-700px)";
    scrollport.dispatchEvent(new Event("scroll"));

    await waitFor(() => {
      expectRect(
        probe.getAttribute("data-contrast-rect"),
        [0.1, 0.25, 0.6, 0.75],
      );
    });
    expectRect(
      probe.getAttribute("data-contrast-feather"),
      [0, 0.08, 0.048, 0.08],
    );
  });
});

describe("Zen shader non-editor Glass geometry (real Chromium)", () => {
  it("tracks disjoint panel and Stripe surfaces without absorbing the Editor", async () => {
    const view = render(<WorkspaceSurfaceProbe />);
    const probe = view.getByTestId("workspace-surface-layout");

    await waitFor(() => {
      expectRects(parseRects(probe.getAttribute("data-ui-surface-rects")), [
        [0, 1 / 3, 0.2, 5 / 6],
        [0, 14 / 15, 1, 1],
      ]);
    });
    expectRect(probe.getAttribute("data-contrast-rect"), [
      0.4,
      1 / 3,
      0.6,
      11 / 15,
    ]);

    view.rerender(<WorkspaceSurfaceProbe glass={false} />);
    await waitFor(() => {
      expectRects(parseRects(probe.getAttribute("data-ui-surface-rects")), []);
    });
    expectRect(probe.getAttribute("data-contrast-rect"), [
      0.4,
      1 / 3,
      0.6,
      11 / 15,
    ]);
  });

  it("starts tracking a Glass surface after its enter animation becomes visible", async () => {
    const view = render(<TransientWorkspaceSurfaceProbe visible={false} />);
    const probe = view.getByTestId("transient-workspace-surface-layout");

    await waitFor(() => {
      expectRects(parseRects(probe.getAttribute("data-ui-surface-rects")), []);
    });

    view.rerender(<TransientWorkspaceSurfaceProbe visible />);

    await waitFor(() => {
      expectRects(parseRects(probe.getAttribute("data-ui-surface-rects")), [
        [0.1, 13 / 15, 0.9, 14 / 15],
      ]);
    });
  });

  it("does not leak a Glass surface through a hidden animation ancestor", async () => {
    const view = render(
      <TransientWorkspaceSurfaceProbe visible ancestorVisible={false} />,
    );
    const probe = view.getByTestId("transient-workspace-surface-layout");

    await waitFor(() => {
      expectRects(parseRects(probe.getAttribute("data-ui-surface-rects")), []);
    });

    view.rerender(<TransientWorkspaceSurfaceProbe visible ancestorVisible />);

    await waitFor(() => {
      expectRects(parseRects(probe.getAttribute("data-ui-surface-rects")), [
        [0.1, 13 / 15, 0.9, 14 / 15],
      ]);
    });
  });

  it("remeasures after removing an animation sibling moves a Stripe without resizing it", async () => {
    const view = render(<PositionOnlySettlementProbe phase="baseline" />);
    const probe = view.getByTestId("position-only-settlement-layout");

    await waitFor(() => {
      expectRects(parseRects(probe.getAttribute("data-ui-surface-rects")), [
        [0, 1 / 15, 1, 2 / 15],
      ]);
    });

    view.rerender(<PositionOnlySettlementProbe phase="transient" />);
    await waitFor(() => {
      expectRects(parseRects(probe.getAttribute("data-ui-surface-rects")), [
        [0, 0, 0, 0],
      ]);
    });

    view.rerender(<PositionOnlySettlementProbe phase="settled" />);
    await waitFor(() => {
      expectRects(parseRects(probe.getAttribute("data-ui-surface-rects")), [
        [0, 1 / 15, 1, 2 / 15],
      ]);
    });
  });
});
