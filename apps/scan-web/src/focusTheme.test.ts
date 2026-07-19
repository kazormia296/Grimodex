import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

describe("Scan light focus treatment", () => {
  it("uses the high-contrast primary token for keyboard focus", () => {
    expect(styles).toMatch(
      /button:focus-visible,[\s\S]*?select:focus-visible\s*\{[\s\S]*?outline:\s*2px solid var\(--primary\);/,
    );
  });
});
