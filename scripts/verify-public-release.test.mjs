import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { verifyPublicRelease } from "./verify-public-release.mjs";

function mockFetch() {
  const files = new Map([
    ["LICENSE", "license"],
    ["NOTICE", "notice"],
    ["RELEASE_NOTES.md", "notes"],
    [
      "provenance.json",
      JSON.stringify({
        publication: {
          repository: "kazormia296/GrimodexReleases",
          tag: "v2.0.11",
        },
      }),
    ],
    ["latest.yml", "latest"],
    ["latest-linux.yml", "linux"],
    ["latest-mac.yml", "mac"],
    [
      "latest.json",
      JSON.stringify({
        platforms: {
          win: {
            url: "https://github.com/kazormia296/GrimodexReleases/releases/download/v2.0.11/Grimodex-2.0.11-windows-x64.exe",
          },
        },
      }),
    ],
    ["Grimodex-2.0.11-windows-x64.exe", "windows"],
    ["Grimodex-2.0.11-linux-amd64.AppImage", "appimage"],
    ["Grimodex-2.0.11-linux-amd64.deb", "deb"],
    ["Grimodex-2.0.11-linux-amd64.rpm", "rpm"],
    ["Grimodex-2.0.11-mac-arm64.dmg", "dmg"],
    ["Grimodex-2.0.11-mac-arm64.zip", "zip"],
    ["Grimodex-2.0.11-mac-arm64.app.tar.gz", "archive"],
  ]);
  const assets = [...files.keys()].map((name, index) => ({
    id: index + 1,
    name,
    browser_download_url: `https://github.com/kazormia296/GrimodexReleases/releases/download/v2.0.11/${name}`,
    digest: `sha256:${createHash("sha256").update(files.get(name)).digest("hex")}`,
  }));
  const release = { tag_name: "v2.0.11", draft: false, assets };
  return async (url) => {
    if (url.includes("api.github.com")) {
      return new Response(JSON.stringify(release), { status: 200 });
    }
    const name = decodeURIComponent(url.split("/").at(-1));
    const body = files.get(name) ?? "download";
    return new Response(body, { status: 200 });
  };
}

describe("public release smoke verifier", () => {
  it("verifies anonymous tagged assets and stable latest endpoints", async () => {
    const result = await verifyPublicRelease(
      {
        repository: "kazormia296/GrimodexReleases",
        tag: "v2.0.11",
        stable: true,
      },
      mockFetch(),
    );
    assert.equal(result.tag, "v2.0.11");
    assert.equal(result.manifestPlatforms, 1);
  });

  it("rejects an unpublished release", async () => {
    const fetchImpl = async (url) => {
      if (url.includes("api.github.com")) {
        return new Response(
          JSON.stringify({ tag_name: "v2.0.11", draft: true, assets: [] }),
          { status: 200 },
        );
      }
      return new Response("missing", { status: 200 });
    };
    await assert.rejects(
      verifyPublicRelease(
        { repository: "kazormia296/GrimodexReleases", tag: "v2.0.11" },
        fetchImpl,
      ),
      /must be published/,
    );
  });
});
