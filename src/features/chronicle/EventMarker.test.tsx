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

  it("interval の先頭グリフは凡例「期間」と同形＝横長の角丸帯（縦棒に退行しない）", () => {
    const { getByTestId } = renderMarker({ isInterval: true, barWidth: 120 });
    const g = getByTestId("marker-glyph") as HTMLElement;
    const w = parseFloat(g.style.width);
    const h = parseFloat(g.style.height);
    // 横長（幅 > 高さ）であること。旧実装は width:4/height:14 の縦棒だった。
    expect(w).toBeGreaterThan(h);
    expect(g.style.borderRadius).toBe("3.5px");
  });

  it("interval も scene 未参照はオフページ＝中空で示す（点 ●/◯ と同様）", () => {
    // 各 render の container 内で引く（共有 document の多重一致を避ける）。
    const on = renderMarker({
      isInterval: true,
      barWidth: 100,
      event: ev({ sceneLinked: true }),
    });
    const gOn = on.container.querySelector(
      '[data-testid="marker-glyph"]',
    ) as HTMLElement;
    const off = renderMarker({
      isInterval: true,
      barWidth: 100,
      event: ev({ sceneLinked: false }),
    });
    const gOff = off.container.querySelector(
      '[data-testid="marker-glyph"]',
    ) as HTMLElement;
    // off-page=中空（card 地）/ on-page=塗り（card 地ではない）。
    // ※ tint は color-mix(in oklch) で happy-dom が getter を落とすため、card 地で判別。
    expect(gOff.style.background).toContain("card");
    expect(gOn.style.background).not.toContain("card");
  });

  it("オフページでも border は確度専用（exact は実線・オフページが破線を強制しない）", () => {
    // 以前はオフページが dashed を強制し確度差が潰れていた回帰の gate。
    const { container, getByTestId } = renderMarker({
      event: ev({ sceneLinked: false, precision: "exact" }),
    });
    expect(getByTestId("marker-glyph")).toBeTruthy(); // 中空グリフは描画される
    const el = container.querySelector('[data-event-id="m1"]') as HTMLElement;
    expect(el.style.borderStyle).toBe("solid");
  });

  it("オフページでも確度の差が出る（exact=実線 / approx=点線 / unknown=破線）", () => {
    const sty = (p: "exact" | "approx" | "unknown") => {
      const { container } = renderMarker({
        event: ev({ sceneLinked: false, precision: p }),
      });
      return (container.querySelector('[data-event-id="m1"]') as HTMLElement)
        .style.borderStyle;
    };
    expect(sty("exact")).toBe("solid");
    expect(sty("approx")).toBe("dotted");
    expect(sty("unknown")).toBe("dashed");
  });

  it("approx/unknown は確度チップを描く（確定は無印）", () => {
    const chip = (p: "exact" | "approx" | "unknown") =>
      renderMarker({ event: ev({ precision: p }) }).container.querySelector(
        '[data-testid="precision-tag"]',
      );
    expect(chip("approx")).toBeTruthy();
    expect(chip("unknown")).toBeTruthy();
    expect(chip("exact")).toBeNull();
  });

  it("確度 unknown は point/interval ともに破線（確度が外周線へ反映）", () => {
    const p = renderMarker({ event: ev({ precision: "unknown" }) });
    expect(
      (p.container.querySelector('[data-event-id="m1"]') as HTMLElement).style
        .borderStyle,
    ).toBe("dashed");
    const iv = renderMarker({
      event: ev({ precision: "unknown" }),
      isInterval: true,
      barWidth: 120,
    });
    expect(
      (iv.container.querySelector('[data-event-id="m1"]') as HTMLElement).style
        .borderStyle,
    ).toBe("dashed");
  });

  it("border は shorthand を使わず longhand のみ（border/borderStyle 混在の React 警告回避）", () => {
    const { container } = renderMarker();
    const el = container.querySelector('[data-event-id="m1"]') as HTMLElement;
    const style = el.getAttribute("style") ?? "";
    // 'border:' shorthand を含まない（'border-style:' 等の longhand は可）。
    expect(/(^|;)\s*border\s*:/.test(style)).toBe(false);
    expect(el.style.borderStyle).toBeTruthy();
    expect(el.style.borderWidth).toBeTruthy();
  });

  it("確度 exact は実線（interval も）", () => {
    const iv = renderMarker({
      event: ev({ precision: "exact" }),
      isInterval: true,
      barWidth: 120,
    });
    expect(
      (iv.container.querySelector('[data-event-id="m1"]') as HTMLElement).style
        .borderStyle,
    ).toBe("solid");
  });

  it("選択中でも確度の破線が見える（選択は色を奪わない）", () => {
    const { container } = renderMarker({
      event: ev({ precision: "unknown" }),
      selected: true,
    });
    const el = container.querySelector('[data-event-id="m1"]') as HTMLElement;
    expect(el.style.borderStyle).toBe("dashed");
  });

  it("確度 approx は点線＋やや減光（確定=実線と明確に差をつける）", () => {
    const { container } = renderMarker({ event: ev({ precision: "approx" }) });
    const el = container.querySelector('[data-event-id="m1"]') as HTMLElement;
    expect(el.style.borderStyle).toBe("dotted");
    expect(Number(el.style.opacity)).toBeLessThan(1);
  });

  it("secret は秘匿タグを描く", () => {
    const { getByTestId } = renderMarker({ event: ev({ secret: true }) });
    expect(getByTestId("secret-tag")).toBeTruthy();
  });

  it("conflict は警告バッジ(!)を描く", () => {
    const { getByTestId } = renderMarker({ conflict: true });
    expect(getByTestId("conflict-badge").textContent).toBe("!");
  });

  it("種別は先頭グリフ（凡例と同じ）で示し文字タグは描かない", () => {
    const r = renderMarker({ event: ev({ kind: "birth" }) });
    // 文字タグ(kind-tag)は廃止。先頭グリフの title が種別を伝える。
    expect(r.container.querySelector('[data-testid="kind-tag"]')).toBeNull();
    expect(r.getByTestId("marker-glyph").getAttribute("title")).toBe("出生");
  });

  it("オフページの birth/death も種別グリフ（中空丸に潰れない）", () => {
    const birth = renderMarker({
      event: ev({ kind: "birth", sceneLinked: false }),
    });
    expect(birth.getByTestId("marker-glyph").getAttribute("title")).toBe(
      "出生",
    );
  });

  it("出生/死亡も scene 未参照はオフページ＝中空(outline)で示す（点 ●/◯ と同様）", () => {
    for (const kind of ["birth", "death"] as const) {
      const on = renderMarker({ event: ev({ kind, sceneLinked: true }) });
      const off = renderMarker({ event: ev({ kind, sceneLinked: false }) });
      const pOn = on.container.querySelector(
        '[data-testid="marker-glyph"] polygon',
      ) as SVGPolygonElement;
      const pOff = off.container.querySelector(
        '[data-testid="marker-glyph"] polygon',
      ) as SVGPolygonElement;
      expect(pOn).toBeTruthy();
      expect(pOff).toBeTruthy();
      // on-page=塗り（stroke 幅 0）/ off-page=中空（stroke 幅 > 0）。
      expect(parseFloat(pOn.style.strokeWidth) || 0).toBe(0);
      expect(parseFloat(pOff.style.strokeWidth)).toBeGreaterThan(0);
    }
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
