// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChronicleStore } from "./chronicleStore";
import { useChronicleViewportController } from "./useChronicleViewportController";

vi.mock("@/lib/a11y/announcer", () => ({ announce: vi.fn() }));

describe("useChronicleViewportController", () => {
  beforeEach(() => {
    useChronicleStore.setState({
      pxPerDay: null,
      viewStartDay: null,
      axisMode: null,
      viewProjectId: null,
      viewWorkspacePath: null,
    });
  });

  it("fits locally on first measurement and persists user navigation", () => {
    const { result } = renderHook(() =>
      useChronicleViewportController({
        workspacePath: "/workspace-a",
        projectId: "project-a",
        dataReady: true,
        dataStart: 0,
        dataEnd: 100,
        eventCount: 2,
        focusDay: 50,
        hasCalendarAxis: true,
      }),
    );

    act(() => result.current.setTrackW(800));
    expect(result.current.view.pxPerDay).toBeGreaterThan(0);
    expect(useChronicleStore.getState().pxPerDay).toBeNull();

    act(() => result.current.applyView({ pxPerDay: 4, viewStartDay: 10 }));
    expect(useChronicleStore.getState()).toMatchObject({
      pxPerDay: 4,
      viewStartDay: 10,
      axisMode: "calendar",
      viewProjectId: "project-a",
      viewWorkspacePath: "/workspace-a",
    });

    act(() => result.current.centerOnDay(110));
    expect(result.current.view.viewStartDay).toBeCloseTo(10);
  });

  it("does not center when the viewport has no measurable width", () => {
    const { result } = renderHook(() =>
      useChronicleViewportController({
        workspacePath: "/workspace-a",
        projectId: "project-a",
        dataReady: true,
        dataStart: 0,
        dataEnd: 10,
        eventCount: 1,
        focusDay: 5,
        hasCalendarAxis: true,
      }),
    );
    const before = result.current.view;
    act(() => result.current.centerOnDay(5));
    expect(result.current.view).toEqual(before);
  });

  it("axisMode を持たない legacy persisted view は現在 mode へ一度だけ fit して保存する", () => {
    useChronicleStore.setState({
      pxPerDay: 4,
      viewStartDay: 0,
      axisMode: null,
      viewProjectId: null,
      viewWorkspacePath: null,
    });
    const { result } = renderHook(() =>
      useChronicleViewportController({
        workspacePath: "/workspace-a",
        projectId: "project-a",
        dataReady: true,
        dataStart: 96_000,
        dataEnd: 96_010,
        eventCount: 2,
        focusDay: 96_005,
        hasCalendarAxis: true,
      }),
    );

    act(() => result.current.setTrackW(400));

    expect(result.current.view.viewStartDay).toBeGreaterThan(95_000);
    expect(useChronicleStore.getState()).toMatchObject({
      ...result.current.view,
      axisMode: "calendar",
      viewProjectId: "project-a",
      viewWorkspacePath: "/workspace-a",
    });
  });

  it("保存 mode と current mode が違えば疎な新範囲が旧 view と交差しても再 fit する", () => {
    useChronicleStore.setState({
      pxPerDay: 4,
      viewStartDay: 0,
      axisMode: "sequence",
      viewProjectId: "project-a",
      viewWorkspacePath: "/workspace-a",
    });
    const { result } = renderHook(() =>
      useChronicleViewportController({
        workspacePath: "/workspace-a",
        projectId: "project-a",
        dataReady: true,
        // 旧 sequence view の day=0 は bounding range 内だが、calendar event
        // 自体は両端に疎在する想定。mode 契約で確実に移行する。
        dataStart: -100_000,
        dataEnd: 100_000,
        eventCount: 2,
        focusDay: 100_000,
        hasCalendarAxis: true,
      }),
    );

    act(() => result.current.setTrackW(400));

    expect(result.current.view.viewStartDay).toBeGreaterThan(90_000);
    expect(useChronicleStore.getState()).toMatchObject({
      ...result.current.view,
      axisMode: "calendar",
      viewProjectId: "project-a",
      viewWorkspacePath: "/workspace-a",
    });
  });

  it("同じ mode の data range 変更ではデータ外へ pan した persisted view を保持する", () => {
    useChronicleStore.setState({
      pxPerDay: 4,
      viewStartDay: 0,
      axisMode: "calendar",
      viewProjectId: "project-a",
      viewWorkspacePath: "/workspace-a",
    });
    const { result, rerender } = renderHook(
      ({ dataStart, dataEnd }: { dataStart: number; dataEnd: number }) =>
        useChronicleViewportController({
          workspacePath: "/workspace-a",
          projectId: "project-a",
          dataReady: true,
          dataStart,
          dataEnd,
          eventCount: 2,
          focusDay: (dataStart + dataEnd) / 2,
          hasCalendarAxis: true,
        }),
      { initialProps: { dataStart: 0, dataEnd: 10 } },
    );

    act(() => result.current.setTrackW(400));
    act(() => result.current.applyView({ pxPerDay: 4, viewStartDay: 50_000 }));
    rerender({ dataStart: 96_000, dataEnd: 96_010 });

    expect(result.current.view).toEqual({
      pxPerDay: 4,
      viewStartDay: 50_000,
    });
    expect(useChronicleStore.getState()).toMatchObject({
      pxPerDay: 4,
      viewStartDay: 50_000,
      axisMode: "calendar",
      viewProjectId: "project-a",
      viewWorkspacePath: "/workspace-a",
    });
  });

  it("同じ数値範囲・mode の別 project でも所有 ID で再 fit する", () => {
    useChronicleStore.setState({
      pxPerDay: 4,
      viewStartDay: 50_000,
      axisMode: "calendar",
      viewProjectId: "project-a",
      viewWorkspacePath: "/workspace-a",
    });
    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) =>
        useChronicleViewportController({
          workspacePath: "/workspace-a",
          projectId,
          dataReady: true,
          dataStart: 0,
          dataEnd: 10,
          eventCount: 2,
          focusDay: 5,
          hasCalendarAxis: true,
        }),
      { initialProps: { projectId: "project-a" } },
    );

    act(() => result.current.resetForProject("project-a"));
    act(() => result.current.setTrackW(400));
    expect(result.current.view.viewStartDay).toBe(50_000);

    act(() => result.current.resetForProject("project-b"));
    rerender({ projectId: "project-b" });

    expect(result.current.view.viewStartDay).toBeLessThan(100);
    expect(useChronicleStore.getState()).toMatchObject({
      ...result.current.view,
      axisMode: "calendar",
      viewProjectId: "project-b",
      viewWorkspacePath: "/workspace-a",
    });
  });

  it("再マウント時も別 project 所有の persisted view を再 fit する", () => {
    useChronicleStore.setState({
      pxPerDay: 4,
      viewStartDay: 50_000,
      axisMode: "calendar",
      viewProjectId: "project-a",
      viewWorkspacePath: "/workspace-a",
    });
    const { result } = renderHook(() =>
      useChronicleViewportController({
        workspacePath: "/workspace-a",
        projectId: "project-b",
        dataReady: true,
        dataStart: 0,
        dataEnd: 10,
        eventCount: 2,
        focusDay: 5,
        hasCalendarAxis: true,
      }),
    );

    act(() => result.current.setTrackW(400));

    expect(result.current.view.viewStartDay).toBeLessThan(100);
    expect(useChronicleStore.getState()).toMatchObject({
      ...result.current.view,
      axisMode: "calendar",
      viewProjectId: "project-b",
      viewWorkspacePath: "/workspace-a",
    });
  });

  it("同じ default project ID でも別 workspace 所有の view は再 fit する", () => {
    useChronicleStore.setState({
      pxPerDay: 4,
      viewStartDay: 50_000,
      axisMode: "calendar",
      viewProjectId: "default-project",
      viewWorkspacePath: "/workspace-a",
    });
    const { result } = renderHook(() =>
      useChronicleViewportController({
        workspacePath: "/workspace-b",
        projectId: "default-project",
        dataReady: true,
        dataStart: 0,
        dataEnd: 10,
        eventCount: 2,
        focusDay: 5,
        hasCalendarAxis: true,
      }),
    );

    act(() => result.current.setTrackW(400));

    expect(result.current.view.viewStartDay).toBeLessThan(100);
    expect(useChronicleStore.getState()).toMatchObject({
      ...result.current.view,
      axisMode: "calendar",
      viewProjectId: "default-project",
      viewWorkspacePath: "/workspace-b",
    });
  });

  it("snapshot 未到着中の view 操作を無視し、到着後に初回 fit する", () => {
    const { result, rerender } = renderHook(
      ({ dataReady }: { dataReady: boolean }) =>
        useChronicleViewportController({
          workspacePath: "/workspace-a",
          projectId: "project-a",
          dataReady,
          dataStart: 0,
          dataEnd: 10,
          eventCount: 2,
          focusDay: 5,
          hasCalendarAxis: true,
        }),
      { initialProps: { dataReady: false } },
    );

    act(() => result.current.setTrackW(400));
    act(() => result.current.applyView({ pxPerDay: 9, viewStartDay: 99 }));
    expect(result.current.view).toEqual({ pxPerDay: 1, viewStartDay: 0 });
    expect(useChronicleStore.getState().pxPerDay).toBeNull();

    rerender({ dataReady: true });

    expect(result.current.view).not.toEqual({
      pxPerDay: 1,
      viewStartDay: 0,
    });
    expect(useChronicleStore.getState().pxPerDay).toBeNull();
  });

  it("unpersisted session の mode 遷移は再 fit するが永続化しない", () => {
    const { result, rerender } = renderHook(
      ({
        dataStart,
        dataEnd,
        hasCalendarAxis,
      }: {
        dataStart: number;
        dataEnd: number;
        hasCalendarAxis: boolean;
      }) =>
        useChronicleViewportController({
          workspacePath: "/workspace-a",
          projectId: "project-a",
          dataReady: true,
          dataStart,
          dataEnd,
          eventCount: 2,
          focusDay: (dataStart + dataEnd) / 2,
          hasCalendarAxis,
        }),
      {
        initialProps: {
          dataStart: 0,
          dataEnd: 1,
          hasCalendarAxis: false,
        },
      },
    );

    act(() => result.current.setTrackW(400));
    expect(useChronicleStore.getState()).toMatchObject({
      pxPerDay: null,
      viewStartDay: null,
      axisMode: null,
      viewProjectId: null,
      viewWorkspacePath: null,
    });

    rerender({
      dataStart: 96_000,
      dataEnd: 96_010,
      hasCalendarAxis: true,
    });

    expect(result.current.view.viewStartDay).toBeGreaterThan(95_000);
    expect(useChronicleStore.getState()).toMatchObject({
      pxPerDay: null,
      viewStartDay: null,
      axisMode: null,
      viewProjectId: null,
      viewWorkspacePath: null,
    });
  });
});
