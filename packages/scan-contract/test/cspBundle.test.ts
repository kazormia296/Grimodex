import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { build } from "vite";

const VIRTUAL_ENTRY = "virtual:scan-contract-csp-entry";
const RESOLVED_VIRTUAL_ENTRY = "\0scan-contract-csp-entry";
const scanContractEntry = fileURLToPath(
  new URL("../src/index.ts", import.meta.url),
).replaceAll("\\", "/");

describe("scan-contract CSP bundle", () => {
  it("does not bundle string-based JavaScript compilation", async () => {
    const result = await build({
      configFile: false,
      logLevel: "silent",
      plugins: [
        {
          name: "scan-contract-csp-probe",
          resolveId(id) {
            return id === VIRTUAL_ENTRY ? RESOLVED_VIRTUAL_ENTRY : null;
          },
          load(id) {
            if (id !== RESOLVED_VIRTUAL_ENTRY) return null;
            return [
              `import { validateScanBundle } from ${JSON.stringify(scanContractEntry)};`,
              "globalThis.__grimodexScanValidatorCspProbe = validateScanBundle;",
            ].join("\n");
          },
        },
      ],
      build: {
        write: false,
        minify: false,
        target: "es2022",
        rollupOptions: { input: VIRTUAL_ENTRY },
      },
    });

    const buildResults = Array.isArray(result) ? result : [result];
    const bundled = buildResults
      .flatMap((item) => ("output" in item ? item.output : []))
      .filter((item) => item.type === "chunk")
      .map((item) => item.code)
      .join("\n");

    expect(bundled).toContain("__grimodexScanValidatorCspProbe");
    expect(bundled).toContain("must have required property 'source'");
    expect(bundled).not.toMatch(/\b(?:new\s+)?Function\s*\(/u);
    expect(bundled).not.toMatch(/\beval\s*\(/u);
    expect(bundled).not.toMatch(/\brequire\s*\(/u);
    expect(bundled).not.toContain("ajv/dist/compile");
  });
});
