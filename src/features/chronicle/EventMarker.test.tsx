// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { EventMarker } from "./EventMarker";
import type { ChronicleLaneMarker } from "./chronicleLaneModel";

function marker(o: Partial<ChronicleLaneMarker> = {}): ChronicleLaneMarker {
  return {
    eventId: "m1",
    ordinal: "a0",
    precision: "exact",
    isOffpage: false,
    isInterval: false,
    ...o,
  };
}

// EventMarker は <rect>/<circle> を直接返すので SVG 親でラップして描く（Viewport harness と同形）。
function renderMarker(props: {
  marker?: ChronicleLaneMarker;
  x?: number;
  xEnd?: number | null;
}) {
  return render(
    <svg>
      <EventMarker
        marker={props.marker ?? marker()}
        x={props.x ?? 100}
        xEnd={props.xEnd ?? null}
        y={30}
        selected={false}
        onSelect={() => {}}
      />
    </svg>,
  );
}

describe("EventMarker", () => {
  it("interval でも xEnd=null なら円で描く（rank モード）", () => {
    const { container } = renderMarker({
      marker: marker({ isInterval: true }),
      x: 100,
      xEnd: null,
    });
    const el = container.querySelector('[data-event-id="m1"]')!;
    expect(el.tagName.toLowerCase()).toBe("circle");
  });

  it("xEnd<=x の interval は円にフォールバック（負幅 rect を出さない）", () => {
    // ゼロ/負の duration（xEnd === x や xEnd < x）でも rect を描かない。
    const zero = renderMarker({
      marker: marker({ isInterval: true }),
      x: 100,
      xEnd: 100,
    });
    const zEl = zero.container.querySelector('[data-event-id="m1"]')!;
    expect(zEl.tagName.toLowerCase()).toBe("circle");

    const negative = renderMarker({
      marker: marker({ isInterval: true }),
      x: 100,
      xEnd: 80,
    });
    const nEl = negative.container.querySelector('[data-event-id="m1"]')!;
    expect(nEl.tagName.toLowerCase()).toBe("circle");
    // 念のため負幅 rect が描かれていないこと
    expect(negative.container.querySelector("rect")).toBeNull();
  });

  it("正の duration の interval は rect で描く", () => {
    const { container } = renderMarker({
      marker: marker({ isInterval: true }),
      x: 100,
      xEnd: 160,
    });
    const el = container.querySelector('[data-event-id="m1"]')!;
    expect(el.tagName.toLowerCase()).toBe("rect");
    expect(el.getAttribute("width")).toBe("60");
  });

  it("オフページは中空（fill=none）", () => {
    const { container } = renderMarker({
      marker: marker({ isOffpage: true }),
      x: 100,
      xEnd: null,
    });
    const el = container.querySelector('[data-event-id="m1"]')!;
    expect(el.getAttribute("fill")).toBe("none");
  });
});
