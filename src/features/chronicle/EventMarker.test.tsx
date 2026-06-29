// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import {
  EventMarker,
  type MarkerEvent,
  type EventMarkerProps,
} from "./EventMarker";

function ev(o: Partial<MarkerEvent> = {}): MarkerEvent {
  return {
    id: "m1",
    title: "出来事A",
    kind: "generic",
    precision: "exact",
    secret: false,
    sceneLinked: true,
    primaryCodexId: "c1",
    ...o,
  };
}

function renderMarker(props: Partial<EventMarkerProps> = {}) {
  return render(
    <EventMarker
      event={props.event ?? ev()}
      left={props.left ?? 100}
      top={props.top ?? 10}
      tokenH={props.tokenH ?? 26}
      maxTok={props.maxTok ?? 218}
      isInterval={props.isInterval ?? false}
      barWidth={props.barWidth ?? null}
      selected={props.selected ?? false}
      conflict={props.conflict ?? false}
      labelsOn={props.labelsOn ?? true}
      onSelect={props.onSelect ?? (() => {})}
    />,
  );
}

describe("EventMarker (DOM token)", () => {
  it("point は data-event-id 付きのボタンを描く", () => {
    const { container } = renderMarker();
    const el = container.querySelector('[data-event-id="m1"]')!;
    expect(el.tagName.toLowerCase()).toBe("button");
    expect(el.getAttribute("title")).toBe("出来事A");
  });

  it("interval は barWidth の幅で帯を描く", () => {
    const { container } = renderMarker({ isInterval: true, barWidth: 120 });
    const el = container.querySelector('[data-event-id="m1"]') as HTMLElement;
    expect(el.style.width).toBe("120px");
  });

  it("オフページ(point)は破線ボーダー", () => {
    const { container } = renderMarker({ event: ev({ sceneLinked: false }) });
    const el = container.querySelector('[data-event-id="m1"]') as HTMLElement;
    expect(el.style.borderStyle).toBe("dashed");
  });

  it("secret は秘匿タグを描く", () => {
    const { getByTestId } = renderMarker({ event: ev({ secret: true }) });
    expect(getByTestId("secret-tag")).toBeTruthy();
  });

  it("conflict は警告バッジ(!)を描く", () => {
    const { getByTestId } = renderMarker({ conflict: true });
    expect(getByTestId("conflict-badge").textContent).toBe("!");
  });

  it("birth は種別タグを描く", () => {
    const { getByTestId } = renderMarker({ event: ev({ kind: "birth" }) });
    expect(getByTestId("kind-tag")).toBeTruthy();
  });

  it("labelsOn=false ではタイトル本文を描かない（title 属性は残す）", () => {
    const { container } = renderMarker({ labelsOn: false });
    const el = container.querySelector('[data-event-id="m1"]') as HTMLElement;
    expect(el.textContent).not.toContain("出来事A");
    expect(el.getAttribute("title")).toBe("出来事A");
  });

  it("クリックで onSelect が発火する", () => {
    const onSelect = vi.fn();
    const { container } = renderMarker({ onSelect });
    (container.querySelector('[data-event-id="m1"]') as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
