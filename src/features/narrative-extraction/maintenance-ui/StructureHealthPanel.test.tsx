// @vitest-environment happy-dom
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MaintenanceHealthSummary } from "@/application/narrative-extraction/nativeApi";
import enLocale from "@/locales/en.json";
import jaLocale from "@/locales/ja.json";

const { summaryMock, loadedProjectIdMock, readSpy } = vi.hoisted(() => ({
  summaryMock: vi.fn(),
  loadedProjectIdMock: vi.fn(),
  readSpy: vi.fn(),
}));

vi.mock("@/application/narrative-extraction/nativeApi", () => ({
  narrativeMaintenanceHealthSummary: summaryMock,
}));
vi.mock("@/application/project/currentProjectAuthority", () => ({
  getLoadedProjectId: loadedProjectIdMock,
}));

// Observe whether a late response is still processed after unmount.
vi.mock("./structureHealthModel", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./structureHealthModel")>();
  return {
    ...actual,
    isNothingToInspect: (
      ...args: Parameters<typeof actual.isNothingToInspect>
    ) => {
      readSpy(...args);
      return actual.isNothingToInspect(...args);
    },
  };
});

// The scene list has its own tests; here only its mount condition matters.
vi.mock("./StaleProposalScenesList", () => ({
  StaleProposalScenesList: ({ projectId }: { projectId: string }) => (
    <div data-testid="structure-health-scenes-stub">{projectId}</div>
  ),
}));

import { StructureHealthPanel } from "./StructureHealthPanel";

function summary(
  patch: Partial<Omit<MaintenanceHealthSummary, "staleBreakdown">> & {
    staleBreakdown?: Partial<MaintenanceHealthSummary["staleBreakdown"]>;
  } = {},
): MaintenanceHealthSummary {
  return {
    proposalsChecked: 0,
    proposalsStale: 0,
    maintenanceStopped: 0,
    unrecognized: 0,
    ...patch,
    staleBreakdown: {
      stale: 0,
      "source-missing": 0,
      "anchor-mismatch": 0,
      "read-set-drift": 0,
      unknown: 0,
      ...patch.staleBreakdown,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("StructureHealthPanel", () => {
  beforeEach(() => {
    summaryMock.mockReset();
    readSpy.mockReset();
    loadedProjectIdMock.mockReset();
    loadedProjectIdMock.mockReturnValue("project-1");
  });

  it("reads exactly once on open, with the loaded project id", async () => {
    summaryMock.mockResolvedValue(summary({ proposalsChecked: 1 }));
    const { rerender } = render(<StructureHealthPanel onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByTestId("structure-health-counts")).toBeInTheDocument(),
    );
    rerender(<StructureHealthPanel onClose={() => {}} />);
    expect(summaryMock).toHaveBeenCalledExactlyOnceWith({
      projectId: "project-1",
    });
  });

  it("shows loading first, then the counts with a breakdown and the partial-check note", async () => {
    const pending = deferred<MaintenanceHealthSummary>();
    summaryMock.mockReturnValue(pending.promise);
    render(<StructureHealthPanel onClose={() => {}} />);
    expect(screen.getByTestId("structure-health-loading")).toBeInTheDocument();

    await act(async () => {
      pending.resolve(
        summary({
          proposalsChecked: 4,
          proposalsStale: 3,
          staleBreakdown: { stale: 2, "source-missing": 1 },
          maintenanceStopped: 1,
        }),
      );
    });

    expect(screen.queryByTestId("structure-health-loading")).toBeNull();
    expect(screen.getByTestId("structure-health-checked")).toHaveTextContent(
      "4",
    );
    expect(screen.getByTestId("structure-health-stale")).toHaveTextContent("3");
    expect(
      screen.getByTestId("structure-health-stale-stale"),
    ).toHaveTextContent("2");
    expect(
      screen.getByTestId("structure-health-stale-source-missing"),
    ).toHaveTextContent("1");
    expect(screen.getByTestId("structure-health-stopped")).toHaveTextContent(
      "1",
    );
    expect(screen.queryByTestId("structure-health-unrecognized")).toBeNull();
    expect(
      screen.getByTestId("structure-health-partial-note"),
    ).toBeInTheDocument();
  });

  it("lists scenes for the loaded project only when something is out of date", async () => {
    summaryMock.mockResolvedValue(summary({ proposalsChecked: 1 }));
    const fresh = render(<StructureHealthPanel onClose={() => {}} />);
    await screen.findByTestId("structure-health-counts");
    expect(screen.queryByTestId("structure-health-scenes-stub")).toBeNull();
    fresh.unmount();

    summaryMock.mockResolvedValue(
      summary({
        proposalsChecked: 1,
        proposalsStale: 1,
        staleBreakdown: { "source-missing": 1 },
      }),
    );
    render(<StructureHealthPanel onClose={() => {}} />);
    const stub = await screen.findByTestId("structure-health-scenes-stub");
    expect(stub).toHaveTextContent("project-1");
    // The list updates on demand; it must not be announced by the live region.
    expect(stub.closest("[aria-live]")).toBeNull();
  });

  it("says there is nothing to check (never 'all clear') when nothing was counted", async () => {
    summaryMock.mockResolvedValue(summary());
    render(<StructureHealthPanel onClose={() => {}} />);
    const empty = await screen.findByTestId("structure-health-empty");
    const text = empty.textContent ?? "";
    expect([
      jaLocale.narrativeMaintenance.inbox.empty,
      enLocale.narrativeMaintenance.inbox.empty,
    ]).toContain(text);
    expect(text).not.toMatch(
      /正常|問題なし|異常なし|all clear|healthy|no problems/i,
    );
    expect(screen.queryByTestId("structure-health-counts")).toBeNull();
  });

  it("shows a failure that is distinct from zero", async () => {
    summaryMock.mockRejectedValue(new Error("boom"));
    render(<StructureHealthPanel onClose={() => {}} />);
    expect(await screen.findByTestId("structure-health-failed")).toBeVisible();
    expect(screen.queryByTestId("structure-health-empty")).toBeNull();
    expect(screen.queryByTestId("structure-health-counts")).toBeNull();
    // role="alert" must not sit inside an aria-live region.
    expect(
      screen.getByTestId("structure-health-failed").closest("[aria-live]"),
    ).toBeNull();
    // The failure text must not echo the error.
    expect(screen.getByTestId("structure-health-failed")).not.toHaveTextContent(
      "boom",
    );
  });

  it("does not read when no project is loaded", async () => {
    loadedProjectIdMock.mockReturnValue(null);
    render(<StructureHealthPanel onClose={() => {}} />);
    expect(
      await screen.findByTestId("structure-health-no-project"),
    ).toBeInTheDocument();
    expect(summaryMock).not.toHaveBeenCalled();
  });

  it("drops a response that arrives after unmount", async () => {
    const pending = deferred<MaintenanceHealthSummary>();
    summaryMock.mockReturnValue(pending.promise);
    const { unmount } = render(<StructureHealthPanel onClose={() => {}} />);
    unmount();
    await act(async () => {
      pending.resolve(summary({ proposalsChecked: 1, proposalsStale: 1 }));
    });
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("reads again on each fresh open", async () => {
    summaryMock.mockResolvedValue(summary({ proposalsChecked: 1 }));
    const view1 = render(<StructureHealthPanel onClose={() => {}} />);
    await screen.findByTestId("structure-health-counts");
    view1.unmount();
    render(<StructureHealthPanel onClose={() => {}} />);
    await screen.findByTestId("structure-health-counts");
    expect(summaryMock).toHaveBeenCalledTimes(2);
  });
});
