import { describe, expect, it, vi } from "vitest";
import { consumeEditorSeedHandoff } from "./webEditorHandoff";

describe("consumeEditorSeedHandoff", () => {
  it("removes the one-time fragment before consuming the seed via Authorization", async () => {
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
        return Response.json({ schemaVersion: "test-editor-seed" });
      },
    );

    await expect(
      consumeEditorSeedHandoff({
        href: "https://try.grimodex.app/editor?lang=ja#scan-import=one-time%2Ftoken%3D",
        apiBaseUrl: "https://scan.example/",
        fetchImpl,
        replaceHistory,
      }),
    ).resolves.toEqual({ schemaVersion: "test-editor-seed" });

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
});
