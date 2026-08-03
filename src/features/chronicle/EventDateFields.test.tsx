// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { EventDateFields } from "./EventDateFields";

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./ChronicleDatePicker", () => ({
  ChronicleDatePicker: ({
    which,
    onCommitDay,
    onCommitMinute,
  }: {
    which: "start" | "end";
    onCommitDay: (day: number) => void;
    onCommitMinute: (minute: number) => void;
  }) => (
    <>
      <button
        type="button"
        data-testid={`${which}-day-10`}
        onClick={() => onCommitDay(10)}
      />
      <button
        type="button"
        data-testid={`${which}-minute-720`}
        onClick={() => onCommitMinute(720)}
      />
      <button
        type="button"
        data-testid={`${which}-minute-1260`}
        onClick={() => onCommitMinute(1260)}
      />
    </>
  ),
}));

const calendar = { daysPerYear: 360, seasonBoundaries: [] };

describe("EventDateFields interval invariants", () => {
  it("終了分を開始前へ動かしてもday/minuteを一つのpatchで開始へclampする", () => {
    const onPatch = vi.fn();
    render(
      <EventDateFields
        calendar={calendar}
        startTime={10}
        startMinute={1080}
        startGranularity="time"
        endTime={10}
        endMinute={1200}
        endGranularity="time"
        onPatch={onPatch}
      />,
    );

    fireEvent.click(screen.getByTestId("end-minute-720"));
    expect(onPatch).toHaveBeenLastCalledWith({
      endTime: 10,
      endMinute: 1080,
      endGranularity: "time",
    });
  });

  it("開始分を終了後へ動かしてもday/minuteを一つのpatchで終了へclampする", () => {
    const onPatch = vi.fn();
    render(
      <EventDateFields
        calendar={calendar}
        startTime={10}
        startMinute={1080}
        startGranularity="time"
        endTime={10}
        endMinute={1200}
        endGranularity="time"
        onPatch={onPatch}
      />,
    );

    fireEvent.click(screen.getByTestId("start-minute-1260"));
    expect(onPatch).toHaveBeenLastCalledWith({
      startTime: 10,
      startMinute: 1200,
      startGranularity: "time",
    });
  });

  it("開始を未指定へ戻すと孤立した終了端も同じpatchで消す", () => {
    const onPatch = vi.fn();
    render(
      <EventDateFields
        calendar={calendar}
        startTime={10}
        startMinute={1080}
        startGranularity="time"
        endTime={11}
        endMinute={0}
        endGranularity="time"
        onPatch={onPatch}
      />,
    );

    fireEvent.change(screen.getByLabelText("開始の粒度"), {
      target: { value: "none" },
    });
    expect(onPatch).toHaveBeenLastCalledWith({
      startGranularity: "none",
      startTime: null,
      startMinute: null,
      endGranularity: "none",
      endTime: null,
      endMinute: null,
    });
  });

  it.each([
    ["day", 10, 10],
    ["none", null, 0],
  ] as const)(
    "%s粒度からtimeへ切り替えると分を同じpatchで00:00へ補完する",
    (startGranularity, startTime, expectedDay) => {
      const onPatch = vi.fn();
      render(
        <EventDateFields
          calendar={calendar}
          startTime={startTime}
          startMinute={null}
          startGranularity={startGranularity}
          endTime={null}
          endMinute={null}
          endGranularity="none"
          onPatch={onPatch}
        />,
      );

      fireEvent.change(screen.getByLabelText("開始の粒度"), {
        target: { value: "time" },
      });
      expect(onPatch).toHaveBeenLastCalledWith({
        startGranularity: "time",
        startTime: expectedDay,
        startMinute: 0,
      });
    },
  );

  it("timeからdayへ切り替えると非表示の分を同じpatchで消す", () => {
    const onPatch = vi.fn();
    render(
      <EventDateFields
        calendar={calendar}
        startTime={10}
        startMinute={720}
        startGranularity="time"
        endTime={null}
        endMinute={null}
        endGranularity="none"
        onPatch={onPatch}
      />,
    );

    fireEvent.change(screen.getByLabelText("開始の粒度"), {
      target: { value: "day" },
    });
    expect(onPatch).toHaveBeenLastCalledWith({
      startGranularity: "day",
      startTime: 10,
      startMinute: null,
    });
  });

  it("日粒度の期間を作ると終了分を残さない", () => {
    const onPatch = vi.fn();
    render(
      <EventDateFields
        calendar={calendar}
        startTime={10}
        startMinute={null}
        startGranularity="day"
        endTime={null}
        endMinute={null}
        endGranularity="none"
        onPatch={onPatch}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "期間にする" }));
    expect(onPatch).toHaveBeenLastCalledWith({
      endTime: 70,
      endGranularity: "day",
      endMinute: null,
    });
  });
});
