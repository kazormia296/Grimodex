// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
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
      resizable={props.resizable}
      cursor={props.cursor}
      dragOffset={props.dragOffset}
      onHover={props.onHover}
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

  it("シーンイベント(sceneLinked)もグリフは丸(●)のまま。区別は Link アイコンで示す（■にしない）", () => {
    const { getByTestId, container } = renderMarker({
      event: ev({ isScene: true, sceneLinked: true }),
    });
    const g = getByTestId("marker-glyph") as HTMLElement;
    expect(g.style.borderRadius).toBe("50%"); // 丸のまま（角丸スクエアに退行しない）
    expect(
      container.querySelector('[data-testid="scene-link-icon"]'),
    ).toBeTruthy();
  });

  it("点は sceneLinked で Link アイコンの有無だけが変わる（形は常に丸）", () => {
    const on = renderMarker({ event: ev({ sceneLinked: true }) });
    expect(
      (
        on.container.querySelector(
          '[data-testid="marker-glyph"]',
        ) as HTMLElement
      ).style.borderRadius,
    ).toBe("50%");
    expect(
      on.container.querySelector('[data-testid="scene-link-icon"]'),
    ).toBeTruthy();
    const off = renderMarker({ event: ev({ sceneLinked: false }) });
    expect(
      (
        off.container.querySelector(
          '[data-testid="marker-glyph"]',
        ) as HTMLElement
      ).style.borderRadius,
    ).toBe("50%");
    expect(
      off.container.querySelector('[data-testid="scene-link-icon"]'),
    ).toBeNull();
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

  it("interval はオン/オフページとも塗り（中空にしない）。リンクは Link アイコンで示す", () => {
    const on = renderMarker({
      isInterval: true,
      barWidth: 100,
      event: ev({ sceneLinked: true }),
    });
    const gOn = on.container.querySelector(
      '[data-testid="marker-glyph"]',
    ) as HTMLElement;
    expect(gOn.style.background).not.toContain("card"); // 塗り
    expect(
      on.container.querySelector('[data-testid="scene-link-icon"]'),
    ).toBeTruthy();
    const off = renderMarker({
      isInterval: true,
      barWidth: 100,
      event: ev({ sceneLinked: false }),
    });
    const gOff = off.container.querySelector(
      '[data-testid="marker-glyph"]',
    ) as HTMLElement;
    expect(gOff.style.background).not.toContain("card"); // オフページも塗り
    expect(
      off.container.querySelector('[data-testid="scene-link-icon"]'),
    ).toBeNull(); // オフページはアイコン無し
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

  it("interval の警告バッジは overflow:hidden の先祖に切り取られない（角に浮くバッジが期間ボックスに埋もれる退行の gate）", () => {
    // 期間ボックスは固定幅帯の内容クリップで overflow:hidden を持つ。
    // 角外(top:-6/right:-6)に浮く警告バッジがそれに切られると視認不能になる。
    const { container, getByTestId } = renderMarker({
      isInterval: true,
      barWidth: 120,
      conflict: true,
    });
    const badge = getByTestId("conflict-badge");
    const root = container.querySelector('[data-event-id="m1"]') as HTMLElement;
    const clippers: string[] = [];
    let node: HTMLElement | null = badge.parentElement;
    while (node) {
      if (node.style.overflow === "hidden") {
        clippers.push(node.getAttribute("data-testid") ?? node.tagName);
      }
      if (node === root) break;
      node = node.parentElement;
    }
    expect(clippers).toEqual([]);
  });

  it("interval の内容(グリフ/ラベル/タグ)は専用クリップ層で切り取る（固定幅帯のはみ出し防止・バッジはその外）", () => {
    const { getByTestId } = renderMarker({
      isInterval: true,
      barWidth: 60,
      conflict: true,
    });
    const content = getByTestId("marker-content");
    expect(content.style.overflow).toBe("hidden");
    // 警告バッジはクリップ層の外（兄弟）に置く＝切り取られない。
    expect(content.querySelector('[data-testid="conflict-badge"]')).toBeNull();
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

  it("出生/死亡はオン/オフページとも塗り（strokeWidth 0）。リンクは Link アイコンで示す", () => {
    for (const kind of ["birth", "death"] as const) {
      const on = renderMarker({ event: ev({ kind, sceneLinked: true }) });
      const off = renderMarker({ event: ev({ kind, sceneLinked: false }) });
      const pOn = on.container.querySelector(
        '[data-testid="marker-glyph"] polygon',
      ) as SVGPolygonElement;
      const pOff = off.container.querySelector(
        '[data-testid="marker-glyph"] polygon',
      ) as SVGPolygonElement;
      // どちらも塗り（中空にしない）。
      expect(parseFloat(pOn.style.strokeWidth) || 0).toBe(0);
      expect(parseFloat(pOff.style.strokeWidth) || 0).toBe(0);
      // オンページのみ Link アイコン。
      expect(
        on.container.querySelector('[data-testid="scene-link-icon"]'),
      ).toBeTruthy();
      expect(
        off.container.querySelector('[data-testid="scene-link-icon"]'),
      ).toBeNull();
    }
  });

  it("labelsOn=false ではタイトル本文を描かない（title 属性は残す）", () => {
    const { container } = renderMarker({ labelsOn: false });
    const el = container.querySelector('[data-event-id="m1"]') as HTMLElement;
    expect(el.textContent).not.toContain("出来事A");
    expect(el.getAttribute("title")).toBe("出来事A");
  });

  it("クリックで onSelect が event.id 付きで発火する", () => {
    const onSelect = vi.fn();
    const { container } = renderMarker({ onSelect });
    (container.querySelector('[data-event-id="m1"]') as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toBe("m1");
  });

  it("onHover は event.id 付きで enter=true / leave=false を通知する", () => {
    const onHover = vi.fn();
    const { container } = renderMarker({ onHover });
    const el = container.querySelector('[data-event-id="m1"]') as HTMLElement;
    fireEvent.mouseOver(el);
    expect(onHover).toHaveBeenLastCalledWith("m1", true);
    fireEvent.mouseOut(el);
    expect(onHover).toHaveBeenLastCalledWith("m1", false);
  });

  it("EventMarker は memo 化されている（親のドラッグ/ホバー再レンダーで全マーカー再描画しない gate）", () => {
    expect((EventMarker as { $$typeof?: symbol }).$$typeof).toBe(
      Symbol.for("react.memo"),
    );
  });
});

describe("EventMarker — アクセシブル名 / 状態", () => {
  const btn = (r: ReturnType<typeof renderMarker>) =>
    r.container.querySelector('[data-event-id="m1"]') as HTMLElement;

  it("button の aria-label にイベント名を含む（title 属性任せにしない）", () => {
    const r = renderMarker();
    expect(btn(r).getAttribute("aria-label")).toContain("出来事A");
  });

  it("aria-label に種別（出生/死亡）と確度（おおよそ/不明）を統合する", () => {
    const birth = renderMarker({
      event: ev({ kind: "birth", precision: "approx" }),
    });
    const label = btn(birth).getAttribute("aria-label")!;
    expect(label).toContain("出生");
    expect(label).toContain("おおよそ");
    // 確定(exact)は無印（視覚の確度チップと同じ扱い）。
    const exact = renderMarker({ event: ev({ precision: "exact" }) });
    expect(btn(exact).getAttribute("aria-label")).not.toContain("確定");
  });

  it("aria-label に矛盾/秘匿の状態を含む", () => {
    const r = renderMarker({
      event: ev({ secret: true }),
      conflict: true,
    });
    const label = btn(r).getAttribute("aria-label")!;
    expect(label).toContain("整合警告あり");
    expect(label).toContain("秘匿");
  });

  it("無題イベントは aria-label がフォールバック名になる", () => {
    const r = renderMarker({ event: ev({ title: "" }) });
    expect(btn(r).getAttribute("aria-label")).toContain("無題のイベント");
  });

  it("選択状態は aria-current=true（非選択時は属性なし）", () => {
    const on = renderMarker({ selected: true });
    expect(btn(on).getAttribute("aria-current")).toBe("true");
    const off = renderMarker({ selected: false });
    expect(btn(off).getAttribute("aria-current")).toBeNull();
  });

  it("種別グリフは装飾（aria-hidden）— 種別は button の aria-label が伝える", () => {
    for (const kind of ["generic", "birth"] as const) {
      const r = renderMarker({ event: ev({ kind }) });
      const glyph = r.container.querySelector('[data-testid="marker-glyph"]')!;
      expect(glyph.getAttribute("aria-hidden")).toBe("true");
    }
  });
});

describe("EventMarker — リサイズグリップ / カーソル", () => {
  it("interval+resizable は両端にリサイズグリップを描く（既定は隠れ group-hover で表示）", () => {
    const { container } = renderMarker({
      isInterval: true,
      barWidth: 120,
      resizable: true,
    });
    const grips = container.querySelectorAll('[data-testid="resize-grip"]');
    expect(grips.length).toBe(2);
    // 既定は非表示(opacity-0)、ホバー(group-hover)/キーボードフォーカス
    // (group-focus-visible)でフェードイン（WCAG 1.4.13）。
    for (const g of grips) {
      expect(g.className).toContain("opacity-0");
      expect(g.className).toContain("group-hover:opacity-100");
      expect(g.className).toContain("group-focus-visible:opacity-100");
    }
    // 両端の data-resize 帯の中に居る（クリック判定は帯側が担う）。
    expect(
      container.querySelector(
        '[data-resize="start"] [data-testid="resize-grip"]',
      ),
    ).toBeTruthy();
    expect(
      container.querySelector(
        '[data-resize="end"] [data-testid="resize-grip"]',
      ),
    ).toBeTruthy();
    // 親ボタンは group（group-hover の起点）。
    const btn = container.querySelector('[data-event-id="m1"]') as HTMLElement;
    expect(btn.className).toContain("group");
  });

  it("resizable でない期間・点にはグリップを描かない", () => {
    const iv = renderMarker({
      isInterval: true,
      barWidth: 120,
      resizable: false,
    });
    expect(
      iv.container.querySelectorAll('[data-testid="resize-grip"]').length,
    ).toBe(0);
    const pt = renderMarker({ isInterval: false, resizable: true });
    expect(
      pt.container.querySelectorAll('[data-testid="resize-grip"]').length,
    ).toBe(0);
  });

  it("ホバーカーソルは渡された cursor（grab）、ドラッグ追従中は grabbing", () => {
    const hover = renderMarker({ cursor: "grab" });
    expect(
      (hover.container.querySelector('[data-event-id="m1"]') as HTMLElement)
        .style.cursor,
    ).toBe("grab");
    const dragging = renderMarker({
      cursor: "grab",
      dragOffset: { dx: 12, dy: 0 },
    });
    expect(
      (dragging.container.querySelector('[data-event-id="m1"]') as HTMLElement)
        .style.cursor,
    ).toBe("grabbing");
  });
});
