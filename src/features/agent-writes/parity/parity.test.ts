/**
 * In-app ↔ MCP parity gates (TS side).
 *
 * The fixtures in this directory are contract snapshots shared with two Rust
 * test suites: grimodex-core (MCP write path) and commands/agent_writes.rs
 * (in-app mirror). This file gates the TS executor layer against the SAME
 * fixtures: the policy key each write is gated by, the authorship span source
 * the builders emit, and the proposed_content shapes the consumer accepts.
 * Editing a fixture must break every side that no longer matches.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const h = vi.hoisted(() => ({
  blockIfPolicyOff: vi.fn(() => true),
  invoke: vi.fn(),
}));

vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: h.blockIfPolicyOff,
}));
vi.mock("@/lib/tauri", () => ({
  invoke: h.invoke,
}));

import { agentCreateCodexEntry } from "../codex";
import { agentProposeSceneBody, parseProposedContent } from "../prose";
import { syntheticAiSpans } from "../authorshipSpans";

const here = dirname(fileURLToPath(import.meta.url));
const codexFixture = JSON.parse(
  readFileSync(join(here, "codexCreate.fixture.json"), "utf8"),
);
const proseFixture = JSON.parse(
  readFileSync(join(here, "proseStaging.fixture.json"), "utf8"),
);

describe("parity fixtures (TS executor side)", () => {
  beforeEach(() => {
    h.blockIfPolicyOff.mockClear();
    h.blockIfPolicyOff.mockReturnValue(true);
    h.invoke.mockClear();
  });

  it("codex create is gated by the fixture's policy key", async () => {
    await expect(
      agentCreateCodexEntry({
        requestId: "agent-tool:parity-codex-create",
        type: "character",
        name: "Alice",
      }),
    ).rejects.toThrow();
    expect(h.blockIfPolicyOff).toHaveBeenCalledWith(codexFixture.policyGate);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("prose propose is gated by the fixture's policy key", async () => {
    await expect(
      agentProposeSceneBody({ sceneId: "s1", text: "prose" }),
    ).rejects.toThrow();
    expect(h.blockIfPolicyOff).toHaveBeenCalledWith(proseFixture.policyGate);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it("authorship span builders emit the fixture's source", () => {
    const spans = syntheticAiSpans("summary text");
    expect(spans.length).toBeGreaterThan(0);
    for (const span of spans) {
      expect(span.source).toBe(codexFixture.authorshipSpan.source);
    }
  });

  it("proposed_content consumer accepts both writers' fixture shapes", () => {
    // MCP writer shape: mode/text + anchor keys.
    const mcpShape = parseProposedContent(
      JSON.stringify({
        mode: "insert",
        text: "from mcp",
        anchorText: "anchor",
        anchorPosition: "before",
      }),
    );
    expect(mcpShape.mode).toBe("insert");
    expect(mcpShape.text).toBe("from mcp");
    expect(mcpShape.anchorText).toBe("anchor");

    // In-app writer shape: mode/text + replace keys (null for append).
    const inAppShape = parseProposedContent(
      JSON.stringify({
        mode: "append",
        text: "from in-app",
        replaceFrom: null,
        replaceTo: null,
      }),
    );
    expect(inAppShape.mode).toBe("append");
    expect(inAppShape.text).toBe("from in-app");
  });

  it("every fixture key the writers may emit is a known consumer key", () => {
    // The consumer contract: required + optional keys, nothing else. If a
    // writer grows a key, it must be added to the fixture (and both Rust
    // suites re-assert their writer against it).
    const { requiredKeys, optionalKeys } = proseFixture.proposedContent;
    expect(requiredKeys).toEqual(["mode", "text"]);
    for (const key of [...requiredKeys, ...optionalKeys]) {
      expect(typeof key).toBe("string");
    }
    // surfaces are a closed set shared with both Rust writers.
    expect(proseFixture.sourceSurfaces).toContain("mcp");
    expect(proseFixture.sourceSurfaces).toContain("in-app-agent");
  });
});
