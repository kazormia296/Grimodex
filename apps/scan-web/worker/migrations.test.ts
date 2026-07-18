import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));

describe("Cloudflare D1 migrations", () => {
  it("never disables D1 foreign-key enforcement", async () => {
    const files = (await readdir(migrationsDir))
      .filter((file) => /^\d{4}_.+\.sql$/.test(file))
      .sort();
    const violations: string[] = [];

    for (const file of files) {
      const sql = await readFile(`${migrationsDir}/${file}`, "utf8");
      for (const [index, line] of sql.split(/\r?\n/).entries()) {
        if (/\bPRAGMA\s+foreign_keys\s*=\s*(?:OFF|0)\b/i.test(line)) {
          violations.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
