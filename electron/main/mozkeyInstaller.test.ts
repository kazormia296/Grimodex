import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createMozkeyInstallerManager } from "./mozkeyInstaller.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "grimodex-mozkey-test-"));
  roots.push(root);
  return root;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function releaseFetch(
  assetName: string,
  payload: Uint8Array,
  downloadedPayload: Uint8Array = payload,
) {
  const checksum = `${sha256(payload)}  ${assetName}\n`;
  const release = {
    tag_name: "v1.2.3",
    draft: false,
    prerelease: true,
    assets: [
      {
        name: assetName,
        browser_download_url: `https://github.com/kazormia296/mozkey-ibg/releases/download/v1.2.3/${assetName}`,
        size: payload.byteLength,
      },
      {
        name: "SHA256SUMS",
        browser_download_url:
          "https://github.com/kazormia296/mozkey-ibg/releases/download/v1.2.3/SHA256SUMS",
        size: checksum.length,
      },
    ],
  };

  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/releases?per_page=10")) {
      return new Response(JSON.stringify([release]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/SHA256SUMS")) {
      return new Response(checksum, { status: 200 });
    }
    if (url.endsWith(`/${assetName}`)) {
      return new Response(downloadedPayload, {
        status: 200,
        headers: { "content-length": String(downloadedPayload.byteLength) },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
  vi.restoreAllMocks();
});

describe("MozkeyInstallerManager", () => {
  it("downloads the matching Windows package, verifies SHA-256, and launches it", async () => {
    const payload = new TextEncoder().encode("signed installer payload");
    const assetName = "MozkeyIbG_v1.2.3_x64.msi";
    const root = tempRoot();
    const openInstaller = vi.fn().mockResolvedValue("");
    const manager = createMozkeyInstallerManager({
      fetch: releaseFetch(assetName, payload),
      platform: "win32",
      arch: "x64",
      userDataDir: root,
      openInstaller,
    });

    await expect(
      manager.handlers.mozkey_download_and_install({}),
    ).resolves.toEqual({ version: "1.2.3", assetName });

    const installedPath = path.join(root, "mozkey-installers", assetName);
    expect(readFileSync(installedPath)).toEqual(Buffer.from(payload));
    expect(openInstaller).toHaveBeenCalledWith(installedPath);
  });

  it("selects the Debian package on a Debian-family Linux host", async () => {
    const payload = new TextEncoder().encode("deb payload");
    const assetName = "mozkey-ibg_1.2.3_amd64.deb";
    const openInstaller = vi.fn().mockResolvedValue("");
    const manager = createMozkeyInstallerManager({
      fetch: releaseFetch(assetName, payload),
      platform: "linux",
      arch: "x64",
      userDataDir: tempRoot(),
      readLinuxOsRelease: vi
        .fn()
        .mockResolvedValue('ID=ubuntu\nID_LIKE="debian"\n'),
      openInstaller,
    });

    await expect(
      manager.handlers.mozkey_download_and_install({}),
    ).resolves.toEqual({ version: "1.2.3", assetName });
    expect(openInstaller).toHaveBeenCalledOnce();
  });

  it("fails closed when the downloaded package does not match SHA256SUMS", async () => {
    const expectedPayload = new TextEncoder().encode("expected");
    const downloadedPayload = new TextEncoder().encode("tampered");
    const assetName = "MozkeyIbG_v1.2.3_x64.msi";
    const root = tempRoot();
    const fetchMock = releaseFetch(
      assetName,
      expectedPayload,
      downloadedPayload,
    );
    const openInstaller = vi.fn().mockResolvedValue("");
    const manager = createMozkeyInstallerManager({
      fetch: fetchMock,
      platform: "win32",
      arch: "x64",
      userDataDir: root,
      openInstaller,
    });

    await expect(
      manager.handlers.mozkey_download_and_install({}),
    ).rejects.toThrow("checksum verification failed");
    expect(openInstaller).not.toHaveBeenCalled();
    expect(existsSync(path.join(root, "mozkey-installers", assetName))).toBe(
      false,
    );
  });

  it("reports that no public release is available without launching anything", async () => {
    const openInstaller = vi.fn().mockResolvedValue("");
    const manager = createMozkeyInstallerManager({
      fetch: vi.fn().mockResolvedValue(
        new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
      platform: "win32",
      arch: "x64",
      userDataDir: tempRoot(),
      openInstaller,
    });

    await expect(
      manager.handlers.mozkey_download_and_install({}),
    ).rejects.toThrow("No public Mozkey IbG release is available");
    expect(openInstaller).not.toHaveBeenCalled();
  });

  it("coalesces concurrent requests so an installer is launched only once", async () => {
    const payload = new TextEncoder().encode("installer");
    const assetName = "MozkeyIbG_v1.2.3_x64.msi";
    const openInstaller = vi.fn().mockResolvedValue("");
    const manager = createMozkeyInstallerManager({
      fetch: releaseFetch(assetName, payload),
      platform: "win32",
      arch: "x64",
      userDataDir: tempRoot(),
      openInstaller,
    });

    const first = manager.handlers.mozkey_download_and_install({});
    const second = manager.handlers.mozkey_download_and_install({});
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(openInstaller).toHaveBeenCalledOnce();
  });
});
