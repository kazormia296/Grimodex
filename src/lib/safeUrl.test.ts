import { describe, it, expect } from "vitest";
import { isSafeExternalUrl } from "./safeUrl";

describe("isSafeExternalUrl", () => {
  it("allows http/https/mailto", () => {
    expect(isSafeExternalUrl("https://example.com/x")).toBe(true);
    expect(isSafeExternalUrl("http://example.com")).toBe(true);
    expect(isSafeExternalUrl("mailto:a@b.com")).toBe(true);
  });

  it("rejects dangerous schemes", () => {
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeExternalUrl("data:text/html,<script>")).toBe(false);
    expect(isSafeExternalUrl("vbscript:msgbox")).toBe(false);
  });

  it("rejects relative / unparseable URLs", () => {
    expect(isSafeExternalUrl("/relative/path")).toBe(false);
    expect(isSafeExternalUrl("not a url")).toBe(false);
    expect(isSafeExternalUrl("")).toBe(false);
  });
});
