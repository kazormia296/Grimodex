import { describe, expect, it } from "vitest";

import { readPersistedCodexAppServerSettings } from "./persistedSettings.js";

describe("persisted Codex App Server settings", () => {
  it("reads a Codex binary path and approval opt-in from the native snapshot", async () => {
    const backend = {
      getAiSettings: async () =>
        JSON.stringify({
          provider: "cli",
          cli: {
            kind: "codex",
            binaryPath: " /opt/codex ",
            codexAllowApprovals: true,
          },
        }),
    };

    await expect(readPersistedCodexAppServerSettings(backend)).resolves.toEqual(
      {
        binaryPath: "/opt/codex",
        allowApprovals: true,
      },
    );
  });

  it("fails closed for missing, malformed, or non-Codex settings", async () => {
    await expect(readPersistedCodexAppServerSettings(null)).resolves.toEqual({
      binaryPath: null,
      allowApprovals: false,
    });
    await expect(
      readPersistedCodexAppServerSettings({
        getAiSettings: async () => "not json",
      }),
    ).resolves.toEqual({ binaryPath: null, allowApprovals: false });
    await expect(
      readPersistedCodexAppServerSettings({
        getAiSettings: async () =>
          JSON.stringify({
            provider: "cli",
            cli: {
              kind: "claude",
              binaryPath: "/tmp/codex",
              codexAllowApprovals: true,
            },
          }),
      }),
    ).resolves.toEqual({ binaryPath: null, allowApprovals: false });
  });
});
