import { describe, expect, it } from "vitest";
import { BROWSER_DIRECT_AI_PROVIDERS } from "@/features/chat/browserProviderPolicy";
import { AI_RUNTIME_ROUTES } from "./aiPathRegistry";

describe("Web Editor AI runtime route registry", () => {
  it("registers only the user-selected HTTP Local LLM and BYOK route", () => {
    expect(AI_RUNTIME_ROUTES.map(({ id }) => id)).toEqual(["browser_byok_web"]);
    expect(AI_RUNTIME_ROUTES[0]).toMatchObject({
      auditOwner: "browser-runtime",
      captureLevel: "full-observable",
      consentRoute: "byok",
      providerAuthority: "user-selection",
      providers: BROWSER_DIRECT_AI_PROVIDERS,
    });
    expect(AI_RUNTIME_ROUTES[0].capabilityGate).toMatch(
      /actual (?:connection )?destination/i,
    );
    expect(AI_RUNTIME_ROUTES[0].providers).not.toContain("cli");
    expect(AI_RUNTIME_ROUTES[0].note).toMatch(/no app-owned credential/i);
    expect(AI_RUNTIME_ROUTES[0].note).toMatch(
      /complete credential-free JSON value/i,
    );
    expect(AI_RUNTIME_ROUTES[0].note).toMatch(/serialization whitespace/i);
    expect(AI_RUNTIME_ROUTES[0].note).toMatch(
      /durable journal ACK before fetch/i,
    );
    expect(AI_RUNTIME_ROUTES[0].note).toMatch(
      /prompt-free \/api\/generate \{model, stream:false\} runner preload/i,
    );
    expect(JSON.stringify(AI_RUNTIME_ROUTES)).not.toMatch(/WebGPU|WebLLM/i);
  });
});
