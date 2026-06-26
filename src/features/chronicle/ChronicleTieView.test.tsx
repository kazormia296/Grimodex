// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ChronicleTieView } from "./ChronicleTieView";
import { buildTieView } from "./tieView";

const model = buildTieView({
  scenes: [
    { id: "s1", title: "場面1" },
    { id: "s2", title: "場面2" },
  ],
  events: [
    { id: "e1", title: "出来事1", ordinal: "a1" },
    { id: "e2", title: "出来事2", ordinal: "a0" },
  ],
  links: [
    { sceneId: "s1", eventId: "e1" },
    { sceneId: "s2", eventId: "e2" },
  ],
  width: 400,
  padX: 50,
  topY: 20,
  bottomY: 80,
});

describe("ChronicleTieView", () => {
  it("scene/event ドットとタイ線を描く", () => {
    const { container } = render(
      <ChronicleTieView model={model} width={400} height={120} />,
    );
    expect(container.querySelector('[data-tie-scene="s1"]')).not.toBeNull();
    expect(container.querySelector('[data-tie-event="e2"]')).not.toBeNull();
    const tie = container.querySelector('[data-tie="s1|e1"]')!;
    expect(tie.tagName.toLowerCase()).toBe("line");
    // s1(reading 先頭=50) → e1(ordinal 後=350)
    expect(tie.getAttribute("x1")).toBe("50");
    expect(tie.getAttribute("x2")).toBe("350");
    expect(tie.getAttribute("y1")).toBe("20");
    expect(tie.getAttribute("y2")).toBe("80");
  });
});
