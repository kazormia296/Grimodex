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

  it("scene/event が欠けたリンクはタイ線に描かれない", () => {
    const missing = buildTieView({
      scenes: [{ id: "s1", title: "場面1" }],
      events: [{ id: "e1", title: "出来事1", ordinal: "a0" }],
      links: [
        { sceneId: "s1", eventId: "e1" }, // 有効
        { sceneId: "s1", eventId: "ghost" }, // event 欠落
        { sceneId: "ghost", eventId: "e1" }, // scene 欠落
      ],
      width: 400,
      padX: 50,
      topY: 20,
      bottomY: 80,
    });
    const { container } = render(
      <ChronicleTieView model={missing} width={400} height={120} />,
    );
    expect(container.querySelectorAll("[data-tie]")).toHaveLength(1);
    expect(container.querySelector('[data-tie="s1|e1"]')).not.toBeNull();
    expect(container.querySelector('[data-tie="s1|ghost"]')).toBeNull();
    expect(container.querySelector('[data-tie="ghost|e1"]')).toBeNull();
  });

  it("交差不変: 読む順と作中順が逆のリンクは線が交差する", () => {
    // model は s1→e1 / s2→e2、reading s1<s2、作中 e2(a0)<e1(a1)。
    const { container } = render(
      <ChronicleTieView model={model} width={400} height={120} />,
    );
    const t1 = container.querySelector('[data-tie="s1|e1"]')!;
    const t2 = container.querySelector('[data-tie="s2|e2"]')!;
    const x1a = Number(t1.getAttribute("x1"));
    const x1b = Number(t2.getAttribute("x1"));
    const x2a = Number(t1.getAttribute("x2"));
    const x2b = Number(t2.getAttribute("x2"));
    // 上端の左右関係と下端の左右関係が逆 = 交差
    expect(x1a).toBeLessThan(x1b);
    expect(x2a).toBeGreaterThan(x2b);
  });
});
