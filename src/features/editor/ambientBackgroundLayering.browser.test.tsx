import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { COLOR_THEMES, type ThemePalette } from "@/lib/colorThemes";

function renderLayering(
  enabled: boolean,
  glassEnabled = true,
  palette?: ThemePalette,
  sharedCompositor = false,
  backgroundRenderer: "initializing" | "webgl" | "fallback" = "webgl",
) {
  return render(
    <div
      className="app-shell"
      style={palette as React.CSSProperties | undefined}
    >
      <header data-header-bar>Header</header>
      <main id="main-content">
        <div
          data-editor-ambient
          data-background-enabled={enabled ? "true" : "false"}
          data-background-renderer={backgroundRenderer}
        >
          {sharedCompositor && <div data-zen-glass-compositor />}
        </div>
        <div
          data-workspace-glass-root
          data-layout-shell
          data-workspace-fluid-glass={glassEnabled ? "true" : "false"}
          style={
            {
              "--workspace-fluid-glass-blur": "22px",
              "--workspace-fluid-glass-saturate": "1.4",
              "--workspace-fluid-glass-shine": "0.65",
            } as React.CSSProperties
          }
        >
          <aside
            data-ambient-glass-surface="panel"
            data-slot-panel="chat"
            className="gx-panel"
          >
            <div data-animated-slot-panel>
              <div data-tool-panel-root className="bg-background">
                <span data-tool-panel-text>Tool panel text</span>
              </div>
            </div>
          </aside>
          <nav
            data-ambient-glass-surface="stripe"
            data-stripe-root
            data-stripe-region="left"
            className="gx-panel"
          >
            <span data-stripe-text>Stripe text</span>
            <span data-stripe-drop-overlay className="absolute inset-0 z-40" />
          </nav>
          <div
            data-ambient-glass-surface="stripe"
            data-zoom-restore-bar
            className="gx-panel"
          >
            <span data-zoom-text>Zoom restore</span>
          </div>
          <section
            data-editor-area
            data-editor-fluid-glass="true"
            className="gx-panel gx-panel--flat"
          >
            <div data-editor-fluid-glass-filter aria-hidden="true" />
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

const THEME_CASES = COLOR_THEMES.flatMap((theme) =>
  (["light", "dark"] as const).map((mode) => ({
    name: `${theme.id}/${mode}`,
    palette: theme[mode],
  })),
);

describe("editor ambient background layering (real Chromium)", () => {
  it("reveals the enabled shader through the layout, editor and translucent chrome", () => {
    const { container } = renderLayering(true);

    const layout = container.querySelector<HTMLElement>("[data-layout-shell]");
    const editor = container.querySelector<HTMLElement>("[data-editor-area]");
    const editorGlassFilter = container.querySelector<HTMLElement>(
      "[data-editor-fluid-glass-filter]",
    );
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
    const footer = container.querySelector<HTMLElement>("[data-editor-footer]");
    const body = container.querySelector<HTMLElement>("[data-editor-body]");
    const text = container.querySelector<HTMLElement>("[data-editor-text]");
    const paper = container.querySelector<HTMLElement>("[data-editor-paper]");
    const paperText = container.querySelector<HTMLElement>("[data-paper-text]");
    const toolPanel = container.querySelector<HTMLElement>(
      '[data-ambient-glass-surface="panel"]',
    );
    const toolPanelRoot = container.querySelector<HTMLElement>(
      "[data-tool-panel-root]",
    );
    const toolPanelText = container.querySelector<HTMLElement>(
      "[data-tool-panel-text]",
    );
    const stripe = container.querySelector<HTMLElement>(
      '[data-ambient-glass-surface="stripe"][data-stripe-root]',
    );
    const stripeText =
      container.querySelector<HTMLElement>("[data-stripe-text]");
    const stripeDropOverlay = container.querySelector<HTMLElement>(
      "[data-stripe-drop-overlay]",
    );
    const zoomRestore = container.querySelector<HTMLElement>(
      "[data-zoom-restore-bar]",
    );

    expect(layout).not.toBeNull();
    expect(editor).not.toBeNull();
    expect(editorGlassFilter).not.toBeNull();
    expect(chrome).not.toBeNull();
    expect(body).not.toBeNull();
    expect(text).not.toBeNull();
    expect(paper).not.toBeNull();
    expect(paperText).not.toBeNull();
    expect(toolPanel).not.toBeNull();
    expect(stripe).not.toBeNull();
    expect(stripeDropOverlay).not.toBeNull();
    expect(zoomRestore).not.toBeNull();
    expect(getComputedStyle(layout!).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    const editorStyle = getComputedStyle(editor!);
    expect(editorStyle.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(editorStyle.backgroundImage).not.toBe("none");
    expect(editorStyle.backdropFilter).toBe("none");
    expect(editorStyle.isolation).toBe("auto");
    const editorFilterStyle = getComputedStyle(editorGlassFilter!);
    expect(editorFilterStyle.position).toBe("absolute");
    expect(editorFilterStyle.pointerEvents).toBe("none");
    expect(editorFilterStyle.backdropFilter).toContain("blur(14px)");
    expect(editorFilterStyle.backdropFilter).toContain("saturate(1.16)");
    expect(editorFilterStyle.backdropFilter).toContain("contrast(1.03)");
    const glass = getComputedStyle(editor!, "::before");
    expect(glass.backgroundImage).not.toBe("none");
    expect(glass.boxShadow).not.toBe("none");
    expect(glass.filter).toBe("none");
    expect(getComputedStyle(breadcrumb!).backdropFilter).toBe("none");
    expect(getComputedStyle(chrome!).backdropFilter).toBe("none");
    expect(getComputedStyle(toolbar!).backdropFilter).toBe("none");
    expect(getComputedStyle(metadata!).backdropFilter).toBe("none");
    expect(getComputedStyle(footer!).backdropFilter).toBe("none");
    expect(getComputedStyle(body!).backdropFilter).toBe("none");
    expect(getComputedStyle(body!).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(text!).opacity).toBe("1");
    const paperPaint = getComputedStyle(paper!, "::before");
    expect(paperPaint.backgroundImage).toBe("none");
    expect(paperPaint.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(paperPaint.boxShadow).toBe("none");
    expect(paperPaint.maskImage).toBe("none");
    expect(getComputedStyle(paperText!).opacity).toBe("1");
    expect(getComputedStyle(paperText!).filter).toBe("none");

    for (const surface of [toolPanel!, stripe!, zoomRestore!]) {
      const surfaceStyle = getComputedStyle(surface);
      expect(surfaceStyle.backgroundColor).toBe("rgba(0, 0, 0, 0)");
      expect(surfaceStyle.backgroundImage).toBe("none");
      expect(surfaceStyle.backdropFilter).toContain("blur(22px)");
      expect(surfaceStyle.backdropFilter).toContain("saturate(1.4)");
      expect(surfaceStyle.backdropFilter).toContain("contrast(1.03)");
      const highlight = getComputedStyle(surface, "::before");
      expect(highlight.opacity).toBe("0");
      expect(highlight.backgroundImage).toBe("none");
      expect(highlight.boxShadow).toBe("none");
    }
    expect(getComputedStyle(toolPanelRoot!).backgroundColor).toBe(
      "rgba(0, 0, 0, 0)",
    );
    for (const label of [toolPanelText!, stripeText!]) {
      expect(getComputedStyle(label).opacity).toBe("1");
      expect(getComputedStyle(label).filter).toBe("none");
    }
    expect(getComputedStyle(stripeDropOverlay!).zIndex).toBe("40");
  });

  it("restores solid layout and chrome surfaces when the background is off", () => {
    const { container } = renderLayering(false);

    const layout = container.querySelector<HTMLElement>("[data-layout-shell]");
    const editor = container.querySelector<HTMLElement>("[data-editor-area]");
    const editorGlassFilter = container.querySelector<HTMLElement>(
      "[data-editor-fluid-glass-filter]",
    );
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
    const footer = container.querySelector<HTMLElement>("[data-editor-footer]");
    const body = container.querySelector<HTMLElement>("[data-editor-body]");
    const paper = container.querySelector<HTMLElement>("[data-editor-paper]");
    const glassSurfaces = container.querySelectorAll<HTMLElement>(
      "[data-ambient-glass-surface]",
    );

    expect(getComputedStyle(layout!).backgroundColor).not.toBe(
      "rgba(0, 0, 0, 0)",
    );
    expect(getComputedStyle(editor!).backgroundColor).not.toBe(
      "rgba(0, 0, 0, 0)",
    );
    expect(getComputedStyle(editor!).backdropFilter).toBe("none");
    expect(getComputedStyle(editorGlassFilter!).backdropFilter).toBe("none");
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
    for (const surface of glassSurfaces) {
      expect(getComputedStyle(surface).backgroundColor).not.toBe(
        "rgba(0, 0, 0, 0)",
      );
      expect(getComputedStyle(surface).backdropFilter).toBe("none");
    }
  });

  it("gives the shared compositor exclusive ownership of Glass filtering", () => {
    const { container } = renderLayering(true, true, undefined, true);
    const editorFilter = container.querySelector<HTMLElement>(
      "[data-editor-fluid-glass-filter]",
    );
    const glassSurfaces = container.querySelectorAll<HTMLElement>(
      "[data-ambient-glass-surface]",
    );

    expect(editorFilter).not.toBeNull();
    expect(glassSurfaces.length).toBeGreaterThan(0);
    expect(getComputedStyle(editorFilter!).backdropFilter).toBe("none");
    for (const surface of glassSurfaces) {
      expect(getComputedStyle(surface).backdropFilter).toBe("none");
    }
  });

  it("keeps native Glass filters active while WebGL is initializing", () => {
    const { container } = renderLayering(
      true,
      true,
      undefined,
      false,
      "initializing",
    );
    const editorFilter = container.querySelector<HTMLElement>(
      "[data-editor-fluid-glass-filter]",
    );
    const glassSurfaces = container.querySelectorAll<HTMLElement>(
      "[data-ambient-glass-surface]",
    );

    expect(getComputedStyle(editorFilter!).backdropFilter).toContain(
      "blur(14px)",
    );
    for (const surface of glassSurfaces) {
      expect(getComputedStyle(surface).backdropFilter).toContain("blur(22px)");
    }
  });

  it("keeps non-editor surfaces solid when the shared Glass setting is off", () => {
    const { container } = renderLayering(true, false);
    const glassSurfaces = container.querySelectorAll<HTMLElement>(
      "[data-ambient-glass-surface]",
    );

    expect(glassSurfaces.length).toBeGreaterThan(0);
    for (const surface of glassSurfaces) {
      expect(getComputedStyle(surface).backgroundColor).not.toBe(
        "rgba(0, 0, 0, 0)",
      );
      expect(getComputedStyle(surface).backdropFilter).toBe("none");
    }
  });

  it.each(THEME_CASES)(
    "keeps the tool panel transparent and blurred for $name",
    ({ palette }) => {
      const { container } = renderLayering(true, true, palette);
      const toolPanel = container.querySelector<HTMLElement>(
        '[data-ambient-glass-surface="panel"]',
      );
      const toolPanelRoot = container.querySelector<HTMLElement>(
        "[data-tool-panel-root]",
      );

      expect(toolPanel).not.toBeNull();
      expect(toolPanelRoot).not.toBeNull();
      expect(getComputedStyle(toolPanel!).backgroundColor).toBe(
        "rgba(0, 0, 0, 0)",
      );
      expect(getComputedStyle(toolPanel!).backdropFilter).toContain(
        "blur(22px)",
      );
      expect(getComputedStyle(toolPanel!).backgroundImage).toBe("none");
      expect(getComputedStyle(toolPanel!).borderTopLeftRadius).toBe("18px");
      expect(getComputedStyle(toolPanel!, "::before").opacity).toBe("0");
      expect(getComputedStyle(toolPanelRoot!).backgroundColor).toBe(
        "rgba(0, 0, 0, 0)",
      );
    },
  );
});
