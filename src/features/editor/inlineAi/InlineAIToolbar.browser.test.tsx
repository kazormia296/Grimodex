/**
 * 実 Chromium で動かす InlineAIToolbar の幾何 invariant。happy-dom は
 * getBoundingClientRect を実寸で返さないため、「ツールバーが anchor (= owner
 * エディタの本文コンテナ) の下端中央に張り付く」ことはブラウザで測って gate する。
 * 画面下部中央固定への退行 (下 Stripe にツールがあると本文から乖離するバグ) を防ぐ。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { useRef } from "react";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { InlineAIToolbar } from "./InlineAIToolbar";
import { useInlineAiStore } from "./inlineAiStore";
import type { InlineAiStatus } from "./inlineAiTypes";

const ANCHOR = { left: 200, top: 100, width: 400, height: 300 } as const;

function Harness({
  isOwner = true,
  anchorStyle,
}: {
  isOwner?: boolean;
  anchorStyle?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <>
      <div
        ref={ref}
        data-testid="anchor"
        style={{
          position: "fixed",
          left: ANCHOR.left,
          top: ANCHOR.top,
          width: ANCHOR.width,
          height: ANCHOR.height,
          ...anchorStyle,
        }}
      />
      <InlineAIToolbar
        onAccept={() => {}}
        onReject={() => {}}
        onRetry={() => {}}
        anchorRef={ref}
        isOwner={isOwner}
      />
    </>
  );
}

function setStatus(status: InlineAiStatus): void {
  useInlineAiStore.setState({ status });
}

beforeEach(() => {
  useInlineAiStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useInlineAiStore.getState().reset();
});

describe("InlineAIToolbar geometry (browser)", () => {
  it("anchors to the bottom-center of the anchor element when owner + pending", async () => {
    setStatus("diffShown");
    render(<Harness isOwner />);

    const toolbar = await screen.findByRole("status");
    const tb = toolbar.getBoundingClientRect();
    const anchor = screen.getByTestId("anchor").getBoundingClientRect();

    const anchorCenterX = anchor.left + anchor.width / 2;
    const toolbarCenterX = tb.left + tb.width / 2;

    // Horizontally centered on the anchor.
    expect(Math.abs(toolbarCenterX - anchorCenterX)).toBeLessThanOrEqual(2);
    // Bottom edge sits ~12px above the anchor's bottom edge.
    expect(Math.abs(tb.bottom - (anchor.bottom - 12))).toBeLessThanOrEqual(3);
    // Never pinned to the viewport bottom when the anchor is fully visible.
    expect(tb.bottom).toBeLessThan(window.innerHeight - 20);
  });

  it("clamps to the viewport bottom when the anchor extends past the fold", async () => {
    setStatus("diffShown");
    render(
      <Harness
        isOwner
        anchorStyle={{ top: window.innerHeight - 100, height: 600 }}
      />,
    );
    const toolbar = await screen.findByRole("status");
    const tb = toolbar.getBoundingClientRect();
    // bottom: max(8, …) → 8px above the viewport bottom.
    expect(Math.abs(tb.bottom - (window.innerHeight - 8))).toBeLessThanOrEqual(
      3,
    );
  });

  it("does not render for a non-owner editor (no split-view double toolbar)", async () => {
    setStatus("diffShown");
    render(<Harness isOwner={false} />);
    // Give the portal a chance to mount, then assert it never did.
    await waitFor(() => {
      expect(screen.queryByRole("status")).toBeNull();
    });
  });

  it("does not render when idle", async () => {
    setStatus("idle");
    render(<Harness isOwner />);
    await waitFor(() => {
      expect(screen.queryByRole("status")).toBeNull();
    });
  });
});
