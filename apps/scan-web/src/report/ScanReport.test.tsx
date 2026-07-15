// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMinimalJaBundle } from "../fixtures/minimalJa";
import { ScanReport } from "./ScanReport";

describe("ScanReport", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the fixture report with list fallbacks and evidence controls", () => {
    const onOpenEditor = vi.fn();
    const { getByRole, getAllByTestId, getByText } = render(
      <ScanReport
        bundle={createMinimalJaBundle()}
        onOpenEditor={onOpenEditor}
      />,
    );

    expect(getByText("灯台の手紙")).toBeTruthy();
    expect(getAllByTestId("scan-entity-card")).toHaveLength(2);
    expect(getByRole("button", { name: "この作品を編集する" })).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "この作品を編集する" }));
    expect(onOpenEditor).toHaveBeenCalledOnce();
  });

  it("reveals evidence and records explicit finding feedback", () => {
    const onFeedback = vi.fn();
    const { getByRole, getByText } = render(
      <ScanReport bundle={createMinimalJaBundle()} onFeedback={onFeedback} />,
    );

    fireEvent.click(getByText("手紙の宛先は要確認"));
    expect(getByText("手紙の宛先が本文からは読み取れない")).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "意図的として扱う" }));
    expect(onFeedback).toHaveBeenCalledWith(
      "finding:66666666-6666-4666-8666-666666666666",
      "intentional",
    );
  });
});
