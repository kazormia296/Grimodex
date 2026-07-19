import { describe, expect, it } from "vitest";
import { AI_RUNTIME_ROUTES } from "./aiPathRegistry";

describe("OpenRouter hosted AI route registry", () => {
  it("names the split Workers AI, Terra, and Luna server routes", () => {
    const scan = AI_RUNTIME_ROUTES.find(
      ({ id }) => id === "scan_upload_hosted",
    );
    const editor = AI_RUNTIME_ROUTES.find(
      ({ id }) => id === "hosted_editor_web",
    );

    expect(scan?.transport).toContain("Workers AI extraction");
    expect(scan?.transport).toContain("OpenRouter Terra frontier");
    expect(editor?.transport).toContain("OpenRouter Luna");
    expect(editor?.capabilityGate).toContain("Access account");
  });
});
