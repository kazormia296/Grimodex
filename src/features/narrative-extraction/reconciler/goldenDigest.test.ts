import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { digestStableJson, stableJsonStringify } from "../source/digest";

interface GoldenFixture {
  readonly envelope: Record<string, unknown> & {
    readonly readSet: readonly Record<string, unknown>[];
  };
  readonly expected: {
    readonly canonicalJson: string;
    readonly readSetDigest: string;
    readonly envelopeDigest: string;
  };
}

const fixture = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../evals/fixtures/narrative/reconciliation-envelope-v1.json",
    ),
    "utf8",
  ),
) as GoldenFixture;

describe("Proposal Revision Envelope canonical digest golden", () => {
  it("matches the shared canonical JSON and SHA-256 contract", async () => {
    expect(stableJsonStringify(fixture.envelope)).toBe(
      fixture.expected.canonicalJson,
    );
    await expect(digestStableJson(fixture.envelope.readSet)).resolves.toBe(
      fixture.expected.readSetDigest,
    );
    await expect(digestStableJson(fixture.envelope)).resolves.toBe(
      fixture.expected.envelopeDigest,
    );
  });
});
