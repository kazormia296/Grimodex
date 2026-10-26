import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_AI_POLICY } from "@/features/ai-policy/types";
import { serializeAiPolicy } from "@/features/ai-policy/parse";
import { expandPreset } from "@/features/ai-policy/preset";
import {
  decideNir1LocalSendPolicy,
  nir1LocalPurposeGate,
} from "./nir1LocalPolicyGate";

// DD-1c (DR-DD1C-8): the renderer's copy of Native's local send policy
// decision is pinned to Native's own decision vectors, and the display hides
// a turned-off purpose and disables an unreadable policy (DR-DD1B-12).

interface Expected {
  readonly allow: boolean;
  readonly source?: string;
  readonly code?: string;
  readonly item?: string;
}
interface Vector {
  readonly label: string;
  readonly raw: string | null;
  readonly writing: Expected;
  readonly review: Expected;
}

const vectors = (
  JSON.parse(
    readFileSync(
      resolve(
        __dirname,
        "../../../../src-tauri/crates/grimodex-core/src/nir1_local_send_policy/decision_vectors.json",
      ),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;

describe("the copy of Native's local send policy decision", () => {
  it("has Native's vectors to compare with", () => {
    expect(vectors.length).toBeGreaterThan(100);
  });

  it.each(vectors.map((vector) => [vector.label, vector] as const))(
    "%s",
    (_label, vector) => {
      for (const purpose of ["writing", "review"] as const) {
        expect(decideNir1LocalSendPolicy(vector.raw, purpose), purpose).toEqual(
          vector[purpose],
        );
      }
    },
  );

  // Values `JSON.parse` reads but serde_json refuses (review P3, DR-DD1C-21):
  // a number out of the f64 range, an escaped lone surrogate, and nesting at
  // serde_json's recursion limit (128).
  it.each([
    [
      '{"preset":"full","toggles":{"chat":true,"bodyWrite":true,"analysis":true},"x":1e400}',
    ],
    [
      '{"preset":"full","toggles":{"chat":true,"bodyWrite":true,"analysis":true},"x":"\\ud800"}',
    ],
    [
      '{"preset":"full","toggles":{"chat":true,"bodyWrite":true,"analysis":true},"\\udc00":1}',
    ],
    [
      `{"preset":"full","toggles":{"chat":true,"bodyWrite":true,"analysis":true},"x":${"[".repeat(127)}${"]".repeat(127)}}`,
    ],
  ])("denies %s as serde_json would", (raw) => {
    expect(decideNir1LocalSendPolicy(raw, "writing")).toEqual({
      allow: false,
      code: "not-json",
    });
  });

  it("allows the same shapes inside serde_json's limits", () => {
    const base =
      '{"preset":"full","toggles":{"chat":true,"bodyWrite":true,"analysis":true},"x":';
    for (const value of [
      "1e300",
      '"\\ud83d\\ude00"',
      `${"[".repeat(100)}${"]".repeat(100)}`,
    ]) {
      expect(decideNir1LocalSendPolicy(`${base}${value}}`, "writing")).toEqual({
        allow: true,
        source: "stored",
      });
    }
  });

  it("denies a policy over 64 KiB", () => {
    const raw = JSON.stringify({
      preset: "full",
      toggles: { chat: true, bodyWrite: true, analysis: true },
      pad: "x".repeat(64 * 1024),
    });
    expect(decideNir1LocalSendPolicy(raw, "writing")).toEqual({
      allow: false,
      code: "too-large",
    });
  });
});

describe("the start's hide／disable by the AI usage policy (K5/3:427)", () => {
  const project = (aiPolicy: string | null) => ({ aiPolicy });

  it("is pending while no project is loaded", () => {
    expect(nir1LocalPurposeGate(undefined, "writing")).toEqual({
      presentation: "pending",
    });
  });

  it("enables both purposes with the default policy", () => {
    const raw = serializeAiPolicy(DEFAULT_AI_POLICY);
    expect(nir1LocalPurposeGate(project(raw), "writing").presentation).toBe(
      "enabled",
    );
    expect(nir1LocalPurposeGate(project(raw), "review").presentation).toBe(
      "enabled",
    );
  });

  it.each([
    ["assist-off", "hidden", "enabled"],
    ["review-only", "hidden", "hidden"],
    ["off", "hidden", "hidden"],
    ["full", "enabled", "enabled"],
  ] as const)(
    "follows the %s preset with the same items as evaluateAiCapability",
    (preset, writing, review) => {
      const raw = JSON.stringify({ preset, toggles: expandPreset(preset) });
      expect(nir1LocalPurposeGate(project(raw), "writing").presentation).toBe(
        writing,
      );
      expect(nir1LocalPurposeGate(project(raw), "review").presentation).toBe(
        review,
      );
    },
  );

  it("hides only the purpose whose own item is off", () => {
    const raw = JSON.stringify({
      preset: "custom",
      toggles: { chat: true, bodyWrite: false, analysis: true },
    });
    expect(nir1LocalPurposeGate(project(raw), "writing")).toEqual({
      presentation: "hidden",
      reason: "NIR1_LOCAL_POLICY_DENIED",
    });
    expect(nir1LocalPurposeGate(project(raw), "review").presentation).toBe(
      "enabled",
    );
  });

  it.each([
    ['{"preset":"full"}'],
    ["{not json"],
    ["  "],
    [
      '{"preset":"full","toggles":{"chat":"true","bodyWrite":true,"analysis":true}}',
    ],
  ])("disables both purposes for the unreadable %s", (raw) => {
    for (const purpose of ["writing", "review"] as const) {
      expect(nir1LocalPurposeGate(project(raw), purpose)).toEqual({
        presentation: "disabled",
        reason: "NIR1_LOCAL_POLICY_UNREADABLE",
      });
    }
  });

  it("agrees with Native's vectors on every readable and unreadable value", () => {
    for (const vector of vectors) {
      if (vector.raw === null) continue;
      for (const purpose of ["writing", "review"] as const) {
        const expected = vector[purpose];
        const gate = nir1LocalPurposeGate(project(vector.raw), purpose);
        const want = expected.allow
          ? "enabled"
          : expected.code === "item-disabled"
            ? "hidden"
            : "disabled";
        expect(gate.presentation, `${vector.label} ${purpose}`).toBe(want);
      }
    }
  });
});
