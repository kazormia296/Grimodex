import { describe, expect, it, vi } from "vitest";

// With the constant overridden (the Session C-1 wording, D-13 (a);
// DR-DA2B-R7) the notice also names the restriction.
vi.mock("@/features/profile-egress/profileActivationAvailability", () => ({
  PROFILE_ACTIVATION_UI_ENABLED: true,
}));

import { chatImportNotice } from "./chatImportNotice";

describe("chatImportNotice with the activation UI enabled", () => {
  it("gives the count and the restricted reason", async () => {
    const notice = await chatImportNotice(2);
    expect(notice).toContain("2");
    expect(notice).toContain("外部送信を制限中");
    expect(notice).not.toContain("完了");
  });
});
