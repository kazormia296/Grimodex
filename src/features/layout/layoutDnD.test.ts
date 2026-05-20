// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import {
  TOOL_WINDOW_REASSIGN_TYPE,
  countOpenSlotsBeforeIndex,
  getDropTargetElement,
  getDropTargetRect,
  getNewSlotPreviewRect,
  dragTargetsEqual,
  acceptsToolWindowReassignDrag,
  resolveDropTargetFromElement,
} from "./layoutDnD";
import { buildDefaultLayoutState } from "./layoutStateUtils";

describe("layoutDnD", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("acceptsToolWindowReassignDrag respects layout lock and MIME type", () => {
    const event = {
      dataTransfer: { types: [TOOL_WINDOW_REASSIGN_TYPE] },
    } as unknown as React.DragEvent;

    expect(acceptsToolWindowReassignDrag(event, false)).toBe(true);
    expect(acceptsToolWindowReassignDrag(event, true)).toBe(false);

    const other = {
      dataTransfer: { types: ["text/plain"] },
    } as unknown as React.DragEvent;
    expect(acceptsToolWindowReassignDrag(other, false)).toBe(false);
    expect(acceptsToolWindowReassignDrag(other, false, "chat")).toBe(true);
  });

  it("resolveDropTargetFromElement finds content slot and stripe segment", () => {
    document.body.innerHTML = `
      <div data-region-content="left">
        <div data-drop-slot="l0" data-drop-region="left"></div>
      </div>
      <div data-stripe-region="right">
        <div data-drop-segment data-drop-slot-id="r1" data-drop-region="right"></div>
      </div>
      <div
        data-drop-edge="start"
        data-drop-region="bottom"
        data-insert-index="0"
        data-drop-surface="stripe-start"
      ></div>
    `;

    expect(
      resolveDropTargetFromElement(
        document.querySelector("[data-drop-slot='l0']"),
      ),
    ).toEqual({ type: "slot", region: "left", slotId: "l0" });

    expect(
      resolveDropTargetFromElement(
        document.querySelector("[data-drop-segment]"),
      ),
    ).toEqual({ type: "slot", region: "right", slotId: "r1" });

    expect(
      resolveDropTargetFromElement(
        document.querySelector("[data-drop-edge='start']"),
      ),
    ).toEqual({
      type: "new-slot",
      region: "bottom",
      insertIndex: 0,
      surface: "stripe-start",
    });
  });

  it("getDropTargetElement resolves slot targets from content and stripe", () => {
    document.body.innerHTML = `
      <div data-drop-slot="l0"></div>
      <div data-drop-segment data-drop-slot-id="r1"></div>
    `;

    expect(
      getDropTargetElement({ type: "slot", region: "left", slotId: "l0" }),
    ).not.toBeNull();
    expect(
      getDropTargetElement({ type: "slot", region: "right", slotId: "r1" }),
    ).not.toBeNull();
  });

  it("getDropTargetRect returns bounding box for stripe edge targets", () => {
    document.body.innerHTML = `
      <div data-stripe-region="left">
        <div data-drop-edge="start" style="width:40px;height:20px"></div>
      </div>
    `;
    const el = document.querySelector("[data-drop-edge='start']") as HTMLElement;
    el.getBoundingClientRect = () =>
      ({
        left: 10,
        top: 20,
        width: 40,
        height: 20,
        right: 50,
        bottom: 40,
        x: 10,
        y: 20,
        toJSON: () => ({}),
      }) as DOMRect;

    const rect = getDropTargetRect({
      type: "new-slot",
      region: "left",
      insertIndex: 0,
      surface: "stripe-start",
    });

    expect(rect).toEqual({ left: 10, top: 20, width: 40, height: 20 });
  });

  it("resolveDropTargetFromElement finds between-slot and content-start targets", () => {
    document.body.innerHTML = `
      <div data-region-content="left">
        <div
          data-drop-between
          data-drop-region="left"
          data-insert-index="1"
          data-drop-surface="content-between"
        ></div>
        <div
          data-drop-new-slot="left"
          data-drop-region="left"
          data-insert-index="0"
          data-drop-surface="content-start"
        ></div>
      </div>
      <div
        data-drop-edge="between"
        data-drop-region="right"
        data-insert-index="2"
        data-drop-surface="stripe-between"
      ></div>
    `;

    expect(
      resolveDropTargetFromElement(
        document.querySelector("[data-drop-between]"),
      ),
    ).toEqual({
      type: "new-slot",
      region: "left",
      insertIndex: 1,
      surface: "content-between",
    });

    expect(
      resolveDropTargetFromElement(
        document.querySelector("[data-drop-new-slot='left']"),
      ),
    ).toEqual({
      type: "new-slot",
      region: "left",
      insertIndex: 0,
      surface: "content-start",
    });

    expect(
      resolveDropTargetFromElement(
        document.querySelector("[data-drop-edge='between']"),
      ),
    ).toEqual({
      type: "new-slot",
      region: "right",
      insertIndex: 2,
      surface: "stripe-between",
    });
  });

  it("countOpenSlotsBeforeIndex counts only open slots before insert index", () => {
    const layout = buildDefaultLayoutState();
    layout.regions.left.slots[0].activePanel = "scenes";
    layout.regions.left.slots[1].activePanel = null;

    expect(
      countOpenSlotsBeforeIndex(layout.regions.left.slots, 0),
    ).toBe(0);
    expect(
      countOpenSlotsBeforeIndex(layout.regions.left.slots, 1),
    ).toBe(1);
    expect(
      countOpenSlotsBeforeIndex(layout.regions.left.slots, 2),
    ).toBe(1);
  });

  it("getNewSlotPreviewRect shows equal split bands for each insert position", () => {
    document.body.innerHTML = `<div data-region-content="left"></div>`;
    const container = document.querySelector(
      "[data-region-content='left']",
    ) as HTMLElement;
    container.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 300,
        height: 600,
        right: 300,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    const layout = buildDefaultLayoutState();
    layout.regions.left.slots[0].activePanel = "scenes";
    layout.regions.left.slots[1].activePanel = "codex";

    expect(
      getNewSlotPreviewRect(
        {
          type: "new-slot",
          region: "left",
          insertIndex: 0,
          surface: "content-start",
        },
        layout,
      ),
    ).toEqual({ left: 0, top: 0, width: 300, height: 200 });

    expect(
      getNewSlotPreviewRect(
        {
          type: "new-slot",
          region: "left",
          insertIndex: 1,
          surface: "content-between",
        },
        layout,
      ),
    ).toEqual({ left: 0, top: 200, width: 300, height: 200 });

    expect(
      getNewSlotPreviewRect(
        {
          type: "new-slot",
          region: "left",
          insertIndex: 2,
          surface: "content-end",
        },
        layout,
      ),
    ).toEqual({ left: 0, top: 400, width: 300, height: 200 });
  });

  it("getDropTargetRect uses split preview when layout is provided", () => {
    document.body.innerHTML = `<div data-region-content="left"></div>`;
    const container = document.querySelector(
      "[data-region-content='left']",
    ) as HTMLElement;
    container.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 300,
        height: 600,
        right: 300,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    const layout = buildDefaultLayoutState();
    layout.regions.left.slots[0].activePanel = "scenes";
    layout.regions.left.slots[1].activePanel = "codex";

    const rect = getDropTargetRect(
      {
        type: "new-slot",
        region: "left",
        insertIndex: 2,
        surface: "content-end",
      },
      layout,
    );

    expect(rect).toEqual({ left: 0, top: 400, width: 300, height: 200 });
  });

  it("resolveDropTargetFromElement finds center segment targets", () => {
    document.body.innerHTML = `
      <div data-center-content="center">
        <div
          data-drop-slot="ct0"
          data-drop-region="center"
          data-center-segment-kind="tool"
        ></div>
        <div
          data-drop-between
          data-drop-region="center"
          data-insert-index="1"
          data-drop-surface="content-between"
        ></div>
      </div>
    `;

    expect(
      resolveDropTargetFromElement(
        document.querySelector("[data-drop-slot='ct0']"),
      ),
    ).toEqual({ type: "slot", region: "center", slotId: "ct0" });

    expect(
      resolveDropTargetFromElement(
        document.querySelector("[data-drop-between]"),
      ),
    ).toEqual({
      type: "new-slot",
      region: "center",
      insertIndex: 1,
      surface: "content-between",
    });
  });

  it("dragTargetsEqual compares target identity", () => {
    const slot = { type: "slot" as const, region: "left" as const, slotId: "l0" };
    expect(dragTargetsEqual(slot, { ...slot })).toBe(true);
    expect(
      dragTargetsEqual(slot, { type: "slot", region: "left", slotId: "l1" }),
    ).toBe(false);
    expect(dragTargetsEqual(null, slot)).toBe(false);
  });
});
