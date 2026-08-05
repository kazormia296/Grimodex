// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerEditorStickySurface,
  requestEditorStickyAtTarget,
} from "./editorStickySurfaceRegistry";

function setRect(
  element: HTMLElement,
  rect: { left: number; top: number; width: number; height: number },
): void {
  const { left, top, width, height } = rect;
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect);
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("editor sticky surface routing", () => {
  it("routes a target already inside its registered surface", () => {
    const surface = document.createElement("div");
    surface.dataset.editorStickySurface = "true";
    const target = document.createElement("span");
    surface.append(target);
    document.body.append(surface);
    const addAtClientPoint = vi.fn();
    registerEditorStickySurface(surface, { addAtClientPoint });

    expect(requestEditorStickyAtTarget(target, 40, 60)).toBe(true);
    expect(addAtClientPoint).toHaveBeenCalledWith(40, 60);
  });

  it("routes editor margin clicks to the only registered descendant surface", () => {
    const editorRoot = document.createElement("div");
    const margin = document.createElement("div");
    const surface = document.createElement("div");
    surface.dataset.editorStickySurface = "true";
    editorRoot.append(margin, surface);
    document.body.append(editorRoot);
    const addAtClientPoint = vi.fn();
    registerEditorStickySurface(surface, { addAtClientPoint });

    expect(requestEditorStickyAtTarget(margin, 640, 160)).toBe(true);
    expect(addAtClientPoint).toHaveBeenCalledWith(640, 160);
  });

  it("chooses the nearest registered scene surface in Linear mode", () => {
    const linearRoot = document.createElement("div");
    const first = document.createElement("div");
    const second = document.createElement("div");
    first.dataset.editorStickySurface = "true";
    second.dataset.editorStickySurface = "true";
    linearRoot.append(first, second);
    document.body.append(linearRoot);
    setRect(first, { left: 20, top: 20, width: 400, height: 180 });
    setRect(second, { left: 20, top: 260, width: 400, height: 180 });
    const addToFirst = vi.fn();
    const addToSecond = vi.fn();
    registerEditorStickySurface(first, { addAtClientPoint: addToFirst });
    registerEditorStickySurface(second, { addAtClientPoint: addToSecond });

    expect(requestEditorStickyAtTarget(linearRoot, 180, 300)).toBe(true);
    expect(addToFirst).not.toHaveBeenCalled();
    expect(addToSecond).toHaveBeenCalledWith(180, 300);
  });

  it("returns false when no registered surface can accept the request", () => {
    const target = document.createElement("div");
    document.body.append(target);

    expect(requestEditorStickyAtTarget(target, 10, 20)).toBe(false);
  });
});
