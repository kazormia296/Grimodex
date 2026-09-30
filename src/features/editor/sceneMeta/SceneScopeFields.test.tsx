// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SceneScopeFields } from "./SceneScopeFields";
import type { Binding, Registry } from "./sceneScopeTypes";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

function binding(): Binding {
  return {
    schemaVersion: 1,
    projectId: "project-1",
    sceneId: "scene-1",
    sceneIncarnationId: "incarnation-1",
    compatibilityMarker: "unknown",
    queryIdentity: {
      timeline: { kind: "exact", ref: "any" },
      worldline: { kind: "unresolved", reason: "test" },
      narrativeLayer: { kind: "unresolved", reason: "test" },
    },
    materialConstraint: {
      timeline: { kind: "exact", ref: "unresolved" },
      worldline: { kind: "any" },
      narrativeLayer: { kind: "any" },
    },
    knowledgeHolder: { kind: "reader" },
    audience: { kind: "reader" },
    version: 1,
    sourceToken: "token",
    updatedAt: "2026-09-13T00:00:00.000Z",
  };
}

const registry: Registry = {
  registryVersion: "narrative-scene-scope-registry/1",
  timelineRefs: ["any", "unresolved"],
  worldlineRefs: [],
  narrativeLayerRefs: [],
};

describe("SceneScopeFields", () => {
  it("keeps exact registry refs distinct from any and unresolved sentinels", () => {
    const onAxisChange = vi.fn();
    render(
      <SceneScopeFields
        draft={binding()}
        registry={registry}
        onAxisChange={onAxisChange}
      />,
    );

    const [queryTimeline, materialTimeline] = screen.getAllByRole(
      "combobox",
    ) as HTMLSelectElement[];
    expect(queryTimeline.value.startsWith("exact:")).toBe(true);
    expect(materialTimeline.value.startsWith("exact:")).toBe(true);

    const exactAny = Array.from(queryTimeline.options).find(
      (option) =>
        option.textContent === "any" && option.value.startsWith("exact:"),
    );
    const exactUnresolved = Array.from(materialTimeline.options).find(
      (option) =>
        option.textContent === "unresolved" &&
        option.value.startsWith("exact:"),
    );
    expect(exactAny).toBeDefined();
    expect(exactUnresolved).toBeDefined();
    if (!exactAny || !exactUnresolved) {
      throw new Error("exact registry refs must be rendered as options");
    }
    expect(exactAny.value).not.toBe("any");
    expect(exactAny.value).not.toBe("unresolved");
    expect(exactUnresolved.value).not.toBe("any");
    expect(exactUnresolved.value).not.toBe("unresolved");

    fireEvent.change(queryTimeline, { target: { value: exactAny.value } });
    fireEvent.change(materialTimeline, {
      target: { value: exactUnresolved.value },
    });
    expect(onAxisChange).toHaveBeenNthCalledWith(
      1,
      "queryIdentity",
      "timeline",
      { kind: "exact", ref: "any" },
    );
    expect(onAxisChange).toHaveBeenNthCalledWith(
      2,
      "materialConstraint",
      "timeline",
      { kind: "exact", ref: "unresolved" },
    );
  });
});
