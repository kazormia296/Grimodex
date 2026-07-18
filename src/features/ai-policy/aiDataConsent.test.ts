import { describe, expect, it } from "vitest";
import {
  createAiDataConsentRecord,
  isAiDataConsentCurrent,
} from "./aiDataConsent";

const byokDisclosureIdentity = {
  policyVersion: "2026-07-19.1",
  route: "byok" as const,
  provider: "openai",
};

describe("BYOK-local AI data consent", () => {
  it("records the policy version, route, and provider that were accepted", () => {
    const record = createAiDataConsentRecord(
      byokDisclosureIdentity,
      "2026-07-19T01:02:03.000Z",
    );

    expect(record).toMatchObject({
      policyVersion: "2026-07-19.1",
      route: "byok",
      provider: "openai",
      acceptedAt: "2026-07-19T01:02:03.000Z",
    });
    expect(isAiDataConsentCurrent(record, byokDisclosureIdentity)).toBe(true);
  });

  it.each([
    ["policy version", { policyVersion: "2026-07-20.1" }],
    ["provider", { provider: "anthropic" }],
    ["route", { route: "hosted-editor" as const }],
  ])("requires renewed consent when the %s changes", (_label, change) => {
    const record = createAiDataConsentRecord(
      byokDisclosureIdentity,
      "2026-07-19T01:02:03.000Z",
    );
    const currentDisclosure = { ...byokDisclosureIdentity, ...change };

    expect(isAiDataConsentCurrent(record, currentDisclosure)).toBe(false);
  });

  it.each(["policyVersion", "route", "provider", "acceptedAt"] as const)(
    "fails closed when a stored consent record is missing %s",
    (field) => {
      const record = createAiDataConsentRecord(
        byokDisclosureIdentity,
        "2026-07-19T01:02:03.000Z",
      ) as unknown as Record<string, unknown>;
      delete record[field];

      expect(isAiDataConsentCurrent(record, byokDisclosureIdentity)).toBe(
        false,
      );
    },
  );

  it("fails closed for malformed persisted consent instead of trusting partial data", () => {
    expect(isAiDataConsentCurrent(null, byokDisclosureIdentity)).toBe(false);
    expect(
      isAiDataConsentCurrent(
        {
          ...byokDisclosureIdentity,
          acceptedAt: "not-a-timestamp",
        },
        byokDisclosureIdentity,
      ),
    ).toBe(false);
  });
});
