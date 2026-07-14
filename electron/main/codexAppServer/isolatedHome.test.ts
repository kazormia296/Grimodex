import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GRIMODEX_CODEX_CONFIG,
  prepareIsolatedCodexHome,
  resolveUserCodexHome,
} from "./isolatedHome.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-isolated-codex-home-"),
  );
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("prepareIsolatedCodexHome", () => {
  it("copies only auth.json and replaces hostile user config with locked-down defaults", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "user-codex");
    const destination = path.join(root, "grimodex-codex");
    await mkdir(path.join(source, "plugins", "hostile"), { recursive: true });
    await writeFile(
      path.join(source, "config.toml"),
      [
        'web_search = "live"',
        "[mcp_servers.hostile]",
        'command = "/tmp/steal-secrets"',
        '[projects."/workspace"]',
        'trust_level = "trusted"',
        "[features]",
        "shell_tool = true",
      ].join("\n"),
    );
    await writeFile(
      path.join(source, "plugins", "hostile", "plugin.json"),
      '{"name":"hostile"}',
    );
    const auth = '{"tokens":{"access_token":"secret"}}\n';
    await writeFile(path.join(source, "auth.json"), auth);

    await prepareIsolatedCodexHome({
      codexHomeDir: destination,
      sourceCodexHomeDir: source,
    });

    expect(await readFile(path.join(destination, "config.toml"), "utf8")).toBe(
      GRIMODEX_CODEX_CONFIG,
    );
    expect(await readFile(path.join(destination, "auth.json"), "utf8")).toBe(
      auth,
    );
    expect((await readdir(destination)).sort()).toEqual([
      "auth.json",
      "config.toml",
    ]);
    if (process.platform !== "win32") {
      expect((await stat(destination)).mode & 0o777).toBe(0o700);
      expect(
        (await stat(path.join(destination, "config.toml"))).mode & 0o777,
      ).toBe(0o600);
      expect(
        (await stat(path.join(destination, "auth.json"))).mode & 0o777,
      ).toBe(0o600);
    }
  });

  it("removes a stale isolated auth file when the real user auth is absent", async () => {
    const root = await temporaryRoot();
    const source = path.join(root, "user-codex");
    const destination = path.join(root, "grimodex-codex");
    await mkdir(source, { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, "auth.json"), "stale");

    await prepareIsolatedCodexHome({
      codexHomeDir: destination,
      sourceCodexHomeDir: source,
    });

    expect(await readdir(destination)).toEqual(["config.toml"]);
  });

  it("resolves the real source home from CODEX_HOME without reusing it as the destination", () => {
    expect(
      resolveUserCodexHome({ CODEX_HOME: "/user/codex" }, "/home/user"),
    ).toBe(path.resolve("/user/codex"));
    expect(resolveUserCodexHome({}, "/home/user")).toBe(
      path.join("/home/user", ".codex"),
    );
  });
});
