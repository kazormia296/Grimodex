// @vitest-environment happy-dom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WorkLayerProvider, useWorkLayer } from "./WorkLayerContext";
import type {
  WorkLayerLoadRequest,
  WorkLayerModel,
  WorkLayerPort,
} from "./types";

function model(scopeId: string, count: number): WorkLayerModel {
  return {
    scopeId,
    liveEntries: [{ id: "codex-candidates", status: "ready", count }],
    focus: null,
    attention: [],
    disposedAttention: [],
    system: { state: "idle", label: "idle" },
  };
}

function Probe() {
  const value = useWorkLayer();
  return (
    <>
      <output data-testid="model">
        {value?.model.scopeId ?? "empty"}:{value?.provenance ?? "none"}:
        {value?.model.liveEntries?.[0]?.count ?? "-"}
      </output>
      <button onClick={() => value?.openAttention()}>open tray</button>
    </>
  );
}

describe("Work Layer live provider", () => {
  it("reloads when navigation opens the tray and applies the result", async () => {
    const port: WorkLayerPort = {
      kind: "live",
      scopeKey: "p1",
      load: vi
        .fn()
        .mockResolvedValueOnce(model("p1", 1))
        .mockResolvedValueOnce(model("p1", 4)),
    };
    render(
      <WorkLayerProvider port={port}>
        <Probe />
      </WorkLayerProvider>,
    );

    expect(await screen.findByText("p1:live:1")).toBeInTheDocument();
    fireEvent.click(screen.getByText("open tray"));
    await waitFor(() => {
      expect(port.load).toHaveBeenLastCalledWith({ reason: "tray-open" });
      expect(screen.getByTestId("model")).toHaveTextContent("p1:live:4");
    });
  });

  it("keeps the previous model when a tray-open reload fails", async () => {
    const port: WorkLayerPort = {
      kind: "live",
      scopeKey: "p1",
      load: vi
        .fn()
        .mockResolvedValueOnce(model("p1", 1))
        .mockRejectedValueOnce(new Error("reload")),
    };
    render(
      <WorkLayerProvider port={port}>
        <Probe />
      </WorkLayerProvider>,
    );

    expect(await screen.findByText("p1:live:1")).toBeInTheDocument();
    fireEvent.click(screen.getByText("open tray"));
    await waitFor(() => expect(port.load).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("model")).toHaveTextContent("p1:live:1");
  });

  it("drops an old port's late tray result after the port changes", async () => {
    let resolveOldTray!: (next: WorkLayerModel) => void;
    const oldPort: WorkLayerPort = {
      kind: "live",
      scopeKey: "p1",
      load: vi.fn(
        (request: WorkLayerLoadRequest): Promise<WorkLayerModel> =>
          request.reason === "mount"
            ? Promise.resolve(model("p1", 1))
            : new Promise<WorkLayerModel>((resolve) => {
                resolveOldTray = resolve;
              }),
      ),
    };
    const newPort: WorkLayerPort = {
      kind: "live",
      scopeKey: "p2",
      load: vi.fn().mockResolvedValue(model("p2", 8)),
    };
    const view = render(
      <WorkLayerProvider port={oldPort}>
        <Probe />
      </WorkLayerProvider>,
    );
    expect(await screen.findByText("p1:live:1")).toBeInTheDocument();
    fireEvent.click(screen.getByText("open tray"));
    expect(oldPort.load).toHaveBeenLastCalledWith({ reason: "tray-open" });

    view.rerender(
      <WorkLayerProvider port={newPort}>
        <Probe />
      </WorkLayerProvider>,
    );
    expect(await screen.findByText("p2:live:8")).toBeInTheDocument();
    await act(async () => {
      resolveOldTray(model("p1", 2));
    });
    expect(screen.getByTestId("model")).toHaveTextContent("p2:live:8");
  });

  it("applies same-scope subscription updates and ignores another scope", async () => {
    let listener: ((next: WorkLayerModel) => void) | undefined;
    const unsubscribe = vi.fn();
    const port: WorkLayerPort = {
      kind: "live",
      scopeKey: "p1",
      load: vi.fn().mockResolvedValue(model("p1", 1)),
      subscribe: vi.fn((next) => {
        listener = next;
        return unsubscribe;
      }),
    };
    const view = render(
      <WorkLayerProvider port={port}>
        <Probe />
      </WorkLayerProvider>,
    );
    expect(await screen.findByText("p1:live:1")).toBeInTheDocument();

    act(() => listener?.(model("p1", 5)));
    expect(screen.getByTestId("model")).toHaveTextContent("p1:live:5");
    act(() => listener?.(model("p2", 99)));
    expect(screen.getByTestId("model")).toHaveTextContent("p1:live:5");

    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("reloads only when the tray opens from ambient, never when moving between faces", async () => {
    const port: WorkLayerPort = {
      kind: "live",
      scopeKey: "p1",
      load: vi.fn().mockResolvedValue(model("p1", 1)),
    };
    function Faces() {
      const value = useWorkLayer();
      return (
        <>
          <output data-testid="mode">{value?.navigation.mode ?? "none"}</output>
          <button onClick={() => value?.openAttention()}>attention</button>
          <button onClick={() => value?.openDisposed()}>disposed</button>
          <button onClick={() => value?.openLedger()}>ledger</button>
          <button onClick={() => value?.close()}>close</button>
        </>
      );
    }
    render(
      <WorkLayerProvider port={port}>
        <Faces />
      </WorkLayerProvider>,
    );
    await waitFor(() => expect(port.load).toHaveBeenCalledTimes(1));
    await screen.findByText("ledger");

    // ambient -> tray: one reload.
    fireEvent.click(screen.getByText("attention"));
    await waitFor(() => expect(port.load).toHaveBeenCalledTimes(2));
    expect(port.load).toHaveBeenLastCalledWith({ reason: "tray-open" });

    // tray -> other faces: no reload.
    fireEvent.click(screen.getByText("disposed"));
    fireEvent.click(screen.getByText("ledger"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("mode")).toHaveTextContent("ledger");
    expect(port.load).toHaveBeenCalledTimes(2);

    // closing and opening again: one more reload.
    fireEvent.click(screen.getByText("close"));
    await waitFor(() =>
      expect(screen.getByTestId("mode")).toHaveTextContent("ambient"),
    );
    fireEvent.click(screen.getByText("attention"));
    await waitFor(() => expect(port.load).toHaveBeenCalledTimes(3));
  });
});
