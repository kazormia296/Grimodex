import { describe, expect, it } from "vitest";

import {
  createInitialWorkLayerNavigationState,
  reduceWorkLayerNavigation,
} from "./workLayerReducer";

describe("workLayerReducer", () => {
  it("keeps FOCUS and ATTN as separate doors into the same Work Layer", () => {
    const initial = createInitialWorkLayerNavigationState();

    expect(
      reduceWorkLayerNavigation(initial, { type: "open-focus" }),
    ).toMatchObject({ mode: "tray-focus", history: ["ambient"] });
    expect(
      reduceWorkLayerNavigation(initial, { type: "open-attention" }),
    ).toMatchObject({ mode: "tray-attention", history: ["ambient"] });
  });

  it("returns from Inspect to the surface that opened it, one level at a time", () => {
    const initial = createInitialWorkLayerNavigationState();
    const tray = reduceWorkLayerNavigation(initial, {
      type: "open-attention",
    });
    const lens = reduceWorkLayerNavigation(tray, {
      type: "open-finding",
      findingId: "finding-binding",
    });
    const inspectFromLens = reduceWorkLayerNavigation(lens, {
      type: "open-inspect",
    });

    expect(inspectFromLens).toMatchObject({
      mode: "inspect",
      history: ["ambient", "tray-attention", "lens"],
      selectedFindingId: "finding-binding",
    });
    expect(
      reduceWorkLayerNavigation(inspectFromLens, { type: "back" }),
    ).toMatchObject({ mode: "lens", history: ["ambient", "tray-attention"] });

    const projection = reduceWorkLayerNavigation(tray, {
      type: "open-projection",
    });
    const inspectFromProjection = reduceWorkLayerNavigation(projection, {
      type: "open-inspect",
    });
    expect(
      reduceWorkLayerNavigation(inspectFromProjection, { type: "back" }),
    ).toMatchObject({
      mode: "projection",
      history: ["ambient", "tray-attention"],
    });

    expect(reduceWorkLayerNavigation(projection, { type: "back" })).toEqual(
      createInitialWorkLayerNavigationState(),
    );
  });

  it("returns ALL WORK to the Focus tray from every tray footer", () => {
    const initial = createInitialWorkLayerNavigationState();
    const attention = reduceWorkLayerNavigation(initial, {
      type: "open-attention",
    });
    const disposed = reduceWorkLayerNavigation(attention, {
      type: "open-disposed",
    });

    for (const opener of [attention, disposed]) {
      const ledger = reduceWorkLayerNavigation(opener, {
        type: "open-ledger",
      });

      expect(ledger).toMatchObject({
        mode: "ledger",
        history: ["ambient", "tray-focus"],
      });
      expect(reduceWorkLayerNavigation(ledger, { type: "back" })).toMatchObject(
        {
          mode: "tray-focus",
          history: ["ambient"],
        },
      );
    }
  });

  it("turns a preview decision into a receipt without claiming persistence", () => {
    const lens = reduceWorkLayerNavigation(
      reduceWorkLayerNavigation(createInitialWorkLayerNavigationState(), {
        type: "open-attention",
      }),
      { type: "open-finding", findingId: "finding-binding" },
    );

    expect(
      reduceWorkLayerNavigation(lens, {
        type: "resolve-preview",
        findingId: "finding-binding",
        decisionLabel: "アリス・レインへ Binding",
      }),
    ).toEqual({
      mode: "resolved",
      history: ["ambient"],
      selectedFindingId: "finding-binding",
      decisionLabel: "アリス・レインへ Binding",
    });
  });
});
