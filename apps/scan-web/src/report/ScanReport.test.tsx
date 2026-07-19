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

  it("exposes the destructive Scan deletion action only when it is provided", () => {
    const onDelete = vi.fn();
    const { getByRole, queryByRole, rerender } = render(
      <ScanReport bundle={createMinimalJaBundle()} onDelete={onDelete} />,
    );

    fireEvent.click(getByRole("button", { name: "原稿とScanデータを削除" }));
    expect(onDelete).toHaveBeenCalledOnce();

    rerender(<ScanReport bundle={createMinimalJaBundle()} />);
    expect(
      queryByRole("button", { name: "原稿とScanデータを削除" }),
    ).toBeNull();
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

  it("renders report navigation, counts, and actions in English", () => {
    const { getByRole, getByText } = render(
      <ScanReport bundle={createMinimalJaBundle()} locale="en" />,
    );

    expect(getByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(getByRole("heading", { name: "Characters & places" })).toBeTruthy();
    expect(getByRole("heading", { name: "Story phases" })).toBeTruthy();
    expect(getByText(/characters · 1 section · 2 paragraphs/)).toBeTruthy();
    expect(getByText("Writing language: Japanese (detected)")).toBeTruthy();
  });

  it("translates every entity type in the Scan contract", () => {
    const japanese = createMinimalJaBundle();
    japanese.entities[0]!.type = "object";
    japanese.entities[1]!.type = "alias";
    const { getByText, rerender } = render(
      <ScanReport bundle={japanese} locale="ja" />,
    );

    expect(getByText("物品")).toBeTruthy();
    expect(getByText("別名")).toBeTruthy();

    rerender(<ScanReport bundle={japanese} locale="en" />);
    expect(getByText("Object")).toBeTruthy();
    expect(getByText("Alias")).toBeTruthy();
  });
});
