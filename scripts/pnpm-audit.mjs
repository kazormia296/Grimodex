import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Audit a scratch copy of the manifests with a pinned pnpm and no ignored advisories.
// GHSA-ch52-4w7c-c8xp was resolved by http-cache-semantics 4.3.0 (the registry marks <=4.2.0 as vulnerable).
const auditRoot = mkdtempSync(join(tmpdir(), "grimodex-pnpm-audit-"));
try {
  for (const path of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
    writeFileSync(join(auditRoot, path), readFileSync(path));
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
