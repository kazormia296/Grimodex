import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("editor ambient background layering (real Chromium)", () => {
  it("reveals the main-scoped shader through the layout canvas and editor panel", () => {
    const { container } = render(
      <div className="app-shell" data-card="true">
        <header data-header-bar>Header</header>
        <main id="main-content">
          <div data-editor-ambient />
          <div data-layout-shell>
            <section data-editor-area className="gx-panel gx-panel--flat">
              <span data-editor-text>Opaque text</span>
            </section>
          </div>
        </main>
      </div>,
    );

    const layout = container.querySelector<HTMLElement>("[data-layout-shell]");
    const editor = container.querySelector<HTMLElement>("[data-editor-area]");
    const text = container.querySelector<HTMLElement>("[data-editor-text]");

    expect(layout).not.toBeNull();
    expect(editor).not.toBeNull();
    expect(text).not.toBeNull();
    expect(getComputedStyle(layout!).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(editor!).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(text!).opacity).toBe("1");
  });
});
