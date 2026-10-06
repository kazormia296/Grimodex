import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The unpatched advisory is currently reachable only as a dev-tool dependency with got's HTTP cache disabled.
// Revisit this exception by the end of 2026-10-17 in Asia/Tokyo.
if (Date.now() >= Date.parse("2026-10-18T00:00:00+09:00")) {
  throw new Error("GHSA-ch52-4w7c-c8xp audit exception expired");
}

// Any change to the reviewed dependency tree or builder options requires a fresh risk decision.
const auditFiles = new Map();
for (const [path, expected] of Object.entries({
  "package.json":
    "21a2397c0da237019979a63cfef091c42540770175250e3e12cd385121c86065",
  "pnpm-lock.yaml":
    "a95628046e43b70d64b2beb370688eff1c03d05c9e13ee7b8989b0e723333c28",
  "pnpm-workspace.yaml":
    "9913bee7cbb1ad3804ca3cc9c4ebcac9fb15270c83903869a58b9325b447e32b",
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
