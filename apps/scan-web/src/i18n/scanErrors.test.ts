import { describe, expect, it } from "vitest";
import { ScanApiError } from "../api/scanApiClient";
import { scanErrorMessage } from "./scanErrors";

describe("scanErrorMessage", () => {
  it.each([
    [
      new TypeError("Failed to fetch"),
      "通信できませんでした",
      "could not connect",
    ],
    [
      new ScanApiError(429, "raw rate limit", "rate_limited"),
      "混み合っています",
      "receiving too many requests",
    ],
    [
      new ScanApiError(503, "raw outage", "internal_error"),
      "一時的に利用できません",
      "temporarily unavailable",
    ],
    [
      new ScanApiError(413, "raw too large", "source_too_large"),
      "原稿を受け付けられませんでした",
      "could not accept this manuscript",
    ],
    [
      new ScanApiError(401, "raw unauthorized", "scan_token_required"),
      "認証情報を確認できませんでした",
      "could not verify your authorization",
    ],
    [
      new Error("raw secret detail"),
      "処理を完了できませんでした",
      "could not complete",
    ],
  ])("maps errors without exposing their raw message", (cause, ja, en) => {
    expect(scanErrorMessage(cause, "ja")).toContain(ja);
    expect(scanErrorMessage(cause, "en")).toContain(en);
    expect(scanErrorMessage(cause, "ja")).not.toContain(cause.message);
    expect(scanErrorMessage(cause, "en")).not.toContain(cause.message);
  });
});
