// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  installSuppressSystemMenuOnAlt,
  isEditorTextFocus,
  shouldSuppressSystemMenuOnAlt,
} from "./suppressSystemMenuOnAlt";

describe("suppressSystemMenuOnAlt", () => {
  let editor: HTMLDivElement;

  beforeEach(() => {
    editor = document.createElement("div");
    editor.className = "ProseMirror";
    editor.setAttribute("contenteditable", "true");
    document.body.appendChild(editor);
    editor.focus();
  });

  afterEach(() => {
    editor.remove();
  });

  it("detects focus inside ProseMirror", () => {
    expect(isEditorTextFocus()).toBe(true);
  });

  it("suppresses bare Alt while editing on non-macOS", () => {
    const e = new KeyboardEvent("keydown", {
      key: "Alt",
      code: "AltLeft",
      bubbles: true,
      cancelable: true,
    });
    expect(shouldSuppressSystemMenuOnAlt(e, false)).toBe(true);
  });

  it("suppresses Alt+Space while editing on non-macOS", () => {
    const e = new KeyboardEvent("keydown", {
      key: " ",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    expect(shouldSuppressSystemMenuOnAlt(e, false)).toBe(true);
  });

  it("does not suppress Alt+arrow shortcuts", () => {
    const e = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    expect(shouldSuppressSystemMenuOnAlt(e, false)).toBe(false);
  });

  it("does not suppress Ctrl+Alt (AltGr) while editing", () => {
    const e = new KeyboardEvent("keydown", {
      key: "Alt",
      code: "AltRight",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    expect(shouldSuppressSystemMenuOnAlt(e, false)).toBe(false);
  });

  it("does not suppress on macOS", () => {
    const e = new KeyboardEvent("keydown", {
      key: "Alt",
      code: "AltLeft",
      bubbles: true,
      cancelable: true,
    });
    expect(shouldSuppressSystemMenuOnAlt(e, true)).toBe(false);
  });

  it("install listener calls preventDefault for bare Alt in editor", () => {
    installSuppressSystemMenuOnAlt();
    const e = new KeyboardEvent("keydown", {
      key: "Alt",
      code: "AltLeft",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});
