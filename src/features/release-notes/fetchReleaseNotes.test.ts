// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fetchReleaseNotes, hasJaReleaseNotes } from "./fetchReleaseNotes";

describe("fetchReleaseNotes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns primary when ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: url.includes(".ja.md"),
      })) as unknown as typeof fetch,
    );
    const result = await fetchReleaseNotes("0.10.4", "ja");
    expect(result).toEqual({
      src: "RELEASE_NOTES/v0.10.4.ja.md",
      isFallback: false,
    });
  });

  it("falls back to ja when en primary missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: url.endsWith(".ja.md"),
      })) as unknown as typeof fetch,
    );
    const result = await fetchReleaseNotes("0.10.4", "en");
    expect(result).toEqual({
      src: "RELEASE_NOTES/v0.10.4.ja.md",
      isFallback: true,
    });
  });

  it("returns null when both fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })) as unknown as typeof fetch,
    );
    expect(await fetchReleaseNotes("0.10.4", "en")).toBeNull();
  });
});

describe("hasJaReleaseNotes", () => {
  it("checks ja path only", async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: url.includes(".ja.md"),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    expect(await hasJaReleaseNotes("0.10.4")).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/RELEASE_NOTES/v0.10.4.ja.md");
  });
});
