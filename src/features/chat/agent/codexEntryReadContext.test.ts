import { afterEach, describe, expect, it } from "vitest";

import { usePhaseStore } from "@/features/codex/phaseStore";
import { LEGACY_CODEX_ENTRY_CONTEXT } from "./codexEntryReadContext";

describe("get_codex_entry の renderer context", () => {
  const originalEpoch = usePhaseStore.getState().projectEpoch;

  afterEach(() => {
    usePhaseStore.setState({ projectEpoch: originalEpoch });
  });

  it("呼出し時点の project epoch を core に渡す", () => {
    expect(LEGACY_CODEX_ENTRY_CONTEXT.getProjectEpoch).toBeDefined();
    usePhaseStore.setState({ projectEpoch: originalEpoch + 1 });
    expect(LEGACY_CODEX_ENTRY_CONTEXT.getProjectEpoch()).toBe(
      originalEpoch + 1,
    );
  });
});
