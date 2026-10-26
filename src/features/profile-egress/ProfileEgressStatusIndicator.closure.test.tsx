// @vitest-environment happy-dom
// DA-2b の PUB-G 前の必須 3・4（DR-DA2B-R22、R27）：状態の表示は AI の入口の閉鎖の唯一の
// 書き手。unrestricted 以外の既知の状態で閉じ、読めない（unknown）間と unrestricted では
// 閉じない。閉は一方向：global は戻せない property なので、この file では開を確かめる
// 試験を閉にする試験より前に置く（vitest は file ごとに global を分ける）。
import { act, cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileEgressStatusView } from "@/lib/profileEgressStatus";

type Handler = (view: ProfileEgressStatusView) => void;
const { handlers, getMock } = vi.hoisted(() => ({
  handlers: [] as Handler[],
  getMock: vi.fn<() => Promise<ProfileEgressStatusView>>(),
}));
vi.mock("@/lib/profileEgressStatus", () => ({
  getProfileEgressStatus: () => getMock(),
  onProfileEgressStatus: (handler: Handler) => {
    handlers.push(handler);
    return () => {};
  },
  requestProfileActivation: vi.fn(),
}));
vi.mock("./profileActivationAvailability", () => ({
  PROFILE_ACTIVATION_UI_ENABLED: true,
}));

import ProfileEgressStatusIndicator from "./ProfileEgressStatusIndicator";
import { useAiSettingsStore } from "@/features/chat/store";
import { closeProfileEgressEntrances } from "@/features/chat/closeProfileEgressEntrances";
import { profileEgressLocalRefusal } from "./profileEgressClosure";

function closure() {
  return {
    store: useAiSettingsStore.getState().profileEgressClosed === true,
    local: globalThis.__grimodexProfileEgressLocalRefusal !== undefined,
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderWith(answer: () => Promise<ProfileEgressStatusView>) {
  getMock.mockImplementation(answer);
  const view = render(<ProfileEgressStatusIndicator />);
  await settle();
  return view;
}

beforeEach(() => {
  handlers.length = 0;
  getMock.mockReset();
});
afterEach(() => cleanup());

describe("the AI entrances' closure written by the status display", () => {
  // Open first: nothing below may run before these (the closure is one-way).
  it.each([
    ["unrestricted", () => Promise.resolve({ state: "unrestricted" } as const)],
    ["an unreadable state", () => Promise.reject(new Error("bridge"))],
  ] as Array<[string, () => Promise<ProfileEgressStatusView>]>)(
    "%s leaves them open",
    async (_label, answer) => {
      await renderWith(answer);
      expect(closure()).toEqual({ store: false, local: false });
    },
  );

  it("closes both on the stage-2 event after an unrestricted answer", async () => {
    await renderWith(() => Promise.resolve({ state: "unrestricted" }));
    expect(closure()).toEqual({ store: false, local: false });
    act(() => {
      for (const handler of handlers) handler({ state: "activating" });
    });
    expect(closure()).toEqual({ store: true, local: true });
    expect(globalThis.__grimodexProfileEgressLocalRefusal).toBe(
      profileEgressLocalRefusal,
    );
  });

  it.each([
    [{ state: "restricted" }],
    [{ state: "activating" }],
    [{ state: "unavailable", reason: "status-invalid" }],
  ] as Array<[ProfileEgressStatusView]>)(
    "%o closes the store",
    async (view) => {
      useAiSettingsStore.setState({ profileEgressClosed: undefined });
      await renderWith(() => Promise.resolve(view));
      expect(closure()).toEqual({ store: true, local: true });
    },
  );

  it("stays closed when the writer is called again (one-way)", () => {
    closeProfileEgressEntrances();
    closeProfileEgressEntrances();
    expect(closure()).toEqual({ store: true, local: true });
    expect(globalThis.__grimodexProfileEgressLocalRefusal).toBe(
      profileEgressLocalRefusal,
    );
  });

  it("cannot be reopened by assigning, deleting or redefining the global", () => {
    expect(() => {
      globalThis.__grimodexProfileEgressLocalRefusal = undefined;
    }).toThrow(TypeError);
    expect(
      () =>
        delete (globalThis as { __grimodexProfileEgressLocalRefusal?: unknown })
          .__grimodexProfileEgressLocalRefusal,
    ).toThrow(TypeError);
    expect(() =>
      Object.defineProperty(globalThis, "__grimodexProfileEgressLocalRefusal", {
        value: undefined,
      }),
    ).toThrow(TypeError);
    expect(closure().local).toBe(true);
  });

  it("stays closed across StrictMode's double effects, an unmount and a re-render", async () => {
    getMock.mockImplementation(() => Promise.resolve({ state: "restricted" }));
    const first = render(
      <StrictMode>
        <ProfileEgressStatusIndicator />
      </StrictMode>,
    );
    await settle();
    expect(closure()).toEqual({ store: true, local: true });
    first.unmount();
    expect(closure()).toEqual({ store: true, local: true });

    getMock.mockImplementation(() =>
      Promise.resolve({ state: "unrestricted" }),
    );
    const second = render(
      <StrictMode>
        <ProfileEgressStatusIndicator />
      </StrictMode>,
    );
    await settle();
    second.unmount();
    expect(closure()).toEqual({ store: true, local: true });
  });
});
