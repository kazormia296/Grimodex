// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MapPalette } from "./MapPalette";
import type { AiGatePresentation } from "@/features/ai-policy/evaluateAiCapability";

function renderPalette(
  presentation: AiGatePresentation,
  tooltip: string | null = null,
) {
  const onOpenAiBranch = vi.fn();
  render(
    <MapPalette
      paletteMode="default"
      onPaletteModeChange={vi.fn()}
      onAddSticky={vi.fn()}
      onOpenPicker={vi.fn()}
      onOpenAiBranch={onOpenAiBranch}
      aiBranchPresentation={presentation}
      aiBranchTooltip={tooltip}
    />,
  );
  return { onOpenAiBranch };
}

describe("MapPalette — AI Branch gate presentation", () => {
  it("enabled なら AI Branch ボタンが押せる", () => {
    const { onOpenAiBranch } = renderPalette("enabled");
    const button = screen.getByRole("button", { name: "AI Branch" });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(onOpenAiBranch).toHaveBeenCalledTimes(1);
  });

  it("hidden (policy off) なら AI Branch ボタンを描画しない", () => {
    renderPalette("hidden");
    expect(screen.queryByRole("button", { name: "AI Branch" })).toBeNull();
  });

  it("disabled (provider/model 未設定) なら disabled 表示で tooltip を出す", () => {
    const { onOpenAiBranch } = renderPalette(
      "disabled",
      "AIプロバイダが未設定です",
    );
    const button = screen.getByRole("button", { name: "AI Branch" });
    expect(button).toBeDisabled();
    expect(button.getAttribute("title")).toBe("AIプロバイダが未設定です");
    fireEvent.click(button);
    expect(onOpenAiBranch).not.toHaveBeenCalled();
  });

  it("pending なら表示したまま押せる (ちらつき防止)", () => {
    renderPalette("pending");
    const button = screen.getByRole("button", { name: "AI Branch" });
    expect(button).not.toBeDisabled();
  });
});
