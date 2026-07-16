import { describe, expect, it } from "vitest";
import { validateUploadIntent } from "./validation";

describe("upload intent validation", () => {
  it("accepts bounded text and markdown uploads", () => {
    expect(
      validateUploadIntent(
        { filename: "novel.md", contentType: "text/markdown", size: 12 },
        100,
      ),
    ).toMatchObject({
      filename: "novel.md",
      extension: ".md",
    });
  });

  it("rejects unsupported types and oversized input before issuing an upload", () => {
    expect(() =>
      validateUploadIntent(
        { filename: "novel.pdf", contentType: "application/pdf", size: 12 },
        100,
      ),
    ).toThrow("unsupported upload extension");
    expect(() =>
      validateUploadIntent(
        { filename: "novel.txt", contentType: "text/plain", size: 101 },
        100,
      ),
    ).toThrow("exceeds");
  });
});
