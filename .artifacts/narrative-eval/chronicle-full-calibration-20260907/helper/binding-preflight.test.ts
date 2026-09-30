import { describe, expect, it } from "vitest";

import {
  loadHelperManifest,
  validateManifestShape,
  verifyImmutableBinding,
} from "./live-driver.mjs";

describe("Chronicle Luna helper immutable binding", () => {
  it("loads the exact helper manifest and candidate bindings", async () => {
    const loaded = await loadHelperManifest();
    expect(validateManifestShape(loaded.manifest)).toBe(true);
    expect(loaded.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    await expect(verifyImmutableBinding(loaded.manifest)).resolves.toBe(true);
  });
});
