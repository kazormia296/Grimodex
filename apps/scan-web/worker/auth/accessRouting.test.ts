import { describe, expect, it } from "vitest";
import { routeRequiresAccount } from "./accessRouting";

describe("Scan account route boundary", () => {
  it.each([
    ["GET", "/api/v1/session"],
    ["POST", "/api/v1/upload-intents"],
    ["PUT", "/api/v1/uploads/upload-1"],
    ["POST", "/api/v1/uploads/upload-1/complete"],
    ["POST", "/api/v1/scans"],
    ["GET", "/api/v1/scans/scan-1"],
    ["DELETE", "/api/v1/scans/scan-1"],
    ["POST", "/api/v1/scans/scan-1/editor-ai"],
    ["DELETE", "/api/v1/public-reports/public-1"],
    ["GET", "/api/v1/editor-seeds"],
  ])("requires an account for %s %s", (method, pathname) => {
    expect(routeRequiresAccount(method, pathname)).toBe(true);
  });

  it.each([
    ["OPTIONS", "/api/v1/scans"],
    ["GET", "/api/v1/health"],
    ["GET", "/api/v1/ai-disclosures/scan"],
    ["GET", "/api/v1/public-reports/public-1"],
    ["POST", "/api/v1/public-reports/public-1/abuse-reports"],
  ])("keeps %s %s anonymous", (method, pathname) => {
    expect(routeRequiresAccount(method, pathname)).toBe(false);
  });
});
