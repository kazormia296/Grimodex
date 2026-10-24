import { describe, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { debugLog, rootCause } from "./debugLog";
import { D2A_RESTRICTED_DB_EXECUTE_DENIAL } from "./d2aRestrictedGenericSql.testSupport";
import { d2aFailureText, d2aMessageText } from "./d2aFailureText";

// DA-2b (K3/2 "D の扱い", Negative (11); DR-DA2B-R5): the failure displays
// outside the startup graph (settings, export, Vivliostyle, kouetsu, Map,
// Codex tags, matrix, the chat panel's Codex approval) show a D2a refusal as
// the generic text: no raw marker, no statement or params, no blame on a
// connection or a CLI. Anything else keeps the display's own text.

const GENERIC = rootCause(new Error(D2A_RESTRICTED_DB_EXECUTE_DENIAL));

function refusedQuery(): DrizzleQueryError {
  return new DrizzleQueryError(
    'select "id", "title" from "tree_nodes" where "tree_nodes"."project_id" = ?',
    ["secret-project-id"],
    new Error(D2A_RESTRICTED_DB_EXECUTE_DENIAL),
  );
}

describe("d2aFailureText", () => {
  it("shows a bare D2a refusal as the generic text instead of the display's text", () => {
    const error = new Error(
      "D2A_EGRESS_DENIED: external-url: route test_ai_connection is unavailable in profile local-only mode",
    );
    const shown = d2aFailureText(error, `接続失敗: ${error.message}`);
    expect(shown).toBe(GENERIC);
    expect(shown).not.toContain("D2A_EGRESS_DENIED");
    expect(shown).not.toContain("接続失敗");
  });

  it("shows a Drizzle-wrapped refusal without the statement or its params", () => {
    const error = refusedQuery();
    expect(String(error)).toContain("Failed query");
    const shown = d2aFailureText(error, String(error));
    expect(shown).toBe(GENERIC);
    for (const leaked of [
      "Failed query",
      "tree_nodes",
      "params",
      "secret-project-id",
      "D2A_EGRESS_DENIED",
    ]) {
      expect(shown).not.toContain(leaked);
    }
  });

  it("keeps the refusal and its reason code in the debug log, without the params", () => {
    const warn = vi.spyOn(debugLog, "warn").mockImplementation(() => {});
    try {
      d2aFailureText(refusedQuery(), "unused");
      expect(warn).toHaveBeenCalledTimes(1);
      const detail = String(warn.mock.calls[0]?.[2]);
      expect(detail).toContain("D2A_EGRESS_DENIED: plaintext-publication");
      expect(detail).not.toContain("secret-project-id");
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the display's own text for any other failure", () => {
    const warn = vi.spyOn(debugLog, "warn").mockImplementation(() => {});
    try {
      expect(
        d2aFailureText(new Error("spawn failed"), "Error: spawn failed"),
      ).toBe("Error: spawn failed");
      expect(d2aFailureText("license server down", "license server down")).toBe(
        "license server down",
      );
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("d2aMessageText", () => {
  it("shows a stored refusal message as the generic text and keeps any other", () => {
    expect(d2aMessageText(`Error: ${D2A_RESTRICTED_DB_EXECUTE_DENIAL}`)).toBe(
      GENERIC,
    );
    expect(d2aMessageText("HTTP 401 Unauthorized")).toBe(
      "HTTP 401 Unauthorized",
    );
  });
});
