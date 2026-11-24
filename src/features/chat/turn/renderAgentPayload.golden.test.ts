import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  renderAgentConversationPayloads,
  renderAgentToolPayloads,
} from "./renderAgentPayload";

interface GoldenFixture {
  inputs: {
    histories: Record<string, unknown[]>;
    toolScenarios: Record<string, unknown[]>;
    webSearch: unknown;
  };
  cases: Array<{
    name: string;
    route: unknown;
    output: {
      histories: Record<string, string[]>;
      tools: Record<string, string[]>;
    };
  }>;
}

describe("renderAgentPayload golden", () => {
  it("matches the pre-move provider payloads byte for byte", () => {
    const fixtureBytes = readFileSync(
      new URL("./__fixtures__/renderAgentPayload/golden.json", import.meta.url),
      "utf8",
    );
    const fixture = JSON.parse(fixtureBytes) as GoldenFixture;
    const output = {
      inputs: fixture.inputs,
      cases: fixture.cases.map(({ name, route }) => ({
        name,
        route,
        output: {
          histories: Object.fromEntries(
            Object.entries(fixture.inputs.histories).map(([key, messages]) => [
              key,
              renderAgentConversationPayloads(
                route as never,
                messages as never,
              ),
            ]),
          ),
          tools: {
            none: renderAgentToolPayloads(
              route as never,
              fixture.inputs.toolScenarios.none as never,
            ),
            multiple: renderAgentToolPayloads(
              route as never,
              fixture.inputs.toolScenarios.multiple as never,
            ),
            webSearch: renderAgentToolPayloads(
              route as never,
              fixture.inputs.toolScenarios.multiple as never,
              fixture.inputs.webSearch as never,
            ),
          },
        },
      })),
    };
    expect(JSON.stringify(output)).toBe(JSON.stringify(fixture));
  });
});
