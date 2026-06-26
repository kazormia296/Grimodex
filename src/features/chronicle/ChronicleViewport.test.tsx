// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ChronicleViewport } from "./ChronicleViewport";
import type { ChronicleLaneModel } from "./chronicleLaneModel";
import type { ScaledPoint } from "./chronicleTimeScale";

const model: ChronicleLaneModel = {
  laneHeight: 40,
  contentHeight: 48,
  lanes: [
    {
      codexId: "alice",
      name: "Alice",
      y: 30,
      markers: [
        {
          eventId: "m1",
          ordinal: "a0",
          precision: "exact",
          isOffpage: false,
          isInterval: false,
        },
        {
          eventId: "m2",
          ordinal: "a1",
          precision: "exact",
          isOffpage: false,
          isInterval: true,
        },
      ],
    },
  ],
  unassigned: [
    {
      eventId: "u1",
      ordinal: "a2",
      precision: "exact",
      isOffpage: true,
      isInterval: false,
    },
  ],
};

const scaled = new Map<string, ScaledPoint>([
  ["m1", { eventId: "m1", x: 100, xEnd: null }],
  ["m2", { eventId: "m2", x: 200, xEnd: 260 }],
  ["u1", { eventId: "u1", x: 150, xEnd: null }],
]);

function renderViewport(selectedEventId: string | null = null) {
  return render(
    <ChronicleViewport
      model={model}
      scaled={scaled}
      width={400}
      gutterX={60}
      selectedEventId={selectedEventId}
      onSelectEvent={() => {}}
    />,
  );
}

describe("ChronicleViewport", () => {
  it("point マーカーは scaled.x の位置に円で描く", () => {
    const { container } = renderViewport();
    const m1 = container.querySelector('[data-event-id="m1"]')!;
    expect(m1.tagName.toLowerCase()).toBe("circle");
    expect(m1.getAttribute("cx")).toBe("100");
    expect(m1.getAttribute("cy")).toBe("30");
  });

  it("interval マーカーは start..end 幅の矩形", () => {
    const { container } = renderViewport();
    const m2 = container.querySelector('[data-event-id="m2"]')!;
    expect(m2.tagName.toLowerCase()).toBe("rect");
    expect(m2.getAttribute("x")).toBe("200");
    expect(m2.getAttribute("width")).toBe("60"); // 260-200
  });

  it("オフページは中空（fill=none）", () => {
    const { container } = renderViewport();
    const u1 = container.querySelector('[data-event-id="u1"]')!;
    expect(u1.getAttribute("fill")).toBe("none");
  });

  it("未割当マーカーは __unassigned グループに入る", () => {
    const { container } = renderViewport();
    const group = container.querySelector('[data-lane-id="__unassigned"]')!;
    expect(group).not.toBeNull();
    expect(group.querySelector('[data-event-id="u1"]')).not.toBeNull();
  });

  it("選択中マーカーに selected クラスが付く", () => {
    const { container } = renderViewport("m1");
    const m1 = container.querySelector('[data-event-id="m1"]')!;
    expect(m1.getAttribute("class")).toContain("chronicle-marker--selected");
  });

  it("人物レーンに name ラベルとレーン線", () => {
    const { container } = renderViewport();
    const lane = container.querySelector('[data-lane-id="alice"]')!;
    expect(lane.textContent).toContain("Alice");
    expect(lane.querySelector("line")).not.toBeNull();
  });
});
