import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { toast } from "sonner";
import i18next from "@/lib/i18n";
import {
  WORKSPACE_QUARANTINED_TOAST_ID,
  notifyIfWorkspaceQuarantined,
  notifyWorkspaceQuarantined,
} from "./notifyWorkspaceQuarantined";

const quarantined = () =>
  Object.assign(new Error("WORKSPACE_QUARANTINED: fenced"), {
    code: "WORKSPACE_QUARANTINED",
  });

describe("notifyWorkspaceQuarantined", () => {
  beforeEach(() => vi.clearAllMocks());

  it("固定 id の sticky toast を出す（重ねて呼んでも同じ id で 1 つになる）", () => {
    notifyWorkspaceQuarantined();
    expect(toast.error).toHaveBeenCalledWith(
      i18next.t("autoSave.workspaceQuarantined"),
      { id: WORKSPACE_QUARANTINED_TOAST_ID, duration: Infinity },
    );
  });

  it("quarantine の拒否（cause の中でも）だけ案内して true を返す", () => {
    expect(notifyIfWorkspaceQuarantined(quarantined())).toBe(true);
    expect(
      notifyIfWorkspaceQuarantined(
        new Error("wrapped", { cause: quarantined() }),
      ),
    ).toBe(true);
    expect(toast.error).toHaveBeenCalledTimes(2);

    vi.clearAllMocks();
    expect(notifyIfWorkspaceQuarantined(new Error("boom"))).toBe(false);
    expect(notifyIfWorkspaceQuarantined("WORKSPACE_SWITCHING")).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
