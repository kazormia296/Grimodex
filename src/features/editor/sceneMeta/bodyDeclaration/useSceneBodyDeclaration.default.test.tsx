// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));

import { useSceneBodyDeclaration } from "./useSceneBodyDeclaration";

// No mock of the availability module: the real product default.
describe("the hook with the product default", () => {
  it("invokes no command at all while the UI constant is off", async () => {
    const { result, rerender } = renderHook(
      (props: { version: number }) =>
        useSceneBodyDeclaration({
          workspacePath: "/workspace",
          projectId: "project-1",
          sceneId: "scene-1",
          version: props.version,
        }),
      { initialProps: { version: 1 } },
    );
    rerender({ version: 2 });
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {
      await result.current.declare({
        story: true,
        auto: true,
        phase: true,
        reveal: true,
        pov: true,
      });
      await result.current.revoke();
      result.current.reload();
    });
    expect(result.current.status).toBe("off");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
