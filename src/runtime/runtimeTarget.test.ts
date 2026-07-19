import { describe, expect, it } from "vitest";
import {
  resolveRuntimeCapabilities,
  type RuntimeCapabilities,
} from "./runtimeCapabilities";
import { runtimeTargets, type RuntimeTarget } from "./runtimeTarget";

describe("runtime target contract", () => {
  it("exposes the three planned runtime targets", () => {
    expect(runtimeTargets).toEqual(["electron", "web", "mobile-native"]);
  });

  it.each<[RuntimeTarget, keyof RuntimeCapabilities]>([
    ["electron", "nativeFilesystem"],
    ["web", "hostedAi"],
    ["mobile-native", "shareSheet"],
  ])("resolves a capability preset for %s", (target, capability) => {
    expect(resolveRuntimeCapabilities(target)[capability]).toBe(true);
  });

  it("does not expose native-only capabilities to hosted web", () => {
    const capabilities = resolveRuntimeCapabilities("web");

    expect(capabilities.nativeFilesystem).toBe(false);
    expect(capabilities.externalMount).toBe(false);
    expect(capabilities.localAi).toBe(false);
    expect(capabilities.mcpServer).toBe(false);
    expect(capabilities.multiWindow).toBe(false);
    expect(capabilities.customIme).toBe(false);
  });

  it("only exposes generic project transfer to the Electron application", () => {
    expect(resolveRuntimeCapabilities("web").genericProjectTransfer).toBe(
      false,
    );
    expect(resolveRuntimeCapabilities("electron").genericProjectTransfer).toBe(
      true,
    );
  });
});
