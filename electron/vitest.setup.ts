import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll } from "vitest";

const originalCodexHome = process.env.CODEX_HOME;
const testCodexHome = await mkdtemp(
  path.join(os.tmpdir(), "grimodex-electron-codex-home-"),
);
process.env.CODEX_HOME = testCodexHome;

afterAll(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  await rm(testCodexHome, { recursive: true, force: true });
});
