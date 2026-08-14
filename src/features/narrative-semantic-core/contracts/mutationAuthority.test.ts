import { describe, expect, it } from "vitest";

import {
  MUTATION_AUTHORITY_ROUTES,
  assertMutationAuthorityContext,
  isMutationAuthorityRoute,
  requiredControlsForRoute,
  type MutationAuthorityContext,
} from "./mutationAuthority";

describe("narrative mutation authority routes", () => {
  it("keeps origin and authority route as separate concepts", () => {
    const context: MutationAuthorityContext = {
      origin: "ai-apply",
      authorityRoute: "interactive-agent-command",
      caller: "chat-tool-executor",
      controls: requiredControlsForRoute("interactive-agent-command"),
      provenance: {
        requestId: "request-1",
        traceId: "trace-1",
      },
    };

    expect(context.origin).toBe("ai-apply");
    expect(context.authorityRoute).toBe("interactive-agent-command");
    expect(() => assertMutationAuthorityContext(context)).not.toThrow();
  });

  it("fails closed for unknown routes and missing route controls", () => {
    expect(isMutationAuthorityRoute("unknown")).toBe(false);
    expect(() =>
      assertMutationAuthorityContext({
        origin: "ai-apply",
        authorityRoute: "unknown" as never,
        caller: "background-maintenance",
        controls: [],
      }),
    ).toThrow(/authority route/i);

    expect(() =>
      assertMutationAuthorityContext({
        origin: "ai-apply",
        authorityRoute: "interactive-agent-command",
        caller: "chat-tool-executor",
        controls: [],
      }),
    ).toThrow(/required control/i);
  });

  it("does not allow background callers to use the interactive agent route", () => {
    expect(() =>
      assertMutationAuthorityContext({
        origin: "ai-apply",
        authorityRoute: "interactive-agent-command",
        caller: "background-maintenance",
        controls: requiredControlsForRoute("interactive-agent-command"),
        provenance: { requestId: "request-1", traceId: "trace-1" },
      }),
    ).toThrow(/forbidden caller/i);
  });

  it("exposes the complete six-route vocabulary", () => {
    expect(MUTATION_AUTHORITY_ROUTES).toEqual([
      "human-direct",
      "interactive-agent-command",
      "interpreter-projection",
      "import-apply",
      "history-replay",
      "restore-or-migration",
    ]);
  });
});
