// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

// 表示ゲートは policy: getVisibleInlineAiCommands() → isAiFeatureBlockedByPolicy。
vi.mock("@/features/ai-policy/policyGuard", () => ({
  isAiFeatureBlockedByPolicy: vi.fn(() => false),
}));
// useAiGate は memo の再評価トリガーとしてのみ使う (プロバイダ readiness ストアを
// 引き込まないよう固定値でモック)。
vi.mock("@/features/ai-policy/useAiGate", () => ({
  useAiGate: () => ({ presentation: "enabled", tooltip: null, capability: {} }),
}));
// 位置・フォーカス・portal は AnimatedDropdown 自身のテスト範囲。ここでは open 時に
// children をそのまま出す薄いスタブにして、コマンド一覧とコールバックを検証する。
vi.mock("@/components/ui/animated-dropdown", () => ({
  AnimatedDropdown: ({
    open,
    children,
  }: {
    open: boolean;
    children: ReactNode;
  }) => (open ? children : null),
}));

import { isAiFeatureBlockedByPolicy } from "@/features/ai-policy/policyGuard";
import { BubbleAiMenu } from "./BubbleAiMenu";

const mockBlocked = vi.mocked(isAiFeatureBlockedByPolicy);

describe("BubbleAiMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBlocked.mockReturnValue(false);
  });
  afterEach(() => cleanup());

  it("shows the AI trigger when bodyWrite is allowed", () => {
    render(<BubbleAiMenu onCommand={vi.fn()} />);
    expect(screen.getByTestId("bubble-ai")).toHaveClass("h-6", "min-w-[24px]");
  });

  it("renders null (no trigger) when bodyWrite policy is off", () => {
    mockBlocked.mockReturnValue(true);
    render(<BubbleAiMenu onCommand={vi.fn()} />);
    expect(screen.queryByTestId("bubble-ai")).not.toBeInTheDocument();
  });

  it("keeps the submenu closed until the trigger is clicked", () => {
    render(<BubbleAiMenu onCommand={vi.fn()} />);
    expect(screen.queryByTestId("bubble-ai-rewrite")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("bubble-ai"));
    expect(screen.getByTestId("bubble-ai-rewrite")).toBeInTheDocument();
  });

  it("lists only needsSelection commands (no insert-mode/structural ones)", () => {
    render(<BubbleAiMenu onCommand={vi.fn()} />);
    fireEvent.click(screen.getByTestId("bubble-ai"));
    for (const id of ["rewrite", "shorten", "expand", "tone", "translate"]) {
      expect(screen.getByTestId(`bubble-ai-${id}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId("bubble-ai-continue")).not.toBeInTheDocument();
    expect(screen.queryByTestId("bubble-ai-sceneBeat")).not.toBeInTheDocument();
  });

  it("forwards a non-arg command (rewrite) to onCommand and closes", () => {
    const onCommand = vi.fn();
    render(<BubbleAiMenu onCommand={onCommand} />);
    fireEvent.click(screen.getByTestId("bubble-ai"));
    fireEvent.click(screen.getByTestId("bubble-ai-rewrite"));
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand.mock.calls[0][0].id).toBe("rewrite");
    // クリックで閉じる。
    expect(screen.queryByTestId("bubble-ai-rewrite")).not.toBeInTheDocument();
  });

  it("forwards an arg-requiring command (tone) as well", () => {
    const onCommand = vi.fn();
    render(<BubbleAiMenu onCommand={onCommand} />);
    fireEvent.click(screen.getByTestId("bubble-ai"));
    fireEvent.click(screen.getByTestId("bubble-ai-tone"));
    expect(onCommand).toHaveBeenCalledWith(
      expect.objectContaining({ id: "tone", needsArg: true }),
    );
  });
});
