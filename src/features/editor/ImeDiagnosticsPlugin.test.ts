// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EditorView } from "@tiptap/pm/view";
import { EditorState } from "@tiptap/pm/state";
import { schema } from "prosemirror-schema-basic";
import {
  clearImeLog,
  disableImeLog,
  dumpImeLog,
  enableImeLog,
} from "@/lib/imeLog";
import { createImeDiagnosticsPlugin } from "./ImeDiagnosticsPlugin";

function compositionEvent(type: string, data?: string): Event {
  // happy-dom には CompositionEvent コンストラクタが無い環境があるため、
  // 素の Event に data を expando で載せる (plugin 側は cast 読みのみ)。
  return Object.assign(new Event(type), data === undefined ? {} : { data });
}

describe("ImeDiagnosticsPlugin", () => {
  let wrapper: HTMLDivElement;
  let view: EditorView;

  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    clearImeLog();

    wrapper = document.createElement("div");
    document.body.appendChild(wrapper);

    const state = EditorState.create({
      doc: schema.nodes.doc.create({}, [
        schema.nodes.paragraph.create({}, [schema.text("こんにちは")]),
      ]),
      plugins: [createImeDiagnosticsPlugin()],
    });
    view = new EditorView(wrapper, { state });
    view.coordsAtPos = vi
      .fn()
      .mockReturnValue({ left: 50, right: 52, top: 20, bottom: 40 });
  });

  afterEach(() => {
    view.destroy();
    wrapper.remove();
    disableImeLog();
    clearImeLog();
    localStorage.removeItem("grimodex.imeLog");
    document
      .querySelectorAll("[data-ime-diagnostics-overlay]")
      .forEach((n) => n.remove());
    vi.restoreAllMocks();
  });

  it("records nothing while disabled (OFF はチェック 1 回で即 return)", () => {
    view.dom.dispatchEvent(compositionEvent("compositionstart"));
    view.dom.dispatchEvent(compositionEvent("compositionupdate", "あ"));
    view.dom.dispatchEvent(compositionEvent("compositionend", "あ"));
    expect(dumpImeLog()).toEqual([]);
    expect(document.querySelector("[data-ime-diagnostics-overlay]")).toBeNull();
  });

  it("records all three composition events without retaining their text", () => {
    enableImeLog();
    view.dom.dispatchEvent(compositionEvent("compositionstart"));
    view.dom.dispatchEvent(compositionEvent("compositionupdate", "あい"));
    view.dom.dispatchEvent(compositionEvent("compositionend", "あい"));

    const entries = dumpImeLog();
    expect(entries.map((e) => e.type)).toEqual([
      "compositionstart",
      "compositionupdate",
      "compositionend",
    ]);
    expect(entries[1]?.dataLength).toBe(2);
    expect(entries[0]?.dataLength).toBeNull();
    expect(JSON.stringify(entries)).not.toContain("あい");
    expect(entries[0]?.selectionFrom).toBe(1);
    expect(entries[0]?.vertical).toBe(false);
  });

  it("renders the shared overlay (singleton) when enabled", () => {
    enableImeLog();
    view.dom.dispatchEvent(compositionEvent("compositionupdate", "あ"));
    view.dom.dispatchEvent(compositionEvent("compositionupdate", "あい"));
    const overlays = document.querySelectorAll(
      "[data-ime-diagnostics-overlay]",
    );
    expect(overlays).toHaveLength(1);
    expect(overlays[0]?.textContent).toContain("imeLog #");
  });

  it("detects vertical mode from the .editor-vertical ancestor class", () => {
    wrapper.classList.add("editor-vertical");
    enableImeLog();
    view.dom.dispatchEvent(compositionEvent("compositionupdate", "あ"));
    expect(dumpImeLog()[0]?.vertical).toBe(true);
  });

  it("is strictly read-only: doc and selection are untouched", () => {
    enableImeLog();
    const docBefore = view.state.doc;
    const selBefore = view.state.selection;
    view.dom.dispatchEvent(compositionEvent("compositionstart"));
    view.dom.dispatchEvent(compositionEvent("compositionupdate", "あ"));
    view.dom.dispatchEvent(compositionEvent("compositionend", "あ"));
    expect(view.state.doc).toBe(docBefore);
    expect(view.state.selection).toBe(selBefore);
  });

  it("does not consume the event (PM の composition 処理に流す)", () => {
    enableImeLog();
    const ev = compositionEvent("compositionstart");
    const prevented = !view.dom.dispatchEvent(ev);
    expect(prevented).toBe(false);
    expect(ev.defaultPrevented).toBe(false);
  });
});
