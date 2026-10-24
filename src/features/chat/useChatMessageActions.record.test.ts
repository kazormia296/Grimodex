import { describe, expect, it, vi } from "vitest";

// CW 8 (K3/2 "chat の書込みの入口" 8; DR-DA2B-R2): a failed extraction record
// (a typed refusal, or a temporary D2a refusal from activation stage 4 to the
// stop confirmation) is shown and does not throw, so the extraction dialog
// closes instead of inviting a second press that would duplicate the entry.

const { updateMessageMetadata, toastError } = vi.hoisted(() => ({
  updateMessageMetadata: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock("./chatApi", () => ({ updateMessageMetadata }));
vi.mock("sonner", () => ({ toast: { error: toastError } }));

import { recordExtraction } from "./useChatMessageActions";

describe("recordExtraction", () => {
  it("records the extraction", async () => {
    updateMessageMetadata.mockResolvedValueOnce(undefined);
    await recordExtraction("m1", { extractedCodex: ["c1"] });
    expect(updateMessageMetadata).toHaveBeenCalledWith("m1", {
      extractedCodex: ["c1"],
    });
    expect(toastError).not.toHaveBeenCalled();
  });

  it.each([
    "CHAT_WRITE_REFUSED:metadata-unreadable",
    "D2A_EGRESS_DENIED: publication is closed during startup quiescence",
  ])("shows %s without the raw code and resolves", async (message) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    toastError.mockClear();
    updateMessageMetadata.mockRejectedValueOnce(new Error(message));
    await expect(
      recordExtraction("m1", { extractedSnippets: ["s1"] }),
    ).resolves.toBeUndefined();
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(String(toastError.mock.calls[0][0])).not.toContain(
      message.split(":")[0],
    );
    logged.mockRestore();
  });
});
