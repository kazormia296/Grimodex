// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NodeProps } from "@xyflow/react";
import {
  _resetQuiescenceParticipantsForTests,
  flushQuiescenceParticipants,
} from "@/application/lifecycle/quiescenceParticipants";
import { FrameNode } from "./FrameNode";

vi.mock("@xyflow/react", () => ({
  NodeResizer: () => null,
}));

function makeProps(onTitleChange: (title: string) => Promise<void>): NodeProps {
  return {
    id: "frame:frame-1",
    data: {
      title: "Original frame",
      background: "#fff",
      borderColor: "#000",
      onTitleChange,
    },
    selected: true,
  } as unknown as NodeProps;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("FrameNode title draft lifecycle", () => {
  beforeEach(() => {
    _resetQuiescenceParticipantsForTests();
  });

  afterEach(() => {
    _resetQuiescenceParticipantsForTests();
  });

  it("ignores composition keys and persists the active draft on strict flush", async () => {
    const onTitleChange = vi.fn().mockResolvedValue(undefined);
    render(<FrameNode {...makeProps(onTitleChange)} />);
    fireEvent.doubleClick(screen.getByText("Original frame"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "変換中 frame" } });

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });

    expect(onTitleChange).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue("変換中 frame");

    await flushQuiescenceParticipants();
    expect(onTitleChange).toHaveBeenCalledWith("変換中 frame", {
      preexistingDraft: true,
    });
  });

  it("編集中の再ダブルクリックで入力値を元タイトルへ戻さない", () => {
    const onTitleChange = vi.fn().mockResolvedValue(undefined);
    render(<FrameNode {...makeProps(onTitleChange)} />);
    fireEvent.doubleClick(screen.getByText("Original frame"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "編集中の frame" } });

    fireEvent.doubleClick(input);

    expect(screen.getByRole("textbox")).toHaveValue("編集中の frame");
    expect(onTitleChange).not.toHaveBeenCalled();
  });

  it("保存中の追加入力を再保存し、最新値の成功まで編集を閉じない", async () => {
    const first = deferred();
    const latest = deferred();
    const onTitleChange = vi
      .fn<(title: string) => Promise<void>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => latest.promise);
    render(<FrameNode {...makeProps(onTitleChange)} />);
    fireEvent.doubleClick(screen.getByText("Original frame"));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "最初の frame" },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });

    await waitFor(() => {
      expect(onTitleChange).toHaveBeenNthCalledWith(1, "最初の frame");
    });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "最新の frame" },
    });

    first.resolve();
    await waitFor(() => {
      expect(onTitleChange).toHaveBeenNthCalledWith(2, "最新の frame");
    });
    expect(screen.getByRole("textbox")).toHaveValue("最新の frame");

    latest.resolve();
    await waitFor(() => {
      expect(screen.queryByRole("textbox")).toBeNull();
    });
  });
});
