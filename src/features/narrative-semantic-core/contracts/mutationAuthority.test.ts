import { describe, expect, it } from "vitest";

import {
  MUTATION_AUTHORITY_ROUTES,
  assertMutationAuthorityContext,
  allowedCallersForRoute,
  conditionalControlsForRoute,
  authorityRouteForUnambiguousOrigin,
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

  it("does not infer a route from the ambiguous ai-apply origin", () => {
    expect(authorityRouteForUnambiguousOrigin("human")).toBe("human-direct");
    expect(authorityRouteForUnambiguousOrigin("import")).toBe("import-apply");
    expect(() =>
      authorityRouteForUnambiguousOrigin("ai-apply" as never),
    ).toThrow(/ai-apply|unambiguous/i);
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

  it("does not allow unknown or versioned background callers to use the interactive agent route", () => {
    expect(() =>
      assertMutationAuthorityContext({
        origin: "ai-apply",
        authorityRoute: "interactive-agent-command",
        caller: "background-maintenance",
        controls: requiredControlsForRoute("interactive-agent-command"),
        provenance: { requestId: "request-1", traceId: "trace-1" },
      }),
    ).toThrow(/forbidden caller/i);
    expect(() =>
      assertMutationAuthorityContext({
        origin: "ai-apply",
        authorityRoute: "interactive-agent-command",
        caller: "background-maintenance-v2",
        controls: requiredControlsForRoute("interactive-agent-command"),
        provenance: { requestId: "request-1", traceId: "trace-1" },
      }),
    ).toThrow(/forbidden caller/i);
  });

  it("binds each route to its origin and explicit caller allowlist", () => {
    expect(allowedCallersForRoute("interactive-agent-command")).toEqual([
      "chat-tool-executor",
      "manual-wrapper",
      "registered-agent-surface",
    ]);
    expect(() =>
      assertMutationAuthorityContext({
        origin: "import",
        authorityRoute: "interactive-agent-command",
        caller: "chat-tool-executor",
        controls: requiredControlsForRoute("interactive-agent-command"),
        provenance: { requestId: "request-1", traceId: "trace-1" },
      }),
    ).toThrow(/origin/i);
    expect(() =>
      assertMutationAuthorityContext({
        origin: "import",
        authorityRoute: "import-apply",
        caller: "reconciler",
        controls: requiredControlsForRoute("import-apply"),
      }),
    ).toThrow(/forbidden caller/i);
  });

  it("requires Field Authority only when the mutation targets protected fields", () => {
    expect(conditionalControlsForRoute("human-direct")).toEqual([
      "field-authority",
    ]);
    expect(conditionalControlsForRoute("interactive-agent-command")).toEqual(
      [],
    );
    expect(() =>
      assertMutationAuthorityContext({
        origin: "ai-apply",
        authorityRoute: "interactive-agent-command",
        caller: "chat-tool-executor",
        controls: requiredControlsForRoute("interactive-agent-command").filter(
          (control) => control !== "field-authority",
        ),
        provenance: { requestId: "request-1", traceId: "trace-1" },
      }),
    ).toThrow(/required control.*field-authority/i);
    const base = {
      origin: "human" as const,
      authorityRoute: "human-direct" as const,
      caller: "human-ui",
      controls: requiredControlsForRoute("human-direct"),
    };
    expect(() => assertMutationAuthorityContext(base)).not.toThrow();
    expect(() =>
      assertMutationAuthorityContext({
        ...base,
        writesAuthorityProtectedField: true,
      }),
    ).toThrow(/field-authority/i);
    expect(() =>
      assertMutationAuthorityContext({
        ...base,
        writesAuthorityProtectedField: true,
        controls: [
          ...requiredControlsForRoute("human-direct"),
          "field-authority",
        ],
      }),
    ).not.toThrow();
  });

  it("requires complete history replay lineage", () => {
    expect(() =>
      assertMutationAuthorityContext({
        origin: "undo",
        authorityRoute: "history-replay",
        caller: "history-controller",
        controls: requiredControlsForRoute("history-replay"),
      }),
    ).toThrow(/lineage/i);
    expect(() =>
      assertMutationAuthorityContext({
        origin: "undo",
        authorityRoute: "history-replay",
        caller: "history-controller",
        controls: requiredControlsForRoute("history-replay"),
        originalTransactionId: "tx-1",
        undoJournalId: "journal-1",
      }),
    ).not.toThrow();
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
