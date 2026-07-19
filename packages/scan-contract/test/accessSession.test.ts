import { describe, expect, it } from "vitest";
import {
  ACCESS_SESSION_SCHEMA_VERSION,
  parseAccessSession,
} from "../src/accessSession";

describe("Access session contract", () => {
  it("accepts a bounded pseudonymous account session", () => {
    expect(
      parseAccessSession({
        schemaVersion: ACCESS_SESSION_SCHEMA_VERSION,
        subject: "access-subject-123",
        expiresAt: "2026-07-20T00:00:00.000Z",
        fullScanEnabled: true,
        hostedEditorAiEnabled: true,
      }),
    ).toEqual({
      ok: true,
      value: {
        schemaVersion: "grimodex/access-session/1",
        subject: "access-subject-123",
        expiresAt: "2026-07-20T00:00:00.000Z",
        fullScanEnabled: true,
        hostedEditorAiEnabled: true,
      },
    });
  });

  it.each([
    { subject: "" },
    { subject: "x".repeat(129) },
    { expiresAt: "not-a-date" },
    { fullScanEnabled: "true" },
    { hostedEditorAiEnabled: 1 },
  ])("rejects an invalid session field %#", (override) => {
    expect(
      parseAccessSession({
        schemaVersion: ACCESS_SESSION_SCHEMA_VERSION,
        subject: "access-subject-123",
        expiresAt: "2026-07-20T00:00:00.000Z",
        fullScanEnabled: false,
        hostedEditorAiEnabled: false,
        ...override,
      }).ok,
    ).toBe(false);
  });
});
