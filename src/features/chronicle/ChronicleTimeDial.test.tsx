// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import {
  ChronicleTimeDial,
  clockPosFromPoint,
  hourFromPoint,
  minuteFromPoint,
  CENTER,
  R_OUT,
  R_IN,
} from "./ChronicleTimeDial";

describe("time dial geometry (pure)", () => {
  it("clockPosFromPoint: 上=0 右=3 下=6 左=9", () => {
    expect(clockPosFromPoint(0, -10)).toBe(0);
    expect(clockPosFromPoint(10, 0)).toBe(3);
    expect(clockPosFromPoint(0, 10)).toBe(6);
    expect(clockPosFromPoint(-10, 0)).toBe(9);
  });
  it("hourFromPoint: 外周=1..12 / 内周=0,13..23", () => {
    expect(hourFromPoint(0, -R_OUT)).toBe(12); // 上・外周
    expect(hourFromPoint(0, -R_IN)).toBe(0); // 上・内周
    expect(hourFromPoint(R_OUT, 0)).toBe(3); // 右・外周
    expect(hourFromPoint(R_IN, 0)).toBe(15); // 右・内周(=3+12)
  });
  it("minuteFromPoint: 5分刻み（上=0 右=15 下=30）", () => {
    expect(minuteFromPoint(0, -10)).toBe(0);
    expect(minuteFromPoint(10, 0)).toBe(15);
    expect(minuteFromPoint(0, 10)).toBe(30);
  });
});

describe("ChronicleTimeDial", () => {
  const setup = (hour = 3, minute = 15) => {
    const onHour = vi.fn();
    const onMinute = vi.fn();
    const r = render(
      <ChronicleTimeDial
        hour={hour}
        minute={minute}
        onHour={onHour}
        onMinute={onMinute}
      />,
    );
    return { ...r, onHour, onMinute };
  };

  it("デジタル入力欄に時:分（03:15）", () => {
    const { getByTestId } = setup();
    expect((getByTestId("chronicle-dial-hh") as HTMLInputElement).value).toBe(
      "03",
    );
    expect((getByTestId("chronicle-dial-mm") as HTMLInputElement).value).toBe(
      "15",
    );
  });

  it("時の手入力（数値）→ blur で clamp して onHour", () => {
    const { getByTestId, onHour } = setup();
    const hh = getByTestId("chronicle-dial-hh");
    fireEvent.focus(hh);
    fireEvent.change(hh, { target: { value: "21" } });
    fireEvent.blur(hh);
    expect(onHour).toHaveBeenLastCalledWith(21);
  });

  it("分の手入力は 0..59 へ clamp（99→59）", () => {
    const { getByTestId, onMinute } = setup();
    const mm = getByTestId("chronicle-dial-mm");
    fireEvent.focus(mm);
    fireEvent.change(mm, { target: { value: "99" } });
    fireEvent.blur(mm);
    expect(onMinute).toHaveBeenLastCalledWith(59);
  });

  it("盤面クリックで onHour（右・外周→3時）", () => {
    const { getByTestId, onHour } = setup();
    fireEvent.pointerDown(getByTestId("chronicle-time-dial"), {
      clientX: CENTER + R_OUT,
      clientY: CENTER,
    });
    expect(onHour).toHaveBeenCalledWith(3);
  });

  it("内周クリックで 24時間側の時（右・内周→15時）", () => {
    const { getByTestId, onHour } = setup();
    fireEvent.pointerDown(getByTestId("chronicle-time-dial"), {
      clientX: CENTER + R_IN,
      clientY: CENTER,
    });
    expect(onHour).toHaveBeenCalledWith(15);
  });

  it("ArrowUp で時を +1（ラップ）", () => {
    const { getByTestId, onHour } = setup(23);
    fireEvent.keyDown(getByTestId("chronicle-time-dial"), { key: "ArrowUp" });
    expect(onHour).toHaveBeenCalledWith(0);
  });

  it("分入力欄フォーカスで分モードへ→盤面クリックで onMinute（上→0分）", () => {
    const { getByTestId, onMinute } = setup();
    fireEvent.focus(getByTestId("chronicle-dial-mm")); // MM 入力欄フォーカスで分モード
    fireEvent.pointerDown(getByTestId("chronicle-time-dial"), {
      clientX: CENTER,
      clientY: CENTER - R_OUT,
    });
    expect(onMinute).toHaveBeenCalledWith(0);
  });
});
