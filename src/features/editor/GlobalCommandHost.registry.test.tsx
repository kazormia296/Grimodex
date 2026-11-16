// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/application/lifecycle/quiescenceLease", () => ({
  canScheduleQuiescenceMutation: () => true,
}));

import { runRegisteredAppCommand } from "@/features/commands/appCommandRegistry";
import { GlobalCommandHost } from "./GlobalCommandHost";

afterEach(cleanup);

describe("GlobalCommandHost — registry への文脈の登録", () => {
  it("mount 中はキー以外の呼び出し元も、host の props で run でき、unmount で外れる", () => {
    const onOpenSettings = vi.fn();
    const view = render(
      <GlobalCommandHost
        phoneWorkspace
        runtimeCapabilities={
          {
            genericProjectTransfer: false,
          } as unknown as import("@/runtime/runtimeCapabilities").RuntimeCapabilities
        }
        onToggleExport={() => {}}
        onOpenSettings={onOpenSettings}
      />,
    );
    expect(runRegisteredAppCommand("openSettings")).toEqual({ ok: true });
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    // phone の文脈が使われる（overlay は phone では開かない）。
    expect(runRegisteredAppCommand("toggleLeftOverlay")).toEqual({
      ok: false,
      reason: "unavailable",
    });

    view.unmount();
    expect(runRegisteredAppCommand("openSettings")).toEqual({
      ok: false,
      reason: "no-host",
    });
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
