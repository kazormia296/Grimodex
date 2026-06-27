// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useRef } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { InlineAIToolbar } from "./InlineAIToolbar";
import { useInlineAiStore } from "./inlineAiStore";
import type { InlineAiStatus } from "./inlineAiTypes";

// happy-dom は getBoundingClientRect を実寸で返さない (幾何は browser test で gate)。
// ここでは可視性/owner ゲート/error 出口/キーバインドのロジックだけを検証する。

function Harness({
  isOwner = true,
  onAccept = () => {},
  onReject = () => {},
  onRetry = () => {},
}: {
  isOwner?: boolean;
  onAccept?: () => void;
  onReject?: () => void;
  onRetry?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={ref} data-testid="anchor" />
      <InlineAIToolbar
        onAccept={onAccept}
        onReject={onReject}
        onRetry={onRetry}
        anchorRef={ref}
        isOwner={isOwner}
      />
    </>
  );
}

function setStatus(status: InlineAiStatus): void {
  useInlineAiStore.setState({ status });
}

beforeEach(() => useInlineAiStore.getState().reset());
afterEach(() => {
  cleanup();
  useInlineAiStore.getState().reset();
});

describe("InlineAIToolbar visibility", () => {
  it("renders nothing when idle", () => {
    setStatus("idle");
    render(<Harness />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders nothing for a non-owner editor even when pending", () => {
    setStatus("diffShown");
    render(<Harness isOwner={false} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders Accept/Reject/Retry when diffShown for the owner", () => {
    setStatus("diffShown");
    render(<Harness isOwner />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("Accept").closest("button")).not.toBeDisabled();
    expect(screen.getByText("Reject")).toBeTruthy();
    expect(screen.getByText("↺ Retry")).toBeTruthy();
  });

  it("disables Accept (and hides Retry) while generating", () => {
    setStatus("generating");
    render(<Harness isOwner />);
    expect(screen.getByText("Accept").closest("button")).toBeDisabled();
    expect(screen.queryByText("↺ Retry")).toBeNull();
  });

  it("error state: keeps the toolbar with disabled Accept and a Retry exit", () => {
    setStatus("error");
    render(<Harness isOwner />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("Accept").closest("button")).toBeDisabled();
    expect(screen.getByText("Reject")).toBeTruthy();
    expect(screen.getByText("↺ Retry")).toBeTruthy();
  });
});

describe("InlineAIToolbar keybindings", () => {
  it("Tab accepts only while diffShown", () => {
    const onAccept = vi.fn();
    setStatus("diffShown");
    render(<Harness isOwner onAccept={onAccept} />);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it("Tab does not accept while generating", () => {
    const onAccept = vi.fn();
    setStatus("generating");
    render(<Harness isOwner onAccept={onAccept} />);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("Esc rejects/dismisses in any pending state", () => {
    const onReject = vi.fn();
    setStatus("error");
    render(<Harness isOwner onReject={onReject} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onReject).toHaveBeenCalledTimes(1);
  });
});
