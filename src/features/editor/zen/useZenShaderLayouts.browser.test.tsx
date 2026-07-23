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

const parseRect = (value: string | null) => value?.split(" ").map(Number) ?? [];

const parseNumber = (value: string | null) => Number(value);

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
