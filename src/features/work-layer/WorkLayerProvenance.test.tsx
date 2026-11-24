// @vitest-environment happy-dom

import { act, render, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkLayerProvider, useWorkLayerProvenance } from "./WorkLayer";
import { useWorkLayer } from "./WorkLayerContext";
import type { WorkLayerContextValue } from "./workLayerContextTypes";
import type { WorkLayerModel, WorkLayerPort } from "./types";

function liveModel(scopeId: string): WorkLayerModel {
  return {
    scopeId,
    liveEntries: [{ id: "codex-candidates", status: "ready", count: 1 }],
    focus: null,
    attention: [],
    disposedAttention: [],
    system: { state: "idle", label: "idle" },
  };
}

function Probe({
  onRender,
}: {
  readonly onRender?: (value: WorkLayerContextValue | null) => void;
}) {
  const value = useWorkLayer();
  onRender?.(value);
  return (
    <output data-testid="provider-value">
      {value?.model.scopeId ?? "empty"}:{useWorkLayerProvenance()}
    </output>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("Work Layer provenance", () => {
  it("reports live only for a live port", () => {
    const model = liveModel("example-work");
    const { rerender, getByTestId } = render(
      <WorkLayerProvider initialModel={model}>
        <Probe />
      </WorkLayerProvider>,
    );
    expect(getByTestId("provider-value")).toHaveTextContent(
      "example-work:preview",
    );

    const fixturePort: WorkLayerPort = {
      kind: "fixture",
      scopeKey: model.scopeId,
      load: vi.fn().mockResolvedValue(model),
    };
    rerender(
      <WorkLayerProvider initialModel={model} port={fixturePort}>
        <Probe />
      </WorkLayerProvider>,
    );
    expect(getByTestId("provider-value")).toHaveTextContent(
      "example-work:preview",
    );

    const livePort: WorkLayerPort = {
      kind: "live",
      scopeKey: model.scopeId,
      load: vi.fn().mockResolvedValue(model),
    };
    rerender(
      <WorkLayerProvider initialModel={model} port={livePort}>
        <Probe />
      </WorkLayerProvider>,
    );
    expect(getByTestId("provider-value")).toHaveTextContent(
      "example-work:live",
    );
  });

  it("defaults to preview outside a provider", () => {
    const { result } = renderHook(() => useWorkLayerProvenance());
    expect(result.current).toBe("preview");
  });

  it("hides a prior scope immediately and ignores its late load", async () => {
    const initialA = deferred<WorkLayerModel>();
    const replacementA = deferred<WorkLayerModel>();
    const loadB = deferred<WorkLayerModel>();
    const portA: WorkLayerPort = {
      kind: "live",
      scopeKey: "A",
      load: vi.fn(() => initialA.promise),
    };
    const portAReplacement: WorkLayerPort = {
      kind: "live",
      scopeKey: "A",
      load: vi.fn(() => replacementA.promise),
    };
    const portB: WorkLayerPort = {
      kind: "live",
      scopeKey: "B",
      load: vi.fn(() => loadB.promise),
    };
    const renderedScopes: Array<string | null> = [];
    const onRender = (value: WorkLayerContextValue | null) => {
      renderedScopes.push(value?.model.scopeId ?? null);
    };
    const view = render(
      <WorkLayerProvider port={portA}>
        <Probe onRender={onRender} />
      </WorkLayerProvider>,
    );

    expect(portA.load).toHaveBeenCalledWith({ reason: "mount" });
    await act(async () => {
      initialA.resolve(liveModel("A"));
      await initialA.promise;
    });
    expect(renderedScopes.at(-1)).toBe("A");

    renderedScopes.length = 0;
    view.rerender(
      <WorkLayerProvider port={portAReplacement}>
        <Probe onRender={onRender} />
      </WorkLayerProvider>,
    );
    expect(renderedScopes[0]).toBe("A");
    expect(renderedScopes).not.toContain(null);

    renderedScopes.length = 0;
    view.rerender(
      <WorkLayerProvider port={portB}>
        <Probe onRender={onRender} />
      </WorkLayerProvider>,
    );
    expect(renderedScopes[0]).toBeNull();
    expect(renderedScopes).not.toContain("A");
    expect(portB.load).toHaveBeenCalledWith({ reason: "mount" });

    await act(async () => {
      loadB.resolve(liveModel("B"));
      await loadB.promise;
    });
    expect(renderedScopes.at(-1)).toBe("B");

    await act(async () => {
      replacementA.resolve(liveModel("A"));
      await replacementA.promise;
    });
    expect(renderedScopes.at(-1)).toBe("B");
  });

  it("passes live entries through the provider context", () => {
    const model = liveModel("example-work");
    const received: Array<WorkLayerContextValue | null> = [];
    render(
      <WorkLayerProvider
        initialModel={model}
        port={{ kind: "live", scopeKey: model.scopeId, load: vi.fn() }}
      >
        <Probe onRender={(value) => received.push(value)} />
      </WorkLayerProvider>,
    );

    // A live model never carries an arrival hint into the context.
    expect(received.at(-1)?.model).toEqual({ ...model, attentionDelta: 0 });
  });
});
