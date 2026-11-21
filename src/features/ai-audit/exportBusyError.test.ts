import { describe, expect, it } from "vitest";
import en from "@/locales/en.json";
import ja from "@/locales/ja.json";
import {
  AI_AUDIT_EXPORT_AI_RUNNING,
  AiAuditExportBusyError,
  isAiAuditExportBusyError,
} from "./exportBusyError";

describe("AI audit export refusal while an AI execution is running", () => {
  it("has a closed code and a type guard that rejects unrelated errors", () => {
    const error = new AiAuditExportBusyError();
    expect(error.code).toBe(AI_AUDIT_EXPORT_AI_RUNNING);
    expect(isAiAuditExportBusyError(error)).toBe(true);
    expect(isAiAuditExportBusyError(new Error("autosave flush failed"))).toBe(
      false,
    );
    expect(isAiAuditExportBusyError(null)).toBe(false);
  });

  it("has the author-facing message in Japanese and English", () => {
    expect(ja.attribution.aiAudit.aiRunning).toContain("AIの実行中");
    expect(en.attribution.aiAudit.aiRunning).toContain("AI run is in progress");
    expect(ja.attribution.aiAudit.aiRunning).not.toBe(
      en.attribution.aiAudit.aiRunning,
    );
  });
});
