import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Audit a scratch copy of the manifests with a pinned pnpm.
// GHSA-ch52-4w7c-c8xp was resolved by http-cache-semantics 4.3.0 (the registry marks <=4.2.0 as vulnerable).
//
// Temporary exception (decided by the user on 2026-11-18): GHSA-fc5q-39xc-vjpf (picomatch <=4.0.7, ReDoS
// through single-branch repeated extglobs) has no published fix; the registry's latest picomatch is 4.0.7.
// In pnpm-lock.yaml picomatch is pulled by build and test tools (vite, vitest, rollup plugins,
// tinyglobby, fdir), and now also directly by `@mastra/core` (Mastra migration MP-1, 2026-11-19), which
// depends on picomatch 4.0.7. The product bundle `dist-electron/mastra-agent.cjs` includes `@mastra/core`
// from MP-3a. Decided 2026-11-19: the exception continues, and the Mastra workspace is never enabled,
// which keeps user input away from picomatch (docs/plans/mastra-mp3-decisions.md DR-MP3-14 and DR-MP3-15).
// Two checks keep that true: a static check that no product code enables a Mastra workspace or skills
// (electron/main/mastra/mastraWorkspaceDisabled.static.test.ts), and `mastra-ee-check.mjs --dist`, which pins
// the only importer of picomatch in the bundle to the workspace-skills chunk of `@mastra/core`.
// When a fixed picomatch is published, raise it and remove this exception.
// The exception ends at 2026-12-18 00:00 JST; extending it needs a fresh decision.
const TEMPORARY_IGNORED_GHSAS = [
  { id: "GHSA-fc5q-39xc-vjpf", expiresAt: "2026-12-18T00:00:00+09:00" },
];
for (const { id, expiresAt } of TEMPORARY_IGNORED_GHSAS) {
  if (Date.now() >= Date.parse(expiresAt)) {
    throw new Error(`${id} audit exception expired at ${expiresAt}`);
  }
}

// Seed the scratch config; the ignore flag of pnpm audit only writes config and skips the audit.
const auditRoot = mkdtempSync(join(tmpdir(), "grimodex-pnpm-audit-"));
try {
  for (const path of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    const contents = readFileSync(path);
    writeFileSync(
      join(auditRoot, path),
      path === "pnpm-workspace.yaml"
        ? Buffer.concat([
            Buffer.from(
              `auditConfig:\n  ignoreGhsas:\n${TEMPORARY_IGNORED_GHSAS.map(({ id }) => `    - ${id}\n`).join("")}\n`,
            ),
            contents,
          ])
        : contents,
    );
  }
  const audit = spawnSync(
    "pnpm",
    [
      "dlx",
      "pnpm@11.13.0",
      "--pm-on-fail=ignore",
      "audit",
      "--audit-level",
      "high",
    ],
    { cwd: auditRoot, stdio: "inherit" },
  );
  if (audit.error) throw audit.error;
  process.exitCode = audit.status ?? 1;
} finally {
  rmSync(auditRoot, { recursive: true, force: true });
}
