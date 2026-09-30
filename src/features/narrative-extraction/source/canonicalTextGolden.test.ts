import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import canonicalTextFixtures from "../../../../evals/fixtures/narrative/canonical-text-v1.json";
import {
  serializeProseMirrorDocument,
  type PersistedProseMirrorSchema,
} from "./proseMirrorSerializer";

interface CanonicalTextFixture {
  readonly id: string;
  readonly schema: "database" | "file-backed";
  readonly document: Record<string, unknown>;
  readonly canonicalText: string;
  readonly canonicalDigest: string;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

describe("gdx-canonical-text/1 golden fixtures", () => {
  it.each(canonicalTextFixtures as CanonicalTextFixture[])(
    "$id matches the shared canonical text and digest",
    (fixture) => {
      const result = serializeProseMirrorDocument(
        JSON.stringify(fixture.document),
        fixture.schema as PersistedProseMirrorSchema,
      );

      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;

      expect(result.canonical.text).toBe(fixture.canonicalText);
      expect(result.canonical.text.length).toBe(fixture.canonicalText.length);
      expect(digest(result.canonical.text)).toBe(fixture.canonicalDigest);
    },
  );
});
