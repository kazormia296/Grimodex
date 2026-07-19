import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EditorSeedV1, ScanBundleV1 } from "../src/index.js";
import {
  buildEditorHandoffUrl,
  parseEditorHandoffEnvelope,
} from "../src/editorHandoff";

async function validEditorSeed(): Promise<EditorSeedV1> {
  const fixturePath = fileURLToPath(
    new URL("./fixtures/minimal-ja.json", import.meta.url),
  );
  const bundle = JSON.parse(
    await readFile(fixturePath, "utf8"),
  ) as ScanBundleV1;
  return {
    schemaVersion: "grimodex-scan/editor-seed/1",
    bundle,
    source: {
      schemaVersion: "grimodex-scan/source-document/1",
      title: bundle.source.title,
      language: bundle.source.language,
      fingerprint: bundle.source.fingerprint,
      sections: bundle.sections.map((section) => ({
        id: section.id,
        ordinal: section.ordinal,
        title: section.title,
        paragraphIds: section.paragraphIds,
      })),
      paragraphs: [
        {
          id: "paragraph:0:0:1111111111111111111111111111111111111111111111111111111111111111",
          sectionId:
            "section:0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ordinal: 0,
          text: "葵は灯台の窓を開けた。",
        },
        {
          id: "paragraph:0:1:2222222222222222222222222222222222222222222222222222222222222222",
          sectionId:
            "section:0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ordinal: 1,
          text: "白灯台には古い手紙が残っていた。",
        },
      ],
    },
  };
}

describe("buildEditorHandoffUrl", () => {
  it("places only the one-time editor token in the URL fragment", () => {
    const href = buildEditorHandoffUrl(
      "https://try.grimodex.app/editor",
      "one-time/token=",
    );
    const url = new URL(href);

    expect(url.origin).toBe("https://try.grimodex.app");
    expect(url.pathname).toBe("/editor");
    expect(url.search).toBe("");
    expect(url.hash).toBe("#scan-import=one-time%2Ftoken%3D");
    expect(href).not.toContain("scan-secret");
  });

  it("replaces any stale query or fragment on the configured Editor URL", () => {
    const href = buildEditorHandoffUrl(
      "https://try.grimodex.app/editor?old=value#stale",
      "fresh-token",
    );

    expect(href).toBe(
      "https://try.grimodex.app/editor#scan-import=fresh-token",
    );
  });

  it("carries a concrete Scan UI language beside the token in the scrubbed fragment", () => {
    const href = buildEditorHandoffUrl(
      "https://try.grimodex.app/editor?old=value#stale",
      "fresh-token",
      "en",
    );
    const url = new URL(href);

    expect(url.search).toBe("");
    expect(new URLSearchParams(url.hash.slice(1)).get("scan-import")).toBe(
      "fresh-token",
    );
    expect(new URLSearchParams(url.hash.slice(1)).get("ui-language")).toBe(
      "en",
    );
  });
});

describe("parseEditorHandoffEnvelope", () => {
  it("validates the seed and the scoped hosted AI session together", async () => {
    const seed = await validEditorSeed();
    const result = parseEditorHandoffEnvelope({
      schemaVersion: "grimodex/editor-handoff/1",
      seed,
      hostedAiSession: {
        scanId: "11111111-1111-4111-8111-111111111111",
        token: "a".repeat(64),
        expiresAt: "2026-07-20T00:00:00.000Z",
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        schemaVersion: "grimodex/editor-handoff/1",
        seed,
        hostedAiSession: {
          scanId: "11111111-1111-4111-8111-111111111111",
          token: "a".repeat(64),
          expiresAt: "2026-07-20T00:00:00.000Z",
        },
      },
    });
  });

  it.each([
    ["raw seed response", (seed: EditorSeedV1) => seed],
    [
      "short session token",
      (seed: EditorSeedV1) => ({
        schemaVersion: "grimodex/editor-handoff/1",
        seed,
        hostedAiSession: {
          scanId: "11111111-1111-4111-8111-111111111111",
          token: "not-high-entropy",
          expiresAt: "2026-07-20T00:00:00.000Z",
        },
      }),
    ],
    [
      "invalid expiry",
      (seed: EditorSeedV1) => ({
        schemaVersion: "grimodex/editor-handoff/1",
        seed,
        hostedAiSession: {
          scanId: "11111111-1111-4111-8111-111111111111",
          token: "b".repeat(64),
          expiresAt: "tomorrow",
        },
      }),
    ],
    [
      "mutated seed",
      (seed: EditorSeedV1) => ({
        schemaVersion: "grimodex/editor-handoff/1",
        seed: {
          ...seed,
          source: { ...seed.source, fingerprint: "sha256:tampered" },
        },
        hostedAiSession: {
          scanId: "11111111-1111-4111-8111-111111111111",
          token: "c".repeat(64),
          expiresAt: "2026-07-20T00:00:00.000Z",
        },
      }),
    ],
  ])("rejects a %s", async (_label, createValue) => {
    const result = parseEditorHandoffEnvelope(
      createValue(await validEditorSeed()),
    );

    expect(result.ok).toBe(false);
  });
});
