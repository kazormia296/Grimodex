// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnstileWidget } from "./TurnstileWidget";

describe("TurnstileWidget", () => {
  afterEach(() => {
    cleanup();
    delete window.turnstile;
  });

  it("passes the locale to Turnstile and re-renders when it changes", () => {
    const renderWidget = vi
      .fn()
      .mockReturnValueOnce("widget-1")
      .mockReturnValueOnce("widget-2");
    const removeWidget = vi.fn();
    window.turnstile = {
      render: renderWidget,
      reset: vi.fn(),
      remove: removeWidget,
    };
    const onToken = vi.fn();
    const onError = vi.fn();
    const view = render(
      <TurnstileWidget
        siteKey="site-key"
        resetKey={0}
        locale="ja"
        onToken={onToken}
        onError={onError}
      />,
    );

    expect(renderWidget).toHaveBeenLastCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ language: "ja" }),
    );

    view.rerender(
      <TurnstileWidget
        siteKey="site-key"
        resetKey={0}
        locale="en"
        onToken={onToken}
        onError={onError}
      />,
    );

    expect(renderWidget).toHaveBeenCalledTimes(2);
    expect(removeWidget).toHaveBeenCalledTimes(1);
    expect(removeWidget).toHaveBeenCalledWith("widget-1");
    expect(renderWidget).toHaveBeenLastCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ language: "en" }),
    );
  });
});
