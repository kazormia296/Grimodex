import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseScanBundle,
  validateScanBundle,
  type ScanBundleV1,
} from "../src/index.js";

async function readFixture(): Promise<unknown> {
  const fixturePath = fileURLToPath(
    new URL("./fixtures/minimal-ja.json", import.meta.url),
  );
  return JSON.parse(await readFile(fixturePath, "utf8")) as unknown;
}

describe("ScanBundleV1 contract", () => {
  it("accepts the minimal Japanese fixture", async () => {
    const result = validateScanBundle(await readFixture());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.schemaVersion).toBe("grimodex-scan/1");
      expect(result.value.sections).toHaveLength(1);
    }
  });

  it("returns a typed bundle from parseScanBundle", async () => {
    const result = parseScanBundle(await readFixture());

    expect(result.ok).toBe(true);
    if (result.ok) {
      const bundle: ScanBundleV1 = result.value;
      expect(bundle.entities[0]?.name).toBe("葵");
    }
  });

  it("rejects evidence that points to a missing paragraph", async () => {
    const fixture = (await readFixture()) as Record<string, unknown>;
    const sections = fixture.sections as Array<Record<string, unknown>>;
    const entities = fixture.entities as Array<Record<string, unknown>>;
    const evidence = (entities[0]?.evidence ?? []) as Array<
      Record<string, unknown>
    >;
    evidence[0] = {
      ...evidence[0],
      paragraphId: "paragraph:0:9:deadbeef",
    };
    sections[0] = { ...sections[0] };

    const result = validateScanBundle(fixture);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.code === "missing-reference")).toBe(
        true,
      );
    }
  });

  it("rejects a phase whose anchors move backwards", async () => {
    const fixture = (await readFixture()) as Record<string, unknown>;
    const phases = fixture.phases as Array<Record<string, unknown>>;
    phases[0] = {
      ...phases[0],
      anchors: [...(phases[0]?.anchors as unknown[])].reverse(),
    };

    const result = validateScanBundle(fixture);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.code === "phase-order")).toBe(
        true,
      );
    }
  });

  it("rejects duplicate IDs and relation self-loops", async () => {
    const fixture = (await readFixture()) as Record<string, unknown>;
    const entities = fixture.entities as Array<Record<string, unknown>>;
    entities[1] = { ...entities[1], id: entities[0]?.id };
    const relations = fixture.relations as Array<Record<string, unknown>>;
    relations[0] = {
      ...relations[0],
      fromEntityId: entities[0]?.id,
      toEntityId: entities[0]?.id,
    };

    const result = validateScanBundle(fixture);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.code === "duplicate-id")).toBe(
        true,
      );
      expect(result.errors.some((error) => error.code === "relation-self-loop")).toBe(
        true,
      );
    }
  });
});
