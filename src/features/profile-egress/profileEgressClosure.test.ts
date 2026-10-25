import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProfileEgressGate,
  d2aRouteLedgersForTest,
} from "../../../electron/main/profileEgress";
import { nativeSqlPolicyV2 } from "../../../electron/main/d2aSqlPolicyFixture";
import type { NapiBackendLike } from "../../../electron/shared/ipcContract";
import { isD2aEgressDenied } from "@/lib/tauri";
import i18next from "@/lib/i18n";
import { aiFailureText } from "./profileEgressAiStop";
import { useAiSettingsStore } from "@/features/chat/store";
import { closeProfileEgressEntrances } from "@/features/chat/closeProfileEgressEntrances";
import {
  profileEgressLocalRefusal,
  rendererDeniedCommandsForTest,
  resetProfileEgressClosureForTest,
} from "./profileEgressClosure";

// DA-2b の PUB-G 前の必須 3（DR-DA2B-R22）：`invoke` の手前の局所の拒否は、Main の
// 拒否の台帳と同じ command を、Main の gate が restricted で投げる文と同じ文で拒否する。

function restrictedBackend(): NapiBackendLike {
  return {
    initializeProfileEgress: async () =>
      JSON.stringify({
        profileId: "profile-1",
        callerEpoch: 4,
        restricted: true,
        handlesInvalidated: true,
        inFlightStopped: true,
        sqlPolicy: nativeSqlPolicyV2(),
      }),
    registerProfileEgressCaller: () => undefined,
    invalidateProfileEgressCallers: () => undefined,
  } as unknown as NapiBackendLike;
}

function mainRefusal(
  gate: { assertInvoke(command: string, args: Record<string, unknown>): void },
  command: string,
): string {
  try {
    gate.assertInvoke(command, {});
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`Main allowed ${command}`);
}

afterEach(() => {
  resetProfileEgressClosureForTest();
  useAiSettingsStore.setState({ profileEgressClosed: undefined });
});

describe("the renderer's local refusal before invoke (DR-DA2B-R22)", () => {
  it("lists exactly Main's DENIED_COMMANDS", () => {
    const renderer = rendererDeniedCommandsForTest().map(
      ([command]) => command,
    );
    expect(new Set(renderer).size).toBe(renderer.length);
    expect([...renderer].sort()).toEqual(
      [...d2aRouteLedgersForTest().denied].sort(),
    );
  });

  it("refuses each command with the text Main's restricted gate throws", async () => {
    const gate = await createProfileEgressGate(restrictedBackend());
    expect(gate.restricted).toBe(true);
    closeProfileEgressEntrances();
    for (const [command] of rendererDeniedCommandsForTest()) {
      expect(profileEgressLocalRefusal(command), command).toBe(
        mainRefusal(gate, command),
      );
    }
  });

  it("the writer closes both homes of the closure at once", () => {
    expect(globalThis.__grimodexProfileEgressLocalRefusal).toBeUndefined();
    closeProfileEgressEntrances();
    expect(globalThis.__grimodexProfileEgressLocalRefusal).toBe(
      profileEgressLocalRefusal,
    );
    expect(useAiSettingsStore.getState().profileEgressClosed).toBe(true);
  });

  it("never refuses the stop commands, the internal ones or an unknown one", () => {
    closeProfileEgressEntrances();
    for (const command of [
      ...d2aRouteLedgersForTest().stop,
      ...d2aRouteLedgersForTest().internal,
      ...d2aRouteLedgersForTest().ownDataRead,
      "get_profile_egress_status",
      "capture_current_chat_input",
      "no_such_command",
    ]) {
      expect(profileEgressLocalRefusal(command), command).toBeNull();
    }
  });

  it("is a D2a refusal that the displays show as the generic text, never the marker", () => {
    closeProfileEgressEntrances();
    const refusal = profileEgressLocalRefusal("send_inline_ai_stream");
    expect(refusal).not.toBeNull();
    expect(isD2aEgressDenied(new Error(refusal!))).toBe(true);
    // Not one of the activation's AI terminals (`stopped`, `discarded`).
    expect(aiFailureText(refusal)).toBe(i18next.t("common.error"));
    expect(aiFailureText(`Error: ${refusal}`)).toBe(i18next.t("common.error"));
    expect(aiFailureText(refusal)).not.toContain("D2A_EGRESS_DENIED");
  });

  it("imports nothing and calls nothing at the top level (R23)", () => {
    const source = readFileSync(
      resolve(__dirname, "profileEgressClosure.ts"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/^\s*export\s*\{/m);
    // Top-level statements are declarations only (no call, no `new`).
    const topLevel = source
      .split("\n")
      .filter((line) => /^[A-Za-z]/.test(line) && line !== "declare global {");
    for (const line of topLevel) {
      expect(line).toMatch(/^(?:export )?(?:let|const|function) /);
      if (!/^(?:export )?function /.test(line)) {
        expect(line).not.toMatch(/\bnew\b|\w\(/);
      }
    }
  });
});
