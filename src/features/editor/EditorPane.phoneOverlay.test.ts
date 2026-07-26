// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useClosePhoneReorderOverlay } from "./EditorPane";

describe("useClosePhoneReorderOverlay", () => {
  it("closes an open desktop reorder overlay when the viewport enters phone mode", () => {
    const closeOverlay = vi.fn();
    const { rerender } = renderHook(
      ({ phoneWorkspace, open }) =>
        useClosePhoneReorderOverlay({
          phoneWorkspace,
          open,
          closeOverlay,
        }),
      {
        initialProps: {
          phoneWorkspace: false,
          open: true,
        },
      },
    );

    expect(closeOverlay).not.toHaveBeenCalled();

    rerender({ phoneWorkspace: true, open: true });

    expect(closeOverlay).toHaveBeenCalledTimes(1);
  });
});
