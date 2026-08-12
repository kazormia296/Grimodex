import { describe, it, expect } from "vitest";
import { isNewImportSessionPipelinePreferred } from "./importTarget";

describe("isNewImportSessionPipelinePreferred", () => {
  it("is false unless VITE_GRIMODEX_IMPORT_SESSION_PIPELINE=new", () => {
    expect(isNewImportSessionPipelinePreferred()).toBe(
      import.meta.env.VITE_GRIMODEX_IMPORT_SESSION_PIPELINE === "new",
    );
  });
});
