import { describe, expect, it } from "vitest";
import { BROWSER_DIRECT_AI_PROVIDERS } from "@/features/chat/browserProviderPolicy";
import { AI_RUNTIME_ROUTES } from "./aiPathRegistry";

describe("Web Editor AI runtime route registry", () => {
  it("registers one user-selected route for every HTTP provider", () => {
    expect(AI_RUNTIME_ROUTES.map(({ id }) => id)).toEqual(["browser_byok_web"]);
    expect(AI_RUNTIME_ROUTES[0]).toMatchObject({
      consentRoute: "byok",
      providerAuthority: "user-selection",
      providers: BROWSER_DIRECT_AI_PROVIDERS,
    });
    expect(AI_RUNTIME_ROUTES[0].capabilityGate).toMatch(
      /actual (?:connection )?destination/i,
    );
    expect(AI_RUNTIME_ROUTES[0].providers).not.toContain("cli");
    expect(AI_RUNTIME_ROUTES[0].note).toMatch(/no app-owned credential/i);
  });
});
