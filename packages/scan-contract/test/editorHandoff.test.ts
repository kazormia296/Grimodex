import { describe, expect, it } from "vitest";
import { buildEditorHandoffUrl } from "../src/editorHandoff";

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
});
