import { describe, expect, it } from "vitest";

import {
  MODELS_DEV_PROVIDER_MAP,
  SNAPSHOT_PROVIDERS,
} from "@/../electron/shared/modelCapabilityRegistry";
import { AI_PROVIDERS } from "../types";

// electron/shared の検証 module は他を import できないため、provider 名の写しがずれないことを
// renderer 側の試験で確かめる（electron の試験設定は `@` の alias を持たない）。
describe("モデル能力の registry の provider", () => {
  it("写しの provider は AiProvider の部分集合", () => {
    for (const provider of SNAPSHOT_PROVIDERS) {
      expect(AI_PROVIDERS).toContain(provider);
    }
    for (const provider of MODELS_DEV_PROVIDER_MAP.values()) {
      expect(AI_PROVIDERS).toContain(provider);
    }
  });
});
