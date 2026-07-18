import { describe, expect, it, vi } from "vitest";
import { createMinimalJaSeed } from "../../../../apps/scan-web/src/fixtures/minimalJa";
import { consumeEditorSeedHandoff } from "./webEditorHandoff";

describe("consumeEditorSeedHandoff", () => {
  it("removes the one-time fragment before consuming the seed via Authorization", async () => {
    const seed = createMinimalJaSeed();
    const envelope = {
      schemaVersion: "grimodex/editor-handoff/1" as const,
      seed,
      hostedAiSession: {
        scanId: "11111111-1111-4111-8111-111111111111",
        token: "a".repeat(64),
        expiresAt: "2026-07-20T00:00:00.000Z",
      },
    };
    const events: string[] = [];
    const replaceHistory = vi.fn((href: string) => {
      events.push("replace-history");
      expect(href).toBe("https://try.grimodex.app/editor?lang=ja");
      expect(href).not.toContain("one-time");
    });
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        events.push("fetch-seed");
        expect(String(input)).toBe("https://scan.example/api/v1/editor-seeds");
        expect(String(input)).not.toContain("one-time");
        expect(init?.method).toBe("GET");
        expect(init?.cache).toBe("no-store");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer one-time/token=",
        );
        return Response.json(envelope);
      },
    );

    await expect(
      consumeEditorSeedHandoff({
        href: "https://try.grimodex.app/editor?lang=ja#scan-import=one-time%2Ftoken%3D",
        apiBaseUrl: "https://scan.example/",
        fetchImpl,
        replaceHistory,
      }),
    ).resolves.toEqual(envelope);

    expect(events).toEqual(["replace-history", "fetch-seed"]);
    expect(replaceHistory).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("leaves a standalone Editor launch untouched when no handoff exists", async () => {
    const replaceHistory = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      consumeEditorSeedHandoff({
        href: "https://try.grimodex.app/editor",
        apiBaseUrl: "https://scan.example",
        fetchImpl,
        replaceHistory,
      }),
    ).resolves.toBeNull();

    expect(replaceHistory).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed when the Worker returns an unvalidated handoff", async () => {
    const replaceHistory = vi.fn();
    const fetchImpl = vi.fn(async () =>
      Response.json({ schemaVersion: "grimodex-scan/editor-seed/1" }),
    );

    await expect(
      consumeEditorSeedHandoff({
        href: "https://try.grimodex.app/editor#scan-import=one-time",
        apiBaseUrl: "https://scan.example",
        fetchImpl,
        replaceHistory,
      }),
    ).rejects.toThrow("Editor handoff response is invalid");

    expect(replaceHistory).toHaveBeenCalledOnce();
  });
});
