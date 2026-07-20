import { describe, expect, it } from "vitest";
import {
  createAiDataConsentRecord,
  isAiDataConsentCurrent,
} from "./aiDataConsent";

const byokDisclosureIdentity = {
  policyVersion: "2026-07-19.1",
  route: "byok" as const,
  provider: "openai",
  destination: "https://api.openai.com",
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
      destination: "https://api.openai.com",
      acceptedAt: "2026-07-19T01:02:03.000Z",
    });
    expect(isAiDataConsentCurrent(record, byokDisclosureIdentity)).toBe(true);
  });

  it.each([
    ["policy version", { policyVersion: "2026-07-20.1" }],
    ["provider", { provider: "anthropic" }],
    ["destination", { destination: "https://api.example.test" }],
  ])("requires renewed consent when the %s changes", (_label, change) => {
    const record = createAiDataConsentRecord(
      byokDisclosureIdentity,
      "2026-07-19T01:02:03.000Z",
    );
    const currentDisclosure = { ...byokDisclosureIdentity, ...change };

    expect(isAiDataConsentCurrent(record, currentDisclosure)).toBe(false);
  });

  it("rejects consent left by a retired hosted route", () => {
    expect(
      isAiDataConsentCurrent(
        {
          ...byokDisclosureIdentity,
          route: "hosted-editor",
          acceptedAt: "2026-07-19T01:02:03.000Z",
        },
        byokDisclosureIdentity,
      ),
    ).toBe(false);
  });

  it.each([
    "policyVersion",
    "route",
    "provider",
    "destination",
    "acceptedAt",
  ] as const)(
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
