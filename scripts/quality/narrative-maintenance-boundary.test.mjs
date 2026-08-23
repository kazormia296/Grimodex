import assert from "node:assert/strict";
import test from "node:test";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";

import narrativeMaintenanceBoundaryRule from "./narrative-maintenance-boundary-rule.mjs";

async function lintText(code, filePath) {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.{ts,tsx}"],
        languageOptions: { parser: tseslint.parser },
        plugins: {
          local: { rules: { "narrative-maintenance-boundary": narrativeMaintenanceBoundaryRule } },
        },
        rules: { "local/narrative-maintenance-boundary": "error" },
      },
    ],
  });
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages;
}

test("rejects narrative maintenance imports from renderer and preload", async () => {
  for (const filePath of ["src/features/example.ts", "electron/preload/index.ts"]) {
    const messages = await lintText(
      'import { createNarrativeMaintenanceScheduler } from "../../electron/main/narrativeMaintenance.js";',
      filePath,
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.ruleId, "local/narrative-maintenance-boundary");
  }
});

test("rejects exposing a private maintenance method from preload", async () => {
  const messages = await lintText(
    `contextBridge.exposeInMainWorld("grimodex", {
      runNarrativeMaintenanceCycle: () => Promise.resolve(),
    });`,
    "electron/preload/index.ts",
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.ruleId, "local/narrative-maintenance-boundary");
});

test("allows the main owner and ordinary renderer bridge code", async () => {
  const mainMessages = await lintText(
    'import { createNarrativeMaintenanceScheduler } from "./narrativeMaintenance.js";',
    "electron/main/narrativeMaintenanceBootstrap.ts",
  );
  const rendererMessages = await lintText(
    'export const bridge = { invoke: (cmd: string) => window.grimodex.invoke(cmd) };',
    "src/lib/bridge.ts",
  );
  assert.deepEqual(mainMessages, []);
  assert.deepEqual(rendererMessages, []);
});
