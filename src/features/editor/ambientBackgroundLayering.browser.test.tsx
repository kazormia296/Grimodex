import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

function renderLayering(enabled: boolean) {
  return render(
    <div className="app-shell" data-card="true">
      <header data-header-bar>Header</header>
      <main id="main-content">
        <div
          data-editor-ambient
          data-background-enabled={enabled ? "true" : "false"}
        />
        <div data-layout-shell>
          <section data-editor-area className="gx-panel gx-panel--flat">
            <div data-editor-chrome className="editor-background-glass">
              <span data-editor-text>Opaque text</span>
            </div>
            <div
              data-editor-paper
              className="zen-editor-paper"
              style={
                {
                  "--editor-paper-fill": "rgb(20 30 40 / 80%)",
                  "--editor-paper-edge-fade": enabled ? "8%" : "0%",
                } as React.CSSProperties
              }
            >
              <span data-paper-text>Paper text</span>
            </div>
          </section>
        </div>
      </main>
    </div>,
  );
}

describe("editor ambient background layering (real Chromium)", () => {
  it("reveals the enabled shader through the layout, editor and translucent chrome", () => {
    const { container } = renderLayering(true);

    const layout = container.querySelector<HTMLElement>("[data-layout-shell]");
    const editor = container.querySelector<HTMLElement>("[data-editor-area]");
    const chrome = container.querySelector<HTMLElement>("[data-editor-chrome]");
    const text = container.querySelector<HTMLElement>("[data-editor-text]");
    const paper = container.querySelector<HTMLElement>("[data-editor-paper]");
    const paperText = container.querySelector<HTMLElement>("[data-paper-text]");

    expect(layout).not.toBeNull();
    expect(editor).not.toBeNull();
    expect(chrome).not.toBeNull();
    expect(text).not.toBeNull();
    expect(paper).not.toBeNull();
    expect(paperText).not.toBeNull();
    expect(getComputedStyle(layout!).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(editor!).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(chrome!).backdropFilter).not.toBe("none");
    expect(getComputedStyle(text!).opacity).toBe("1");
    expect(getComputedStyle(paper!, "::before").maskImage).not.toBe("none");
    expect(getComputedStyle(paperText!).opacity).toBe("1");
    expect(getComputedStyle(paperText!).filter).toBe("none");
  });

  it("restores solid layout and chrome surfaces when the background is off", () => {
    const { container } = renderLayering(false);

    const layout = container.querySelector<HTMLElement>("[data-layout-shell]");
    const editor = container.querySelector<HTMLElement>("[data-editor-area]");
    const chrome = container.querySelector<HTMLElement>("[data-editor-chrome]");

    expect(getComputedStyle(layout!).backgroundColor).not.toBe(
      "rgba(0, 0, 0, 0)",
    );
    expect(getComputedStyle(editor!).backgroundColor).not.toBe(
      "rgba(0, 0, 0, 0)",
    );
    expect(getComputedStyle(chrome!).backdropFilter).toBe("none");
  });
});
