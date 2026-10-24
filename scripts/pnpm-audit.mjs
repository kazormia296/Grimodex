import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The unpatched advisory is currently reachable only as a dev-tool dependency with got's HTTP cache disabled.
// Revisit this exception by the end of 2026-11-17 in Asia/Tokyo; no patched http-cache-semantics exists as of 2026-10-17.
if (Date.now() >= Date.parse("2026-11-18T00:00:00+09:00")) {
  throw new Error("GHSA-ch52-4w7c-c8xp audit exception expired");
}

// Any change to the reviewed dependency tree or builder options requires a fresh risk decision.
const auditFiles = new Map();
for (const [path, expected] of Object.entries({
  "package.json":
    "dd112820d877a104e406f31b61f46310d7f9b0a08601bbbf0c0999a8c80b2d03",
  "pnpm-lock.yaml":
    "c4f75b93493642391ad807a42117714e38446c25208791b7964a2e86490be3dd",
  "pnpm-workspace.yaml":
    "9ed861aee69a45baaaa5ce32c36c4f299d4cf467cd02c6462ff4bf8f0ad20551",
  "electron-builder.yml":
    "5c78bc304e01c550c03beabb422907ca86fcf8921f5136e87ae49676d60a1bf4",
})) {
  const contents = readFileSync(path);
  if (createHash("sha256").update(contents).digest("hex") !== expected) {
    throw new Error(
      `GHSA-ch52-4w7c-c8xp audit exception needs review: ${path} changed`,
    );
  }
  if (path !== "electron-builder.yml") auditFiles.set(path, contents);
}

// Seed the scratch config; pnpm audit --ignore only writes config and skips the audit.
const auditRoot = mkdtempSync(join(tmpdir(), "grimodex-pnpm-audit-"));
try {
  for (const [path, contents] of auditFiles) {
    writeFileSync(
      join(auditRoot, path),
      path === "pnpm-workspace.yaml"
        ? Buffer.concat([
            Buffer.from(
              "auditConfig:\n  ignoreGhsas:\n    - GHSA-ch52-4w7c-c8xp\n\n",
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
