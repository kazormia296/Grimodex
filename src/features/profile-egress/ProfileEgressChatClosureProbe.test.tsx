// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProfileEgressStatusSnapshot } from "./useProfileEgressStatus";

// DA-2b ST4-B (DR-DA2B-R6): the chat panel's lazy probe reports the AI
// entrances closed while restricted, activating or unavailable.

const { snapshot } = vi.hoisted(() => ({
  snapshot: { current: { kind: "loading" } as ProfileEgressStatusSnapshot },
}));
vi.mock("./useProfileEgressStatus", () => ({
  useProfileEgressStatus: () => snapshot.current,
}));

import ProfileEgressChatClosureProbe from "./ProfileEgressChatClosureProbe";
import i18n from "@/lib/i18n";

describe("ProfileEgressChatClosureProbe", () => {
  it.each([
    [{ kind: "loading" }, false],
    [{ kind: "unknown" }, false],
    [{ kind: "known", view: { state: "unrestricted" } }, false],
    [{ kind: "known", view: { state: "activating" } }, true],
    [{ kind: "known", view: { state: "restricted" } }, true],
    [
      {
        kind: "known",
        view: { state: "unavailable", reason: "activation-failed" },
      },
      true,
    ],
  ] as Array<[ProfileEgressStatusSnapshot, boolean]>)(
    "%o → closed %s",
    (state, closed) => {
      snapshot.current = state;
      const onChange = vi.fn();
      const { container } = render(
        <ProfileEgressChatClosureProbe onChange={onChange} />,
      );
      expect(container).toBeEmptyDOMElement();
      expect(onChange).toHaveBeenLastCalledWith(closed);
    },
  );

  it("registers the chat strings of the closed entrances", () => {
    expect(i18n.exists("profileEgress.chat.editClosed")).toBe(true);
    expect(i18n.t("profileEgress.chat.sendClosed")).not.toBe(
      "profileEgress.chat.sendClosed",
    );
  });
});
