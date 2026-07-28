// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mutationAffectsZenShaderLayout } from "./useZenShaderLayouts";

function mutationRecords(
  root: HTMLElement,
  mutate: () => void,
  options: MutationObserverInit = { childList: true, subtree: true },
) {
  const observer = new MutationObserver(() => undefined);
  observer.observe(root, options);
  mutate();
  const records = observer.takeRecords();
  observer.disconnect();
  return records;
}

describe("mutationAffectsZenShaderLayout", () => {
  it("ignores content and unrelated panel mutations", () => {
    const root = document.createElement("main");
    const paper = document.createElement("article");
    paper.className = "zen-editor-paper";
    const unrelated = document.createElement("aside");
    root.append(paper, unrelated);

    const paperRecords = mutationRecords(paper, () => {
      paper.append(document.createElement("p"));
    });
    const unrelatedRecords = mutationRecords(unrelated, () => {
      unrelated.append(document.createElement("li"));
    });

    expect(mutationAffectsZenShaderLayout(paperRecords)).toBe(false);
    expect(mutationAffectsZenShaderLayout(unrelatedRecords)).toBe(false);
  });

  it("remeasures when an editor layout target mounts or unmounts", () => {
    const root = document.createElement("main");
    const editor = document.createElement("section");
    editor.dataset.editorArea = "";
    const paper = document.createElement("article");
    paper.className = "zen-editor-paper";
    editor.append(paper);

    const mounted = mutationRecords(root, () => {
      root.append(editor);
    });
    const unmounted = mutationRecords(root, () => {
      editor.remove();
    });

    expect(mutationAffectsZenShaderLayout(mounted)).toBe(true);
    expect(mutationAffectsZenShaderLayout(unmounted)).toBe(true);
  });

  it("remeasures when a non-editor Glass surface mounts or unmounts", () => {
    const root = document.createElement("main");
    const surface = document.createElement("aside");
    surface.dataset.ambientGlassSurface = "panel";

    const mounted = mutationRecords(root, () => {
      root.append(surface);
    });
    const unmounted = mutationRecords(root, () => {
      surface.remove();
    });

    expect(mutationAffectsZenShaderLayout(mounted)).toBe(true);
    expect(mutationAffectsZenShaderLayout(unmounted)).toBe(true);
  });

  it("remeasures when removing a sibling moves a surviving layout target", () => {
    const root = document.createElement("main");
    const dock = document.createElement("section");
    const exitingPanel = document.createElement("div");
    const stripe = document.createElement("nav");
    stripe.dataset.ambientGlassSurface = "stripe";
    dock.append(exitingPanel, stripe);
    root.append(dock);

    const records = mutationRecords(dock, () => {
      exitingPanel.remove();
    });

    expect(mutationAffectsZenShaderLayout(records)).toBe(true);
  });

  it("remeasures observed layout attributes", () => {
    const editor = document.createElement("section");
    const records = mutationRecords(
      editor,
      () => {
        editor.style.borderRadius = "18px";
      },
      { attributes: true, attributeFilter: ["class", "style"] },
    );

    expect(mutationAffectsZenShaderLayout(records)).toBe(true);
  });
});
