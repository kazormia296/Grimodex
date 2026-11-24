// @vitest-environment happy-dom

import { act, render, renderHook, screen } from "@testing-library/react";
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
  it("reports preview for an initial model, a fixture port, and no source", async () => {
    const model = liveModel("example-work");
    const first = render(
      <WorkLayerProvider initialModel={model}>
        <Probe />
      </WorkLayerProvider>,
    );
    expect(first.getByTestId("provider-value")).toHaveTextContent(
      "example-work:preview",
    );
    first.unmount();

    const fixturePort: WorkLayerPort = {
      kind: "fixture",
      scopeKey: model.scopeId,
      load: vi.fn().mockResolvedValue(model),
    };
    const second = render(
      <WorkLayerProvider port={fixturePort}>
        <Probe />
      </WorkLayerProvider>,
    );
    expect(await second.findByText("example-work:preview")).toBeInTheDocument();
    second.unmount();

    const third = render(
      <WorkLayerProvider>
        <Probe />
      </WorkLayerProvider>,
    );
    expect(third.getByTestId("provider-value")).toHaveTextContent(
      "empty:preview",
    );
  });

  it("reports live for a live port once it has loaded", async () => {
    const model = liveModel("example-work");
    const port: WorkLayerPort = {
      kind: "live",
      scopeKey: model.scopeId,
      load: vi.fn().mockResolvedValue(model),
    };
    render(
      <WorkLayerProvider port={port}>
        <Probe />
      </WorkLayerProvider>,
    );

    expect(await screen.findByText("example-work:live")).toBeInTheDocument();
  });

  it("defaults to preview outside a provider", () => {
    const { result } = renderHook(() => useWorkLayerProvenance());
    expect(result.current).toBe("preview");
  });

  it("never lets an initial model stand in for a live port", async () => {
    const loaded = deferred<WorkLayerModel>();
    const initial = liveModel("example-work");
    const port: WorkLayerPort = {
      kind: "live",
      scopeKey: "example-work",
      load: vi.fn(() => loaded.promise),
    };
    const rendered: Array<string | null> = [];
    render(
      <WorkLayerProvider initialModel={initial} port={port}>
        <Probe
          onRender={(value) => rendered.push(value?.model.scopeId ?? null)}
        />
      </WorkLayerProvider>,
    );

    expect(port.load).toHaveBeenCalledWith({ reason: "mount" });
    expect(rendered.at(-1)).toBeNull();

    await act(async () => {
      loaded.resolve(liveModel("example-work"));
      await loaded.promise;
    });
    expect(rendered.at(-1)).toBe("example-work");
  });

  it("keeps an initial model for a fixture port of another scope", () => {
    const fixturePort: WorkLayerPort = {
      kind: "fixture",
      scopeKey: "other-scope",
      load: vi.fn().mockResolvedValue(liveModel("other-scope")),
    };
    render(
      <WorkLayerProvider
        initialModel={liveModel("example-work")}
        port={fixturePort}
      >
        <Probe />
      </WorkLayerProvider>,
    );

    expect(screen.getByTestId("provider-value")).toHaveTextContent(
      "example-work:preview",
    );
    expect(fixturePort.load).not.toHaveBeenCalled();
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

  it("hides the model at once when the port goes away", async () => {
    const portA: WorkLayerPort = {
      kind: "live",
      scopeKey: "A",
      load: vi.fn().mockResolvedValue(liveModel("A")),
    };
    const rendered: Array<string | null> = [];
    const onRender = (value: WorkLayerContextValue | null) => {
      rendered.push(value?.model.scopeId ?? null);
    };
    const view = render(
      <WorkLayerProvider port={portA}>
        <Probe onRender={onRender} />
      </WorkLayerProvider>,
    );
    expect(await screen.findByText("A:live")).toBeInTheDocument();

    rendered.length = 0;
    view.rerender(
      <WorkLayerProvider port={null}>
        <Probe onRender={onRender} />
      </WorkLayerProvider>,
    );
    expect(rendered[0]).toBeNull();
    expect(rendered).not.toContain("A");
  });

  it("passes live entries through the provider context without an arrival hint", async () => {
    const model = { ...liveModel("example-work"), attentionDelta: 3 };
    const received: Array<WorkLayerContextValue | null> = [];
    render(
      <WorkLayerProvider
        port={{
          kind: "live",
          scopeKey: model.scopeId,
          load: vi.fn().mockResolvedValue(model),
        }}
      >
        <Probe onRender={(value) => received.push(value)} />
      </WorkLayerProvider>,
    );

    expect(await screen.findByText("example-work:live")).toBeInTheDocument();
    expect(received.at(-1)?.model).toEqual({ ...model, attentionDelta: 0 });
  });
});
