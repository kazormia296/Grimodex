import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { load } from "js-yaml";

const root = path.resolve(import.meta.dirname, "..");

describe("Linux Electron release ABI gate", () => {
  it("builds on Ubuntu 24.04 and checks both symbols and package metadata", async () => {
    const workflow = load(
      await readFile(path.join(root, ".github/workflows/release.yml"), "utf8"),
    );
    const linux = workflow.jobs.build.strategy.matrix.include.find(
      (entry) => entry.id === "linux",
    );
    assert.equal(linux.os, "ubuntu-24.04");

    const commands = workflow.jobs.build.steps
      .map((step) => step.run)
      .filter(Boolean)
      .join("\n");
    assert.match(commands, /objdump -T/);
    assert.match(commands, /dpkg --compare-versions/);
    assert.match(commands, /dpkg-deb -f/);
    assert.match(commands, /libc6 \(>= 2\.39\)/);
    assert.match(commands, /libstdc\+\+6 \(>= 12\)/);
    assert.match(commands, /libgcc-s1/);
    assert.match(commands, /libdbus-1-3/);
    assert.match(commands, /rpm -qpR/);
    assert.match(commands, /glibc >= 2\.39/);
    assert.match(commands, /dbus-libs/);
    assert.match(commands, /rpm -qp --scripts/);
    assert.match(commands, /posttrans scriptlet/);

    const builder = load(
      await readFile(path.join(root, "electron-builder.yml"), "utf8"),
    );
    assert.deepEqual(builder.rpm.fpm, [
      "--rpm-posttrans=packaging/linux/rpm-posttrans.sh",
    ]);
    const posttrans = await readFile(
      path.join(root, "packaging/linux/rpm-posttrans.sh"),
      "utf8",
    );
    assert.match(posttrans, /rpm -q "\$\{package_name\}"/);
    assert.match(posttrans, /update-alternatives --install/);
    assert.match(posttrans, /ln -sf "\$\{app_executable\}" "\$\{launcher\}"/);
    assert.match(posttrans, /chrome-sandbox/);
    assert.match(posttrans, /apparmor-profile/);
    assert.doesNotMatch(posttrans, /rm\s+-rf?/);

    const abiStep = workflow.jobs.build.steps.find(
      (step) =>
        step.name === "Verify Linux native ABI and deb dependency floor",
    );
    const grepLine = abiStep.run
      .split("\n")
      .find((line) => line.includes("grep -oE"));
    assert.ok(grepLine, "GLIBC grep command is missing");
    const executablePipeline = `printf '%s\\n' 'symbol GLIBC_2.39 symbol GLIBC_2.4' ${grepLine
      .trim()
      .replace(/\\\s*$/, "")}`;
    const grepResult = spawnSync(
      "bash",
      ["-o", "pipefail", "-c", executablePipeline],
      {
        encoding: "utf8",
      },
    );
    assert.equal(grepResult.status, 0, grepResult.stderr);
    assert.deepEqual(grepResult.stdout.trim().split("\n"), [
      "GLIBC_2.39",
      "GLIBC_2.4",
    ]);
  });
});
