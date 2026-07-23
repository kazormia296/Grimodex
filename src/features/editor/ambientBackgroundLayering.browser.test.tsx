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
          <section
            data-editor-area
            data-editor-fluid-glass="true"
            className="gx-panel gx-panel--flat"
          >
            <div data-editor-breadcrumb className="glass-editor-chrome">
              Breadcrumb
            </div>
            <div
              data-editor-chrome
              className="editor-background-glass glass-editor-chrome"
            >
              <span data-editor-text>Opaque text</span>
            </div>
            <div data-editor-toolbar className="glass-editor-chrome">
              Toolbar
            </div>
            <div
              data-testid="scene-meta-chip-row"
              className="glass-editor-chrome"
            >
              Metadata
            </div>
            <div data-editor-body className="glass-editor-body">
              <div
                data-editor-paper
                className="zen-editor-paper"
                style={
                  {
                    "--editor-paper-fill": enabled
                      ? "transparent"
                      : "rgb(20 30 40)",
                  } as React.CSSProperties
                }
              >
                <span data-paper-text>Paper text</span>
              </div>
            </div>
            <div data-editor-footer className="glass-editor-chrome">
              Footer
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
    const breadcrumb = container.querySelector<HTMLElement>(
      "[data-editor-breadcrumb]",
    );
    const chrome = container.querySelector<HTMLElement>("[data-editor-chrome]");
    const toolbar = container.querySelector<HTMLElement>(
      "[data-editor-toolbar]",
    );
    const metadata = container.querySelector<HTMLElement>(
      '[data-testid="scene-meta-chip-row"]',
    );
    const footer = container.querySelector<HTMLElement>(
      "[data-editor-footer]",
    );
    const body = container.querySelector<HTMLElement>("[data-editor-body]");
    const text = container.querySelector<HTMLElement>("[data-editor-text]");
    const paper = container.querySelector<HTMLElement>("[data-editor-paper]");
    const paperText = container.querySelector<HTMLElement>("[data-paper-text]");

    expect(layout).not.toBeNull();
    expect(editor).not.toBeNull();
    expect(chrome).not.toBeNull();
    expect(body).not.toBeNull();
    expect(text).not.toBeNull();
    expect(paper).not.toBeNull();
    expect(paperText).not.toBeNull();
    expect(getComputedStyle(layout!).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(editor!).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    const glass = getComputedStyle(editor!, "::before");
    expect(glass.backgroundImage).not.toBe("none");
    expect(glass.boxShadow).not.toBe("none");
    expect(glass.filter).toBe("none");
    expect(getComputedStyle(breadcrumb!).backdropFilter).toContain(
      "blur(14px)",
    );
    expect(getComputedStyle(chrome!).backdropFilter).toContain("blur(14px)");
    expect(getComputedStyle(toolbar!).backdropFilter).toContain("blur(14px)");
    expect(getComputedStyle(metadata!).backdropFilter).toContain("blur(14px)");
    expect(getComputedStyle(footer!).backdropFilter).toContain("blur(14px)");
    expect(getComputedStyle(body!).backdropFilter).not.toBe("none");
    expect(getComputedStyle(body!).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(text!).opacity).toBe("1");
    const paperPaint = getComputedStyle(paper!, "::before");
    expect(paperPaint.backgroundImage).toBe("none");
    expect(paperPaint.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(paperPaint.boxShadow).toBe("none");
    expect(paperPaint.maskImage).toBe("none");
    expect(getComputedStyle(paperText!).opacity).toBe("1");
    expect(getComputedStyle(paperText!).filter).toBe("none");
  });

  it("restores solid layout and chrome surfaces when the background is off", () => {
    const { container } = renderLayering(false);

    const layout = container.querySelector<HTMLElement>("[data-layout-shell]");
    const editor = container.querySelector<HTMLElement>("[data-editor-area]");
    const breadcrumb = container.querySelector<HTMLElement>(
      "[data-editor-breadcrumb]",
    );
    const chrome = container.querySelector<HTMLElement>("[data-editor-chrome]");
    const toolbar = container.querySelector<HTMLElement>(
      "[data-editor-toolbar]",
    );
    const metadata = container.querySelector<HTMLElement>(
      '[data-testid="scene-meta-chip-row"]',
    );
    const footer = container.querySelector<HTMLElement>(
      "[data-editor-footer]",
    );
    const body = container.querySelector<HTMLElement>("[data-editor-body]");
    const paper = container.querySelector<HTMLElement>("[data-editor-paper]");

    expect(getComputedStyle(layout!).backgroundColor).not.toBe(
      "rgba(0, 0, 0, 0)",
    );
    expect(getComputedStyle(editor!).backgroundColor).not.toBe(
      "rgba(0, 0, 0, 0)",
    );
    expect(getComputedStyle(chrome!).backdropFilter).toBe("none");
    expect(getComputedStyle(breadcrumb!).backdropFilter).toBe("none");
    expect(getComputedStyle(toolbar!).backdropFilter).toBe("none");
    expect(getComputedStyle(metadata!).backdropFilter).toBe("none");
    expect(getComputedStyle(footer!).backdropFilter).toBe("none");
    expect(getComputedStyle(body!).backdropFilter).toBe("none");
    expect(getComputedStyle(editor!, "::before").filter).toBe("none");
    expect(getComputedStyle(paper!, "::before").backgroundImage).toBe("none");
    expect(getComputedStyle(paper!, "::before").backgroundColor).not.toBe(
      "rgba(0, 0, 0, 0)",
    );
  });
});
