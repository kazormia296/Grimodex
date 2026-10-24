// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useRef } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { InlineAIToolbar } from "./InlineAIToolbar";
import { useInlineAiStore } from "./inlineAiStore";
import type { InlineAiStatus } from "./inlineAiTypes";
import i18next from "@/lib/i18n";
import {
  PROFILE_EGRESS_AI_STOP_TRANSLATIONS,
  ensureProfileEgressAiStopTranslations,
} from "@/features/profile-egress/profileEgressAiStopText";

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

beforeEach(async () => {
  useInlineAiStore.getState().reset();
  await i18next.changeLanguage("ja");
});
afterEach(async () => {
  cleanup();
  useInlineAiStore.getState().reset();
  await i18next.changeLanguage("ja");
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

  it("announces status transitions via an explicit aria-live region", () => {
    setStatus("generating");
    render(<Harness isOwner />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  });

  it.each([
    ["ja", "反映", "破棄", "再試行"],
    ["en", "Accept", "Reject", "Retry"],
  ] as const)(
    "renders localized action labels and invokes callbacks (%s)",
    async (language, acceptLabel, rejectLabel, retryLabel) => {
      const onAccept = vi.fn();
      const onReject = vi.fn();
      const onRetry = vi.fn();
      await i18next.changeLanguage(language);
      setStatus("diffShown");
      render(
        <Harness
          isOwner
          onAccept={onAccept}
          onReject={onReject}
          onRetry={onRetry}
        />,
      );

      const accept = screen.getByRole("button", {
        name: new RegExp(acceptLabel),
      });
      const reject = screen.getByRole("button", {
        name: new RegExp(rejectLabel),
      });
      const retry = screen.getByRole("button", {
        name: new RegExp(retryLabel),
      });
      expect(accept).toHaveTextContent(acceptLabel);
      expect(reject).toHaveTextContent(rejectLabel);
      expect(retry).toHaveTextContent(retryLabel);

      fireEvent.click(accept);
      fireEvent.click(reject);
      fireEvent.click(retry);

      expect(onAccept).toHaveBeenCalledTimes(1);
      expect(onReject).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledTimes(1);
    },
  );

  it("renders the Japanese action labels when diffShown for the owner", () => {
    setStatus("diffShown");
    render(<Harness isOwner />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByRole("button", { name: /反映/ })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /破棄/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /再試行/ })).toBeTruthy();
  });

  it("disables Accept (and hides Retry) while generating", () => {
    setStatus("generating");
    render(<Harness isOwner />);
    expect(screen.getByRole("button", { name: /反映/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /再試行/ })).toBeNull();
  });

  it("error state: keeps the toolbar with disabled Accept and a Retry exit", () => {
    setStatus("error");
    render(<Harness isOwner />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByRole("button", { name: /反映/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /破棄/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /再試行/ })).toBeTruthy();
  });
});

describe("InlineAIToolbar profile activation terminal (DA-2 D-10 (a))", () => {
  it("keeps the fixed failure text until the reason strings are registered, then shows the reason", () => {
    useInlineAiStore.setState({
      status: "error",
      error: "D2A_EGRESS_DENIED: profile-activation-stopped",
    });
    const { unmount } = render(<Harness isOwner />);
    expect(screen.getByRole("status").textContent).toContain(
      i18next.t("inlineAi.generateFailed"),
    );
    expect(screen.getByRole("status").textContent).not.toContain(
      "D2A_EGRESS_DENIED",
    );
    unmount();
    ensureProfileEgressAiStopTranslations();
    render(<Harness isOwner />);
    expect(screen.getByRole("status").textContent).toContain(
      PROFILE_EGRESS_AI_STOP_TRANSLATIONS.ja.stopped,
    );
  });

  it("keeps the fixed failure text for any other error", () => {
    ensureProfileEgressAiStopTranslations();
    useInlineAiStore.setState({ status: "error", error: "provider failed" });
    render(<Harness isOwner />);
    expect(screen.getByRole("status").textContent).toContain(
      i18next.t("inlineAi.generateFailed"),
    );
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
