import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { ESLint } from "eslint";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const BOUNDARY_RULE_ID = "grimodex-boundaries/narrative-maintenance";

async function lintText(code, filePath) {
  const eslint = new ESLint({ cwd: repoRoot });
  const [result] = await eslint.lintText(code, {
    filePath: path.resolve(repoRoot, filePath),
  });
  return result.messages;
}

function boundaryMessages(messages) {
  return messages.filter(({ ruleId }) => ruleId === BOUNDARY_RULE_ID);
}

test("rejects narrative maintenance imports from renderer and preload", async () => {
  for (const filePath of [
    "src/features/example.ts",
    "electron/preload/index.ts",
  ]) {
    const messages = await lintText(
      'import { createNarrativeMaintenanceScheduler } from "../../electron/main/narrativeMaintenance.js";',
      filePath,
    );
    assert.equal(boundaryMessages(messages).length, 1);
  }
});

test("rejects exposing a private maintenance method from preload", async () => {
  for (const code of [
    `contextBridge.exposeInMainWorld("grimodex", {
      runNarrativeMaintenanceCycle: () => Promise.resolve(),
    });`,
    `contextBridge.exposeInMainWorld("grimodex", {
      ["runNarrativeMaintenanceCycle"]: () => Promise.resolve(),
    });`,
    "const method = backend['runNarrativeMaintenanceCycle'];",
    "const method = backend[`runNarrativeMaintenanceCycle`];",
    "const privateMethods = ['runNarrativeMaintenanceCycle'];",
  ]) {
    const messages = await lintText(code, "electron/preload/index.ts");
    assert.equal(boundaryMessages(messages).length, 1);
  }
});

test("rejects literal dynamic imports of the main or native backend", async () => {
  for (const source of [
    "electron/main/narrativeMaintenance.js",
    "electron/native/grimodex-node/index.js",
  ]) {
    const messages = await lintText(
      `void import("${source}");`,
      "src/features/example.ts",
    );
    assert.equal(boundaryMessages(messages).length, 1);
  }
});

test("rejects static template imports of the main and native backend", async () => {
  for (const source of [
    "electron/main/narrativeMaintenance.js",
    "electron/native/grimodex-node/index.js",
    "electron/native/grimodex-node",
  ]) {
    const messages = await lintText(
      `void import(\`${source}\`);`,
      "src/features/example.ts",
    );
    assert.equal(boundaryMessages(messages).length, 1);
  }
});

test("rejects native directory imports without a trailing slash", async () => {
  const messages = await lintText(
    'import type { NativeBinding } from "electron/native/grimodex-node";',
    "src/features/example.ts",
  );
  assert.equal(boundaryMessages(messages).length, 1);
});

test("does not resolve expression-containing templates", async () => {
  const messages = await lintText(
    'const method = backend[`${"runNarrativeMaintenanceCycle"}`];',
    "electron/preload/index.ts",
  );
  assert.deepEqual(boundaryMessages(messages), []);
});

test("allows the main owner and ordinary renderer bridge code", async () => {
  const mainMessages = await lintText(
    'import { createNarrativeMaintenanceScheduler } from "./narrativeMaintenance.js";',
    "electron/main/narrativeMaintenanceBootstrap.ts",
  );
  const rendererMessages = await lintText(
    "export const bridge = { invoke: (cmd: string) => window.grimodex.invoke(cmd) };",
    "src/lib/bridge.ts",
  );
  assert.deepEqual(boundaryMessages(mainMessages), []);
  assert.deepEqual(boundaryMessages(rendererMessages), []);
});
